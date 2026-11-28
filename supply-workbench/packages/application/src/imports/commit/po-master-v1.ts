import { entityId, orderLineId, poMasterBaseKey, poMasterCandidateKey, type EntityId, type ImportAction, type ImportRow, type OrderLine, type OrderLineId, type PurchaseOrder } from '@sw/domain';
import type { PoMasterPayload } from '../../ports/parsed-rows.js';
import type { CommitContext, CommitResult } from './context.js';
import { isDateCell, isNumberCell, isPoCell, isTextCell } from './parsed-cells.js';
import { applyPoFactories, applyPoRowOwner, poFactoryRelation, type PoFactoryRelation } from './po-master-v1-relations.js';
import { loadPoMasterComparison, verifyPoMasterComparison } from '../po-master-comparison.js';
import { procurementSourceKey } from '../../shared/procurement-source.js';
import { commitPoComponents } from './po-master-components.js';
import { poMasterSuppliers, type PoMasterSuppliers } from './po-master-suppliers.js';

export async function commitPoMaster(ctx: CommitContext): Promise<CommitResult> {
  const repo = ctx.tx.procurement;
  const preview = await repo?.preview(ctx.batch.id);
  const suppliers = poMasterSuppliers(ctx);
  const { finishedBySource, ...result } = await commitFinishedRows({ ctx, suppliers, isProcurementWorkbook: preview != null });
  if (repo !== undefined && preview != null) await commitPoComponents({ ctx, repo, preview, finishedBySource, suppliers });
  await suppliers.saveObservations();
  return result;
}

async function commitFinishedRows({ ctx, suppliers, isProcurementWorkbook }: {
  readonly ctx: CommitContext;
  readonly suppliers: PoMasterSuppliers;
  readonly isProcurementWorkbook: boolean;
}) {
  const keys = keysOf(ctx.rows);
  const presenceKeys = keysOf(ctx.rows, true);
  const affectedLineIds: string[] = [];
  const presentLineIds: string[] = [];
  const factoryRelations: PoFactoryRelation[] = [];
  const finishedBySource = new Map<string, string>();
  const comparison = await loadPoMasterComparison(ctx, isProcurementWorkbook);
  for (const row of ctx.rows) {
    const payload = safePoPayload(row);
    if (!isProcurementWorkbook && payload !== null) suppliers.observe(payload.supplierRaw.value);
    if (row.action === 'skip') {
      const lineId = await skippedLineId({ ctx, row, key: presenceKeys.get(row.id) });
      if (lineId !== null) presentLineIds.push(lineId);
      continue;
    }
    const lineId = await writePoRow({ ctx, row, key: keys.get(row.id), isProcurementWorkbook, suppliers, comparison });
    if (lineId === null) continue;
    finishedBySource.set(procurementSourceKey(row), lineId);
    affectedLineIds.push(lineId);
    presentLineIds.push(lineId);
    if (payload === null) continue;
    if (isProcurementWorkbook) suppliers.observe(payload.supplierRaw.value);
    await applyPoRowOwner({ ctx, lineId, payload });
    const factory = poFactoryRelation({ lineId, payload });
    if (factory !== null) factoryRelations.push(factory);
  }
  await applyPoFactories(ctx, factoryRelations);
  return { affectedLineIds, presentLineIds, finishedBySource };
}

async function skippedLineId(input: { readonly ctx: CommitContext; readonly row: ImportRow; readonly key: string | undefined }): Promise<string | null> {
  if (input.row.targetId !== null) return input.row.targetId;
  const payload = safePoPayload(input.row);
  if (payload === null || input.key === undefined) return null;
  const existing = await existingLine({ ctx: input.ctx, row: input.row, key: input.key, poNorm: payload.po.value?.poNorm ?? null, isNewConflict: false });
  return existing?.id ?? null;
}

