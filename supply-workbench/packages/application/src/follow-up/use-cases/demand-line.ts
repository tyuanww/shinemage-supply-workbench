import type { EntityId, FactoryDemandFacts, OrderLine, OrderLineId } from '@sw/domain';
import type { UnitOfWorkStores } from '../../ports/unit-of-work.js';
import { createPurchaseOrder, findPurchaseOrders } from './purchase-order-ref.js';

export type MaterialIdentity = { readonly purchaseOrderId: EntityId; readonly itemCode: string };

type MatchProblem = '匹配到多条订单行' | '订单行已取消';

export type MaterialMatchFailure = {
  readonly reason: MatchProblem;
  readonly material: MaterialIdentity;
  readonly matchingLineIds: readonly OrderLineId[];
};

type MaterialLine =
  { readonly lineId: OrderLineId; readonly material: MaterialIdentity; readonly matchingLineIds: readonly OrderLineId[]; readonly created: boolean }
  | MaterialMatchFailure
  | { readonly reason: string };

type ResolveInput = {
  readonly demand: FactoryDemandFacts;
  readonly factoryPartyId: EntityId;
  readonly at: string;
  readonly nextOrderLineId: () => OrderLineId;
  readonly nextEntityId: () => EntityId;
};

export async function resolveMaterialLine(
  tx: UnitOfWorkStores,
  input: ResolveInput,
): Promise<MaterialLine> {
  const itemCode = blankToNull(input.demand.itemCodeRaw);
  if (itemCode === null) return { reason: '没有材料品号' };
  const found = await findPurchaseOrders(tx, {
    poRaw: input.demand.blockMaterialPoRaw,
    lane: 'material',
  });
  if ('reason' in found) return found;
  const existing = found.orders[0];
  if (existing !== undefined)
    return lineOnOrder(tx, { ...input, itemCode, purchaseOrderId: existing.id });
  return createLine(tx, { ...input, itemCode, purchaseOrderId: null });
}

async function lineOnOrder(
  tx: UnitOfWorkStores,
  input: ResolveInput & { readonly itemCode: string; readonly purchaseOrderId: EntityId },
): Promise<MaterialLine> {
  const material = { purchaseOrderId: input.purchaseOrderId, itemCode: input.itemCode };
  const matches = await materialLinesOnOrder(tx, material);
  const open = openMatches(matches);
  const matchingLineIds = matches.map((line) => line.id);
  const reason = matchProblem({ matches, open });
  if (reason !== null) return { reason, material, matchingLineIds };
  const found = open[0];
  if (found !== undefined) return { lineId: found.id, material, matchingLineIds, created: false };
  return createLine(tx, { ...input, purchaseOrderId: input.purchaseOrderId });
}

async function createLine(
  tx: UnitOfWorkStores,
  input: ResolveInput & { readonly itemCode: string; readonly purchaseOrderId: EntityId | null },
): Promise<MaterialLine> {
  const name = blankToNull(input.demand.nameRaw);
  if (name === null) return { reason: '没有材料品名' };
  const purchaseOrderId =
    input.purchaseOrderId ??
    (await createPurchaseOrder(tx, {
      poRaw: input.demand.blockMaterialPoRaw,
      lane: 'material',
      supplierPartyId: input.factoryPartyId,
      at: input.at,
      nextId: input.nextEntityId,
    }));
  const lineId = input.nextOrderLineId();
  await tx.orderLines.save(materialLine({ ...input, lineId, purchaseOrderId, name }));
  return { lineId, material: { purchaseOrderId, itemCode: input.itemCode }, matchingLineIds: [lineId], created: true };
}

export async function isCurrentMaterialLine(tx: UnitOfWorkStores, { line, material }: {
  readonly line: OrderLine; readonly material: MaterialIdentity;
}): Promise<boolean> {
  if (!sameMaterial(line, material)) return false;
  const open = openMatches(await materialLinesOnOrder(tx, material));
  if (open.length === 0) return line.cancelledAt !== null;
  return open.length === 1 && open[0]?.id === line.id;
}

export async function isCurrentMaterialFailure(tx: UnitOfWorkStores, failure: MaterialMatchFailure): Promise<boolean> {
  const matches = await materialLinesOnOrder(tx, failure.material);
  return matchProblem({ matches, open: openMatches(matches) }) === failure.reason;
}

function openMatches(matches: readonly OrderLine[]): readonly OrderLine[] {
  return matches.filter((line) => line.cancelledAt === null);
}

function matchProblem({ matches, open }: { readonly matches: readonly OrderLine[]; readonly open: readonly OrderLine[] }): MatchProblem | null {
  if (open.length > 1) return '匹配到多条订单行';
  if (open.length === 0 && matches.length > 0) return '订单行已取消';
  return null;
}

async function materialLinesOnOrder(tx: UnitOfWorkStores, material: MaterialIdentity): Promise<readonly OrderLine[]> {
  return (await tx.orderLines.listByPurchaseOrder(material.purchaseOrderId)).filter((line) => sameMaterial(line, material));
}

function sameMaterial(line: OrderLine, identity: MaterialIdentity): boolean {
  return line.lane === 'material' && line.purchaseOrderId === identity.purchaseOrderId && line.itemCodeRaw === identity.itemCode;
}

function materialLine(
  input: ResolveInput & {
    readonly lineId: OrderLineId;
    readonly purchaseOrderId: EntityId;
    readonly itemCode: string;
    readonly name: string;
  },
): OrderLine {
  return {
    id: input.lineId,
    createdAt: input.at,
    updatedAt: input.at,
    purchaseOrderId: input.purchaseOrderId,
    lane: 'material',
    itemId: null,
    itemCodeRaw: input.itemCode,
    barcodeRaw: null,
    nameRaw: input.name,
    qtyOrdered: null,
    unit: null,
    buyerUserId: null,
    receiverPartyId: input.factoryPartyId,
    origin: 'from_factory_demand',
    currentSnapshotId: null,
    candidateKey: null,
    missingInLatestImport: false,
    cancelledAt: null,
    cancelReason: null,
    stage: 'no_batch',
    stageChangedAt: input.at,
    nextDueBatchId: null,
    nextDueDate: null,
  };
}

function blankToNull(value: string | null): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}
