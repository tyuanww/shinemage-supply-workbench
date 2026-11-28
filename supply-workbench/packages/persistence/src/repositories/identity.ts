import { and, eq, sql } from 'drizzle-orm';
import { NotFoundError } from '@sw/application/errors';
import { CODE_TYPES, REVIEW_STATUSES, type CodeLink, type ItemCode, type ItemName } from '@sw/domain';
import type { CodeLinkRepository } from '../../../application/src/ports/code-link-repository.js';
import type { ItemCodeRepository } from '../../../application/src/ports/item-code-repository.js';
import type { ItemNameRepository, NameDecision } from '../../../application/src/ports/item-name-repository.js';
import type { AppDatabase } from '../client.js';
import { instant, instantOrNull } from '../mappers/time.js';
import { entityId, entityIdOrNull } from '../mappers/id.js';
import { codeLinks, itemCodes, itemNames, nameDecisions } from '../schema/platform.js';

export function itemCodeRepository(db: AppDatabase): ItemCodeRepository {
  return {
    async get(id) {
      const found = await findCode(db, id);
      if (found === undefined) throw new NotFoundError('编码', id);
      return found;
    },
    find: (id) => findCode(db, id),
    async save(entity) {
      await db.insert(itemCodes).values(entity).onConflictDoUpdate({ target: itemCodes.id, set: entity });
    },
    async insertIfAbsent(entity) {
      const [inserted] = await db.insert(itemCodes).values(entity)
        .onConflictDoNothing({ target: [itemCodes.codeType, itemCodes.codeNorm] })
        .returning();
      if (inserted !== undefined) return entityId(inserted.id);
      const [existing] = await db.select({ id: itemCodes.id }).from(itemCodes)
        .where(and(eq(itemCodes.codeType, entity.codeType), eq(itemCodes.codeNorm, entity.codeNorm)));
      if (existing === undefined) throw new NotFoundError('编码', entity.codeNorm);
      return entityId(existing.id);
    },
    async listByNorm(codeNorm) {
      const rows = await db.select().from(itemCodes).where(eq(itemCodes.codeNorm, codeNorm));
      return rows.map(toCode);
    },
  };
}

export function itemNameRepository(db: AppDatabase): ItemNameRepository {
  return {
    async listByItem(itemId) {
      const rows = await db.select().from(itemNames).where(eq(itemNames.itemId, itemId));
      return rows.map(toName);
    },
    async save(name) {
      const rows = await db.select().from(itemNames).where(and(eq(itemNames.itemId, name.itemId), eq(itemNames.nameNorm, name.nameNorm)));
      if (rows.length === 0) {
        await db.insert(itemNames).values(name);
        return;
      }
      await db.update(itemNames).set({ nameRaw: name.nameRaw, seenCount: name.seenCount }).where(and(eq(itemNames.itemId, name.itemId), eq(itemNames.nameNorm, name.nameNorm)));
    },
    async decision(itemId) {
      const row = (await db.select().from(nameDecisions).where(eq(nameDecisions.itemId, itemId)))[0];
      return decisionOf(row?.mode);
    },
    async saveDecision(itemId, mode) {
      await db.insert(nameDecisions).values({ itemId, mode }).onConflictDoUpdate({ target: nameDecisions.itemId, set: { mode } });
    },
  };
}

export function codeLinkRepository(db: AppDatabase): CodeLinkRepository {
  return {
    async get(id) {
      const found = await findLink(db, id);
      if (found === undefined) throw new NotFoundError('对照', id);
      return found;
    },
    find: (id) => findLink(db, id),
    async save(entity) {
      await db.insert(codeLinks).values(entity).onConflictDoUpdate({
        target: codeLinks.id,
        set: entity,
        setWhere: sql`${entity.status !== 'pending'} or ${codeLinks.status} = 'pending'`,
      });
    },
    async listApproved() {
      const rows = await db.select().from(codeLinks).where(eq(codeLinks.status, 'approved'));
      return rows.map(toLink);
    },
  };
}

async function findCode(db: AppDatabase, id: string): Promise<ItemCode | undefined> {
  const row = (await db.select().from(itemCodes).where(eq(itemCodes.id, id)))[0];
  return row === undefined ? undefined : toCode(row);
}

async function findLink(db: AppDatabase, id: string): Promise<CodeLink | undefined> {
  const row = (await db.select().from(codeLinks).where(eq(codeLinks.id, id)))[0];
  return row === undefined ? undefined : toLink(row);
}

function toCode(row: typeof itemCodes.$inferSelect): ItemCode {
  return { ...row, id: entityId(row.id), itemId: entityIdOrNull(row.itemId), codeType: oneOf(CODE_TYPES, row.codeType), status: oneOf(REVIEW_STATUSES, row.status), createdAt: instant(row.createdAt), updatedAt: instant(row.updatedAt) };
}

function toName(row: typeof itemNames.$inferSelect): ItemName {
  return { itemId: entityId(row.itemId), nameRaw: row.nameRaw, nameNorm: row.nameNorm, seenCount: row.seenCount };
}

function toLink(row: typeof codeLinks.$inferSelect): CodeLink {
  return { ...row, id: entityId(row.id), fromCodeId: entityId(row.fromCodeId), toCodeId: entityId(row.toCodeId), reviewedBy: entityIdOrNull(row.reviewedBy), status: oneOf(REVIEW_STATUSES, row.status), createdAt: instant(row.createdAt), updatedAt: instant(row.updatedAt), reviewedAt: instantOrNull(row.reviewedAt) };
}

function decisionOf(mode: string | undefined): NameDecision {
  if (mode === 'same_item' || mode === 'shared_code') return mode;
  return 'undecided';
}

function oneOf<T extends string>(values: readonly T[], value: string): T {
  for (const item of values) if (item === value) return item;
  throw new Error(`认不出的值: ${value}`);
}