async function writePoRow({ ctx, row, key, isProcurementWorkbook, suppliers, comparison }: {
  readonly ctx: CommitContext;
  readonly row: ImportRow;
  readonly key: string | undefined;
  readonly isProcurementWorkbook: boolean;
  readonly suppliers: PoMasterSuppliers;
  readonly comparison: Awaited<ReturnType<typeof loadPoMasterComparison>>;
}): Promise<string | null> {
  const payload = poPayload(row);
  if (payload === null || key === undefined) return null;
  const hasExplicitCreate = isNewConflict(ctx.batch, row.id);
  const existing = await existingLine({ ctx, row, key, poNorm: payload.po.value?.poNorm ?? null, isNewConflict: hasExplicitCreate });
  if (row.targetId !== null && existing === undefined) throw new Error(`冲突目标订单行不存在 ${row.targetId}`);
  if (!hasExplicitCreate) await verifyPoMasterComparison({ comparison, existing, payload, row });
  const compared = comparedRow({ ctx, row, payload, existing, isProcurementWorkbook });
  if (compared !== undefined) return compared;
  return createPoRow({ ctx, row, payload, key, suppliers });
}

function comparedRow(input: { readonly ctx: CommitContext; readonly row: ImportRow; readonly payload: PoMasterPayload; readonly existing: OrderLine | undefined; readonly isProcurementWorkbook: boolean }): Promise<string | null> | undefined {
  if (input.row.action === 'conflict') return Promise.resolve(null);
  if (input.row.action === 'unchanged' && input.existing === undefined) return Promise.resolve(null);
  if (input.existing !== undefined && (input.row.action !== 'create' || input.isProcurementWorkbook)) {
    const row = input.row.action === 'create' ? { ...input.row, action: 'update' as const } : input.row;
    return applyComparedRow({ ctx: input.ctx, row, payload: input.payload, existing: input.existing });
  }
  return undefined;
}

async function createPoRow(input: { readonly ctx: CommitContext; readonly row: ImportRow; readonly payload: PoMasterPayload; readonly key: string; readonly suppliers: PoMasterSuppliers }): Promise<string> {
  const lineId = orderLineId(`${input.row.id}:line`);
  const purchaseOrderId = await purchaseOrderIdOf({ ctx: input.ctx, payload: input.payload, rowId: input.row.id, suppliers: input.suppliers });
  const line = orderLine({ id: lineId, purchaseOrderId, payload: input.payload, key: input.key, at: input.ctx.at });
  const snapshotId = entityId(`${lineId}:snap`);
  await input.ctx.tx.orderLines.save({ ...line, currentSnapshotId: snapshotId });
  await rememberStatus({ ctx: input.ctx, line: { ...line, currentSnapshotId: snapshotId }, row: input.row, payload: input.payload });
  await input.ctx.tx.imports.saveRow({ ...input.row, action: 'create' satisfies ImportAction, targetId: lineId });
  return lineId;
}

async function applyComparedRow(input: { readonly ctx: CommitContext; readonly row: ImportRow; readonly payload: PoMasterPayload; readonly existing: OrderLine }): Promise<string> {
  const remembered = await rememberStatus({ ctx: input.ctx, line: input.existing, row: input.row, payload: input.payload });
  const line = input.row.action === 'update' ? importedLine({ line: remembered, payload: input.payload, at: input.ctx.at }) : remembered;
  if (input.row.action === 'update') await input.ctx.tx.orderLines.save(line);
  await input.ctx.tx.imports.saveRow({ ...input.row, targetId: line.id });
  return line.id;
}

function importedLine(input: { readonly line: OrderLine; readonly payload: PoMasterPayload; readonly at: string }): OrderLine {
  return {
    ...input.line,
    barcodeRaw: input.payload.barcodeRaw.value,
    nameRaw: input.payload.nameRaw.value,
    qtyOrdered: input.payload.qtyOrdered.value,
    updatedAt: input.at,
  };
}

