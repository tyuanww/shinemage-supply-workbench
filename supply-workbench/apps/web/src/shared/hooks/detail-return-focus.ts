import { useCallback, useEffect, useRef, type MouseEvent, type RefObject } from 'react';
import { createPath, useLocation, useNavigationType } from 'react-router';
import { z } from 'zod';
import { browserEntryIndex, useCanRestoreEntryFocus, usePreviousBrowserEntry } from './browser-entry-history.js';

const detailOriginSchema = z.union([
  z.object({ sourceKey: z.string(), detailPath: z.string(), sourceLink: z.string().optional() }),
  z.object({ sourceKey: z.undefined().optional(), detailPath: z.string(), sourceLink: z.string() }),
]);
type DetailOrigin = z.infer<typeof detailOriginSchema>;
const departureSchema = z.object({ detailDeparture: detailOriginSchema });
const historyMarker = 'workbenchDetailOrigin';
const linkId = (detailPath: string) => `detail-link:${detailPath}`;

export function useDetailFocusLink(detailPath: string, sourceLink = detailPath) {
  return useDetailFocusLinks()(detailPath, sourceLink);
}

export function useDetailFocusLinks() {
  const { key } = useLocation();
  return (detailPath: string, sourceLink = detailPath) => {
    const origin: DetailOrigin = { sourceKey: key, detailPath, ...(sourceLink === detailPath ? {} : { sourceLink }) };
    return {
      id: linkId(sourceLink),
      state: { detailOrigin: origin },
      onClick(event: MouseEvent<HTMLAnchorElement>) {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        window.history.replaceState({ ...window.history.state, [historyMarker]: origin }, '');
      },
    };
  };
}

function readOrigin(value: unknown): DetailOrigin | undefined {
  return detailOriginSchema.safeParse(value).data;
}

function linkOrigin(state: unknown) {
  return typeof state === 'object' && state !== null && 'detailOrigin' in state ? readOrigin(state.detailOrigin) : undefined;
}

function historyOrigin(key: string) {
  if (typeof window === 'undefined') return undefined;
  const origin = readOrigin(window.history.state?.[historyMarker]);
  return origin?.sourceKey === key ? origin : undefined;
}

export function detailReturnState(state: unknown, target: string | { detailPath: string; sourceLink: string }) {
  const detailPath = typeof target === 'string' ? target : target.detailPath;
  const origin = linkOrigin(state);
  if (origin?.detailPath === detailPath) return { detailOrigin: origin };
  return typeof target === 'string' ? undefined : { detailOrigin: target };
}

export function preserveDetailReturnState({ key, state }: { readonly key: string; readonly state: unknown }) {
  const origin = linkOrigin(state) ?? historyOrigin(key);
  if (origin === undefined) return state;
  return { ...(typeof state === 'object' && state !== null ? state : {}), detailOrigin: origin };
}

export function withoutDetailReturnFocus(state: unknown, sourceLinkPrefix: string): unknown {
  if (state === null || typeof state !== 'object' || !('detailOrigin' in state)) return state;
  if (readOrigin(state.detailOrigin)?.sourceLink?.startsWith(sourceLinkPrefix) !== true) return state;
  const rest = { ...state };
  Reflect.deleteProperty(rest, 'detailOrigin');
  return rest;
}

export type DetailReturnFocus = {
  readonly hasOrigin: boolean;
  readonly restore: (fallback: HTMLElement | null) => void;
};

export function detailDepartureState(state: unknown, departure: DetailOrigin) {
  return { ...(state !== null && typeof state === 'object' ? state : {}), detailDeparture: departure };
}

function useArrivalOrigin(sourceLinkPrefix: string) {
  const location = useLocation();
  const { key, state } = location;
  const navigation = useNavigationType();
  const previous = usePreviousBrowserEntry();
  const index = browserEntryIndex(key);
  const isForward = index !== undefined && previous?.index !== undefined && previous.index < index;
  const candidate = navigation === 'POP' && !isForward ? departureOnBack(previous, { key, index }) : linkOrigin(state);
  return { key, origin: matchesReturnRoute(candidate, { address: createPath(location), sourceLinkPrefix }) };
}

function departureOnBack(previous: ReturnType<typeof usePreviousBrowserEntry>, { key, index }: {
  readonly key: string; readonly index: number | undefined;
}) {
  if (index === undefined || previous?.index !== index + 1) return undefined;
  const departure = departureSchema.safeParse(previous.state).data?.detailDeparture;
  return departure?.sourceKey === key ? departure : undefined;
}

function matchesReturnRoute(origin: DetailOrigin | undefined, { address, sourceLinkPrefix }: {
  readonly address: string; readonly sourceLinkPrefix: string;
}) {
  return origin?.detailPath === address && origin.sourceLink?.startsWith(sourceLinkPrefix) === true ? origin : undefined;
}

export function useOneTimeDetailReturnFocus(sourceLinkPrefix: string): DetailReturnFocus {
  const { key, origin } = useArrivalOrigin(sourceLinkPrefix);
  const canRestore = useCanRestoreEntryFocus();
  const restored = useRef<{ key: string; canRestore: typeof canRestore } | null>(null);
  const restore = useCallback((fallback: HTMLElement | null) => {
    if (origin === undefined || (restored.current?.key === key && restored.current.canRestore === canRestore)) return;
    const target = findReturnTarget(origin, undefined) ?? fallback;
    if (target === null) return;
    // Limit focus changes to this visit. A later Back can reuse the same history entry.
    restored.current = { key, canRestore };
    if (canRestore()) target.focus();
  }, [key, origin, canRestore]);
  return { hasOrigin: origin !== undefined, restore };
}

type ReturnFocusFallback = {
  readonly heading: RefObject<HTMLElement | null>;
  readonly onMissing: () => void;
};

export function useDetailReturnFocus(isReady: boolean, { allowContainerFocus = false, fallback, sourcePath }: {
  readonly allowContainerFocus?: boolean; readonly fallback?: ReturnFocusFallback; readonly sourcePath?: string;
} = {}) {
  const { key, state } = useLocation();
  const navigation = useNavigationType();
  const restored = useRef<string | null>(null);
  useEffect(() => {
    if (!isReady || restored.current === key) return;
    const origin = navigation === 'POP' ? historyOrigin(key) : linkOrigin(state);
    if (origin === undefined || (sourcePath !== undefined && origin.detailPath !== sourcePath)) return;
    const destination = findReturnTarget(origin, fallback);
    if (!destination) return;
    restored.current = key;
    if (canRestoreFocus(destination, allowContainerFocus)) destination.focus();
  }, [allowContainerFocus, isReady, key, state, navigation, fallback, sourcePath]);
}

function findReturnTarget(origin: DetailOrigin, fallback: ReturnFocusFallback | undefined) {
  const target = document.getElementById(linkId(origin.sourceLink ?? origin.detailPath));
  if (target !== null) return target;
  fallback?.onMissing();
  return fallback?.heading.current;
}

function canRestoreFocus(target: HTMLElement, allowContainerFocus: boolean): boolean {
  const focused = document.activeElement;
  return focused === document.body || (allowContainerFocus && focused?.contains(target) === true);
}
