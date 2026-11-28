import { expect, it } from 'vitest';
import { makeAssignLines, makeCreateHintBatches, makeGenerateBatchesFromDemand, makeUpdateLine } from '../../packages/application/src/follow-up/index.js';
import { makeAssignOwner } from '../../packages/application/src/owner/index.js';
import { purchaseOrderKey } from '../../packages/application/src/follow-up/use-cases/purchase-order-ref.js';
import { entityId, orderLineId } from '../../packages/domain/src/index.js';
import type { AppDatabase } from '../../packages/persistence/src/client.js';
import { factoryReportRepository } from '../../packages/persistence/src/repositories/factory-reports.js';
import { orderLineRepository } from '../../packages/persistence/src/repositories/order-lines.js';
import { deliveryBatchRepository } from '../../packages/persistence/src/repositories/delivery-batches.js';
import { settingsRepository } from '../../packages/persistence/src/repositories/settings.js';
import { userRepository } from '../../packages/persistence/src/repositories/users.js';
import { seed } from '../../packages/persistence/src/seed.js';
import { aUser, anOrderLine } from '../../packages/testkit/src/index.js';
import { blockedOnPostgres, gate, onlyLineDetail, rawCells, seedLine, settled, url, wait, withFixture, writes, type Sample } from './factory-demand-generation-fixture.js';

it.skipIf(url === undefined)('工厂反序生成两条订单与今日批量建批重叠时，两笔操作都能提交', async () => {
  await withFixture(async ({ main, competing, applicationName, sample }) => {
    await seed(main.exec);
    const warehouse = (await settingsRepository(main.db).get()).ownWarehousePartyId;
    if (warehouse === null) throw new Error('合成配置缺少我方仓库');
    const pair = await seedDemandPair(main.db, {
      sample, fields: { buyerUserId: sample.buyer.id, qtyOrdered: 120, unit: '个', receiverPartyId: warehouse },
    });
    const paused = gate();
    const hint = makeCreateHintBatches(writes(main.db, {
      afterLineLock: async (id) => { if (id === sample.lineId) await paused.hold(); },
    }));
    const hinting = hint({ lineIds: pair.lineIds, source: 'today', includeCompleted: false }, sample.buyer);
    const generate = makeGenerateBatchesFromDemand(writes(competing.db));
    let generated: ReturnType<typeof generate> | undefined;
    try {
      await Promise.race([paused.entered, hinting]);
      generated = generate({ rowIds: [...pair.rowIds].reverse() }, sample.buyer);
      await expect.poll(() => blockedOnPostgres(main, applicationName), wait).toBe(true);
    } finally {
      paused.release();
      await Promise.allSettled(generated === undefined ? [hinting] : [hinting, generated]);
    }
    expect(await hinting).toEqual({ created: 2, skipped: [] });
    expect(await generated).toEqual({ createdLines: 0, createdBatches: 2, skipped: [] });
    for (const id of pair.lineIds) {
      const batches = await deliveryBatchRepository(main.db).listByOrderLine(id);
      expect([...batches].sort((left, right) => left.seq - right.seq)).toMatchObject([
        { seq: 1, plannedQty: 120, origin: 'from_po_master_hint', receiverPartyId: warehouse },
        { seq: 2, plannedQty: 50, origin: 'from_factory_demand', receiverPartyId: warehouse },
      ]);
    }
  });
}, 15000);

