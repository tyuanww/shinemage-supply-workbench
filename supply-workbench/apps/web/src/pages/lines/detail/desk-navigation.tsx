import { EntityIdSchema, ProcurementStoreSchema } from '@sw/contracts';
import type { ReactNode } from 'react';
import { Link, useInRouterContext, useLocation } from 'react-router';
import { STUCK_BATCH_PARAM, STUCK_RETURN_PARAM, stuckOrderFocus, stuckReturnAddress } from '../../../features/performance/index.js';
import { currentProgressPath, planningLabels, planningScope, planningSectionOf, schedulePath, scheduleWorkspaceBack } from '../../../features/progress/index.js';
import { useCan } from '../../../shared/actor.js';
import { detailReturnState } from '../../../shared/hooks/detail-return-focus.js';
import { businessToday, deliveryBackAddress, followUpAddress, useFollowUpSearch } from '../../../features/follow-up/index.js';
import { IMPORT_RETURN_PARAM, importFollowUpCandidate, importFollowUpScope, useImportReturnTemplateContext } from '../../../features/imports/index.js';
import { legacyPersonalPath, TODAY_BATCH_RETURN_PARAM, todayArrivalsPath, todayBatchRecordFocus } from '../../../features/today/index.js';
import { HOME_RISK_RETURN_PARAM, homeRiskBackAddress, homeRiskLineFocus } from '../../director-home/home-location.js';
import { importFollowUpReturn, readImportBatchOriginState } from '../../imports/import-source.js';
import { useDetailImportProof } from './import-detail-verification.js';
import { relatedOrderBack, withoutRelatedOrderFocus } from './related-procurement-navigation.js';

type LineDetailLinkProps = {
  readonly href: string; readonly search: string; readonly children: ReactNode;
  readonly isVerifiedImport?: boolean | undefined; readonly isCheckingImportMembership?: boolean | undefined;
};

export function LineDetailLink(props: LineDetailLinkProps) {
  const search = new URLSearchParams(props.search);
  const isRouted = useInRouterContext();
  const template = useImportReturnTemplateContext();
  const candidate = importFollowUpCandidate(search);
  if (props.isCheckingImportMembership === true || (template === undefined && candidate !== null)) {
    return <PendingLineDetailLink>{props.children}</PendingLineDetailLink>;
  }
  const { href, isScoped, isUnverified } = lineDetailDestination({ href: props.href, search, template, isVerifiedImport: props.isVerifiedImport });
  if (!isRouted) return <a href={href}>{props.children}</a>;
  return isUnverified ? <Link to={href}>{props.children}</Link>
    : <RoutedLineDetailLink href={href} search={search.toString()} isScoped={isScoped}>{props.children}</RoutedLineDetailLink>;
}

function lineDetailDestination({ href, search, template, isVerifiedImport }: {
  readonly href: string; readonly search: URLSearchParams;
  readonly template: ReturnType<typeof useImportReturnTemplateContext>; readonly isVerifiedImport: boolean | undefined;
}) {
  const batch = EntityIdSchema.safeParse(search.get('importBatchId')).data;
  const isUnverified = batch !== undefined && isVerifiedImport === false;
  const back = isUnverified ? undefined : importFollowUpScope(search, { template })?.to;
  if (back === undefined) search.delete(IMPORT_RETURN_PARAM);
  const to = batch === undefined ? href : importDetailAddress({ href, search, batch: isUnverified ? undefined : batch, back });
  return { href: to, isScoped: back !== undefined, isUnverified };
}

export function PendingLineDetailLink({ children }: { readonly children: ReactNode }) {
  const status = '正在核对导入范围';
  return <span role="link" aria-disabled="true" aria-busy="true" aria-description={status} title={status} style={{ cursor: 'progress' }}>{children}</span>;
}

function importDetailAddress({ href, batch, back, search }: {
  readonly href: string; readonly batch: string | undefined; readonly back: string | undefined; readonly search: URLSearchParams;
}): string {
  const detail = new URL(href, 'https://workbench.invalid');
  if (batch !== undefined) detail.searchParams.set('importBatchId', batch);
  if (back === undefined) detail.searchParams.delete(IMPORT_RETURN_PARAM);
  else detail.searchParams.set(IMPORT_RETURN_PARAM, back);
  copyImportStore(search, detail.searchParams);
  return followUpAddress(detail.pathname, detail.searchParams);
}

function copyImportStore(from: URLSearchParams, to: URLSearchParams) {
  const store = ProcurementStoreSchema.safeParse(from.get('store')).data;
  if (store !== undefined) to.set('store', store);
}

