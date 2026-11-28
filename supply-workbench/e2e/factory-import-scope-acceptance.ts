import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { URLSearchParams } from 'node:url';
import type { Page } from '../node_modules/.pnpm/node_modules/playwright/index.js';
import { seedDemoFixture } from './procurement-today-acceptance.ts';
import { afterFocusEffects, checkRelatedOrderReturn } from './related-order-return-acceptance.ts';

const requireWeb = createRequire(new URL('../packages/report-renderers/package.json', import.meta.url));
const xlsx: typeof import('../node_modules/.pnpm/node_modules/xlsx/types/index.js') = requireWeb('xlsx');
const scopeId = 'scope-import-current';
const currentStore = 'dafuyan';
const storeOrderPos = ['FS-MANUAL', 'FS-MATCHED'];
const currentFactoryOrderPos = [...storeOrderPos, 'FS-YILING'];
const sourceName = '核对本次导入来源';
const destinationName = '查看本次实际关联的订单';

export async function checkFactoryImportScope({ buyer, manager, origin }: {
  readonly buyer: Page; readonly manager: Page; readonly origin: URL;
}) {
  seedDemoFixture(new URL('../fixtures/demo/factory-import-scope.sql', import.meta.url));
  await buyer.setViewportSize({ width: 1440, height: 900 });
  await manager.setViewportSize({ width: 1440, height: 900 });
  await assertFactoryScopeApi({ page: buyer, origin, id: scopeId, expected: currentFactoryOrderPos });
  await assertFactoryScopeApi({ page: buyer, origin, id: 'scope-import-other-batch', expected: ['FS-OTHER-BATCH'] });
  await assertFactoryScopeApi({ page: buyer, origin, id: 'scope-import-other-factory', expected: ['FS-OTHER-FACTORY'] });
  await assertFactoryScopeApi({ page: buyer, origin, id: scopeId, expected: ['FS-YILING'], store: 'yiling' });
  const shared = await checkFactorySourceRoundTrip(buyer, origin);
  await checkCopiedSourceFromAnotherStore(buyer, shared);
  await checkCopiedSourceWithNoStore(buyer, shared);
  await checkFactorySourceCannotBecomeProcurement(buyer, shared);
  await checkRelatedBatchMember(buyer, origin);
  await checkDetachedFactoryDetail(buyer, shared);
  await checkEmptyFactorySource(buyer, origin);
  const denied = await manager.request.get(new URL(`/api/v1/imports/${scopeId}`, origin).href);
  assert.equal(denied.status(), 403);
  await manager.goto(shared.href);
  await assertFactoryScopeRows(manager);
  assert.equal(await manager.getByRole('link', { name: '返回导入批次', exact: true }).count(), 0);
  await checkSharedOrderView(manager, shared);
  await checkSharedProcurementReturn({ page: manager, origin });
  await checkSharedProcurementReturn({ page: manager, origin, store: currentStore });
  await checkPendingPreviewReturn(buyer, origin);
  await checkDelayedDetailReturnFocus(buyer, shared);
  await checkRelatedOrderReturn(buyer, shared, origin);
  return { associatedOrders: currentFactoryOrderPos, scopedOrders: storeOrderPos, exportMatches: true,
    emptyHasNoLink: true, returnFocus: true, managerImportStatus: denied.status(), sharedOrdersMatch: true,
    sharedPresetKeepsStore: true, copiedSourceKeepsStore: true, unfilteredSourceKeepsStore: true, actualTemplateKeepsScope: true,
    relatedOrdersKeepTrueScope: true, relatedOrderReturnFocus: true, detachedDetailChecksMembership: true, sharedFilteredReturn: true,
    pendingPreviewReturn: true, delayedDetailReturnFocus: true, delayedReturnKeepsSearchFocus: true, relatedOrderFocusFollowsHistory: true };
}

function factoryRelatedComponent(page: Page) {
  return page.getByRole('region', { name: '关联采购事项', exact: true }).getByRole('link', { name: /FS-COMPONENT/ }).and(page.locator('a[href]'));
}

