import '../application/load-import-registry.js';

import { expect, it } from 'vitest';
import { makeRelinkFactoryRows } from '../../packages/application/src/factory-links/index.js';
import { makeCommitImport } from '../../packages/application/src/imports/index.js';
import { makeApproveCodeLink, makeLinkFactoryRow } from '../../packages/application/src/master-data/index.js';
import { entityId, factorySourceKey, orderLineId } from '../../packages/domain/src/index.js';
import type { AppDatabase } from '../../packages/persistence/src/client.js';
import { factoryLinkQueries } from '../../packages/persistence/src/queries/factory-links/index.js';
import { factoryReportRepository } from '../../packages/persistence/src/repositories/factory-reports.js';
import { codeLinkRepository, itemCodeRepository } from '../../packages/persistence/src/repositories/identity.js';
import { importBatchRepository } from '../../packages/persistence/src/repositories/import-batches.js';
import { orderLineRepository } from '../../packages/persistence/src/repositories/order-lines.js';
import { aFactoryStockRow, anOrderLine } from '../../packages/testkit/src/index.js';
import { blockedOnPostgres, clock, gate, seedLine, url, wait, withFixture, writes, type Sample } from './factory-demand-generation-fixture.js';

const left = '30000091';
const right = '30000092';

it.skipIf(url === undefined)('编码审核保留同期提交的人工在途挂接', async () => {
  await withFixture(async ({ main, competing, sample }) => {
    const codes = await seedReviewedLine(main.db, sample);
    const lineId = orderLineId(`${sample.id}-other`);
    await orderLineRepository(main.db).save(anOrderLine({ id: lineId, purchaseOrderId: sample.orderId, lane: 'material', itemCodeRaw: '另一个合成物料' }));
    const rowId = entityId(`${sample.id}-review-report`);
    await factoryReportRepository(main.db).save(aFactoryStockRow({
      id: rowId, importBatchId: sample.importId, factoryPartyId: sample.factoryId, fingerprint: rowId, kind: 'in_transit',
      inTransit: { poRaw: sample.poRaw, poNorm: sample.poRaw, nameRaw: '合成物料', itemCodeRaw: left, barcodeRaw: null, qtyRequired: 50 },
    }));
    try {
      const paused = gate();
      const approve = makeApproveCodeLink(writes(main.db, { afterCodeLinkSave: paused.hold }));
      const approving = approve({ linkId: codes.linkId }, sample.reviewer);
      try {
        await Promise.race([paused.entered, approving]);
        await makeLinkFactoryRow(writes(competing.db))({ table: 'in-transit', rowId, orderLineId: lineId }, sample.reviewer);
      } finally {
        paused.release();
        await approving;
      }
      expect(await factoryReportRepository(main.db).get(rowId)).toMatchObject({ linkedOrderLineId: lineId, linkStatus: 'manual' });
    } finally {
      await main.exec(`delete from factory_in_transit_rows where id = '${rowId}'; ${cleanupCodes(codes)}`);
    }
  });
}, 15000);

it.skipIf(url === undefined)('等待首次快照写入编码对照后，审核会处理刚发布的在途报告', async () => {
  await withFixture(async ({ main, competing, applicationName, sample }) => {
    const codes = await seedReviewedLine(main.db, sample);
    const incoming = await stageIncomingReport(main.db, sample);
    try {
      const paused = gate();
      const publish = makeCommitImport(writes(main.db, { afterCodeLinkSave: paused.hold }));
      const publishing = publish({ importBatchId: incoming.id }, sample.reviewer);
      let approving: ReturnType<ReturnType<typeof makeApproveCodeLink>> | undefined;
      try {
        await Promise.race([paused.entered, publishing]);
        const approve = makeApproveCodeLink(writes(competing.db));
        approving = approve({ linkId: codes.linkId }, sample.reviewer);
        void approving.catch(() => undefined);
        await expect.poll(() => blockedOnPostgres(main, applicationName), wait).toBe(true);
      } finally {
        paused.release();
        await Promise.allSettled(approving === undefined ? [publishing] : [publishing, approving]);
      }
      expect(await publishing).toEqual({ importBatchId: incoming.id });
      expect(await approving).toEqual({ linkId: codes.linkId });
      expect(await factoryReportRepository(main.db).get(incoming.reportId)).toMatchObject({ linkedOrderLineId: sample.lineId, linkStatus: 'linked' });
    } finally {
      await main.exec(`
        delete from factory_in_transit_rows where id = '${incoming.reportId}';
        delete from import_rows where import_batch_id = '${incoming.id}';
        delete from import_batches where id = '${incoming.id}'; ${cleanupCodes(codes)}
      `);
    }
  });
}, 15000);

