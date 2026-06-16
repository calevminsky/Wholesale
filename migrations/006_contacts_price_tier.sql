-- Per-account contact people (CRM-lite) + price tier / print-label flags.
-- Safe to run more than once.

-- ---------- customers: price tier + print-label flag ----------
-- price_tier holds the spreadsheet's account type, e.g. 'Full Price' / 'Off Price'.
-- yb_print_label mirrors the "YB Print Label?" column (do we print the YB label?).
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS price_tier      TEXT,
  ADD COLUMN IF NOT EXISTS yb_print_label  BOOLEAN;

-- ---------- contacts ----------
-- People at an account. Today each account has one primary contact; the table is
-- shaped to hold many (buyer, owner, AP, etc.) so activity tracking can roll in later.
CREATE TABLE IF NOT EXISTS contacts (
  id           SERIAL PRIMARY KEY,
  customer_id  INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  role         TEXT,                 -- e.g. "Buyer", "Owner"
  email        TEXT,
  phone        TEXT,
  is_primary   BOOLEAN NOT NULL DEFAULT FALSE,
  notes        TEXT,
  archived_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contacts_customer
  ON contacts (customer_id) WHERE archived_at IS NULL;

-- At most one primary contact per account.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_contacts_primary
  ON contacts (customer_id) WHERE is_primary AND archived_at IS NULL;