async function checkRelatedBatchMember(page: Page, origin: URL) {
  const purchaseBatch = 'scope-import-store-evidence';
  await page.goto(new URL(`/lines?importBatchId=${purchaseBatch}&store=${currentStore}&q=FS-MANUAL`, origin).href);
  const original = page.getByRole('link', { name: 'FS-MANUAL', exact: true });
  await original.press('Enter');
  const related = factoryRelatedComponent(page).and(page.locator(`a[href*="importBatchId=${purchaseBatch}"]`));
  await related.press('Enter');
  await page.getByRole('heading', { name: 'FS-COMPONENT', exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('store'), currentStore);
  await page.getByRole('link', { name: '返回跟进中心', exact: true }).press('Enter');
  await original.and(page.locator(':focus')).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('q'), 'FS-MANUAL');
}

async function checkDetachedFactoryDetail(page: Page, shared: URL) {
  const preview = new URL(shared);
  preview.searchParams.set('drawer', 'preview');
  preview.searchParams.set('lineId', 'scope-line-component');
  await page.goto(preview.href);
  const drawer = page.getByRole('dialog', { name: 'FS-COMPONENT 预览', exact: true });
  const detail = drawer.getByRole('link', { name: '打开订单行详情', exact: true }).and(page.locator('a[href]'));
  const ordinary = new URL(await detail.getAttribute('href') ?? '', shared);
  assert.equal(ordinary.search, `?store=${currentStore}`);
  ordinary.search = shared.search;
  const [membership] = await Promise.all([
    page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === '/api/v1/lines' && url.searchParams.get('lineIds') === 'scope-line-component';
    }),
    page.goto(ordinary.href),
  ]);
  assert.deepEqual((await membership.json()).items, []);
  await page.getByRole('heading', { name: 'FS-COMPONENT', exact: true }).waitFor();
  for (const name of ['返回导入批次', '返回本批订单']) {
    assert.equal(await page.getByRole('link', { name, exact: true }).count(), 0);
  }
}

async function checkRelatedOutsideFactoryBatch(page: Page, origin: URL) {
  const scopedRow = page.getByRole('link', { name: 'FS-MANUAL', exact: true }).and(page.locator('a[href]'));
  const [membership] = await Promise.all([
    page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === '/api/v1/lines' && url.searchParams.get('lineIds') === 'scope-line-component';
    }),
    scopedRow.press('Enter'),
  ]);
  const lookup = new URL(membership.url()).searchParams;
  assert.equal(lookup.get('importBatchId'), scopeId);
  assert.equal(lookup.get('store'), currentStore);
  assert.deepEqual((await membership.json()).items, []);
  const from = page.url();
  const related = factoryRelatedComponent(page);
  const address = new URL(await related.getAttribute('href') ?? '', origin);
  assert.equal(address.search, `?store=${currentStore}`);
  await related.press('Enter');
  await page.getByRole('heading', { name: 'FS-COMPONENT', exact: true }).waitFor();
  assert.equal(await page.getByRole('link', { name: '返回导入批次', exact: true }).count(), 0);
  await page.goBack();
  await page.waitForURL(from);
  await related.and(page.locator(':focus')).waitFor();

  await related.press('Enter');
  await page.getByRole('link', { name: '返回原订单', exact: true }).press('Enter');
  await page.waitForURL(from);
  await related.and(page.locator(':focus')).waitFor();
  await page.getByRole('link', { name: '返回跟进中心', exact: true }).press('Enter');
  await scopedRow.and(page.locator(':focus')).waitFor();
}

