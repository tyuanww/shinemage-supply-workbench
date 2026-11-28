import { eq, sql } from 'drizzle-orm';
import type { AppDatabase } from '../client.js';
import { factoryOwnershipGuards } from '../schema/orders.js';

export async function lockFactoryOwnershipChange(db: AppDatabase, orderLineIds: readonly (string | null)[]): Promise<void> {
  const ids = [...new Set(orderLineIds)].filter((id) => id !== null);
  if (ids.length === 0) return;
  await db.select({ id: factoryOwnershipGuards.orderLineId }).from(factoryOwnershipGuards)
    .where(sql`${factoryOwnershipGuards.orderLineId} = any(${sql.param(ids)}::text[])`)
    .orderBy(factoryOwnershipGuards.orderLineId).for('key share');
}

export async function tryLockFactoryOwnershipForEvidence(db: AppDatabase, orderLineId: string): Promise<boolean> {
  // 写入彼此兼容。只有生成完成业务写入后才尝试排他读取凭据。
  const [locked] = await db.select({ id: factoryOwnershipGuards.orderLineId }).from(factoryOwnershipGuards)
    .where(eq(factoryOwnershipGuards.orderLineId, orderLineId)).for('update', { skipLocked: true });
  return locked !== undefined;
}

export async function lockReportSources(db: AppDatabase, factoryPartyIds: readonly string[]): Promise<void> {
  for (const factoryPartyId of [...new Set(factoryPartyIds)].sort()) {
    await lockFactorySnapshotSource(db, { factoryPartyId, kind: 'report' });
  }
}

export async function lockFactorySnapshotSource(db: AppDatabase, { factoryPartyId, kind }: {
  readonly factoryPartyId: string; readonly kind: 'publish' | 'report';
}): Promise<void> {
  const key = sql`hashtextextended('supply.follow-up.factory-snapshot:' || ${factoryPartyId}, 0)`;
  await db.execute(kind === 'publish' ? sql`select pg_advisory_xact_lock(${key})` : sql`select pg_advisory_xact_lock_shared(${key})`);
}
