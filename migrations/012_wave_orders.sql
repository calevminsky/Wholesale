-- Wave orders: partial Shopify submissions of portal preorder drafts.
--
-- A "wave" turns the currently-fulfillable slice of a portal draft (active
-- reservations + delivered-not-yet-counted PO units, FIFO by order age) into
-- a real Shopify order committed at the Wholesale Holding Location, while the
-- draft itself stays open so its remaining demand keeps feeding the
-- reservation ledger and yb-pd's receiving allocation.
--
-- lines JSONB: [{order_line_id, handle, size, qty, unit_price,
--               shopify_variant_id, reserved, delivered}]
-- Safe to run more than once.

CREATE TABLE IF NOT EXISTS wholesale_wave_orders (
  id                 BIGSERIAL PRIMARY KEY,
  order_id           INTEGER NOT NULL REFERENCES wholesale_orders(id) ON DELETE CASCADE,
  shopify_order_id   TEXT,
  shopify_order_name TEXT,
  lines              JSONB NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS wwo_order_idx ON wholesale_wave_orders (order_id);