async function checkCopiedSourceFromAnotherStore(page: Page, shared: URL) {
  await page.goto(shared.href);
  await assertFactoryScopeRows(page);
  const order = page.getByRole('region', { name: '订单查询结果', exact: true })
    .getByRole('link', { name: 'FS-MANUAL', exact: true }).and(page.locator('a[href]'));
  const detail = new URL(await order.getAttribute('href') ?? '', shared);
  assert.equal(detail.searchParams.get('store'), currentStore);
  const source = new URL(detail.searchParams.get('backToImport') ?? '', shared);
  assert.equal(source.pathname, `/imports/${scopeId}`);
  assert.equal(source.searchParams.get('store'), currentStore);
  await page.goto(detail.href);
  const back = page.getByRole('link', { name: '返回导入批次', exact: true });
  await back.waitFor();

  source.searchParams.set('store', 'yiling');
  detail.searchParams.set('backToImport', source.pathname + source.search);
  await page.goto(detail.href);
  await page.getByRole('heading', { name: 'FS-MANUAL', exact: true }).waitFor();
  assert.deepEqual(await back.evaluateAll((links) => links.map((link) => link.getAttribute('href'))), [],
    '达肤妍订单不能返回同批次的译龄抽屉');
  await page.getByRole('link', { name: '返回本批订单', exact: true }).press('Enter');
  await page.waitForURL((url) => url.pathname === '/lines' && url.searchParams.get('importBatchId') === scopeId
    && url.searchParams.get('store') === currentStore && !url.searchParams.has('backToImport'));
  await assertFactoryScopeRows(page);
}

async function checkCopiedSourceWithNoStore(page: Page, shared: URL) {
  const source = new URL(shared.searchParams.get('backToImport') ?? '', shared);
  source.searchParams.set('store', 'yiling');
  for (const store of [null, 'invalid-store']) {
    const list = new URL(shared);
    if (store === null) list.searchParams.delete('store');
    else list.searchParams.set('store', store);
    list.searchParams.set('backToImport', source.pathname + source.search);
    await page.goto(list.href);
    const rows = page.getByRole('region', { name: '订单查询结果', exact: true });
    await rows.getByRole('link', { name: 'FS-YILING', exact: true }).and(page.locator('a[href]')).waitFor();
    assert.equal(await page.getByRole('link', { name: '返回导入批次', exact: true }).count(), 0);
    const order = rows.getByRole('link', { name: 'FS-MANUAL', exact: true }).and(page.locator('a[href]'));
    const detail = new URL(await order.getAttribute('href') ?? '', shared);
    assert.equal(detail.searchParams.has('backToImport'), false);
    detail.search = list.search;
    await page.goto(detail.href);
    await page.getByRole('heading', { name: 'FS-MANUAL', exact: true }).waitFor();
    assert.equal(await page.getByRole('link', { name: '返回导入批次', exact: true }).count(), 0);
    await page.getByRole('link', { name: '返回本批订单', exact: true }).press('Enter');
    await page.waitForURL((url) => url.pathname === '/lines' && url.searchParams.get('importBatchId') === scopeId
      && !url.searchParams.has('store') && !url.searchParams.has('backToImport'));
    await rows.getByRole('link', { name: 'FS-YILING', exact: true }).and(page.locator('a[href]')).waitFor();
    assert.deepEqual((await rows.locator('th[scope="row"] a').allTextContents()).sort(), currentFactoryOrderPos);
  }
}

