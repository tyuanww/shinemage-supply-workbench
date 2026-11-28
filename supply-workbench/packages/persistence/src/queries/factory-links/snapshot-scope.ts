import { and, eq, isNull } from 'drizzle-orm';
import type { AppDatabase } from '../../client.js';
import { importBatches } from '../../schema/archive.js';

const FACTORY_BATCH_COLUMNS = {
  id: importBatches.id,
  factoryPartyId: importBatches.factoryPartyId,
  sourceKey: importBatches.sourceKey,
  supersededAt: importBatches.supersededAt,
  status: importBatches.status,
  committedAt: importBatches.committedAt,
  createdAt: importBatches.createdAt,
} as const;

/** 工厂批次的活动快照判定只在这里实现一次：列表、详情、产品档案、未关联队列、搜索共用。 */
type FactoryBatchScopeRow = {
  readonly id: string;
  readonly factoryPartyId: string | null;
  readonly sourceKey: string | null;
  readonly supersededAt: Date | string | null;
  readonly status: string;
  readonly committedAt: Date | string | null;
  readonly createdAt: Date | string;
};

/** 每个 source 的最新 committed 快照里取唯一一个；给读路径当 inArray 白名单。 */
export async function activeFactoryBatchIds(db: Pick<AppDatabase, 'select'>): Promise<ReadonlySet<string>> {
  const rows = await db.select(FACTORY_BATCH_COLUMNS).from(importBatches).where(eq(importBatches.template, 'factory-progress-v1'));
  return latestFactoryBatchIds(rows);
}

export async function isActiveFactoryBatch(db: Pick<AppDatabase, 'select'>, batchId: string): Promise<boolean> {
  const template = eq(importBatches.template, 'factory-progress-v1');
  const [batch] = await db.select(FACTORY_BATCH_COLUMNS).from(importBatches).where(and(template, eq(importBatches.id, batchId)));
  if (batch === undefined || batch.factoryPartyId === null || !isFactoryBatchCandidate(batch)) return false;
  const scope = batch.sourceKey === null
    ? and(isNull(importBatches.sourceKey), eq(importBatches.factoryPartyId, batch.factoryPartyId))
    : eq(importBatches.sourceKey, batch.sourceKey);
  const rows = await db.select(FACTORY_BATCH_COLUMNS).from(importBatches).where(and(template, scope));
  return latestFactoryBatchIds(rows).has(batchId);
}

function latestFactoryBatchIds(rows: readonly FactoryBatchScopeRow[]): ReadonlySet<string> {
  const latest = new Map<string, { readonly id: string; readonly at: number }>();
  for (const row of rows) {
    if (!isFactoryBatchCandidate(row)) continue;
    const at = committedAtOf(row);
    if (at === null || row.factoryPartyId === null) continue;
    const key = row.sourceKey === null ? `legacy:${row.factoryPartyId}` : `source:${row.sourceKey}`;
    const current = latest.get(key);
    if (isLaterFactoryBatch({ row, at, current })) latest.set(key, { id: row.id, at });
  }
  return new Set([...latest.values()].map((row) => row.id));
}

function isFactoryBatchCandidate(row: { readonly factoryPartyId: string | null; readonly sourceKey: string | null; readonly supersededAt: Date | string | null; readonly status: string; readonly committedAt: Date | string | null }): boolean {
  return row.factoryPartyId !== null && row.status === 'committed' && row.committedAt !== null && (row.sourceKey === null || (row.supersededAt ?? null) === null);
}

function committedAtOf(row: { readonly committedAt: Date | string | null; readonly createdAt: Date | string }): number | null {
  return dateValue(row.committedAt) ?? dateValue(row.createdAt);
}

function isLaterFactoryBatch(input: { readonly row: { readonly id: string }; readonly at: number; readonly current: { readonly id: string; readonly at: number } | undefined }): boolean {
  return input.current === undefined || input.at > input.current.at || (input.at === input.current.at && input.row.id > input.current.id);
}

function dateValue(value: Date | string | null): number | null {
  if (value === null) return null;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
