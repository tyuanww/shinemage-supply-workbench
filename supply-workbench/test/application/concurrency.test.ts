import { expect, it } from 'vitest';
import { makeUpdateBatch } from '../../packages/application/src/follow-up/use-cases/update-batch.js';
import { makeUpdateLine } from '../../packages/application/src/follow-up/use-cases/update-line.js';
import { makeUpdateSettings } from '../../packages/application/src/platform/use-cases/update-settings.js';
import { StateConflictError } from '../../packages/application/src/shared/errors.js';
import { anActor, anOrderLine, aBatch, createMemory, FixedClock, SequentialIds } from '../../packages/testkit/src/index.js';

it('订单行、批次和设置的条件写入拒绝过期版本', async () => {
  const memory = createMemory();
  const line = anOrderLine();
  await memory.stores.orderLines.save(line);
  const nextLine = { ...line, nameRaw: '先写入', updatedAt: '2026-10-12T00:00:01.000Z' };
  expect(await memory.stores.orderLines.saveConditional?.(nextLine, line.updatedAt)).toBe(true);
  expect(await memory.stores.orderLines.saveConditional?.({ ...line, nameRaw: '后写入' }, line.updatedAt)).toBe(false);
  expect((await memory.stores.orderLines.get(line.id)).nameRaw).toBe('先写入');

  const batch = aBatch().build();
  await memory.stores.batches.save(batch);
  const nextBatch = { ...batch, plannedQty: 3, updatedAt: '2026-10-12T00:00:01.000Z' };
  const saveBatchConditional = memory.stores.batches.saveWithRecordsConditional;
  if (saveBatchConditional === undefined) throw new Error('测试适配器没有条件批次写入');
  expect(await saveBatchConditional({ batch: nextBatch, shipments: [], receipts: [], deliveryNote: null, dateChanges: [] }, batch.updatedAt)).toBe(true);
  expect(await saveBatchConditional({ batch: { ...batch, plannedQty: 4 }, shipments: [], receipts: [], deliveryNote: null, dateChanges: [] }, batch.updatedAt)).toBe(false);

  const settings = await memory.stores.settings.get();
  const saveSettingsConditional = memory.stores.settings.saveConditional;
  if (saveSettingsConditional === undefined) throw new Error('测试适配器没有条件设置写入');
  expect(await saveSettingsConditional({ ...settings, upcomingDays: 5 }, settings)).toBe(true);
  expect(await saveSettingsConditional({ ...settings, upcomingDays: 6 }, settings)).toBe(false);
});

it('更新用例把条件写入失败转换成可识别的状态冲突', async () => {
  const memory = createMemory();
  const line = anOrderLine();
  await memory.stores.orderLines.save(line);
  const actor = anActor('buyer');
  const clock = new FixedClock('2026-10-12T00:00:02.000Z');
  const ids = new SequentialIds();
  const updateLine = makeUpdateLine({
    uow: {
      run: (fn) => fn({ ...memory.stores, orderLines: { ...memory.stores.orderLines, saveConditional: async () => false } }),
    },
    clock,
    ids,
  });
  await expect(updateLine({ lineId: line.id, nameRaw: '冲突' }, actor)).rejects.toBeInstanceOf(StateConflictError);

  const batch = { ...aBatch().build(), orderLineId: line.id };
  await memory.stores.batches.save(batch);
  const updateBatch = makeUpdateBatch({
    uow: {
      run: (fn) => fn({ ...memory.stores, batches: { ...memory.stores.batches, saveWithRecordsConditional: async () => false } }),
    },
    clock,
    ids,
  });
  await expect(updateBatch({ batchId: batch.id, plannedQty: 2 }, actor)).rejects.toBeInstanceOf(StateConflictError);

  const updateSettings = makeUpdateSettings({
    uow: {
      run: (fn) => fn({ ...memory.stores, settings: { ...memory.stores.settings, saveConditional: async () => false } }),
    },
    clock,
    ids,
    settings: memory.stores.settings,
  });
  await expect(updateSettings({ patch: { upcomingDays: 9 } }, anActor('admin'))).rejects.toBeInstanceOf(StateConflictError);
});

