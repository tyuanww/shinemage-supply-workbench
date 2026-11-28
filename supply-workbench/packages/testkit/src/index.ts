import type { FileStore } from '../../application/src/ports/file-store.js';
import type { UnitOfWork, UnitOfWorkStores } from '../../application/src/ports/unit-of-work.js';
import type { UserDirectory } from '../../application/src/ports/user-directory.js';
import { createMemoryBox, type MemoryBox } from './memory/box.js';
import { fileStore, userDirectory } from './memory/services.js';
import { memoryUnitOfWork, storesOf } from './memory/unit-of-work.js';

export function createMemory(): {
  readonly box: MemoryBox;
  readonly unitOfWork: UnitOfWork;
  readonly stores: UnitOfWorkStores;
  readonly directory: UserDirectory;
  readonly files: FileStore;
} {
  const box = createMemoryBox();
  return {
    box,
    unitOfWork: memoryUnitOfWork(box),
    stores: storesOf(box),
    directory: userDirectory(box),
    files: fileStore(box),
  };
}

export {
  describeDeliveryBatchRepositoryContract,
  describeExceptionRepositoryContract,
  describeFactoryReportRepositoryContract,
  describeFollowUpRepositoryContract,
  describeImportBatchRepositoryContract,
  describeItemRepositoryContract,
  describeOrderLineRepositoryContract,
  describePartyRepositoryContract,
  describeProductRepositoryContract,
  describePurchaseOrderRepositoryContract,
  describeSettingsRepositoryContract,
  describeUserRepositoryContract,
  describeWeeklyReportRepositoryContract,
} from './contracts/repositories.js';
export { describeFileStoreContract, describeUnitOfWorkContract } from './contracts/unit-of-work.js';
export { describeImportTemplateContract, existingFromParsed } from './contracts/import-template.js';
export { FixedClock, SequentialIds } from './clock.js';
export { deliveryBatchId, entityId, orderLineId, productId } from './ids.js';
export {
  aBatch,
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
} from './builders.js';
