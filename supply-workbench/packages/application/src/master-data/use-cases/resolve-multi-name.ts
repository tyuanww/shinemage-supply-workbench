import { normalizeText, type EntityId } from '@sw/domain';
import type { ResolveMultiName, ResolveMultiNameDeps } from '../boundary.js';
import type { ResolveMultiNameInput } from '../views.js';
import type { IdGenerator } from '../../ports/id-generator.js';
import type { UnitOfWorkStores } from '../../ports/unit-of-work.js';
import { auditOf } from '../../shared/audit.js';
import { authorize } from '../../shared/authorize.js';
import { refreshLineProjection } from '../../shared/line-projection.js';
import { backfillItem } from './backfill.js';
import { itemDraft } from './drafts.js';
import { prepareCodeRelink, relinkPreparedRows } from './relink-rows.js';
import { requireText } from './require-text.js';

export const makeResolveMultiName =
  (deps: ResolveMultiNameDeps): ResolveMultiName =>
  async (input, actor) => {
    authorize(actor, 'master.review');
    const at = deps.clock.now();
    await deps.uow.run(async (tx) => {
      const code = await tx.itemCodes.get(input.codeId);
      const itemId = await ensureItem(tx, { ids: deps.ids, itemId: code.itemId, codeRaw: code.codeRaw, input, at });
      await applyDecision(tx, { itemId, input, at });
      if (code.itemId === null) await tx.itemCodes.save({ ...code, itemId, status: 'approved', updatedAt: at });
      const filled = code.itemId === null ? await backfillItem(tx, { codeNorm: code.codeNorm, itemId, at }) : [];
      const rows = await prepareCodeRelink(tx, [code.codeNorm]);
      const linked = await relinkPreparedRows(tx, rows);
      const lineIds = [...filled, ...linked];
      if (lineIds.length > 0) await refreshLineProjection(tx, lineIds);
      await tx.audit.record(auditOf({ action: 'code.resolve-names', subject: code, ctx: { actor, at, before: code, after: { itemId, mode: input.mode }, entity: '编码' } }));
    });
    return { codeId: input.codeId };
  };

async function ensureItem(tx: UnitOfWorkStores, ctx: { readonly ids: IdGenerator; readonly itemId: EntityId | null; readonly codeRaw: string; readonly input: ResolveMultiNameInput; readonly at: string }): Promise<EntityId> {
  if (ctx.itemId !== null) return ctx.itemId;
  const id = ctx.ids.next();
  const name = ctx.input.mode === 'same_item' ? requireText(ctx.input.displayName, '要选一个显示名') : ctx.codeRaw;
  await tx.items.save(itemDraft({ id, at: ctx.at, displayName: name, kind: 'unknown' }));
  return id;
}

async function applyDecision(tx: UnitOfWorkStores, ctx: { readonly itemId: EntityId; readonly input: ResolveMultiNameInput; readonly at: string }): Promise<void> {
  const item = await tx.items.get(ctx.itemId);
  if (ctx.input.mode === 'shared_code') {
    await tx.items.save({ ...item, sharedCodeFlag: true, updatedAt: ctx.at });
    await tx.itemNames.saveDecision(ctx.itemId, 'shared_code');
    return;
  }
  const displayName = requireText(ctx.input.displayName, '要选一个显示名');
  await tx.items.save({ ...item, displayName, sharedCodeFlag: false, updatedAt: ctx.at });
  await tx.itemNames.save({ itemId: ctx.itemId, nameRaw: displayName, nameNorm: normalizeText(displayName), seenCount: 1 });
  await tx.itemNames.saveDecision(ctx.itemId, 'same_item');
}
