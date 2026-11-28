import { expect, it } from 'vitest';
import { makeRelinkFactoryRows, makeSetLineFactoryLink } from '../../packages/application/src/factory-links/index.js';
import { makeGenerateBatchesFromDemand } from '../../packages/application/src/follow-up/index.js';
import { makeLinkFactoryRow } from '../../packages/application/src/master-data/index.js';
import { entityId } from '../../packages/domain/src/index.js';
import type { AppDatabase } from '../../packages/persistence/src/client.js';
import { factoryLinkQueries } from '../../packages/persistence/src/queries/factory-links/index.js';
import { factoryReportRepository } from '../../packages/persistence/src/repositories/factory-reports.js';
import { partyRepository } from '../../packages/persistence/src/repositories/parties.js';
import { aFactoryStockRow, aParty } from '../../packages/testkit/src/index.js';
import { blockedOnPostgres, gate, onlyLineDetail, rawCells, seedLine, seedOtherFactoryReport, settled, slot, url, wait, withFixture, writes, type Sample } from './factory-demand-generation-fixture.js';

it.skipIf(url === undefined).each([
  { kind: 'shipment', table: 'shipment' },
  { kind: 'in_transit', table: 'in-transit' },
  { kind: 'stock', table: 'stock' },
] as const)('代工厂手工关联的活动 $kind 上报也能证明订单归属', async ({ kind, table }) => {
  await withFixture(async ({ main, sample }) => {
    await seedLine({ db: main.db, sample, id: sample.lineId });
    const { rowId, factory } = await seedOtherFactoryReport(main.db, { sample, kind });
    await makeLinkFactoryRow(writes(main.db))({ table, rowId, orderLineId: sample.lineId }, sample.reviewer);
    expect((await onlyLineDetail(main.db, sample.code)).line.factory?.id).toBe(factory.id);
    await expectPlanWithoutSource(main.db, sample);
  });
}, 15000);

it.skipIf(url === undefined).each(['insert', 'update', 'report'] as const)('真实 PostgreSQL 归属事务还在写 %s 时仍生成业务批次，原表待核对', async (path) => {
  await withFixture(async ({ main, competing, sample }) => {
    await seedLine({ db: main.db, sample, id: sample.lineId });
    const { rowId, factory } = await seedOtherFactoryReport(main.db, { sample, kind: 'stock' });
    const originalFactory = aParty({ id: sample.factoryId, isFactory: true });
    await partyRepository(main.db).save(originalFactory);
    if (path === 'update') {
      await makeSetLineFactoryLink(writes(main.db))({ orderLineId: sample.lineId, factoryPartyId: originalFactory.id }, sample.reviewer);
    }
    const paused = gate();
    const write = path === 'report'
      ? makeLinkFactoryRow(writes(competing.db, { afterDemandSave: paused.hold }))({
        table: 'stock', rowId, orderLineId: sample.lineId,
      }, sample.reviewer)
      : makeSetLineFactoryLink(writes(competing.db, { afterFactoryLinkSave: paused.hold }))({
        orderLineId: sample.lineId, factoryPartyId: factory.id,
      }, sample.reviewer);
    void write.catch(() => undefined);
    try {
      await expect.poll(paused.hasEntered, wait).toBe(true);
      const generated = settled(expectPlanWithoutSource(main.db, sample));
      try {
        await expect.poll(generated.isDone, wait).toBe(true);
        await generated.result;
      } finally {
        paused.release();
        await Promise.allSettled([generated.result]);
      }
    } finally {
      paused.release();
      await write;
    }
    const after = await onlyLineDetail(main.db, sample.code);
    expect(after.line.factory?.id).toBe(factory.id);
    expect(after.batchDemandSources).toEqual({});
  });
}, 15000);

it.skipIf(url === undefined)('自动批量首挂只让受影响订单的凭据待核对', async () => {
  await withFixture(async ({ main, competing, sample }) => {
    await withFixture(async ({ sample: unaffected }) => {
      await seedLine({ db: main.db, sample, id: sample.lineId });
      await seedLine({ db: main.db, sample: unaffected, id: unaffected.lineId });
      const { rowId, factory } = await seedOtherFactoryReport(main.db, { sample, kind: 'stock' });
      await main.exec(`update factory_stock_rows set item_code_raw = '${sample.code}' where id = '${rowId}'`);
      const paused = gate();
      const relink = makeRelinkFactoryRows({
        ...writes(competing.db, { afterFactoryLinkSave: paused.hold }),
        links: scopedFactoryReports(competing.db, { reports: [rowId], lines: [sample.lineId] }),
      })({ limit: 1 }, sample.reviewer);
      try {
        await Promise.race([relink, paused.entered]);
        await expectPlanWithoutSource(main.db, sample);
        const generate = makeGenerateBatchesFromDemand(writes(main.db));
        expect(await generate({ rowIds: [unaffected.id] }, unaffected.buyer)).toEqual({ createdLines: 0, createdBatches: 1, skipped: [] });
        const detail = await onlyLineDetail(main.db, unaffected.code);
        expect(Object.values(detail.batchDemandSources ?? {})).toMatchObject([{ importBatchId: unaffected.importId, slot: { originalCells: rawCells } }]);
      } finally {
        paused.release();
        await relink;
      }
      const detail = await onlyLineDetail(main.db, sample.code);
      expect(detail.line.factory?.id).toBe(factory.id);
      expect(detail.batchDemandSources).toEqual({});
    });
  });
}, 15000);

