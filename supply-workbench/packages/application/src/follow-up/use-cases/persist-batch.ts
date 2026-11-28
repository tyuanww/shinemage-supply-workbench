import type { Actor } from '../../shared/actor.js';
import type { BatchDateChange, BatchRecords, EntityId, RuleContext } from '@sw/domain';
import type { UnitOfWorkStores } from '../../ports/unit-of-work.js';
import { StateConflictError } from '../../shared/errors.js';
import { refreshLineProjection } from '../../shared/line-projection.js';

export function commandContext<Id extends EntityId>({ actor, at, nextId }: { readonly actor: Actor; readonly at: string; readonly nextId: Id }): RuleContext<Id> {
  return { at, by: actor.id, isAdmin: actor.roles.some((role) => role === 'admin'), nextId };
}

export async function persistBatch({ tx, records, dateChanges, expectedUpdatedAt }: { readonly tx: UnitOfWorkStores; readonly records: BatchRecords; readonly dateChanges: readonly BatchDateChange[]; readonly expectedUpdatedAt?: string }): Promise<void> {
  await tx.orderLines.lock(records.batch.orderLineId);
  const payload = { ...records, dateChanges };
  if (expectedUpdatedAt !== undefined && tx.batches.saveWithRecordsConditional !== undefined) {
    const isSaved = await tx.batches.saveWithRecordsConditional(payload, expectedUpdatedAt);
    if (!isSaved) throw new StateConflictError('delivery_batch.updated_at');
  } else {
    await tx.batches.saveWithRecords(payload);
  }
  await refreshLineProjection(tx, [records.batch.orderLineId]);
}
