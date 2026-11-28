import { entityId } from '@sw/domain';
import type { PoMasterPayload } from '../../ports/parsed-rows.js';
import type { CommitContext } from './context.js';
import { lineFactoryLinksOf, linkIdOf, linkOf } from '../../shared/factory-link.js';
import { applyOwnerAssignment, ownerAssignmentsOf } from '../../shared/owner-assignment.js';

/**
 * PO 总表可选列“采购负责人/工厂”落到当前行。
 * 负责人按 users.name 精确匹配；匹配不到或重名进 pending，不写假负责人。
 * 工厂按主体显示名精确匹配；匹配失败写 unlinked + 原因，读路径能看到未关联原因。
 * 已有手工负责人/手工工厂关联优先，导入不覆盖人工决定。
 */
export async function applyPoRowOwner(input: {
  readonly ctx: CommitContext;
  readonly lineId: string;
  readonly payload: PoMasterPayload;
}): Promise<void> {
  const ownerName = textOf(input.payload.ownerRaw?.value ?? null);
  if (ownerName !== null) await applyPoOwner({ ctx: input.ctx, lineId: input.lineId, name: ownerName });
}

export type PoFactoryRelation = {
  readonly lineId: string;
  readonly name: string;
  readonly payload: PoMasterPayload;
};

export function poFactoryRelation(input: { readonly lineId: string; readonly payload: PoMasterPayload }): PoFactoryRelation | null {
  const name = textOf(input.payload.factoryRaw?.value ?? null);
  return name === null ? null : { ...input, name };
}

export async function applyPoFactories(ctx: CommitContext, relations: readonly PoFactoryRelation[]): Promise<void> {
  // 和自动重联按相同订单行顺序写工厂关联。
  for (const relation of [...relations].sort((left, right) => left.lineId.localeCompare(right.lineId))) {
    await applyPoFactory({ ...relation, ctx });
  }
}

export async function applyPoOwner(input: { readonly ctx: CommitContext; readonly lineId: string; readonly name: string; readonly lookupName?: string }): Promise<void> {
  const line = await input.ctx.tx.orderLines.get(input.lineId);
  if (line.cancelledAt !== null) return;
  const matches = await ownerAssignmentsOf(input.ctx.tx).findUsersByName(input.lookupName ?? input.name);
  const desired = matches.length === 1 && matches[0] !== undefined
    ? { status: 'assigned' as const, ownerUserId: matches[0].id, ownerNameRaw: input.name, source: 'po_master' as const, sourceRef: input.ctx.batch.id }
    : { status: 'pending' as const, ownerUserId: null, ownerNameRaw: input.name, source: 'po_master' as const, sourceRef: input.ctx.batch.id };
  await applyOwnerAssignment({
    tx: input.ctx.tx,
    nextId: () => entityId(`${input.lineId}:owner:${input.ctx.batch.id}`),
    at: input.ctx.at,
    line,
    desired,
  });
}

async function applyPoFactory(input: { readonly ctx: CommitContext; readonly lineId: string; readonly name: string; readonly payload: PoMasterPayload }): Promise<void> {
  const links = lineFactoryLinksOf(input.ctx.tx);
  const previous = await links.find(input.lineId);
  if (previous?.status === 'manual') return;
  const matches = await links.findFactoriesByName(input.name);
  const id = previous?.id ?? linkIdOf(input.lineId);
  if (matches.length === 1 && matches[0] !== undefined) {
    await links.save(linkOf({
      id,
      at: input.ctx.at,
      orderLineId: input.lineId,
      factoryPartyId: matches[0].id,
      status: 'linked',
      source: 'po_master',
      confidence: 'column',
      poRaw: input.payload.po.raw,
      barcodeRaw: input.payload.barcodeRaw.raw,
    }));
    return;
  }
  await links.save(linkOf({
    id,
    at: input.ctx.at,
    orderLineId: input.lineId,
    factoryPartyId: null,
    status: 'unlinked',
    source: 'po_master',
    confidence: 'none',
    reason: matches.length === 0 ? 'FACTORY_NAME_NOT_FOUND' : 'FACTORY_NAME_AMBIGUOUS',
    poRaw: input.payload.po.raw,
    barcodeRaw: input.payload.barcodeRaw.raw,
  }));
}

function textOf(value: string | null): string | null {
  if (value === null) return null;
  const text = value.trim();
  return text === '' ? null : text;
}