it.skipIf(url === undefined)('批量重联会拆掉原归属时，处理前序报告期间原订单已待核对', async () => {
  await withFixture(async ({ main, competing, sample }) => {
    await withFixture(async ({ sample: target }) => {
      await seedLine({ db: main.db, sample, id: sample.lineId });
      await seedLine({ db: main.db, sample: target, id: target.lineId });
      const { rowId: fallback, factory } = await seedOtherFactoryReport(main.db, { sample, kind: 'stock' });
      await makeLinkFactoryRow(writes(main.db))({ table: 'stock', rowId: fallback, orderLineId: sample.lineId }, sample.reviewer);
      const moving = await seedMovingShipment(main.db, { sample, target });
      try {
        const { rowId: first } = await seedOtherFactoryReport(main.db, { sample: target, kind: 'in_transit' });
        await main.exec(`update factory_in_transit_rows set item_code_raw = '${target.code}' where id = '${first}'`);
        expect((await onlyLineDetail(main.db, sample.code)).line.factory?.id).toBe(sample.factoryId);
        const paused = gate();
        const relink = makeRelinkFactoryRows({
          ...writes(competing.db, { afterFactoryLinkSave: paused.hold }),
          links: scopedFactoryReports(competing.db, { reports: [first, moving], lines: [sample.lineId, target.lineId] }),
        })({}, sample.reviewer);
        try {
          await Promise.race([relink, paused.entered]);
          await expectPlanWithoutSource(main.db, sample);
        } finally {
          paused.release();
          await relink;
        }
        expect((await onlyLineDetail(main.db, sample.code)).line.factory?.id).toBe(factory.id);
      } finally {
        await main.exec(`delete from factory_shipment_rows where id = '${moving}'`);
      }
    });
  });
}, 15000);

async function seedMovingShipment(db: AppDatabase, { sample, target }: { readonly sample: Sample; readonly target: Sample }) {
  const id = entityId(`1-${sample.id}-moving-shipment`);
  await factoryReportRepository(db).save(aFactoryStockRow({
    id, importBatchId: sample.importId, factoryPartyId: sample.factoryId, fingerprint: id, kind: 'shipment',
    linkedOrderLineId: sample.lineId, linkStatus: 'linked', raw: { itemCodeRaw: target.code },
  }));
  return id;
}

function scopedFactoryReports(db: AppDatabase, { reports, lines }: { readonly reports: readonly string[]; readonly lines: readonly string[] }) {
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

it.skipIf(url === undefined)('同单生成先确认原表时，之后的改挂不会覆盖历史凭据', async () => {
  await withFixture(async ({ main, competing, applicationName, sample }) => {
    await seedLine({ db: main.db, sample, id: sample.lineId });
    const { factory } = await seedOtherFactoryReport(main.db, { sample, kind: 'stock' });
    const paused = gate();
    const generate = makeGenerateBatchesFromDemand(writes(main.db, { afterSourceFreeze: paused.hold }));
    const generation = generate({ rowIds: [sample.id] }, sample.buyer);
    let assignment: ReturnType<ReturnType<typeof makeSetLineFactoryLink>> | undefined;
    try {
      await Promise.race([generation, paused.entered]);
      assignment = makeSetLineFactoryLink(writes(competing.db))({
        orderLineId: sample.lineId, factoryPartyId: factory.id,
      }, sample.reviewer);
      void assignment.catch(() => undefined);
      await expect.poll(() => blockedOnPostgres(main, applicationName), wait).toBe(true);
    } finally {
      paused.release();
      await Promise.allSettled(assignment === undefined ? [generation] : [generation, assignment]);
    }
    expect(await generation).toEqual({ createdLines: 0, createdBatches: 1, skipped: [] });
    await assignment;
    const detail = await onlyLineDetail(main.db, sample.code);
    expect(detail.line.factory?.id).toBe(factory.id);
    expect(detail.batches).toMatchObject([{ plannedQty: slot.qty, dateFactoryRequired: slot.date }]);
    expect(Object.values(detail.batchDemandSources ?? {})).toMatchObject([{ importBatchId: sample.importId, slot: { originalCells: rawCells } }]);
  });
}, 15000);

async function expectPlanWithoutSource(db: AppDatabase, sample: Sample): Promise<void> {
  expect(await makeGenerateBatchesFromDemand(writes(db))({ rowIds: [sample.id] }, sample.buyer))
    .toEqual({ createdLines: 0, createdBatches: 1, skipped: [] });
  const detail = await onlyLineDetail(db, sample.code);
  expect(detail.batches).toMatchObject([{ plannedQty: slot.qty, dateFactoryRequired: slot.date }]);
  expect(detail.batchDemandSources).toEqual({});
}
