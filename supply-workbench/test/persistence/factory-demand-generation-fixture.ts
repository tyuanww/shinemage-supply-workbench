import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { systemIds } from '../../apps/server/src/system/ids.js';
import { entityId, localDate, orderLineId, parsePoCell } from '../../packages/domain/src/index.js';
import { createDb, type AppDatabase, type AppHandle } from '../../packages/persistence/src/client.js';
import { migrate } from '../../packages/persistence/src/migrate.js';
import { followUpQueries } from '../../packages/persistence/src/queries/follow-up/index.js';
import { requireDatabase } from '../../packages/persistence/src/require-database.js';
import { auditRepository } from '../../packages/persistence/src/repositories/audit-log.js';
import { deliveryBatchRepository } from '../../packages/persistence/src/repositories/delivery-batches.js';
import { factoryReportRepository } from '../../packages/persistence/src/repositories/factory-reports.js';
import { itemCodeRepository } from '../../packages/persistence/src/repositories/identity.js';
import { importBatchRepository } from '../../packages/persistence/src/repositories/import-batches.js';
import { placeholderStores } from '../../packages/persistence/src/repositories/index.js';
import { itemRepository } from '../../packages/persistence/src/repositories/items.js';
import { orderLineRepository } from '../../packages/persistence/src/repositories/order-lines.js';
import { ownerAssignmentRepository } from '../../packages/persistence/src/repositories/owner-assignments.js';
import { partyRepository } from '../../packages/persistence/src/repositories/parties.js';
import { purchaseOrderRepository } from '../../packages/persistence/src/repositories/purchase-orders.js';
import { settingsRepository } from '../../packages/persistence/src/repositories/settings.js';
import { userRepository } from '../../packages/persistence/src/repositories/users.js';
import { createUnitOfWork } from '../../packages/persistence/src/unit-of-work.js';
import { aFactoryStockRow, anActor, anOrderLine, aPurchaseOrder, FixedClock } from '../../packages/testkit/src/index.js';

export const url = process.env.SW_PG_URL;
export const clock = new FixedClock('2026-11-28T00:00:00.000Z');
export const slot = { index: 0, date: localDate('2026-11-24'), qty: 50 };
export const rawCells = { dateRaw: '2026/11/24', qtyRaw: '050.00' };
export const wait = { timeout: 4000, interval: 25 };

type Hooks = {
  readonly afterOriginRead?: () => Promise<void>;
  readonly afterMaterialOrderLock?: () => Promise<void>;
  readonly afterDemandSave?: () => Promise<void>;
  readonly afterLineLock?: (id: string) => Promise<void>;
  readonly afterLineSave?: (id: string) => Promise<void>;
};

export function writes(db: AppDatabase, hooks: Hooks = {}) {
  const uow = createUnitOfWork(db, (transaction) => {
    const tx = requireDatabase(transaction);
    const batches = deliveryBatchRepository(tx);
    const reports = factoryReportRepository(tx);
    return {
      ...placeholderStores(),
      batches: {
        ...batches,
        async lockDemandGeneration(scope: Parameters<typeof batches.lockDemandGeneration>[0]) {
          await batches.lockDemandGeneration(scope);
          if ('materialOrderNumbers' in scope) await hooks.afterMaterialOrderLock?.();
        },
        async listByOriginRef(ref: { readonly rowId: string; readonly slotIndex: number }) {
          const found = await batches.listByOriginRef(ref);
          await hooks.afterOriginRead?.();
          return found;
        },
      },
      factoryReports: {
        ...reports,
        async save(row: Parameters<typeof reports.save>[0]) {
          await reports.save(row);
          await hooks.afterDemandSave?.();
        },
      },
      orderLines: linesWithHooks(tx, hooks),
      items: itemRepository(tx),
      itemCodes: itemCodeRepository(tx),
      ownerAssignments: ownerAssignmentRepository(tx),
      parties: partyRepository(tx),
      users: userRepository(tx),
      settings: settingsRepository(tx),
      purchaseOrders: purchaseOrderRepository(tx),
      audit: auditRepository(tx),
    };
  });
  return { uow, clock, ids: systemIds() };
}

function linesWithHooks(tx: AppDatabase, hooks: Hooks) {
  const orderLines = orderLineRepository(tx);
  return {
    ...orderLines,
    async lock(...args: Parameters<typeof orderLines.lock>) {
      const line = await orderLines.lock(...args);
      const [id] = args;
      await hooks.afterLineLock?.(id);
      return line;
    },
    async save(line: Parameters<typeof orderLines.save>[0]) {
      await orderLines.save(line);
      await hooks.afterLineSave?.(line.id);
    },
  };
}

function sampleOf() {
  const token = randomUUID();
  const poDigits = BigInt(`0x${token.replaceAll('-', '')}`).toString().slice(-14).padStart(14, '0');
  return {
    id: entityId(token), lineId: orderLineId(token), importId: entityId(`demand-test-${token}`), factoryId: entityId(`demand-factory-${token}`),
    orderId: entityId(`demand-order-${token}`), code: `VERIFY-DEMAND-${token}`, poRaw: `PO${poDigits}`,
    buyer: { ...anActor('buyer'), id: entityId(`demand-buyer-${token}`) },
    reviewer: { ...anActor('reviewer'), id: entityId(`demand-reviewer-${token}`) },
  };
}

export type Sample = ReturnType<typeof sampleOf>;
type Fixture = { readonly main: AppHandle; readonly competing: AppHandle; readonly applicationName: string; readonly sample: Sample };

