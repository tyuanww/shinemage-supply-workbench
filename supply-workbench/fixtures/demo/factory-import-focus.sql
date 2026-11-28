BEGIN;
INSERT INTO purchase_orders (id, created_at, updated_at, po_raw, po_norm, po_format, related_po_raws, lane)
VALUES ('scope-po-component-c', now(), now(), 'FS-COMPONENT-C', 'FS-COMPONENT-C', 'OTHER', ARRAY[]::text[], 'material');
INSERT INTO order_lines (id, created_at, updated_at, purchase_order_id, lane, name_raw, qty_ordered, unit,
  origin, missing_in_latest_import, latest_import_presence, stage, stage_changed_at)
VALUES ('scope-line-component-c', now(), now(), 'scope-po-component-c', 'material', '合成范围采购子件 C', 10, '件',
  'import_procurement_component', false, 'not_applicable', 'no_batch', now());
INSERT INTO procurement_finished_lines (material_line_id, finished_line_id)
VALUES ('scope-line-component-c', 'scope-line-manual');
INSERT INTO procurement_observations (import_batch_id, sheet_name, row_no, finished_line_ids, material_line_id, reasons, fact)
SELECT import_batch_id, sheet_name, 6, finished_line_ids, 'scope-line-component-c', reasons,
  jsonb_set(fact, '{source,rowNo}', '6'::jsonb)
FROM procurement_observations WHERE material_line_id='scope-line-component';
INSERT INTO factory_stock_rows (id, import_batch_id, factory_party_id, sheet_name, row_no, raw, fingerprint,
  linked_order_line_id, link_status, created_at, updated_at)
SELECT 'scope-stock-component-c', import_batch_id, factory_party_id, sheet_name, 30, raw, 'scope-stock-component-c',
  'scope-line-component-c', 'manual', now(), now()
FROM factory_stock_rows WHERE id='scope-stock-manual';
INSERT INTO delivery_batches (id, created_at, updated_at, order_line_id, seq, planned_qty, planned_unit, receiver_party_id,
  date_buyer_confirmed, first_confirmed_date, status, status_changed_at, origin)
VALUES ('scope-manual-batch-focus', now(), now(), 'scope-line-manual', 1, 3, '件', '0199f0a0-0000-7000-8000-000000000010',
  '2026-11-29', '2026-11-29', 'confirmed', now(), 'manual');
UPDATE order_lines SET stage='awaiting_shipment', next_due_batch_id='scope-manual-batch-focus', next_due_date='2026-11-29'
WHERE id='scope-line-manual';
COMMIT;
