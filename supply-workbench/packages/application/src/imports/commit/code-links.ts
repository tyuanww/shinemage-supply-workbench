import { entityId, parseItemCode, type CodeLink, type EntityId, type ItemCode, type ParsedItemCode } from '@sw/domain';
import type { CommitContext } from './context.js';

type RawLink = {
  readonly fromCodeRaw: string;
  readonly toCodeRaw: string;
  readonly sheetName: string;
  readonly rowNo: number;
};

type Pair = RawLink & {
  readonly from: ParsedItemCode;
  readonly to: ParsedItemCode;
};

type PendingCode = {
  readonly parsed: ParsedItemCode;
  readonly raw: string;
};

export async function saveFactoryCodeLinks(ctx: CommitContext): Promise<void> {
  const pairs = codePairs(ctx.batch.fileMeta);
  const codes = new Map<string, PendingCode>();
  for (const pair of pairs) {
    addCode(codes, { parsed: pair.from, raw: pair.fromCodeRaw });
    addCode(codes, { parsed: pair.to, raw: pair.toCodeRaw });
  }
  // 并发快照可能包含相同编码。先按固定顺序写编码，再按固定顺序写对照。
  const ids = await saveCodes(ctx, codes);
  for (const [key, pair] of sortedEntries(pairs.map((pair) => [linkKey(pair), pair] as const))) {
    await ensureLink({ ctx, pair, id: entityId(key), ids: {
      fromId: savedCodeId(ids, pair.from),
      toId: savedCodeId(ids, pair.to),
    } });
  }
}

function codePairs(fileMeta: unknown): readonly Pair[] {
  const pairs = new Map<string, Pair>();
  for (const link of linksOf(fileMeta)) {
    const pair = pairOf(link);
    if (pair === null) continue;
    const key = `${pair.from.codeType}:${pair.from.codeNorm}|${pair.to.codeType}:${pair.to.codeNorm}`;
    if (!pairs.has(key)) pairs.set(key, pair);
  }
  return [...pairs.values()];
}

function addCode(codes: Map<string, PendingCode>, code: PendingCode): void {
  const key = codeKey(code.parsed);
  if (!codes.has(key)) codes.set(key, code);
}

async function saveCodes(ctx: CommitContext, codes: ReadonlyMap<string, PendingCode>): Promise<ReadonlyMap<string, EntityId>> {
  const ids = new Map<string, EntityId>();
  for (const [key, { parsed, raw }] of sortedEntries(codes)) ids.set(key, await ensureCode({ ctx, parsed, raw }));
  return ids;
}

function savedCodeId(ids: ReadonlyMap<string, EntityId>, parsed: ParsedItemCode): EntityId {
  const id = ids.get(codeKey(parsed));
  if (id === undefined) throw new Error('工厂编码未保存');
  return id;
}

function codeKey(code: ParsedItemCode): string {
  return `code:${code.codeType}:${code.codeNorm}`;
}

function linkKey(pair: Pair): string {
  return `link:${pair.from.codeNorm}:${pair.to.codeNorm}`;
}

function sortedEntries<Value>(entries: Iterable<readonly [string, Value]>): (readonly [string, Value])[] {
  return [...entries].sort(([left], [right]) => {
    if (left === right) return 0;
    return left < right ? -1 : 1;
  });
}

async function ensureCode({ ctx, parsed, raw }: { readonly ctx: CommitContext; readonly parsed: ParsedItemCode; readonly raw: string }): Promise<EntityId> {
  const existing = (await ctx.tx.itemCodes.listByNorm(parsed.codeNorm)).find((row) => row.codeType === parsed.codeType);
  if (existing !== undefined) return existing.id;
  const id = entityId(codeKey(parsed));
  return ctx.tx.itemCodes.insertIfAbsent(newCode({ id, parsed, raw, at: ctx.at }));
}

async function ensureLink({ ctx, pair, id, ids }: { readonly ctx: CommitContext; readonly pair: Pair; readonly id: EntityId; readonly ids: { readonly fromId: EntityId; readonly toId: EntityId } }): Promise<void> {
  const existing = await ctx.tx.codeLinks.find(id);
  if (existing !== undefined && existing.status !== 'pending') return;
  await ctx.tx.codeLinks.save(pendingLink({ ctx, pair, fromId: ids.fromId, toId: ids.toId, id, existing }));
}

function pendingLink(input: { readonly ctx: CommitContext; readonly pair: Pair; readonly fromId: EntityId; readonly toId: EntityId; readonly id: EntityId; readonly existing: CodeLink | undefined }): CodeLink {
  return {
    id: input.id,
    createdAt: input.existing?.createdAt ?? input.ctx.at,
    updatedAt: input.ctx.at,
    fromCodeId: input.fromId,
    toCodeId: input.toId,
    status: 'pending',
    evidence: { importBatchId: input.ctx.batch.id, sheetName: input.pair.sheetName, rowNo: input.pair.rowNo },
    reviewedBy: input.existing?.reviewedBy ?? null,
    reviewedAt: input.existing?.reviewedAt ?? null,
  };
}

function newCode(input: { readonly id: EntityId; readonly parsed: ParsedItemCode; readonly raw: string; readonly at: string }): ItemCode {
  return { id: input.id, createdAt: input.at, updatedAt: input.at, codeType: input.parsed.codeType, codeRaw: input.raw, codeNorm: input.parsed.codeNorm, itemId: null, status: 'pending' };
}

function pairOf(link: RawLink): Pair | null {
  const from = parseItemCode(link.fromCodeRaw).value;
  const to = parseItemCode(link.toCodeRaw).value;
  if (from === null || from === undefined || to === null || to === undefined) return null;
  return { ...link, from, to };
}

function linksOf(fileMeta: unknown): RawLink[] {
  if (!isRecord(fileMeta) || !Array.isArray(fileMeta.codeLinks)) return [];
  return fileMeta.codeLinks.flatMap(rawLink);
}

function rawLink(value: unknown): RawLink[] {
  if (!isRecord(value)) return [];
  if (typeof value.fromCodeRaw !== 'string' || typeof value.toCodeRaw !== 'string') return [];
  if (typeof value.sheetName !== 'string' || typeof value.rowNo !== 'number') return [];
  return [{ fromCodeRaw: value.fromCodeRaw, toCodeRaw: value.toCodeRaw, sheetName: value.sheetName, rowNo: value.rowNo }];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