function RoutedLineDetailLink({ href, search, children, isScoped }: LineDetailLinkProps & { readonly isScoped: boolean }) {
  const { state } = useLocation();
  const origin = isScoped ? readImportBatchOriginState(state) : undefined;
  const originalLine = new URL(href, 'https://workbench.invalid').pathname.split('/').at(-1);
  const lineDeskOriginId = originalLine === undefined ? undefined : decodeURIComponent(originalLine);
  return <Link to={href} state={{ lineDeskSearch: search, lineDeskOriginId, ...origin }}>{children}</Link>;
}

type PlanningReturnState = NonNullable<ReturnType<typeof detailReturnState>> & { readonly scheduleTaskOrigin?: unknown };
type LineDeskReturnState = { readonly lineDeskFocus: string; readonly importBatchOrigin?: unknown };
export type DetailBack = { readonly to: string; readonly label: string; readonly state?: LineDeskReturnState
  | { readonly todayPendingId: string } | { readonly todayArrivalId: string } | PlanningReturnState };

type BackSource = {
  readonly progress: string | null; readonly delivery?: string | null; readonly home?: string | null; readonly schedule?: string | null;
  readonly deliveryEntry?: string | null;
  readonly state: unknown; readonly lineId: string; readonly desk?: URLSearchParams | null; readonly todayBatch?: string | null; readonly focusBatch?: string | null; readonly today?: string | null;
};

export function useLineDetailNavigation({ lineId, params }: { readonly lineId: string; readonly params: URLSearchParams }) {
  const { state } = useLocation();
  const canReadImports = useCan('imports.read');
  const canReadDashboard = useCan('dashboard.read');
  const proof = useDetailImportProof({ params, lineId, canReadImports });
  return { back: readLineDetailBack({ lineId, params, state, canReadDashboard, canReadImports, proof }), membership: proof };
}

type ImportProof = Pick<ReturnType<typeof useDetailImportProof>, 'isImportMember' | 'importReturnTemplate' | 'isProcurementSourceRow' | 'confirmedArrival'>
  & { readonly isCheckingImportSource?: boolean };

export function readLineDetailBack({ lineId, params, state, canReadDashboard, canReadImports, proof }: {
  readonly lineId: string; readonly params: URLSearchParams; readonly state: unknown;
  readonly canReadDashboard: boolean; readonly canReadImports: boolean;
  readonly proof?: ImportProof;
}) {
  const stuck = canReadDashboard ? stuckBack(params.get(STUCK_RETURN_PARAM), state) : null;
  if (stuck !== null) return stuck;
  const focusBatch = params.get('focusBatch');
  const today = params.get(TODAY_BATCH_RETURN_PARAM);
  const desk = matchingLineDesk({ params, state, isImportMember: proof?.isImportMember === true });
  const back = lineDetailBack({ lineId, state, desk, focusBatch, today, todayBatch: today === 'arrivals' ? focusBatch : null,
    progress: params.get('backToProgress'), delivery: params.get('backToDelivery'), deliveryEntry: params.get('deliveryEntry'), home: params.get(HOME_RISK_RETURN_PARAM),
    schedule: params.get('backToSchedule') });
  return relatedOrderBack(state) ?? back ?? importDetailBack({ params, state, desk, canReadImports, proof });
}

function importDetailBack({ params, state, desk, canReadImports, proof }: {
  readonly params: URLSearchParams; readonly state: unknown; readonly desk: URLSearchParams | null;
  readonly canReadImports: boolean; readonly proof: ImportProof | undefined;
}) {
  if (proof === undefined || proof.isCheckingImportSource === true) return null;
  const importState = desk === null && lineDeskParams(state) !== null ? undefined : state;
  const source = canReadImports && (proof.isImportMember || proof.confirmedArrival)
    ? importFollowUpReturn({ params, state: importState, template: proof.importReturnTemplate, isProcurementSourceRow: proof.isProcurementSourceRow, confirmedArrival: proof.confirmedArrival }) : null;
  return source ?? (proof.isImportMember ? importOrdersBack(params) : null);
}

export function lineDetailBack(input: BackSource): DetailBack | null {
  const home = homeBack(input);
  if (home !== null) return home;
  const delivery = deliveryBack(input);
  if (delivery !== null) return delivery;
  if (input.progress !== null) return legacyProgressBack(input.progress, input.state);
  const batchDrawer = todayBatchDrawerBack(input);
  if (batchDrawer !== null) return batchDrawer;
  const today = todayBack(input.state, input.todayBatch);
  if (today !== null) return today;
  if (input.todayBatch) return { to: `${todayArrivalsPath}&focusBatch=${encodeURIComponent(input.todayBatch)}`, label: '返回在途待收' };
  const desk = lineDeskBack(input);
  if (desk !== null) return desk;
  return typeof input.schedule === 'string' ? scheduleBack(new URLSearchParams(input.schedule), input.state) : null;
}

