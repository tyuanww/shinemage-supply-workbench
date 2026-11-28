import { useContext, useEffect, useRef, useState, type RefObject } from 'react';
import { Link, createPath, useLocation } from 'react-router';
import { Alert, Button, Collapse, Descriptions, Form, Input, Typography } from 'antd';
import { BatchViewSchema, EntityIdSchema, FollowUpViewSchema, type OrderLineDetail } from '@sw/contracts';
import { isNotProvided } from '@sw/domain';
import { deliveryBackAddress, followUpAddress, useFollowUpSearch } from '../../../features/follow-up/index.js';
import { IMPORT_RETURN_PARAM, importFollowUpCandidate } from '../../../features/imports/index.js';
import { detailDepartureState, detailReturnState, useDetailFocusLinks } from '../../../shared/hooks/detail-return-focus.js';
import { useCan } from '../../../shared/actor.js';
import { apiErrorMessage, apiSend } from '../../../shared/api/client.js';
import { fetchLatestNotes } from '../../../shared/api/catalog.js';
import { HOME_RISK_RETURN_PARAM, homeRiskBackAddress } from '../../director-home/home-location.js';
import { PendingLineDetailLink } from './desk-navigation.js';
import { LineImportMembership } from './import-detail-verification.js';
import { relatedOrderFocusLink, relatedOrderState, useRelatedImportMembers, withoutRelatedOrderFocus } from './related-procurement-navigation.js';
import { useRestoreRelatedOrder } from './related-order-return.js';

const quantityFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 12 });

export function ProcurementSection({ detail }: { readonly detail: OrderLineDetail }) {
  const procurement = detail.procurement;
  const progress = detail.line.storeProgress;
  const section = useRef<HTMLElement>(null);
  const hasSection = procurement !== undefined || progress !== undefined;
  const links = <RelatedProcurementLines lines={procurement?.relatedLines ?? []} section={section} />;
  if (!hasSection) return links;
  const isComponent = detail.line.origin === 'import_procurement_component';
  return (
    <section ref={section} tabIndex={-1} aria-label={isComponent ? '采购事项来源' : '关联采购事项'}>
      {isComponent ? <ComponentFields line={detail.line} /> : null}
      <ProcurementOa progress={progress} />
      <Typography.Title level={2}>{isComponent ? '关联成品' : '关联采购事项'}</Typography.Title>
      {links}
      {procurement === undefined || procurement.sources.length === 0 ? null : <ProcurementSources sources={procurement.sources} />}

    </section>
  );
}

function procurementReturnState({ params, state, isImportMember }: {
  readonly params: URLSearchParams; readonly state: unknown; readonly isImportMember: boolean;
}) {
  const home = homeRiskBackAddress(params.get(HOME_RISK_RETURN_PARAM));
  if (home !== null) return detailReturnState(state, home);
  const delivery = params.get('backToDelivery');
  if (delivery !== null) return detailReturnState(state, deliveryBackAddress(delivery));
  return params.has('backToSchedule') || isImportMember ? withoutRelatedOrderFocus(state) : undefined;
}

function procurementDetailQuery(params: URLSearchParams): URLSearchParams {
  const related = new URLSearchParams();
  for (const key of ['store', 'backToProgress', 'backToSchedule', 'backToDelivery', 'deliveryEntry', HOME_RISK_RETURN_PARAM]) {
    const value = params.get(key);
    if (value !== null) related.set(key, value);
  }
  return related;
}

function ProcurementOa({ progress }: { readonly progress: OrderLineDetail['line']['storeProgress'] }) {
  if (progress === undefined) return null;
  const refs = progress.sources.flatMap((source) => source.oaRaw ?? []);
  return <p>OA 需求 {[...new Set(refs)].join(' · ') || '未关联 OA'}</p>;
}

type RelatedLine = NonNullable<OrderLineDetail['procurement']>['relatedLines'][number];

