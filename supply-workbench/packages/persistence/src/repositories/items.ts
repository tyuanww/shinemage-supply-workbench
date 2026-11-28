import { eq } from 'drizzle-orm';
import { NotFoundError } from '@sw/application/errors';
import type { Item, ItemKind } from '@sw/domain';
import { ITEM_KINDS } from '@sw/domain';
import type { ItemRepository } from '../../../application/src/ports/item-repository.js';
import type { AppDatabase } from '../client.js';
import { items } from '../schema/platform.js';
import { entityId } from '../mappers/id.js';
import { instant } from '../mappers/time.js';

export function itemRepository(db: AppDatabase): ItemRepository {
  return {
    async get(id) {
      const found = await findItem(db, id);
      if (found === undefined) throw new NotFoundError('物料', id);
      return found;
    },
    async lock(id) {
      const [row] = await db.select().from(items).where(eq(items.id, id)).for('update');
      if (row === undefined) throw new NotFoundError('物料', id);
      return toItem(row);
    },
    find: (id) => findItem(db, id),
    async save(entity) {
      await db.insert(items).values(entity).onConflictDoUpdate({ target: items.id, set: entity });
    },
  };
}

async function findItem(db: AppDatabase, id: string): Promise<Item | undefined> {
  const row = (await db.select().from(items).where(eq(items.id, id)))[0];
  return row === undefined ? undefined : toItem(row);
}

function toItem(row: typeof items.$inferSelect): Item {
  return { ...row, id: entityId(row.id), kind: itemKind(row.kind), createdAt: instant(row.createdAt), updatedAt: instant(row.updatedAt) };
}

function itemKind(value: string): ItemKind {
  for (const kind of ITEM_KINDS) if (kind === value) return kind;
  throw new Error(`认不出的物料类型: ${value}`);
}
