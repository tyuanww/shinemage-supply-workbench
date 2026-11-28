import { and, eq, inArray, sql } from 'drizzle-orm';
import { NotFoundError } from '@sw/application/errors';
import {
  BATCH_ORIGINS,
  BATCH_STATUSES,
  DATE_CHANGE_FIELDS,
  NOTE_STATUSES,
  RECEIPT_CATEGORIES,
  localDate,
  type BatchDateChange,
  type DeliveryBatch,
  type DeliveryNote,
  type Receipt,
  type Shipment,
} from '@sw/domain';
import { deliveryBatchId, entityId, entityIdOrNull, orderLineId } from '../mappers/id.js';
import type { BatchWithRecords, DeliveryBatchRepository } from '../../../application/src/ports/delivery-batch-repository.js';
import type { AppDatabase } from '../client.js';
import { numberOrNull, numberToDb } from '../mappers/number.js';
import { instant, instantOrNull } from '../mappers/time.js';
import { batchDateChanges, deliveryBatches, deliveryNotes, receipts, shipments } from '../schema/orders.js';

export function deliveryBatchRepository(db: AppDatabase): DeliveryBatchRepository {
  return {
    get: (id) => requireBatch(db, id),
    find: (id) => findBatch(db, id),
    getWithRecords: async (id) => recordsOf(db, await requireBatch(db, id)),
    lockWithRecords: async (id) => recordsOf(db, await lockBatch(db, id)),
    listByOrderLine: (orderLineId) => listByLine(db, orderLineId),
    listByOriginRef: (ref) => listBySlot(db, ref),
    lockDemandGeneration: (scope) => lockDemandGeneration(db, scope),
    findAdoptedShipment: (rowId) => adopted(db, rowId),
    findBatchIdOf: (kind, recordId) => batchIdOf({ db, kind, recordId }),
    save: (entity) => saveBatch(db, entity),
    saveWithRecords: (records) => saveRecords(db, records),
    freezeDemandSource: (input) => freezeDemandSource(db, input),
    saveWithRecordsConditional: (records, expectedUpdatedAt) => saveRecordsConditional({ db, records, expectedUpdatedAt }),
    remove: (id) => removeBatch(db, id),
  };
}

async function requireBatch(db: AppDatabase, id: string): Promise<DeliveryBatch> {
  const found = await findBatch(db, id);
  if (found === undefined) throw new NotFoundError('要货批次', id);
  return found;
}

async function findBatch(db: AppDatabase, id: string): Promise<DeliveryBatch | undefined> {
  const row = (await db.select().from(deliveryBatches).where(eq(deliveryBatches.id, id)))[0];
  return row === undefined ? undefined : toBatch(row);
}

async function lockBatch(db: AppDatabase, id: string): Promise<DeliveryBatch> {
  const [row] = await db.select().from(deliveryBatches).where(eq(deliveryBatches.id, id)).for('update');
  if (row === undefined) throw new NotFoundError('要货批次', id);
  return toBatch(row);
}

async function recordsOf(db: AppDatabase, batch: DeliveryBatch): Promise<BatchWithRecords> {
  const id = batch.id;
  const shipped = await db.select().from(shipments).where(eq(shipments.batchId, id));
  const received = await db.select().from(receipts).where(eq(receipts.batchId, id));
  const noted = await db.select().from(deliveryNotes).where(eq(deliveryNotes.batchId, id));
  const changed = await db.select().from(batchDateChanges).where(eq(batchDateChanges.batchId, id));
  return {
    batch,
    shipments: shipped.map(toShipment),
    receipts: received.map(toReceipt),
    deliveryNote: noted[0] === undefined ? null : toNote(noted[0]),
    dateChanges: changed.map(toChange),
  };
}

async function saveRecords(db: AppDatabase, records: BatchWithRecords): Promise<void> {
  await saveBatch(db, records.batch);
  await db.delete(shipments).where(eq(shipments.batchId, records.batch.id));
  await db.delete(receipts).where(eq(receipts.batchId, records.batch.id));
  await db.delete(deliveryNotes).where(eq(deliveryNotes.batchId, records.batch.id));
  await db.delete(batchDateChanges).where(eq(batchDateChanges.batchId, records.batch.id));
  if (records.shipments.length > 0) await db.insert(shipments).values(records.shipments.map(shipmentRow));
  if (records.receipts.length > 0) await db.insert(receipts).values(records.receipts.map(receiptRow));
  if (records.deliveryNote !== null) await db.insert(deliveryNotes).values(noteRow(records.deliveryNote));
  if (records.dateChanges.length > 0) await db.insert(batchDateChanges).values(records.dateChanges.map(changeRow));
}

