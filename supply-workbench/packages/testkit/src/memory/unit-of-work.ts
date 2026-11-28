import { NotFoundError, StateConflictError } from '@sw/application/errors';
import { normalizeText, type BomLine, type DeliveryNote, type Lane, type ProductContact, type ProductContactRole } from '@sw/domain';
import type {
  BatchWithRecords,
  DeliveryBatchRepository,
} from '../../../application/src/ports/delivery-batch-repository.js';
import type { UnitOfWork, UnitOfWorkStores } from '../../../application/src/ports/unit-of-work.js';
import type { PurchaseOrderRepository } from '../../../application/src/ports/purchase-order-repository.js';
import type { MemoryBox } from './box.js';
import { factoryReportRepository } from './factory-reports.js';
import { idRepository } from './repository.js';
import {
  aliasRepository,
  codeLinkRepository,
  itemCodeRepository,
  itemNameRepository,
} from './review-stores.js';
import {
  auditLog,
  settingsRepository,
  userRepository,
  weeklyReportRepository,
} from './services.js';

export function storesOf(box: MemoryBox): UnitOfWorkStores {
  const items = idRepository(() => box.current.items, '物料');
  return {
    users: userRepository(box),
    settings: settingsRepository(box),
    parties: idRepository(() => box.current.parties, '主体'),
    aliases: aliasRepository(box),
    items: { ...items, lock: items.get },
    itemCodes: itemCodeRepository(box),
    itemNames: itemNameRepository(box),
    codeLinks: codeLinkRepository(box),
    purchaseOrders: purchaseOrderRepository(box),
    orderLines: orderLineRepository(box),
    batches: batchRepository(box),
    exceptions: removable({ repo: idRepository(() => box.current.exceptions, '异常'), rows: () => box.current.exceptions, entity: '异常' }
    ),
    followUps: removable({ repo: idRepository(() => box.current.followUps, '跟进'), rows: () => box.current.followUps, entity: '跟进' }
    ),
    factoryReports: factoryReportRepository(box),
    imports: importRepository(box),
    products: idRepository(() => box.current.products, '产品'),
    productImages: productImageRepository(box),
    productContacts: productContactRepository(box),
    bomLines: bomLineRepository(box),
    weeklyReports: weeklyReportRepository(box),
    audit: auditLog(box),
  };
}

export function memoryUnitOfWork(box: MemoryBox): UnitOfWork {
  let pending = Promise.resolve();
  return {
    async run(fn) {
      if (box.transaction.getStore()?.active === true) return runTurn(box, fn);
      const turn = pending.then(() => runTransaction(box, fn));
      pending = turn.then(() => undefined, () => undefined);
      return turn;
    },
  };
}

async function runTransaction<T>(box: MemoryBox, fn: (stores: UnitOfWorkStores) => Promise<T>): Promise<T> {
  const transaction = { active: true };
  try {
    return await box.transaction.run(transaction, () => runTurn(box, fn));
  } finally {
    transaction.active = false;
  }
}

async function runTurn<T>(box: MemoryBox, fn: (stores: UnitOfWorkStores) => Promise<T>): Promise<T> {
  const before = structuredClone(box.current);
  try {
    return await fn(storesOf(box));
  } catch (error) {
    box.current = before;
    throw error;
  }
}

function batchRepository(box: MemoryBox): DeliveryBatchRepository {
  const repo = idRepository(() => box.current.batches, '要货批次');
  return {
    ...repo,
    getWithRecords: (id) => batchWithRecords(box, id),
    lockWithRecords: (id) => batchWithRecords(box, id),
    listByOrderLine: async (orderLineId) => batchesOnLine(box, orderLineId),
    listByOriginRef: async (ref) => batchesFromSlot(box, ref),
    lockDemandGeneration: async () => {},
    findAdoptedShipment: async (rowId) => adoptedShipment(box, rowId),
    findBatchIdOf: async (kind, recordId) => findBatchId({ box, kind, recordId }),
    saveWithRecords: async (records) => saveBatchRecords(box, records),
    freezeDemandSource: async () => {},
    saveWithRecordsConditional: async (records, expectedUpdatedAt) => {
      const current = box.current.batches.get(records.batch.id);
      if (current === undefined || current.updatedAt !== expectedUpdatedAt) return false;
      saveBatchRecords(box, records);
      return true;
    },
    remove: async (id) => removeBatch(box, id),
  };
}

