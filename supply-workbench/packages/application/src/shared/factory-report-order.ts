import type { FactoryReportKind } from '@sw/domain';

const reportOrder: Readonly<Record<FactoryReportKind, number>> = {
  in_transit: 0, demand: 1, shipment: 2, stock: 3, schedule: 4, packaging_combo: 5, customer_supplied: 6,
};

type ReportRef = { readonly kind: FactoryReportKind; readonly id: string };

export function compareFactoryReportWrites(left: ReportRef, right: ReportRef): number {
  return reportOrder[left.kind] - reportOrder[right.kind] || left.id.localeCompare(right.id);
}
