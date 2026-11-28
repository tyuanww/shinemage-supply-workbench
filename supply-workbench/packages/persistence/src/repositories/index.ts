import type { UnitOfWorkStores } from '../../../application/src/ports/unit-of-work.js';

function missing(card: string) {
  return async () => {
    throw new Error(`NotImplemented: ${card}`);
  };
}

export function placeholderStores(): UnitOfWorkStores {
  const p01 = missing('P01');
  const p02 = missing('P02');
  const p03 = missing('P03');
  return {
    users: { get: p01, find: p01, list: p01, save: p01 },
    settings: { get: p01, save: p01 },
    parties: { get: p02, find: p02, save: p02 },
    aliases: { get: p02, find: p02, findByNormName: p02, save: p02 },
    items: { get: p02, lock: p02, find: p02, save: p02 },
    itemCodes: { get: p02, lock: p02, lockMany: p02, find: p02, save: p02, listByNorm: p02 },
    itemNames: { listByItem: p02, save: p02, decision: p02, saveDecision: p02 },
    codeLinks: { get: p02, find: p02, save: p02, listApproved: p02 },
    purchaseOrders: { get: p02, find: p02, save: p02, listByPoNorm: p02, listNoNumber: p02, backfillMissingSupplier: p02 },
    orderLines: { get: p01, lock: p01, find: p01, save: p01, listByPurchaseOrder: p01, listByCodeNorm: p01, saveSnapshot: p01, reportedStatus: p01 },
    batches: {
      get: p01,
      find: p01,
      getWithRecords: p01,
      lockWithRecords: p01,
      listByOrderLine: p01,
      listByOriginRef: p01, lockDemandGeneration: p01,
      findAdoptedShipment: p01,
      findBatchIdOf: p01,
      save: p01,
      saveWithRecords: p01, freezeDemandSource: p01,
      remove: p01,
    },
    exceptions: { get: p01, find: p01, save: p01, remove: p01 },
    followUps: { get: p01, find: p01, save: p01, remove: p01 },
    factoryReports: { get: p02, getForDemandGeneration: p02, demandSourcesAtGeneration: p02, find: p02, lockSnapshotSource: p02, lockReportSources: p02, effectiveReportOwners: p02, lockSnapshotOrders: p02, save: p02, linkUnassignedTransit: p02, listByCodeNorm: p02, lockRelinkRows: p02 },
    imports: { get: p02, find: p02, save: p02, list: p02, listRows: p02, saveRow: p02 },
    products: { get: p03, find: p03, save: p03 },
    productImages: { get: p03, listByProduct: p03, save: p03 },
    productContacts: { listByProduct: p03, replaceRole: p03 },
    bomLines: { replace: p03 },
    weeklyReports: { get: p03, find: p03, findCurrent: p03, list: p03, save: p03 },
    audit: { record: p01, hasEntry: p01 },
  };
}
