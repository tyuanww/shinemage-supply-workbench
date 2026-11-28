import { orderLineId as brandOrderLineId } from '@sw/domain';
import type { UnitOfWorkStores } from '../../ports/unit-of-work.js';
import type { RelinkFactoryRows, RelinkFactoryRowsDeps } from '../boundary.js';
import { planFactoryLinks, type FactoryMatch } from '../matching.js';
import { lineFactoryLinksOf, linkIdOf, linkOf } from '../../shared/factory-link.js';
import type { LineFactoryLinkRepository } from '../repository.js';
import type { FactoryRowMatchRef, OrderLineMatchRef } from '../views.js';
import { compareFactoryReportWrites } from '../../shared/factory-report-order.js';
import { authorize } from '../../shared/authorize.js';

const DEFAULT_LIMIT = 20000;

type Matched = Extract<FactoryMatch, { readonly kind: 'matched' }>;
type Failure = Extract<FactoryMatch, { readonly kind: 'conflict' | 'none' }>;
type Counters = { factoryLinked: number; factoryManual: number; factoryUnlinked: number; conflicts: number; byBasis: { po: number; item_code: number; barcode: number } };
type Write = { readonly tx: UnitOfWorkStores; readonly at: string; readonly links: LineFactoryLinkRepository; readonly matchedLines: Set<string>; readonly counters: Counters };

export const makeRelinkFactoryRows =
  (deps: RelinkFactoryRowsDeps): RelinkFactoryRows =>
  async (input, actor) => {
    authorize(actor, 'master.review');
    const at = deps.clock.now();
    const [orderLines, allRows] = await Promise.all([deps.links.listOrderLineRefs(), deps.links.listFactoryRowRefs()]);
    const factoryRows = allRows.filter((row) => row.kind !== 'schedule').slice(0, input.limit ?? DEFAULT_LIMIT);
    const plan = planFactoryLinks({ orderLines, factoryRows });
    const counters = emptyCounters();
    const matchedLines = new Set<string>();
    await deps.uow.run(async (tx) => {
      const write = { tx, at, links: lineFactoryLinksOf(tx), matchedLines, counters };
      const reports = plan.map(({ row }) => row);
      await tx.factoryReports.lockReportSources(reports.map((row) => row.factoryPartyId));
      const oldOwners = await tx.factoryReports.effectiveReportOwners(reports);
      await write.links.lockOwnershipChanges([...oldOwners, ...ownershipTargets({ plan, orderLines })]);
      await writeRecordedLinks(write, { plan, orderLines });
      for (const result of [...plan].sort(comparePlannedWrites)) await applyResult({ ...write, result });
    });
    const manualLines = orderLines.filter((line) => line.linkStatus === 'manual').length;
    return {
      factoryRows: factoryRows.length,
      factoryLinked: counters.factoryLinked,
      factoryManual: counters.factoryManual,
      factoryUnlinked: counters.factoryUnlinked,
      conflicts: counters.conflicts,
      linesLinked: matchedLines.size,
      linesUnlinked: orderLines.length - manualLines - matchedLines.size,
      byBasis: counters.byBasis,
    };
  };

function ownershipTargets(input: { readonly plan: readonly FactoryMatch[]; readonly orderLines: readonly OrderLineMatchRef[] }): string[] {
  const matched = input.plan.flatMap((result) => result.kind === 'matched' && !isManualLine(result.line) ? [result.line.orderLineId] : []);
  const recorded = input.orderLines.filter((line) => line.linkStatus === 'linked' && !isManualLine(line)).map((line) => line.orderLineId);
  return [...matched, ...recorded];
}

function isManualLine(line: OrderLineMatchRef): boolean {
  return line.linkStatus === 'manual' || line.linkSource === 'manual';
}

function comparePlannedWrites(left: FactoryMatch, right: FactoryMatch): number {
  return compareFactoryReportWrites(
    { id: left.row.rowId, kind: left.row.kind },
    { id: right.row.rowId, kind: right.row.kind },
  );
}

function emptyCounters(): Counters {
  return { factoryLinked: 0, factoryManual: 0, factoryUnlinked: 0, conflicts: 0, byBasis: { po: 0, item_code: 0, barcode: 0 } };
}

async function applyResult(input: Write & { readonly result: FactoryMatch }): Promise<void> {
  if (input.result.row.linkStatus === 'manual') {
    input.counters.factoryManual += 1;
    return;
  }
  if (input.result.kind === 'matched') return applyMatched({ ...input, result: input.result });
  return applyFailure({ ...input, result: input.result });
}

