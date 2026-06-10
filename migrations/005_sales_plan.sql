-- Wholesale sales plan (PLAN side only). Actuals come live from the reporting
-- DB (shopify_sales_daily.total_wholesale + order_lines), bucketed by the
-- company's own `fiscal_calendar` (4-5-4, January-anchored). Safe to re-run.

-- Per-fiscal-month wholesale revenue target. period_index = fiscal_month (1-12)
-- of the company fiscal_calendar. Absent row = no target set yet.
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

-- Drop the redundant calendar table from the first cut — the company's
-- `fiscal_calendar` is the source of truth for 4-5-4 boundaries now.
DROP TABLE IF EXISTS wholesale_fiscal_periods;
