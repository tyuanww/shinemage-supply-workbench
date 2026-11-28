import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { Link, useLocation } from 'react-router';
import { Button, Result, Skeleton } from 'antd';
import { importBatchOf, loadViews, orderLensOf, presetViews, readDesk, switchOrderLens, useFollowUpSearch, type OrderLens } from '../../../features/follow-up/index.js';
import { importFollowUpCandidate, ImportReturnTemplateContext, useImportReturnTemplate, useImportReturnTemplateContext } from '../../../features/imports/index.js';
import { useShellViewport } from '../../../features/shell/index.js';
import { WorkbenchPage } from '../../../shared/ui/page.js';
import { ViewSwitch } from '../../../shared/ui/view-switch.js';
import { DeliveryOrders } from '../../progress/DeliveryOrders.js';
import { space, topBar } from '../../../theme/tokens.js';
import { useCan } from '../../../shared/actor.js';
import { useCanRestoreEntryFocus } from '../../../shared/hooks/browser-entry-history.js';
import { importFollowUpReturn, readImportBatchOriginState } from '../../imports/import-source.js';
import { readReturningLine } from '../detail/desk-navigation.js';
import { LineAlerts, LineBulkBar } from './actions.js';
import { loadDeskOwners } from './owners.js';
import { useDeskLoad } from './use-desk-load.js';
import { LineViewBar, readDensity, readHiddenColumns, type Density, type SavedView } from './view-bar.js';
import { LineResultSummary } from './line-summary.js';
import { LineFilters } from './line-filters.js';
import { useDeskScrollRestore } from './desk-scroll.js';
import { readFollowUpPreview, writeFollowUpPreview } from './follow-up-preview-url.js';
import { ArrivalDesk } from './arrival-desk.js';
import { FollowUpPreviewDrawer } from './FollowUpPreviewDrawer.js';
import { LineTable } from './line-table.js';
import { PartyPreviewDrawer } from './PartyPreviewDrawer.js';
import { closePartyPreview, openPartyPreview, readPartyPreview } from './party-preview.js';

export { LineTable, type LineTableProps } from './line-table.js';

type SearchSetter = ReturnType<typeof useFollowUpSearch>[1];
type Desk = ReturnType<typeof readDesk>;
type ResultsRef = RefObject<HTMLDivElement | null>;

export function LineListPage() {
  const [params, setParams] = useFollowUpSearch();
  const { state } = useLocation();
  const canReadImports = useCan('imports.read');
  const hasImportBatch = importBatchOf(params) !== undefined;
  const lens = orderLensOf(params);
  const template = useImportReturnTemplate(params, canReadImports);
  const back = canReadImports ? importFollowUpReturn({ params, state, template }) : null;
  return <WorkbenchPage title="跟进中心" browserTitle={lens === 'delivery' ? '按店铺交付' : '订单查询'}
    action={back === null ? null : <Link to={back.to} state={back.state}>{back.label}</Link>}>
    {hasImportBatch ? null : <div style={{ marginBottom: space[2] }}>
      <ViewSwitch<OrderLens> aria-label="订单查法" value={lens}
        options={[{ value: 'query', label: '订单查询' }, { value: 'delivery', label: '按店铺交付' }]}
        onChange={(value) => setParams(switchOrderLens(params, value))} />
    </div>}
    <ImportReturnTemplateContext value={template}>
      {lens === 'delivery' ? <DeliveryOrders /> : <OrderQuery />}
    </ImportReturnTemplateContext>
  </WorkbenchPage>;
}

