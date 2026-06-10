// Storage for the sales PLAN side (4-5-4 calendar rows, per-month targets, the
// annual goal). Actuals are not stored here — see shopify-actuals.js.
import { query } from "../pg.js";
import { generatePeriods } from "./calendar.js";

// Make sure the 12 calendar rows exist for a fiscal year, sourced from
// calendar.js (the single source of truth for 4-5-4 boundaries).
export async function ensurePeriods(fiscalYear) {
  const periods = generatePeriods(fiscalYear);
  for (const p of periods) {
    await query(
      `INSERT INTO wholesale_fiscal_periods
         (fiscal_year, period_index, label, starts_on, ends_on, weeks)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (fiscal_year, period_index) DO UPDATE
         SET label = EXCLUDED.label,
             starts_on = EXCLUDED.starts_on,
             ends_on = EXCLUDED.ends_on,
             weeks = EXCLUDED.weeks`,
      [fiscalYear, p.period_index, p.label, p.starts_on, p.ends_on, p.weeks]
    );
  }
  return periods;
}

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

// Returns { [period_index]: target_amount } for periods that have a target set.
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
