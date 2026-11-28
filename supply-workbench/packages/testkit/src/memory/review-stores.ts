import type { CodeLink, ItemCode, ItemName, PartyAlias } from '@sw/domain';
import type { NameDecision } from '../../../application/src/ports/item-name-repository.js';
import type { MemoryBox } from './box.js';
import { idRepository } from './repository.js';

export function aliasRepository(box: MemoryBox) {
  return {
    ...idRepository(() => box.current.aliases, '别名'),
    async findByNormName(normName: string) {
      return [...box.current.aliases.values()].find((alias) => alias.normName === normName);
    },
  };
}

export function itemCodeRepository(box: MemoryBox) {
  const repo = idRepository(() => box.current.itemCodes, '编码');
  return {
    ...repo,
    async insertIfAbsent(code: ItemCode) {
      const existing = [...box.current.itemCodes.values()].find((row) => row.codeType === code.codeType && row.codeNorm === code.codeNorm);
      if (existing !== undefined) return existing.id;
      await repo.save(code);
      return code.id;
    },
    async listByNorm(codeNorm: string) {
      return [...box.current.itemCodes.values()].filter((row) => row.codeNorm === codeNorm);
    },
  };
}

export function codeLinkRepository(box: MemoryBox) {
  const repo = idRepository(() => box.current.codeLinks, '编码对照');
  return {
    ...repo,
    async save(link: CodeLink) {
      const current = box.current.codeLinks.get(link.id);
      if (link.status === 'pending' && current !== undefined && current.status !== 'pending') return;
      await repo.save(link);
    },
    async listApproved() {
      return [...box.current.codeLinks.values()].filter((row) => row.status === 'approved');
    },
  };
}

export function itemNameRepository(box: MemoryBox) {
  return {
    async listByItem(itemId: string) {
      return [...box.current.itemNames.values()].filter((row) => row.itemId === itemId);
    },
    async save(name: ItemName) {
      box.current.itemNames.set(`${name.itemId}:${name.nameNorm}`, name);
    },
    async decision(itemId: string): Promise<NameDecision> {
      return box.current.nameDecisions.get(itemId) ?? 'undecided';
    },
    async saveDecision(itemId: string, mode: Exclude<NameDecision, 'undecided'>) {
      box.current.nameDecisions.set(itemId, mode);
    },
  };
}

export type { CodeLink, ItemCode, PartyAlias };
