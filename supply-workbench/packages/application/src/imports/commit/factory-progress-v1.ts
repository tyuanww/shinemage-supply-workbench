import { entityId, orderLineId, parseLocalDate, type EntityId, type FactoryDemandFacts, type FactoryDemandSlot, type FactoryInTransitFacts, type FactoryReportKind, type FactoryReportRow, type FactoryShipmentFacts, type ImportRow, type LocalDate } from '@sw/domain';
import { ImportFactoryRequiredError } from '../../shared/errors.js';
import { fingerprintOnRow, linksToCarry, type CarryLink } from './carry-links.js';
import type { CommitContext, CommitResult } from './context.js';

const SHEET_KIND: readonly { readonly title: string; readonly kind: FactoryReportKind }[] = [
  { title: '在途订单汇总', kind: 'in_transit' },
  { title: '成品出货明细', kind: 'shipment' },
  { title: '库存数量汇总', kind: 'stock' },
  { title: '排产计划', kind: 'schedule' },
  { title: '包材组合', kind: 'packaging_combo' },
  { title: '客供原料登记表', kind: 'customer_supplied' },
];

export async function commitFactory(ctx: CommitContext): Promise<CommitResult> {
  const partyId = ctx.batch.factoryPartyId;
  if (partyId === null) throw new ImportFactoryRequiredError();
  const assigned = ctx.rows.map((row) => fingerprintOnRow(row));
  const carried = await carriedLinks(ctx, assigned);
  for (let index = 0; index < ctx.rows.length; index += 1) {
    const row = ctx.rows[index];
    const fingerprint = assigned[index];
    if (row === undefined || fingerprint === undefined) continue;
    await saveRow({ ctx, row, partyId, link: carried[index] ?? null, fingerprint: fingerprint.value });
  }
  return { affectedLineIds: [], presentLineIds: [] };
}

async function saveRow(input: { readonly ctx: CommitContext; readonly row: ImportRow; readonly partyId: EntityId; readonly link: CarryLink | null; readonly fingerprint: string }): Promise<void> {
  // unchanged 的行也要写进新批次：旧快照在提交时会被退休，新活动快照必须是当前文件的全量镜像，
  // 否则只有变化行留在活动快照里，已交量/未关联队列会丢行。skip 表示本轮明确不导入，仍然跳过。
  // 新批次 id 不同，仓储 upsert 键含 import_batch_id，因此这里是插入完整镜像行而不是覆盖旧行。
  if (input.row.action === 'skip') return;
  const kind = kindOf(input.row.sheetName);
  if (kind === null) return;
  await input.ctx.tx.factoryReports.save(withCarriedLink(reportOf({ ctx: input.ctx, row: input.row, partyId: input.partyId, kind, fingerprint: input.fingerprint }), input.link));
}

/**
 * 继承来源只有同一 sourceKey 的上一份未退休活动快照。
 * 文件登记了指纹时按指纹一对一继承；同一快照里指纹重复则不继承。
 * 没有登记指纹、且表行号在两边都唯一时，才沿用原先行号继承。不扫描其它工厂或更早的快照。
 */
async function carriedLinks(ctx: CommitContext, assigned: readonly { readonly value: string; readonly fromFile: boolean }[]): Promise<readonly (CarryLink | null)[]> {
  const current = ctx.rows.map((row, index) => ({
    fingerprint: assigned[index] ?? { value: `row:${row.id}`, fromFile: false },
    sheetName: row.sheetName,
    rowNo: row.rowNo,
    unchanged: row.action === 'unchanged',
  }));
  const previous = await previousActiveSnapshot(ctx);
  if (previous === undefined) return current.map(() => null);
  const earlier: { readonly fingerprint: string; readonly sheetName: string; readonly rowNo: number; readonly link: CarryLink | null }[] = [];
  for (const previousRow of await ctx.tx.imports.listRows(previous.id)) {
    const report = await ctx.tx.factoryReports.find(`${previousRow.id}:report`);
    earlier.push({
      fingerprint: report?.fingerprint ?? `row:${previousRow.id}`,
      sheetName: previousRow.sheetName,
      rowNo: previousRow.rowNo,
      link: linkOf(report),
    });
  }
  return linksToCarry({ current, previous: earlier });
}

async function previousActiveSnapshot(ctx: CommitContext): Promise<{ readonly id: string } | undefined> {
  if (ctx.batch.sourceKey === null || ctx.batch.sourceKey === undefined) return undefined;
  return (await ctx.tx.imports.list()).find((item) =>
    item.id !== ctx.batch.id
    && item.status === 'committed'
    && item.template === 'factory-progress-v1'
    && item.sourceKey === ctx.batch.sourceKey
    && (item.supersededAt ?? null) === null);
}

