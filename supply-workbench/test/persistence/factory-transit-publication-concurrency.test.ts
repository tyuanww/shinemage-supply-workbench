import '../application/load-import-registry.js';

import { expect, it } from 'vitest';
import { makeCreateLineFromInTransit } from '../../packages/application/src/follow-up/index.js';
import { makeCommitImport } from '../../packages/application/src/imports/index.js';
import { entityId, factorySourceKey } from '../../packages/domain/src/index.js';
import type { AppDatabase } from '../../packages/persistence/src/client.js';
import { factoryReportRepository } from '../../packages/persistence/src/repositories/factory-reports.js';
import { importBatchRepository } from '../../packages/persistence/src/repositories/import-batches.js';
import { orderLineRepository } from '../../packages/persistence/src/repositories/order-lines.js';
import { seed } from '../../packages/persistence/src/seed.js';
import { aFactoryStockRow } from '../../packages/testkit/src/index.js';
import { blockedOnPostgres, gate, settled, url, wait, withFixture, writes, type Sample } from './factory-demand-generation-fixture.js';

it.skipIf(url === undefined)('从在途创建订单与换快照重叠时，成功的领取必须出现在当前快照', async () => {
  await withFixture(async ({ main, competing, applicationName, sample }) => {
    await seed(main.exec);
    const seeded = await stageInheritedTransit(main.db, sample);
    try {
      const paused = gate();
      const publish = makeCommitImport(beforePreviousRead(main.db, { rowId: seeded.oldReportId, paused }));
      const publishing = publish({ importBatchId: seeded.newBatchId }, sample.reviewer);
      let claiming: ReturnType<ReturnType<typeof makeCreateLineFromInTransit>> | undefined;
      try {
        await Promise.race([paused.entered, publishing]);
        const claim = makeCreateLineFromInTransit(writes(competing.db));
        const running = settled(claim({ rowId: seeded.oldReportId }, sample.buyer));
        claiming = running.result;
        await expect.poll(() => running.isDone() || blockedOnPostgres(main, applicationName), wait).toBe(true);
      } finally {
        paused.release();
        await Promise.allSettled(claiming === undefined ? [publishing] : [claiming, publishing]);
      }
      expect(await publishing).toEqual({ importBatchId: seeded.newBatchId });
      const [claim] = await Promise.allSettled([claiming]);
      const current = await factoryReportRepository(main.db).get(seeded.newReportId);
      if (claim.status === 'fulfilled') {
        expect(current.linkedOrderLineId).toBe(claim.value?.lineId);
      } else {
        expect(claim.reason).toMatchObject({ code: 'STATE_CONFLICT' });
        expect(current.linkedOrderLineId).toBeNull();
        expect(await orderLineRepository(main.db).listByCodeNorm(sample.code)).toEqual([]);
      }
    } finally {
      await main.exec(`
        delete from factory_in_transit_rows where id in ('${seeded.oldReportId}','${seeded.newReportId}');
        delete from import_rows where import_batch_id in ('${sample.importId}','${seeded.newBatchId}');
        delete from import_batches where id = '${seeded.newBatchId}';
      `);
    }
  });
}, 15000);

function beforePreviousRead(db: AppDatabase, { rowId, paused }: { readonly rowId: string; readonly paused: ReturnType<typeof gate> }) {
  const deps = writes(db);
  const uow: typeof deps.uow = {
    run: (effect) => deps.uow.run((tx) => effect({
      ...tx,
      factoryReports: {
        ...tx.factoryReports,
        async find(id: string) {
          if (id === rowId) await paused.hold();
          return tx.factoryReports.find(id);
        },
      },
    })),
  };
  return { ...deps, uow };
}

async function stageInheritedTransit(db: AppDatabase, sample: Sample) {
  const imports = importBatchRepository(db);
  const existing = await imports.get(sample.importId);
  const sourceKey = factorySourceKey(sample.factoryId);
  const newBatchId = entityId(`${sample.id}-transit-replacement`);
  await imports.save({ ...existing, sourceKey });
  await imports.save({ ...existing, id: newBatchId, fileId: newBatchId, status: 'parsed', committedAt: null, committedBy: null, sourceKey });
  const sheetName = '在途订单汇总';
  const po = { poRaw: sample.poRaw, poNorm: sample.poRaw };
  const facts = { ...po, itemCodeRaw: sample.code, nameRaw: '合成在途物料', barcodeRaw: null, qtyRequired: 50 };
  const parsed = { fingerprint: sample.id, po: { value: po }, itemCodeRaw: { value: facts.itemCodeRaw }, nameRaw: { value: facts.nameRaw }, qtyRequired: { value: facts.qtyRequired } };
  const base = { sheetName, rowNo: 2, raw: {}, parsed, issues: [], targetId: null, skipReason: null };
  const oldRowId = entityId(`${sample.id}-original-transit`);
  const newRowId = entityId(`${sample.id}-next-transit`);
  await imports.saveRow({ ...base, id: oldRowId, importBatchId: sample.importId, action: 'create' });
  await imports.saveRow({ ...base, id: newRowId, importBatchId: newBatchId, action: 'unchanged' });
  const oldReportId = entityId(`${oldRowId}:report`);
  await factoryReportRepository(db).save(aFactoryStockRow({
    id: oldReportId, importBatchId: sample.importId, factoryPartyId: sample.factoryId, fingerprint: sample.id,
    sheetName, rowNo: 2, kind: 'in_transit', inTransit: facts,
  }));
  return { oldReportId, newReportId: entityId(`${newRowId}:report`), newBatchId };
}
