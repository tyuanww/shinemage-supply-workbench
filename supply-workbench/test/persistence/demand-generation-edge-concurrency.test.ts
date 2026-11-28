import { expect, it } from 'vitest';
import { makeCancelBatch, makeCreateBatch, makeGenerateBatchesFromDemand, makeReopenBatch, makeReopenLine, makeUpdateBatch } from '../../packages/application/src/follow-up/index.js';
import { makeBulkCreateItems } from '../../packages/application/src/master-data/index.js';
import { entityId, localDate, orderLineId } from '../../packages/domain/src/index.js';
import type { AppDatabase } from '../../packages/persistence/src/client.js';
import { followUpQueries } from '../../packages/persistence/src/queries/follow-up/index.js';
import { deliveryBatchRepository } from '../../packages/persistence/src/repositories/delivery-batches.js';
import { factoryReportRepository } from '../../packages/persistence/src/repositories/factory-reports.js';
import { itemCodeRepository } from '../../packages/persistence/src/repositories/identity.js';
import { orderLineRepository } from '../../packages/persistence/src/repositories/order-lines.js';
import { aBatch, anOrderLine } from '../../packages/testkit/src/index.js';
import { anotherDemand, blockedOnPostgres, clock, gate, seedLine, settled, slot, url, wait, withFixture, writes, type Sample } from './factory-demand-generation-fixture.js';

it.skipIf(url === undefined)('取消旧批次与生成新批次重叠后，订单列表显示实际开放的下一批', async () => {
  await withFixture(async ({ main, competing, applicationName, sample }) => {
    await seedLine({ db: main.db, sample, id: sample.lineId });
    const before = await makeCreateBatch(writes(main.db))({
      lineId: sample.lineId, receiverPartyId: sample.factoryId, plannedQty: 25,
    }, sample.buyer);
    const paused = gate();
    const generate = makeGenerateBatchesFromDemand(beforeBatchSave(main.db, { paused }));
    const generation = generate({ rowIds: [sample.id] }, sample.buyer);
    let cancellation: ReturnType<ReturnType<typeof makeCancelBatch>> | undefined;
    try {
      await Promise.race([generation, paused.entered]);
      const cancel = makeCancelBatch(writes(competing.db));
      const pending = settled(cancel({ batchId: before.batchId, reason: '合成旧批次已取消' }, sample.buyer));
      cancellation = pending.result;
      await expect.poll(() => pending.isDone() || blockedOnPostgres(main, applicationName), wait).toBe(true);
    } finally {
      paused.release();
      await Promise.allSettled(cancellation === undefined ? [generation] : [generation, cancellation]);
    }
    expect(await generation).toEqual({ createdLines: 0, createdBatches: 1, skipped: [] });
    expect(await cancellation).toEqual({ batchId: before.batchId });
    const batches = await deliveryBatchRepository(main.db).listByOrderLine(sample.lineId);
    const replacement = batches.find((batch) => batch.id !== before.batchId);
    expect(batches.find((batch) => batch.id === before.batchId)?.status).toBe('cancelled');
    expect(replacement).toMatchObject({ seq: 2, status: 'awaiting_date', plannedQty: slot.qty, dateFactoryRequired: slot.date });
    const rows = followUpQueries({ db: main.db, clock, timeZone: 'Asia/Shanghai' });
    const [listed] = (await rows.list({ q: sample.code })).items;
    expect(listed).toMatchObject({ stage: 'awaiting_date', nextDue: { batchId: replacement?.id, dateFactoryRequired: slot.date } });
    expect((await rows.list({ q: sample.code, stages: ['no_batch'] })).items).toEqual([]);
  });
}, 15000);

