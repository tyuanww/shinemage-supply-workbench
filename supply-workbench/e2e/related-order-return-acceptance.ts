import assert from 'node:assert/strict';
import type { Page } from '../node_modules/.pnpm/node_modules/playwright/index.js';
import { seedDemoFixture } from './procurement-today-acceptance.ts';

export async function checkRelatedOrderReturn(page: Page, shared: URL, origin: URL) {
  seedDemoFixture(new URL('../fixtures/demo/factory-import-focus.sql', import.meta.url));
  for (const viewport of [{ width: 1440, height: 900 }, { width: 320, height: 667 }]) {
    await page.setViewportSize(viewport);
    await checkRelatedOrderFocusHistory(page, shared);
    await checkGlobalSearchReturn(page, origin);
  }
}

async function checkRelatedOrderFocusHistory(page: Page, shared: URL) {
  const preview = new URL(shared);
  preview.searchParams.set('q', 'FS-MANUAL');
  preview.searchParams.set('drawer', 'preview');
  preview.searchParams.set('lineId', 'scope-line-manual');
  await page.goto(preview.href);
  const drawer = page.getByRole('dialog', { name: 'FS-MANUAL 预览', exact: true });
  const detailBatch = drawer.getByRole('link', { name: '查看第 1 批', exact: true }).and(page.locator('a[href]'));
  const focusedBatch = page.getByRole('region', { name: '批次', exact: true }).locator('li:focus');
  await detailBatch.press('Enter');
  await focusedBatch.waitFor();
  const original = page.url();
  assert.equal(new URL(original).searchParams.get('focusBatch'), 'scope-manual-batch-focus');
  const related = page.getByRole('region', { name: '关联采购事项', exact: true });
  const outside = related.getByRole('link', { name: /FS-COMPONENT$/u }).and(page.locator('a[href]'));
  const inside = related.getByRole('link', { name: /FS-COMPONENT-C$/u }).and(page.locator('a[href]'));
  await outside.press('Enter');
  await page.getByRole('link', { name: '返回原订单', exact: true }).press('Enter');
  await page.waitForURL(original);
  await outside.and(page.locator(':focus')).waitFor();
  await page.goBack();
  await page.getByRole('heading', { name: 'FS-COMPONENT', exact: true }).waitFor();
  await page.goForward();
  await page.waitForURL(original);
  await outside.and(page.locator(':focus')).waitFor();
  await outside.press('Enter');
  await page.getByRole('heading', { name: 'FS-COMPONENT', exact: true }).waitFor();
  await page.goBack();
  await page.waitForURL(original);
  await outside.and(page.locator(':focus')).waitFor();
  await inside.press('Enter');
  await page.getByRole('heading', { name: 'FS-COMPONENT-C', exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('importBatchId'), shared.searchParams.get('importBatchId'));
  await page.goBack();
  await page.waitForURL(original);
  await inside.and(page.locator(':focus')).waitFor();
  await page.getByRole('link', { name: '返回跟进中心', exact: true }).press('Enter');
  await page.waitForURL((url) => url.pathname === '/lines');
  await page.getByRole('region', { name: '订单查询结果', exact: true })
    .getByRole('link', { name: 'FS-MANUAL', exact: true }).and(page.locator(':focus')).waitFor();
  await page.goBack();
  await page.waitForURL(original);
  await inside.waitFor();
  await focusedBatch.waitFor();
  assert.equal(await related.locator('a:focus').count(), 0);

  async function throughMember() {
    await inside.press('Enter');
    const source = page.getByRole('region', { name: '采购事项来源', exact: true });
    await source.getByRole('link', { name: /FS-MANUAL$/u }).and(page.locator('a[href]')).press('Enter');
    await outside.waitFor();
  }
  await throughMember();
  const ordinary = page.url();
  await outside.press('Enter');
  await page.getByRole('link', { name: '返回原订单', exact: true }).press('Enter');
  await outside.and(page.locator(':focus')).waitFor();
  await throughMember();
  await page.waitForURL(ordinary);
  await afterFocusEffects(page);
  assert.equal(await related.locator('a:focus').count(), 0);

  await page.goto(preview.href);
  await detailBatch.press('Enter');
  await focusedBatch.waitFor();
  const batchAddress = page.url();
  await outside.press('Enter');
  await page.getByRole('heading', { name: 'FS-COMPONENT', exact: true }).waitFor();
  await page.evaluate(() => window.history.go(-2));
  await page.waitForURL(preview.href);
  await detailBatch.waitFor();
  await page.goForward();
  await page.waitForURL(batchAddress);
  await outside.waitFor();
  await focusedBatch.waitFor();
  assert.equal(await related.locator('a:focus').count(), 0);
  const component = page.getByRole('heading', { name: 'FS-COMPONENT', exact: true });
  await page.goForward();
  await component.waitFor();
  await page.goBack();
  await page.waitForURL(batchAddress);
  await outside.and(page.locator(':focus')).waitFor();

  await page.goForward();
  await component.waitFor();
  const isOriginalDetail = (url: URL) => url.pathname === '/api/v1/lines/scope-line-manual';
  let resumeRead: () => void = () => undefined;
  const paused = new Promise<void>((resolve) => { resumeRead = resolve; });
  await page.route(isOriginalDetail, async (route) => {
    await paused;
    await route.continue().catch(() => undefined);
  }, { times: 1 });
  try {
    await Promise.all([page.waitForRequest((request) => isOriginalDetail(new URL(request.url()))), page.goBack()]);
    await page.waitForURL(batchAddress);
    await page.goForward();
    await component.waitFor();
  } finally {
    resumeRead();
    await page.unroute(isOriginalDetail);
  }
  await page.goBack();
  await page.waitForURL(batchAddress);
  await outside.and(page.locator(':focus')).waitFor();
  await outside.press('Enter');
  await component.waitFor();
  await returnWhileSessionIsLoading(page, batchAddress);
  await outside.and(page.locator(':focus')).waitFor();
  await outside.press('Enter');
  await component.waitFor();
  await saveNoteWhileReturning(page, batchAddress);
  await openBatchWithModifier(page, batchAddress);
}

async function openBatchWithModifier(page: Page, address: string) {
  const isDetail = (url: URL) => url.pathname === '/api/v1/lines/scope-line-manual';
  let release: () => void = () => undefined;
  const paused = new Promise<void>(resolve => { release = resolve; });
  await page.route(isDetail, async route => {
    await paused;
    await route.continue().catch(() => undefined);
  });
  const batch = page.getByRole('region', { name: '批次', exact: true }).locator('li:focus');
  try {
    await Promise.all([page.waitForRequest(request => isDetail(new URL(request.url()))), page.goto(address)]);
    assert.equal(await batch.count(), 0);
    // Reading the window title with NVDA can send a lone Control to the document.
    await page.keyboard.press('Control');
    release();
    await batch.getByRole('button', { name: '回查第 1 批原表', exact: true }).waitFor();
  } finally {
    release();
    await page.unroute(isDetail);
  }
}

async function saveNoteWhileReturning(page: Page, source: string) {
  const batch = new URL(source).searchParams.get('importBatchId');
  const isMembership = (url: URL) => url.pathname === '/api/v1/lines' && url.searchParams.get('importBatchId') === batch
    && url.searchParams.getAll('lineIds').includes('scope-line-component-c');
  let release: () => void = () => undefined;
  const paused = new Promise<void>((resolve) => { release = resolve; });
  await page.route(isMembership, async (route) => {
    await paused;
    await route.continue().catch(() => undefined);
  }, { times: 1 });
  const related = page.getByRole('region', { name: '关联采购事项', exact: true }).getByRole('link', { name: /FS-COMPONENT$/u });
  try {
    await Promise.all([page.waitForRequest((request) => isMembership(new URL(request.url()))), page.goBack()]);
    await page.waitForURL(source);
    await related.and(page.locator('[aria-busy="true"]')).waitFor();
    const note = page.getByRole('region', { name: '订单行备注', exact: true });
    const text = `关联订单返回等待中的备注 ${page.viewportSize()?.width}`;
    await note.getByRole('textbox').fill(text);
    const [saved] = await Promise.all([
      page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/v1/follow-ups'),
      note.getByRole('button', { name: '保存备注', exact: true }).click(),
    ]);
    assert.ok(saved.ok());
    await note.getByText(text, { exact: true }).waitFor();
    await related.and(page.locator('[aria-busy="true"]')).waitFor();
    assert.equal(await page.evaluate(() => document.activeElement === document.body), true);
    const loaded = page.waitForResponse(response => isMembership(new URL(response.url())) && response.request().method() === 'GET');
    release();
    assert.ok((await loaded).ok());
  } finally {
    release();
    await page.unroute(isMembership);
  }
  await related.and(page.locator('a[href]')).waitFor();
  const member = page.getByRole('region', { name: '关联采购事项', exact: true }).getByRole('link', { name: /FS-COMPONENT-C$/u }).and(page.locator('a[href]'));
  await member.waitFor();
  const href = await member.getAttribute('href');
  assert.equal(new URL(href ?? '', source).searchParams.get('importBatchId'), batch);
  await afterFocusEffects(page);
  assert.equal(await related.and(page.locator(':focus')).count(), 0);
}

async function returnWhileSessionIsLoading(page: Page, source: string) {
  const isSession = (url: URL) => url.pathname === '/api/v1/me';
  let release: () => void = () => undefined;
  const paused = new Promise<void>((resolve) => { release = resolve; });
  await page.route(isSession, async (route) => {
    await paused;
    await route.continue().catch(() => undefined);
  });
  try {
    await Promise.all([
      page.waitForRequest((request) => isSession(new URL(request.url()))),
      page.reload({ waitUntil: 'domcontentloaded' }),
    ]);
    await page.goBack({ waitUntil: 'commit' });
    await page.waitForURL(source);
    assert.equal(await page.getByRole('button', { name: '搜索单号、品名、供应商', exact: true }).count(), 0);
  } finally {
    release();
    await page.unroute(isSession);
  }
}

export function afterFocusEffects(page: Page) {
  return page.evaluate(() => new Promise<void>((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()))));
}

