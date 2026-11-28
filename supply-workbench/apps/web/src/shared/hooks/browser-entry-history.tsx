import { createContext, useContext, useEffectEvent, useLayoutEffect, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router';

type Entry = { readonly key: string; readonly state: unknown; readonly index: number | undefined };
type History = { readonly current: Entry; readonly previous?: Entry; readonly focus: ReturnType<typeof focusOnArrival> };
const BrowserHistory = createContext<History | undefined>(undefined);
export const SearchDialogBlocksPageFocus = createContext(false);
export const globalSearchTriggerId = 'workbench-global-search-trigger';
const modifierKeys = new Set(['Alt', 'AltGraph', 'Control', 'Meta', 'Shift']);

function focusOnArrival() {
  const inherited = typeof document === 'undefined' ? null : document.activeElement;
  let hasInteracted = false;
  return {
    recordInput(event: Event) {
      if (event instanceof KeyboardEvent && modifierKeys.has(event.key)) return;
      hasInteracted = true;
    },
    canRestore({ allowInherited = false } = {}) {
      const active = document.activeElement;
      if (hasInteracted || active?.closest('[aria-modal="true"]')) return false;
      return active === document.body || (allowInherited && (active === inherited || active?.id === globalSearchTriggerId));
    },
  };
}

export function BrowserEntryHistory({ children }: { readonly children: ReactNode }) {
  const location = useLocation();
  const key = location.key;
  const entry: Entry = { key, state: location.state, index: browserEntryIndex(key) };
  const [history, setHistory] = useState<History>(() => ({ current: entry, focus: focusOnArrival() }));
  let visit = history;
  if (history.current.key !== key) {
    visit = { current: entry, previous: history.current, focus: focusOnArrival() };
    setHistory(visit);
  }
  const observePop = useEffectEvent(() => {
    // The browser can leave and return before React commits the intervening route.
    const state = window.history.state;
    if (typeof state?.idx === 'number' && (state.key ?? 'default') === visit.current.key && state.idx === visit.current.index) {
      setHistory({ current: visit.current, focus: focusOnArrival() });
    }
  });
  useLayoutEffect(() => {
    window.addEventListener('popstate', observePop, true);
    return () => window.removeEventListener('popstate', observePop, true);
  }, []);
  const { focus } = visit;
  useLayoutEffect(() => {
    const controller = new AbortController();
    for (const event of ['keydown', 'pointerdown', 'click', 'input', 'wheel']) {
      document.addEventListener(event, focus.recordInput, { capture: true, passive: true, signal: controller.signal });
    }
    return () => controller.abort();
  }, [focus]);
  return <BrowserHistory value={visit}>{children}</BrowserHistory>;
}

export function usePreviousBrowserEntry() {
  return useContext(BrowserHistory)?.previous;
}

const bodyHasFocus = () => document.activeElement === document.body;

export function useCanRestoreEntryFocus() {
  return useContext(BrowserHistory)?.focus.canRestore ?? bodyHasFocus;
}

export function browserEntryIndex(key: string): number | undefined {
  if (typeof window === 'undefined') return undefined;
  const state = window.history.state;
  if ((state?.key ?? 'default') !== key) return undefined;
  return typeof state?.idx === 'number' ? state.idx : undefined;
}
