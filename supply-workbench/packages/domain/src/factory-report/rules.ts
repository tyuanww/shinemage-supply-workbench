import { normalizeText } from '../identity/text.js';

export function normalizeFactoryReportCode(raw: string | null | undefined): string {
  return (raw ?? '').normalize('NFKC').trim().toUpperCase();
}

/** 供应商原文和上传时选的代工厂不是同一个名字。空的不算不一致。 */
export function isFactoryMismatch(supplier: string | null, factoryName: string | null): boolean {
  if (supplier === null || factoryName === null) return false;
  const left = normalizeText(supplier);
  const right = normalizeText(factoryName);
  if (left === '' || right === '') return false;
  return left !== right;
}

/** 公式算出的 0，且来源表没有对应行，不是实际为零。 */
export function derivedZeroValue(qty: number | null, hasSource: boolean): number | null {
  if (qty === 0 && !hasSource) return null;
  return qty;
}

export function isDerivedNegative(qty: number | null): boolean {
  return qty !== null && qty < 0;
}
