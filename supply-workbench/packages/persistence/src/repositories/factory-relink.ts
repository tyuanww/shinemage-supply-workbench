import { and, ne, sql } from 'drizzle-orm';
import { normalizeFactoryReportCode } from '@sw/domain';
import type { FactoryReportRepository } from '../../../application/src/ports/factory-report-repository.js';
import type { AppDatabase } from '../client.js';
import { factoryInTransitRows, factoryMaterialDemandRows } from '../schema/factory.js';

export function readReportsByCode(db: AppDatabase, codeNorms: readonly string[]) {
  return reportsByCode(db, relinkCodes(codeNorms));
}

type RelinkInput = Parameters<FactoryReportRepository['lockRelinkRows']>[0];
type RelinkTable = typeof factoryInTransitRows | typeof factoryMaterialDemandRows;

export async function lockReportsByCode(db: AppDatabase, { codeNorms, candidates }: RelinkInput) {
  const codes = relinkCodes(codeNorms);
  if (codes.size === 0) return { transit: [], demand: [] };
  const transit = candidates.filter((row) => row.kind === 'in_transit');
  const demand = candidates.filter((row) => row.kind === 'demand');
  const transitTable = factoryInTransitRows;
  const demandTable = factoryMaterialDemandRows;
  const lockedTransit = transit.length === 0 ? [] : await db.select().from(transitTable)
    .where(and(relinkRowScope(transitTable, transit), ne(transitTable.poNorm, '')))
    .orderBy(sql`${transitTable.id} collate "C"`).for('update');
  const lockedDemand = demand.length === 0 ? [] : await db.select().from(demandTable)
    .where(and(relinkRowScope(demandTable, demand),
      sql`jsonb_typeof(${demandTable.slots}->'poNorm') = 'string' and ${demandTable.slots}->>'poNorm' <> ''`))
    .orderBy(sql`${demandTable.id} collate "C"`).for('update');
  return {
    transit: lockedTransit.filter((row) => matchesReportCode(row, codes)),
    demand: lockedDemand.filter((row) => matchesReportCode(row, codes)),
  };
}

function relinkRowScope(table: RelinkTable, rows: RelinkInput['candidates']) {
  const ids = rows.map(({ id }) => id);
  const factories = rows.map(({ factoryPartyId }) => factoryPartyId);
  return and(sql`(${table.id}, ${table.factoryPartyId}) in (select * from unnest(${sql.param(ids)}::text[], ${sql.param(factories)}::text[]))`,
    ne(table.linkStatus, 'manual'));
}

async function reportsByCode(db: AppDatabase, codes: ReadonlySet<string>) {
  if (codes.size === 0) return { transit: [], demand: [] };
  const transit = await db.select().from(factoryInTransitRows);
  const demand = await db.select().from(factoryMaterialDemandRows);
  return { transit: transit.filter((row) => matchesReportCode(row, codes)), demand: demand.filter((row) => matchesReportCode(row, codes)) };
}

function matchesReportCode(row: { readonly itemCodeRaw: string | null; readonly barcodeRaw?: string | null }, codes: ReadonlySet<string>): boolean {
  return codes.has(normalizeFactoryReportCode(row.itemCodeRaw)) || codes.has(normalizeFactoryReportCode(row.barcodeRaw));
}

function relinkCodes(codeNorms: readonly string[]): ReadonlySet<string> {
  return new Set(codeNorms.map(normalizeFactoryReportCode).filter((code) => code !== ''));
}
