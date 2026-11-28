import type { FactoryReportKind, LineFactoryLinkSource, LineFactoryLinkStatus, LineFactoryMatchBasis } from '@sw/domain';
import type { FactoryRef } from './factory-link-repository.js';
import type { ListResult } from '../shared/page.js';

export type { FactoryRef };

export type LineFactoryLinkView = {
  readonly orderLineId: string;
  readonly factory: FactoryRef | null;
  readonly status: LineFactoryLinkStatus;
  readonly source: LineFactoryLinkSource;
  readonly confidence: LineFactoryMatchBasis;
  readonly reason: string | null;
  readonly linkedAt: string;
};

/** relink 的订单行候选。linkId/linkStatus 用来就地更新或保留手工关联。 */
export type OrderLineMatchRef = {
  readonly orderLineId: string;
  readonly poNorm: string | null;
  readonly itemCodeNorm: string | null;
  readonly barcodeNorm: string | null;
  readonly linkId: string | null;
  readonly linkStatus: LineFactoryLinkStatus | null;
  readonly linkReason: string | null;
  readonly linkSource?: LineFactoryLinkSource;
};

/** relink 的工厂行候选。不排除已自动关联的行，否则第二次运行会把已有 link 当成无候选。 */
export type FactoryRowMatchRef = {
  readonly rowId: string;
  readonly kind: FactoryReportKind;
  readonly factoryPartyId: string;
  readonly poNorm: string | null;
  readonly itemCodeNorm: string | null;
  readonly barcodeNorm: string | null;
  readonly poRaw: string | null;
  readonly itemCodeRaw: string | null;
  readonly barcodeRaw: string | null;
  readonly linkStatus: string;
  readonly linkReason: string | null;
  readonly linkedOrderLineId: string | null;
};

export type RelinkFactoryRowsResult = {
  /** 参与关联的工厂行总数（linked + manual + unlinked = factoryRows）。 */
  readonly factoryRows: number;
  readonly factoryLinked: number;
  readonly factoryManual: number;
  readonly factoryUnlinked: number;
  /** PO 命中多个订单行且品号/条码都不能唯一定位。 */
  readonly conflicts: number;
  readonly linesLinked: number;
  readonly linesUnlinked: number;
  readonly byBasis: { readonly po: number; readonly item_code: number; readonly barcode: number };
};

export type SetLineFactoryLinkInput = {
  readonly orderLineId: string;
  /** null 表示取消关联，reason 必填。 */
  readonly factoryPartyId: string | null;
  readonly reason?: string | undefined;
};

export type UnmatchedFactoryRowView = {
  readonly rowId: string;
  readonly kind: FactoryReportKind;
  readonly factoryPartyId: string;
  readonly poRaw: string | null;
  readonly itemCodeRaw: string | null;
  readonly barcodeRaw: string | null;
  readonly reason: string;
  readonly suggestedAction: string;
};

export type FactoryDiagnosticScope = 'active' | 'historical';
export type FactoryDiagnosticPageQuery = { readonly scope: FactoryDiagnosticScope; readonly page: number; readonly pageSize: number };

export type FactoryLinkCounts = {
  readonly linked: number;
  readonly manual: number;
  readonly unlinked: number;
};

/** 工厂关联只读端口，由持久层实现。 */
export type ApprovedSupplierAlias = {
  readonly normName: string;
  readonly partyId: string;
};

export interface FactoryLinkQueries {
  listOrderLineRefs(): Promise<readonly OrderLineMatchRef[]>;
  listFactoryRowRefs(): Promise<readonly FactoryRowMatchRef[]>;
  /** 只读活动代工厂进度快照里的排产格。不含已退休批次，也不含其它六类工厂行。 */
  listActiveScheduleRefs(): Promise<readonly FactoryRowMatchRef[]>;
  listUnmatched(limit: number): Promise<readonly UnmatchedFactoryRowView[]>;
  listDiagnosticPage(input: FactoryDiagnosticPageQuery): Promise<ListResult<UnmatchedFactoryRowView>>;
  /** 已关联或人工取消的订单行记录优先，其次是活动工厂上报，最后是自动未匹配记录。 */
  getView(orderLineId: string): Promise<LineFactoryLinkView | undefined>;
  countStates(): Promise<FactoryLinkCounts>;
  /** 已审批的供应商别名，用于补 purchase_orders.supplier_party_id。 */
  listApprovedSupplierAliases(): Promise<readonly ApprovedSupplierAlias[]>;
}