it.skipIf(url === undefined)('取消唯一批次后，列表仍显示未建要货和空下一批', async () => {
  await withFixture(async ({ main, sample }) => {
    await seedLine({ db: main.db, sample, id: sample.lineId });
    const batch = await makeCreateBatch(writes(main.db))({
      lineId: sample.lineId, receiverPartyId: sample.factoryId, plannedQty: 25,
    }, sample.buyer);
    await makeCancelBatch(writes(main.db))({ batchId: batch.batchId, reason: '合成旧批次已取消' }, sample.buyer);
    const rows = followUpQueries({ db: main.db, clock, timeZone: 'Asia/Shanghai' });
    expect((await rows.list({ q: sample.code, stages: ['no_batch'] })).items)
      .toMatchObject([{ id: sample.lineId, stage: 'no_batch', nextDue: null }]);
  });
}, 15000);

function beforeBatchSave(db: AppDatabase, { paused, beforeLineLock = false }: {
  readonly paused: ReturnType<typeof gate>;
  readonly beforeLineLock?: boolean;
}) {
  const deps = writes(db);
  async function holdOnce() { if (!paused.hasEntered()) await paused.hold(); }
  const uow: typeof deps.uow = {
    run: (effect) => deps.uow.run((tx) => effect({
      ...tx,
      orderLines: {
        ...tx.orderLines,
        async lock(...args: Parameters<typeof tx.orderLines.lock>) {
          if (beforeLineLock) await holdOnce();
          return tx.orderLines.lock(...args);
        },
      },
      batches: {
        ...tx.batches,
        async saveWithRecords(records) {
          await holdOnce();
          await tx.batches.saveWithRecords(records);
        },
      },
    })),
  };
  return { ...deps, uow };
}

it.skipIf(url === undefined).each([true, false])('等待其他订单锁期间重开另一订单会重验匹配（同物料 %s）', async (sameItem) => {
  await withFixture(async ({ main, competing, applicationName, sample }) => {
    const pair = await seedPair(main.db, sample);
    const reopenedLineId = orderLineId(`${sample.id}-reopened`);
    await orderLineRepository(main.db).save(anOrderLine({
      id: reopenedLineId, purchaseOrderId: sample.orderId, lane: 'material', itemCodeRaw: sameItem ? pair.secondCode : `${pair.secondCode}-unrelated`,
      cancelledAt: clock.now(), cancelReason: '预先取消的合成订单', stage: 'cancelled',
    }));
    try {
      const paused = gate();
      const holding = writes(main.db).uow.run(async (tx) => { await tx.orderLines.lock(sample.lineId); await paused.hold(); });
      const generate = makeGenerateBatchesFromDemand(writes(competing.db));
      let generated: ReturnType<typeof generate> | undefined;
      try {
        await Promise.race([holding, paused.entered]);
        generated = generate({ rowIds: pair.rowIds }, sample.buyer);
        await expect.poll(() => blockedOnPostgres(main, applicationName), wait).toBe(true);
        const reopen = makeReopenLine(writes(main.db));
        expect(await reopen({ lineId: reopenedLineId, reason: '恢复合成订单' }, sample.buyer)).toEqual({ lineId: reopenedLineId });
      } finally {
        paused.release();
        await Promise.allSettled(generated === undefined ? [holding] : [holding, generated]);
      }
      const skipped = sameItem ? [{ rowId: pair.rowIds[1], slotIndex: 0, reason: '匹配到多条订单行' }] : [];
      expect(await generated).toEqual({ createdLines: 0, createdBatches: sameItem ? 1 : 2, skipped });
      expect(await deliveryBatchRepository(main.db).listByOrderLine(pair.lineIds[1])).toHaveLength(sameItem ? 0 : 1);
      expect(await deliveryBatchRepository(main.db).listByOrderLine(reopenedLineId)).toEqual([]);
    } finally {
      await main.exec(`delete from delivery_batches where order_line_id = '${reopenedLineId}'; delete from order_lines where id = '${reopenedLineId}';`);
    }
  });
}, 15000);

