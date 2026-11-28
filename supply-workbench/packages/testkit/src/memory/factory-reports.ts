import { normalizeFactoryReportCode, type FactoryReportRow, type OrderLineId } from '@sw/domain';
import type { FactoryReportRepository } from '../../../application/src/ports/factory-report-repository.js';
import { compareFactoryReportWrites } from '../../../application/src/shared/factory-report-order.js';
import type { MemoryBox } from './box.js';
import { idRepository } from './repository.js';

export function factoryReportRepository(box: MemoryBox) {
  const repo = idRepository(() => box.current.factoryReports, '代工厂上报');
  return {
    ...repo,
    async getForDemandGeneration(id: string) {
      return { row: await repo.get(id), version: null };
    },
    async demandSourcesAtGeneration() { return new Map<never, never>(); },
    lockSnapshotSource: async () => {},
    lockReportSources: async () => {},
    effectiveReportOwners: async () => [],
    lockSnapshotOrders: async () => {},
    async linkUnassignedTransit(rowId: string, lineId: OrderLineId) {
      const row = await repo.find(rowId);
      if (row?.kind !== 'in_transit' || row.linkedOrderLineId !== null) return false;
      await repo.save({ ...row, linkedOrderLineId: lineId, linkStatus: 'manual', linkReason: null });
      return true;
    },
    async listByCodeNorm(codeNorm: string) {
      const requested = normalizeFactoryReportCode(codeNorm);
      if (requested === '') return [];
      return [...box.current.factoryReports.values()].filter((row) => reportCodes(row).includes(requested));
    },
    async lockRelinkRows({ codeNorms, candidates }: Parameters<FactoryReportRepository['lockRelinkRows']>[0]) {
      const requested = new Set(codeNorms.map(normalizeFactoryReportCode).filter((code) => code !== ''));
      const matching = new Map<string, FactoryReportRow>();
      for (const candidate of candidates) {
        const row = box.current.factoryReports.get(candidate.id);
        if (canRelink(row, candidate) && reportCodes(row).some((code) => requested.has(code))) matching.set(row.id, row);
      }
      return [...matching.values()].sort(compareFactoryReportWrites);
    },
  };
}

function canRelink(row: FactoryReportRow | undefined, candidate: Pick<FactoryReportRow, 'kind' | 'factoryPartyId'>): row is FactoryReportRow {
  if (row?.kind !== candidate.kind || row.factoryPartyId !== candidate.factoryPartyId || row.linkStatus === 'manual') return false;
  if (row.kind !== 'in_transit' && row.kind !== 'demand') return false;
  const facts = row.kind === 'in_transit' ? row.inTransit : row.demand;
  return (facts?.poNorm ?? '') !== '';
}

function reportCodes(row: FactoryReportRow): string[] {
  if (row.kind === 'in_transit') {
    return [row.inTransit?.itemCodeRaw, row.inTransit?.barcodeRaw].map(normalizeFactoryReportCode).filter((code) => code !== '');
  }
  if (row.kind !== 'demand') return [];
  const code = normalizeFactoryReportCode(row.demand?.itemCodeRaw);
  return code === '' ? [] : [code];
}
