import type { ItemCode } from '@sw/domain';

export interface ItemCodeRepository {
  /** 找不到就抛 NotFoundError。 */
  get(id: string): Promise<ItemCode>;
  /** 在事务内锁定并返回编码。 */
  lock(id: string): Promise<ItemCode>;
  /** 批量修改前按固定顺序锁定并返回存在的编码。 */
  lockMany(ids: readonly string[]): Promise<readonly ItemCode[]>;
  /** 找不到返回 undefined。 */
  find(id: string): Promise<ItemCode | undefined>;
  /** 插入或按 id 覆盖。事务由 UnitOfWork.run 负责。 */
  save(entity: ItemCode): Promise<void>;
  /** 规范化后相同的编码。没有就空数组。 */
  listByNorm(codeNorm: string): Promise<readonly ItemCode[]>;
}
