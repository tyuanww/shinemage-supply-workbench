import { eq } from 'drizzle-orm';
import { NotFoundError, ValidationFailedError } from '@sw/application/errors';
import { CODE_TYPES, ITEM_KINDS, REVIEW_STATUSES, recentMonth, similarNames, type LocalDate } from '@sw/domain';
import type { MasterDataQueries } from '../../../../application/src/ports/master-data-queries.js';
import type { ListResult } from '../../../../application/src/shared/page.js';
import type { AppDatabase } from '../../client.js';
import { codeLinks, itemCodes, itemNames, items, parties, partyAliases } from '../../schema/platform.js';
import { oneOf } from '../follow-up/guards.js';
import { loadPartyKpi as supplierKpi } from './party-kpi.js';
import { hydrateUnlinked, linkedReportView, listUnlinkedKeys } from './unlinked.js';

const PAGE_MAX = 200;
const PAGE_DEFAULT = 50;

type Clock = { today(): LocalDate };
type Page = { readonly page?: number; readonly pageSize?: number };
type ItemOf<T> = T extends Promise<{ readonly items: readonly (infer Item)[] }> ? Item : never;
type MasterLookup = MasterDataQueries & {
  aliasById(id: string): Promise<ItemOf<ReturnType<MasterDataQueries['listAliases']>>>;
  codeById(id: string): Promise<ItemOf<ReturnType<MasterDataQueries['listCodes']>>>;
  linkById(id: string): Promise<ItemOf<ReturnType<MasterDataQueries['listCodeLinks']>>>;
  multiById(id: string): Promise<ItemOf<ReturnType<MasterDataQueries['listMultiName']>>>;
  linkedReport(input: Parameters<typeof linkedReportView>[1]): ReturnType<typeof linkedReportView>;
};

export function masterDataQueries(db: AppDatabase, clock: Clock): MasterLookup {
  return {
    reviewCounts: () => counts(db),
    listAliases: (query) => listAliases(db, query),
    listCodes: async (query) => pageOf((await db.select().from(itemCodes)).filter((row) => (query.status === undefined || row.status === query.status) && (query.codeType === undefined || row.codeType === query.codeType)).map(codeView), query),
    listCodeLinks: async (query) => pageOf((await db.select().from(codeLinks)).filter((row) => query.status === undefined || row.status === query.status).map(linkView), query),
    listMultiName: async (query) => pageOf(await multiName(db), query),
    listParties: async (query) => pageOf((await db.select().from(parties)).filter((row) => partyMatches(row, query)).map(partyView), query),
    getParty: (query) => partyDetail({ db, partyId: query.partyId, today: clock.today() }),
    loadPartyKpi: (query) => supplierKpi({ db, today: clock.today(), partyId: query.partyId }),
    listItems: async (query) => pageOf((await db.select().from(items)).filter((row) => query.q === undefined || row.displayName.includes(query.q)).map(itemView), query),
    getItem: (itemId) => itemDetail(db, itemId),
    listUnlinked: async (query) => {
      const paged = slice(await listUnlinkedKeys(db, query), query);
      return { items: await hydrateUnlinked(db, paged.items), page: paged.page };
    },
    listDemand: async (query) => pageOf([], query),
    listCustomerSupplied: async (query) => pageOf([], query),
    aliasById: (id) => aliasById(db, id),
    codeById: (id) => codeById(db, id),
    linkById: (id) => linkById(db, id),
    multiById: (id) => multiById(db, id),
    linkedReport: (input) => linkedReportView(db, input),
  };
}

async function counts(db: AppDatabase) {
  const [aliases, codes, links] = await Promise.all([
    db.select().from(partyAliases).where(eq(partyAliases.status, 'pending')),
    db.select().from(itemCodes).where(eq(itemCodes.status, 'pending')),
    db.select().from(codeLinks).where(eq(codeLinks.status, 'pending')),
  ]);
  return { aliases: aliases.length, codes: codes.length, links: links.length, multiName: (await multiName(db)).length };
}

async function codeById(db: AppDatabase, id: string) {
  const found = (await db.select().from(itemCodes)).map(codeView).find((row) => row.id === id);
  if (found === undefined) throw new Error(`编码不存在 ${id}`);
  return found;
}

async function linkById(db: AppDatabase, id: string) {
  const found = (await db.select().from(codeLinks)).map(linkView).find((row) => row.id === id);
  if (found === undefined) throw new Error(`对照不存在 ${id}`);
  return found;
}

async function multiById(db: AppDatabase, id: string) {
  const [code] = await db.select().from(itemCodes).where(eq(itemCodes.id, id));
  if (code === undefined) throw new NotFoundError('编码', id);
  const names = code.itemId === null ? [] : await db.select().from(itemNames).where(eq(itemNames.itemId, code.itemId));
  return multiNameView(code, names);
}

async function aliasById(db: AppDatabase, id: string) {
  const [aliases, rows] = await Promise.all([db.select().from(partyAliases), db.select().from(parties)]);
  const found = aliases.find((row) => row.id === id);
  if (found === undefined) throw new NotFoundError('别名', id);
  return aliasView(found, rows);
}

async function listAliases(db: AppDatabase, query: { readonly status?: string; readonly page?: number; readonly pageSize?: number }) {
  const [aliases, rows] = await Promise.all([db.select().from(partyAliases), db.select().from(parties)]);
  const views = aliases.filter((row) => query.status === undefined || row.status === query.status).map((row) => aliasView(row, rows));
  return pageOf(views, query);
}

