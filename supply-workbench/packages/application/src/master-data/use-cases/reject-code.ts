import type { EntityId, ItemCode, ReviewStatus } from '@sw/domain';
import type { RejectCode, RejectCodeDeps } from '../boundary.js';
import { auditOf } from '../../shared/audit.js';
import { authorize } from '../../shared/authorize.js';
import { requireText } from './require-text.js';

export const makeRejectCode =
  (deps: RejectCodeDeps): RejectCode =>
  async (input, actor) => {
    authorize(actor, 'master.review');
    const reason = requireText(input.reason, '驳回要写原因');
    const at = deps.clock.now();
    await deps.uow.run(async (tx) => {
      const code = await tx.itemCodes.lock(input.codeId);
      const after = decided(code, { itemId: null, status: 'rejected', at });
      await tx.itemCodes.save(after);
      await tx.audit.record(auditOf({ action: 'code.reject', subject: after, ctx: { actor, at, before: code, after: { ...after, reason }, entity: '编码' } }));
    });
    return { codeId: input.codeId };
  };

function decided(code: ItemCode, patch: { readonly itemId: EntityId | null; readonly status: ReviewStatus; readonly at: string }): ItemCode {
  return { ...code, itemId: patch.itemId, status: patch.status, updatedAt: patch.at };
}
