import '../application/load-import-registry.js';

import { expect, it } from 'vitest';
import { makeGenerateBatchesFromDemand } from '../../packages/application/src/follow-up/index.js';
import { makeCommitImport } from '../../packages/application/src/imports/index.js';
import { makeLinkFactoryRow } from '../../packages/application/src/master-data/index.js';
import { entityId, factorySourceKey } from '../../packages/domain/src/index.js';
import type { AppDatabase } from '../../packages/persistence/src/client.js';
import { factoryReportRepository } from '../../packages/persistence/src/repositories/factory-reports.js';
import { importBatchRepository } from '../../packages/persistence/src/repositories/import-batches.js';
import { aFactoryStockRow } from '../../packages/testkit/src/index.js';
import { gate, onlyLineDetail, seedLine, seedOtherFactoryReport, slot, url, withFixture, writes, type Sample } from './factory-demand-generation-fixture.js';

it.skipIf(url === undefined)('代工厂快照退休尚未提交时，保留业务批次但不确认受影响订单凭据', async () => {
  await withFixture(async ({ main, competing, sample }) => {
    await seedLine({ db: main.db, sample, id: sample.lineId });
    const { rowId, factory } = await seedOtherFactoryReport(main.db, { sample, kind: 'stock' });
    const linkReport = makeLinkFactoryRow(writes(main.db));
    await linkReport({ table: 'stock', rowId, orderLineId: sample.lineId }, sample.reviewer);
    const { importBatchId, reportId } = await seedPublishingSnapshot(main.db, sample);
    try {
      await linkReport({ table: 'shipment', rowId: reportId, orderLineId: sample.lineId }, sample.reviewer);
      expect((await onlyLineDetail(main.db, sample.code)).line.factory?.id).toBe(sample.factoryId);
      const pending = gate();
      const publish = makeCommitImport(writes(competing.db, { beforeSnapshotTransactionCommit: pending.hold }))({ importBatchId }, sample.reviewer);
      try {
        await Promise.race([publish, pending.entered]);
        const generate = makeGenerateBatchesFromDemand(writes(main.db));
        expect(await generate({ rowIds: [sample.id] }, sample.buyer)).toEqual({ createdLines: 0, createdBatches: 1, skipped: [] });
      } finally {
        pending.release();
        await publish;
      }
      const detail = await onlyLineDetail(main.db, sample.code);
      expect(detail.line.factory?.id).toBe(factory.id);
      expect(detail.batches).toMatchObject([{ plannedQty: slot.qty, dateFactoryRequired: slot.date }]);
      expect(detail.batchDemandSources).toEqual({});
    } finally {
      await main.exec(`delete from factory_shipment_rows where id = '${reportId}'; delete from import_batches where id = '${importBatchId}';`);
    }
  });
}, 15000);

async function seedPublishingSnapshot(db: AppDatabase, sample: Sample) {
  const imports = importBatchRepository(db);
  const old = await imports.get(sample.importId);
  const sourceKey = factorySourceKey(sample.factoryId);
  await imports.save({ ...old, sourceKey });
  const importBatchId = entityId(`${sample.importId}-publishing`);
  await imports.save({ ...old, id: importBatchId, status: 'parsed', fileId: importBatchId, committedBy: null, committedAt: null, sourceKey });
  const reportId = entityId(`${sample.id}-retiring`);
  await factoryReportRepository(db).save(aFactoryStockRow({
    id: reportId, importBatchId: sample.importId, kind: 'shipment', fingerprint: reportId, factoryPartyId: sample.factoryId,
  }));
  return { importBatchId, reportId };
}
