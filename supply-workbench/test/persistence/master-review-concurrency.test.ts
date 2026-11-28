import { expect, it } from 'vitest';
import { systemIds } from '../../apps/server/src/system/ids.js';
import { makeApproveCode, makeBulkCreateItems, makeResolveMultiName } from '../../packages/application/src/master-data/index.js';
import { makeRelinkFactoryRows } from '../../packages/application/src/factory-links/index.js';
import { makeGenerateBatchesFromDemand } from '../../packages/application/src/follow-up/index.js';
import { entityId, type EntityId, type ItemCode } from '../../packages/domain/src/index.js';
import {
  auditRepository, codeLinkRepository, createUnitOfWork, factoryReportRepository, factoryLinkQueries, itemCodeRepository,
  itemNameRepository, itemRepository, orderLineRepository, placeholderStores, purchaseOrderRepository,
  requireDatabase, deliveryBatchRepository, type AppDatabase,
} from '../../packages/persistence/src/index.js';
import { aFactoryStockRow, anItem } from '../../packages/testkit/src/index.js';
import { blockedOnPostgres, clock, gate, onlyLineDetail, rawCells, seedLine, settled, url, wait, withFixture, writes } from './factory-demand-generation-fixture.js';

type Fixture = Parameters<Parameters<typeof withFixture>[0]>[0];

it.skipIf(url === undefined)('PostgreSQL 按品号及条码并发重联同一在途行时使用已提交的审核决定', async () => {
  await withReviewFixture(async (fixture, keys) => {
    const { main, competing, sample } = fixture;
    const codes = [
      reviewCode({ id: keys.left, codeRaw: sample.code, itemId: keys.firstItem }),
      reviewCode({ id: keys.right, codeRaw: `BARCODE-${sample.id}`, itemId: keys.secondItem, codeType: 'barcode_69' }),
    ] as const;
    await seedReviewLine({ fixture, codes });
    const reports = factoryReportRepository(main.db);
    const rowId = entityId(`0-${sample.id}-report`);
    const { poNorm } = await purchaseOrderRepository(main.db).get(sample.orderId);
    await reports.save(aFactoryStockRow({
      id: rowId, importBatchId: sample.importId, factoryPartyId: sample.factoryId, fingerprint: rowId, kind: 'in_transit',
      inTransit: { poRaw: sample.poRaw, poNorm, nameRaw: '工厂不同名', itemCodeRaw: codes[0].codeRaw, barcodeRaw: codes[1].codeRaw, qtyRequired: 50 },
    }));
    const paused = gate();
    const first = makeResolveMultiName(reviewWrites(main.db, { nextId: keys.firstItem, afterAudit: paused.hold }));
    const second = makeResolveMultiName(reviewWrites(competing.db, { nextId: keys.secondItem }));
    const receipt = await overlap(fixture, {
      paused,
      first: () => first({ codeId: codes[0].id, mode: 'same_item', displayName: '工厂不同名' }, sample.reviewer),
      second: () => second({ codeId: codes[1].id, mode: 'shared_code' }, sample.reviewer),
    });
    expect(receipt).toEqual({ codeId: codes[1].id });
    expect(await reports.get(rowId)).toMatchObject({ linkStatus: 'linked', linkedOrderLineId: sample.lineId, linkReason: null });
    expect(await itemNameRepository(main.db).decision(keys.firstItem)).toBe('same_item');
  });
}, 15000);

it.skipIf(url === undefined)('PostgreSQL 批量建物料和一号多名审核并发时使用同一物料归属', async () => {
  await withReviewFixture(async (fixture, keys) => {
    const { main, competing, sample } = fixture;
    const code = reviewCode({ id: keys.left, codeRaw: sample.code, itemId: null });
    await seedLine({ db: main.db, sample, id: sample.lineId });
    const codes = itemCodeRepository(main.db);
    await codes.save(code);
    const paused = gate();
    const resolve = makeResolveMultiName(reviewWrites(main.db, { nextId: keys.firstItem, afterAudit: paused.hold }));
    const bulk = makeBulkCreateItems(reviewWrites(competing.db, { nextId: keys.secondItem }));
    const receipt = await overlap(fixture, {
      paused,
      first: () => resolve({ codeId: code.id, mode: 'same_item', displayName: '审核统一名称' }, sample.reviewer),
      second: () => bulk({ codeIds: [code.id] }, sample.reviewer),
    });
    expect(receipt).toEqual({ created: 0 });
    expect(await codes.get(code.id)).toMatchObject({ itemId: keys.firstItem, status: 'approved' });
    expect(await orderLineRepository(main.db).get(sample.lineId)).toMatchObject({ itemId: keys.firstItem });
    expect(await itemRepository(main.db).find(keys.secondItem)).toBeUndefined();
  });
}, 15000);

