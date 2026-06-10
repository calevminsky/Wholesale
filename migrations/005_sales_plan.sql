-- Wholesale sales plan: a 4-5-4 (NRF retail) monthly plan + per-month targets.
-- Actuals are NOT stored here — they're read live from Shopify (orders tagged
-- "Wholesale"). This holds only the plan/goals side. Safe to run more than once.

-- The 4-5-4 fiscal calendar. Rows are seeded by the app from src/sales/calendar.js
-- (single source of truth for the boundaries) on first access to a fiscal year.
CREATE TABLE IF NOT EXISTS wholesale_fiscal_periods (
  fiscal_year   INTEGER NOT NULL,
  period_index  INTEGER NOT NULL CHECK (period_index BETWEEN 1 AND 12),
  label         TEXT    NOT NULL,           -- "Feb".."Jan"
  starts_on     DATE    NOT NULL,
  ends_on       DATE    NOT NULL,
  weeks         INTEGER NOT NULL,           -- 4 or 5
  PRIMARY KEY (fiscal_year, period_index)
);

-- Per-month revenue target. Absent row = no target set yet for that month.
CREATE TABLE IF NOT EXISTS wholesale_sales_targets (
  fiscal_year   INTEGER NOT NULL,
  period_index  INTEGER NOT NULL CHECK (period_index BETWEEN 1 AND 12),
  target_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (fiscal_year, period_index)
);

-- One row per fiscal year: the annual goal the monthly plan should sum to.
CREATE TABLE IF NOT EXISTS wholesale_plan_settings (
  fiscal_year   INTEGER PRIMARY KEY,
  annual_goal   NUMERIC(12,2) NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Seed the current plan: FY2026 goal = $500,000.
INSERT INTO wholesale_plan_settings (fiscal_year, annual_goal)
VALUES (2026, 500000)
ON CONFLICT (fiscal_year) DO NOTHING;
