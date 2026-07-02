-- Wholesale fulfillment ledger: normalized order lines (keyed by pd.variant)
-- + reservations (units set aside for a specific order line, on-hand or from
-- a PO receipt) + open-demand views consumed by yb-pd's allocation pre-pass
-- and yb-reports' Wholesale dashboard.
--
-- Safe to run more than once (this repo reruns every migration on boot).

-- ---------- wholesale_order_lines ----------
-- One row per (order, handle, size) exploded from wholesale_orders.items JSONB
-- and resolved to a pd.variant. Lines are never hard-deleted when an order is
-- edited — qty goes to 0 instead — so reservation history stays attached.
-- colorway_id / variant_id reference pd.colorway / pd.variant logically; no
-- cross-schema FK on purpose (pd owns its schema, coupling stays loose).
CREATE TABLE IF NOT EXISTS wholesale_order_lines (
  id            BIGSERIAL PRIMARY KEY,
  order_id      INTEGER NOT NULL REFERENCES wholesale_orders(id) ON DELETE CASCADE,
  handle        TEXT    NOT NULL,
  size          TEXT    NOT NULL,
  qty           INTEGER NOT NULL DEFAULT 0 CHECK (qty >= 0),
  unit_price    NUMERIC,
  colorway_id   BIGINT,
  variant_id    BIGINT,
  resolution    TEXT NOT NULL DEFAULT 'unresolved'
                CHECK (resolution IN ('resolved','unresolved_handle','unresolved_size')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (order_id, handle, size)
);

CREATE INDEX IF NOT EXISTS wol_variant_idx ON wholesale_order_lines (variant_id);
CREATE INDEX IF NOT EXISTS wol_order_idx   ON wholesale_order_lines (order_id);

-- ---------- wholesale_reservations ----------
-- Units set aside for one order line.
--   source 'on_hand'  — reserved from Warehouse stock at intake; transferred_at
--                       is stamped when the pull-sheet transfer is executed
--                       (physical move + Shopify Warehouse→Wholesale move).
--   source 'receipt'  — created at yb-pd PO closeout from units scanned into
--                       the Wholesale bucket; transferred_at is stamped at
--                       creation (closeout already pushed them to the Shopify
--                       Wholesale location — they must never be moved again).
--   released_at set   — reservation is dead (order edited/cancelled, or stock
--                       not found). A released row that HAD transferred_at set
--                       means units sit at Wholesale with no owner → surfaced
--                       as "return to Warehouse" on the dashboard.
CREATE TABLE IF NOT EXISTS wholesale_reservations (
  id             BIGSERIAL PRIMARY KEY,
  order_line_id  BIGINT NOT NULL REFERENCES wholesale_order_lines(id) ON DELETE CASCADE,
  variant_id     BIGINT NOT NULL,
  qty            INTEGER NOT NULL CHECK (qty > 0),
  source         TEXT NOT NULL CHECK (source IN ('on_hand','receipt')),
  po_id          BIGINT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  transferred_at TIMESTAMPTZ,
  released_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS wres_line_idx ON wholesale_reservations (order_line_id);
CREATE INDEX IF NOT EXISTS wres_variant_active_idx
  ON wholesale_reservations (variant_id) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS wres_po_idx
  ON wholesale_reservations (po_id) WHERE po_id IS NOT NULL;

-- ---------- open-demand views ----------
-- Demand = lines on live orders (not archived, not submitted/cancelled) whose
-- qty isn't fully covered by active (unreleased) reservations. Orders count
-- from the moment they land (status 'draft') — editing the order releases.
-- order_created_at drives FIFO when receipts are assigned to orders.
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
   AND l.variant_id IS NOT NULL
   AND l.qty - COALESCE(r.reserved, 0) > 0;

CREATE OR REPLACE VIEW wholesale_open_demand AS
SELECT variant_id, SUM(open_qty)::int AS open_qty
  FROM wholesale_open_demand_lines
 GROUP BY variant_id;
