import type { ImportTemplate } from '../../packages/application/src/ports/import-template.js';
import type { WorkbookLike } from '../../packages/application/src/ports/workbook-reader.js';
import type { ParsedImport } from '../../packages/application/src/ports/parsed-rows.js';
import { localDate } from '../../packages/domain/src/index.js';
import {
  aBatch,
  createMemory,
  describeDeliveryBatchRepositoryContract,
  describeExceptionRepositoryContract,
  describeFactoryReportRepositoryContract,
  describeFileStoreContract,
  describeFollowUpRepositoryContract,
  describeImportBatchRepositoryContract,
  describeImportTemplateContract,
  describeItemRepositoryContract,
  describeOrderLineRepositoryContract,
  describePartyRepositoryContract,
  describeProductRepositoryContract,
  describePurchaseOrderRepositoryContract,
  describeSettingsRepositoryContract,
  describeUnitOfWorkContract,
  describeUserRepositoryContract,
  describeWeeklyReportRepositoryContract,
  FixedClock,
  SequentialIds,
  aFactoryStockRow,
  aFollowUp,
  aParty,
  aProduct,
  aPurchaseOrder,
  aUser,
  anActor,
  anException,
  anItem,
  anOrderLine,
} from '../../packages/testkit/src/index.js';
import { expect, it } from 'vitest';

const memory = () => createMemory();

describeUserRepositoryContract(() => memory().stores.users);
describePartyRepositoryContract(() => memory().stores.parties);
describeItemRepositoryContract(() => memory().stores.items);
describePurchaseOrderRepositoryContract(() => memory().stores.purchaseOrders);
describeOrderLineRepositoryContract(() => memory().stores.orderLines);
describeExceptionRepositoryContract(() => memory().stores.exceptions);
describeFollowUpRepositoryContract(() => memory().stores.followUps);
describeFactoryReportRepositoryContract(() => memory().stores.factoryReports);
describeImportBatchRepositoryContract(() => memory().stores.imports);
describeProductRepositoryContract(() => memory().stores.products);
describeSettingsRepositoryContract(() => memory().stores.settings);
describeDeliveryBatchRepositoryContract(() => memory().stores.batches);
describeWeeklyReportRepositoryContract(() => memory().stores.weeklyReports);
describeFileStoreContract(() => memory().files);
describeUnitOfWorkContract(() => {
  const created = memory();
  return {
    ...created.unitOfWork,
    readUser: (id) => created.stores.users.find(id),
    auditCount: () => created.box.current.audit.length,
  };
});

it('独立工作单元等待前一笔回滚，再读取已提交的数据', async () => {
  const { unitOfWork, stores } = memory();
  const rolledBack = aUser();
  const committed = aUser();
  let started = () => {};
  let release = () => {};
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const finish = new Promise<void>((resolve) => { release = resolve; });
  const first = unitOfWork.run(async (tx) => {
    await tx.users.save(rolledBack);
    started();
    await finish;
    throw new Error('合成回滚');
  });
  const firstRejected = expect(first).rejects.toThrow('合成回滚');
  await entered;
  const second = unitOfWork.run(async (tx) => {
    const previous = await tx.users.find(rolledBack.id);
    await tx.users.save(committed);
    return previous;
  });
  await Promise.resolve();
  release();
  await firstRejected;
  expect(await second).toBeUndefined();
  expect(await stores.users.find(committed.id)).toEqual(committed);
});

it('工作单元可等待同一异步链的嵌套工作单元回滚', async () => {
  const { unitOfWork, stores } = memory();
  const outer = aUser();
  const inner = aUser();
  await unitOfWork.run(async (tx) => {
    await tx.users.save(outer);
    await expect(unitOfWork.run(async (nested) => {
      expect(await nested.users.find(outer.id)).toEqual(outer);
      await nested.users.save(inner);
      throw new Error('嵌套回滚');
    })).rejects.toThrow('嵌套回滚');
  });
  expect(await stores.users.find(outer.id)).toEqual(outer);
  expect(await stores.users.find(inner.id)).toBeUndefined();
});