async function saveRecordsConditional(input: { readonly db: AppDatabase; readonly records: BatchWithRecords; readonly expectedUpdatedAt: string }): Promise<boolean> {
  const row = batchRow(input.records.batch);
  const updated = await input.db.update(deliveryBatches)
    .set(batchUpdate(row))
    .where(and(eq(deliveryBatches.id, input.records.batch.id), eq(deliveryBatches.updatedAt, input.expectedUpdatedAt)))
    .returning();
  if (updated.length !== 1) return false;
  await input.db.delete(shipments).where(eq(shipments.batchId, input.records.batch.id));
  await input.db.delete(receipts).where(eq(receipts.batchId, input.records.batch.id));
  await input.db.delete(deliveryNotes).where(eq(deliveryNotes.batchId, input.records.batch.id));
  await input.db.delete(batchDateChanges).where(eq(batchDateChanges.batchId, input.records.batch.id));
  if (input.records.shipments.length > 0) await input.db.insert(shipments).values(input.records.shipments.map(shipmentRow));
  if (input.records.receipts.length > 0) await input.db.insert(receipts).values(input.records.receipts.map(receiptRow));
  if (input.records.deliveryNote !== null) await input.db.insert(deliveryNotes).values(noteRow(input.records.deliveryNote));
  if (input.records.dateChanges.length > 0) await input.db.insert(batchDateChanges).values(input.records.dateChanges.map(changeRow));
  return true;
}

async function saveBatch(db: AppDatabase, entity: DeliveryBatch): Promise<void> {
  const row = batchRow(entity);
  const originRef = entity.originRef;
  const insert = entity.origin === 'from_factory_demand' && originRef !== null
    ? { ...row, originRef: { ...originRef, generationSource: null } }
    : row;
  await db.insert(deliveryBatches).values(insert).onConflictDoUpdate({ target: deliveryBatches.id, set: batchUpdate(row) });
}

async function freezeDemandSource(db: AppDatabase, { batchId, rowId, source }: Parameters<DeliveryBatchRepository['freezeDemandSource']>[0]): Promise<void> {
  const ref = deliveryBatches.originRef;
  await db.update(deliveryBatches).set({ originRef: sql`${ref} || ${sql.param({ generationSource: source }, ref)}` })
    .where(and(eq(deliveryBatches.id, batchId), eq(deliveryBatches.origin, 'from_factory_demand'),
      sql`${ref}->>'rowId' = ${rowId} and ${ref}->>'slotIndex' = ${String(source.slot.index)} and ${ref}->'generationSource' = 'null'::jsonb`));
}

function batchUpdate(row: typeof deliveryBatches.$inferInsert) {
  const stored = deliveryBatches.originRef;
  return {
    ...row,
    // 此处也要保留 null。它记录了新批生成时无法确认原表，不能回退到现时工厂行。
    originRef: sql`case when ${stored} ? 'generationSource' then ${stored} else ${sql.param(row.originRef ?? null, stored)} end`,
  };
}

async function removeBatch(db: AppDatabase, id: string): Promise<void> {
  await requireBatch(db, id);
  await db.delete(shipments).where(eq(shipments.batchId, id));
  await db.delete(receipts).where(eq(receipts.batchId, id));
  await db.delete(deliveryNotes).where(eq(deliveryNotes.batchId, id));
  await db.delete(batchDateChanges).where(eq(batchDateChanges.batchId, id));
  await db.delete(deliveryBatches).where(eq(deliveryBatches.id, id));
}

async function listByLine(db: AppDatabase, orderLineId: string): Promise<readonly DeliveryBatch[]> {
  return (await db.select().from(deliveryBatches).where(eq(deliveryBatches.orderLineId, orderLineId))).map(toBatch);
}

