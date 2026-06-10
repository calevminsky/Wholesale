// The company's official 4-5-4 retail calendar lives in the reporting DB
// (`fiscal_calendar`, one row per day → fiscal_year/quarter/month/week). The
// fiscal year is January-anchored (FY2026 = Jan 4 2026 → Jan 2 2027), with
// 4-5-4 week-count months. We read it rather than computing our own so the
// sales plan buckets exactly match the other (retail) sales plans.
import { query } from "../pg.js";

// The 12 fiscal "months" for a year:
//   [{ period_index:1..12, label:'Jan'..'Dec', starts_on, ends_on, weeks }]
export async function getFiscalPeriods(fiscalYear) {
  const { rows } = await query(
    `SELECT fiscal_month AS period_index,
            to_char(MIN(month_start), 'Mon') AS label,
            to_char(MIN(date), 'YYYY-MM-DD') AS starts_on,
            to_char(MAX(date), 'YYYY-MM-DD') AS ends_on,
            COUNT(DISTINCT fiscal_week)::int AS weeks
       FROM fiscal_calendar
      WHERE fiscal_year = $1
      GROUP BY fiscal_month
      ORDER BY fiscal_month`,
    [fiscalYear]
  );
  return rows.map((r) => ({ ...r, period_index: Number(r.period_index) }));
}

// Where "today" sits in the retail calendar: { fiscal_year, fiscal_month }.
// Falls back to the latest covered day if today is outside the calendar range.
export async function getCurrentFiscalPosition() {
  const { rows } = await query(
    `SELECT fiscal_year, fiscal_month FROM fiscal_calendar WHERE date = CURRENT_DATE`
  );
  if (rows[0]) {
    return { fiscal_year: Number(rows[0].fiscal_year), fiscal_month: Number(rows[0].fiscal_month) };
  }
  const { rows: last } = await query(
    `SELECT fiscal_year, fiscal_month FROM fiscal_calendar ORDER BY date DESC LIMIT 1`
  );
  return last[0]
    ? { fiscal_year: Number(last[0].fiscal_year), fiscal_month: Number(last[0].fiscal_month) }
    : { fiscal_year: new Date().getFullYear(), fiscal_month: 1 };
}

// Status of a period relative to the current fiscal position.
export function periodStatus(fiscalYear, periodIndex, current) {
  if (fiscalYear < current.fiscal_year) return "closed";
  if (fiscalYear > current.fiscal_year) return "future";
  if (periodIndex < current.fiscal_month) return "closed";
  if (periodIndex > current.fiscal_month) return "future";
  return "current";
}