it.skipIf(url === undefined)('重复生成已存在的全部批次时，反序回填物料的操作仍能提交', async () => {
  await withFixture(async ({ main, competing, applicationName, sample }) => {
    const pair = await seedPair(main.db, sample);
    const generate = makeGenerateBatchesFromDemand(writes(competing.db));
    expect(await generate({ rowIds: pair.rowIds }, sample.buyer)).toEqual({ createdLines: 0, createdBatches: 2, skipped: [] });
    const codes = await seedPendingCodes(main.db, { sample, secondCode: pair.secondCode });
    try {
      const paused = gate();
      const bulk = makeBulkCreateItems(writes(main.db, { afterLineSave: async (id) => {
        if (id === pair.lineIds[1]) await paused.hold();
      } }));
      const backfill = bulk({ codeIds: [...codes].reverse() }, sample.reviewer);
      let duplicate: ReturnType<typeof generate> | undefined;
      try {
        await Promise.race([backfill, paused.entered]);
        const retry = settled(generate({ rowIds: pair.rowIds }, sample.buyer));
        duplicate = retry.result;
        await expect.poll(() => retry.isDone() || blockedOnPostgres(main, applicationName), wait).toBe(true);
        expect(retry.isDone()).toBe(true);
      } finally {
        paused.release();
        await Promise.allSettled(duplicate === undefined ? [backfill] : [duplicate, backfill]);
      }
      expect(await backfill).toEqual({ created: 2 });
      expect(await duplicate).toEqual({ createdLines: 0, createdBatches: 0, skipped: pair.rowIds.map((rowId) => ({
        rowId, slotIndex: 0, reason: '已经生成过批次',
      })) });
      for (const id of pair.lineIds) expect((await deliveryBatchRepository(main.db).listByOrderLine(id)).map(({ seq }) => seq)).toEqual([1]);
    } finally {
      await main.exec(`delete from items where id in (select item_id from item_codes where id in ('${codes[0]}','${codes[1]}')); delete from item_codes where id in ('${codes[0]}','${codes[1]}');`);
    }
  });
}, 15000);

it.skipIf(url === undefined)('等待已取消候选的锁时释放已获取的订单行锁', async () => {
  await withFixture(async ({ main, competing, applicationName, sample }) => {
    const cancelled = orderLineId(`${sample.id}-other`);
    await seedLine({ db: main.db, sample, id: sample.lineId });
    await seedLine({ db: main.db, sample, id: cancelled, fields: { cancelledAt: clock.now(), cancelReason: '合成取消', stage: 'cancelled' } });
    const paused = gate();
    const other = writes(main.db).uow.run(async (tx) => {
      await tx.orderLines.lock(cancelled);
      await paused.hold();
      await tx.orderLines.lock(sample.lineId);
    });
    const generate = makeGenerateBatchesFromDemand(writes(competing.db));
    let generation: ReturnType<typeof generate> | undefined;
    try {
      await Promise.race([other, paused.entered]);
      generation = settled(generate({ rowIds: [sample.id] }, sample.buyer)).result;
      await expect.poll(() => blockedOnPostgres(main, applicationName), wait).toBe(true);
      expect(await main.exec(`select id from order_lines where id = '${sample.lineId}' for update nowait`))
        .toMatchObject({ rows: [{ id: sample.lineId }] });
    } finally {
      paused.release();
      await Promise.allSettled(generation === undefined ? [other] : [other, generation]);
    }
    await other;
    expect(await generation).toEqual({ createdLines: 0, createdBatches: 1, skipped: [] });
  });
}, 15000);

async function seedPendingCodes(db: AppDatabase, { sample, secondCode }: { readonly sample: Sample; readonly secondCode: string }) {
  const left = entityId(`${sample.id}-code-left`);
  const right = entityId(`${sample.id}-code-right`);
  const at = clock.now();
  await itemCodeRepository(db).save({ id: left, codeRaw: sample.code, codeNorm: sample.code, codeType: 'other', status: 'pending', itemId: null, createdAt: at, updatedAt: at });
  await itemCodeRepository(db).save({ id: right, codeRaw: secondCode, codeNorm: secondCode, codeType: 'other', status: 'pending', itemId: null, createdAt: at, updatedAt: at });
  return [left, right] as const;
}

