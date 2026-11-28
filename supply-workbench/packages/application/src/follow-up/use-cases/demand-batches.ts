import {
  createBatch,
  generateBatchCandidates,
  type BatchCandidate,
  type DeliveryBatchId,
  type EntityId,
  type FactoryDemandFacts,
  type FactoryReportRow,
  type OrderLine,
  type OrderLineId,
} from '@sw/domain';
import type { Actor } from '../../shared/actor.js';
import type { UnitOfWorkStores } from '../../ports/unit-of-work.js';
import { auditOf } from '../../shared/audit.js';
import { lockOrderLines, requireLockedOrderLine } from '../../shared/locked-order-lines.js';
import { isCurrentMaterialFailure, isCurrentMaterialLine, resolveMaterialLine, type MaterialIdentity, type MaterialMatchFailure } from './demand-line.js';
import { purchaseOrderKey } from './purchase-order-ref.js';
import { commandContext, persistBatch } from './persist-batch.js';

const NO_SLOT = -1;
const EXISTING_BATCH = '已经生成过批次';

export type SlotSkip = {
  readonly rowId: string;
  readonly slotIndex: number;
  readonly reason: string;
};
export type RowOutcome = {
  readonly lines: number;
  readonly batches: number;
  readonly skipped: readonly SlotSkip[];
  readonly evidence?: GenerationEvidence;
};

type CreatedSlot = { readonly batchId: DeliveryBatchId; readonly slotIndex: number };
type GenerationEvidence = {
  readonly rowId: string;
  readonly version: string;
  readonly orderLineId: OrderLineId;
  readonly created: readonly CreatedSlot[];
};

export type GenerateInput = {
  readonly tx: UnitOfWorkStores;
  readonly actor: Actor;
  readonly at: string;
  readonly nextOrderLineId: () => OrderLineId;
  readonly nextEntityId: () => EntityId;
  readonly nextDeliveryBatchId: () => DeliveryBatchId;
};

type DemandSnapshot = Awaited<ReturnType<UnitOfWorkStores['factoryReports']['getForDemandGeneration']>>;

type ActionableDemand = {
  readonly demand: FactoryDemandFacts;
  readonly rowId: string;
  readonly version: string | null;
  readonly factoryPartyId: EntityId;
  readonly candidates: readonly BatchCandidate[];
};

type PreparedDemand = Omit<ActionableDemand, 'demand'> & {
  readonly lineId: OrderLineId;
  readonly material: MaterialIdentity;
  readonly matchingLineIds: readonly OrderLineId[];
  readonly lineCreated: boolean;
};

type PreparedFailure = MaterialMatchFailure & Pick<ActionableDemand, 'candidates'>;

export class DemandMaterialChanged extends Error {}

export async function generateDemandRows(input: GenerateInput, sources: readonly DemandSnapshot[]): Promise<RowOutcome[]> {
  const rows = [];
  const lineIds = new Set<OrderLineId>();
  for (const source of await lockNeededMaterialOrders(input.tx, sources)) {
    const row = 'demand' in source ? await prepareDemandRow(input, source) : source;
    rows.push(row);
    if ('matchingLineIds' in row) {
      for (const lineId of row.matchingLineIds) lineIds.add(lineId);
    }
  }
  const shouldLockWithoutWaiting = lineIds.size > 1;
  const lines = await lockOrderLines({ lock: (id) => input.tx.orderLines.lock(id, { noWait: shouldLockWithoutWaiting }) }, [...lineIds]);
  const outcomes = [];
  for (const row of rows) {
    if ('lineId' in row) {
      const line = requireLockedOrderLine(lines, row.lineId);
      if (!await isCurrentMaterialLine(input.tx, { line, material: row.material })) throw new DemandMaterialChanged();
      outcomes.push(await generatePreparedRow(input, { ...row, line }));
    } else if ('material' in row) {
      if (!await isCurrentMaterialFailure(input.tx, row)) throw new DemandMaterialChanged();
      outcomes.push(skipCandidates(row.candidates, row.reason));
    } else {
      outcomes.push(row);
    }
  }
  return outcomes;
}

