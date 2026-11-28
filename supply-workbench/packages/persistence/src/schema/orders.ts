import type { DeliveryBatch, ReceiptEvidence, ShipmentEvidence } from '@sw/domain';
import type { BatchDemandSource } from '../../../application/src/ports/delivery-batch-repository.js';
import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { at, day, id, qty, timestamps } from './columns.js';

function meta() {
  return { id: id(), ...timestamps };
}

export const purchaseOrders = pgTable(
  'purchase_orders',
  {
    ...meta(),
    poRaw: text('po_raw'),
    poNorm: text('po_norm'),
    poFormat: text('po_format').notNull(),
    relatedPoRaws: text('related_po_raws').array().notNull(),
    supplierPartyId: text('supplier_party_id'),
    supplierRaw: text('supplier_raw'),
    lane: text('lane').notNull(),
    oaDemandRef: text('oa_demand_ref'),
  },
  (table) => [index('purchase_orders_po_norm').on(table.poNorm)],
);

export const orderLines = pgTable(
  'order_lines',
  {
    ...meta(),
    purchaseOrderId: text('purchase_order_id').notNull(),
    lane: text('lane').notNull(),
    itemId: text('item_id'),
    itemCodeRaw: text('item_code_raw'),
    barcodeRaw: text('barcode_raw'),
    nameRaw: text('name_raw'),
    qtyOrdered: qty('qty_ordered'),
    unit: text('unit'),
    buyerUserId: text('buyer_user_id'),
    receiverPartyId: text('receiver_party_id'),
    origin: text('origin').notNull(),
    currentSnapshotId: text('current_snapshot_id'),
    candidateKey: text('candidate_key'),
    missingInLatestImport: boolean('missing_in_latest_import').notNull(),
    latestImportPresence: text('latest_import_presence').notNull().default('not_applicable'),
    cancelledAt: at('cancelled_at'),
    cancelReason: text('cancel_reason'),
    stage: text('stage').notNull(),
    stageChangedAt: at('stage_changed_at').notNull(),
    nextDueBatchId: text('next_due_batch_id'),
    nextDueDate: day('next_due_date'),
  },
  (table) => [
    index('order_lines_purchase_order_id').on(table.purchaseOrderId),
    uniqueIndex('order_lines_candidate_key_uq').on(table.candidateKey).where(sql`${table.candidateKey} is not null`),
    index('order_lines_stage_due').on(table.stage, table.nextDueDate),
    index('order_lines_buyer_user_id').on(table.buyerUserId),
    index('order_lines_barcode_raw').on(table.barcodeRaw),
    check('order_lines_latest_import_presence_check', sql`${table.latestImportPresence} in ('present', 'missing', 'unknown', 'not_applicable')`),
  ],
);

export const factoryOwnershipGuards = pgTable('factory_ownership_guards', {
  orderLineId: text('order_line_id').primaryKey().references(() => orderLines.id, { onDelete: 'cascade' }),
});

export const orderLineSnapshots = pgTable('order_line_snapshots', {
  id: text('id').primaryKey(),
  orderLineId: text('order_line_id').notNull(),
  importBatchId: text('import_batch_id').notNull(),
  importRowId: text('import_row_id').notNull(),
  data: jsonb('data').notNull(),
});

export const deliveryBatches = pgTable(
  'delivery_batches',
  {
    ...meta(),
    orderLineId: text('order_line_id').notNull(),
    seq: integer('seq').notNull(),
    plannedQty: qty('planned_qty').notNull(),
    plannedUnit: text('planned_unit'),
    receiverPartyId: text('receiver_party_id').notNull(),
    dateFactoryRequired: day('date_factory_required'),
    dateSupplierPromised: day('date_supplier_promised'),
    dateBuyerConfirmed: day('date_buyer_confirmed'),
    firstConfirmedDate: day('first_confirmed_date'),
    confirmedBy: text('confirmed_by'),
    confirmedAt: at('confirmed_at'),
    status: text('status').notNull(),
    statusChangedAt: at('status_changed_at').notNull(),
    origin: text('origin').notNull(),
    originRef: jsonb('origin_ref').$type<NonNullable<DeliveryBatch['originRef']> & {
      readonly generationSource?: BatchDemandSource | null;
    }>(),
    closedAt: at('closed_at'),
    closedReason: text('closed_reason'),
    cancelledAt: at('cancelled_at'),
    cancelReason: text('cancel_reason'),
  },
  (table) => [
    index('delivery_batches_order_line_id').on(table.orderLineId),
    index('delivery_batches_status_confirmed').on(table.status, table.dateBuyerConfirmed),
  ],
);

export const batchDateChanges = pgTable('batch_date_changes', {
  id: text('id').primaryKey(),
  batchId: text('batch_id').notNull(),
  field: text('field').notNull(),
  oldValue: day('old_value'),
  newValue: day('new_value'),
  reason: text('reason'),
  changedBy: text('changed_by').notNull(),
  changedAt: at('changed_at').notNull(),
});

