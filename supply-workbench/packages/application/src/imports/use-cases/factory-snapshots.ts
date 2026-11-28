import type { ImportBatch } from '@sw/domain';
import { saveFactoryCodeLinks } from '../commit/code-links.js';
import type { CommitContext } from '../commit/context.js';
import type { UnitOfWorkStores } from '../../ports/unit-of-work.js';
import { revisionOf, saveImportRevision } from './revision.js';

export type FactorySnapshotReplay = {
  readonly existing: ImportBatch;
};

export class FactorySnapshotReplayChanged extends Error {}

export async function prepareFactorySnapshot(ctx: CommitContext): Promise<FactorySnapshotReplay | undefined> {
  if (ctx.batch.template !== 'factory-progress-v1') return undefined;
  const before = await findFactorySnapshotReplay(ctx);
  if (before === undefined) await saveFactoryCodeLinks(ctx);
  if (ctx.batch.factoryPartyId !== null) await ctx.tx.factoryReports.lockSnapshotSource(ctx.batch.factoryPartyId);
  const replay = await findFactorySnapshotReplay(ctx);
  // 另一事务已发布同一快照，回滚本次预写的编码对照，再执行既有放弃流程。
  if (before === undefined && replay !== undefined) throw new FactorySnapshotReplayChanged();
  return replay;
}

async function findFactorySnapshotReplay(input: { readonly tx: UnitOfWorkStores; readonly batch: ImportBatch }): Promise<FactorySnapshotReplay | undefined> {
  if (input.batch.template !== 'factory-progress-v1' || input.batch.sourceKey === null || input.batch.sourceKey === undefined) return undefined;
  const fingerprint = input.batch.sourceFingerprint ?? input.batch.fileId;
  const existing = (await input.tx.imports.list()).find((item) => item.id !== input.batch.id && item.status === 'committed' && item.sourceKey === input.batch.sourceKey && (item.sourceFingerprint ?? item.fileId) === fingerprint);
  return existing === undefined ? undefined : { existing };
}

export async function retireFactorySnapshot(input: { readonly tx: UnitOfWorkStores; readonly batch: ImportBatch; readonly at: string }): Promise<void> {
  if (input.batch.template !== 'factory-progress-v1') return;
  const source = input.batch.sourceKey ?? null;
  const active = (await input.tx.imports.list()).filter((item) => item.id !== input.batch.id
    && item.template === 'factory-progress-v1' && item.status === 'committed'
    && (item.sourceKey ?? null) === source
    && (source === null ? item.factoryPartyId === input.batch.factoryPartyId : (item.supersededAt ?? null) === null));
  await input.tx.factoryReports.lockSnapshotOrders({
    incomingBatchId: input.batch.id, previousBatchIds: active.map((item) => item.id), onlyEffectivePrevious: source === null,
  });
  if (source === null) return;
  for (const previous of active) {
    const next = { ...previous, revision: revisionOf(previous.revision) + 1, supersededAt: input.at, updatedAt: input.at };
    await saveImportRevision({ repo: input.tx.imports, next, expectedRevision: revisionOf(previous.revision) });
  }
}