it.skipIf(url === undefined)('同期重复快照只保留先发布的编码对照凭据', async () => {
  await withFixture(async ({ main, competing, applicationName, sample }) => {
    const codes = await seedReviewedLine(main.db, sample);
    const incoming = await stageIncomingReport(main.db, sample);
    const imports = importBatchRepository(main.db);
    const duplicateId = entityId(`${incoming.id}-duplicate`);
    await imports.save({ ...await imports.get(incoming.id), id: duplicateId });
    for (const row of await imports.listRows(incoming.id)) {
      await imports.saveRow({ ...row, id: entityId(`${row.id}-duplicate`), importBatchId: duplicateId });
    }
    try {
      const paused = gate();
      const first = makeCommitImport(writes(main.db, { afterCodeLinkSave: paused.hold }));
      const publishing = first({ importBatchId: incoming.id }, sample.reviewer);
      let copying: ReturnType<typeof first> | undefined;
      try {
        await Promise.race([paused.entered, publishing]);
        copying = makeCommitImport(writes(competing.db))({ importBatchId: duplicateId }, sample.reviewer);
        void copying.catch(() => undefined);
        await expect.poll(() => blockedOnPostgres(main, applicationName), wait).toBe(true);
      } finally {
        paused.release();
        await Promise.allSettled(copying === undefined ? [publishing] : [publishing, copying]);
      }
      expect(await publishing).toEqual({ importBatchId: incoming.id });
      expect(await copying).toEqual({ importBatchId: duplicateId });
      expect(await imports.get(incoming.id)).toMatchObject({ status: 'committed' });
      expect(await imports.get(duplicateId)).toMatchObject({ status: 'discarded' });
      expect(await codeLinkRepository(main.db).get(codes.linkId)).toMatchObject({ evidence: { importBatchId: incoming.id } });
    } finally {
      await main.exec(`
        delete from factory_in_transit_rows where id in ('${incoming.reportId}', '${incoming.reportId.replace(':report', '-duplicate:report')}');
        delete from import_rows where import_batch_id in ('${incoming.id}', '${duplicateId}');
        delete from import_batches where id in ('${incoming.id}', '${duplicateId}'); ${cleanupCodes(codes)}
      `);
    }
  });
}, 15000);

