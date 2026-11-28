import type { EntityId, ItemCode } from '@sw/domain';

export interface ItemCodeRepository {
  /** 找不到就抛 NotFoundError。 */
  get(id: string): Promise<ItemCode>;
  /** 找不到返回 undefined。 */
  find(id: string): Promise<ItemCode | undefined>;
  /** 插入或按 id 覆盖。事务由 UnitOfWork.run 负责。 */
  save(entity: ItemCode): Promise<void>;
  /** 仅登记不存在的编码，返回同类型和规范编码的实际 ID，保留已有审核结果。 */
  insertIfAbsent(entity: ItemCode): Promise<EntityId>;
  /** 规范化后相同的编码。没有就空数组。 */
  listByNorm(codeNorm: string): Promise<readonly ItemCode[]>;
}