it.skipIf(url === undefined).each([false, true])('真 PostgreSQL 等待改料提交后重新解析材料（有可复用订单行 %s）', async (existing) => {
  await withFixture(async ({ main, competing, applicationName, sample }) => {
    await seedLine({ db: main.db, sample, id: sample.lineId });
    const paused = gate();
    const alternate = existing ? orderLineId(`${sample.id}-other`) : null;
    if (alternate !== null) {
      await orderLineRepository(main.db).save(anOrderLine({
        id: alternate, purchaseOrderId: sample.orderId, lane: 'material', itemCodeRaw: `${sample.code}-before`,
      }));
    }
    const otherCode = `${sample.code}-edited`;
    const editing = updateMaterialLines(main.db, { sample, alternate, otherCode, paused });
    const generate = makeGenerateBatchesFromDemand(writes(competing.db));
    let generated: ReturnType<typeof generate> | undefined;
    try {
      await Promise.race([paused.entered, editing]);
      generated = generate({ rowIds: [sample.id] }, sample.buyer);
      await expect.poll(() => blockedOnPostgres(main, applicationName), wait).toBe(true);
    } finally {
      paused.release();
      await Promise.allSettled(generated === undefined ? [editing] : [editing, generated]);
    }
    expect(await editing).toEqual({ lineId: sample.lineId });
    expect(await generated).toEqual({ createdLines: existing ? 0 : 1, createdBatches: 1, skipped: [] });
    expect((await orderLineRepository(main.db).get(sample.lineId)).itemCodeRaw).toEqual(otherCode);
    expect(await deliveryBatchRepository(main.db).listByOrderLine(sample.lineId)).toEqual([]);
    const correct = await onlyLineDetail(main.db, sample.code);
    expect(correct.line.id).not.toEqual(sample.lineId);
    if (alternate !== null) expect(correct.line.id).toEqual(alternate);
    expect(correct.batches).toMatchObject([{ seq: 1, plannedQty: 50 }]);
    expect(Object.values(correct.batchDemandSources ?? {})).toMatchObject([{ slot: { originalCells: rawCells } }]);
    expect(await generate({ rowIds: [sample.id] }, sample.buyer)).toEqual({
      createdLines: 0, createdBatches: 0, skipped: [{ rowId: sample.id, slotIndex: 0, reason: '已经生成过批次' }],
    });
  });
}, 15000);

function updateMaterialLines(db: AppDatabase, { sample, alternate, otherCode, paused }: {
  readonly sample: Sample; readonly alternate: ReturnType<typeof orderLineId> | null;
  readonly otherCode: string; readonly paused: ReturnType<typeof gate>;
}) {
  const deps = writes(db);
  return deps.uow.run(async (tx) => {
    const update = makeUpdateLine({ ...deps, uow: { run: (effect) => effect(tx) } });
    const from = { lineId: sample.lineId, itemCodeRaw: otherCode };
    const receipt = await update(from, sample.buyer);
    if (alternate !== null) {
      const to = { lineId: alternate, itemCodeRaw: sample.code };
      await update(to, sample.buyer);
    }
    await paused.hold();
    return receipt;
  });
}

it.skipIf(url === undefined).each([
  { route: 'follow-up', prior: false },
  { route: 'owner', prior: true },
] as const)('真 PostgreSQL 逆序批量分配与生成重叠可提交（%j）', async ({ route, prior }) => {
  await withFixture(async ({ main, competing, applicationName, sample }) => {
    const pair = await seedDemandPair(main.db, { sample });
    await userRepository(main.db).save(aUser({ id: sample.buyer.id }));
    const generate = makeGenerateBatchesFromDemand(writes(competing.db));
    if (prior) expect(await generate({ rowIds: pair.rowIds }, sample.buyer)).toEqual({ createdLines: 0, createdBatches: 2, skipped: [] });
    const paused = gate();
    const written: string[] = [];
    const deps = writes(main.db, { afterLineSave: async (id) => {
      written.push(id);
      if (id === pair.lineIds[1]) await paused.hold();
    } });
    const lineIds = [...pair.lineIds].reverse();
    const assigning = route === 'follow-up'
      ? makeAssignLines(deps)({ lineIds, buyerUserId: sample.buyer.id }, sample.buyer)
      : makeAssignOwner(deps)({ lineIds, ownerUserId: sample.buyer.id }, sample.buyer);
    let generated: ReturnType<typeof generate> | undefined;
    try {
      await Promise.race([paused.entered, assigning]);
      const generation = settled(generate({ rowIds: [...pair.rowIds].reverse() }, sample.buyer));
      generated = generation.result;
      const hasReachedExpectedState = async () => prior ? generation.isDone() : blockedOnPostgres(main, applicationName);
      await expect.poll(hasReachedExpectedState, wait).toBe(true);
    } finally {
      paused.release();
      await Promise.allSettled(generated === undefined ? [assigning] : [assigning, generated]);
    }
    expect(await assigning).toEqual({ updated: 2 });
    expect(written).toEqual(lineIds);
    const skipped = [...pair.rowIds].reverse().map((rowId) => ({ rowId, slotIndex: 0, reason: '已经生成过批次' }));
    expect(await generated).toEqual({ createdLines: 0, createdBatches: prior ? 0 : 2, skipped: prior ? skipped : [] });
    for (const id of pair.lineIds) {
      expect((await orderLineRepository(main.db).get(id)).buyerUserId).toEqual(sample.buyer.id);
      expect((await deliveryBatchRepository(main.db).listByOrderLine(id)).map((batch) => batch.seq)).toEqual([1]);
    }
  });
}, 15000);

