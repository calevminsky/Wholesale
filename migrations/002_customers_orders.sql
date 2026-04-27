-- Customers, wholesale orders (drafts), preview snapshots, line sheet price history.
-- Safe to run more than once.

-- ---------- customers ----------
-- First-class record for an account/buyer. Replaces the free-text `customer`
-- column on line_sheets (kept for back-compat, see ALTER below).
CREATE TABLE IF NOT EXISTS customers (
  id                       SERIAL PRIMARY KEY,
  name                     TEXT NOT NULL,
  email                    TEXT,
  phone                    TEXT,
  shipping_address         JSONB DEFAULT '{}'::jsonb,
  -- Discount off MSRP. 50.00 means "wholesale = MSRP * 0.50". NULL = no tier set.
  -- Per-product overrides on the line sheet still win over this default.
  discount_pct_off_msrp    NUMERIC(5,2),
  default_location_ids     TEXT[] DEFAULT '{}',
  notes                    TEXT,
  archived_at              TIMESTAMPTZ,
  created_at               TIMESTAMPTZ DEFAULT NOW(),
  updated_at               TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_customers_name_lower_active
  ON customers (LOWER(name)) WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_customers_active
  ON customers (updated_at DESC) WHERE archived_at IS NULL;

-- ---------- line_sheets.customer_id ----------
-- Link line sheets to a real customer record. The legacy `customer` text column
-- stays for back-compat; new code should prefer customer_id.
ALTER TABLE line_sheets
  ADD COLUMN IF NOT EXISTS customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_line_sheets_customer
  ON line_sheets (customer_id) WHERE archived_at IS NULL;

-- ---------- wholesale_orders ----------
-- Persisted draft orders. Status flow:
--   draft       -> editing, no allocation run yet (or ran and was edited since)
--   previewed   -> allocation snapshot saved, ready to send to customer
--   submitted   -> Shopify order created (read-only)
--   cancelled   -> manually cancelled before submission
CREATE TABLE IF NOT EXISTS wholesale_orders (
  id                  SERIAL PRIMARY KEY,
  status              TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','previewed','submitted','cancelled')),
  customer_id         INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  line_sheet_id       INTEGER REFERENCES line_sheets(id) ON DELETE SET NULL,
  name                TEXT,                 -- e.g. "Spring 26 - Boutique X"
  notes               TEXT,
  location_ids        TEXT[] DEFAULT '{}',  -- warehouse drain order
  -- items: [{handle, title, unit_price, msrp, size_qty:{XXS:..XXL:..}}, ...]
  items               JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_filename     TEXT,                 -- original upload name if any
  shopify_order_id    TEXT,                 -- set when status=submitted
  shopify_order_name  TEXT,
  submitted_at        TIMESTAMPTZ,
  archived_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wholesale_orders_status
  ON wholesale_orders (status, updated_at DESC) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_wholesale_orders_customer
  ON wholesale_orders (customer_id) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_wholesale_orders_line_sheet
  ON wholesale_orders (line_sheet_id) WHERE archived_at IS NULL;

-- ---------- wholesale_order_previews ----------
-- One row per "Run Preview" click. Old snapshots are kept (audit trail) and
-- marked stale when the order's items change after the snapshot was taken.
CREATE TABLE IF NOT EXISTS wholesale_order_previews (
  id            SERIAL PRIMARY KEY,
  order_id      INTEGER NOT NULL REFERENCES wholesale_orders(id) ON DELETE CASCADE,
  -- Full runAllocationOnly() result blob: requestedSeen, availabilitySeen,
  -- metaByHandle, locationIdToName, locationIdsInOrder, etc.
  snapshot      JSONB NOT NULL,
  is_stale      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_previews_order
  ON wholesale_order_previews (order_id, created_at DESC);

-- ---------- line_sheet_price_history ----------
-- Audit trail for line sheet pricing edits (audit item #8).
CREATE TABLE IF NOT EXISTS line_sheet_price_history (
  id             SERIAL PRIMARY KEY,
  line_sheet_id  INTEGER NOT NULL REFERENCES line_sheets(id) ON DELETE CASCADE,
  pricing_before JSONB NOT NULL,
  pricing_after  JSONB NOT NULL,
  changed_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_price_history_sheet
  ON line_sheet_price_history (line_sheet_id, changed_at DESC);
