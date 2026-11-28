import '../application/load-import-registry.js';

import { expect, it } from 'vitest';
import { composeMasterData } from '../../apps/server/src/composition/master-data.js';
import { makeCommitImport } from '../../packages/application/src/imports/index.js';
import { makeBulkCreateItems } from '../../packages/application/src/master-data/index.js';
import type { PoMasterPayload } from '../../packages/application/src/ports/parsed-rows.js';
import { entityId, orderLineId, parsePoCell, type ImportBatch, type ItemCode } from '../../packages/domain/src/index.js';
import {
  auditRepository, createUnitOfWork, deliveryBatchRepository, importBatchRepository, itemCodeRepository, itemRepository, orderLineRepository,
  placeholderStores, procurementRepository, purchaseOrderRepository, requireDatabase, type AppDatabase, type AppHandle,
} from '../../packages/persistence/src/index.js';
import { anOrderLine, aPurchaseOrder } from '../../packages/testkit/src/index.js';
import { blockedOnPostgres, clock, gate, settled, url, wait, withFixture, writes, type Sample } from './factory-demand-generation-fixture.js';

const at = clock.now();

it.skipIf(url === undefined).each(['换码', '逆序两行'] as const)('采购总表与批量建物料同时进行时按提交顺序使用最新条码（%s）', async (flow) => {
  await withFixture(async ({ main, competing, sample, applicationName }) => {
    const isReverse = flow === '逆序两行';
    const seed = await poSample(main.db, { sample, isReverse });
    const importPaused = gate();
    const importer = makeCommitImport({ clock, uow: procurementImport(main.db, { paused: importPaused, high: seed.high }) });
    const bulk = composeMasterData({ db: competing.db, clock, timeZone: 'Asia/Shanghai' });
    const publishing = settled(importer({ importBatchId: seed.batchId }, sample.buyer));
    let review: ReturnType<typeof bulk.bulkCreate> | undefined;
    try {
      await Promise.race([importPaused.entered, publishing.result]);
      review = settled(bulk.bulkCreate({ codeIds: [seed.second.id, seed.first.id] }, sample.reviewer)).result;
      await expect.poll(() => blockedOnPostgres(main, applicationName), wait).toBe(true);
    } finally {
      importPaused.release();
      const results = await Promise.allSettled(review === undefined ? [publishing.result] : [publishing.result, review]);
      try {
        expect(results).toEqual([{ status: 'fulfilled', value: { importBatchId: seed.batchId } }, { status: 'fulfilled', value: { created: 2 } }]);
        const codes = itemCodeRepository(main.db);
        const lines = orderLineRepository(main.db);
        const approvedB = await codes.get(seed.second.id);
        expect(approvedB.itemId).not.toBeNull();
        expect(await lines.get(seed.high)).toMatchObject({ barcodeRaw: seed.second.codeRaw, nameRaw: '采购表新名称', itemId: approvedB.itemId });
        if (isReverse) {
          const approvedA = await codes.get(seed.first.id);
          expect(approvedA.itemId).not.toBeNull();
          expect(await lines.get(seed.low)).toMatchObject({ barcodeRaw: seed.first.codeRaw, itemId: approvedA.itemId });
        }
      } finally {
        await cleanPoSample(main, seed);
      }
    }
  });
}, 20000);

it.skipIf(url === undefined)('批量建物料不能使用拿锁之后由工厂导入新增的编码', async () => {
  await withFixture(async ({ main, competing, sample }) => {
    const batchId = entityId(sample.importId + '-new-codes');
    const codes = ['30001371', '30001372'];
    const fromId = entityId('code:pack_30:' + codes[0]);
    const toId = entityId('code:pack_30:' + codes[1]);
    const imports = importBatchRepository(main.db);
    const codeRepo = itemCodeRepository(main.db);
    await imports.save({
      ...parsedBatch(await imports.get(sample.importId), { id: batchId, template: 'factory-progress-v1' }),
      fileMeta: { codeLinks: [{ fromCodeRaw: codes[0], toCodeRaw: codes[1], sheetName: '合成编码对照', rowNo: 2 }] },
    });
    const paused = gate();
    const bulk = makeBulkCreateItems({
      ...writes(competing.db),
      uow: createUnitOfWork(competing.db, (transaction) => {
        const db = requireDatabase(transaction);
        const itemCodes = itemCodeRepository(db);
        return {
          ...placeholderStores(), audit: auditRepository(db), items: itemRepository(db), orderLines: orderLineRepository(db),
          procurement: procurementRepository(db),
          itemCodes: { ...itemCodes, async lockMany(ids) {
            const locked = await itemCodes.lockMany(ids);
            await paused.hold();
            return locked;
          } },
        };
      }),
    });
    const reviewing = settled(bulk({ codeIds: [fromId] }, sample.reviewer));
    try {
      await Promise.race([paused.entered, reviewing.result]);
      expect(await codeRepo.find(fromId)).toBeUndefined();
      const receipt = await makeCommitImport(writes(main.db))({ importBatchId: batchId }, sample.reviewer);
      expect(receipt).toEqual({ importBatchId: batchId });
      expect(await codeRepo.get(fromId)).toMatchObject({ status: 'pending', itemId: null });
      paused.release();
      await expect(reviewing.result).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await codeRepo.get(fromId)).toMatchObject({ status: 'pending', itemId: null });
      const retry = composeMasterData({ db: main.db, clock, timeZone: 'Asia/Shanghai' });
      expect(await retry.bulkCreate({ codeIds: [fromId, fromId] }, sample.reviewer)).toEqual({ created: 1 });
    } finally {
      paused.release();
      await Promise.allSettled([reviewing.result]);
      const itemId = (await codeRepo.find(fromId))?.itemId;
      await main.exec(`
        delete from code_links where from_code_id = '${fromId}';
        delete from item_codes where id in ('${fromId}', '${toId}');
        delete from import_batches where id = '${batchId}';
        ${itemId == null ? '' : `delete from items where id = '${itemId}';`}
      `);
    }
  });
}, 20000);

