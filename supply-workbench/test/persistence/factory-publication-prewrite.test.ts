import '../application/load-import-registry.js';

import { expect, it } from 'vitest';
import { makeCommitImport } from '../../packages/application/src/imports/index.js';
import { makeApproveCode } from '../../packages/application/src/master-data/index.js';
import { entityId, factorySourceKey } from '../../packages/domain/src/index.js';
import type { AppDatabase } from '../../packages/persistence/src/client.js';
import { itemCodeRepository } from '../../packages/persistence/src/repositories/identity.js';
import { importBatchRepository } from '../../packages/persistence/src/repositories/import-batches.js';
import { FixedClock } from '../../packages/testkit/src/index.js';
import { blockedOnPostgres, gate, url, wait, withFixture, writes, type Sample } from './factory-demand-generation-fixture.js';

const earlier = '2026-11-28T00:00:01.000Z';
const later = '2026-11-28T00:00:02.000Z';
const latest = '2026-11-28T00:00:03.000Z';

it.skipIf(url === undefined)('两份快照的提交和被替代时间反映实际发布顺序', async () => {
  await withFixture(async ({ main, competing, sample, applicationName }) => {
    const first = await stageSnapshot(main.db, { sample, name: 'first', from: '30000093', to: '30000094' });
    const second = await stageSnapshot(main.db, { sample, name: 'second', from: '30000095', to: '30000096' });
    const firstClock = new FixedClock(earlier);
    const paused = gate();
    try {
      const publishFirst = makeCommitImport({ ...writes(main.db, { afterCodeLinkSave: paused.hold }), clock: firstClock });
      const publishSecond = makeCommitImport({ ...writes(competing.db), clock: new FixedClock(later) });
      const publishing = publishFirst({ importBatchId: first.id }, sample.reviewer);
      let overlapping: ReturnType<typeof publishSecond> | undefined;
      try {
        await Promise.race([paused.entered, publishing]);
        overlapping = publishSecond({ importBatchId: second.id }, sample.reviewer);
        const hasPublishedFirst = await finishedBeforeRelease(overlapping, () => blockedOnPostgres(main, applicationName));
        if (hasPublishedFirst) firstClock.set(latest);
      } finally {
        paused.release();
        await Promise.allSettled(overlapping === undefined ? [publishing] : [publishing, overlapping]);
      }
      await Promise.all([publishing, overlapping]);
      const imports = importBatchRepository(main.db);
      const snapshots = await Promise.all([imports.get(first.id), imports.get(second.id)]);
      const retired = snapshots.find((entry) => entry.supersededAt != null);
      const active = snapshots.find((entry) => entry.supersededAt == null);
      expect(retired?.supersededAt).toBe(active?.committedAt);
      expect(retired?.supersededAt).toBe(later === retired?.committedAt ? latest : later);
    } finally {
      await clearDrafts(main.exec, { drafts: [first, second], codes: ['30000093', '30000094', '30000095', '30000096'] });
    }
  });
}, 15000);

it.skipIf(url === undefined)('发布在查找待建编码之后恢复时保留同期完成的物料审核', async () => {
  await withFixture(async ({ main, competing, sample, applicationName }) => {
    const from = '30000093';
    const to = '30000094';
    const itemName = `测试已审核物料-${sample.id}`;
    const first = await stageSnapshot(main.db, { sample, name: 'first', from, to });
    const second = await stageSnapshot(main.db, { sample, name: 'second', from, to });
    const codeId = entityId(`code:pack_30:${from}`);
    const paused = gate();
    try {
      const publish = makeCommitImport(writes(main.db, { afterItemCodeRead: async (code) => { if (code === from) await paused.hold(); } }));
      const publishing = publish({ importBatchId: first.id }, sample.reviewer);
      let overlapping: ReturnType<typeof publish> | undefined;
      const approve = () => makeApproveCode(writes(competing.db))(
        { codeId, createItem: { displayName: itemName, kind: 'unknown' } }, sample.reviewer,
      );
      try {
        await Promise.race([paused.entered, publishing]);
        overlapping = makeCommitImport(writes(competing.db))({ importBatchId: second.id }, sample.reviewer);
        const hasPublishedFirst = await finishedBeforeRelease(overlapping, () => blockedOnPostgres(main, applicationName));
        if (hasPublishedFirst) await approve();
      } finally {
        const isAlreadyApproved = (await itemCodeRepository(main.db).find(codeId))?.status === 'approved';
        paused.release();
        await Promise.allSettled(overlapping === undefined ? [publishing] : [publishing, overlapping]);
        if (overlapping !== undefined && !isAlreadyApproved) await approve();
      }
      await Promise.all([publishing, overlapping]);
      expect(await itemCodeRepository(main.db).get(codeId)).toMatchObject({ status: 'approved', itemId: expect.any(String) });
    } finally {
      await clearDrafts(main.exec, { drafts: [first, second], codes: [from, to] });
      await main.exec(`delete from items where display_name = '${itemName}'`);
    }
  });
}, 15000);

async function finishedBeforeRelease(result: Promise<unknown>, isBlocked: () => Promise<boolean>): Promise<boolean> {
  return Promise.race([
    result.then(() => true),
    expect.poll(isBlocked, wait).toBe(true).then(() => false),
  ]);
}

async function stageSnapshot(db: AppDatabase, { sample, name, from, to }: {
  readonly sample: Sample; readonly name: string; readonly from: string; readonly to: string;
}) {
  const imports = importBatchRepository(db);
  const existing = await imports.get(sample.importId);
  const id = entityId(`${sample.id}-${name}-prewrite`);
  const rowId = entityId(`${id}-row`);
  const sheetName = '在途订单汇总';
  await imports.save({
    ...existing, id, fileId: id, status: 'parsed', committedAt: null, committedBy: null,
    sourceKey: factorySourceKey(sample.factoryId),
    fileMeta: { codeLinks: [{ fromCodeRaw: from, toCodeRaw: to, sheetName: '编码对照', rowNo: 2 }] },
  });
  const parsed = { po: { value: { poRaw: sample.poRaw, poNorm: sample.poRaw } }, itemCodeRaw: { value: from }, qtyRequired: { value: 50 } };
  await imports.saveRow({ id: rowId, importBatchId: id, sheetName, rowNo: 2, raw: {}, parsed, issues: [], action: 'create', targetId: null, skipReason: null });
  return { id, reportId: entityId(`${rowId}:report`), linkId: entityId(`link:${from}:${to}`) };
}

async function clearDrafts(exec: (query: string) => Promise<unknown>, { drafts, codes }: {
  readonly drafts: readonly Awaited<ReturnType<typeof stageSnapshot>>[]; readonly codes: readonly string[];
}): Promise<void> {
  for (const draft of drafts) {
    await exec(`delete from factory_in_transit_rows where id = '${draft.reportId}';
      delete from import_rows where import_batch_id = '${draft.id}';
      delete from import_batches where id = '${draft.id}';
      delete from code_links where id = '${draft.linkId}';`);
  }
  for (const code of codes) await exec(`delete from item_codes where id = 'code:pack_30:${code}'`);
}
