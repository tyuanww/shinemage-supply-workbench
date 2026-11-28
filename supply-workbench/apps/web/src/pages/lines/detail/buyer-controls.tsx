import { useEffect, useId, useState } from 'react';
import { Alert, Button, Select, Space, Typography } from 'antd';
import { OrderLineDetailSchema, type OrderLineDetail, type MeResponse } from '@sw/contracts';
import { can } from '@sw/domain';
import { useSearchParams } from 'react-router';
import { useCanWrite } from '../../../shared/actor.js';
import { ApiError, apiErrorMessage, apiSend } from '../../../shared/api/client.js';
import { fetchLineOwners } from '../../../shared/api/catalog.js';
import { read } from '../../../shared/api/reads.js';
import { space, topBar } from '../../../theme/tokens.js';
import { useOrderEntryFocus } from './related-order-return.js';

type Owner = NonNullable<OrderLineDetail['line']['buyer']>;
type OwnerUndo = NonNullable<OrderLineDetail['ownerUndo']>;
type Directory = { readonly kind: 'ready'; readonly owners: readonly Owner[]; readonly me: MeResponse };
type EditorState = { readonly kind: 'loading' | 'failed' } | Directory;
type Props = { readonly detail: OrderLineDetail; readonly onSaved: (detail: OrderLineDetail) => void };

export function BuyerControls({ detail, onSaved }: Props) {
  const canWrite = useCanWrite('lines.write');
  const [params] = useSearchParams();
  const shouldFocus = params.get('focus') === 'buyer';
  const section = useOrderEntryFocus<HTMLElement>(shouldFocus, 'start');
  const buyerName = detail.pendingBuyerName === undefined
    ? detail.line.buyer?.name ?? '未分配'
    : `${detail.pendingBuyerName}（待处理）`;
  return <section ref={section} tabIndex={-1} aria-label="订单负责人" style={{ marginTop: space[3], scrollMarginBlockStart: topBar + space[2] }}>
    <Typography.Paragraph>当前负责人 {buyerName}</Typography.Paragraph>
    {canWrite && detail.line.cancelledAt === null ? <BuyerEditor detail={detail} onSaved={onSaved} /> : null}
  </section>;
}

function BuyerEditor(props: Props) {
  const { directory, reload } = useOwnerDirectory();
  if (directory.kind === 'loading') return <Typography.Text type="secondary">正在读取采购账号…</Typography.Text>;
  if (directory.kind !== 'ready') return <Alert type="error" showIcon title="采购账号没有读出来" action={<Button onClick={reload}>重试</Button>} />;
  return <BuyerAssignment {...props} directory={directory} />;
}

function useOwnerDirectory() {
  const [directory, setDirectory] = useState<EditorState>({ kind: 'loading' });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    void Promise.all([
      fetchLineOwners(signal),
      read({ name: 'me', signal }),
    ]).then(([owners, me]) => {
      if (!signal.aborted) setDirectory({ kind: 'ready', owners, me });
    }, () => {
      if (!signal.aborted) setDirectory({ kind: 'failed' });
    });
    return () => controller.abort();
  }, [retry]);
  return { directory, reload: () => { setDirectory({ kind: 'loading' }); setRetry((value) => value + 1); } };
}

