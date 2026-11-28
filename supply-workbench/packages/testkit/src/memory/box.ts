import { AsyncLocalStorage } from 'node:async_hooks';
import { emptyState, type MemoryState } from './state.js';

type MemoryTransaction = { active: boolean };

export type MemoryBox = {
  current: MemoryState;
  readonly transaction: AsyncLocalStorage<MemoryTransaction>;
};

export function createMemoryBox(): MemoryBox {
  return { current: emptyState(), transaction: new AsyncLocalStorage() };
}