function OrderQuery() {
  const [params, updateParams] = useFollowUpSearch();
  const location = useLocation();
  const importOrigin = importFollowUpCandidate(params) === null ? undefined : readImportBatchOriginState(location.state);
  const setParams: SearchSetter = (next, options) => updateParams(next, importOrigin === undefined ? options : { ...options, state: importOrigin });
  const results = useRef<HTMLDivElement>(null);
  const [users, setUsers] = useState<readonly { readonly id: string; readonly name: string }[]>([]);
  const [isOwnerVisible, setOwnerVisible] = useState(false);
  const [userId, setUserId] = useState('');
  const [buyerId, setBuyerId] = useState('');
  const [skips, setSkips] = useState<readonly string[]>([]);
  const [message, setMessage] = useState('');
  const [reload, setReload] = useState(0);
  const [now] = useState(() => new Date());
  const search = params.toString(); const desk = readDesk(search);
  const preview = readFollowUpPreview(search); const party = readPartyPreview(search); const { density, hiddenKeys } = displayPrefs(search);
  const request = { query: desk.requestQuery, reload };
  const load = useDeskLoad(request);
  const { picked, setPicked } = useDeskSelection(request);
  const refresh = () => setReload((value) => value + 1);
  const rememberPreviewTrigger = usePreviewTrigger(preview !== null, results);
  const isTemplateSettled = useImportReturnTemplateContext() !== undefined;
  useDetailReturnFocus({ results, lineId: readReturningLine(location.state), key: location.key, isSettled: isTemplateSettled && load.kind !== 'pending' });
  useEffect(() => { void loadDeskOwners({ setUsers, setUserId, setOwnerVisible }); }, []);
  return (
    <>
      <LineTop search={search} desk={desk} setParams={setParams} views={viewChoices(userId)} userId={userId} setMessage={setMessage} picked={load.kind === 'ready' ? picked : []} users={users} isOwnerVisible={isOwnerVisible} buyerId={buyerId} setBuyerId={setBuyerId} onReload={refresh} setSkips={setSkips} density={density} hiddenKeys={hiddenKeys}
        arrivalAction={<ArrivalDesk search={search} setParams={setParams} userId={userId} onMutated={refresh} />}
        onResults={() => results.current?.focus()}
      />
      <LineAlerts skips={skips} setSkips={setSkips} message={message} />
      <DeskResults results={results} reload={reload} load={load} desk={desk} searched={search} setParams={setParams} picked={picked} setPicked={setPicked}
        density={density} hiddenKeys={hiddenKeys} onPreviewTrigger={rememberPreviewTrigger} onRetry={refresh} now={now}
      />
      <LinePreviews preview={preview} party={party} search={search} setParams={setParams} />
    </>
  );
}

function usePreviewTrigger(isOpen: boolean, results: ResultsRef) {
  const trigger = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (isOpen) { wasOpen.current = true; return; }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    const element = trigger.current;
    trigger.current = null;
    const frame = window.requestAnimationFrame(() => {
      if (element?.isConnected === true) element.focus({ preventScroll: true });
      else results.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isOpen, results]);
  return (element: HTMLElement) => { trigger.current = element; };
}

function useDetailReturnFocus({ results, lineId, key, isSettled }: { readonly results: ResultsRef; readonly lineId: string | null; readonly key: string; readonly isSettled: boolean }) {
  const restored = useRef<string | null>(null);
  const canRestore = useCanRestoreEntryFocus();
  useEffect(() => {
    const region = results.current;
    if (!isSettled || lineId === null || region === null || restored.current === key) return;
    restored.current = key;
    if (!canRestore()) return;
    const row = [...region.querySelectorAll('tr[data-row-key]')].find((candidate) => candidate.getAttribute('data-row-key') === lineId);
    (row?.querySelector<HTMLElement>('th[scope="row"] a') ?? region).focus();
  }, [isSettled, key, lineId, results, canRestore]);
}

function useDeskSelection(request: Parameters<typeof useDeskLoad>[0]) {
  const [selection, setSelection] = useState<typeof request & { readonly picked: readonly string[] }>({ ...request, picked: [] });
  const isCurrent = selection.query === request.query && selection.reload === request.reload;
  if (!isCurrent) setSelection({ ...request, picked: [] });
  return {
    picked: isCurrent ? selection.picked : [],
    setPicked: (picked: readonly string[]) => setSelection({ ...request, picked }),
  };
}

function LinePreviews(props: {
  readonly preview: ReturnType<typeof readFollowUpPreview>;
  readonly party: ReturnType<typeof readPartyPreview>;
  readonly search: string;
  readonly setParams: SearchSetter;
}) {
  const [lastPreview, setLastPreview] = useState(props.preview);
  if (props.preview !== null && props.preview.lineId !== lastPreview?.lineId) setLastPreview(props.preview);
  const shownPreview = props.preview ?? lastPreview;
  return (
    <>
      {shownPreview === null ? null : <FollowUpPreviewDrawer
        key={shownPreview.lineId}
        lineId={shownPreview.lineId}
        search={shownPreview.preservedSearch}
        isOpen={props.preview !== null}
        onClose={() => keepPlace(props.setParams, writeFollowUpPreview({ search: props.search, session: null }))}
      />}
      {partyDrawer({ party: props.party, search: props.search, setParams: props.setParams })}
    </>
  );
}

function displayPrefs(search: string): { readonly density: Density; readonly hiddenKeys: readonly string[] } {
  return { density: readDensity(search), hiddenKeys: readHiddenColumns(search) };
}

function viewChoices(userId: string): readonly SavedView[] {
  if (userId === '') return presetViews();
  return [...presetViews(), ...loadViews(window.localStorage, userId)];
}

function DeskResults({ results, reload, ...body }: Parameters<typeof DeskBody>[0] & { readonly results: ResultsRef; readonly reload: number }) {
  return <div ref={results} id="line-search-results" role="region" aria-label="订单查询结果" tabIndex={-1} style={{ scrollMarginTop: topBar + space[2] }}>
    <LineResultSummary query={body.desk.requestQuery} reload={reload} total={body.load.kind === 'ready' ? body.load.total : null} />
    <DeskBody {...body} />
  </div>;
}

