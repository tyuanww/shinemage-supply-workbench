import { parsePoCell, type EntityId, type Lane, type PurchaseOrder } from '@sw/domain';
import type { UnitOfWorkStores } from '../../ports/unit-of-work.js';

type PoKey =
  | { readonly kind: 'none'; readonly poNorm: null }
  | {
      readonly kind: 'norm';
      readonly poRaw: string;
      readonly poNorm: string;
      readonly parsed: ReturnType<typeof parsePoCell>['value'];
    };

type ResolveInput = {
  readonly poRaw: string | null;
  readonly lane: Lane;
  readonly supplierPartyId: EntityId | null;
  readonly at: string;
  readonly nextId: () => EntityId;
};

export async function findPurchaseOrders(
  tx: UnitOfWorkStores,
  input: { readonly poRaw: string | null; readonly lane: Lane },
): Promise<{ readonly orders: readonly PurchaseOrder[] } | { readonly reason: string }> {
  const found = await existingOrders({ tx, key: purchaseOrderKey(input.poRaw), lane: input.lane });
  if (found.length > 1) return { reason: '采购单不唯一' };
  return { orders: found };
}

export async function createPurchaseOrder(
  tx: UnitOfWorkStores,
  input: ResolveInput,
): Promise<EntityId> {
  const id = input.nextId();
  await tx.purchaseOrders.save(purchaseOrderOf({ id, key: purchaseOrderKey(input.poRaw), input }));
  return id;
}

async function existingOrders({ tx, key, lane }: { readonly tx: UnitOfWorkStores; readonly key: PoKey; readonly lane: Lane }): Promise<readonly PurchaseOrder[]> {
  if (key.kind === 'none') return tx.purchaseOrders.listNoNumber(lane);
  return (await tx.purchaseOrders.listByPoNorm(key.poNorm)).filter((order) => order.lane === lane);
}

export function purchaseOrderKey(raw: string | null): PoKey {
  const trimmed = raw?.trim() ?? '';
  if (trimmed === '') return { kind: 'none', poNorm: null };
  const parsed = parsePoCell(trimmed).value;
  if (parsed.poFormat === 'NONE' || parsed.poNorm === null) return { kind: 'none', poNorm: null };
  return { kind: 'norm', poRaw: trimmed, poNorm: parsed.poNorm, parsed };
}

function purchaseOrderOf({ id, key, input }: { readonly id: EntityId; readonly key: PoKey; readonly input: ResolveInput }): PurchaseOrder {
  return {
    id,
    createdAt: input.at,
    updatedAt: input.at,
    poRaw: key.kind === 'norm' ? key.poRaw : null,
    poNorm: key.kind === 'norm' ? key.poNorm : null,
    poFormat: key.kind === 'norm' ? key.parsed.poFormat : 'NONE',
    relatedPoRaws: key.kind === 'norm' ? key.parsed.relatedPoRaws : [],
    supplierPartyId: input.supplierPartyId,
    supplierRaw: null,
    lane: input.lane,
    oaDemandRef: null,
  };
}