async function existingLine(input: { readonly ctx: CommitContext; readonly row: ImportRow; readonly key: string; readonly poNorm: string | null; readonly isNewConflict: boolean }): Promise<OrderLine | undefined> {
  if (input.row.action === 'create' && input.isNewConflict) return undefined;
  if (input.row.targetId !== null) {
    const line = await input.ctx.tx.orderLines.find(input.row.targetId);
    return line?.lane === 'finished' ? line : undefined;
  }
  return findLine({ ctx: input.ctx, key: input.key, poNorm: input.poNorm });
}

function isNewConflict(batch: CommitContext['batch'], rowId: string): boolean {
  const decisions = recordOf(batch.decisions);
  if (decisions === undefined || !Array.isArray(decisions.conflictResolutions)) return false;
  return decisions.conflictResolutions.some((resolution) => {
    const item = recordOf(resolution);
    return item?.rowId === rowId && item.targetOrderLineId === null;
  });
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

async function rememberStatus(input: { readonly ctx: CommitContext; readonly line: OrderLine; readonly row: ImportRow; readonly payload: PoMasterPayload }): Promise<OrderLine> {
  const snapshotId = input.line.currentSnapshotId ?? entityId(`${input.line.id}:snap`);
  const line = input.line.currentSnapshotId === null ? { ...input.line, currentSnapshotId: snapshotId, updatedAt: input.ctx.at } : input.line;
  if (input.line.currentSnapshotId === null) await input.ctx.tx.orderLines.save(line);
  await input.ctx.tx.orderLines.saveSnapshot({
    id: snapshotId,
    orderLineId: input.line.id,
    importBatchId: input.ctx.batch.id,
    importRowId: input.row.id,
    data: { statusReported: input.payload.statusReported },
  });
  return line;
}

async function findLine({ ctx, key, poNorm }: { readonly ctx: CommitContext; readonly key: string; readonly poNorm: string | null }): Promise<OrderLine | undefined> {
  const orders = poNorm === null || poNorm === ''
    ? await ctx.tx.purchaseOrders.listNoNumber('finished')
    : (await ctx.tx.purchaseOrders.listByPoNorm(poNorm)).filter((order) => order.lane === 'finished');
  for (const order of orders) {
    const lines = await ctx.tx.orderLines.listByPurchaseOrder(order.id);
    const found = lines.find((line) => line.candidateKey === key);
    if (found !== undefined) return found;
  }
  return undefined;
}

function keysOf(rows: readonly ImportRow[], includeSkipped = false): Map<string, string> {
  const seen = new Map<string, number>();
  const keys = new Map<string, string>();
  for (const row of rows) {
    if (!includeSkipped && row.action === 'skip') continue;
    const payload = safePoPayload(row);
    if (payload === null) continue;
    const base = poMasterBaseKey({
      poNorm: payload.po.value?.poNorm ?? null,
      barcode: payload.barcodeRaw.value,
      nameRaw: payload.nameRaw.value,
    });
    const previous = seen.get(base);
    const next = previous === undefined ? 1 : previous + 1;
    seen.set(base, next);
    keys.set(row.id, poMasterCandidateKey(base, next));
  }
  return keys;
}

function poPayload(row: ImportRow): PoMasterPayload | null {
  if (!hasPoIdentity(row.parsed)) return null;
  if (!isPoPayload(row.parsed)) throw new Error('采购订单行无法读取');
  return row.parsed;
}

function safePoPayload(row: ImportRow): PoMasterPayload | null {
  try {
    return poPayload(row);
  } catch {
    return null;
  }
}

function hasPoIdentity(value: unknown): boolean {
  return isRecord(value) && 'po' in value && 'barcodeRaw' in value && 'nameRaw' in value;
}

function isPoPayload(value: unknown): value is PoMasterPayload {
  if (!isRecord(value)) return false;
  return textsOf(value) && numbersOf(value) && datesOf(value) && isPoCell(value.po);
}

function textsOf(value: Record<string, unknown>): boolean {
  return isTextCell(value.oaDemandRef) && isTextCell(value.supplierRaw) && isTextCell(value.nameRaw) && isTextCell(value.barcodeRaw) && isTextCell(value.statusReported);
}

function numbersOf(value: Record<string, unknown>): boolean {
  return isNumberCell(value.qtyOrdered) && isNumberCell(value.plannedDurationDays) && isNumberCell(value.actualDurationDays) && isNumberCell(value.factoryStockReported) && restNumbers(value);
}

function restNumbers(value: Record<string, unknown>): boolean {
  return isNumberCell(value.shippedQtyReported) && isNumberCell(value.qtyDiffReported);
}

function datesOf(value: Record<string, unknown>): boolean {
  return isDateCell(value.oaSubmittedOn) && isDateCell(value.oaRequiredOn) && isDateCell(value.actualStartOn) && isDateCell(value.firstDeliveryOn) && isDateCell(value.actualEndOn);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function purchaseOrderIdOf({ ctx, payload, rowId, suppliers }: { readonly ctx: CommitContext; readonly payload: PoMasterPayload; readonly rowId: string; readonly suppliers: PoMasterSuppliers }): Promise<EntityId> {
  const existing = await findPurchaseOrder(ctx, payload);
  if (existing !== undefined) return existing;
  const id = entityId(`${rowId}:po`);
  const supplierPartyId = await suppliers.approvedPartyId(payload.supplierRaw.value);
  await ctx.tx.purchaseOrders.save(purchaseOrder({ id, payload, supplierPartyId, at: ctx.at }));
  return id;
}

async function findPurchaseOrder(ctx: CommitContext, payload: PoMasterPayload): Promise<EntityId | undefined> {
  const poNorm = payload.po.value?.poNorm ?? null;
  if (poNorm !== null && poNorm !== '') {
    return (await ctx.tx.purchaseOrders.listByPoNorm(poNorm)).find((order) => order.lane === 'finished')?.id;
  }
  const supplier = payload.supplierRaw.value;
  const blanks = await ctx.tx.purchaseOrders.listNoNumber('finished');
  return blanks.find((order) => order.supplierRaw === supplier)?.id;
}

function purchaseOrder(input: { readonly id: EntityId; readonly payload: PoMasterPayload; readonly supplierPartyId: EntityId | null; readonly at: string }): PurchaseOrder {
  return {
    id: input.id,
    createdAt: input.at,
    updatedAt: input.at,
    ...numberOf(input.payload),
    supplierPartyId: input.supplierPartyId,
    supplierRaw: input.payload.supplierRaw.value,
    lane: 'finished',
    oaDemandRef: input.payload.oaDemandRef.value,
  };
}

function numberOf(payload: PoMasterPayload): Pick<PurchaseOrder, 'poRaw' | 'poNorm' | 'poFormat' | 'relatedPoRaws'> {
  const po = payload.po.value;
  const relatedPoRaws = po?.relatedPoRaws ?? [];
  if (po?.poNorm === undefined || po.poNorm === null || po.poNorm === '') {
    return { poRaw: null, poNorm: null, poFormat: 'NONE', relatedPoRaws };
  }
  return { poRaw: po.poRaw, poNorm: po.poNorm, poFormat: po.poFormat, relatedPoRaws };
}

function orderLine(input: { readonly id: OrderLineId; readonly purchaseOrderId: EntityId; readonly payload: PoMasterPayload; readonly key: string; readonly at: string }): OrderLine {
  return {
    id: input.id,
    createdAt: input.at,
    updatedAt: input.at,
    purchaseOrderId: input.purchaseOrderId,
    lane: 'finished',
    itemId: null,
    itemCodeRaw: null,
    barcodeRaw: input.payload.barcodeRaw.value,
    nameRaw: input.payload.nameRaw.value,
    qtyOrdered: input.payload.qtyOrdered.value,
    unit: null,
    buyerUserId: null,
    receiverPartyId: null,
    origin: 'import_po_master',
    currentSnapshotId: null,
    candidateKey: input.key,
    missingInLatestImport: false,
    cancelledAt: null,
    cancelReason: null,
    stage: 'no_batch',
    stageChangedAt: input.at,
    nextDueBatchId: null,
    nextDueDate: null,
  };
}