export async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  if (url === undefined) throw new Error('需要一次性 PostgreSQL 库');
  const sample = sampleOf();
  const applicationName = `demand-test-${sample.id}`;
  const secondUrl = new URL(url);
  secondUrl.searchParams.set('application_name', applicationName);
  const main = await createDb({ driver: 'pg', url });
  const competing = await createDb({ driver: 'pg', url: secondUrl.href });
  try {
    await migrate(main.exec);
    try {
      await seedDemand(main.db, sample);
      await run({ main, competing, applicationName, sample });
    } finally {
      await clearSample(main, sample);
    }
  } finally {
    await Promise.all([main.close(), competing.close()]);
  }
}

async function seedDemand(db: AppDatabase, sample: Sample): Promise<void> {
  await importBatchRepository(db).save({
    id: sample.importId, fileId: sample.importId, template: 'factory-progress-v1', factoryPartyId: sample.factoryId,
    status: 'committed', createdAt: clock.now(), updatedAt: clock.now(), fileMeta: {}, stats: {}, decisions: {},
    committedBy: sample.buyer.id, committedAt: clock.now(), createdBy: sample.buyer.id, rolledBackAt: null, rolledBackBy: null, error: null,
  });
  await factoryReportRepository(db).save(aFactoryStockRow({
    id: sample.id, importBatchId: sample.importId, factoryPartyId: sample.factoryId, fingerprint: sample.id,
    kind: 'demand', sheetName: '11月排产包材原料需求表', rowNo: 4, linkReason: 'NO_CANDIDATE_LINE',
    raw: { slots: [{ ...slot, ...rawCells, sourceColumns: { date: 10, quantity: 11 } }] },
    demand: { role: 'material', blockMaterialPoRaw: sample.poRaw, poNorm: null, itemCodeRaw: sample.code, nameRaw: '合成包材', slots: [slot] },
  }));
}

export async function anotherDemand(db: AppDatabase, { sample, code = sample.code }: { readonly sample: Sample; readonly code?: string }) {
  const repo = factoryReportRepository(db);
  const first = await repo.get(sample.id);
  if (first.demand === null) throw new Error('合成需求缺失');
  const id = entityId(`${sample.id}-other-demand`);
  await repo.save({ ...first, id, fingerprint: id, rowNo: 5, demand: { ...first.demand, itemCodeRaw: code } });
  return id;
}

export async function seedLine({ db, sample, id, fields }: {
  readonly db: AppDatabase; readonly sample: Sample; readonly id: ReturnType<typeof orderLineId>;
  readonly fields?: Partial<ReturnType<typeof anOrderLine>>;
}): Promise<void> {
  const parsed = parsePoCell(sample.poRaw).value;
  await purchaseOrderRepository(db).save(aPurchaseOrder({
    id: sample.orderId, poRaw: sample.poRaw, poNorm: parsed.poNorm, poFormat: parsed.poFormat, lane: 'material',
  }));
  await orderLineRepository(db).save(anOrderLine({ ...fields, id, purchaseOrderId: sample.orderId, lane: 'material', itemCodeRaw: sample.code }));
}

export async function onlyLineDetail(db: AppDatabase, code: string) {
  const lines = await orderLineRepository(db).listByCodeNorm(code);
  expect(lines).toHaveLength(1);
  const [line] = lines;
  if (line === undefined) throw new Error('没有生成合成订单');
  return followUpQueries({ db, clock, timeZone: 'Asia/Shanghai' }).getDetail(line.id);
}

async function clearSample(handle: AppHandle, sample: Sample): Promise<void> {
  // 所有条件来自本次测试生成的 UUID，和同库的其他验证样本隔离。
  await handle.exec(`
    delete from audit_log where actor_user_id in ('${sample.buyer.id}', '${sample.reviewer.id}');
    delete from delivery_batches where order_line_id in (select id from order_lines where item_code_raw = '${sample.code}' or id in ('${sample.lineId}', '${sample.id}-other'));
    delete from owner_assignments where subject_id in ('${sample.lineId}', '${sample.id}-other') or owner_user_id = '${sample.buyer.id}';
    delete from line_factory_links where order_line_id = '${sample.lineId}';
    delete from order_lines where item_code_raw = '${sample.code}' or id in ('${sample.lineId}', '${sample.id}-other');
    delete from users where id = '${sample.buyer.id}';
    delete from purchase_orders where id = '${sample.orderId}' or po_norm in ('${sample.poRaw}', upper('ALT-${sample.id}'));
    delete from factory_material_demand_rows where import_batch_id = '${sample.importId}';
    delete from import_batches where id = '${sample.importId}';
  `);
}

export async function blockedOnPostgres(observer: AppHandle, applicationName: string): Promise<boolean> {
  // applicationName 含固定前缀和本次测试 UUID。
  const result = await observer.exec(`select exists (
    select 1 from pg_stat_activity where datname = current_database() and application_name = '${applicationName}'
      and cardinality(pg_blocking_pids(pid)) > 0
  ) as waiting`);
  return typeof result === 'object' && result !== null && 'rows' in result
    && Array.isArray(result.rows) && result.rows[0]?.waiting === true;
}

export function gate() {
  let isEntered = false;
  let notify: () => void = () => {};
  let release: () => void = () => {};
  const enteredPromise = new Promise<void>((resolve) => { notify = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  return {
    entered: enteredPromise, hasEntered: () => isEntered, release,
    async hold() {
      isEntered = true;
      notify();
      await released;
    },
  };
}

export function settled<T>(result: Promise<T>) {
  let isDone = false;
  const setDone = () => { isDone = true; };
  void result.then(setDone, setDone);
  return { result, isDone: () => isDone };
}
