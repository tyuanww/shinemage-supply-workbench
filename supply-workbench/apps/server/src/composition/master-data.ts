import {
  makeApproveAlias,
  makeApproveCode,
  makeApproveCodeLink,
  makeBulkCreateItems,
  makeCreateParty,
  makeGetItem,
  makeGetPartyDetail,
  makeGetReviewCounts,
  makeLinkFactoryRow,
  makeListAliases,
  makeListCodeLinks,
  makeListCodes,
  makeListCustomerSupplied,
  makeListDemandRows,
  makeListItems,
  makeListMultiName,
  makeListParties,
  makeListUnlinkedFactoryRows,
  makeRejectAlias,
  makeRejectCode,
  makeRejectCodeLink,
  makeResolveMultiName,
  makeUpdateParty,
  makeCreateLineFromInTransit,
  makeGetLineDetail,
} from '@sw/application';
import { FactoryReportRowViewSchema } from '@sw/contracts';
import type { LocalDate } from '@sw/domain';
import {
  aliasRepository,
  auditRepository,
  codeLinkRepository,
  createUnitOfWork,
  deliveryBatchRepository,
  exceptionRepository,
  factoryReportRepository,
  followUpQueries,
  followUpRepository,
  itemCodeRepository,
  itemNameRepository,
  itemRepository,
  masterDataQueries,
  lineFactoryLinkRepository,
  orderLineRepository,
  ownerAssignmentRepository,
  partyRepository,
  procurementRepository,
  placeholderStores,
  purchaseOrderRepository,
  requireDatabase,
  settingsRepository,
  userRepository,
  type AppDatabase,
} from '@sw/persistence';
import type { MasterApi } from '../http/master-data/api.js';
import { systemClock } from '../system/clock.js';
import { systemIds } from '../system/ids.js';

type Clock = { now(): string; today(): LocalDate };
type Write = { readonly uow: ReturnType<typeof createUnitOfWork>; readonly clock: Clock; readonly ids: ReturnType<typeof systemIds> };

export function register(): never {
  throw new Error('主数据路由由 buildHttpApp 挂载');
}

export function composeMasterData(input: { readonly db: AppDatabase; readonly timeZone: string; readonly clock?: Clock }): MasterApi {
  const clock = input.clock ?? systemClock(input.timeZone);
  const ids = systemIds();
  const uow = createUnitOfWork(input.db, (tx) => stores(tx));
  const write = { uow, clock, ids };
  const master = masterDataQueries(input.db, clock);
  const lines = followUpQueries({ db: input.db, clock, timeZone: input.timeZone });
  const reads = { master };
  return { ...reviewApi({ write, reads, master }), ...catalogApi({ db: input.db, write, reads, master, lines }) };
}

function reviewApi(input: { readonly write: Write; readonly reads: { readonly master: ReturnType<typeof masterDataQueries> }; readonly master: ReturnType<typeof masterDataQueries> }): Pick<MasterApi, 'reviewCounts' | 'listAliases' | 'approveAlias' | 'rejectAlias' | 'aliasView' | 'listCodes' | 'approveCode' | 'rejectCode' | 'bulkCreate' | 'codeView' | 'listLinks' | 'approveLink' | 'rejectLink' | 'linkView' | 'listMultiName' | 'resolveMulti' | 'multiView'> {
  const { write, reads, master } = input;
  return {
    reviewCounts: makeGetReviewCounts(reads),
    listAliases: makeListAliases(reads),
    approveAlias: makeApproveAlias(write),
    rejectAlias: makeRejectAlias(write),
    aliasView: master.aliasById,
    listCodes: makeListCodes(reads),
    approveCode: makeApproveCode(write),
    rejectCode: makeRejectCode(write),
    bulkCreate: makeBulkCreateItems(write),
    codeView: master.codeById,
    listLinks: makeListCodeLinks(reads),
    approveLink: makeApproveCodeLink(write),
    rejectLink: makeRejectCodeLink(write),
    linkView: master.linkById,
    listMultiName: makeListMultiName(reads),
    resolveMulti: makeResolveMultiName(write),
    multiView: master.multiById,
  };
}

function catalogApi(input: { readonly db: AppDatabase; readonly write: Write; readonly reads: { readonly master: ReturnType<typeof masterDataQueries> }; readonly master: ReturnType<typeof masterDataQueries>; readonly lines: ReturnType<typeof followUpQueries> }): Pick<MasterApi, 'listParties' | 'getParty' | 'createParty' | 'updateParty' | 'partyView' | 'listItems' | 'getItem' | 'listUnlinked' | 'listDemand' | 'listSupplied' | 'linkRow' | 'lineFromTransit' | 'lineDetail'> {
  const { write, reads, master, lines } = input;
  return {
    listParties: makeListParties(reads),
    getParty: makeGetPartyDetail(reads),
    createParty: makeCreateParty(write),
    updateParty: makeUpdateParty(write),
    partyView: (id) => partyById(master, id),
    listItems: makeListItems(reads),
    getItem: makeGetItem(reads),
    listUnlinked: makeListUnlinkedFactoryRows(reads),
    listDemand: makeListDemandRows(reads),
    listSupplied: makeListCustomerSupplied(reads),
    linkRow: linkReport(input.db, write),
    lineFromTransit: makeCreateLineFromInTransit(write),
    lineDetail: (input, actor) => makeGetLineDetail({ lines })(input, actor),
  };
}

function linkReport(db: AppDatabase, write: Write): MasterApi['linkRow'] {
  return (params, actor) => db.transaction(async (tx) => {
    const link = makeLinkFactoryRow({ ...write, uow: { run: (effect) => effect(stores(tx)) } });
    const linked = await link(params, actor);
    const row = await masterDataQueries(requireDatabase(tx), write.clock).linkedReport(linked);
    return FactoryReportRowViewSchema.parse(row);
  });
}

async function partyById(master: ReturnType<typeof masterDataQueries>, id: string) {
  const detail = await master.getParty({ partyId: id });
  return detail.party;
}

function stores(tx: unknown) {
  const db = requireDatabase(tx);
  return {
    ...placeholderStores(),
    users: userRepository(db),
    settings: settingsRepository(db),
    ownerAssignments: ownerAssignmentRepository(db),
    parties: partyRepository(db),
    procurement: procurementRepository(db),
    aliases: aliasRepository(db),
    items: itemRepository(db),
    itemCodes: itemCodeRepository(db),
    itemNames: itemNameRepository(db),
    codeLinks: codeLinkRepository(db),
    purchaseOrders: purchaseOrderRepository(db),
    orderLines: orderLineRepository(db),
    batches: deliveryBatchRepository(db),
    exceptions: exceptionRepository(db),
    followUps: followUpRepository(db),
    factoryReports: factoryReportRepository(db),
    audit: auditRepository(db),
    factoryLinks: lineFactoryLinkRepository(db),
  };
}