function RelatedProcurementLines({ lines, section }: {
  readonly lines: readonly RelatedLine[];
  readonly section: RefObject<HTMLElement | null>;
}) {
  const [params] = useFollowUpSearch();
  const location = useLocation();
  const { isImportMember, isCheckingImportMembership } = useContext(LineImportMembership);
  const batch = isImportMember ? EntityIdSchema.safeParse(params.get('importBatchId')).data : undefined;
  const members = useRelatedImportMembers({ batch, store: params.get('store'), lines });
  const source = createPath(location);
  const detailFocusLink = useDetailFocusLinks();
  const isReady = !isCheckingImportMembership && members !== undefined;
  useRestoreRelatedOrder(isReady, section);
  if (lines.length === 0) return null;
  if (!isReady) {
    return <ul>{lines.map((line) => <li key={line.id}><PendingLineDetailLink>{relatedLineLabel(line)}</PendingLineDetailLink></li>)}</ul>;
  }
  const query = procurementDetailQuery(params);
  const scoped = procurementImportQuery({ query, params, batch });
  const returnState = procurementReturnState({ params, state: location.state, isImportMember });
  return (
    <ul>{lines.map((line) => {
      const isMember = members.has(line.id);
      const href = followUpAddress(`/lines/${encodeURIComponent(line.id)}`, isMember ? scoped : query);
      const { id, state: focus } = detailFocusLink(source, relatedOrderFocusLink(line.id));
      const originState = isMember ? undefined : relatedOrderState(location, batch === undefined ? undefined : focus);
      const state = detailDepartureState(originState ?? returnState, focus.detailOrigin);
      return <li key={line.id}>
        <Link to={href} state={state} id={id}>{relatedLineLabel(line)}</Link>
      </li>;
    })}</ul>
  );
}

function relatedLineLabel(line: RelatedLine): string {
  return [line.nameRaw, line.codeRaw, line.poRaw].filter(Boolean).join(' · ') || '打开订单行';
}

function procurementImportQuery({ query, params, batch }: {
  readonly query: URLSearchParams; readonly params: URLSearchParams; readonly batch: string | undefined;
}): URLSearchParams {
  const scoped = new URLSearchParams(query);
  if (batch !== undefined) scoped.set('importBatchId', batch);
  const source = importFollowUpCandidate(params);
  if (source !== null) scoped.set(IMPORT_RETURN_PARAM, source.to);
  return scoped;
}

type ProcurementSourcesList = NonNullable<OrderLineDetail['procurement']>['sources'];

function ProcurementSources({ sources }: { readonly sources: ProcurementSourcesList }) {
  const canReadImport = useCan('imports.read');
  return (
    <Collapse items={[{
      key: 'procurement-source',
      label: `来源版本（${sources.length}）`,
      children: <ul>{sources.map((entry) => (
        <ProcurementSource key={JSON.stringify([entry.importBatchId, entry.fact.source.sheetName, entry.fact.source.rowNo])} entry={entry} canReadImport={canReadImport} />
      ))}</ul>,
    }]} />
  );
}

function ProcurementSource({ entry, canReadImport }: { readonly entry: ProcurementSourcesList[number]; readonly canReadImport: boolean }) {
  const { fact } = entry;
  const source = `${fact.source.sheetName} 第 ${fact.source.rowNo} 行`;
  return (
    <li>
      {canReadImport ? <Link to={`/imports/${encodeURIComponent(entry.importBatchId)}`}>{source}</Link> : source}
      {' · '}{entry.fileName ?? entry.importBatchId}
      {' · '}{fact.status === 'completed' ? '源表标为已完结' : '项目表'}
      {' · '}{fact.quantityRaw ?? '采购量未填'}
      {' · '}{fact.buyerRaw ?? '采购员未填'}
      {' · '}{fact.supplierRaw ?? '供应商未填'}
      {fact.deliveryProgressRaw == null ? null : ` · 源表交付原文 ${fact.deliveryProgressRaw}`}
    </li>
  );
}

function ComponentFields({ line }: { readonly line: OrderLineDetail['line'] }) {
  const ordered = line.qtyOrdered === null ? '采购量未填' : quantityFormat.format(line.qtyOrdered);
  return <Descriptions items={[
    { key: 'item', label: '子件', children: [line.nameRaw, line.itemCodeRaw].filter(Boolean).join(' · ') },
    { key: 'qty', label: '采购量 / 单位', children: `${ordered} · ${line.unit ?? '单位未填'}` },
    { key: 'buyer', label: '采购员', children: line.buyer?.name ?? '采购员未分派' },
    { key: 'supplier', label: '供应商', children: line.supplier.displayName ?? line.supplier.rawName ?? '供应商未填' },
  ]} />;
}

type LatestNote =
  | { readonly status: 'loading' | 'failed' }
  | { readonly status: 'loaded'; readonly text: string | null };

