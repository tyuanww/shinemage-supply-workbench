import type { DeliveryBatch, Shipment } from '@sw/domain';
import type { DeliveryBatchRepository } from '../../../application/src/ports/delivery-batch-repository.js';
import type { ExceptionRepository } from '../../../application/src/ports/exception-repository.js';
import type { FactoryReportRepository } from '../../../application/src/ports/factory-report-repository.js';
import type { FollowUpRepository } from '../../../application/src/ports/follow-up-repository.js';
import type { ImportBatchRepository } from '../../../application/src/ports/import-batch-repository.js';
import type { ItemRepository } from '../../../application/src/ports/item-repository.js';
import type { OrderLineRepository } from '../../../application/src/ports/order-line-repository.js';
import type { PartyRepository } from '../../../application/src/ports/party-repository.js';
import type { ProductRepository } from '../../../application/src/ports/product-repository.js';
import type { PurchaseOrderRepository } from '../../../application/src/ports/purchase-order-repository.js';
import type { SettingsRepository } from '../../../application/src/ports/settings-repository.js';
import type { UserRepository } from '../../../application/src/ports/user-repository.js';
import type { WeeklyReportRepository } from '../../../application/src/ports/weekly-report-repository.js';
import {
  aFactoryStockRow,
  aFollowUp,
  aParty,
  aProduct,
  aPurchaseOrder,
  aUser,
  anException,
  anItem,
  anOrderLine,
  aBatch,
} from '../builders.js';
import { describeIdRepositoryContract } from './id-repository.js';
import { expect, it } from 'vitest';
import { localDate } from '@sw/domain';
import { entityId, orderLineId } from '../ids.js';

export function describeUserRepositoryContract(make: () => UserRepository): void {
  describeIdRepositoryContract('用户仓储', () => ({ repo: make(), sample: aUser }));
  it('用户仓储列出全部用户，含停用', async () => {
    const repo = make();
    const active = aUser({ active: true });
    const stopped = aUser({ active: false });
    await repo.save(active);
    await repo.save(stopped);
    expect(await repo.list()).toEqual([active, stopped]);
  });
}

export function describePartyRepositoryContract(make: () => PartyRepository): void {
  describeIdRepositoryContract('主体仓储', () => ({ repo: make(), sample: aParty }));
}

export function describeItemRepositoryContract(make: () => ItemRepository): void {
  describeIdRepositoryContract('物料仓储', () => ({ repo: make(), sample: anItem }));
}

export function describePurchaseOrderRepositoryContract(make: () => PurchaseOrderRepository): void {
  describeIdRepositoryContract('采购单仓储', () => ({ repo: make(), sample: aPurchaseOrder }));
  it('按规范化单号找采购单，无单号的按线分开', async () => {
    const repo = make();
    const numbered = aPurchaseOrder({
      poNorm: '3500-202609700002',
      poRaw: '3500-202609700002',
      poFormat: 'PUR3500',
    });
    const blank = aPurchaseOrder({ poRaw: null, poNorm: null, poFormat: 'NONE', lane: 'material' });
    const finishedBlank = aPurchaseOrder({
      poRaw: null,
      poNorm: null,
      poFormat: 'NONE',
      lane: 'finished',
    });
    await repo.save(numbered);
    await repo.save(blank);
    await repo.save(finishedBlank);
    expect((await repo.listByPoNorm('3500-202609700002')).map((row) => row.id)).toEqual([
      numbered.id,
    ]);
    expect((await repo.listNoNumber('material')).map((row) => row.id)).toEqual([blank.id]);
    expect(await repo.listByPoNorm('missing')).toEqual([]);
  });
}

export function describeOrderLineRepositoryContract(make: () => OrderLineRepository): void {
  describeIdRepositoryContract('订单行仓储', () => ({ repo: make(), sample: anOrderLine }));
  it('按采购单列订单行，别的采购单不混进来', async () => {
    const repo = make();
    const own = anOrderLine({ purchaseOrderId: entityId('po-own') });
    const other = anOrderLine({ purchaseOrderId: entityId('po-other') });
    await repo.save(own);
    await repo.save(other);
    expect((await repo.listByPurchaseOrder('po-own')).map((row) => row.id)).toEqual([own.id]);
    expect(await repo.listByPurchaseOrder('missing')).toEqual([]);
  });
}

export function describeExceptionRepositoryContract(make: () => ExceptionRepository): void {
  describeIdRepositoryContract('异常仓储', () => ({ repo: make(), sample: anException }));
}

export function describeFollowUpRepositoryContract(make: () => FollowUpRepository): void {
  describeIdRepositoryContract('跟进仓储', () => ({ repo: make(), sample: aFollowUp }));
}

