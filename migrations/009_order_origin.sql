-- Two distinct populations share wholesale_orders and must not be conflated:
--   origin 'importer' — real-time orders (rep uploads / manual drafts) filled
--                       immediately from existing stock via preview -> submit.
--                       These NEVER feed the preorder-fulfillment ledger.
--   origin 'portal'   — buyer self-service portal orders (mixed preorder +
--                       in-stock). Only these drive wholesale_open_demand,
--                       the on-hand sweep, and the yb-reports dashboard.
-- Safe to run more than once.

ALTER TABLE wholesale_orders
  ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'importer';

-- Backfill: portal-built orders tag every item with _sources like
-- "(portal:slug)" / "(season:full:slug)" / "(season:off:slug)".
UPDATE wholesale_orders
   SET origin = 'portal'
 WHERE origin = 'importer'
   AND (items::text LIKE '%(portal:%' OR items::text LIKE '%(season:%');

-- Demand views (replace the origin-blind versions from 007): portal only.
CREATE OR REPLACE VIEW wholesale_open_demand_lines AS
SELECT l.id AS order_line_id,
       l.order_id,
       l.variant_id,
       o.created_at AS order_created_at,
       (l.qty - COALESCE(r.reserved, 0))::int AS open_qty
  FROM wholesale_order_lines l
  JOIN wholesale_orders o ON o.id = l.order_id
  LEFT JOIN (
        SELECT order_line_id, SUM(qty) AS reserved
          FROM wholesale_reservations
         WHERE released_at IS NULL
         GROUP BY order_line_id
       ) r ON r.order_line_id = l.id
 WHERE o.archived_at IS NULL
   AND o.status NOT IN ('submitted','cancelled')
   AND o.origin = 'portal'
   AND l.variant_id IS NOT NULL
   AND l.qty - COALESCE(r.reserved, 0) > 0;

CREATE OR REPLACE VIEW wholesale_open_demand AS
SELECT variant_id, SUM(open_qty)::int AS open_qty
  FROM wholesale_open_demand_lines
 GROUP BY variant_id;
