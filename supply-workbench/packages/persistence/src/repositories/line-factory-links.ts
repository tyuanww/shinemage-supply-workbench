import { and, eq, sql } from 'drizzle-orm';
import type { LineFactoryLink, LineFactoryLinkSource, LineFactoryLinkStatus, LineFactoryMatchBasis } from '@sw/domain';
import type { FactoryRef } from '../../../application/src/ports/factory-link-repository.js';
import type { LineFactoryLinkRepository } from '../../../application/src/ports/factory-link-repository.js';
import type { AppDatabase } from '../client.js';
import { entityId, entityIdOrNull, orderLineId } from '../mappers/id.js';
import { instant } from '../mappers/time.js';
import { lineFactoryLinks } from '../schema/orders.js';
import { parties } from '../schema/platform.js';
import { lockFactoryOwnershipChange } from './factory-ownership-lock.js';

const STATUSES: readonly LineFactoryLinkStatus[] = ['linked', 'unlinked', 'manual'];
const SOURCES: readonly LineFactoryLinkSource[] = ['po_master', 'factory_progress', 'relink', 'manual'];
const CONFIDENCES: readonly LineFactoryMatchBasis[] = ['po', 'item_code', 'barcode', 'column', 'manual', 'none'];

export function lineFactoryLinkRepository(db: AppDatabase): LineFactoryLinkRepository {
  const prelocked = new Set<string>();
  return {
    find: (orderLineId) => find(db, orderLineId),
    async lockOwnershipChanges(ids) {
      await lockFactoryOwnershipChange(db, ids);
      for (const id of ids) prelocked.add(id);
    },
    save: (entity) => save(db, { entity, isPrelocked: prelocked.has(entity.orderLineId) }),
    findFactoriesByName: (displayName) => findFactoriesByName(db, displayName),
  };
}

async function find(db: AppDatabase, orderLineIdValue: string): Promise<LineFactoryLink | undefined> {
  const rows = await db.select().from(lineFactoryLinks).where(eq(lineFactoryLinks.orderLineId, orderLineIdValue));
  const row = rows[0];
  return row === undefined ? undefined : toLink(row);
}

async function save(db: AppDatabase, { entity, isPrelocked }: { readonly entity: LineFactoryLink; readonly isPrelocked: boolean }): Promise<boolean> {
  if (isPrelocked) return saveLink(db, { entity, allowOwnerChange: true });
  if (entity.source === 'manual') {
    await lockFactoryOwnershipChange(db, [entity.orderLineId]);
    return saveLink(db, { entity, allowOwnerChange: true });
  }
  const previous = await find(db, entity.orderLineId);
  if (isManual(previous)) return false;
  if (entity.factoryPartyId === null && (previous?.factoryPartyId ?? null) === null) {
    if (await saveLink(db, { entity, allowOwnerChange: false })) return true;
    if (isManual(await find(db, entity.orderLineId))) return false;
  }
  await lockFactoryOwnershipChange(db, [entity.orderLineId]);
  return saveLink(db, { entity, allowOwnerChange: true });
}

function isManual(link: LineFactoryLink | undefined): boolean {
  return link?.source === 'manual' || link?.status === 'manual';
}

async function saveLink(db: AppDatabase, { entity, allowOwnerChange }: {
  readonly entity: LineFactoryLink; readonly allowOwnerChange: boolean;
}): Promise<boolean> {
  const row = toRow(entity);
  const updated = await db.insert(lineFactoryLinks).values(row).onConflictDoUpdate({
    target: lineFactoryLinks.id,
    set: row,
    setWhere: sql`(${entity.source === 'manual'} or (${lineFactoryLinks.source} <> 'manual' and ${lineFactoryLinks.status} <> 'manual'))
      and (${allowOwnerChange} or ${lineFactoryLinks.factoryPartyId} is null)`,
  }).returning();
  return updated.length > 0;
}

async function findFactoriesByName(db: AppDatabase, displayName: string): Promise<readonly FactoryRef[]> {
  const trimmed = displayName.trim();
  if (trimmed === '') return [];
  const rows = await db.select().from(parties).where(and(eq(parties.isFactory, true), eq(parties.displayName, trimmed)));
  return rows.map((row) => ({ id: row.id, displayName: row.displayName }));
}

function toLink(row: typeof lineFactoryLinks.$inferSelect): LineFactoryLink {
  return {
    id: entityId(row.id),
    createdAt: instant(row.createdAt),
    updatedAt: instant(row.updatedAt),
    orderLineId: orderLineId(row.orderLineId),
    factoryPartyId: entityIdOrNull(row.factoryPartyId),
    status: oneOf(STATUSES, row.status),
    source: oneOf(SOURCES, row.source),
    confidence: oneOf(CONFIDENCES, row.confidence),
    poRaw: row.poRaw,
    itemCodeRaw: row.itemCodeRaw,
    barcodeRaw: row.barcodeRaw,
    reason: row.reason,
    linkedAt: instant(row.linkedAt),
  };
}

function toRow(entity: LineFactoryLink): typeof lineFactoryLinks.$inferInsert {
  return {
    id: entity.id,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
    orderLineId: entity.orderLineId,
    factoryPartyId: entity.factoryPartyId,
    status: entity.status,
    source: entity.source,
    confidence: entity.confidence,
    poRaw: entity.poRaw,
    itemCodeRaw: entity.itemCodeRaw,
    barcodeRaw: entity.barcodeRaw,
    reason: entity.reason,
    linkedAt: entity.linkedAt,
  };
}

function oneOf<T extends string>(values: readonly T[], value: string): T {
  for (const item of values) if (item === value) return item;
  throw new Error(`未知枚举 ${value}`);
}