export function describeFactoryReportRepositoryContract(make: () => FactoryReportRepository): void {
  describeIdRepositoryContract('代工厂上报仓储', () => ({
    repo: make(),
    sample: aFactoryStockRow,
  }));

  it('按编码读取和准备重联使用相同的工厂品号及条码规范', async () => {
    const repo = make();
    const row = aFactoryStockRow({
      kind: 'in_transit',
      inTransit: { poRaw: 'P00012', poNorm: 'P00012', itemCodeRaw: ' ｋ１２３ ', barcodeRaw: 'Ａ  Ｂ', nameRaw: null, qtyRequired: 50 },
    });
    await repo.save(row);
    for (const code of ['Ｋ１２３', ' k123 ', ' a  b ']) {
      expect((await repo.listByCodeNorm(code)).map(({ id }) => id)).toEqual([row.id]);
      expect((await repo.lockRelinkRows({ codeNorms: [code], candidates: [row] })).map(({ id }) => id)).toEqual([row.id]);
    }
    for (const code of ['A B', '　']) {
      expect(await repo.listByCodeNorm(code)).toEqual([]);
      expect(await repo.lockRelinkRows({ codeNorms: [code], candidates: [row] })).toEqual([]);
    }
  });

  describeRelinkRowsContract(make);

  it('按编码仍读出无独立采购单的需求，准备重联时略过', async () => {
    const repo = make();
    const row = aFactoryStockRow({
      kind: 'demand',
      demand: { role: 'material', blockMaterialPoRaw: 'P00012', poNorm: null, itemCodeRaw: 'Ｋ１２３', nameRaw: null, slots: [] },
    });
    await repo.save(row);
    expect((await repo.listByCodeNorm('k123')).map(({ id }) => id)).toEqual([row.id]);
    expect(await repo.lockRelinkRows({ codeNorms: ['k123'], candidates: [row] })).toEqual([]);
  });
}

function describeRelinkRowsContract(make: () => FactoryReportRepository): void {
  it('重联按在途、需求和行 ID 排序，重复候选只返回一次', async () => {
    const repo = make();
    const transitA = relinkTransit('transit-a');
    const transitB = relinkTransit('transit-b');
    const demand = aFactoryStockRow({
      id: entityId('demand-a'), kind: 'demand',
      demand: { role: 'material', blockMaterialPoRaw: 'P00012', poNorm: 'P00012', itemCodeRaw: 'K123', nameRaw: null, slots: [] },
    });
    for (const row of [demand, transitB, transitA]) await repo.save(row);
    const candidates = [demand, transitB, transitB, transitA, demand];
    expect((await repo.lockRelinkRows({ codeNorms: ['k123'], candidates })).map(({ id }) => id))
      .toEqual([transitA.id, transitB.id, demand.id]);
  });

  it('从已发现候选重读当前工厂、人工关联和原始编码', async () => {
    const repo = make();
    const manual = relinkTransit('now-manual');
    const moved = relinkTransit('moved-factory');
    const changed = relinkTransit('changed-code');
    const retained = relinkTransit('retained-code');
    for (const row of [manual, moved, changed, retained]) await repo.save(row);
    const candidates = await repo.listByCodeNorm('k123');
    expect(candidates).toHaveLength(4);
    await repo.save({ ...manual, linkStatus: 'manual' });
    await repo.save({ ...moved, factoryPartyId: entityId('other-factory') });
    await repo.save({ ...changed, inTransit: { ...changed.inTransit, itemCodeRaw: 'NOT-REQUESTED', barcodeRaw: 'NOT-MATCHING' } });
    const latest = { ...retained, inTransit: { ...retained.inTransit, nameRaw: '最新名称', barcodeRaw: '最新条码' } };
    await repo.save(latest);
    expect(await repo.lockRelinkRows({ codeNorms: ['Ｋ１２３'], candidates })).toEqual([latest]);
  });
}

function relinkTransit(id: string) {
  const inTransit = { poRaw: 'P00012', poNorm: 'P00012', itemCodeRaw: ' ｋ１２３ ', barcodeRaw: 'BAR', nameRaw: '旧名称', qtyRequired: 50 };
  return { ...aFactoryStockRow({ id: entityId(id), kind: 'in_transit' }), inTransit };
}

export function describeProductRepositoryContract(make: () => ProductRepository): void {
  describeIdRepositoryContract('产品仓储', () => ({ repo: make(), sample: aProduct }));
}

export function describeImportBatchRepositoryContract(make: () => ImportBatchRepository): void {
  describeIdRepositoryContract('导入批次仓储', () => ({ repo: make(), sample: anImportBatch }));
}

export function describeSettingsRepositoryContract(make: () => SettingsRepository): void {
  it('没有保存过设置时返回领域默认，不抛错', async () => {
    expect((await make().get()).upcomingDays).toBe(3);
  });
  it('保存后的设置能读回', async () => {
    const repo = make();
    const saved = { ...(await repo.get()), upcomingDays: 5 };
    await repo.save(saved);
    expect(await repo.get()).toEqual(saved);
  });
}