export function OrderLineNote({ lineId, onReload }: { readonly lineId: string; readonly onReload: () => void }) {
  const [latest, setLatest] = useState<LatestNote>({ status: 'loading' });
  const [version, setVersion] = useState(0);
  const refresh = () => setVersion((current) => current + 1);
  useEffect(() => {
    let isCurrent = true;
    void fetchLatestNotes([lineId]).then(({ items }) => {
      if (isCurrent) setLatest({ status: 'loaded', text: items.find((item) => item.orderLineId === lineId)?.text ?? null });
    }).catch(() => {
      if (isCurrent) setLatest({ status: 'failed' });
    });
    return () => { isCurrent = false; };
  }, [lineId, version]);
  return <section aria-label="订单行备注">
    <Typography.Title level={2}>订单行备注</Typography.Title>
    {latest.status === 'failed' ? <Alert type="warning" showIcon title="最新备注没有读出来" action={<Button onClick={refresh}>重试</Button>} /> : null}
    {latest.status === 'loaded' ? <p role="status" style={{ whiteSpace: 'pre-wrap' }}>{latest.text ?? '暂无订单行备注'}</p> : null}
    <ProcurementFollowUp lineId={lineId} onReload={() => { refresh(); onReload(); }} />
  </section>;
}

export function ProcurementFollowUp({ lineId, batchId, onReload }: { readonly lineId: string; readonly batchId?: string; readonly onReload: () => void }) {
  const [draft, setDraft] = useState('');
  const label = batchId === undefined ? '订单行备注' : '工厂承诺';
  const [isSaving, setSaving] = useState(false);
  const [error, setError] = useState('');
  async function submit() {
    const text = draft.trim();
    if (text === '' || isSaving) return;
    setSaving(true);
    setError('');
    try {
      await apiSend({ path: '/api/v1/follow-ups', method: 'POST', body: { orderLineId: lineId, text, ...(batchId === undefined ? { kind: 'note' } : { batchId, kind: 'promise' }) }, schema: FollowUpViewSchema });
      setDraft('');
      onReload();
    } catch (caught) {
      setError(apiErrorMessage(caught) ?? '跟进没有记上');
    } finally {
      setSaving(false);
    }
  }
  return (
    <>
      <Form layout="inline" onFinish={() => { void submit(); }}>
        <Input aria-label={label} placeholder={batchId === undefined ? '填写订单行备注' : '例如周五发 5,000 件'} value={draft} disabled={isSaving} onChange={(event) => setDraft(event.target.value)} style={{ maxWidth: 420 }} />
        <Button htmlType="submit" disabled={draft.trim() === ''} loading={isSaving}>{batchId === undefined ? '保存备注' : '记工厂承诺'}</Button>
      </Form>
      {error === '' ? null : <Alert type="error" showIcon title={error} />}
    </>
  );
}

export function BatchUnitCorrection({ batchId, onReload }: { readonly batchId: string; readonly onReload: () => void }) {
  const [plannedUnit, setPlannedUnit] = useState('');
  const [reason, setReason] = useState('');
  const [isSaving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const canSubmit = !isSaving && !isNotProvided(plannedUnit) && !isNotProvided(reason);
  async function submit() {
    if (!canSubmit) return;
    setSaving(true);
    setError('');
    try {
      await apiSend({ path: `/api/v1/batches/${encodeURIComponent(batchId)}`, method: 'PATCH', body: { plannedUnit: plannedUnit.trim(), reason: reason.trim() }, schema: BatchViewSchema });
      setPlannedUnit('');
      setReason('');
      onReload();
    } catch (caught) {
      setError(apiErrorMessage(caught) ?? '计划单位未保存');
    } finally {
      setSaving(false);
    }
  }
  return <>
    <Form layout="inline" onFinish={() => { void submit(); }}>
      <Input aria-label="计划单位" placeholder="计划单位" maxLength={64} value={plannedUnit} disabled={isSaving} onChange={(event) => setPlannedUnit(event.target.value)} style={{ width: 110 }} />
      <Input aria-label="计划单位依据" placeholder="可回查的采购或仓库依据" value={reason} disabled={isSaving} onChange={(event) => setReason(event.target.value)} style={{ width: 220 }} />
      <Button htmlType="submit" disabled={!canSubmit} loading={isSaving}>补录计划单位</Button>
    </Form>
    {error === '' ? null : <Alert type="error" showIcon title={error} />}
  </>;
}