async function seedPair(db: AppDatabase, sample: Sample) {
  await seedLine({ db, sample, id: sample.lineId });
  const secondLine = orderLineId(`${sample.id}-other`);
  const secondCode = `${sample.code}-second`;
  const secondRow = entityId(`${sample.id}-second`);
  await orderLineRepository(db).save(anOrderLine({
    id: secondLine, purchaseOrderId: sample.orderId, lane: 'material', itemCodeRaw: secondCode,
  }));
  const reports = factoryReportRepository(db);
  const first = await reports.get(sample.id);
  if (first.demand === null) throw new Error('合成行缺少工厂需求');
  await reports.save({ ...first, id: secondRow, fingerprint: secondRow, rowNo: 5, demand: { ...first.demand, itemCodeRaw: secondCode } });
  return { lineIds: [sample.lineId, secondLine], rowIds: [sample.id, secondRow], secondCode } as const;
}

it.skipIf(url === undefined)('已生成的需求重试不等待同采购单另一需求的生成', async () => {
  await withFixture(async ({ main, competing, sample }) => {
    await seedLine({ db: main.db, sample, id: sample.lineId });
    const second = await anotherDemand(main.db, { sample });
    const generate = makeGenerateBatchesFromDemand(writes(main.db));
    expect(await generate({ rowIds: [sample.id] }, sample.buyer)).toMatchObject({ createdBatches: 1 });
    const paused = gate();
    const pending = makeGenerateBatchesFromDemand(beforeBatchSave(competing.db, { paused }))({ rowIds: [second] }, sample.buyer);
    let retry: ReturnType<typeof generate> | undefined;
    try {
      await Promise.race([pending, paused.entered]);
      const next = settled(generate({ rowIds: [sample.id] }, sample.buyer));
      retry = next.result;
      await expect.poll(next.isDone, { timeout: 1600, interval: 30 }).toBe(true);
    } finally {
      paused.release();
      await Promise.allSettled(retry === undefined ? [pending] : [pending, retry]);
    }
    expect(await retry).toEqual({ createdLines: 0, createdBatches: 0, skipped: [{ rowId: sample.id, slotIndex: 0, reason: '已经生成过批次' }] });
    expect(await pending).toMatchObject({ createdBatches: 1 });
  });
}, 15000);

it.skipIf(url === undefined)('等待前一订单时重开的后续物料可以生成', async () => {
  await withFixture(async ({ main, competing, sample }) => {
    await seedLine({ db: main.db, sample, id: sample.lineId });
    const code = `${sample.code}-other`;
    const second = await anotherDemand(main.db, { sample, code });
    const laterId = orderLineId(`${sample.id}-other`);
    await orderLineRepository(main.db).save(anOrderLine({
      id: laterId, purchaseOrderId: sample.orderId, lane: 'material', itemCodeRaw: code,
      cancelledAt: clock.now(), cancelReason: '合成取消', stage: 'cancelled',
    }));
    const paused = gate();
    const generate = makeGenerateBatchesFromDemand(beforeBatchSave(main.db, { paused, beforeLineLock: true }));
    const pending = generate({ rowIds: [sample.id, second] }, sample.buyer);
    try {
      await Promise.race([pending, paused.entered]);
      await makeReopenLine(writes(competing.db))({ lineId: laterId, reason: '恢复合成订单' }, sample.buyer);
    } finally {
      paused.release();
      await pending;
    }
    expect(await pending).toEqual({ createdLines: 0, createdBatches: 2, skipped: [] });
    expect(await deliveryBatchRepository(main.db).listByOrderLine(laterId)).toHaveLength(1);
  });
}, 15000);

