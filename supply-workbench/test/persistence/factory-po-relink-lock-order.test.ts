import '../application/load-import-registry.js';

import { expect, it } from 'vitest';
import { makeRelinkFactoryRows } from '../../packages/application/src/factory-links/index.js';
import { makeCommitImport } from '../../packages/application/src/imports/index.js';
import { linkIdOf, linkOf } from '../../packages/application/src/shared/factory-link.js';
import { entityId, orderLineId, parsePoCell } from '../../packages/domain/src/index.js';
import { REQUIRED_COLUMNS } from '../../packages/importers/src/templates/po-master-v1/columns.js';
import { template } from '../../packages/importers/src/templates/po-master-v1/index.js';
import { readCsv } from '../../packages/importers/src/workbook/index.js';
import type { AppDatabase } from '../../packages/persistence/src/client.js';
import { factoryLinkQueries } from '../../packages/persistence/src/queries/factory-links/index.js';
import { factoryReportRepository } from '../../packages/persistence/src/repositories/factory-reports.js';
import { importBatchRepository } from '../../packages/persistence/src/repositories/import-batches.js';
import { lineFactoryLinkRepository } from '../../packages/persistence/src/repositories/line-factory-links.js';
import { orderLineRepository } from '../../packages/persistence/src/repositories/order-lines.js';
import { partyRepository } from '../../packages/persistence/src/repositories/parties.js';
import { purchaseOrderRepository } from '../../packages/persistence/src/repositories/purchase-orders.js';
import { aFactoryStockRow, anOrderLine, aParty, aPurchaseOrder } from '../../packages/testkit/src/index.js';
import { blockedOnPostgres, clock, gate, url, wait, withFixture, writes, type Sample } from './factory-demand-generation-fixture.js';

it.skipIf(url === undefined)('PO总表按反序更新工厂列时和自动重联都能提交', async () => {
  await withFixture(async ({ main, competing, sample, applicationName }) => {
    const seeded = await seedFinished(main.db, sample);
    const report = entityId(`${sample.id}-po-relink-report`);
    await factoryReportRepository(main.db).save(aFactoryStockRow({
      id: report, importBatchId: sample.importId, factoryPartyId: sample.factoryId, fingerprint: report, kind: 'stock',
    }));
    await main.exec(`update factory_stock_rows set item_code_raw = '${seeded.codeB}' where id = '${report}'`);
    const imported = await stagePoUpdate(main.db, { sample, seeded });
    try {
      const paused = gate();
      const commit = makeCommitImport(writes(main.db, { afterFactoryLinkSave: paused.hold }));
      const committing = commit({ importBatchId: imported }, sample.reviewer);
      const relink = makeRelinkFactoryRows({ ...writes(competing.db), links: scopedQueries(competing.db, { report, lines: [seeded.a, seeded.b] }) });
      let matching: ReturnType<typeof relink> | undefined;
      try {
        await Promise.race([paused.entered, committing]);
        matching = relink({}, sample.reviewer);
        void matching.catch(() => undefined);
        await expect.poll(() => blockedOnPostgres(main, applicationName), wait).toBe(true);
      } finally {
        paused.release();
        await Promise.allSettled(matching === undefined ? [committing] : [committing, matching]);
      }
      expect(await committing).toEqual({ importBatchId: imported });
      expect(await matching).toMatchObject({ factoryRows: 1, factoryLinked: 1, linesLinked: 1 });
    } finally {
      await main.exec(`delete from factory_stock_rows where id = '${report}';
        delete from line_factory_links where order_line_id in ('${seeded.a}', '${seeded.b}');
        delete from order_line_snapshots where order_line_id in ('${seeded.a}', '${seeded.b}');
        delete from order_lines where id in ('${seeded.a}', '${seeded.b}');
        delete from party_aliases where first_seen_import_batch_id = '${imported}';
        delete from import_rows where import_batch_id = '${imported}';
        delete from import_batches where id = '${imported}';`);
    }
  });
}, 15000);

function scopedQueries(db: AppDatabase, { report, lines }: { readonly report: string; readonly lines: readonly string[] }) {
  const queries = factoryLinkQueries(db);
  return {
    ...queries,
    async listOrderLineRefs() {
      return (await queries.listOrderLineRefs()).filter((row) => lines.includes(row.orderLineId));
    },
    async listFactoryRowRefs() {
      return (await queries.listFactoryRowRefs()).filter((row) => row.rowId === report);
    },
  };
}

async function seedFinished(db: AppDatabase, sample: Sample) {
  const a = orderLineId(`${sample.id}-a`);
  const b = orderLineId(`${sample.id}-b`);
  const codeB = `${sample.code}-b`;
  const label = `合成反序工厂-${sample.id}`;
  const factory = aParty({ id: sample.factoryId, displayName: label, isFactory: true, isSupplier: true });
  await partyRepository(db).save(factory);
  const parsed = parsePoCell(sample.poRaw).value;
  await purchaseOrderRepository(db).save(aPurchaseOrder({ id: sample.orderId, poRaw: sample.poRaw, poNorm: parsed.poNorm, poFormat: parsed.poFormat, lane: 'finished' }));
  const orders = orderLineRepository(db);
  await orders.save(anOrderLine({ id: a, purchaseOrderId: sample.orderId, lane: 'finished', itemCodeRaw: `${sample.code}-a` }));
  await orders.save(anOrderLine({ id: b, purchaseOrderId: sample.orderId, lane: 'finished', itemCodeRaw: codeB }));
  for (const id of [a, b]) {
    await lineFactoryLinkRepository(db).save(linkOf({ id: linkIdOf(id), at: clock.now(), orderLineId: id, factoryPartyId: factory.id,
      status: 'linked', source: 'po_master', confidence: 'column' }));
  }
  return { a, b, codeB, label };
}

async function stagePoUpdate(db: AppDatabase, { sample, seeded }: { readonly sample: Sample; readonly seeded: Awaited<ReturnType<typeof seedFinished>> }) {
  const repo = importBatchRepository(db);
  const initial = await repo.get(sample.importId);
  const id = entityId(`${sample.id}-po-relink-import`);
  await repo.save({ ...initial, id, fileId: id, template: 'po-master-v1', status: 'parsed', factoryPartyId: null, committedAt: null, committedBy: null });
  const headers = [...REQUIRED_COLUMNS, '工厂'];
  const fields: Readonly<Record<string, string>> = {
    供应商: seeded.label, 产品名称: '合成完工', 产品条码: '6900000000036', 订单数量: '10',
    采购订单号: sample.poRaw, 状态: '进行中', 工厂: seeded.label,
  };
  const row = headers.map((header) => fields[header] ?? '').join(',');
  const data = readCsv(new TextEncoder().encode([headers.join(','), row, row.replace('合成完工', '合成完工第二行')].join('\n')), 'po-relink.csv');
  const parsed = template.parse(data, { uploadedAt: clock.now(), factoryPartyId: null });
  expect(parsed.rows).toHaveLength(2);
  for (const [index, input] of parsed.rows.entries()) {
    await repo.saveRow({ id: entityId(`${id}-${index}`), importBatchId: id, sheetName: input.sheetName, rowNo: input.rowNo,
      raw: {}, parsed: input.payload, issues: input.issues, action: 'update', targetId: index === 0 ? seeded.b : seeded.a, skipReason: null });
  }
  return id;
}
