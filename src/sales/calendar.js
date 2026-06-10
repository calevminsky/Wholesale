// NRF 4-5-4 retail calendar.
//
// The retail year starts on the first Sunday on/after Feb 1 and is divided into
// 12 "months" of 4 or 5 weeks following the 4-5-4 pattern per quarter, labeled
// Feb..Jan. (FY2026 starts Sun Feb 1 2026; weeks run Sunday..Saturday.)
//
// We bucket actual sales (Shopify order dates) into these periods so the numbers
// line up with the merchant's other 4-5-4 sales plans instead of calendar months.

export const MONTH_LABELS = ["Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec","Jan"];
// Weeks per period: quarters of 4-5-4.
export const PERIOD_WEEKS = [4,5,4, 4,5,4, 4,5,4, 4,5,4];

function ymd(d) {
  return d.toISOString().slice(0, 10);
}

// First Sunday on/after Feb 1 of the given fiscal year (UTC, date-only math).
function fiscalYearStart(fiscalYear) {
  const d = new Date(Date.UTC(fiscalYear, 1, 1)); // Feb 1
  const dow = d.getUTCDay(); // 0 = Sunday
  if (dow !== 0) d.setUTCDate(d.getUTCDate() + (7 - dow));
  return d;
}

// Returns the 12 periods for a fiscal year:
//   [{ period_index:1..12, label, weeks, starts_on:'YYYY-MM-DD', ends_on:'YYYY-MM-DD' }]
export function generatePeriods(fiscalYear) {
  let cursor = fiscalYearStart(fiscalYear);
  const periods = [];
  for (let i = 0; i < 12; i++) {
    const start = new Date(cursor);
    const end = new Date(cursor);
    end.setUTCDate(end.getUTCDate() + PERIOD_WEEKS[i] * 7 - 1);
    periods.push({
      period_index: i + 1,
      label: MONTH_LABELS[i],
      weeks: PERIOD_WEEKS[i],
      starts_on: ymd(start),
      ends_on: ymd(end)
    });
    cursor = new Date(end);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return periods;
}

// Which fiscal year does a calendar date belong to? The 4-5-4 year that contains
// it. e.g. 2026-01-15 belongs to FY2025 (its Jan period), 2026-02-10 to FY2026.
export function fiscalYearOf(dateStr) {
  const d = String(dateStr).slice(0, 10);
  const yr = Number(d.slice(0, 4));
  // Try the calendar year and the one before; pick whichever range contains it.
  for (const fy of [yr, yr - 1]) {
    const ps = generatePeriods(fy);
    if (d >= ps[0].starts_on && d <= ps[11].ends_on) return fy;
  }
  return yr;
}

// Find the period (1..12) that contains a calendar date within a given FY.
// Returns null if the date is outside that fiscal year's range.
export function periodIndexFor(dateStr, fiscalYear) {
  const d = String(dateStr).slice(0, 10);
  const ps = generatePeriods(fiscalYear);
  const hit = ps.find((p) => d >= p.starts_on && d <= p.ends_on);
  return hit ? hit.period_index : null;
}