it.skipIf(url === undefined)('重开已收到数量的旧批次与需求生成并发时保留开放的新批次投影', async () => {
  await withFixture(async ({ main, competing, applicationName, sample }) => {
    await seedLine({ db: main.db, sample, id: sample.lineId });
    const old = aBatch().withReceipt(1);
    const batch = { ...old.build(), orderLineId: sample.lineId, receiverPartyId: sample.factoryId,
      status: 'cancelled' as const, cancelledAt: clock.now(), cancelReason: '合成取消' };
    const records = old.records();
    await deliveryBatchRepository(main.db).saveWithRecords({ ...records, batch,
      receipts: records.receipts.map((row) => ({ ...row, batchId: batch.id })) });
    const paused = gate();
    const generate = makeGenerateBatchesFromDemand(beforeBatchSave(main.db, { paused }));
    const pending = generate({ rowIds: [sample.id] }, sample.buyer);
    let opening: ReturnType<ReturnType<typeof makeReopenBatch>> | undefined;
    try {
      await Promise.race([pending, paused.entered]);
      const next = settled(makeReopenBatch(writes(competing.db))({ batchId: batch.id, reason: '重开合成批次' }, sample.buyer));
      opening = next.result;
      await expect.poll(() => next.isDone() || blockedOnPostgres(main, applicationName), wait).toBe(true);
    } finally {
      paused.release();
      await Promise.allSettled(opening === undefined ? [pending] : [pending, opening]);
    }
    expect(await pending).toMatchObject({ createdBatches: 1 });
    expect(await opening).toEqual({ batchId: batch.id });
    const stored = await orderLineRepository(main.db).get(sample.lineId);
    const batches = await deliveryBatchRepository(main.db).listByOrderLine(sample.lineId);
    expect(batches.find(({ id }) => id === batch.id)).toMatchObject({ cancelledAt: null });
    expect(stored).toMatchObject({ stage: 'awaiting_date', nextDueBatchId: batches.find(({ id }) => id !== batch.id)?.id });
  });
}, 15000);

it.skipIf(url === undefined)('修改前一批日期与取消后一批重叠时不指向已取消批次', async () => {
  await withFixture(async ({ main, competing, applicationName, sample }) => {
    await seedLine({ db: main.db, sample, id: sample.lineId });
    const create = makeCreateBatch(writes(main.db));
    const first = await create({ lineId: sample.lineId, receiverPartyId: sample.factoryId, plannedQty: 5,
      dateBuyerConfirmed: localDate('2026-11-29') }, sample.buyer);
    const second = await create({ lineId: sample.lineId, receiverPartyId: sample.factoryId, plannedQty: 5,
      dateBuyerConfirmed: localDate('2026-11-30') }, sample.buyer);
    const paused = gate();
    const pending = makeCancelBatch(beforeBatchSave(main.db, { paused }))({ batchId: second.batchId, reason: '取消合成批次' }, sample.buyer);
    let updating: ReturnType<ReturnType<typeof makeUpdateBatch>> | undefined;
    try {
      await Promise.race([pending, paused.entered]);
      const next = settled(makeUpdateBatch(writes(competing.db))({ batchId: first.batchId, dateBuyerConfirmed: localDate('2026-12-01'), reason: '合成确认延期' }, sample.buyer));
      updating = next.result;
      await expect.poll(() => next.isDone() || blockedOnPostgres(main, applicationName), wait).toBe(true);
    } finally {
      paused.release();
      await Promise.allSettled(updating === undefined ? [pending] : [pending, updating]);
    }
    expect(await pending).toEqual({ batchId: second.batchId });
    expect(await updating).toEqual({ batchId: first.batchId });
    expect(await orderLineRepository(main.db).get(sample.lineId)).toMatchObject({ nextDueBatchId: first.batchId });
  });
}, 15000);
