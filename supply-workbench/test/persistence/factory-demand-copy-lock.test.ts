import '../application/load-import-registry.js';

import { expect, it } from 'vitest';
import { makeCommitImport } from '../../packages/application/src/imports/index.js';
import { makeLinkFactoryRow } from '../../packages/application/src/master-data/index.js';
import { entityId, factorySourceKey, orderLineId } from '../../packages/domain/src/index.js';
import type { AppDatabase } from '../../packages/persistence/src/client.js';
import { factoryReportRepository } from '../../packages/persistence/src/repositories/factory-reports.js';
import { importBatchRepository } from '../../packages/persistence/src/repositories/import-batches.js';
import { orderLineRepository } from '../../packages/persistence/src/repositories/order-lines.js';
import { aFactoryStockRow, anOrderLine } from '../../packages/testkit/src/index.js';
import { blockedOnPostgres, gate, seedLine, slot, url, wait, withFixture, writes, type Sample } from './factory-demand-generation-fixture.js';

it.skipIf(url === undefined)('快照继承需求行前读取已提交的改挂结果', async () => {
  await withFixture(async ({ main, competing, applicationName, sample }) => {
    await seedLine({ db: main.db, sample, id: sample.lineId });
    const target = orderLineId(`${sample.id}-other`);
    await orderLineRepository(main.db).save(anOrderLine({ id: target, purchaseOrderId: sample.orderId, lane: 'material' }));
    const seeded = await seedCarryableDemand(main.db, sample);
    try {
      const moving = gate();
      const publishLocked = gate();
      const move = makeLinkFactoryRow(writes(main.db, { afterDemandSave: moving.hold }));
      const publish = makeCommitImport(writes(competing.db, { afterSnapshotSourceLock: publishLocked.hold }));
      const linking = move({ table: 'demand', rowId: seeded.oldReportId, orderLineId: target }, sample.reviewer);
      await Promise.race([linking, moving.entered]);
      const publication = publish({ importBatchId: seeded.newBatchId }, sample.reviewer);
      void publication.catch(() => undefined);
      try {
        await expect.poll(() => publishLocked.hasEntered() || blockedOnPostgres(main, applicationName), wait).toBe(true);
        expect(publishLocked.hasEntered()).toBe(false);
      } finally {
        moving.release();
        publishLocked.release();
        await Promise.all([linking, publication]);
      }
      const carried = await factoryReportRepository(main.db).get(seeded.newReportId);
      expect(carried.linkedOrderLineId).toBe(target);
      expect((await importBatchRepository(main.db).get(seeded.newBatchId)).status).toBe('committed');
    } finally {
      await main.exec(`
        delete from factory_material_demand_rows where id in ('${seeded.oldReportId}', '${seeded.newReportId}');
        delete from import_rows where import_batch_id in ('${sample.importId}', '${seeded.newBatchId}');
        delete from import_batches where id = '${seeded.newBatchId}';
      `);
    }
  });
}, 15000);

async function seedCarryableDemand(db: AppDatabase, sample: Sample) {
  const imports = importBatchRepository(db);
  const old = await imports.get(sample.importId);
  const sourceKey = factorySourceKey(sample.factoryId);
  await imports.save({ ...old, sourceKey });
  const newBatchId = entityId(`${sample.id}-new-batch`);
  await imports.save({ ...old, id: newBatchId, status: 'parsed', fileId: newBatchId, committedBy: null, committedAt: null, sourceKey });
  const oldRowId = entityId(`${sample.id}-old-import-row`);
  const newRowId = entityId(`${sample.id}-new-import-row`);
  const sheetName = '合成需求';
  const parsed = { fingerprint: sample.id, role: 'material', blockMaterialPoRaw: sample.poRaw, itemCodeRaw: sample.code, slots: [slot] };
  await imports.saveRow({ id: oldRowId, importBatchId: sample.importId, sheetName, rowNo: 1, parsed, raw: {}, issues: [], action: 'create', targetId: null, skipReason: null });
  await imports.saveRow({ id: newRowId, importBatchId: newBatchId, sheetName, rowNo: 1, parsed, raw: {}, issues: [], action: 'unchanged', targetId: null, skipReason: null });
  const oldReportId = entityId(`${oldRowId}:report`);
  const newReportId = entityId(`${newRowId}:report`);
  await factoryReportRepository(db).save(aFactoryStockRow({
    id: oldReportId, importBatchId: sample.importId, factoryPartyId: sample.factoryId, fingerprint: sample.id,
    kind: 'demand', sheetName, rowNo: 1, linkedOrderLineId: sample.lineId, linkStatus: 'manual',
    demand: { role: 'material', blockMaterialPoRaw: sample.poRaw, poNorm: null, itemCodeRaw: sample.code, nameRaw: null, slots: [slot] },
  }));
  return { oldReportId, newReportId, newBatchId };
}
