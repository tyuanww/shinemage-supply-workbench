import type { CodeLink } from '@sw/domain';

export interface CodeLinkRepository {
  /** 找不到就抛 NotFoundError。 */
  get(id: string): Promise<CodeLink>;
  /** 找不到返回 undefined。 */
  find(id: string): Promise<CodeLink | undefined>;
  /** 插入或按 id 更新，待审核记录不覆盖已审核决定。事务由 UnitOfWork.run 负责。 */
  save(entity: CodeLink): Promise<void>;
  /** 已批准的对照。没有就空数组。 */
  listApproved(): Promise<readonly CodeLink[]>;
}