async function lockNeededMaterialOrders(tx: UnitOfWorkStores, sources: readonly DemandSnapshot[]): Promise<readonly (ActionableDemand | RowOutcome)[]> {
  const prepared = [];
  const orders = new Set<string | null>();
  for (const source of sources) {
    const row = await prepareCandidates(tx, source);
    prepared.push(row);
    if ('demand' in row) orders.add(purchaseOrderKey(row.demand.blockMaterialPoRaw).poNorm);
  }
  if (orders.size > 0) await tx.batches.lockDemandGeneration({ materialOrderNumbers: [...orders] });
  return prepared;
}

async function prepareCandidates(tx: UnitOfWorkStores, { row, version }: DemandSnapshot): Promise<ActionableDemand | RowOutcome> {
  const blocked = blockReason(row);
  if (blocked !== null) return skippedRow(row.id, blocked);
  const demand = row.demand;
  if (demand === null) return skippedRow(row.id, '不是需求行');
  const candidates = generateBatchCandidates([
    {
      rowId: row.id,
      blockMaterialPoRaw: demand.blockMaterialPoRaw,
      itemCodeRaw: demand.itemCodeRaw,
      slots: demand.slots,
    },
  ]);
  if (candidates.length === 0) return { lines: 0, batches: 0, skipped: [] };
  if (await allSlotsGenerated(tx, candidates)) return skipCandidates(candidates, EXISTING_BATCH);
  return { rowId: row.id, version, factoryPartyId: row.factoryPartyId, demand, candidates };
}

async function prepareDemandRow(input: GenerateInput, source: ActionableDemand): Promise<PreparedDemand | PreparedFailure | RowOutcome> {
  const { demand, rowId, version, factoryPartyId, candidates } = source;
  const line = await resolveMaterialLine(input.tx, {
    demand, factoryPartyId, at: input.at, nextOrderLineId: input.nextOrderLineId, nextEntityId: input.nextEntityId,
  });
  if ('reason' in line) return 'material' in line ? { ...line, candidates } : skipCandidates(candidates, line.reason);
  return {
    rowId, version, lineId: line.lineId, material: line.material, matchingLineIds: line.matchingLineIds,
    lineCreated: line.created, factoryPartyId, candidates,
  };
}

function skipCandidates(candidates: readonly BatchCandidate[], reason: string): RowOutcome {
  return { lines: 0, batches: 0, skipped: candidates.map(({ rowId, slotIndex }) => skip({ rowId, slotIndex, reason })) };
}

async function allSlotsGenerated(tx: UnitOfWorkStores, candidates: readonly BatchCandidate[]): Promise<boolean> {
  for (const { rowId, slotIndex } of candidates) {
    if ((await tx.batches.listByOriginRef({ rowId, slotIndex })).length === 0) return false;
  }
  return true;
}

async function generatePreparedRow(input: GenerateInput, row: PreparedDemand & { readonly line: OrderLine }): Promise<RowOutcome> {
  const line = row.line;
  if (row.lineCreated) await auditLine(input, line);
  const made = await createSlots({ ...input, ...row }, line);
  const evidence = row.version === null || made.created.length === 0 ? undefined : {
    rowId: row.rowId, version: row.version, orderLineId: line.id, created: made.created,
  };
  return { lines: row.lineCreated ? 1 : 0, batches: made.created.length, skipped: made.skipped, ...(evidence === undefined ? {} : { evidence }) };
}

export async function freezeGenerationEvidence(tx: UnitOfWorkStores, { created, ...ref }: GenerationEvidence): Promise<void> {
  const sources = await tx.factoryReports.demandSourcesAtGeneration(ref);
  for (const { batchId, slotIndex } of created) {
    const source = sources.get(slotIndex);
    if (source !== undefined) await tx.batches.freezeDemandSource({ batchId, rowId: ref.rowId, source });
  }
}

