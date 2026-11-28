import type { GenerateBatchesFromDemand, GenerateBatchesFromDemandDeps } from '../boundary.js';
import type { UnitOfWorkStores } from '../../ports/unit-of-work.js';
import { authorize } from '../../shared/authorize.js';
import { isOrderLineLockBusy, StateConflictError } from '../../shared/errors.js';
import { lockOrderLines } from '../../shared/locked-order-lines.js';
import { DemandMaterialChanged, freezeGenerationEvidence, generateDemandRows, type GenerateInput, type RowOutcome, type SlotSkip } from './demand-batches.js';

const MATERIAL_RETRIES = 2;

export const makeGenerateBatchesFromDemand =
  (deps: GenerateBatchesFromDemandDeps): GenerateBatchesFromDemand =>
  async (input, actor) => {
    authorize(actor, 'records.write');
    const context = {
      actor, at: deps.clock.now(),
      nextOrderLineId: () => deps.ids.orderLine(),
      nextEntityId: () => deps.ids.next(),
      nextDeliveryBatchId: () => deps.ids.deliveryBatch(),
    };
    let materialRetries = 0;
    for (;;) {
      try {
        return await deps.uow.run((tx) => generateOnce({ ...context, tx }, input.rowIds));
      } catch (error) {
        if (isOrderLineLockBusy(error)) {
          await deps.uow.run((tx) => lockOrderLines(tx.orderLines, [error.lineId]));
          continue;
        }
        if (!(error instanceof DemandMaterialChanged)) throw error;
        if (materialRetries === MATERIAL_RETRIES) throw new StateConflictError('order_line.material_changed');
        materialRetries += 1;
      }
    }
  };

async function generateOnce(input: GenerateInput, rowIds: readonly string[]) {
  const { tx } = input;
  const outcomes = await generateDemandRows(input, await lockedDemands(tx, rowIds));
  const skipped: SlotSkip[] = [];
  const evidence: NonNullable<RowOutcome['evidence']>[] = [];
  let createdLines = 0;
  let createdBatches = 0;
  for (const outcome of outcomes) {
    createdLines += outcome.lines;
    createdBatches += outcome.batches;
    skipped.push(...outcome.skipped);
    if (outcome.evidence !== undefined) evidence.push(outcome.evidence);
  }
  // 所有订单写入完成后再取工厂行锁，避免与主数据回填后重联的顺序相反。
  for (const source of evidence) await freezeGenerationEvidence(tx, source);
  return { createdLines, createdBatches, skipped };
}

async function lockedDemands(tx: UnitOfWorkStores, rowIds: readonly string[]) {
  await tx.batches.lockDemandGeneration({ rowIds });
  const demands = [];
  for (const rowId of rowIds) {
    const source = await tx.factoryReports.getForDemandGeneration(rowId);
    demands.push(source);
  }
  return demands;
}