function deliveryBack(input: BackSource): DetailBack | null {
  if (typeof input.delivery !== 'string') return null;
  const to = deliveryBackAddress(input.delivery);
  const target = input.deliveryEntry ? { detailPath: to, sourceLink: input.deliveryEntry } : to;
  const state = detailReturnState(input.state, target);
  return { to, label: '返回按店铺交付', ...(state === undefined ? {} : { state }) };
}

function legacyProgressBack(search: string, state: unknown): DetailBack {
  const params = new URLSearchParams(search);
  const view = params.get('view');
  if (view === 'schedule' || (view !== 'current' && params.has('scheduleLine'))) return scheduleBack(params, state);
  return { to: params.size === 0 ? currentProgressPath : `${currentProgressPath}?${params}`, label: '返回当前进度' };
}

function scheduleBack(params: URLSearchParams, state: unknown): DetailBack {
  const address = scheduleWorkspaceBack(params);
  const mode = params.get('planEntry');
  const isDevelopment = mode === 'development' || (mode === 'alias' && params.get('view') === 'development');
  const label = planningLabels[planningSectionOf(planningScope(params, isDevelopment ? 'development' : 'orders'))];
  const origin = detailReturnState(state, address);
  const scheduleTaskOrigin = typeof state === 'object' && state !== null && 'scheduleTaskOrigin' in state ? state.scheduleTaskOrigin : undefined;
  return {
    to: address, label: `返回${label}`,
    ...(origin === undefined ? {} : { state: { ...origin, ...(scheduleTaskOrigin === undefined ? {} : { scheduleTaskOrigin }) } }),
  };
}

export function orderScheduleAddress({ params, lineId }: { readonly params: URLSearchParams; readonly lineId: string }): string {
  const schedule = new URLSearchParams(params.get('backToSchedule') ?? params.get('backToProgress') ?? '');
  const store = params.get('store');
  if (store !== null) schedule.set('store', store);
  for (const key of ['view', 'lens', 'scheduleReturn', 'planEntry', 'planScope', 'planSelected', 'drawer', 'taskMode', 'taskParent', 'riskReturn', 'scheduleBatch',
    'scheduleBatchEntry', 'procurementTask', 'developmentProject', 'developmentNode', 'developmentNodeProject']) schedule.delete(key);
  schedule.set('scheduleLine', lineId);
  return `${schedulePath}?${schedule}`;
}

function homeBack(input: BackSource): DetailBack | null {
  const to = homeRiskBackAddress(input.home ?? null);
  if (to === null) return null;
  const sourceLink = homeRiskLineFocus(input.lineId, input.focusBatch ?? null);
  const state = detailReturnState(input.state, { detailPath: to, sourceLink });
  return { to, label: '返回首页', ...(state === undefined ? {} : { state }) };
}

function todayBatchDrawerBack({ today, focusBatch, state }: BackSource): DetailBack | null {
  if (typeof today !== 'string' || !today.startsWith('?') || typeof focusBatch !== 'string') return null;
  const query = new URLSearchParams(today);
  if (query.get('drawer') !== 'batch:' + focusBatch) return null;
  const to = '/today' + today;
  const label = query.get('view') === 'arrivals' ? '返回在途待收' : todayActionBackLabel(query);
  const origin = detailReturnState(state, { detailPath: to, sourceLink: todayBatchRecordFocus(focusBatch) });
  return { to, label, ...(origin === undefined ? {} : { state: origin }) };
}

function todayBack(state: unknown, batchId: string | null | undefined): DetailBack | null {
  if (typeof state !== 'object' || state === null) return null;
  if ('personalTodaySearch' in state && typeof state.personalTodaySearch === 'string') {
    return { to: legacyPersonalPath(state.personalTodaySearch, businessToday()), label: '返回个人工作台' };
  }
  if (!('todaySearch' in state) || typeof state.todaySearch !== 'string') return null;
  const query = new URLSearchParams(state.todaySearch);
  if (query.get('view') === 'arrivals' && batchId) {
    query.set('focusBatch', batchId);
    return { to: '/today?' + query, label: '返回在途待收' };
  }
  return actionBack(query, state);
}

function actionBack(query: URLSearchParams, state: object): DetailBack {
  const pending = 'todayPendingId' in state && typeof state.todayPendingId === 'string' ? state.todayPendingId : null;
  const to = query.size === 0 ? '/today' : '/today?' + query;
  if (pending !== null) return { to, label: '返回待建批次', state: { todayPendingId: pending } };
  const label = todayActionBackLabel(query);
  const arrival = 'todayArrivalId' in state && typeof state.todayArrivalId === 'string' ? state.todayArrivalId : null;
  return arrival === null ? { to, label } : { to, label, state: { todayArrivalId: arrival } };
}

function todayActionBackLabel(query: URLSearchParams): string {
  const isSchedule = query.get('view') === 'schedule' || ['schedule', 'owner', 'supplier'].includes(query.get('group') ?? '');
  return isSchedule ? '返回今日排期' : '返回个人工作台';
}

