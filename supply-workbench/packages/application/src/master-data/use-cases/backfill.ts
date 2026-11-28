import { normalizeText, type EntityId } from '@sw/domain';
import type { UnitOfWorkStores } from '../../ports/unit-of-work.js';
import { lockOrderLines } from '../../shared/locked-order-lines.js';

export async function backfillSupplier(tx: UnitOfWorkStores, input: { readonly normName: string; readonly partyId: EntityId; readonly at: string }): Promise<string[]> {
  const orderIds = await tx.purchaseOrders.backfillMissingSupplier(input);
  const lineIds: string[] = [];
  for (const orderId of orderIds) {
    const lines = await tx.orderLines.listByPurchaseOrder(orderId);
    for (const line of lines) lineIds.push(line.id);
  }
  return lineIds;
}

export type ItemBackfill = { readonly codeNorm: string; readonly itemId: EntityId };

export async function backfillItems(tx: UnitOfWorkStores, { items, at }: { readonly items: readonly ItemBackfill[]; readonly at: string }): Promise<string[]> {
  const candidates = new Set<string>();
  for (const item of items) {
    for (const line of await tx.orderLines.listByCodeNorm(item.codeNorm)) {
      if (line.itemId === null) candidates.add(line.id);
    }
  }

  const changed: string[] = [];
  for (const [id, line] of await lockOrderLines(tx.orderLines, [...candidates])) {
    if (line.itemId !== null) continue;
    const currentCodes = [line.itemCodeRaw, line.barcodeRaw].filter((code) => code !== null).map(normalizeText);
    const match = items.find(({ codeNorm }) => currentCodes.includes(codeNorm));
    if (match === undefined) continue;
    await tx.orderLines.save({ ...line, itemId: match.itemId, updatedAt: at });
    changed.push(id);
  }
  return changed;
}
