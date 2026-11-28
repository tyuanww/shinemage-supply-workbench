import { expect, it } from 'vitest';
import { makeCancelLine, makeCreateBatch, makeGenerateBatchesFromDemand } from '../../packages/application/src/follow-up/index.js';
import { makeLinkFactoryRow } from '../../packages/application/src/master-data/index.js';
import { linkIdOf, linkOf } from '../../packages/application/src/shared/factory-link.js';
import { entityId, localDate, orderLineId } from '../../packages/domain/src/index.js';
import { factoryReportRepository } from '../../packages/persistence/src/repositories/factory-reports.js';
import { lineFactoryLinkRepository } from '../../packages/persistence/src/repositories/line-factory-links.js';
import { orderLineRepository } from '../../packages/persistence/src/repositories/order-lines.js';
import { anOrderLine } from '../../packages/testkit/src/index.js';
import {
  url, clock, slot, rawCells, wait, withFixture,
  seedLine, onlyLineDetail, blockedOnPostgres, gate, settled, writes,
} from './factory-demand-generation-fixture.js';

it.skipIf(url === undefined).each([
  { existing: true, distinct: false }, { existing: false, distinct: false },
  { existing: true, distinct: true }, { existing: false, distinct: true },
])('真实 PostgreSQL 并发生成保留每个需求槽并连续编号（已有订单 $existing，不同需求行 $distinct）', async ({ existing, distinct }) => {
  await withFixture(async ({ main, competing, applicationName, sample }) => {
    if (existing) await seedLine({ db: main.db, sample, id: sample.lineId });
    const otherId = distinct ? entityId(`${sample.id}-second`) : sample.id;
    if (distinct) {
      const reports = factoryReportRepository(main.db);
      const original = await reports.get(sample.id);
      if (original.demand === null) throw new Error('合成行缺少工厂需求');
      const secondSlot = { ...slot, qty: 75 };
      await reports.save({ ...original, id: otherId, fingerprint: otherId, rowNo: 5,
        raw: { slots: [{ ...secondSlot, ...rawCells, qtyRaw: '075.00', sourceColumns: { date: 10, quantity: 11 } }] },
        demand: { ...original.demand, blockMaterialPoRaw: ` ＰＯ${sample.poRaw.slice(2)} `, slots: [secondSlot] },
      });
    }
    const paused = gate();
    const first = makeGenerateBatchesFromDemand(writes(main.db, { afterMaterialOrderLock: paused.hold }));
    const second = makeGenerateBatchesFromDemand(writes(competing.db));
    const request = { rowIds: [sample.id] };
    const holding = first(request, sample.buyer);
    let other: ReturnType<typeof second> | undefined;
    try {
      await Promise.race([paused.entered, holding]);
      const running = settled(second({ rowIds: [otherId] }, sample.buyer));
      other = running.result;
      await expect.poll(() => running.isDone() || blockedOnPostgres(main, applicationName), wait).toBe(true);
    } finally {
      paused.release();
      await Promise.allSettled(other === undefined ? [holding] : [holding, other]);
    }
    expect(await holding).toEqual({ createdLines: existing ? 0 : 1, createdBatches: 1, skipped: [] });
    expect(await other).toEqual(distinct ? { createdLines: 0, createdBatches: 1, skipped: [] }
      : { createdLines: 0, createdBatches: 0, skipped: [{ rowId: sample.id, slotIndex: 0, reason: '已经生成过批次' }] });
    const detail = await onlyLineDetail(main.db, sample.code);
    const saved = [...detail.batches].sort((a, b) => a.seq - b.seq).map((batch) => {
      const source = detail.batchDemandSources?.[batch.id];
      return { seq: batch.seq, qty: batch.plannedQty, date: batch.dateFactoryRequired,
        importId: source?.importBatchId, row: source?.rowNo, raw: source?.slot.originalCells };
    });
    const firstBatch = { seq: 1, qty: slot.qty, date: slot.date, importId: sample.importId, row: 4, raw: rawCells };
    expect(saved).toEqual(distinct
      ? [firstBatch, { ...firstBatch, seq: 2, row: 5, qty: 75, raw: { ...rawCells, qtyRaw: '075.00' } }]
      : [firstBatch]);
  });
}, 15000);

