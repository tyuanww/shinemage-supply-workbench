import { entityId, localDate, orderLineId } from '../../packages/domain/src/index.js';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import type { FactoryReportRow, ImportBatch } from '../../packages/domain/src/index.js';
import { createDb, type AppHandle } from '../../packages/persistence/src/client.js';
import { migrate } from '../../packages/persistence/src/migrate.js';
import { factoryReportRepository, insertFactoryShipments } from '../../packages/persistence/src/repositories/factory-reports.js';
import { importBatchRepository } from '../../packages/persistence/src/repositories/import-batches.js';
import { itemRepository } from '../../packages/persistence/src/repositories/items.js';
import { orderLineRepository } from '../../packages/persistence/src/repositories/order-lines.js';
import { partyRepository } from '../../packages/persistence/src/repositories/parties.js';
import { purchaseOrderRepository } from '../../packages/persistence/src/repositories/purchase-orders.js';
import {
  anOrderLine,
  describeFactoryReportRepositoryContract,
  describeImportBatchRepositoryContract,
  describeItemRepositoryContract,
  describePartyRepositoryContract,
  describePurchaseOrderRepositoryContract,
} from '../../packages/testkit/src/index.js';

let handle: AppHandle;

beforeAll(async () => {
  handle = await createDb({ driver: 'pglite' });
  await migrate(handle.exec);
});

afterAll(async () => {
  await handle.close();
});

beforeEach(async () => {
  await handle.exec('truncate table parties, items, purchase_orders, order_lines, factory_stock_rows, factory_shipment_rows, factory_in_transit_rows, factory_material_demand_rows, import_batches, import_rows, products, weekly_reports restart identity cascade');
});

describePartyRepositoryContract(() => partyRepository(handle.db));
describeItemRepositoryContract(() => itemRepository(handle.db));
describePurchaseOrderRepositoryContract(() => purchaseOrderRepository(handle.db));
describeFactoryReportRepositoryContract(() => factoryReportRepository(handle.db));
describeImportBatchRepositoryContract(() => importBatchRepository(handle.db));

it('导入批次仓储保留 partial coverage', async () => {
  const repo = importBatchRepository(handle.db);
  const batch: ImportBatch = {
    id: entityId('partial-coverage-pg'),
    createdAt: '2026-10-12T00:00:00.000Z',
    updatedAt: '2026-10-12T00:00:00.000Z',
    fileId: entityId('partial-file'),
    template: 'po-master-v1',
    factoryPartyId: entityId('partial-factory'),
    status: 'parsed',
    coverage: 'partial',
    fileMeta: {},
    stats: {},
    decisions: {},
    createdBy: entityId('partial-user'),
    committedBy: null,
    committedAt: null,
    rolledBackBy: null,
    rolledBackAt: null,
    error: null,
  };
  await repo.save(batch);
  expect(await repo.get(batch.id)).toEqual(batch);
});

it('同一工厂来源只能有一个未退休快照', async () => {
  const repo = importBatchRepository(handle.db);
  const base: ImportBatch = {
    id: entityId('snapshot-a'), createdAt: '2026-10-12T00:00:00.000Z', updatedAt: '2026-10-12T00:00:00.000Z', fileId: entityId('snapshot-file-a'), template: 'factory-progress-v1', factoryPartyId: entityId('factory-1'), status: 'committed', sourceKey: 'factory-progress-v1:factory-1', sourceFingerprint: 'snapshot-file-a', effectiveAt: '2026-10-12T00:00:00.000Z', supersededAt: null, committedBy: entityId('user-1'), committedAt: '2026-10-12T00:00:00.000Z', fileMeta: {}, stats: {}, decisions: {}, createdBy: entityId('user-1'), rolledBackBy: null, rolledBackAt: null, error: null,
  };
  await repo.save(base);
  await expect(repo.save({ ...base, id: entityId('snapshot-b'), fileId: entityId('snapshot-file-b'), sourceFingerprint: 'snapshot-file-b' })).rejects.toThrow();
  await repo.save({ ...base, id: entityId('snapshot-b'), fileId: entityId('snapshot-file-b'), sourceFingerprint: 'snapshot-file-b', supersededAt: '2026-10-13T00:00:00.000Z' });
});

