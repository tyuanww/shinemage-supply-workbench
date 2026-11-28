import type { EntityId, ItemKind } from '@sw/domain';
import type { ApproveCode, ApproveCodeDeps } from '../boundary.js';
import type { ApproveCodeInput } from '../views.js';
import type { IdGenerator } from '../../ports/id-generator.js';
import type { UnitOfWorkStores } from '../../ports/unit-of-work.js';
import { auditOf } from '../../shared/audit.js';
import { authorize } from '../../shared/authorize.js';
import { ValidationFailedError } from '../../shared/errors.js';
import { refreshLineProjection } from '../../shared/line-projection.js';
import { backfillItems } from './backfill.js';
import { itemDraft } from './drafts.js';

export const makeApproveCode =
  (deps: ApproveCodeDeps): ApproveCode =>
  async (input, actor) => {
    authorize(actor, 'master.review');
    const at = deps.clock.now();
    await deps.uow.run(async (tx) => {
      const code = await tx.itemCodes.lock(input.codeId);
      const itemId = await itemFor(tx, { ids: deps.ids, input, at });
      await tx.itemCodes.save({ ...code, itemId, status: 'approved', updatedAt: at });
      const lineIds = await backfillItems(tx, { items: [{ codeNorm: code.codeNorm, itemId }], at });
      if (lineIds.length > 0) await refreshLineProjection(tx, lineIds);
      await tx.audit.record(auditOf({ action: 'code.approve', subject: code, ctx: { actor, at, before: code, entity: '编码' } }));
    });
    return { codeId: input.codeId };
  };

async function itemFor(tx: UnitOfWorkStores, ctx: { readonly ids: IdGenerator; readonly input: ApproveCodeInput; readonly at: string }): Promise<EntityId> {
  if (ctx.input.createItem !== undefined) return saveItem(tx, { ids: ctx.ids, input: ctx.input.createItem, at: ctx.at });
  if (ctx.input.itemId === undefined) throw new ValidationFailedError('要指定物料或新建物料');
  return ctx.input.itemId;
}

async function saveItem(tx: UnitOfWorkStores, ctx: { readonly ids: IdGenerator; readonly input: { readonly displayName: string; readonly kind: ItemKind }; readonly at: string }): Promise<EntityId> {
  const id = ctx.ids.next();
  await tx.items.save(itemDraft({ id, at: ctx.at, displayName: ctx.input.displayName, kind: ctx.input.kind }));
  return id;
}