function linkOf(report: FactoryReportRow | undefined): CarryLink | null {
  if (report === undefined || report.linkedOrderLineId === null) return null;
  if (report.linkStatus !== 'linked' && report.linkStatus !== 'manual') return null;
  return { linkedOrderLineId: report.linkedOrderLineId, linkStatus: report.linkStatus, linkReason: report.linkReason };
}

function withCarriedLink(report: FactoryReportRow, link: CarryLink | null): FactoryReportRow {
  return link === null ? report : { ...report, linkedOrderLineId: orderLineId(link.linkedOrderLineId), linkStatus: link.linkStatus, linkReason: link.linkReason };
}

function kindOf(sheetName: string): FactoryReportKind | null {
  const found = SHEET_KIND.find((item) => sheetName.trim() === item.title);
  if (found !== undefined) return found.kind;
  if (sheetName.includes('需求')) return 'demand';
  return null;
}

function reportOf(input: { readonly ctx: CommitContext; readonly row: ImportRow; readonly partyId: EntityId; readonly kind: FactoryReportKind; readonly fingerprint: string }): FactoryReportRow {
  return {
    id: entityId(`${input.row.id}:report`),
    importBatchId: input.ctx.batch.id,
    factoryPartyId: input.partyId,
    sheetName: input.row.sheetName,
    rowNo: input.row.rowNo,
    raw: input.row.raw,
    fingerprint: input.fingerprint,
    linkedOrderLineId: null,
    linkStatus: 'unlinked',
    linkReason: null,
    kind: input.kind,
    shipment: input.kind === 'shipment' ? shipmentOf(input.row.parsed) : null,
    demand: input.kind === 'demand' ? demandOf(input.row.parsed) : null,
    inTransit: input.kind === 'in_transit' ? transitOf(input.row.parsed) : null,
  };
}

function shipmentOf(parsed: unknown): FactoryShipmentFacts {
  return { qty: amount(parsed, 'qty'), shipOrArriveOn: dayOf(cellValue(parsed, 'shipOrArriveOn')) };
}

function transitOf(parsed: unknown): FactoryInTransitFacts {
  return {
    poRaw: poField(parsed, 'poRaw'),
    poNorm: poField(parsed, 'poNorm'),
    nameRaw: text(parsed, 'nameRaw'),
    itemCodeRaw: text(parsed, 'itemCodeRaw'),
    barcodeRaw: text(parsed, 'barcodeRaw'),
    qtyRequired: amount(parsed, 'qtyRequired'),
  };
}

function demandOf(parsed: unknown): FactoryDemandFacts | null {
  if (!isRecord(parsed) || (parsed.role !== 'parent' && parsed.role !== 'material')) return null;
  return {
    role: parsed.role,
    blockMaterialPoRaw: typeof parsed.blockMaterialPoRaw === 'string' ? parsed.blockMaterialPoRaw : null,
    poNorm: null,
    itemCodeRaw: text(parsed, 'itemCodeRaw'),
    nameRaw: text(parsed, 'nameRaw'),
    slots: slotsOf(parsed.slots),
  };
}

function slotsOf(value: unknown): FactoryDemandSlot[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(slotOf);
}

function slotOf(value: unknown): FactoryDemandSlot[] {
  if (!isRecord(value) || typeof value.index !== 'number') return [];
  return [{ index: value.index, date: dayOf(value.date), qty: typeof value.qty === 'number' ? value.qty : null }];
}

function poField(parsed: unknown, key: 'poRaw' | 'poNorm'): string | null {
  const value = cellValue(parsed, 'po');
  if (!isRecord(value) || typeof value[key] !== 'string') return null;
  return value[key];
}

function text(parsed: unknown, key: string): string | null {
  const value = cellValue(parsed, key);
  return typeof value === 'string' ? value : null;
}

function amount(parsed: unknown, key: string): number | null {
  const value = cellValue(parsed, key);
  return typeof value === 'number' ? value : null;
}

function dayOf(value: unknown): LocalDate | null {
  if (typeof value !== 'string') return null;
  const parsed = parseLocalDate(value);
  return parsed.ok ? parsed.value : null;
}

function cellValue(parsed: unknown, key: string): unknown {
  if (!isRecord(parsed)) return undefined;
  const cell = parsed[key];
  if (!isRecord(cell) || !('value' in cell)) return undefined;
  return cell.value;
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
