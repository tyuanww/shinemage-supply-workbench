import { ProcurementStoreSchema } from '@sw/contracts';
import { useEffect, useState } from 'react';
import { createPath, matchPath, type Location } from 'react-router';
import { z } from 'zod';
import { read } from '../../../shared/api/reads.js';
import { withoutDetailReturnFocus, type detailReturnState } from '../../../shared/hooks/detail-return-focus.js';

const NO_IMPORT_MEMBERS: ReadonlySet<string> = new Set();
const MAX_MEMBERS = 100;
const MAX_QUERY_LENGTH = 3800;
export const relatedFocusPrefix = 'related-order:';
const relatedOrderOriginSchema = z.object({
  to: z.string().refine(isLocalOrderAddress),
  state: z.unknown(),
});

export function useRelatedImportMembers(input: {
  readonly batch: string | undefined; readonly store: string | null; readonly lines: readonly { readonly id: string }[];
}): ReadonlySet<string> | undefined {
  const query = relatedImportQuery(input);
  const [resolved, setResolved] = useState<{ readonly query: string | null; readonly ids?: ReadonlySet<string> }>({ query });
  if (resolved.query !== query) setResolved({ query });
  useEffect(() => {
    if (query === null) return;
    const abort = new AbortController();
    void read({ name: 'lines', query, signal: abort.signal }).then(({ items }) => {
      if (!abort.signal.aborted) setResolved({ query, ids: new Set(items.map(({ id }) => id)) });
    }, () => {
      if (!abort.signal.aborted) setResolved({ query, ids: NO_IMPORT_MEMBERS });
    });
    return () => abort.abort();
  }, [query]);
  if (query === null) return NO_IMPORT_MEMBERS;
  return resolved.query === query ? resolved.ids : undefined;
}

function relatedImportQuery({ batch, store, lines }: Parameters<typeof useRelatedImportMembers>[0]): string | null {
  if (batch === undefined || lines.length === 0) return null;
  const params = new URLSearchParams({ importBatchId: batch, pageSize: String(MAX_MEMBERS) });
  const validStore = ProcurementStoreSchema.safeParse(store).data;
  if (validStore !== undefined) params.set('store', validStore);
  let length = params.toString().length;
  for (const { id } of lines.slice(0, MAX_MEMBERS)) {
    length += new URLSearchParams({ lineIds: id }).toString().length + 1;
    if (length > MAX_QUERY_LENGTH) break;
    params.append('lineIds', id);
  }
  return params.has('lineIds') ? params.toString() : null;
}

function isLocalOrderAddress(to: string): boolean {
  if (!to.startsWith('/') || to.startsWith('//') || /[\\\p{Cc}]/u.test(to)) return false;
  const { pathname } = new URL(to, 'https://workbench.invalid');
  return matchPath('/lines/:id', pathname) !== null;
}

function readRelatedOrderOrigin(state: unknown) {
  if (state === null || typeof state !== 'object' || !('relatedOrderOrigin' in state)) return undefined;
  return relatedOrderOriginSchema.safeParse(state.relatedOrderOrigin).data;
}

export function relatedOrderState(location: Location<unknown>, returnFocus: ReturnType<typeof detailReturnState>) {
  const state = withoutRelatedOrderFocus(location.state);
  const origin = readRelatedOrderOrigin(state);
  if (origin !== undefined) return { relatedOrderOrigin: origin };
  if (returnFocus === undefined) return undefined;
  return { relatedOrderOrigin: {
    to: createPath(location),
    state: { ...(typeof state === 'object' && state !== null ? state : {}), ...returnFocus },
  } };
}

export function relatedOrderFocusLink(lineId: string): string {
  return relatedFocusPrefix + lineId;
}

export function withoutRelatedOrderFocus(state: unknown): unknown {
  return withoutDetailReturnFocus(state, relatedFocusPrefix);
}

export function relatedOrderBack(state: unknown) {
  const origin = readRelatedOrderOrigin(state);
  return origin === undefined ? null : { ...origin, label: '返回原订单' };
}