async function listBySlot(db: AppDatabase, ref: { readonly rowId: string; readonly slotIndex: number }): Promise<readonly DeliveryBatch[]> {
  const rows = await db.select().from(deliveryBatches).where(sql`${deliveryBatches.originRef}->>'rowId' = ${ref.rowId} and (${deliveryBatches.originRef}->>'slotIndex')::int = ${ref.slotIndex}`);
  return rows.map(toBatch);
}

async function lockDemandGeneration(db: AppDatabase, scope: Parameters<DeliveryBatchRepository['lockDemandGeneration']>[0]): Promise<void> {
  const isRowScope = 'rowIds' in scope;
  const namespace = isRowScope ? 'supply.follow-up.demand-generation:' : 'supply.follow-up.material-order:';
  const keys = isRowScope ? scope.rowIds : scope.materialOrderNumbers.map((number) => JSON.stringify(number));
  if (keys.length === 0) return;
  await db.execute(sql`
    select pg_advisory_xact_lock(lock_key)
    from (
      select distinct hashtextextended(${namespace} || value, 0) as lock_key
      from jsonb_array_elements_text(${JSON.stringify(keys)}::jsonb) as generation_keys(value)
      order by lock_key
    ) generation_lock_keys
  `);
}

async function adopted(db: AppDatabase, rowId: string) {
  const row = (await db.select().from(shipments).where(eq(shipments.factoryShipmentRowId, rowId)))
    .find((item) => item.voidedAt === null);
  return row === undefined ? undefined : { shipmentId: row.id, batchId: row.batchId };
}

async function batchIdOf({ db, kind, recordId }: { readonly db: AppDatabase; readonly kind: 'shipment' | 'receipt' | 'delivery_note'; readonly recordId: string }): Promise<string | undefined> {
  if (kind === 'shipment') return (await db.select().from(shipments).where(eq(shipments.id, recordId)))[0]?.batchId;
  if (kind === 'receipt') return (await db.select().from(receipts).where(eq(receipts.id, recordId)))[0]?.batchId;
  return (await db.select().from(deliveryNotes).where(eq(deliveryNotes.id, recordId)))[0]?.batchId;
}

function toBatch(row: typeof deliveryBatches.$inferSelect): DeliveryBatch {
  const { plannedUnit, ...stored } = row;
  return {
    ...stored,
    ...(plannedUnit === null ? {} : { plannedUnit }),
    id: deliveryBatchId(row.id),
    orderLineId: orderLineId(row.orderLineId),
    receiverPartyId: entityId(row.receiverPartyId),
    confirmedBy: entityIdOrNull(row.confirmedBy),
    createdAt: instant(row.createdAt),
    updatedAt: instant(row.updatedAt),
    plannedQty: requiredNumber(row.plannedQty),
    dateFactoryRequired: dayOrNull(row.dateFactoryRequired),
    dateSupplierPromised: dayOrNull(row.dateSupplierPromised),
    dateBuyerConfirmed: dayOrNull(row.dateBuyerConfirmed),
    firstConfirmedDate: dayOrNull(row.firstConfirmedDate),
    confirmedAt: instantOrNull(row.confirmedAt),
    status: oneOf(BATCH_STATUSES, row.status),
    statusChangedAt: instant(row.statusChangedAt),
    origin: oneOf(BATCH_ORIGINS, row.origin),
    originRef: refOf(row.originRef),
    closedAt: instantOrNull(row.closedAt),
    cancelledAt: instantOrNull(row.cancelledAt),
  };
}

function batchRow(entity: DeliveryBatch): typeof deliveryBatches.$inferInsert {
  return { ...entity, plannedQty: numberToDb(entity.plannedQty) ?? '' };
}

function toShipment(row: typeof shipments.$inferSelect): Shipment {
  return { ...row, id: entityId(row.id), batchId: deliveryBatchId(row.batchId), factoryShipmentRowId: entityIdOrNull(row.factoryShipmentRowId), createdBy: entityId(row.createdBy), voidedBy: entityIdOrNull(row.voidedBy), createdAt: instant(row.createdAt), updatedAt: instant(row.updatedAt), qty: requiredNumber(row.qty), shippedOn: localDate(row.shippedOn), source: shipmentSource(row.source), voidedAt: instantOrNull(row.voidedAt) };
}

function shipmentRow(entity: Shipment): typeof shipments.$inferInsert {
  return { ...entity, qty: numberToDb(entity.qty) ?? '' };
}