function importRepository(box: MemoryBox): UnitOfWorkStores['imports'] {
  const repo = idRepository(() => box.current.imports, '导入批次');
  return {
    ...repo,
    async save(entity: import('@sw/domain').ImportBatch) {
      box.current.imports.set(entity.id, { ...entity });
    },
    async saveConditional(entity: import('@sw/domain').ImportBatch, expectedRevision: number) {
      const current = box.current.imports.get(entity.id);
      if (current === undefined || (current.revision ?? 0) !== expectedRevision) return false;
      box.current.imports.set(entity.id, { ...entity, revision: expectedRevision + 1 });
      return true;
    },
    async list() {
      return [...box.current.imports.values()];
    },
    async listRows(batchId) {
      return [...box.current.importRows.values()].filter((row) => row.importBatchId === batchId);
    },
    async saveRow(row) {
      box.current.importRows.set(row.id, row);
    },
  };
}

function orderLineRepository(box: MemoryBox) {
  const repo = idRepository(() => box.current.orderLines, '订单行');
  return {
    ...repo,
    lock: repo.get,
    save: (entity: import('@sw/domain').OrderLine) => saveUniqueLine({ box, repo, entity }),
    async listAll() {
      return [...box.current.orderLines.values()];
    },
    async saveConditional(entity: import('@sw/domain').OrderLine, expectedUpdatedAt: string) {
      const current = box.current.orderLines.get(entity.id);
      if (current === undefined || current.updatedAt !== expectedUpdatedAt) return false;
      if (duplicateCandidateKey(box, entity)) throw new StateConflictError('candidate_key');
      box.current.orderLines.set(entity.id, entity);
      return true;
    },
    async listByPurchaseOrder(purchaseOrderId: string) {
      return [...box.current.orderLines.values()].filter((row) => row.purchaseOrderId === purchaseOrderId);
    },
    async listByCodeNorm(codeNorm: string) {
      return [...box.current.orderLines.values()].filter((row) => sameCode(row.itemCodeRaw, codeNorm) || sameCode(row.barcodeRaw, codeNorm));
    },
    async saveSnapshot(snapshot: { readonly id: string; readonly orderLineId: string; readonly data: unknown }) {
      const status = statusOf(snapshot.data);
      if (status !== null) box.current.reportedStatuses.set(snapshot.orderLineId, status);
    },
    async reportedStatus(lineId: string) {
      return box.current.reportedStatuses.get(lineId) ?? null;
    },
  };
}

async function saveUniqueLine(input: { readonly box: MemoryBox; readonly repo: { save(entity: import('@sw/domain').OrderLine): Promise<void> }; readonly entity: import('@sw/domain').OrderLine }): Promise<void> {
  if (duplicateCandidateKey(input.box, input.entity)) throw new StateConflictError('candidate_key');
  await input.repo.save(input.entity);
}

function duplicateCandidateKey(box: MemoryBox, entity: import('@sw/domain').OrderLine): boolean {
  const key = entity.candidateKey;
  if (key === null) return false;
  for (const line of box.current.orderLines.values()) {
    if (line.id !== entity.id && line.candidateKey === key) return true;
  }
  return false;
}

function purchaseOrderRepository(box: MemoryBox): PurchaseOrderRepository {
  const repo = idRepository(() => box.current.purchaseOrders, '采购单');
  return {
    ...repo,
    async listByPoNorm(poNorm: string) {
      return [...box.current.purchaseOrders.values()].filter((row) => row.poNorm === poNorm);
    },
    async listNoNumber(lane: Lane) {
      return [...box.current.purchaseOrders.values()].filter((row) => row.poRaw === null && row.poFormat === 'NONE' && row.lane === lane);
    },
    async backfillMissingSupplier({ normName, partyId, at }) {
      const updated = [];
      for (const order of box.current.purchaseOrders.values()) {
        if (order.supplierPartyId !== null || !sameCode(order.supplierRaw, normName)) continue;
        box.current.purchaseOrders.set(order.id, { ...order, supplierPartyId: partyId, updatedAt: at });
        updated.push(order.id);
      }
      return updated;
    },
  };
}

function productImageRepository(box: MemoryBox) {
  const repo = idRepository(() => box.current.productImages, '产品图片');
  return {
    ...repo,
    async listByProduct(productId: string) {
      return [...box.current.productImages.values()].filter((row) => row.productId === productId);
    },
  };
}

function productContactRepository(box: MemoryBox) {
  return {
    async listByProduct(productId: string) {
      return box.current.productContacts.get(productId) ?? [];
    },
    async replaceRole({ productId, role, people }: { readonly productId: string; readonly role: ProductContactRole; readonly people: readonly ProductContact[] }) {
      const current = box.current.productContacts.get(productId) ?? [];
      box.current.productContacts.set(productId, [...current.filter((row) => row.role !== role), ...people]);
    },
  };
}