function blockReason(row: FactoryReportRow): string | null {
  if (row.kind !== 'demand') return '不是需求行';
  if (row.demand?.role === 'parent') return '不是物料行';
  return null;
}

async function auditLine(input: GenerateInput, line: OrderLine): Promise<void> {
  await input.tx.audit.record(
    auditOf({ action: 'line.create', subject: line, ctx: { actor: input.actor, at: input.at, entity: '订单行' } }),
  );
}

async function createSlots(
  input: GenerateInput & {
    readonly lineId: OrderLineId;
    readonly factoryPartyId: EntityId;
    readonly candidates: readonly BatchCandidate[];
  },
  line: OrderLine,
): Promise<{ readonly created: CreatedSlot[]; readonly skipped: SlotSkip[] }> {
  const skipped: SlotSkip[] = [];
  const created: CreatedSlot[] = [];
  if (line.cancelledAt !== null) {
    return { created, skipped: input.candidates.map(({ rowId, slotIndex }) => skip({ rowId, slotIndex, reason: '订单行已取消' })) };
  }
  let seq = nextSeq(await input.tx.batches.listByOrderLine(input.lineId));
  const receiver = line.receiverPartyId ?? input.factoryPartyId;
  for (const slot of input.candidates) {
    const batchId = await createSlot({ ...input, slot, seq, receiver, unit: line.unit, skipped });
    if (batchId === undefined) continue;
    seq += 1;
    created.push({ batchId, slotIndex: slot.slotIndex });
  }
  return { created, skipped };
}

async function createSlot(
  input: GenerateInput & {
    readonly lineId: OrderLineId;
    readonly slot: BatchCandidate;
    readonly seq: number;
    readonly receiver: EntityId;
    readonly unit: string | null;
    readonly skipped: SlotSkip[];
  },
): Promise<DeliveryBatchId | undefined> {
  const prior = await input.tx.batches.listByOriginRef({
    rowId: input.slot.rowId,
    slotIndex: input.slot.slotIndex,
  });
  if (prior.length > 0) {
    input.skipped.push(skip({ rowId: input.slot.rowId, slotIndex: input.slot.slotIndex, reason: EXISTING_BATCH }));
    return undefined;
  }
  const batchId = input.nextDeliveryBatchId();
  const batch = createBatch(
    {
      orderLineId: input.lineId,
      seq: input.seq,
      plannedQty: input.slot.qty,
      plannedUnit: input.unit,
      receiverPartyId: input.receiver,
      dateFactoryRequired: input.slot.date,
      origin: 'from_factory_demand',
      originRef: { rowId: input.slot.rowId, slotIndex: input.slot.slotIndex },
    },
    commandContext({ actor: input.actor, at: input.at, nextId: batchId }),
  );
  const records = { batch, shipments: [], receipts: [], deliveryNote: null };
  await persistBatch({ tx: input.tx, records, dateChanges: [] });
  await input.tx.audit.record(
    auditOf({ action: 'batch.create', subject: batch, ctx: { actor: input.actor, at: input.at, entity: '要货批次' } }),
  );
  return batchId;
}

function skippedRow(rowId: string, reason: string): RowOutcome {
  return { lines: 0, batches: 0, skipped: [skip({ rowId, slotIndex: NO_SLOT, reason })] };
}

function skip({ rowId, slotIndex, reason }: { readonly rowId: string; readonly slotIndex: number; readonly reason: string }): SlotSkip {
  return { rowId, slotIndex, reason };
}

function nextSeq(batches: readonly { readonly seq: number }[]): number {
  let seq = 0;
  for (const batch of batches) if (batch.seq > seq) seq = batch.seq;
  return seq + 1;
}
