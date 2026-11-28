import { eq, inArray, sql } from 'drizzle-orm';
import { normalizeText, type FactoryReportKind, type LineFactoryLinkSource, type LineFactoryLinkStatus, type LineFactoryMatchBasis } from '@sw/domain';
import type { FactoryLinkQueries, FactoryRowMatchRef, LineFactoryLinkView, OrderLineMatchRef } from '../../../../application/src/ports/factory-link-views.js';
import type { AppDatabase } from '../../client.js';
import { customerSuppliedReceiptRows, factoryInTransitRows, factoryMaterialDemandRows, factoryPackagingComboRows, factoryScheduleCells, factoryShipmentRows, factoryStockRows } from '../../schema/factory.js';
import { lineFactoryLinks, orderLines, purchaseOrders } from '../../schema/orders.js';
import { parties, partyAliases } from '../../schema/platform.js';
import { effectiveFactoryLinks, type EffectiveFactoryLink } from './line-association.js';
import { activeFactoryBatchIds } from './snapshot-scope.js';
import { listDiagnosticPage, listUnmatched } from './unmatched.js';

const STATUSES: readonly LineFactoryLinkStatus[] = ['linked', 'unlinked', 'manual'];
const SOURCES: readonly LineFactoryLinkSource[] = ['po_master', 'factory_progress', 'relink', 'manual'];
const CONFIDENCES: readonly LineFactoryMatchBasis[] = ['po', 'item_code', 'barcode', 'column', 'manual', 'none'];

export function factoryLinkQueries(db: AppDatabase): FactoryLinkQueries {
  return {
    listOrderLineRefs: () => listOrderLineRefs(db),
    listFactoryRowRefs: () => listFactoryRowRefs(db),
    listActiveScheduleRefs: () => listActiveScheduleRefs(db),
    listUnmatched: (limit) => listUnmatched(db, limit),
    listDiagnosticPage: (input) => listDiagnosticPage(db, input),
    getView: (orderLineId) => getView(db, orderLineId),
    countStates: () => countStates(db),
    listApprovedSupplierAliases: () => listApprovedSupplierAliases(db),
  };
}

async function listOrderLineRefs(db: AppDatabase): Promise<readonly OrderLineMatchRef[]> {
  const [lines, orders, links] = await Promise.all([
    db.select().from(orderLines),
    db.select().from(purchaseOrders),
    db.select().from(lineFactoryLinks),
  ]);
  const orderById = new Map(orders.map((order) => [order.id, order]));
  const linkByLine = new Map(links.map((link) => [link.orderLineId, link]));
  return lines.map((line) => {
    const link = linkByLine.get(line.id);
    return {
      orderLineId: line.id,
      poNorm: poNormOf(orderById.get(line.purchaseOrderId)?.poNorm ?? null),
      itemCodeNorm: normOf(line.itemCodeRaw),
      barcodeNorm: normOf(line.barcodeRaw),
      linkId: link?.id ?? null,
      linkStatus: link === undefined ? null : statusOf(link.status),
      linkReason: link?.reason ?? null,
      ...(link === undefined ? {} : { linkSource: sourceOf(link.source) }),
    };
  });
}

async function listFactoryRowRefs(db: AppDatabase): Promise<readonly FactoryRowMatchRef[]> {
  const [shipments, transits, stocks, schedules, combos, supplied, demands] = await Promise.all([
    db.select().from(factoryShipmentRows),
    db.select().from(factoryInTransitRows),
    db.select().from(factoryStockRows),
    db.select().from(factoryScheduleCells),
    db.select().from(factoryPackagingComboRows),
    db.select().from(customerSuppliedReceiptRows),
    db.select().from(factoryMaterialDemandRows),
  ]);
  const rows = [
    ...shipments.map((row) => refOf({ row, kind: 'shipment', poNorm: row.poNorm, poRaw: row.poRaw, itemCodeRaw: row.itemCodeRaw, barcodeRaw: null })),
    ...transits.map((row) => refOf({ row, kind: 'in_transit', poNorm: row.poNorm, poRaw: row.poRaw, itemCodeRaw: row.itemCodeRaw, barcodeRaw: row.barcodeRaw })),
    ...stocks.map((row) => refOf({ row, kind: 'stock', poNorm: normOf(row.poRaw), poRaw: row.poRaw, itemCodeRaw: row.itemCodeRaw, barcodeRaw: null })),
    ...schedules.map((row) => refOf({ row, kind: 'schedule', poNorm: normOf(row.poRaw), poRaw: row.poRaw, itemCodeRaw: row.itemCodeRaw, barcodeRaw: null })),
    ...combos.map((row) => refOf({ row, kind: 'packaging_combo', poNorm: normOf(row.poRaw), poRaw: row.poRaw, itemCodeRaw: row.itemCodeRaw, barcodeRaw: null })),
    ...supplied.map((row) => refOf({ row, kind: 'customer_supplied', poNorm: null, poRaw: null, itemCodeRaw: row.itemCodeRaw, barcodeRaw: null })),
    ...demands.map((row) => refOf({ row, kind: 'demand', poNorm: null, poRaw: null, itemCodeRaw: row.itemCodeRaw, barcodeRaw: null })),
  ];
  return rows.sort((left, right) => left.rowId.localeCompare(right.rowId) || left.kind.localeCompare(right.kind));
}