function bomLineRepository(box: MemoryBox) {
  return {
    async replace(productBarcodeRaw: string, lines: readonly BomLine[]) {
      box.current.bomLines.set(productBarcodeRaw, lines.map((line) => ({ ...line })));
    },
  };
}

function statusOf(data: unknown): string | null {
  if (typeof data !== 'object' || data === null || !('statusReported' in data)) return null;
  const cell = data.statusReported;
  if (typeof cell !== 'object' || cell === null || !('value' in cell) || typeof cell.value !== 'string') return null;
  return cell.value;
}

function sameCode(raw: string | null, norm: string): boolean {
  if (raw === null || norm === '') return false;
  return normalizeText(raw) === norm;
}

function batchesOnLine(box: MemoryBox, orderLineId: string) {
  return [...box.current.batches.values()].filter((row) => row.orderLineId === orderLineId);
}

function batchesFromSlot(
  box: MemoryBox,
  ref: { readonly rowId: string; readonly slotIndex: number },
) {
  return [...box.current.batches.values()].filter(
    (row) => row.originRef?.rowId === ref.rowId && row.originRef.slotIndex === ref.slotIndex,
  );
}

function adoptedShipment(box: MemoryBox, rowId: string) {
  const found = [...box.current.shipments.values()].find(
    (row) => row.factoryShipmentRowId === rowId && row.voidedAt === null,
  );
  return found === undefined ? undefined : { shipmentId: found.id, batchId: found.batchId };
}

async function batchWithRecords(box: MemoryBox, id: string): Promise<BatchWithRecords> {
  const batch = box.current.batches.get(id);
  if (batch === undefined) throw new NotFoundError('要货批次', id);
  return {
    batch,
    shipments: [...box.current.shipments.values()].filter((row) => row.batchId === id),
    receipts: [...box.current.receipts.values()].filter((row) => row.batchId === id),
    deliveryNote: [...box.current.deliveryNotes.values()].find((row) => row.batchId === id) ?? null,
    dateChanges: [...box.current.dateChanges.values()].filter((row) => row.batchId === id),
  };
}

function findBatchId({ box, kind, recordId }: { readonly box: MemoryBox; readonly kind: 'shipment' | 'receipt' | 'delivery_note'; readonly recordId: string }) {
  if (kind === 'shipment') return box.current.shipments.get(recordId)?.batchId;
  if (kind === 'receipt') return box.current.receipts.get(recordId)?.batchId;
  return box.current.deliveryNotes.get(recordId)?.batchId;
}

function saveBatchRecords(box: MemoryBox, records: BatchWithRecords): void {
  box.current.batches.set(records.batch.id, records.batch);
  replaceRows({ rows: box.current.shipments, batchId: records.batch.id, next: records.shipments });
  replaceRows({ rows: box.current.receipts, batchId: records.batch.id, next: records.receipts });
  replaceRows({ rows: box.current.dateChanges, batchId: records.batch.id, next: records.dateChanges });
  replaceNote({ box, batchId: records.batch.id, note: records.deliveryNote });
}

function removeBatch(box: MemoryBox, id: string): void {
  if (!box.current.batches.delete(id)) throw new NotFoundError('要货批次', id);
  replaceRows({ rows: box.current.shipments, batchId: id, next: [] });
  replaceRows({ rows: box.current.receipts, batchId: id, next: [] });
  replaceRows({ rows: box.current.dateChanges, batchId: id, next: [] });
  replaceNote({ box, batchId: id, note: null });
}

function replaceRows<T extends { readonly id: string; readonly batchId: string }>({ rows, batchId, next }: { readonly rows: Map<string, T>; readonly batchId: string; readonly next: readonly T[] }): void {
  for (const [key, row] of rows) {
    if (row.batchId === batchId) rows.delete(key);
  }
  for (const row of next) rows.set(row.id, row);
}

function replaceNote({ box, batchId, note }: { readonly box: MemoryBox; readonly batchId: string; readonly note: DeliveryNote | null }): void {
  for (const [key, row] of box.current.deliveryNotes) {
    if (row.batchId === batchId) box.current.deliveryNotes.delete(key);
  }
  if (note !== null) box.current.deliveryNotes.set(note.id, note);
}

function removable<T extends { readonly id: string }>({ repo, rows, entity }: { readonly repo: {
    get(id: string): Promise<T>;
    find(id: string): Promise<T | undefined>;
    save(entity: T): Promise<void>;
  }; readonly rows: () => Map<string, T>; readonly entity: string }) {
  return {
    ...repo,
    async remove(id: string) {
      if (!rows().delete(id)) throw new NotFoundError(entity, id);
    },
  };
}

export { fileStore, userDirectory } from './services.js';