it('同一快照内相同业务指纹 upsert 而不是增加行', async () => {
  const repo = factoryReportRepository(handle.db);
  const first = shipment(1);
  await repo.save(first);
  await repo.save({ ...first, id: entityId('ship-replay'), raw: { replay: true } });
  const result = await handle.exec("select count(*)::int as total from factory_shipment_rows where import_batch_id = 'import-1' and fingerprint = 'fp-1'");
  expect(rowsOf(result)[0]?.total).toBe(1);
});

it('在途事实能写回，并按编码找到', async () => {
  const repo = factoryReportRepository(handle.db);
  await repo.save({
    id: entityId('transit-1'),
    importBatchId: entityId('import-1'),
    factoryPartyId: entityId('factory-1'),
    sheetName: '在途订单汇总',
    rowNo: 2,
    raw: {},
    fingerprint: 'fp-transit',
    linkedOrderLineId: null,
    linkStatus: 'unlinked',
    linkReason: null,
    kind: 'in_transit',
    shipment: null,
    demand: null,
    inTransit: { poRaw: 'PO1', poNorm: 'PO1', nameRaw: '面膜', itemCodeRaw: '70007022', barcodeRaw: '2000000003023', qtyRequired: 10 },
  });
  const loaded = await repo.get('transit-1');
  expect(loaded.kind).toBe('in_transit');
  expect(loaded.inTransit).toMatchObject({ poNorm: 'PO1', itemCodeRaw: '70007022', qtyRequired: 10 });
  expect((await repo.listByCodeNorm('70007022')).map((row) => row.id)).toEqual(['transit-1']);
});

it('需求生成只从生成时读到的同一数据库行版本核对原文', async () => {
  const repo = factoryReportRepository(handle.db);
  await handle.exec(`insert into import_batches (id,created_at,updated_at,file_id,template,factory_party_id,status,file_meta,stats,decisions,created_by)
    values ('import-1',now(),now(),'source-file','factory-progress-v1','factory-1','committed','{}','{}','{}','tester')`);
  const slot = { index: 0, date: localDate('2026-11-24'), qty: 50 };
  const row: FactoryReportRow = {
    ...shipment(1), id: entityId('demand-version'), kind: 'demand', shipment: null,
    sheetName: '11月排产包材原料需求表', raw: { slots: [{ ...slot, dateRaw: '2026/11/24', qtyRaw: '050.00' }] },
    demand: { role: 'material', slots: [slot], blockMaterialPoRaw: null, poNorm: null, itemCodeRaw: '30037001', nameRaw: '合成包材' },
  };
  await repo.save(row);
  const selected = await repo.getForDemandGeneration(row.id);
  const forLine = { rowId: row.id, orderLineId: orderLineId('line-1') };
  await orderLineRepository(handle.db).save(anOrderLine({ id: forLine.orderLineId }));
  if (selected.version === null) throw new Error('需求行缺少数据库版本');
  const input = { ...forLine, version: selected.version };
  expect((await repo.demandSourcesAtGeneration(input)).get(0)?.slot.originalCells).toEqual({ dateRaw: '2026/11/24', qtyRaw: '050.00' });
  await handle.exec("update factory_material_demand_rows set link_reason = link_reason where id = 'demand-version'");
  expect(await repo.demandSourcesAtGeneration(input)).toEqual(new Map());
});

it('批量写入 7339 行出货在 10 秒内完成', async () => {
  const rows = Array.from({ length: 7339 }, (_, index) => shipment(index));
  const started = Date.now();
  await insertFactoryShipments(handle.db, rows);
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(await factoryReportRepository(handle.db).find(rows[0]?.id ?? '')).toBeDefined();
});

function shipment(index: number): FactoryReportRow {
  return {
    id: entityId(`ship-${index}`),
    importBatchId: entityId('import-1'),
    factoryPartyId: entityId('factory-1'),
    sheetName: '成品出货明细',
    rowNo: index + 2,
    raw: {},
    fingerprint: `fp-${index}`,
    linkedOrderLineId: null,
    linkStatus: 'unlinked',
    linkReason: null,
    kind: 'shipment',
    shipment: null,
    demand: null,
    inTransit: null,
  };
}

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return rowsOf(result[0]);
  if (typeof result !== 'object' || result === null || !('rows' in result) || !Array.isArray(result.rows)) return [];
  return result.rows.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null);
}