async function checkGlobalSearchReturn(page: Page, origin: URL) {
  const original = new URL('/lines/scope-line-manual?focus=buyer', origin);
  await page.goto(original.href);
  const owner = page.getByRole('region', { name: '订单负责人', exact: true });
  const related = page.getByRole('region', { name: '关联采购事项', exact: true })
    .getByRole('link', { name: /FS-COMPONENT$/u });
  const component = page.getByRole('heading', { name: 'FS-COMPONENT', exact: true });
  await owner.and(page.locator(':focus')).waitFor();
  await related.press('Enter');
  await component.waitFor();
  const destination = page.url();
  await page.goBack();
  await related.and(page.locator(':focus')).waitFor();

  const trigger = page.getByRole('button', { name: '搜索单号、品名、供应商', exact: true });
  const search = page.getByRole('dialog', { name: '搜索', exact: true });
  const input = search.getByPlaceholder('单号 / 品名 / 编码');
  async function chooseOrder() {
    await trigger.press('Enter');
    await input.fill('FS-COMPONENT');
    await search.locator('a[href="/lines/scope-line-component"]').press('Enter');
    await page.waitForURL(destination);
  }

  await chooseOrder();
  await component.waitFor();
  await page.getByPlaceholder('单号 / 品名 / 编码').waitFor({ state: 'detached' });
  assert.equal(page.url(), destination);
  await trigger.and(page.locator(':focus')).waitFor();
  await page.goBack();
  await page.waitForURL(original.href);
  await owner.and(page.locator(':focus')).waitFor();
  await chooseOrder();
  await page.goBack();
  await page.waitForURL(original.href);
  await owner.and(page.locator(':focus')).waitFor();

  await chooseOrder();
  await trigger.and(page.locator(':focus')).waitFor();
  await trigger.press('Enter');
  await input.fill('继续搜索');
  await page.goBack();
  await page.waitForURL(original.href);
  await page.locator('[aria-label="订单负责人"]').waitFor({ state: 'attached' });
  await afterFocusEffects(page);
  assert.equal(await input.and(page.locator(':focus')).count(), 1);
  await input.press('Escape');
  await trigger.and(page.locator(':focus')).waitFor();
}
