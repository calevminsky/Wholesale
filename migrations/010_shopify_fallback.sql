-- In-stock portal items are Shopify products that may not exist in pd at all
-- (the portal's in-stock catalog is built from Shopify, its preorder catalog
-- from pd). Lines that don't resolve to a pd variant now fall back to a
-- direct Shopify variant match — they behave like regular stock that just
-- needs the Warehouse -> Wholesale move, never "no supply".
--
-- Also: pd.variant.shopify_variant_id is bare-numeric for most rows while
-- public.inventory_items.variant_id is always a full GID. Every join between
-- them must compare the numeric tail (regexp_replace(x,'^.*/','')).
-- Safe to run more than once.

ALTER TABLE wholesale_order_lines ADD COLUMN IF NOT EXISTS shopify_variant_id TEXT;

ALTER TABLE wholesale_order_lines DROP CONSTRAINT IF EXISTS wholesale_order_lines_resolution_check;
ALTER TABLE wholesale_order_lines ADD CONSTRAINT wholesale_order_lines_resolution_check
  CHECK (resolution IN ('resolved','resolved_shopify','unresolved_handle','unresolved_size'));

-- Reservations for Shopify-only lines have no pd variant.
ALTER TABLE wholesale_reservations ALTER COLUMN variant_id DROP NOT NULL;
ALTER TABLE wholesale_reservations ADD COLUMN IF NOT EXISTS shopify_variant_id TEXT;

-- Backfill Shopify ids onto existing rows from pd (idempotent).
UPDATE wholesale_order_lines l
   SET shopify_variant_id = pv.shopify_variant_id::text
  FROM pd.variant pv
 WHERE pv.id = l.variant_id
   AND l.shopify_variant_id IS NULL
   AND pv.shopify_variant_id IS NOT NULL;

UPDATE wholesale_reservations r
   SET shopify_variant_id = pv.shopify_variant_id::text
  FROM pd.variant pv
 WHERE pv.id = r.variant_id
   AND r.shopify_variant_id IS NULL
   AND pv.shopify_variant_id IS NOT NULL;

-- Final demand views (this file owns them; 007/009 no longer define views —
-- CREATE OR REPLACE cannot shrink a view's column list, so exactly one
-- migration may define each view). Demand includes Shopify-resolved lines;
-- the per-pd-variant rollup (consumed by yb-pd's allocation pre-pass) stays
-- pd-only — Shopify-only styles never arrive on a pd PO.
DROP VIEW IF EXISTS wholesale_open_demand;
DROP VIEW IF EXISTS wholesale_open_demand_lines;

CREATE VIEW wholesale_open_demand_lines AS
SELECT l.id AS order_line_id,
       l.order_id,
       l.variant_id,
       o.created_at AS order_created_at,
       (l.qty - COALESCE(r.reserved, 0))::int AS open_qty,
       COALESCE(l.shopify_variant_id, pv.shopify_variant_id::text) AS shopify_variant_id
  FROM wholesale_order_lines l
  JOIN wholesale_orders o ON o.id = l.order_id
  LEFT JOIN pd.variant pv ON pv.id = l.variant_id
  LEFT JOIN (
        SELECT order_line_id, SUM(qty) AS reserved
          FROM wholesale_reservations
         WHERE released_at IS NULL
         GROUP BY order_line_id
       ) r ON r.order_line_id = l.id
 WHERE o.archived_at IS NULL
   AND o.status NOT IN ('submitted','cancelled')
   AND o.origin = 'portal'
   AND (l.variant_id IS NOT NULL OR l.shopify_variant_id IS NOT NULL)
   AND l.qty - COALESCE(r.reserved, 0) > 0;

CREATE VIEW wholesale_open_demand AS
SELECT variant_id, SUM(open_qty)::int AS open_qty
  FROM wholesale_open_demand_lines
 WHERE variant_id IS NOT NULL
 GROUP BY variant_id;