export function readReturningLine(state: unknown): string | null {
  if (typeof state !== 'object' || state === null || !('lineDeskFocus' in state) || typeof state.lineDeskFocus !== 'string') return null;
  return state.lineDeskFocus;
}

function lineDeskBack(input: BackSource): DetailBack | null {
  const { state } = input;
  const params = input.desk === undefined ? lineDeskParams(state) : input.desk;
  if (params === null) return null;
  const original = typeof state === 'object' && state !== null && 'lineDeskOriginId' in state
    && typeof state.lineDeskOriginId === 'string' ? state.lineDeskOriginId : input.lineId;
  return { to: followUpAddress('/lines', params), label: '返回跟进中心', state: { lineDeskFocus: original, ...readImportBatchOriginState(state) } };
}

function lineDeskParams(state: unknown): URLSearchParams | null {
  if (typeof state !== 'object' || state === null || !('lineDeskSearch' in state) || typeof state.lineDeskSearch !== 'string') return null;
  return new URLSearchParams(state.lineDeskSearch);
}

const shopSchema = ProcurementStoreSchema.exclude(['all']);

function matchingLineDesk({ params, state, isImportMember }: {
  readonly params: URLSearchParams; readonly state: unknown; readonly isImportMember: boolean;
}): URLSearchParams | null {
  const desk = lineDeskParams(state);
  if (desk === null || (!isImportMember && params.has('importBatchId'))) return null;
  const hasImportScope = [params, desk].some((query) => query.has('importBatchId') || query.has(IMPORT_RETURN_PARAM));
  if (!hasImportScope) return desk;
  const current = lineDeskScopeKey(params);
  return current !== null && lineDeskScopeKey(desk) === current ? desk : null;
}

function lineDeskScopeKey(params: URLSearchParams): string | null {
  const candidate = importFollowUpCandidate(params);
  if (candidate === null && params.has(IMPORT_RETURN_PARAM)) return null;
  const batch = EntityIdSchema.safeParse(params.get('importBatchId')).data;
  const store = shopSchema.safeParse(params.get('store')).data;
  const source = candidate === null ? null : normalizedImportSource(candidate);
  return JSON.stringify([batch, store, source]);
}

function normalizedImportSource(candidate: NonNullable<ReturnType<typeof importFollowUpCandidate>>): string {
  const query = new URLSearchParams(candidate.to.slice(candidate.to.indexOf('?')));
  if (!shopSchema.safeParse(query.get('store')).success) query.delete('store');
  query.sort();
  return `${candidate.id}?${query}`;
}

export function arrivalEvidenceLink({ arrivalId, params, state, isImportMember = false }: {
  readonly arrivalId: string; readonly params: URLSearchParams; readonly state: unknown; readonly isImportMember?: boolean;
}) {
  const desk = matchingLineDesk({ params, state, isImportMember });
  const scoped = isImportMember ? desk ?? importDeskScope(params) : null;
  const search = scoped ?? new URLSearchParams();
  search.set('arrival', arrivalId);
  const shouldPreserveOrigin = scoped?.has(IMPORT_RETURN_PARAM) === true && (desk !== null || lineDeskParams(state) === null);
  return { to: followUpAddress('/lines', search), state: shouldPreserveOrigin ? readImportBatchOriginState(state) : undefined };
}

function importOrdersBack(params: URLSearchParams): DetailBack | null {
  const search = importDeskScope(params);
  if (search === null) return null;
  search.delete(IMPORT_RETURN_PARAM);
  return { to: followUpAddress('/lines', search), label: '返回本批订单' };
}

function importDeskScope(params: URLSearchParams): URLSearchParams | null {
  const id = EntityIdSchema.safeParse(params.get('importBatchId'));
  if (!id.success) return null;
  const search = new URLSearchParams({ lane: 'all', importBatchId: id.data });
  const candidate = importFollowUpCandidate(params);
  if (candidate !== null) search.set(IMPORT_RETURN_PARAM, candidate.to);
  copyImportStore(params, search);
  return search;
}

export function useLineDetailSearchParams() {
  const [params, setParams] = useFollowUpSearch();
  const { state } = useLocation();
  return { params, setParams: (next: URLSearchParams) => setParams(next, { state: withoutRelatedOrderFocus(state) }) };
}

function stuckBack(search: string | null, state: unknown): DetailBack | null {
  const to = stuckReturnAddress(search);
  const batchId = new URLSearchParams(search ?? '').get(STUCK_BATCH_PARAM);
  if (to === null || batchId === null) return null;
  const origin = detailReturnState(state, { detailPath: to, sourceLink: stuckOrderFocus(batchId) });
  return { to, label: '返回管理看板', ...(origin === undefined ? {} : { state: origin }) };
}