function aliasView(row: typeof partyAliases.$inferSelect, knownParties: readonly (typeof parties.$inferSelect)[]) {
  return {
    id: row.id,
    rawName: row.rawName,
    normName: row.normName,
    partyId: row.partyId,
    status: oneOf(REVIEW_STATUSES, row.status),
    firstSeenImportBatchId: row.firstSeenImportBatchId,
    seenCount: row.seenCount,
    reviewedBy: row.reviewedBy,
    reviewedAt: row.reviewedAt,
    similar: similarOf(row.rawName, knownParties),
  };
}

function similarOf(rawName: string, rows: readonly (typeof parties.$inferSelect)[]) {
  const names = similarNames(rawName, rows.map((row) => row.displayName));
  return rows.filter((row) => names.includes(row.displayName)).map((row) => ({ partyId: row.id, displayName: row.displayName }));
}

function codeView(row: typeof itemCodes.$inferSelect) {
  return { id: row.id, codeType: oneOf(CODE_TYPES, row.codeType), codeRaw: row.codeRaw, codeNorm: row.codeNorm, itemId: row.itemId, status: oneOf(REVIEW_STATUSES, row.status) };
}

function linkView(row: typeof codeLinks.$inferSelect) {
  return { id: row.id, fromCodeId: row.fromCodeId, toCodeId: row.toCodeId, status: oneOf(REVIEW_STATUSES, row.status), evidence: row.evidence, reviewedBy: row.reviewedBy, reviewedAt: row.reviewedAt };
}

function partyView(row: typeof parties.$inferSelect) {
  return { id: row.id, displayName: row.displayName, isSupplier: row.isSupplier, isFactory: row.isFactory, isOwnWarehouse: row.isOwnWarehouse, note: row.note };
}

function partyMatches(row: typeof parties.$inferSelect, query: { readonly q?: string; readonly role?: 'supplier' | 'factory' | 'own_warehouse' }): boolean {
  if (query.q !== undefined && !row.displayName.includes(query.q)) return false;
  if (query.role === 'supplier') return row.isSupplier;
  if (query.role === 'factory') return row.isFactory;
  if (query.role === 'own_warehouse') return row.isOwnWarehouse;
  return true;
}

function itemView(row: typeof items.$inferSelect) {
  return { id: row.id, displayName: row.displayName, kind: oneOf(ITEM_KINDS, row.kind), spec: row.spec, sharedCodeFlag: row.sharedCodeFlag };
}

async function partyDetail(input: { readonly db: AppDatabase; readonly partyId: string; readonly today: LocalDate }) {
  const party = (await input.db.select().from(parties).where(eq(parties.id, input.partyId)))[0];
  if (party === undefined) throw new NotFoundError('主体', input.partyId);
  const aliases = (await input.db.select().from(partyAliases)).filter((row) => row.partyId === input.partyId);
  const empty = { numerator: null, denominator: null, n: 0 };
  return {
    party: partyView(party),
    aliases: aliases.map((row) => aliasView(row, [])),
    kpis: { dueBatches: empty, onTime: empty, averageDelayDays: empty, overdueNow: empty, dateChanges: empty, noteReturnDays: empty, openExceptions: empty },
    kpiWindow: recentMonth(input.today),
  };
}

async function itemDetail(db: AppDatabase, itemId: string) {
  const item = (await db.select().from(items).where(eq(items.id, itemId)))[0];
  if (item === undefined) throw new NotFoundError('物料', itemId);
  const codes = (await db.select().from(itemCodes)).filter((row) => row.itemId === itemId).map(codeView);
  const names = (await db.select().from(itemNames)).filter((row) => row.itemId === itemId).map((row) => ({ nameRaw: row.nameRaw, seenCount: row.seenCount }));
  return { item: itemView(item), codes, names };
}

async function multiName(db: AppDatabase) {
  const [codes, names] = await Promise.all([db.select().from(itemCodes), db.select().from(itemNames)]);
  return codes.flatMap((code) => {
    const view = multiNameView(code, names.filter((row) => row.itemId === code.itemId));
    return view.names.length < 2 ? [] : [view];
  });
}

function multiNameView(code: Pick<typeof itemCodes.$inferSelect, 'id' | 'codeRaw'>, names: readonly (typeof itemNames.$inferSelect)[]) {
  return { codeId: code.id, codeRaw: code.codeRaw, names: groupNames(names) };
}

function groupNames(rows: readonly (typeof itemNames.$inferSelect)[]) {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const current = counts.get(row.nameRaw);
    counts.set(row.nameRaw, current === undefined ? row.seenCount : current + row.seenCount);
  }
  return [...counts].map(([nameRaw, count]) => ({ nameRaw, count }));
}

function pageOf<T>(items: readonly T[], query: Page): ListResult<T> {
  return slice(items, query);
}

function slice<T>(items: readonly T[], query: Page): ListResult<T> {
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? PAGE_DEFAULT;
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > PAGE_MAX) {
    throw new ValidationFailedError('页码不合法', { field: 'page' });
  }
  return { items: items.slice((page - 1) * pageSize, page * pageSize), page: { page, pageSize, total: items.length } };
}