describeImportTemplateContract(proofTemplate(), {
  ownFile: book('own.csv'),
  foreignFile: book('other.csv'),
});

it('固定时钟按上海时区给业务日，advance 往后推', () => {
  const clock = new FixedClock('2026-10-11T15:30:00.000Z');
  expect(clock.today()).toBe(localDate('2026-10-11'));
  clock.advance(3600);
  expect(clock.today()).toBe(localDate('2026-10-12'));
});

it('顺序 id 不重复', () => {
  const ids = new SequentialIds();
  expect(ids.next()).not.toBe(ids.next());
});

it('构建器两次调用不共享对象', () => {
  expect(aUser()).not.toBe(aUser());
  expect(anActor('buyer').roles).toEqual(['buyer']);
  expect(aParty().isFactory).toBe(true);
  expect(anItem().kind).toBe('finished');
  expect(aPurchaseOrder().lane).toBe('finished');
  expect(anOrderLine().origin).toBe('manual');
  expect(aFollowUp().kind).toBe('note');
  expect(anException().type).toBe('delay');
  expect(aProduct().skuName).toBe('海葡萄水光冰冰贴');
  expect(aFactoryStockRow().sheetName).toBe('库存数量汇总');
  const built = aBatch().withShipment(2).withReceipt(1).withDeliveryNote().confirmedOn('2026-10-01');
  expect(built.build().status).toBe('confirmed');
  expect(built.records().shipments).toHaveLength(1);
  expect(aBatch().records().shipments).toHaveLength(0);
});

function book(name: string): WorkbookLike {
  return { source: { kind: 'csv', fileName: name }, date1904: false, sheets: [] };
}

function proofTemplate(): ImportTemplate {
  return {
    requiresFactory: false,
    identityOf() {
      return [];
    },
    existingFrom() {
      return { poMaster: [], factoryFingerprints: [], products: [], bomKeys: [] };
    },
    factsOf() {
      return { ignoredSheets: [], codeLinks: [] };
    },
    id: 'po-master-v1',
    detect(file) {
      return file.source.fileName === 'own.csv' ? { score: 1, reasons: ['表头'] } : { score: 0, reasons: [] };
    },
    parse(): ParsedImport {
      return {
        template: 'po-master-v1',
        rows: [{
          sheetName: '总表',
          rowNo: 2,
          issues: [{ code: 'DATE_NO_YEAR', severity: 'warning', column: '首批交付', message: '没有年份', raw: '7月30日' }],
          action: null,
          targetId: null,
          skipReason: null,
          payload: emptyPoPayload(),
        }],
      };
    },
    diff(parsed, existing) {
      if (parsed.template !== 'po-master-v1') return parsed;
      const keys = new Set(existing.poMaster.map((row) => row.candidateKey));
      return {
        ...parsed,
        rows: parsed.rows.map((row) => ({ ...row, action: keys.has(`${row.sheetName}:${row.rowNo}`) ? 'unchanged' : 'create' })),
      };
    },
  };
}

function emptyPoPayload(): Extract<ParsedImport, { template: 'po-master-v1' }>['rows'][number]['payload'] {
  const text = { raw: null, value: null };
  const qty = { raw: null, value: null };
  const date = { raw: null, value: null };
  return {
    oaDemandRef: text,
    supplierRaw: text,
    nameRaw: text,
    barcodeRaw: text,
    qtyOrdered: qty,
    oaSubmittedOn: date,
    oaRequiredOn: date,
    plannedDurationDays: qty,
    po: { raw: null, value: null },
    actualStartOn: date,
    firstDeliveryOn: date,
    actualEndOn: date,
    actualDurationDays: qty,
    factoryStockReported: qty,
    shippedQtyReported: qty,
    qtyDiffReported: qty,
    statusReported: text,
  };
}