export function describeDeliveryBatchRepositoryContract(make: () => DeliveryBatchRepository): void {
  describeIdRepositoryContract('要货批次仓储', () => ({
    repo: make(),
    sample: () => aBatch().build(),
  }));
  it('没有附属记录时明细是空的', async () => {
    const repo = make();
    const batch = aBatch().build();
    await repo.save(batch);
    const loaded = await repo.getWithRecords(batch.id);
    expect(loaded.shipments).toEqual([]);
    expect(loaded.deliveryNote).toBeNull();
  });

  it('按订单行列批次，别的订单行不混进来', async () => {
    const repo = make();
    const own = aBatch().build();
    const other = { ...aBatch().build(), orderLineId: orderLineId('line-2') };
    await repo.save(own);
    await repo.save(other);
    expect((await repo.listByOrderLine(own.orderLineId)).map((row) => row.id)).toEqual([own.id]);
    expect(await repo.listByOrderLine('missing')).toEqual([]);
  });

  it('附属记录随聚合保存，删除后一起消失', async () => {
    const repo = make();
    const batch = aBatch().build();
    const shipment = aBatch().withShipment(2).records().shipments[0];
    if (shipment === undefined) throw new Error('夹具没有发货');
    await repo.saveWithRecords({
      batch,
      shipments: [{ ...shipment, batchId: batch.id }],
      receipts: [],
      deliveryNote: null,
      dateChanges: [],
    });
    expect((await repo.getWithRecords(batch.id)).shipments).toHaveLength(1);
    await repo.remove(batch.id);
    expect(await repo.find(batch.id)).toBeUndefined();
  });

  describeDeliveryBatchSlotContract(make);
}

function describeDeliveryBatchSlotContract(make: () => DeliveryBatchRepository): void {
  it('按来源槽找批次，别的槽不混进来', async () => {
    const repo = make();
    const match = { ...aBatch().build(), originRef: { rowId: 'row-1', slotIndex: 0 } };
    const other = { ...aBatch().build(), originRef: { rowId: 'row-1', slotIndex: 1 } };
    await repo.save(match);
    await repo.save(other);
    expect(
      (await repo.listByOriginRef({ rowId: 'row-1', slotIndex: 0 })).map((row) => row.id),
    ).toEqual([match.id]);
    expect(await repo.listByOriginRef({ rowId: 'missing', slotIndex: 0 })).toEqual([]);
  });

  it('已作废的采纳发货不算这条出货行已被采纳', async () => {
    const repo = make();
    const batch = aBatch().build();
    const live = aBatch().withShipment(2).records().shipments[0];
    if (live === undefined) throw new Error('夹具没有发货');
    await saveAdopted({ repo, batch, shipment: live, voidedAt: null });
    expect(await repo.findAdoptedShipment('ship-row')).toEqual({ shipmentId: live.id, batchId: batch.id });
    await saveAdopted({ repo, batch, shipment: live, voidedAt: '2026-10-12T00:00:00.000Z' });
    expect(await repo.findAdoptedShipment('ship-row')).toBeUndefined();
  });
}

export function describeWeeklyReportRepositoryContract(make: () => WeeklyReportRepository): void {
  describeIdRepositoryContract('周报仓储', () => ({ repo: make(), sample: aWeeklyReport }));
  it('周报按生成时间倒序分页', async () => {
    const repo = make();
    const older = aWeeklyReport('2026-10-05T00:00:00.000Z');
    const newer = aWeeklyReport('2026-10-12T00:00:00.000Z');
    await repo.save(older);
    await repo.save(newer);
    expect((await repo.list({ page: 1, pageSize: 1 })).items.map((row) => row.id)).toEqual([
      newer.id,
    ]);
  });
}

async function saveAdopted(input: { readonly repo: DeliveryBatchRepository; readonly batch: DeliveryBatch; readonly shipment: Shipment; readonly voidedAt: string | null }): Promise<void> {
  await input.repo.saveWithRecords({
    batch: input.batch,
    shipments: [{ ...input.shipment, batchId: input.batch.id, factoryShipmentRowId: entityId('ship-row'), source: 'factory_report_adopted', voidedAt: input.voidedAt }],
    receipts: [],
    deliveryNote: null,
    dateChanges: [],
  });
}

function anImportBatch() {
  return {
    ...stamp(),
    fileId: entityId('file-1'),
    template: 'po-master-v1' as const,
    factoryPartyId: null,
    status: 'parsed' as const,
    coverage: 'full_snapshot' as const,
    fileMeta: {},
    stats: {},
    decisions: {},
    createdBy: entityId('user-1'),
    committedBy: null,
    committedAt: null,
    rolledBackBy: null,
    rolledBackAt: null,
    error: null,
  };
}

function aWeeklyReport(generatedAt = '2026-10-12T00:00:00.000Z') {
  return {
    ...stamp(),
    weekStart: localDate('2026-10-05'),
    generatedAt,
    generatedBy: entityId('user-1'),
    data: {},
    dataWatermark: {},
    exports: {},
    supersededBy: null,
  };
}

let sampleSequence = 1;

function stamp() {
  const id = entityId(`sample-${sampleSequence}`);
  sampleSequence += 1;
  return { id, createdAt: '2026-10-12T00:00:00.000Z', updatedAt: '2026-10-12T00:00:00.000Z' };
}
