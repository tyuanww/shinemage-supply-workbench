import type { OrderLine, OrderLineSnapshot } from '@sw/domain';

export interface OrderLineRepository {
  /** 找不到就抛 NotFoundError。 */
  get(id: string): Promise<OrderLine>;
  /** 在写事务中锁定订单行并读取最新记录。 */
  lock(id: string, options?: { readonly noWait?: boolean }): Promise<OrderLine>;
  /** 找不到返回 undefined。 */
  find(id: string): Promise<OrderLine | undefined>;
  /** 插入或按 id 覆盖。事务由 UnitOfWork.run 负责。 */
  save(entity: OrderLine): Promise<void>;
  /** 只有 updatedAt 仍等于读取时的值才覆盖，返回是否写入。 */
  saveConditional?(entity: OrderLine, expectedUpdatedAt: string): Promise<boolean>;
  /** 这张采购单下的订单行。没有就返回空数组。 */
  listByPurchaseOrder(purchaseOrderId: string): Promise<readonly OrderLine[]>;
  /** 全部订单行。用于导入快照收口，旧适配器可省略。 */
  listAll?(): Promise<readonly OrderLine[]>;
  /** 品号或条码原文规范化后等于 codeNorm。没有就空数组。 */
  listByCodeNorm(codeNorm: string): Promise<readonly OrderLine[]>;
  /** 写入或覆盖当前快照。 */
  saveSnapshot(snapshot: OrderLineSnapshot): Promise<void>;
  /** 当前快照里的总表状态。没有快照或没有状态就是 null。 */
  reportedStatus(lineId: string): Promise<string | null>;
}
