import { and, eq } from 'drizzle-orm';
import { NotFoundError, OrderLineLockBusy, StateConflictError } from '@sw/application/errors';
import { LANES, LINE_ORIGINS, LINE_STAGES, localDate, normalizeText, projectLatestImportPresence, type OrderLine, type OrderLineSnapshot } from '@sw/domain';
import type { OrderLineRepository } from '../../../application/src/ports/order-line-repository.js';
import type { AppDatabase } from '../client.js';
import { numberOrNull, numberToDb } from '../mappers/number.js';
import { instant, instantOrNull } from '../mappers/time.js';
import { reportedOrderStatus } from '../mappers/reported-order-status.js';
import { orderLineSnapshots, orderLines } from '../schema/orders.js';
import { deliveryBatchIdOrNull, entityId, entityIdOrNull, orderLineId } from '../mappers/id.js';
import { postgresErrorCode, violatesUnique } from './unique-violation.js';

export function orderLineRepository(db: AppDatabase): OrderLineRepository {
  return {
    get: (id) => getLine(db, id),
    lock: (id, options) => lockLine(db, { id, noWait: options?.noWait === true }),
    find: (id) => findLine(db, id),
    save: (entity) => saveLine(db, entity),
    saveConditional: (entity, expectedUpdatedAt) => saveLineConditional({ db, entity, expectedUpdatedAt }),
    listAll: async () => (await db.select().from(orderLines)).map(orderLineOfRow),
    listByPurchaseOrder: (purchaseOrderId) => listLines(db, purchaseOrderId),
    listByCodeNorm: (codeNorm) => listByCode(db, codeNorm),
    saveSnapshot: (snapshot) => saveSnapshot(db, snapshot),
    reportedStatus: (lineId) => reportedStatus(db, lineId),
  };
}

async function lockLine(db: AppDatabase, { id, noWait }: { readonly id: string; readonly noWait: boolean }): Promise<OrderLine> {
  try {
    const [row] = await db.select().from(orderLines).where(eq(orderLines.id, id)).for('update', noWait ? { noWait: true } : undefined);
    if (row === undefined) throw new NotFoundError('订单行', id);
    return orderLineOfRow(row);
  } catch (error) {
    if (noWait && postgresErrorCode(error) === '55P03') throw new OrderLineLockBusy(id);
    throw error;
  }
}

async function getLine(db: AppDatabase, id: string): Promise<OrderLine> {
  const found = await findLine(db, id);
  if (found === undefined) throw new NotFoundError('订单行', id);
  return found;
}

async function findLine(db: AppDatabase, id: string): Promise<OrderLine | undefined> {
  const row = (await db.select().from(orderLines).where(eq(orderLines.id, id)))[0];
  return row === undefined ? undefined : orderLineOfRow(row);
}

async function listLines(db: AppDatabase, purchaseOrderId: string): Promise<readonly OrderLine[]> {
  return (await db.select().from(orderLines).where(eq(orderLines.purchaseOrderId, purchaseOrderId))).map(orderLineOfRow);
}

async function listByCode(db: AppDatabase, codeNorm: string): Promise<readonly OrderLine[]> {
  if (codeNorm === '') return [];
  const rows = (await db.select().from(orderLines)).map(orderLineOfRow);
  return rows.filter((line) => sameCode(line.itemCodeRaw, codeNorm) || sameCode(line.barcodeRaw, codeNorm));
}

function sameCode(raw: string | null, codeNorm: string): boolean {
  if (raw === null) return false;
  return normalizeText(raw) === codeNorm;
}

async function saveSnapshot(db: AppDatabase, snapshot: OrderLineSnapshot): Promise<void> {
  await db.insert(orderLineSnapshots).values(snapshot).onConflictDoUpdate({ target: orderLineSnapshots.id, set: snapshot });
}

async function reportedStatus(db: AppDatabase, lineId: string): Promise<string | null> {
  const [row] = await db.select({ status: reportedOrderStatus }).from(orderLines)
    .leftJoin(orderLineSnapshots, eq(orderLineSnapshots.id, orderLines.currentSnapshotId))
    .where(eq(orderLines.id, lineId));
  return row?.status ?? null;
}

function isCandidateKeyConflict(error: unknown): boolean {
  return violatesUnique(error, 'order_lines_candidate_key_uq');
}

async function saveLine(db: AppDatabase, entity: OrderLine): Promise<void> {
  const row = toLineRow(entity);
  try {
    await db.insert(orderLines).values(row).onConflictDoUpdate({ target: orderLines.id, set: row });
  } catch (error) {
    if (isCandidateKeyConflict(error)) throw new StateConflictError('candidate_key');
    throw error;
  }
}

async function saveLineConditional(input: { readonly db: AppDatabase; readonly entity: OrderLine; readonly expectedUpdatedAt: string }): Promise<boolean> {
  const row = toLineRow(input.entity);
  try {
    const updated = await input.db.update(orderLines)
      .set(row)
      .where(and(eq(orderLines.id, input.entity.id), eq(orderLines.updatedAt, input.expectedUpdatedAt)))
      .returning();
    return updated.length === 1;
  } catch (error) {
    if (isCandidateKeyConflict(error)) throw new StateConflictError('candidate_key');
    throw error;
  }
}

export function orderLineOfRow(row: typeof orderLines.$inferSelect): OrderLine {
  return {
    id: orderLineId(row.id),
    createdAt: instant(row.createdAt),
    updatedAt: instant(row.updatedAt),
    purchaseOrderId: entityId(row.purchaseOrderId),
    lane: oneOf(LANES, row.lane),
    itemId: entityIdOrNull(row.itemId),
    itemCodeRaw: row.itemCodeRaw,
    barcodeRaw: row.barcodeRaw,
    nameRaw: row.nameRaw,
    qtyOrdered: numberOrNull(row.qtyOrdered),
    unit: row.unit,
    buyerUserId: entityIdOrNull(row.buyerUserId),
    receiverPartyId: entityIdOrNull(row.receiverPartyId),
    origin: oneOf(LINE_ORIGINS, row.origin),
    currentSnapshotId: entityIdOrNull(row.currentSnapshotId),
    candidateKey: row.candidateKey,
    ...projectLatestImportPresence({ latestImportPresence: row.latestImportPresence, missingInLatestImport: row.missingInLatestImport, origin: row.origin }),
    cancelledAt: instantOrNull(row.cancelledAt),
    cancelReason: row.cancelReason,
    stage: oneOf(LINE_STAGES, row.stage),
    stageChangedAt: instant(row.stageChangedAt),
    nextDueBatchId: deliveryBatchIdOrNull(row.nextDueBatchId),
    nextDueDate: row.nextDueDate === null ? null : localDate(row.nextDueDate),
  };
}

function toLineRow(entity: OrderLine): typeof orderLines.$inferInsert {
  return { ...entity, qtyOrdered: numberToDb(entity.qtyOrdered), ...projectLatestImportPresence(entity) };
}

function oneOf<T extends string>(values: readonly T[], value: string): T {
  for (const item of values) if (item === value) return item;
  throw new Error(`未知枚举 ${value}`);
}
