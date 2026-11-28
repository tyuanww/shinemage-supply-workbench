import type { LineFactoryLink } from '@sw/domain';

export type FactoryRef = {
  readonly id: string;
  readonly displayName: string;
};

export interface LineFactoryLinkRepository {
  /** 订单行的当前关联；没有返回 undefined。 */
  find(orderLineId: string): Promise<LineFactoryLink | undefined>;
  /** 批量重联先锁计划会变更归属的订单行。 */
  lockOwnershipChanges(orderLineIds: readonly string[]): Promise<void>;
  /** 插入或按 id 覆盖。自动写入遇到人工决定时返回 false。 */
  save(entity: LineFactoryLink): Promise<boolean>;
  /** 代工厂主体按 displayName 精确匹配；重名返回多个。 */
  findFactoriesByName(displayName: string): Promise<readonly FactoryRef[]>;
}