async function listActiveScheduleRefs(db: AppDatabase): Promise<readonly FactoryRowMatchRef[]> {
  const active = [...await activeFactoryBatchIds(db)];
  if (active.length === 0) return [];
  const rows = await db.select().from(factoryScheduleCells).where(inArray(factoryScheduleCells.importBatchId, active));
  return rows.map((row) => refOf({ row, kind: 'schedule', poNorm: normOf(row.poRaw), poRaw: row.poRaw, itemCodeRaw: row.itemCodeRaw, barcodeRaw: null })).sort((left, right) => left.rowId.localeCompare(right.rowId));
}

function refOf(input: {
  readonly row: { readonly id: string; readonly factoryPartyId: string; readonly linkStatus: string; readonly linkReason: string | null; readonly linkedOrderLineId: string | null };
  readonly kind: FactoryReportKind;
  readonly poNorm: string | null;
  readonly poRaw: string | null;
  readonly itemCodeRaw: string | null;
  readonly barcodeRaw: string | null;
}): FactoryRowMatchRef {
  return {
    rowId: input.row.id,
    kind: input.kind,
    factoryPartyId: input.row.factoryPartyId,
    poNorm: poNormOf(input.poNorm),
    itemCodeNorm: normOf(input.itemCodeRaw),
    barcodeNorm: normOf(input.barcodeRaw),
    poRaw: input.poRaw,
    itemCodeRaw: input.itemCodeRaw,
    barcodeRaw: input.barcodeRaw,
    linkStatus: input.row.linkStatus,
    linkReason: input.row.linkReason,
    linkedOrderLineId: input.row.linkedOrderLineId,
  };
}

async function getView(db: AppDatabase, orderLineId: string): Promise<LineFactoryLinkView | undefined> {
  const [link] = await effectiveFactoryLinks({ db, activeFactoryBatchIds: await activeFactoryBatchIds(db), lineIds: [orderLineId] });
  return link === undefined ? undefined : viewOf({ row: link, factory: await factoryRef(db, link.factoryPartyId) });
}

async function countStates(db: AppDatabase): Promise<{ readonly linked: number; readonly manual: number; readonly unlinked: number }> {
  const links = effectiveFactoryLinks({ db, activeFactoryBatchIds: await activeFactoryBatchIds(db) }).as('effective_factory_links');
  const [counts] = await db.select({
    linked: sql<number>`count(*) filter (where ${links.status} = 'linked')::int`,
    manual: sql<number>`count(*) filter (where ${links.status} = 'manual')::int`,
    unlinked: sql<number>`count(*) filter (where ${links.status} is null or ${links.status} = 'unlinked')::int`,
  }).from(orderLines).leftJoin(links, eq(links.orderLineId, orderLines.id));
  return counts ?? { linked: 0, manual: 0, unlinked: 0 };
}

async function listApprovedSupplierAliases(db: AppDatabase): Promise<readonly { readonly normName: string; readonly partyId: string }[]> {
  const [aliases, rows] = await Promise.all([db.select().from(partyAliases), db.select().from(parties)]);
  const supplierIds = new Set(rows.filter((party) => party.isSupplier).map((party) => party.id));
  return aliases.flatMap((alias) => {
    if (alias.status !== 'approved' || alias.partyId === null || !supplierIds.has(alias.partyId)) return [];
    return [{ normName: alias.normName, partyId: alias.partyId }];
  });
}

async function factoryRef(db: AppDatabase, partyId: string | null): Promise<{ readonly id: string; readonly displayName: string } | null> {
  if (partyId === null) return null;
  const rows = await db.select().from(parties).where(eq(parties.id, partyId));
  const row = rows[0];
  return row === undefined ? null : { id: row.id, displayName: row.displayName };
}

function viewOf(input: { readonly row: EffectiveFactoryLink; readonly factory: { readonly id: string; readonly displayName: string } | null }): LineFactoryLinkView {
  return {
    orderLineId: input.row.orderLineId,
    factory: input.factory,
    status: statusOf(input.row.status),
    source: sourceOf(input.row.source),
    confidence: confidenceOf(input.row.confidence),
    reason: input.row.reason,
    linkedAt: new Date(input.row.linkedAt).toISOString(),
  };
}

function poNormOf(value: string | null): string | null {
  return normOf(value);
}

function normOf(value: string | null): string | null {
  if (value === null) return null;
  const text = normalizeText(value);
  return text === '' ? null : text;
}

function statusOf(value: string): LineFactoryLinkStatus {
  for (const item of STATUSES) if (item === value) return item;
  throw new Error(`未知工厂关联状态 ${value}`);
}

function sourceOf(value: string): LineFactoryLinkSource {
  for (const item of SOURCES) if (item === value) return item;
  throw new Error(`未知工厂关联来源 ${value}`);
}

function confidenceOf(value: string): LineFactoryMatchBasis {
  for (const item of CONFIDENCES) if (item === value) return item;
  throw new Error(`未知工厂关联依据 ${value}`);
}
