import type { FactoryReportKind, FactoryReportRow, OrderLineId } from '@sw/domain';
import type { BatchDemandSource } from './delivery-batch-repository.js';

export interface FactoryReportRepository {
  /** 找不到就抛 NotFoundError。 */
  get(id: string): Promise<FactoryReportRow>;
  /** 读取生成事实并返回同一次读取的行版本。 */
  getForDemandGeneration(id: string): Promise<{
    readonly row: FactoryReportRow;
    readonly version: string | null;
  }>;
  /** 订单写入全部完成后，锁定仍为同一版本且归属可核对的需求行。 */
  demandSourcesAtGeneration(input: {
    readonly rowId: string;
    readonly version: string;
    readonly orderLineId: OrderLineId;
  }): Promise<ReadonlyMap<number, BatchDemandSource>>;
  /** 找不到返回 undefined。 */
  find(id: string): Promise<FactoryReportRow | undefined>;
  /** 发布时先锁同厂快照来源，防止上报改挂改变继承和退休范围。 */
  lockSnapshotSource(factoryPartyId: string): Promise<void>;
  /** 改挂现有报告前按工厂锁住涉及的快照来源。 */
  lockReportSources(factoryPartyIds: readonly string[]): Promise<void>;
  /** 活动的出货、在途、库存报告当前涉及的订单。 */
  effectiveReportOwners(reportRows: readonly { readonly rowId: string; readonly kind: FactoryReportKind }[]): Promise<readonly string[]>;
  /** 新快照、退休快照涉及的已关联订单。旧格式只影响当前生效的快照。 */
  lockSnapshotOrders(input: {
    readonly incomingBatchId: string;
    readonly previousBatchIds: readonly string[];
    readonly onlyEffectivePrevious: boolean;
  }): Promise<void>;
  /** 插入或按 id 覆盖。事务由 UnitOfWork.run 负责。 */
  save(entity: FactoryReportRow): Promise<void>;
  /** 只关联仍未创建订单的在途行。并发认领失败时返回 false。 */
  linkUnassignedTransit(rowId: string, lineId: OrderLineId): Promise<boolean>;
  /**
   * 在途或需求事实里的品号、条码规范化后等于 codeNorm。没有就空数组。
   * 出货和库存的编码不在冻结事实上，不从 raw 猜。
   */
  listByCodeNorm(codeNorm: string): Promise<readonly FactoryReportRow[]>;
}
