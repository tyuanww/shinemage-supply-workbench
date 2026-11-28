import { createBatch, type DeliveryBatchId, type EntityId, type OrderLine } from '@sw/domain';
import type { Actor } from '../../shared/actor.js';
import type { UnitOfWorkStores } from '../../ports/unit-of-work.js';
import type { CreateHintBatches, CreateHintBatchesDeps } from '../boundary.js';
import { auditOf } from '../../shared/audit.js';
import { authorize } from '../../shared/authorize.js';
import { ValidationFailedError } from '../../shared/errors.js';
import { firstBatchReadiness, isOpenForFirstBatch } from '../../shared/first-batch.js';
import { lockOrderLines } from '../../shared/locked-order-lines.js';
import { commandContext, persistBatch } from './persist-batch.js';

type HintMode = { readonly kind: 'today'; readonly warehouseId: EntityId | null }
  | { readonly kind: 'legacy'; readonly warehouseId: EntityId; readonly includeCompleted: boolean };

export const makeCreateHintBatches =
  (deps: CreateHintBatchesDeps): CreateHintBatches =>
  async (input, actor) => {
    authorize(actor, 'lines.write');
    const at = deps.clock.now();
    let created = 0;
    const skipped: { lineId: string; reason: string }[] = [];
    await deps.uow.run(async (tx) => {
      const lines = await lockOrderLines(tx.orderLines, input.lineIds);
      const mode = hintMode(input, (await tx.settings.get()).ownWarehousePartyId);
      for (const lineId of input.lineIds) {
        const outcome = await hintOne({ tx, line: lines.get(lineId), mode, actor, at, batchId: deps.ids.deliveryBatch() });
        if (outcome === 'created') created += 1;
        else skipped.push({ lineId, reason: outcome });
      }
    });
    return { created, skipped };
  };

function hintMode(input: Parameters<CreateHintBatches>[0], warehouseId: EntityId | null): HintMode {
  if (input.source === 'today') return { kind: 'today', warehouseId };
  if (warehouseId === null) throw new ValidationFailedError('没有设置我方仓库', { field: 'ownWarehousePartyId' });
  return { kind: 'legacy', warehouseId, includeCompleted: input.includeCompleted };
}

async function hintOne(input: {
  readonly tx: UnitOfWorkStores;
  readonly line: OrderLine | undefined;
  readonly mode: HintMode;
  readonly actor: Actor;
  readonly at: string;
  readonly batchId: DeliveryBatchId;
}): Promise<'created' | string> {
  const { line, tx, actor, mode } = input;
  if (line === undefined || (mode.kind === 'today' && line.buyerUserId !== actor.id)) return '订单行不存在';
  if ((await tx.batches.listByOrderLine(line.id)).length > 0) return '已有批次';
  const values = mode.kind === 'today'
    ? await todayValues({ tx, line, warehouseId: mode.warehouseId })
    : await legacyValues({ tx, line, ...mode });
  if (typeof values === 'string') return values;
  const batch = createBatch({
    orderLineId: line.id,
    seq: 1,
    ...values,
    origin: 'from_po_master_hint',
  }, commandContext({ actor: input.actor, at: input.at, nextId: input.batchId }));
  await persistBatch({ tx: input.tx, records: { batch, shipments: [], receipts: [], deliveryNote: null }, dateChanges: [] });
  await input.tx.audit.record(auditOf({ action: 'batch.hint', subject: batch, ctx: { actor: input.actor, at: input.at, entity: '要货批次' } }));
  return 'created';
}

type HintValues = { readonly plannedQty: number; readonly plannedUnit: string | null; readonly receiverPartyId: EntityId };

async function todayValues({ tx, line, warehouseId }: { readonly tx: UnitOfWorkStores; readonly line: OrderLine; readonly warehouseId: EntityId | null }): Promise<HintValues | string> {
  if (!isOpenForFirstBatch(line, await tx.orderLines.reportedStatus(line.id))) return '订单行已完成或取消';
  const ready = firstBatchReadiness({ line, warehouseId });
  if (ready.kind === 'detail') return '请在订单详情核对计划数量、单位及收货方';
  if ((await tx.parties.find(ready.receiver))?.isOwnWarehouse !== true) return '请在订单详情确认收货方';
  return { plannedQty: ready.qty, plannedUnit: ready.unit, receiverPartyId: ready.receiver };
}

async function legacyValues({ tx, line, warehouseId, includeCompleted }: {
  readonly tx: UnitOfWorkStores;
  readonly line: OrderLine;
  readonly warehouseId: EntityId;
  readonly includeCompleted: boolean;
}): Promise<HintValues | string> {
  if (line.qtyOrdered === null) return '没有订单数量';
  if (!includeCompleted && await tx.orderLines.reportedStatus(line.id) === '已完成') return '总表状态已完成';
  return { plannedQty: line.qtyOrdered, plannedUnit: line.unit, receiverPartyId: warehouseId };
}