async function applyMatched(input: Write & { readonly result: Matched }): Promise<void> {
  const line = input.result.line;
  const isSaved = input.matchedLines.has(line.orderLineId);
  if (!isSaved) {
    input.counters.factoryUnlinked += 1;
    await markRow({ tx: input.tx, row: input.result.row, status: 'unlinked', reason: 'LINE_LINK_IS_MANUAL' });
    return;
  }
  await markRow({ tx: input.tx, row: input.result.row, status: 'linked', reason: null, orderLineId: line.orderLineId });
  input.counters.factoryLinked += 1;
  input.counters.byBasis[input.result.basis] += 1;
}

async function applyFailure(input: Write & { readonly result: Failure }): Promise<void> {
  input.counters.factoryUnlinked += 1;
  if (input.result.kind === 'conflict') {
    input.counters.conflicts += 1;
    await markRow({ tx: input.tx, row: input.result.row, status: 'ambiguous', reason: 'FACTORY_LINK_CONFLICT' });
    return;
  }
  await markNone({ tx: input.tx, row: input.result.row });
}

async function markNone(input: { readonly tx: UnitOfWorkStores; readonly row: FactoryRowMatchRef }): Promise<void> {
  if (input.row.linkStatus === 'unlinked' && input.row.linkReason !== null) return;
  await markRow({ ...input, status: 'unlinked', reason: 'NO_CANDIDATE_LINE' });
}

async function markRow(input: {
  readonly tx: UnitOfWorkStores;
  readonly row: FactoryRowMatchRef;
  readonly status: 'linked' | 'unlinked' | 'ambiguous';
  readonly reason: string | null;
  readonly orderLineId?: string | null;
}): Promise<void> {
  const orderLineId = input.orderLineId ?? null;
  if (input.row.linkStatus === input.status && input.row.linkReason === input.reason && input.row.linkedOrderLineId === orderLineId) return;
  const found = await input.tx.factoryReports.find(input.row.rowId);
  if (found === undefined) return;
  await input.tx.factoryReports.save({ ...found, linkedOrderLineId: orderLineId === null ? null : brandOrderLineId(orderLineId), linkStatus: input.status, linkReason: input.reason });
}

async function writeRecordedLinks(write: Write, { plan, orderLines }: {
  readonly plan: readonly FactoryMatch[]; readonly orderLines: readonly OrderLineMatchRef[];
}): Promise<void> {
  const candidates = new Map(plan.flatMap((result) => result.kind === 'matched' ? [[result.line.orderLineId, result] as const] : []));
  for (const line of [...orderLines].sort((left, right) => left.orderLineId.localeCompare(right.orderLineId))) {
    const result = candidates.get(line.orderLineId);
    if (result !== undefined && await saveLinked({ links: write.links, at: write.at, result })) {
      write.matchedLines.add(line.orderLineId);
      continue;
    }
    await writeUnlinked({ links: write.links, at: write.at, line });
  }
}

async function saveLinked({ links, at, result }: {
  readonly links: LineFactoryLinkRepository; readonly at: string; readonly result: Matched;
}): Promise<boolean> {
  const line = result.line;
  return links.save(linkOf({
    id: line.linkId ?? linkIdOf(line.orderLineId),
    at: at,
    orderLineId: line.orderLineId,
    factoryPartyId: result.row.factoryPartyId,
    status: 'linked',
    source: 'relink',
    confidence: result.basis,
    poRaw: result.row.poRaw,
    itemCodeRaw: result.row.itemCodeRaw,
    barcodeRaw: result.row.barcodeRaw,
  }));
}

async function writeUnlinked({ links, at, line }: {
  readonly links: LineFactoryLinkRepository; readonly at: string; readonly line: OrderLineMatchRef;
}): Promise<void> {
  if (isManualLine(line) || (line.linkStatus === 'unlinked' && line.linkReason === 'NO_FACTORY_ROW_MATCH')) return;
  await links.save(linkOf({
    id: line.linkId ?? linkIdOf(line.orderLineId),
    at,
    orderLineId: line.orderLineId,
    factoryPartyId: null,
    status: 'unlinked',
    source: 'relink',
    confidence: 'none',
    reason: 'NO_FACTORY_ROW_MATCH',
  }));
}