function toReceipt(row: typeof receipts.$inferSelect): Receipt {
  return { ...row, id: entityId(row.id), batchId: deliveryBatchId(row.batchId), createdBy: entityId(row.createdBy), voidedBy: entityIdOrNull(row.voidedBy), createdAt: instant(row.createdAt), updatedAt: instant(row.updatedAt), qty: requiredNumber(row.qty), receivedOn: localDate(row.receivedOn), category: oneOf(RECEIPT_CATEGORIES, row.category), source: receiptSource(row.source), voidedAt: instantOrNull(row.voidedAt) };
}

function receiptRow(entity: Receipt): typeof receipts.$inferInsert {
  return { ...entity, qty: numberToDb(entity.qty) ?? '' };
}

function toNote(row: typeof deliveryNotes.$inferSelect): DeliveryNote {
  return {
    ...row,
    id: entityId(row.id),
    batchId: deliveryBatchId(row.batchId),
    fileId: entityIdOrNull(row.fileId),
    createdBy: entityId(row.createdBy),
    voidedBy: entityIdOrNull(row.voidedBy),
    createdAt: instant(row.createdAt),
    updatedAt: instant(row.updatedAt),
    status: noteStatusOf(row.status),
    returnedOn: dayOrNull(row.returnedOn),
    verifiedOn: dayOrNull(row.verifiedOn),
    voidedAt: instantOrNull(row.voidedAt),
  };
}

function noteStatusOf(value: string): DeliveryNote['status'] {
  const status = oneOf(NOTE_STATUSES, value);
  if (status === 'missing') throw new Error('送货单没有未回传状态');
  return status;
}

function shipmentSource(value: string): Shipment['source'] {
  if (value === 'manual' || value === 'factory_report_adopted') return value;
  throw new Error(`未知发货来源 ${value}`);
}

function receiptSource(value: string): Receipt['source'] {
  if (value === 'workbench' || value === 'srm') return value;
  throw new Error(`未知收货来源 ${value}`);
}

function noteRow(entity: DeliveryNote): typeof deliveryNotes.$inferInsert {
  return entity;
}

function toChange(row: typeof batchDateChanges.$inferSelect): BatchDateChange {
  return { ...row, id: entityId(row.id), batchId: deliveryBatchId(row.batchId), changedBy: entityId(row.changedBy), field: oneOf(DATE_CHANGE_FIELDS, row.field), oldValue: dayOrNull(row.oldValue), newValue: dayOrNull(row.newValue), changedAt: instant(row.changedAt) };
}

function changeRow(entity: BatchDateChange): typeof batchDateChanges.$inferInsert {
  return entity;
}

function dayOrNull(value: string | null) {
  return value === null ? null : localDate(value);
}

function refOf(value: unknown): DeliveryBatch['originRef'] {
  if (typeof value !== 'object' || value === null || !('rowId' in value) || !('slotIndex' in value)) return null;
  const rowId = value.rowId;
  const slotIndex = value.slotIndex;
  if (typeof rowId !== 'string' || typeof slotIndex !== 'number') return null;
  return { rowId, slotIndex };
}

function requiredNumber(value: string | null): number {
  const parsed = numberOrNull(value);
  if (parsed === null) throw new Error('数量缺失');
  return parsed;
}

function oneOf<T extends string>(values: readonly T[], value: string): T {
  for (const item of values) if (item === value) return item;
  throw new Error(`未知枚举 ${value}`);
}

export async function fulfillmentRecordsByLines(db: AppDatabase, lineIds: readonly string[]) {
  if (lineIds.length === 0) return { batches: [], shipments: [], receipts: [] };
  const heads = await db.select().from(deliveryBatches).where(inArray(deliveryBatches.orderLineId, [...lineIds]));
  if (heads.length === 0) return { batches: [], shipments: [], receipts: [] };
  const batchIds = heads.map((head) => head.id);
  const [sent, received] = await Promise.all([
    db.select().from(shipments).where(inArray(shipments.batchId, batchIds)),
    db.select().from(receipts).where(inArray(receipts.batchId, batchIds)),
  ]);
  return { batches: heads.map(toBatch), shipments: sent.map(toShipment), receipts: received.map(toReceipt) };
}