function DeskBody(props: {
  readonly load: ReturnType<typeof useDeskLoad>;
  readonly desk: Desk;
  readonly searched: string;
  readonly setParams: SearchSetter;
  readonly picked: readonly string[];
  readonly setPicked: (ids: readonly string[]) => void;
  readonly density: Density;
  readonly hiddenKeys: readonly string[];
  readonly onRetry: () => void;
  readonly onPreviewTrigger: (element: HTMLElement) => void;
  readonly now: Date;
}) {
  useDeskScrollRestore({ isReady: props.load.kind === 'ready', layoutKey: props.load.kind === 'ready' ? props.load.rows.length : 0 });
  if (props.load.kind === 'failed') return <DeskError message={props.load.message} onRetry={props.onRetry} />;
  if (props.load.kind === 'pending') return <>
    <p role="status">正在读取订单行…</p>
    <Skeleton active paragraph={{ rows: 10 }} />
  </>;
  return (
    <LineTable
      columns={props.desk.columns}
      rows={props.load.rows}
      picked={props.picked}
      setPicked={props.setPicked}
      page={props.desk.page}
      pageSize={props.desk.pageSize}
      total={props.load.total}
      search={props.searched}
      setParams={props.setParams}
      density={props.density}
      hiddenKeys={props.hiddenKeys}
      now={props.now}
      onPreviewTrigger={props.onPreviewTrigger}
      onOpenParty={(opened) => keepPlace(props.setParams, openPartyPreview({ search: props.searched, opened }))}
    />
  );
}

function DeskError({ message, onRetry }: { readonly message: string; readonly onRetry: () => void }) {
  return (
    <Result
      status="error"
      title="订单行没有读出来"
      subTitle={<span role="alert">{message}</span>}
      extra={[
        <Button key="retry" autoInsertSpace={false} type="primary" onClick={onRetry}>重试</Button>,
        <Button key="back" onClick={() => window.history.back()}>返回</Button>,
      ]}
    />
  );
}

function LineTop(props: {
  readonly search: string;
  readonly desk: Desk;
  readonly setParams: SearchSetter;
  readonly views: readonly SavedView[];
  readonly userId: string;
  readonly setMessage: (message: string) => void;
  readonly picked: readonly string[];
  readonly users: readonly { readonly id: string; readonly name: string }[];
  readonly isOwnerVisible: boolean;
  readonly buyerId: string;
  readonly setBuyerId: (id: string) => void;
  readonly onReload: () => void;
  readonly setSkips: (lines: readonly string[]) => void;
  readonly density: Density;
  readonly hiddenKeys: readonly string[];
  readonly arrivalAction: ReactNode;
  readonly onResults: () => void;
}) {
  const isPhone = useShellViewport().band === 'phone';
  const hasSelection = props.picked.length > 0;
  const views = <LineViewBar search={props.search} query={props.desk.requestQuery} views={props.views} userId={props.userId} columns={props.desk.columns} density={props.density} hiddenKeys={props.hiddenKeys} setMessage={props.setMessage} setParams={props.setParams} />;
  const bulk = hasSelection ? <LineBulkBar users={props.users} isOwnerVisible={props.isOwnerVisible} buyerId={props.buyerId} setBuyerId={props.setBuyerId} picked={props.picked} onReload={props.onReload} setMessage={props.setMessage} setSkips={props.setSkips} /> : null;
  return <>
    <LineFilters search={props.search} desk={props.desk} setParams={props.setParams} isPhone={isPhone} arrivalAction={props.arrivalAction} onResults={props.onResults} />
    {isPhone ? <div style={{ display: 'grid' }}>
      <div inert={hasSelection} style={actionRowStyle(hasSelection)}>{views}</div>
      <div style={actionRowStyle(false)}>{bulk}</div>
    </div> : hasSelection ? bulk : views}
  </>;
}

function actionRowStyle(isHidden: boolean): CSSProperties {
  return { gridArea: '1 / 1', minWidth: 0, opacity: isHidden ? 0 : 1, visibility: isHidden ? 'hidden' : 'visible' };
}

function partyDrawer(input: { readonly party: ReturnType<typeof readPartyPreview>; readonly search: string; readonly setParams: SearchSetter }) {
  if (input.party === null) return null;
  const opened = input.party.opened;
  return <PartyPreviewDrawer key={`${opened.role}:${opened.partyId}`} opened={opened} onClose={() => keepPlace(input.setParams, closePartyPreview(input.search))} />;
}

function keepPlace(setParams: SearchSetter, next: URLSearchParams): void {
  setParams(next, { preventScrollReset: true });
}
