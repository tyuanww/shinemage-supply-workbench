import type { ImportBatch, ImportRow, LatestImportPresence } from '@sw/domain';
import type { CommitImport, CommitImportDeps } from '../boundary.js';
import type { ImportBatchRepository } from '../../ports/import-batch-repository.js';
import type { UnitOfWorkStores } from '../../ports/unit-of-work.js';
import type { OrderLineRepository } from '../../ports/order-line-repository.js';
import { canTransitionImport, importPresenceMatches, withLatestImportPresence } from '@sw/domain';
import { auditOf } from '../../shared/audit.js';
import { authorize } from '../../shared/authorize.js';
import { ImportHasConflictsError, StateConflictError } from '../../shared/errors.js';
import { revisionOf, saveImportRevision } from './revision.js';
import { refreshLineProjection } from '../../shared/line-projection.js';
import { commitExecutors } from '../commit/index.js';
import { FactorySnapshotReplayChanged, prepareFactorySnapshot, retireFactorySnapshot } from './factory-snapshots.js';
import { appliedPoMasterBatches } from './po-existing.js';

export const makeCommitImport =
  (deps: CommitImportDeps): CommitImport =>
  async (input, actor) => {
    authorize(actor, 'imports.write');
    const commit = (tx: UnitOfWorkStores) => commitBatch({ tx, input, actor, clock: deps.clock });
    try {
      await deps.uow.run(commit);
    } catch (error) {
      if (!(error instanceof FactorySnapshotReplayChanged)) throw error;
      await deps.uow.run(commit);
    }
    return { importBatchId: input.importBatchId };
  };

async function commitBatch({ tx, input, actor, clock }: {
  readonly tx: UnitOfWorkStores;
  readonly input: Parameters<CommitImport>[0];
  readonly actor: Parameters<CommitImport>[1];
  readonly clock: CommitImportDeps['clock'];
}): Promise<void> {
  const batch = await lockedBatch(tx, input.importBatchId);
  if (!canTransitionImport(batch.status, 'commit')) throw new StateConflictError(batch.status);
  const startedAt = clock.now();
  const revision = revisionOf(batch.revision) + 1;
  const procurementReplay = batch.template === 'po-master-v1' ? await tx.procurement?.originalBatchId(batch.fileId) ?? null : null;
  if (procurementReplay !== null) {
    const at = startedAt;
    const discarded = { ...batch, revision, status: 'discarded' as const, fileMeta: { ...metadata(batch.fileMeta), procurementReplayOf: procurementReplay }, error: null, updatedAt: at };
    await saveImportRevision({ repo: tx.imports, next: discarded, expectedRevision: input.expectedRevision });
    await tx.audit.record(auditOf({ action: 'import.discard', subject: discarded, ctx: { actor, at, before: batch, after: discarded, entity: '导入批次' } }));
    return;
  }
  const rows = await committableRows({ tx, batch });
  const replay = await prepareFactorySnapshot({ tx, batch, rows, at: startedAt, actor });
  const at = batch.template === 'factory-progress-v1' ? clock.now() : startedAt;
  if (replay !== undefined) {
    const discarded = { ...batch, revision, status: 'discarded' as const, error: `重复快照，已复用 ${replay.existing.id}`, updatedAt: at };
    await saveImportRevision({ repo: tx.imports, next: discarded, expectedRevision: input.expectedRevision });
    return;
  }
  await applyImport({ tx, batch, rows, at, actor });
  const committed = { ...batch, revision, status: 'committed' as const, committedBy: actor.id, committedAt: at, error: null, updatedAt: at };
  await saveImportRevision({ repo: tx.imports, next: committed, expectedRevision: input.expectedRevision });
  await tx.audit.record(auditOf({ action: 'import.commit', subject: committed, ctx: { actor, at, entity: '导入批次' } }));
}

async function lockedBatch(tx: UnitOfWorkStores, id: string): Promise<ImportBatch> {
  const batch = await tx.imports.get(id);
  if (batch.template !== 'po-master-v1' || tx.procurement === undefined) return batch;
  await tx.procurement.lockCommit();
  return tx.imports.get(id);
}

