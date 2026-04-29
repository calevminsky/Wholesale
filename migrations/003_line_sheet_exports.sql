-- Per-export snapshots of order-form pricing, plus columns on wholesale_orders
-- to record the upload's export token and any PPU mismatches found at parse time.
-- Safe to run more than once.

-- ---------- line_sheet_exports ----------
-- One row per "download order form" click. Stores the frozen [{handle, ppu}]
-- list so an uploaded file can be diffed against what we actually sent.
CREATE TABLE IF NOT EXISTS line_sheet_exports (
  id             SERIAL PRIMARY KEY,
  token          TEXT NOT NULL UNIQUE,
  line_sheet_id  INTEGER REFERENCES line_sheets(id) ON DELETE SET NULL,
  customer_id    INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  exported_at    TIMESTAMPTZ DEFAULT NOW(),
  -- [{handle, ppu}] — only the fields we diff. Title/MSRP not stored.
  items          JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_line_sheet_exports_sheet
  ON line_sheet_exports (line_sheet_id, exported_at DESC);

-- ---------- wholesale_orders.export_token / price_mismatches ----------
ALTER TABLE wholesale_orders
  ADD COLUMN IF NOT EXISTS export_token TEXT,
  ADD COLUMN IF NOT EXISTS price_mismatches JSONB DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_wholesale_orders_export_token
  ON wholesale_orders (export_token) WHERE export_token IS NOT NULL;