async function seedDemandPair(db: AppDatabase, { sample, fields = {} }: {
  readonly sample: Sample; readonly fields?: Partial<ReturnType<typeof anOrderLine>>;
}) {
  await seedLine({ db, sample, id: sample.lineId, fields });
  const secondLine = orderLineId(`${sample.id}-other`);
  const secondCode = `${sample.code}-second`;
  const secondRow = entityId(`${sample.id}-second`);
  await orderLineRepository(db).save(anOrderLine({
    ...fields, id: secondLine, purchaseOrderId: sample.orderId, lane: 'material', itemCodeRaw: secondCode,
  }));
  const reports = factoryReportRepository(db);
  const first = await reports.get(sample.id);
  if (first.demand === null) throw new Error('合成行缺少工厂需求');
  await reports.save({ ...first, id: secondRow, fingerprint: secondRow, rowNo: 5,
    demand: { ...first.demand, itemCodeRaw: secondCode },
  });
  return { lineIds: [sample.lineId, secondLine], rowIds: [sample.id, secondRow] } as const;
}

it.skipIf(url === undefined)('四个不同需求行按相反物料单顺序同时生成时，两单各有两个连续批次', async () => {
  await withFixture(async ({ main, competing, applicationName, sample }) => {
    const reports = factoryReportRepository(main.db);
    const first = await reports.get(sample.id);
    if (first.demand === null) throw new Error('合成行缺少工厂需求');
    const ids = [sample.id];
    const alternatePo = `ALT-${sample.id}`;
    for (const po of [alternatePo, alternatePo, sample.poRaw]) {
      const id = entityId(`${sample.id}-${ids.length}`);
      await reports.save({ ...first, id, fingerprint: id, rowNo: first.rowNo + ids.length,
        demand: { ...first.demand, blockMaterialPoRaw: po },
      });
      ids.push(id);
    }
    const paused = gate();
    const left = makeGenerateBatchesFromDemand(writes(main.db, { afterMaterialOrderLock: paused.hold }));
    const right = makeGenerateBatchesFromDemand(writes(competing.db));
    const holding = left({ rowIds: ids.slice(0, 2) }, sample.buyer);
    let waiting: ReturnType<typeof right> | undefined;
    try {
      await Promise.race([paused.entered, holding]);
      waiting = right({ rowIds: ids.slice(2) }, sample.buyer);
      await expect.poll(() => blockedOnPostgres(main, applicationName), wait).toBe(true);
    } finally {
      paused.release();
      await Promise.allSettled(waiting === undefined ? [holding] : [holding, waiting]);
    }
    expect(await holding).toEqual({ createdLines: 2, createdBatches: 2, skipped: [] });
    expect(await waiting).toEqual({ createdLines: 0, createdBatches: 2, skipped: [] });
    const lines = await orderLineRepository(main.db).listByCodeNorm(sample.code);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const batches = await deliveryBatchRepository(main.db).listByOrderLine(line.id);
      expect(batches.map(({ seq }) => seq).sort()).toEqual([1, 2]);
    }
  });
}, 15000);

it.skipIf(url === undefined)('未填、空格和原表占位符共用无单号物料单的事务锁', async () => {
  await withFixture(async ({ main, competing, applicationName }) => {
    const keys = [null, '', '  ', '／', '—'].map((raw) => purchaseOrderKey(raw).poNorm);
    expect(new Set(keys)).toEqual(new Set([null]));
    const paused = gate();
    const holding = writes(main.db).uow.run(async (tx) => {
      await tx.batches.lockDemandGeneration({ materialOrderNumbers: keys.slice(0, 1) });
      await paused.hold();
    });
    let waiting: Promise<void> | undefined;
    try {
      await Promise.race([paused.entered, holding]);
      waiting = writes(competing.db).uow.run((tx) => tx.batches.lockDemandGeneration({ materialOrderNumbers: keys.slice(1) }));
      await expect.poll(() => blockedOnPostgres(main, applicationName), wait).toBe(true);
    } finally {
      paused.release();
      await Promise.allSettled(waiting === undefined ? [holding] : [holding, waiting]);
    }
    await holding;
    await waiting;
  });
}, 15000);