function metadata(value: unknown): object {
  return typeof value === 'object' && value !== null ? value : {};
}

async function committableRows({ tx, batch }: { readonly tx: UnitOfWorkStores; readonly batch: ImportBatch }): Promise<readonly ImportRow[]> {
  const rows = await tx.imports.listRows(batch.id);
  const conflicts = rows.filter((row) => row.action === 'conflict');
  if (conflicts.length > 0) throw new ImportHasConflictsError(conflicts.length);
  return rows;
}

async function applyImport({ tx, batch, rows, at, actor }: {
  readonly tx: UnitOfWorkStores;
  readonly batch: ImportBatch;
  readonly rows: readonly ImportRow[];
  readonly at: string;
  readonly actor: Parameters<CommitImport>[1];
}): Promise<void> {
  const executor = commitExecutors().find((item) => item.template === batch.template);
  if (executor === undefined) throw new Error(`没有提交执行器 ${batch.template}`);
  const result = await executor.run({ tx, batch, rows, at, actor });
  await retireFactorySnapshot({ tx, batch, at });
  if (batch.template === 'po-master-v1' && tx.orderLines.listAll !== undefined) {
    await refreshLatestImportPresence({ batch, imports: tx.imports, orderLines: tx.orderLines, present: new Set(result.presentLineIds), at });
  }
  if (result.affectedLineIds.length > 0) await refreshLineProjection(tx, result.affectedLineIds);
}

async function refreshLatestImportPresence(input: { readonly batch: ImportBatch; readonly imports: ImportBatchRepository; readonly orderLines: OrderLineRepository; readonly present: ReadonlySet<string>; readonly at: string }): Promise<void> {
  const all = await input.orderLines.listAll?.() ?? [];
  const sourceByLine = await latestSourceByLine({ imports: input.imports, current: input.batch, present: input.present });
  for (const line of all) {
    const source = sourceByLine.get(line.id);
    const isSameSource = source !== undefined && sameImportSource(source, input.batch);
    const presence = presenceFor({ coverage: input.batch.coverage ?? 'full_snapshot', line, present: input.present, isSameSource });
    if (importPresenceMatches(line, presence)) continue;
    await input.orderLines.save({ ...withLatestImportPresence(line, presence), updatedAt: input.at });
  }
}

async function latestSourceByLine(input: { readonly imports: ImportBatchRepository; readonly current: ImportBatch; readonly present: ReadonlySet<string> }): Promise<ReadonlyMap<string, ImportBatch>> {
  const latest = new Map<string, ImportBatch>();
  for (const batch of await appliedPoMasterBatches(input.imports)) {
    if (batch.id === input.current.id) continue;
    for (const row of await input.imports.listRows(batch.id)) {
      if (row.targetId === null || row.action === 'skip' || row.action === 'conflict') continue;
      const existing = latest.get(row.targetId);
      if (existing === undefined || batchTime(batch) > batchTime(existing)) latest.set(row.targetId, batch);
    }
  }
  for (const lineId of input.present) latest.set(lineId, input.current);
  return latest;
}

function batchTime(batch: ImportBatch): string {
  return batch.committedAt ?? batch.updatedAt;
}

function sameImportSource(left: ImportBatch, right: ImportBatch): boolean {
  return left.template === right.template && left.factoryPartyId === right.factoryPartyId && laneOf(left) === laneOf(right);
}

function laneOf(batch: ImportBatch): 'finished' | 'other' {
  return batch.template === 'po-master-v1' ? 'finished' : 'other';
}

function presenceFor(input: { readonly coverage: 'full_snapshot' | 'partial'; readonly line: { readonly id: string; readonly origin: string }; readonly present: ReadonlySet<string>; readonly isSameSource: boolean }): LatestImportPresence {
  if (input.line.origin !== 'import_po_master') return 'not_applicable';
  if (!input.isSameSource) return 'not_applicable';
  if (input.coverage === 'partial') return 'unknown';
  return input.present.has(input.line.id) ? 'present' : 'missing';
}