it.skipIf(url === undefined)('需求批次与人工建批同时提交时按同一订单行连续编号', async () => {
  await withFixture(async ({ main, competing, applicationName, sample }) => {
    await seedLine({ db: main.db, sample, id: sample.lineId });
    const paused = gate();
    const generate = makeGenerateBatchesFromDemand(writes(main.db, { afterLineLock: paused.hold }));
    const create = makeCreateBatch(writes(competing.db));
    const generated = generate({ rowIds: [sample.id] }, sample.buyer);
    let manual: ReturnType<typeof create> | undefined;
    try {
      await Promise.race([paused.entered, generated]);
      const running = settled(create({ lineId: sample.lineId, receiverPartyId: sample.factoryId, plannedQty: 75 }, sample.buyer));
      manual = running.result;
      await expect.poll(() => blockedOnPostgres(main, applicationName), wait).toBe(true);
    } finally {
      paused.release();
      await Promise.allSettled(manual === undefined ? [generated] : [generated, manual]);
    }
    await generated;
    await manual;
    const detail = await onlyLineDetail(main.db, sample.code);
    expect([...detail.batches].sort((a, b) => a.seq - b.seq)).toMatchObject([
      { seq: 1, plannedQty: 50, origin: 'from_factory_demand' }, { seq: 2, plannedQty: 75, origin: 'manual' },
    ]);
  });
}, 15000);

it.skipIf(url === undefined)('订单取消先提交时，等待编号的工厂需求沿用已取消的跳过原因', async () => {
  await withFixture(async ({ main, competing, applicationName, sample }) => {
    await seedLine({ db: main.db, sample, id: sample.lineId });
    const deps = writes(main.db);
    const paused = gate();
    const cancel = makeCancelLine({ ...deps, uow: {
      run: (work) => deps.uow.run(async (tx) => {
        const result = await work(tx);
        await paused.hold();
        return result;
      }),
    } });
    const cancelling = cancel({ lineId: sample.lineId, reason: '合成订单取消' }, sample.buyer);
    const generate = makeGenerateBatchesFromDemand(writes(competing.db));
    let generated: ReturnType<typeof generate> | undefined;
    try {
      await Promise.race([paused.entered, cancelling]);
      generated = generate({ rowIds: [sample.id] }, sample.buyer);
      await expect.poll(() => blockedOnPostgres(main, applicationName), wait).toBe(true);
    } finally {
      paused.release();
      await Promise.allSettled(generated === undefined ? [cancelling] : [cancelling, generated]);
    }
    await cancelling;
    expect(await generated).toEqual({ createdLines: 0, createdBatches: 0,
      skipped: [{ rowId: sample.id, slotIndex: 0, reason: '订单行已取消' }] });
    expect((await onlyLineDetail(main.db, sample.code)).batches).toEqual([]);
  });
}, 15000);

it.skipIf(url === undefined)('真实 PostgreSQL 重联持有写锁时仍生成业务批次，原表保留待核对', async () => {
  await withFixture(async ({ main, competing, sample }) => {
    const target = sample.lineId;
    const other = orderLineId(`${sample.id}-other`);
    await seedLine({ db: main.db, sample, id: target });
    await orderLineRepository(main.db).save(anOrderLine({ id: other, purchaseOrderId: sample.orderId, lane: 'material' }));
    const generationRead = gate();
    const relinkWrite = gate();
    const generate = makeGenerateBatchesFromDemand(writes(main.db, { afterOriginRead: generationRead.hold }));
    const link = makeLinkFactoryRow(writes(competing.db, { afterDemandSave: relinkWrite.hold }));
    const generated = settled(generate({ rowIds: [sample.id] }, sample.buyer));
    let linked: ReturnType<typeof link> | undefined;
    try {
      await Promise.race([generationRead.entered, generated.result]);
      linked = link({ table: 'demand', rowId: sample.id, orderLineId: other }, sample.reviewer);
      void linked.catch(() => undefined);
      await expect.poll(relinkWrite.hasEntered, wait).toBe(true);
      generationRead.release();
      await expect.poll(generated.isDone, wait).toBe(true);
      expect(await generated.result).toEqual({ createdLines: 0, createdBatches: 1, skipped: [] });
    } finally {
      generationRead.release();
      relinkWrite.release();
      await Promise.allSettled(linked === undefined ? [generated.result] : [generated.result, linked]);
    }
    await linked;
    const before = await onlyLineDetail(main.db, sample.code);
    expect(before.batches).toMatchObject([{ plannedQty: slot.qty, dateFactoryRequired: slot.date }]);
    expect(before.batchDemandSources).toEqual({});
    expect(await main.exec(`select origin_ref from delivery_batches where origin_ref->>'rowId' = '${sample.id}'`))
      .toMatchObject({ rows: [{ origin_ref: { rowId: sample.id, slotIndex: 0, generationSource: null } }] });
    const linkAfterCommit = makeLinkFactoryRow(writes(competing.db));
    await linkAfterCommit({ table: 'demand', rowId: sample.id, orderLineId: target }, sample.reviewer);
    const after = await onlyLineDetail(main.db, sample.code);
    expect(after.factoryReports.demand).toMatchObject([{ id: sample.id, payload: { slots: [{ originalCells: rawCells }] } }]);
    expect(after.batchDemandSources).toEqual({});
  });
}, 15000);