function BuyerAssignment({ detail, onSaved, directory }: Props & { readonly directory: Directory }) {
  const [draft, setDraft] = useState<string>();
  const [undo, setUndo] = useState<OwnerUndo | null>(null);
  const [isSaving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ readonly kind: 'success' | 'error'; readonly text: string } | null>(null);
  const current = detail.line.buyer;
  const canEdit = current === null || (detail.pendingBuyerName === undefined && current.id === directory.me.id) || can(directory.me, 'admin');

  async function save(next: string | null, expectedAssignmentId?: OwnerUndo['expectedAssignmentId']) {
    if (isSaving || !canEdit) return;
    setSaving(true);
    setNotice(null);
    try {
      const saved = await saveBuyer(detail.line.id, { buyerUserId: next, expectedOwnerAssignmentId: expectedAssignmentId });
      setUndo(saved.ownerUndo ?? null);
      setDraft(undefined);
      setNotice({ kind: 'success', text: expectedAssignmentId !== undefined ? '已撤销负责人修改' : next === null ? '已清空负责人' : '负责人已修改' });
      onSaved(saved);
    } catch (error: unknown) {
      if (expectedAssignmentId !== undefined && hasExpiredUndo(error)) setUndo(null);
      setNotice({ kind: 'error', text: assignmentError(error) });
    } finally {
      setSaving(false);
    }
  }

  return <>
    {canEdit ? <BuyerForm current={current} draft={draft} setDraft={setDraft} owners={directory.owners} undo={undo} isSaving={isSaving} save={save} /> : null}
    {detail.pendingBuyerName === undefined || canEdit ? null : <Typography.Text type="secondary">请管理员重新分配采购账号。</Typography.Text>}
    {notice === null ? null : <Alert role={notice.kind === 'success' ? 'status' : 'alert'} style={{ marginTop: space[2] }} type={notice.kind} showIcon title={notice.text} />}
  </>;
}

type FormProps = {
  readonly current: Owner | null;
  readonly draft: string | undefined;
  readonly setDraft: (draft: string) => void;
  readonly owners: readonly Owner[];
  readonly undo: OwnerUndo | null;
  readonly isSaving: boolean;
  readonly save: (next: string | null, expectedAssignmentId?: OwnerUndo['expectedAssignmentId']) => Promise<void>;
};

function BuyerForm({ current, draft, setDraft, owners, undo, isSaving, save }: FormProps) {
  const selectId = useId();
  return <Space wrap>
    <label htmlFor={selectId}>接手人</label>
    <Select<string>
      id={selectId}
      placeholder="选择采购账号"
      value={draft ?? null}
      showSearch={{ optionFilterProp: 'label' }}
      virtual={false}
      disabled={isSaving}
      options={owners.map((owner) => ({
        value: owner.id,
        label: owners.some((other) => other.id !== owner.id && other.name === owner.name) ? `${owner.name}（${owner.id}）` : owner.name,
      }))}
      onChange={setDraft}
      notFoundContent="没有匹配的采购账号"
      style={{ width: 200 }}
    />
    <Button disabled={draft === undefined || draft === current?.id} loading={isSaving} onClick={() => { if (draft !== undefined) void save(draft); }}>改负责人</Button>
    {current === null ? null : <Button disabled={isSaving} onClick={() => { void save(null); }}>清空负责人</Button>}
    {undo === null ? null : <Button disabled={isSaving} onClick={() => { void save(undo.previousBuyer?.id ?? null, undo.expectedAssignmentId); }}>{undo.previousBuyer === null ? '撤销分配' : `撤销，改回 ${undo.previousBuyer.name}`}</Button>}
  </Space>;
}

function saveBuyer(lineId: string, { buyerUserId, expectedOwnerAssignmentId }: {
  readonly buyerUserId: string | null;
  readonly expectedOwnerAssignmentId: OwnerUndo['expectedAssignmentId'] | undefined;
}) {
  return apiSend({
    path: `/api/v1/lines/${encodeURIComponent(lineId)}`,
    method: 'PATCH',
    body: { buyerUserId, ...(expectedOwnerAssignmentId === undefined ? {} : { expectedOwnerAssignmentId }) },
    schema: OrderLineDetailSchema,
  });
}

function assignmentError(error: unknown): string {
  if (error instanceof ApiError && error.code === 'VALIDATION_FAILED') return '请重新选择启用的采购账号。';
  if (error instanceof ApiError && error.code === 'STATE_CONFLICT') return '负责人已变更，请刷新订单详情后再操作。';
  return apiErrorMessage(error) ?? '负责人没有保存，请重试。';
}

function hasExpiredUndo(error: unknown): boolean {
  return error instanceof ApiError &&
    (error.code === 'STATE_CONFLICT' || error.code === 'FORBIDDEN' || error.code === 'VALIDATION_FAILED');
}