it.skipIf(url === undefined).each(['approve', 'bulk'] as const)('PostgreSQL 同一订单行的品号和条码分别审核时保留先提交的物料（%s）', async (flow) => {
  await withReviewFixture(async (fixture, keys) => {
    const { main, competing, sample } = fixture;
    const firstCode = reviewCode({ id: keys.left, codeRaw: sample.code, itemId: null });
    const secondCode = reviewCode({ id: keys.right, codeRaw: `BARCODE-${sample.id}`, itemId: null, codeType: 'barcode_69' });
    await seedLine({ db: main.db, sample, id: sample.lineId });
    const lines = orderLineRepository(main.db);
    await lines.save({ ...await lines.get(sample.lineId), itemId: null, barcodeRaw: secondCode.codeRaw });
    const codes = itemCodeRepository(main.db);
    await codes.save(firstCode);
    await codes.save(secondCode);

    const paused = gate();
    const first = reviewWrites(main.db, { nextId: keys.firstItem, afterAudit: paused.hold });
    const second = reviewWrites(competing.db, { nextId: keys.secondItem });
    await overlap<unknown>(fixture, {
      paused,
      first: () => flow === 'approve'
        ? makeApproveCode(first)({ codeId: firstCode.id, createItem: { displayName: '品号物料', kind: 'unknown' } }, sample.reviewer)
        : makeBulkCreateItems(first)({ codeIds: [firstCode.id] }, sample.reviewer),
      second: () => flow === 'approve'
        ? makeBulkCreateItems(second)({ codeIds: [secondCode.id] }, sample.reviewer)
        : makeResolveMultiName(second)({ codeId: secondCode.id, mode: 'same_item', displayName: '条码物料' }, sample.reviewer),
    });
    expect(await codes.get(firstCode.id)).toMatchObject({ itemId: keys.firstItem, status: 'approved' });
    expect(await codes.get(secondCode.id)).toMatchObject({ itemId: keys.secondItem, status: 'approved' });
    expect(await lines.get(sample.lineId)).toMatchObject({ itemId: keys.firstItem });
  });
}, 15000);

it.skipIf(url === undefined)('普通一号多名审核期间，无可重联的需求仍能保留生成原表', async () => {
  await withReviewFixture(async ({ main, competing, sample }, keys) => {
    await seedLine({ db: main.db, sample, id: sample.lineId });
    const code = reviewCode({ id: keys.left, codeRaw: sample.code, itemId: keys.firstItem });
    await itemRepository(main.db).save(anItem({ id: keys.firstItem, displayName: '待统一物料' }));
    await itemCodeRepository(main.db).save(code);
    expect((await factoryReportRepository(main.db).get(sample.id)).demand?.poNorm).toBeNull();
    const paused = gate();
    const resolve = makeResolveMultiName(reviewWrites(main.db, { nextId: keys.firstItem, afterAudit: paused.hold }));
    const review = resolve({ codeId: code.id, mode: 'same_item', displayName: '统一名称' }, sample.reviewer);
    try {
      await Promise.race([paused.entered, review]);
      const generate = makeGenerateBatchesFromDemand(writes(competing.db));
      expect(await generate({ rowIds: [sample.id] }, sample.buyer)).toEqual({ createdLines: 0, createdBatches: 1, skipped: [] });
      expect(Object.values((await onlyLineDetail(competing.db, sample.code)).batchDemandSources ?? {}))
        .toMatchObject([{ importBatchId: sample.importId, slot: { originalCells: rawCells } }]);
    } finally {
      paused.release();
      await review;
    }
  });
}, 15000);

it.skipIf(url === undefined)('自动重联与主数据审核按相同表顺序锁住在途和需求', async () => {
  await withReviewFixture(async (fixture, keys) => {
    const { main, competing, sample } = fixture;
    await seedLine({ db: main.db, sample, id: sample.lineId, fields: { nameRaw: '合成包材', itemId: keys.firstItem } });
    const code = reviewCode({ id: keys.left, codeRaw: sample.code, itemId: keys.firstItem });
    await itemRepository(main.db).save(anItem({ id: keys.firstItem, displayName: '待确认物料' }));
    await itemCodeRepository(main.db).save(code);
    const reports = factoryReportRepository(main.db);
    const demand = await reports.get(sample.id);
    if (demand.demand === null) throw new Error('合成样本缺少需求');
    const { poNorm } = await purchaseOrderRepository(main.db).get(sample.orderId);
    await reports.save({ ...demand, demand: { ...demand.demand, poNorm } });
    const transitId = entityId(`z-${sample.id}-transit`);
    await reports.save(aFactoryStockRow({
      id: transitId, importBatchId: sample.importId, factoryPartyId: sample.factoryId, fingerprint: transitId, kind: 'in_transit',
      inTransit: { poRaw: sample.poRaw, poNorm, itemCodeRaw: code.codeNorm, nameRaw: '合成包材', barcodeRaw: null, qtyRequired: 50 },
    }));
    const paused = gate();
    const links = factoryLinkQueries(main.db);
    const bulkRelink = makeRelinkFactoryRows({
      ...writes(main.db, { afterDemandSave: async () => { if (!paused.hasEntered()) await paused.hold(); } }),
      links: {
        ...links,
        listOrderLineRefs: async () => (await links.listOrderLineRefs()).filter(({ orderLineId }) => orderLineId === sample.lineId),
        listFactoryRowRefs: async () => (await links.listFactoryRowRefs()).filter(({ rowId }) => rowId === transitId || rowId === demand.id),
      },
    });
    const review = makeResolveMultiName(reviewWrites(competing.db, { nextId: keys.firstItem }));
    try {
      expect(await overlap(fixture, {
        paused,
        first: async () => expect(await bulkRelink({ limit: 2 }, sample.reviewer)).toMatchObject({ factoryLinked: 1, conflicts: 1 }),
        second: () => review({ codeId: code.id, mode: 'same_item', displayName: '合成包材' }, sample.reviewer),
      })).toEqual({ codeId: code.id });
      expect(await reports.get(transitId)).toMatchObject({ linkStatus: 'linked', linkedOrderLineId: sample.lineId });
      expect(await reports.get(sample.id)).toMatchObject({ linkStatus: 'linked', linkedOrderLineId: sample.lineId });
    } finally {
      await main.exec(`delete from factory_in_transit_rows where id = '${transitId}'`);
    }
  });
}, 15000);

