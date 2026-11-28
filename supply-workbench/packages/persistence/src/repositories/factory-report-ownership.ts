import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { FactoryReportRow } from '@sw/domain';
import type { FactoryReportRepository } from '../../../application/src/ports/factory-report-repository.js';
import type { AppDatabase } from '../client.js';
import { activeFactoryBatchIds, isActiveFactoryBatch } from '../queries/factory-links/snapshot-scope.js';
import { importBatches } from '../schema/archive.js';
import { factoryInTransitRows, factoryMaterialDemandRows, factoryShipmentRows, factoryStockRows } from '../schema/factory.js';
import { lockFactoryOwnershipChange, lockReportSources } from './factory-ownership-lock.js';

const ownershipTables = { shipment: factoryShipmentRows, in_transit: factoryInTransitRows, stock: factoryStockRows };
type OwnershipReportKind = keyof typeof ownershipTables;
type OwnershipReportTable = (typeof ownershipTables)[OwnershipReportKind];
type AssociationTable = OwnershipReportTable | typeof factoryMaterialDemandRows;

export async function lockReportOwnership(db: AppDatabase, { table, entity }: {
  readonly table: AssociationTable; readonly entity: FactoryReportRow;
}): Promise<void> {
  const identity = and(eq(table.importBatchId, entity.importBatchId), eq(table.fingerprint, entity.fingerprint),
    eq(table.sheetName, entity.sheetName), eq(table.rowNo, entity.rowNo));
  const [existing] = await db.select({ factoryPartyId: table.factoryPartyId }).from(table).where(identity);
  if (existing === undefined && !await canInsertActiveAssociation(db, entity)) return;
  await lockReportSources(db, [existing?.factoryPartyId ?? entity.factoryPartyId, entity.factoryPartyId]);
  if (table === factoryMaterialDemandRows || !await isActiveFactoryBatch(db, entity.importBatchId)) return;
  const [previous] = await db.select({ orderLineId: table.linkedOrderLineId }).from(table).where(identity).for('update');
  await lockFactoryOwnershipChange(db, [previous?.orderLineId ?? null, entity.linkedOrderLineId]);
}

async function canInsertActiveAssociation(db: AppDatabase, entity: FactoryReportRow): Promise<boolean> {
  if (entity.linkedOrderLineId === null) return false;
  const [batch] = await db.select({ status: importBatches.status }).from(importBatches).where(eq(importBatches.id, entity.importBatchId));
  return batch?.status === 'committed';
}

export async function effectiveReportOwners(db: AppDatabase, reports: Parameters<FactoryReportRepository['effectiveReportOwners']>[0]): Promise<readonly string[]> {
  const active = [...await activeFactoryBatchIds(db)];
  const shipments = orderIdsOfKind(db, { kind: 'shipment', reports, active });
  const transit = orderIdsOfKind(db, { kind: 'in_transit', reports, active });
  const stock = orderIdsOfKind(db, { kind: 'stock', reports, active });
  return (await Promise.all([shipments, transit, stock])).flat().flatMap(({ orderLineId }) => orderLineId === null ? [] : [orderLineId]);
}

function orderIdsOfKind(db: AppDatabase, { kind, reports, active }: {
  readonly kind: OwnershipReportKind;
  readonly reports: Parameters<FactoryReportRepository['effectiveReportOwners']>[0];
  readonly active: readonly string[];
}) {
  const ids = reports.filter((row) => row.kind === kind).map((row) => row.rowId);
  const table = ownershipTables[kind];
  return ids.length === 0 ? [] : snapshotOrderIds(db, { table, importBatchIds: active, reportIds: ids });
}

export async function lockSnapshotOrders(db: AppDatabase, input: Parameters<FactoryReportRepository['lockSnapshotOrders']>[0]): Promise<void> {
  const effective = input.onlyEffectivePrevious ? await activeFactoryBatchIds(db) : undefined;
  const importBatchIds = [input.incomingBatchId, ...input.previousBatchIds.filter((id) => effective === undefined || effective.has(id))];
  const rows = await snapshotOrderIds(db, { table: factoryShipmentRows, importBatchIds })
    .unionAll(snapshotOrderIds(db, { table: factoryInTransitRows, importBatchIds }))
    .unionAll(snapshotOrderIds(db, { table: factoryStockRows, importBatchIds }));
  await lockFactoryOwnershipChange(db, rows.map((row) => row.orderLineId));
}

function snapshotOrderIds(db: AppDatabase, { table, importBatchIds, reportIds }: {
  readonly table: OwnershipReportTable; readonly importBatchIds: readonly string[]; readonly reportIds?: readonly string[];
}) {
  return db.select({ orderLineId: table.linkedOrderLineId }).from(table).where(and(
    sql`${table.importBatchId} = any(${sql.param([...importBatchIds])}::text[])`, isNotNull(table.linkedOrderLineId), inArray(table.linkStatus, ['linked', 'manual']),
    reportIds === undefined ? undefined : sql`${table.id} = any(${sql.param([...reportIds])}::text[])`,
  ));
}