export const shipments = pgTable('shipments', {
  ...meta(),
  batchId: text('batch_id').notNull(),
  qty: qty('qty').notNull(),
  shippedOn: day('shipped_on').notNull(),
  fulfillment: jsonb('fulfillment').$type<ShipmentEvidence>(),
  source: text('source').notNull(),
  factoryShipmentRowId: text('factory_shipment_row_id'),
  note: text('note'),
  createdBy: text('created_by').notNull(),
  voidedAt: at('voided_at'),
  voidedBy: text('voided_by'),
  voidReason: text('void_reason'),
});

export const receipts = pgTable('receipts', {
  ...meta(),
  batchId: text('batch_id').notNull(),
  qty: qty('qty').notNull(),
  receivedOn: day('received_on').notNull(),
  fulfillment: jsonb('fulfillment').$type<ReceiptEvidence>(),
  category: text('category').notNull(),
  source: text('source').notNull(),
  note: text('note'),
  createdBy: text('created_by').notNull(),
  voidedAt: at('voided_at'),
  voidedBy: text('voided_by'),
  voidReason: text('void_reason'),
});

export const deliveryNotes = pgTable('delivery_notes', {
  ...meta(),
  batchId: text('batch_id').notNull(),
  status: text('status').notNull(),
  returnedOn: day('returned_on'),
  verifiedOn: day('verified_on'),
  fileId: text('file_id'),
  note: text('note'),
  createdBy: text('created_by').notNull(),
  voidedAt: at('voided_at'),
  voidedBy: text('voided_by'),
  voidReason: text('void_reason'),
});

export const exceptions = pgTable('exceptions', {
  ...meta(),
  orderLineId: text('order_line_id').notNull(),
  batchId: text('batch_id'),
  type: text('type').notNull(),
  note: text('note').notNull(),
  status: text('status').notNull(),
  openedBy: text('opened_by').notNull(),
  closedBy: text('closed_by'),
  closedAt: at('closed_at'),
  closeNote: text('close_note'),
});

export const followUps = pgTable('follow_ups', {
  ...meta(),
  orderLineId: text('order_line_id').notNull(),
  batchId: text('batch_id'),
  kind: text('kind').notNull(),
  text: text('text').notNull(),
  reminder: jsonb('reminder').$type<{ readonly nextAt: string | null }>(),
  partyId: text('party_id'),
  createdBy: text('created_by').notNull(),
}, (table) => [
  index('follow_ups_batch_reminder').on(table.batchId, table.createdAt.desc(), table.id.desc())
    .where(sql`${table.reminder} IS NOT NULL AND ${table.batchId} IS NOT NULL`),
]);

export const ownerAssignments = pgTable(
  'owner_assignments',
  {
    ...meta(),
    subjectType: text('subject_type').notNull().default('order_line'),
    subjectId: text('subject_id').notNull(),
    ownerUserId: text('owner_user_id'),
    ownerNameRaw: text('owner_name_raw'),
    status: text('status').notNull(),
    source: text('source').notNull(),
    sourceRef: text('source_ref'),
    effectiveAt: at('effective_at').notNull(),
    supersededAt: at('superseded_at'),
  },
  (table) => [
    uniqueIndex('owner_assignments_current_uq').on(table.subjectType, table.subjectId).where(sql`"superseded_at" is null`),
    index('owner_assignments_subject').on(table.subjectType, table.subjectId),
    index('owner_assignments_owner_user_id').on(table.ownerUserId),
    index('owner_assignments_status').on(table.status),
    check('owner_assignments_status_check', sql`${table.status} in ('assigned', 'pending')`),
    check('owner_assignments_source_check', sql`${table.source} in ('po_master', 'mapping_import', 'manual')`),
    check('owner_assignments_owner_check', sql`(${table.status} = 'assigned') = (${table.ownerUserId} is not null)`),
  ],
);

export const lineFactoryLinks = pgTable(
  'line_factory_links',
  {
    ...meta(),
    orderLineId: text('order_line_id').notNull(),
    factoryPartyId: text('factory_party_id'),
    status: text('status').notNull(),
    source: text('source').notNull(),
    confidence: text('confidence').notNull(),
    poRaw: text('po_raw'),
    itemCodeRaw: text('item_code_raw'),
    barcodeRaw: text('barcode_raw'),
    reason: text('reason'),
    linkedAt: at('linked_at').notNull(),
  },
  (table) => [
    uniqueIndex('line_factory_links_order_line_uq').on(table.orderLineId),
    index('line_factory_links_factory_party_id').on(table.factoryPartyId),
    index('line_factory_links_status').on(table.status),
    check('line_factory_links_status_check', sql`${table.status} in ('linked', 'unlinked', 'manual')`),
    check('line_factory_links_source_check', sql`${table.source} in ('po_master', 'factory_progress', 'relink', 'manual')`),
    check('line_factory_links_confidence_check', sql`${table.confidence} in ('po', 'item_code', 'barcode', 'column', 'manual', 'none')`),
    check('line_factory_links_factory_check', sql`(${table.status} = 'unlinked') = (${table.factoryPartyId} is null)`),
  ],
);