async function overlap<T>({ main, applicationName }: Fixture, input: {
  readonly paused: ReturnType<typeof gate>; readonly first: () => Promise<unknown>; readonly second: () => Promise<T>;
}): Promise<T | undefined> {
  const holding = input.first();
  let competing: Promise<T> | undefined;
  try {
    await Promise.race([input.paused.entered, holding]);
    const other = settled(input.second());
    competing = other.result;
    await expect.poll(() => blockedOnPostgres(main, applicationName), wait).toBe(true);
  } finally {
    input.paused.release();
    await Promise.allSettled(competing === undefined ? [holding] : [holding, competing]);
  }
  await holding;
  return competing;
}

function reviewWrites(db: AppDatabase, { nextId, afterAudit }: { readonly nextId: EntityId; readonly afterAudit?: () => Promise<void> }) {
  const uow = createUnitOfWork(db, (transaction) => {
    const tx = requireDatabase(transaction);
    const audit = auditRepository(tx);
    return {
      ...placeholderStores(), itemCodes: itemCodeRepository(tx), items: itemRepository(tx), itemNames: itemNameRepository(tx),
      codeLinks: codeLinkRepository(tx), factoryReports: factoryReportRepository(tx), purchaseOrders: purchaseOrderRepository(tx),
      orderLines: orderLineRepository(tx), batches: deliveryBatchRepository(tx),
      audit: { ...audit, async record(entry: Parameters<typeof audit.record>[0]) { await audit.record(entry); await afterAudit?.(); } },
    };
  });
  return { uow, clock, ids: { ...systemIds(), next: () => nextId } };
}

function reviewCode({ id, codeRaw, itemId, codeType = 'pack_30' }: Pick<ItemCode, 'id' | 'codeRaw' | 'itemId'> & Partial<Pick<ItemCode, 'codeType'>>): ItemCode {
  return { id, createdAt: clock.now(), updatedAt: clock.now(), codeType, codeRaw, codeNorm: codeRaw, itemId, status: itemId === null ? 'pending' : 'approved' };
}

async function seedReviewLine({ fixture, codes }: { readonly fixture: Fixture; readonly codes: readonly [ItemCode, ItemCode] }): Promise<void> {
  const { main, sample } = fixture;
  const items = itemRepository(main.db);
  const codesRepository = itemCodeRepository(main.db);
  for (const code of codes) {
    if (code.itemId === null) throw new Error('合成编码缺少物料');
    await items.save(anItem({ id: code.itemId, displayName: '订单旧名' }));
    await codesRepository.save(code);
  }
  await seedLine({ db: main.db, sample, id: sample.lineId });
  const lines = orderLineRepository(main.db);
  const line = await lines.get(sample.lineId);
  await lines.save({ ...line, nameRaw: '订单旧名', itemId: codes[0].itemId });
}

function reviewKeys(id: string) {
  return {
    left: entityId(`review-left-${id}`), right: entityId(`review-right-${id}`),
    firstItem: entityId(`review-first-${id}`), secondItem: entityId(`review-second-${id}`),
  };
}

async function withReviewFixture(run: (fixture: Fixture, keys: ReturnType<typeof reviewKeys>) => Promise<void>): Promise<void> {
  await withFixture(async (fixture) => {
    const keys = reviewKeys(fixture.sample.id);
    try {
      await run(fixture, keys);
    } finally {
      await fixture.main.exec(`
        delete from item_codes where id in ('${keys.left}', '${keys.right}');
        delete from name_decisions where item_id in ('${keys.firstItem}', '${keys.secondItem}');
        delete from item_names where item_id in ('${keys.firstItem}', '${keys.secondItem}');
        delete from items where id in ('${keys.firstItem}', '${keys.secondItem}');
      `);
    }
  });
}
