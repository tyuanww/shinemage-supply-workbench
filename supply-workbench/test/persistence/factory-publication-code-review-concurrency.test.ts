import '../application/load-import-registry.js';

import { expect, it } from 'vitest';
import { makeCommitImport } from '../../packages/application/src/imports/index.js';
import { makeApproveCodeLink, makeRejectCodeLink } from '../../packages/application/src/master-data/index.js';
import { entityId, factorySourceKey } from '../../packages/domain/src/index.js';
import type { AppDatabase } from '../../packages/persistence/src/client.js';
import { factoryReportRepository } from '../../packages/persistence/src/repositories/factory-reports.js';
import { codeLinkRepository, itemCodeRepository } from '../../packages/persistence/src/repositories/identity.js';
import { importBatchRepository } from '../../packages/persistence/src/repositories/import-batches.js';
import { aFactoryStockRow } from '../../packages/testkit/src/index.js';
import { blockedOnPostgres, clock, gate, seedLine, url, wait, withFixture, writes, type Sample } from './factory-demand-generation-fixture.js';

const leftCode = '30000001';
const rightCode = '30000002';

it.skipIf(url === undefined).each(['approved', 'rejected'] as const)('同厂提交快照与审核已有编码对照重叠时，两个操作都能提交（%s）', async (decision) => {
  await withFixture(async ({ main, competing, sample, applicationName }) => {
    await seedLine({ db: main.db, sample, id: sample.lineId });
    const seeded = await seedPublication(main.db, sample);
    try {
      const reviewing = gate();
      const publishing = gate();
      const review = decision === 'approved' ? makeApproveCodeLink : makeRejectCodeLink;
      const decide = review(writes(main.db, { afterCodeLinkSave: reviewing.hold }));
      const publish = makeCommitImport(writes(competing.db, { afterSnapshotSourceLock: publishing.hold }));
      const approval = decide({ linkId: seeded.linkId }, sample.reviewer);
      await Promise.race([approval, reviewing.entered]);
      const publication = publish({ importBatchId: seeded.importBatchId }, sample.reviewer);
      void publication.catch(() => undefined);
      try {
        await expect.poll(() => publishing.hasEntered() || blockedOnPostgres(main, applicationName), wait).toBe(true);
      } finally {
        reviewing.release();
        publishing.release();
        await Promise.all([approval, publication]);
      }
      expect((await codeLinkRepository(main.db).get(seeded.linkId)).status).toBe(decision);
      expect((await importBatchRepository(main.db).get(seeded.importBatchId)).status).toBe('committed');
    } finally {
      await main.exec(`
        delete from code_links where id = '${seeded.linkId}';
        delete from item_codes where id in ('${seeded.leftId}', '${seeded.rightId}');
        delete from factory_in_transit_rows where id = '${seeded.reportId}';
        delete from import_batches where id = '${seeded.importBatchId}';
      `);
    }
  });
}, 15000);

async function seedPublication(db: AppDatabase, sample: Sample) {
  const at = clock.now();
  const leftId = entityId(`${sample.id}-left`);
  const rightId = entityId(`${sample.id}-right`);
  await itemCodeRepository(db).save({ id: leftId, createdAt: at, updatedAt: at, codeType: 'pack_30', codeRaw: leftCode, codeNorm: leftCode, status: 'pending', itemId: null });
  await itemCodeRepository(db).save({ id: rightId, createdAt: at, updatedAt: at, codeType: 'pack_30', codeRaw: rightCode, codeNorm: rightCode, status: 'pending', itemId: null });
  const linkId = entityId(`link:${leftCode}:${rightCode}`);
  await codeLinkRepository(db).save({ id: linkId, createdAt: at, updatedAt: at, fromCodeId: leftId, toCodeId: rightId, status: 'pending', evidence: {}, reviewedBy: null, reviewedAt: null });
  const imports = importBatchRepository(db);
  const old = await imports.get(sample.importId);
  const importBatchId = entityId(`${sample.importId}-publishing-review`);
  await imports.save({ ...old, id: importBatchId, status: 'parsed', fileId: importBatchId, committedBy: null, committedAt: null, sourceKey: factorySourceKey(sample.factoryId),
    fileMeta: { codeLinks: [{ fromCodeRaw: leftCode, toCodeRaw: rightCode, sheetName: '合成编码对照', rowNo: 2 }] },
  });
  const reportId = entityId(`${sample.id}-review-transit`);
  await factoryReportRepository(db).save(aFactoryStockRow({ id: reportId, importBatchId: sample.importId, kind: 'in_transit', fingerprint: reportId,
    factoryPartyId: sample.factoryId, inTransit: { poRaw: sample.poRaw, poNorm: sample.poRaw, itemCodeRaw: leftCode, barcodeRaw: null, nameRaw: '合成包材', qtyRequired: 50 },
  }));
  return { linkId, reportId, leftId, rightId, importBatchId };
}
