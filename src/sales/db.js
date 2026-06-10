// Storage for the sales PLAN side (annual goal + per-fiscal-month targets).
// The calendar comes from `fiscal_calendar` (see calendar.js); actuals from
// the reporting tables (see actuals.js). period_index = fiscal_month (1-12).
import { query } from "../pg.js";

export async function getAnnualGoal(fiscalYear) {
  const { rows } = await query(
    `SELECT annual_goal FROM wholesale_plan_settings WHERE fiscal_year = $1`,
    [fiscalYear]
  );
  return rows[0] ? Number(rows[0].annual_goal) : 0;
}

export async function setAnnualGoal(fiscalYear, amount) {
  await query(
    `INSERT INTO wholesale_plan_settings (fiscal_year, annual_goal, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (fiscal_year) DO UPDATE
       SET annual_goal = EXCLUDED.annual_goal, updated_at = NOW()`,
    [fiscalYear, amount]
  );
  return getAnnualGoal(fiscalYear);
}

// Returns { [fiscal_month]: target_amount } for months that have a target set.
export async function getTargets(fiscalYear) {
  const { rows } = await query(
    `SELECT period_index, target_amount
       FROM wholesale_sales_targets WHERE fiscal_year = $1`,
    [fiscalYear]
  );
  const map = {};
  for (const r of rows) map[r.period_index] = Number(r.target_amount);
  return map;
}

export async function setTarget(fiscalYear, periodIndex, amount) {
  await query(
    `INSERT INTO wholesale_sales_targets
       (fiscal_year, period_index, target_amount, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (fiscal_year, period_index) DO UPDATE
       SET target_amount = EXCLUDED.target_amount, updated_at = NOW()`,
    [fiscalYear, periodIndex, amount]
  );
}

// Replace all targets for a fiscal year at once (used when seeding the plan).
export async function setTargets(fiscalYear, targetsByIndex) {
  for (const [idx, amount] of Object.entries(targetsByIndex)) {
    await setTarget(fiscalYear, Number(idx), Number(amount) || 0);
  }
  return getTargets(fiscalYear);
}
