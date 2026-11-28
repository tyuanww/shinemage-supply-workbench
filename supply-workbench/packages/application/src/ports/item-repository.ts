import type { Item } from '@sw/domain';

export interface ItemRepository {
  /** 找不到就抛 NotFoundError。 */
  get(id: string): Promise<Item>;
  /** 在事务内锁定并返回物料。 */
  lock(id: string): Promise<Item>;
  /** 找不到返回 undefined。 */
  find(id: string): Promise<Item | undefined>;
  /** 插入或按 id 覆盖。事务由 UnitOfWork.run 负责。 */
  save(entity: Item): Promise<void>;
}