it.skipIf(url === undefined).each([true, false])('同工厂两份编码对照排列相反的快照都可提交（已有编码：%s）', async (hasExistingCodes) => {
  await withFixture(async ({ main, competing, applicationName, sample }) => {
    const codes = await seedReviewedLine(main.db, sample);
    const imports = importBatchRepository(main.db);
    const alternateLink = entityId(`link:${right}:${left}`);
    if (hasExistingCodes) {
      const links = codeLinkRepository(main.db);
      await links.save({ ...await links.get(codes.linkId), id: alternateLink, fromCodeId: codes.rightId, toCodeId: codes.leftId });
    } else {
      await main.exec(cleanupCodes(codes));
    }
    const { first, secondId } = await stageReorderedReports(main.db, sample);
    try {
      const leftSaved = gate();
      const rightSaved = gate();
      const hook = hasExistingCodes ? 'afterCodeLinkSave' : 'afterItemCodeInsertAttempt';
      const publish = makeCommitImport(writes(main.db, { [hook]: leftSaved.hold }));
      const publishReordered = makeCommitImport(writes(competing.db, { [hook]: rightSaved.hold }));
      const publishing = publish({ importBatchId: first.id }, sample.reviewer);
      let reordering: ReturnType<typeof publishReordered> | undefined;
      try {
        await Promise.race([leftSaved.entered, publishing]);
        reordering = publishReordered({ importBatchId: secondId }, sample.reviewer);
        void reordering.catch(() => undefined);
        await Promise.race([rightSaved.entered, expect.poll(() => blockedOnPostgres(main, applicationName), wait).toBe(true)]);
      } finally {
        leftSaved.release();
        rightSaved.release();
        await Promise.allSettled(reordering === undefined ? [publishing] : [publishing, reordering]);
      }
      const [firstOutcome, secondOutcome] = await Promise.all([publishing, reordering]);
      expect(firstOutcome).toEqual({ importBatchId: first.id });
      expect(secondOutcome).toEqual({ importBatchId: secondId });
      expect(await imports.get(first.id)).toMatchObject({ status: 'committed' });
      expect(await imports.get(secondId)).toMatchObject({ status: 'committed' });
    } finally {
      await main.exec(`
        delete from factory_in_transit_rows where id in ('${first.reportId}', '${secondId}-row:report');
        delete from import_rows where import_batch_id in ('${first.id}', '${secondId}');
        delete from import_batches where id in ('${first.id}', '${secondId}');
        delete from code_links where id = '${alternateLink}'; ${cleanupCodes(codes)}
        delete from item_codes where id in ('code:pack_30:${left}', 'code:pack_30:${right}');
      `);
    }
  });
}, 15000);

it.skipIf(url === undefined)('不同处理上限的自动重联可以同时提交', async () => {
  await withFixture(async ({ main, competing, applicationName, sample }) => {
    const ids = await seedTwoReportKinds(main.db, sample);
    try {
      const paused = gate();
      const scope = { reports: ids, lines: [sample.lineId, `${sample.id}-other`] };
      const first = makeRelinkFactoryRows({ ...writes(main.db, { afterFactoryLinkSave: paused.hold }), links: scopedQueries(main.db, scope) });
      const second = makeRelinkFactoryRows({ ...writes(competing.db), links: scopedQueries(competing.db, scope) });
      const smaller = first({ limit: 1 }, sample.reviewer);
      let larger: ReturnType<typeof second> | undefined;
      try {
        await Promise.race([paused.entered, smaller]);
        larger = second({ limit: 2 }, sample.reviewer);
        void larger.catch(() => undefined);
        await expect.poll(() => blockedOnPostgres(main, applicationName), wait).toBe(true);
      } finally {
        paused.release();
        await Promise.allSettled(larger === undefined ? [smaller] : [smaller, larger]);
      }
      const [smallOutcome, largeOutcome] = await Promise.all([smaller, larger]);
      expect(smallOutcome).toMatchObject({ factoryRows: 1, factoryLinked: 1, linesLinked: 1 });
      expect(largeOutcome).toMatchObject({ factoryRows: 2, factoryLinked: 2, linesLinked: 2 });
    } finally {
      await main.exec(`
        delete from factory_stock_rows where id = '${ids[0]}';
        delete from factory_in_transit_rows where id = '${ids[1]}';
        delete from line_factory_links where order_line_id = '${sample.id}-other';
      `);
    }
  });
}, 15000);

function scopedQueries(db: AppDatabase, { reports, lines }: { readonly reports: readonly string[]; readonly lines: readonly string[] }) {
  const queries = factoryLinkQueries(db);
  return {
    ...queries,
    async listOrderLineRefs() {
      return (await queries.listOrderLineRefs()).filter((line) => lines.includes(line.orderLineId));
    },
    async listFactoryRowRefs() {
      return (await queries.listFactoryRowRefs()).filter((row) => reports.includes(row.rowId));
    },
  };
}

