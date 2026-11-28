import type { BatchDateChange, DeliveryBatch, DeliveryNote, Receipt, Shipment } from '@sw/domain';
import type { DemandSlot } from './parsed-rows.js';

export type BatchDemandSource = {
  readonly importBatchId: string;
  readonly sheetName: string;
  readonly rowNo: number;
  readonly slot: Pick<DemandSlot, 'index' | 'dateRaw' | 'qtyRaw' | 'sourceColumns'> & {
    readonly originalCells?: Readonly<Record<string, string | null>>;
  };
};

export interface BatchWithRecords {
  readonly batch: DeliveryBatch;
  readonly shipments: readonly Shipment[];
  readonly receipts: readonly Receipt[];
  readonly deliveryNote: DeliveryNote | null;
  readonly dateChanges: readonly BatchDateChange[];
}

export interface DeliveryBatchRepository {
  /** 找不到就抛 NotFoundError。 */
  get(id: string): Promise<DeliveryBatch>;
  /** 找不到返回 undefined。 */
  find(id: string): Promise<DeliveryBatch | undefined>;
  /** 批次和它的发货、收货、送货单、改期记录。找不到就抛 NotFoundError。 */
  getWithRecords(id: string): Promise<BatchWithRecords>;
  /** 写事务中先锁住批次头，再加载最新附属记录。 */
  lockWithRecords(id: string): Promise<BatchWithRecords>;
  /** 这个订单行的全部批次，含已取消。没有就返回空数组。 */
  listByOrderLine(orderLineId: string): Promise<readonly DeliveryBatch[]>;
  /** 从这一个需求槽生成过的批次，含已取消。没有就返回空数组。 */
  listByOriginRef(ref: { readonly rowId: string; readonly slotIndex: number }): Promise<readonly DeliveryBatch[]>;
  /** 事务结束前持有锁。先锁全部来源行，再锁全部规范物料单号，之后才能匹配和锁定订单行。null 共用无单号物料单的锁。 */
  lockDemandGeneration(scope: { readonly rowIds: readonly string[] } | { readonly materialOrderNumbers: readonly (string | null)[] }): Promise<void>;
  /** 这条出货行已经采纳成哪条未作废发货。没有返回 undefined。 */
  findAdoptedShipment(factoryShipmentRowId: string): Promise<{ readonly shipmentId: string; readonly batchId: string } | undefined>;
  /** 发货、收货或送货单属于哪个批次。找不到返回 undefined。 */
  findBatchIdOf(kind: 'shipment' | 'receipt' | 'delivery_note', recordId: string): Promise<string | undefined>;
  /** 插入或按 id 覆盖批次头。事务由 UnitOfWork.run 负责。 */
  save(entity: DeliveryBatch): Promise<void>;
  /** 覆盖这一批的头和全部附属记录。不在列表里的旧附属记录删掉。 */
  saveWithRecords(records: BatchWithRecords): Promise<void>;
  /** 写入本事务刚生成批次的原表凭据。 */
  freezeDemandSource(input: { readonly batchId: string; readonly rowId: string; readonly source: BatchDemandSource }): Promise<void>;
  /** 只有批次头 updatedAt 仍等于读取时的值才覆盖，返回是否写入。 */
  saveWithRecordsConditional?(records: BatchWithRecords, expectedUpdatedAt: string): Promise<boolean>;
  /** 删掉批次和它的附属记录。找不到就抛 NotFoundError。 */
  remove(id: string): Promise<void>;
}