async function checkFactorySourceCannotBecomeProcurement(page: Page, shared: URL) {
  const destination = new URL(shared);
  destination.searchParams.delete('store');
  const source = new URL(shared.searchParams.get('backToImport') ?? '', shared);
  source.searchParams.set('template', 'po-master-v1');
  source.searchParams.set('store', 'yiling');
  for (const key of ['batch', 'procurement-batch']) {
    source.searchParams.set('source', key);
    destination.searchParams.set('backToImport', source.pathname + source.search);
    const [summary] = await Promise.all([
      page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/imports/${scopeId}`),
      page.goto(destination.href),
    ]);
    assert.ok(summary.ok());
    assert.equal((await summary.json()).template, 'factory-progress-v1');
    const rows = page.getByRole('region', { name: '订单查询结果', exact: true });
    await rows.getByRole('link', { name: 'FS-YILING', exact: true }).and(page.locator('a[href]')).waitFor();
    assert.equal(await page.getByRole('link', { name: '返回导入批次', exact: true }).count(), 0);
    assert.deepEqual((await rows.locator('th[scope="row"] a').allTextContents()).sort(), currentFactoryOrderPos);
  }
}

async function checkSharedProcurementReturn({ page, origin, store }: {
  readonly page: Page; readonly origin: URL; readonly store?: string;
}) {
  const batchId = 'scope-import-store-evidence';
  const filters = new URLSearchParams({ importBatchId: batchId, lane: 'finished', q: 'FS-MANUAL', buyer: 'unassigned', pageSize: '5' });
  if (store !== undefined) filters.set('store', store);
  const list = new URL(`/lines?${filters}`, origin);
  list.searchParams.set('backToImport', `/imports/${batchId}?drawer=import-source&source=procurement-batch`);
  assert.equal((await page.request.get(new URL(`/api/v1/imports/${batchId}`, origin).href)).status(), 403);
  await page.goto(list.href);
  const row = page.getByRole('link', { name: 'FS-MANUAL', exact: true });
  await row.press('Enter');
  await page.getByRole('heading', { name: 'FS-MANUAL', exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.has('backToImport'), false);
  await page.getByRole('link', { name: '返回跟进中心', exact: true }).press('Enter');
  await row.and(page.locator(':focus')).waitFor();
  assert.equal(new URL(page.url()).searchParams.toString(), filters.toString());
}

async function checkPendingPreviewReturn(page: Page, origin: URL) {
  const batchId = 'scope-import-store-evidence';
  const isMembership = (url: URL) => url.pathname === '/api/v1/lines' && url.searchParams.get('lineIds') === 'scope-line-manual';
  let finish: () => void = () => undefined;
  const paused = new Promise<void>((resolve) => { finish = () => { resolve(); }; });
  await page.route(isMembership, async (route) => {
    await paused;
    await route.continue().catch(() => undefined);
  });
  const filters = new URLSearchParams({ importBatchId: batchId, store: currentStore, q: 'FS-MANUAL' });
  const list = new URL(`/lines?${filters}`, origin);
  list.searchParams.set('drawer', 'preview');
  list.searchParams.set('lineId', 'scope-line-manual');
  try {
    await page.goto(list.href);
    const preview = page.getByRole('dialog', { name: 'FS-MANUAL 预览', exact: true });
    const link = preview.getByRole('link', { name: '打开订单行详情', exact: true });
    assert.equal(await link.getAttribute('aria-disabled'), 'true');
    assert.equal(await link.getAttribute('href'), null);
    await link.dispatchEvent('click');
    assert.equal(page.url(), list.href);
    finish();
    await link.and(page.locator('a[href]')).press('Enter');
    await page.getByRole('link', { name: '返回跟进中心', exact: true }).press('Enter');
    await page.getByRole('link', { name: 'FS-MANUAL', exact: true }).and(page.locator(':focus')).waitFor();
    assert.equal(new URL(page.url()).searchParams.toString(), filters.toString());
  } finally {
    finish();
    await page.unroute(isMembership);
  }
}

async function checkDelayedDetailReturnFocus(page: Page, shared: URL) {
  const address = new URL(shared);
  address.searchParams.set('q', 'FS-MANUAL');
  const isTemplate = (url: URL) => url.pathname === `/api/v1/imports/${scopeId}`;
  const results = page.getByRole('region', { name: '订单查询结果', exact: true });
  const row = results.getByRole('link', { name: 'FS-MANUAL', exact: true });
  const order = row.and(page.locator('a[href]'));
  const search = page.getByLabel('搜索单号、品名或编码', { exact: true });
  for (const { isExpectedSuccess, isTyping } of [
    { isExpectedSuccess: true, isTyping: false },
    { isExpectedSuccess: false, isTyping: false },
    { isExpectedSuccess: true, isTyping: true },
  ]) {
    await page.goto(address.href);
    const [summary] = await Promise.all([
      page.waitForResponse((response) => isTemplate(new URL(response.url()))),
      order.press('Enter'),
    ]);
    assert.ok(summary.ok());
    await page.getByRole('heading', { name: 'FS-MANUAL', exact: true }).waitFor();
    let finish: () => void = () => undefined;
    const paused = new Promise<void>((resolve) => { finish = resolve; });
    await page.route(isTemplate, async (route) => {
      await paused;
      if (isExpectedSuccess) await route.continue();
      else await route.abort();
    }, { times: 1 });
    try {
      await page.getByRole('link', { name: '返回跟进中心', exact: true }).press('Enter');
      await page.waitForURL(address.href);
      await row.and(page.locator('[aria-busy="true"]')).waitFor();
      await afterFocusEffects(page);
      assert.equal(await results.and(page.locator(':focus')).count(), 0);
      if (isTyping) {
        const focused = search.and(page.locator(':focus'));
        for (let tab = 0; tab < 45 && await focused.count() === 0; tab++) await page.keyboard.press('Tab');
        assert.equal(await focused.count(), 1);
        await page.keyboard.press('ControlOrMeta+a');
        await page.keyboard.type('probe-first');
        assert.equal(await search.inputValue(), 'probe-first');
      }
      finish();
      if (isTyping) {
        await order.waitFor();
        await page.keyboard.type('-second');
        assert.equal(await search.and(page.locator(':focus')).count(), 1);
        assert.equal(await search.inputValue(), 'probe-first-second');
      } else {
        await order.and(page.locator(':focus')).waitFor();
      }
      assert.equal(await page.getByRole('link', { name: '返回导入批次', exact: true }).count(), Number(isExpectedSuccess));
    } finally {
      finish();
      await page.unroute(isTemplate);
    }
  }
}

async function checkSharedOrderView(page: Page, shared: URL) {
  const address = new URL(shared);
  address.searchParams.delete('backToImport');
  address.searchParams.set('lens', 'delivery');
  await page.goto(address.href);
  await assertFactoryScopeRows(page);
  assert.equal(await page.getByRole('radiogroup', { name: '订单查法', exact: true }).count(), 0);
  const [lines] = await Promise.all([
    page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === '/api/v1/lines' && url.searchParams.get('stages') === 'no_batch';
    }),
    page.getByRole('radiogroup', { name: '常用视图' }).getByText('未建要货', { exact: true }).click(),
  ]);
  const filters = new URL(lines.url()).searchParams;
  assert.equal(filters.get('importBatchId'), scopeId);
  assert.equal(filters.get('store'), currentStore);
  assert.deepEqual((await lines.json()).items.map((row: { po: { poRaw: string } }) => row.po.poRaw).sort(), storeOrderPos);
  const [summary] = await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/lines/summary'),
    page.getByRole('button', { name: '筛选结果概览', exact: true }).click(),
  ]);
  assert.equal((await summary.json()).total, storeOrderPos.length);
  await assertFactoryScopeExport(page, address);
}

async function assertFactoryScopeApi({ page, origin, id, expected, store }: {
  readonly page: Page; readonly origin: URL; readonly id: string; readonly expected: readonly string[]; readonly store?: string;
}) {
  const query = new URLSearchParams({ importBatchId: id });
  if (store !== undefined) query.set('store', store);
  const response = await page.request.get(new URL(`/api/v1/lines?${query}`, origin).href);
  assert.ok(response.ok(), await response.text());
  const { items, page: pagination }: { items: readonly { po: { poRaw: string } }[]; page: { total: number } } = await response.json();
  assert.equal(pagination.total, expected.length);
  assert.deepEqual(items.map((row) => row.po.poRaw).sort(), expected);
}

async function checkFactorySourceRoundTrip(page: Page, origin: URL) {
  const history = new URL(`/imports?template=factory-progress-v1&status=committed&store=${currentStore}`, origin);
  await page.goto(history.href);
  const batch = page.getByRole('link', { name: 'scope-file-current', exact: true });
  await batch.press('Enter');
  await page.waitForURL((url) => url.pathname === `/imports/${scopeId}`);
  const trigger = page.getByRole('button', { name: sourceName, exact: true });
  const [lookup] = await Promise.all([
    page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === '/api/v1/lines' && url.searchParams.get('pageSize') === '1';
    }),
    trigger.press('Enter'),
  ]);
  const query = new URL(lookup.url()).searchParams;
  assert.equal(query.get('importBatchId'), scopeId);
  assert.equal(query.get('store'), currentStore);
  assert.ok(lookup.ok());
  const drawer = page.getByRole('dialog', { name: sourceName, exact: true });
  await drawer.getByText('本次导入关联 2 条可查看的订单行。', { exact: true }).waitFor();
  await drawer.getByText('合成导入甲厂', { exact: true }).waitFor();
  const sourceUrl = page.url();
  assert.equal(new URL(sourceUrl).pathname, `/imports/${scopeId}`);
  const orderLink = drawer.getByRole('link', { name: destinationName, exact: true });
  const shared = new URL(await orderLink.getAttribute('href') ?? '', origin);
  await orderLink.press('Enter');
  await page.waitForURL(shared.href);
  await assertFactoryScopeRows(page);
  const [filtered] = await Promise.all([
    page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === '/api/v1/lines' && url.searchParams.get('stages') === 'no_batch';
    }),
    page.getByRole('radiogroup', { name: '常用视图' }).getByText('未建要货', { exact: true }).click(),
  ]);
  assert.ok(filtered.ok());
  await page.waitForURL((url) => url.searchParams.get('view') === 'no-batch');
  await assertFactoryScopeRows(page);
  await assertFactoryScopeExport(page, origin);
  await checkRelatedOutsideFactoryBatch(page, origin);
  await page.getByRole('link', { name: '返回导入批次', exact: true }).press('Enter');
  await page.waitForURL(sourceUrl);
  await orderLink.and(page.locator(':focus')).waitFor();
  await page.keyboard.press('Escape');
  await drawer.waitFor({ state: 'hidden' });
  await trigger.and(page.locator(':focus')).waitFor();
  await page.getByRole('link', { name: '返回导入中心', exact: true }).press('Enter');
  await page.waitForURL(history.href);
  await batch.and(page.locator(':focus')).waitFor();
  return shared;
}

async function assertFactoryScopeRows(page: Page) {
  const rows = page.getByRole('region', { name: '订单查询结果', exact: true });
  await rows.getByRole('link', { name: 'FS-MANUAL', exact: true }).and(page.locator('a[href]')).waitFor();
  assert.deepEqual((await rows.locator('th[scope="row"] a').allTextContents()).sort(), storeOrderPos);
}

async function assertFactoryScopeExport(page: Page, origin: URL) {
  const href = await page.getByRole('link', { name: '导出 Excel', exact: true }).getAttribute('href');
  const address = new URL(href ?? '', origin);
  assert.equal(address.searchParams.get('importBatchId'), scopeId);
  assert.equal(address.searchParams.get('store'), currentStore);
  assert.equal(address.searchParams.get('stages'), 'no_batch');
  const response = await page.request.get(address.href);
  assert.ok(response.ok());
  const book = xlsx.read(await response.body());
  const rows = xlsx.utils.sheet_to_json<string[]>(book.Sheets['订单行'], { header: 1 }).slice(1);
  assert.deepEqual(rows.map((row) => row[0]).sort(), storeOrderPos);
}

async function checkEmptyFactorySource(page: Page, origin: URL) {
  await page.goto(new URL('/imports?template=factory-progress-v1&status=committed', origin).href);
  await page.getByRole('link', { name: 'scope-file-empty', exact: true }).press('Enter');
  await page.getByRole('button', { name: sourceName, exact: true }).press('Enter');
  const drawer = page.getByRole('dialog', { name: sourceName, exact: true });
  await drawer.getByText('当前范围没有可查看的关联记录。', { exact: true }).waitFor();
  assert.equal(await drawer.getByRole('link', { name: destinationName, exact: true }).count(), 0);
  assert.equal(new URL(page.url()).pathname, '/imports/scope-import-empty');
  await page.keyboard.press('Escape');
  await drawer.waitFor({ state: 'hidden' });
}