async function seedReviewedLine(db: AppDatabase, sample: Sample) {
  await seedLine({ db, sample, id: sample.lineId });
  const orders = orderLineRepository(db);
  await orders.save({ ...await orders.get(sample.lineId), itemCodeRaw: right });
  const at = clock.now();
  const leftId = entityId(`${sample.id}-review-left`);
  const rightId = entityId(`${sample.id}-review-right`);
  await itemCodeRepository(db).save({ id: leftId, createdAt: at, updatedAt: at, codeType: 'pack_30', codeRaw: left, codeNorm: left, status: 'pending', itemId: null });
  await itemCodeRepository(db).save({ id: rightId, createdAt: at, updatedAt: at, codeType: 'pack_30', codeRaw: right, codeNorm: right, status: 'pending', itemId: null });
  const linkId = entityId(`link:${left}:${right}`);
  await codeLinkRepository(db).save({ id: linkId, createdAt: at, updatedAt: at, fromCodeId: leftId, toCodeId: rightId, status: 'pending', evidence: {}, reviewedBy: null, reviewedAt: null });
  return { leftId, rightId, linkId };
}

function cleanupCodes({ leftId, rightId, linkId }: Awaited<ReturnType<typeof seedReviewedLine>>): string {
  return `delete from code_links where id = '${linkId}'; delete from item_codes where id in ('${leftId}','${rightId}');`;
}

async function stageIncomingReport(db: AppDatabase, sample: Sample) {
  const imports = importBatchRepository(db);
  const existing = await imports.get(sample.importId);
  const id = entityId(`${sample.id}-first-matching-snapshot`);
  const importRowId = entityId(`${id}-row`);
  const sheetName = '在途订单汇总';
  await imports.save({ ...existing, id, fileId: id, status: 'parsed', committedAt: null, committedBy: null, sourceKey: factorySourceKey(sample.factoryId),
    fileMeta: { codeLinks: [{ fromCodeRaw: left, toCodeRaw: right, sheetName, rowNo: 2 }] },
  });
  const parsed = { po: { value: { poRaw: sample.poRaw, poNorm: sample.poRaw } }, itemCodeRaw: { value: left }, qtyRequired: { value: 50 } };
  await imports.saveRow({ id: importRowId, importBatchId: id, sheetName, rowNo: 2, raw: {}, parsed, issues: [], action: 'create', targetId: null, skipReason: null });
  return { id, reportId: entityId(`${importRowId}:report`) };
}

async function stageReorderedReports(db: AppDatabase, sample: Sample) {
  const first = await stageIncomingReport(db, sample);
  const imports = importBatchRepository(db);
  const secondId = entityId(`${first.id}-reordered`);
  const original = await imports.get(first.id);
  const pairs = [
    { fromCodeRaw: left, toCodeRaw: right, sheetName: '编码对照', rowNo: 2 },
    { fromCodeRaw: right, toCodeRaw: left, sheetName: '编码对照', rowNo: 3 },
  ];
  await imports.save({ ...original, fileMeta: { codeLinks: pairs } });
  await imports.save({ ...original, id: secondId, fileId: secondId, fileMeta: { codeLinks: [...pairs].reverse() } });
  for (const row of await imports.listRows(first.id)) {
    await imports.saveRow({ ...row, id: entityId(`${secondId}-row`), importBatchId: secondId });
  }
  return { first, secondId };
}

async function seedTwoReportKinds(db: AppDatabase, sample: Sample) {
  await seedLine({ db, sample, id: sample.lineId });
  const other = `${sample.code}-other`;
  await orderLineRepository(db).save(anOrderLine({ id: orderLineId(`${sample.id}-other`), purchaseOrderId: sample.orderId, lane: 'material', itemCodeRaw: other }));
  const reports = factoryReportRepository(db);
  const stockId = entityId(`0-${sample.id}-limited-stock`);
  const transitId = entityId(`1-${sample.id}-limited-transit`);
  const common = { importBatchId: sample.importId, factoryPartyId: sample.factoryId };
  await reports.save(aFactoryStockRow({ ...common, id: stockId, fingerprint: stockId, kind: 'stock', raw: { itemCodeRaw: sample.code } }));
  await reports.save(aFactoryStockRow({ ...common, id: transitId, fingerprint: transitId, kind: 'in_transit',
    inTransit: { poRaw: null, poNorm: null, nameRaw: '其他合成物料', itemCodeRaw: other, barcodeRaw: null, qtyRequired: 50 },
  }));
  await db.execute(`update factory_stock_rows set item_code_raw = '${sample.code}' where id = '${stockId}'`);
  return [stockId, transitId] as const;
}