it.skipIf(url === undefined).each([
  { qty: 100, qtyRaw: '0100.00' },
  { date: localDate('2026-11-25'), dateRaw: '2026/11/25' },
])('真实 PostgreSQL 原始槽和生成事实冲突时保留计划值，原表待核对（%j）', async (conflict) => {
  await withFixture(async ({ main, sample }) => {
    const reports = factoryReportRepository(main.db);
    const original = await reports.get(sample.id);
    await reports.save({ ...original, raw: { slots: [{ ...slot, ...rawCells, ...conflict }] } });
    const generated = await makeGenerateBatchesFromDemand(writes(main.db))({ rowIds: [sample.id] }, sample.buyer);
    expect(generated).toEqual({ createdLines: 1, createdBatches: 1, skipped: [] });
    const detail = await onlyLineDetail(main.db, sample.code);
    expect(detail.batches).toMatchObject([{ plannedQty: slot.qty, dateFactoryRequired: slot.date }]);
    expect(detail.batchDemandSources).toEqual({});
  });
}, 15000);

it.skipIf(url === undefined).each([true, false])('真实 PostgreSQL 未关联需求只为工厂归属兼容的订单保存原表（冲突 %s）', async (conflict) => {
  await withFixture(async ({ main, sample }) => {
    await seedLine({ db: main.db, sample, id: sample.lineId });
    const factoryId = conflict ? `${sample.factoryId}-other` : sample.factoryId;
    await lineFactoryLinkRepository(main.db).save(linkOf({
      id: linkIdOf(sample.lineId), at: clock.now(), orderLineId: sample.lineId,
      factoryPartyId: factoryId, source: 'manual', status: 'manual', confidence: 'manual',
    }));
    expect(await makeGenerateBatchesFromDemand(writes(main.db))({ rowIds: [sample.id] }, sample.buyer))
      .toEqual({ createdLines: 0, createdBatches: 1, skipped: [] });
    const detail = await onlyLineDetail(main.db, sample.code);
    expect(detail.line.factory).toMatchObject({ id: factoryId });
    expect(detail.batches).toMatchObject([{ plannedQty: slot.qty, dateFactoryRequired: slot.date }]);
    expect(Object.values(detail.batchDemandSources ?? {}))
      .toMatchObject(conflict ? [] : [{ importBatchId: sample.importId, slot: { originalCells: rawCells } }]);
  });
}, 15000);

it.skipIf(url === undefined).each(['raw', 'normalized'] as const)('真实 PostgreSQL 重复 %s 槽索引只影响生成凭据', async (repeated) => {
  await withFixture(async ({ main, sample }) => {
    const reports = factoryReportRepository(main.db);
    const original = await reports.get(sample.id);
    if (original.demand === null) throw new Error('缺少合成需求');
    const second = { ...slot, qty: 75, date: localDate('2026-11-25') };
    const rawSecond = { ...second, qtyRaw: '075.00', dateRaw: '2026/11/25' };
    await reports.save({ ...original,
      raw: { slots: repeated === 'raw' ? [{ ...slot, ...rawCells }, rawSecond] : [rawSecond] },
      demand: { ...original.demand, slots: repeated === 'normalized' ? [slot, second] : [slot] },
    });
    const skipped = repeated === 'normalized' ? [{ rowId: sample.id, slotIndex: 0, reason: '已经生成过批次' }] : [];
    expect(await makeGenerateBatchesFromDemand(writes(main.db))({ rowIds: [sample.id] }, sample.buyer))
      .toEqual({ createdLines: 1, createdBatches: 1, skipped });
    const detail = await onlyLineDetail(main.db, sample.code);
    expect(detail.batches).toMatchObject([{ plannedQty: slot.qty, dateFactoryRequired: slot.date }]);
    expect(detail.batchDemandSources).toEqual({});
  });
}, 15000);
