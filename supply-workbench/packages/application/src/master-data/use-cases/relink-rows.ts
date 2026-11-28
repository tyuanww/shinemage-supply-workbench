import {
  codeDecisionOf,
  linkFactoryRow,
  type ApprovedCodeLink,
  type CodeDecision,
  type EntityId,
  type FactoryLinkLine,
  type FactoryLinkRow,
  type FactoryReportRow,
  type OrderLineId,
} from '@sw/domain';
import type { UnitOfWorkStores } from '../../ports/unit-of-work.js';
import { compareFactoryReportWrites } from '../../shared/factory-report-order.js';

export async function prepareCodeRelink(tx: UnitOfWorkStores, codeNorms: readonly string[]): Promise<readonly FactoryReportRow[]> {
  const sources = new Set<string>();
  for (;;) {
    const rows = (await rowsFor(tx, codeNorms)).filter((row) => linkFacts(row) !== null);
    const pending = rows.flatMap((row) => sources.has(row.factoryPartyId) ? [] : [row.factoryPartyId]);
    if (pending.length === 0) {
      const locked = await tx.factoryReports.lockRelinkRows({ codeNorms, candidates: rows });
      return locked.filter((row) => linkFacts(row) !== null).sort(compareFactoryReportWrites);
    }
    await tx.factoryReports.lockReportSources(pending);
    for (const id of pending) sources.add(id);
  }
}

export async function relinkPreparedRows(tx: UnitOfWorkStores, rows: readonly FactoryReportRow[]): Promise<string[]> {
  if (rows.length === 0) return [];
  const links = await approvedLinks(tx);
  const lineIds: string[] = [];
  for (const row of rows) {
    lineIds.push(...(await affectedLines({ tx, row, links })));
  }
  return lineIds;
}

async function rowsFor(tx: UnitOfWorkStores, norms: readonly string[]): Promise<FactoryReportRow[]> {
  const seen = new Map<string, FactoryReportRow>();
  for (const norm of norms) {
    if (norm === '') continue;
    for (const row of await tx.factoryReports.listByCodeNorm(norm)) {
      if (row.linkStatus === 'manual') continue;
      seen.set(row.id, row);
    }
  }
  return [...seen.values()];
}

async function approvedLinks(tx: UnitOfWorkStores): Promise<ApprovedCodeLink[]> {
  const links = await tx.codeLinks.listApproved();
  const result: ApprovedCodeLink[] = [];
  for (const link of links) {
    const pair = await linkPair({ tx, fromId: link.fromCodeId, toId: link.toCodeId });
    if (pair !== null) result.push(pair);
  }
  return result;
}

async function linkPair({ tx, fromId, toId }: { readonly tx: UnitOfWorkStores; readonly fromId: string; readonly toId: string }): Promise<ApprovedCodeLink | null> {
  const left = await tx.itemCodes.find(fromId);
  const right = await tx.itemCodes.find(toId);
  if (left === undefined || right === undefined) return null;
  return { leftNorm: left.codeNorm, rightNorm: right.codeNorm };
}

async function affectedLines({ tx, row, links }: { readonly tx: UnitOfWorkStores; readonly row: FactoryReportRow; readonly links: readonly ApprovedCodeLink[] }): Promise<string[]> {
  const facts = linkFacts(row);
  if (facts === null) return [];
  const result = linkFactoryRow({ row: facts, lines: await linesFor(tx, facts.poNorm), approvedLinks: links });
  await tx.factoryReports.save(applied(row, result));
  const ids = row.linkedOrderLineId === null ? [] : [row.linkedOrderLineId];
  return result.status === 'linked' ? [...ids, result.lineId] : ids;
}

function linkFacts(row: FactoryReportRow): FactoryLinkRow | null {
  const transit = row.inTransit;
  if (transit !== null && transit.poNorm !== null && transit.poNorm !== '') {
    return { poNorm: transit.poNorm, itemCodeNorm: transit.itemCodeRaw, nameRaw: transit.nameRaw, barcodeRaw: transit.barcodeRaw };
  }
  const demand = row.demand;
  if (demand !== null && demand.poNorm !== null && demand.poNorm !== '') {
    return { poNorm: demand.poNorm, itemCodeNorm: demand.itemCodeRaw, nameRaw: demand.nameRaw, barcodeRaw: null };
  }
  return null;
}

async function linesFor(tx: UnitOfWorkStores, poNorm: string): Promise<FactoryLinkLine[]> {
  const orders = await tx.purchaseOrders.listByPoNorm(poNorm);
  const lines: FactoryLinkLine[] = [];
  for (const order of orders) {
    for (const line of await tx.orderLines.listByPurchaseOrder(order.id)) {
      lines.push(await linkLine({ tx, line, poNorm: order.poNorm ?? poNorm }));
    }
  }
  return lines;
}

async function linkLine({ tx, line, poNorm }: { readonly tx: UnitOfWorkStores; readonly line: { readonly id: OrderLineId; readonly itemId: EntityId | null; readonly itemCodeRaw: string | null; readonly barcodeRaw: string | null; readonly nameRaw: string | null }; readonly poNorm: string }): Promise<FactoryLinkLine> {
  return {
    id: line.id,
    poNorm,
    itemCodeNorm: line.itemCodeRaw,
    nameRaw: line.nameRaw,
    barcodeRaw: line.barcodeRaw,
    codeDecision: await decisionOf(tx, line.itemId),
  };
}

async function decisionOf(tx: UnitOfWorkStores, itemId: string | null): Promise<CodeDecision> {
  if (itemId === null) return 'undecided';
  const item = await tx.items.find(itemId);
  if (item === undefined) return 'undecided';
  const mode = await tx.itemNames.decision(itemId);
  return codeDecisionOf({ sharedCodeFlag: item.sharedCodeFlag, decided: mode !== 'undecided' });
}

function applied(row: FactoryReportRow, result: ReturnType<typeof linkFactoryRow>): FactoryReportRow {
  if (result.status === 'linked') return { ...row, linkedOrderLineId: result.lineId, linkStatus: 'linked', linkReason: null };
  return { ...row, linkedOrderLineId: null, linkStatus: result.status, linkReason: result.reason };
}