function procurementImport(db: AppDatabase, { paused, high }: { readonly paused: ReturnType<typeof gate>; readonly high: string }) {
  return createUnitOfWork(db, (transaction) => {
    const tx = requireDatabase(transaction);
    const lines = orderLineRepository(tx);
    const imports = importBatchRepository(tx);
    return {
      ...placeholderStores(), audit: auditRepository(tx), batches: deliveryBatchRepository(tx), procurement: procurementRepository(tx),
      imports: { ...imports, async listRows(id) { return (await imports.listRows(id)).slice().sort((a, b) => a.rowNo - b.rowNo); } },
      orderLines: { ...lines, async save(line) {
        await lines.save(line);
        if (line.id === high && !paused.hasEntered()) await paused.hold();
      } },
      purchaseOrders: purchaseOrderRepository(tx),
    };
  });
}

async function poSample(db: AppDatabase, { sample, isReverse }: { readonly sample: Sample; readonly isReverse: boolean }) {
  const first = code(sample.id + '-code-first', sample.code + '-A');
  const second = code(sample.id + '-code-second', sample.code + '-B');
  const codeRepo = itemCodeRepository(db);
  await codeRepo.save(first);
  await codeRepo.save(second);
  const po = parsePoCell(sample.poRaw);
  await purchaseOrderRepository(db).save(aPurchaseOrder({
    id: sample.orderId, lane: 'finished', poRaw: sample.poRaw, poNorm: po.value.poNorm, poFormat: po.value.poFormat,
  }));
  const high = orderLineId(sample.id + '-z');
  const low = orderLineId(sample.id + '-a');
  const lines = orderLineRepository(db);
  await lines.save(anOrderLine({ id: high, purchaseOrderId: sample.orderId, lane: 'finished', itemCodeRaw: null,
    barcodeRaw: isReverse ? second.codeRaw : first.codeRaw, nameRaw: '采购表旧名称' }));
  if (isReverse) await lines.save(anOrderLine({
    id: low, purchaseOrderId: sample.orderId, lane: 'finished', itemCodeRaw: null, barcodeRaw: first.codeRaw, nameRaw: '第二个旧名称',
  }));
  const imports = importBatchRepository(db);
  const batchId = entityId(sample.importId + '-po-bulk');
  await imports.save(parsedBatch(await imports.get(sample.importId), { id: batchId, template: 'po-master-v1' }));
  const rows = [{ id: high, barcode: second.codeRaw, name: '采购表新名称' },
    ...(isReverse ? [{ id: low, barcode: first.codeRaw, name: '第二个新名称' }] : [])];
  for (const [index, row] of rows.entries()) {
    await imports.saveRow({
      id: entityId(batchId + ':' + index), importBatchId: batchId, sheetName: '采购订单总表', rowNo: index + 2,
      raw: {}, parsed: poPayload(po, row), issues: [], action: 'update', targetId: row.id, skipReason: null,
    });
  }
  return { high, low, batchId, first, second };
}

async function cleanPoSample(handle: AppHandle, sample: Awaited<ReturnType<typeof poSample>>) {
  const codes = itemCodeRepository(handle.db);
  const items = [(await codes.get(sample.first.id)).itemId, (await codes.get(sample.second.id)).itemId];
  await handle.exec(`
    delete from order_line_snapshots where order_line_id in ('${sample.low}', '${sample.high}');
    delete from order_lines where id in ('${sample.low}', '${sample.high}');
    delete from import_rows where import_batch_id = '${sample.batchId}';
    delete from import_batches where id = '${sample.batchId}';
    delete from item_codes where id in ('${sample.first.id}', '${sample.second.id}');
    ${items.flatMap((id) => id === null ? [] : [`delete from items where id = '${id}';`]).join(' ')}
  `);
}

function code(id: string, raw: string): ItemCode {
  return { id: entityId(id), codeType: 'barcode_69', codeRaw: raw, codeNorm: raw, status: 'pending', itemId: null,
    createdAt: at, updatedAt: at };
}

function parsedBatch(base: ImportBatch, { id, template }: { readonly id: ImportBatch['id']; readonly template: 'factory-progress-v1' | 'po-master-v1' }): ImportBatch {
  return { ...base, id, fileId: id, template, status: 'parsed', committedAt: null, committedBy: null };
}

function poPayload(po: ReturnType<typeof parsePoCell>, { barcode, name }: { readonly barcode: string; readonly name: string }): PoMasterPayload {
  const empty = { raw: null, value: null };
  const value = <T extends string | number>(item: T) => ({ raw: String(item), value: item });
  return { po: { raw: po.raw, value: { ...po.value, poRaw: po.raw } }, nameRaw: value(name), barcodeRaw: value(barcode), qtyOrdered: value(10), oaDemandRef: empty, supplierRaw: empty,
    oaSubmittedOn: empty, oaRequiredOn: empty, plannedDurationDays: empty, actualStartOn: empty, firstDeliveryOn: empty,
    actualEndOn: empty, actualDurationDays: empty, factoryStockReported: empty, shippedQtyReported: empty, qtyDiffReported: empty, statusReported: empty };
}
