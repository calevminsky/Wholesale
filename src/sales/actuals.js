// Wholesale ACTUALS from the reporting DB (yb_reports) — no Shopify API needed.
//
// Headline + monthly totals come from `shopify_sales_daily.total_wholesale`, the
// company's own daily wholesale rollup (the number the wholesale plan is judged
// against). By-vendor comes from `order_lines WHERE is_wholesale` (the only
// source with customer identity); it nets returns and can differ slightly from
// the rollup. Both are bucketed by joining `fiscal_calendar` on the event date.
import { query } from "../pg.js";

// { byPeriod:{ [fiscal_month]: amount }, byVendor:[{name,sales,orders}],
//   total, asOf }
export async function fetchWholesaleActuals(fiscalYear) {
  const byPeriodRows = (await query(
    `SELECT fc.fiscal_month AS period_index,
            ROUND(SUM(sd.total_wholesale)::numeric, 2) AS actual
       FROM shopify_sales_daily sd
       JOIN fiscal_calendar fc ON fc.date = sd.date
      WHERE fc.fiscal_year = $1
      GROUP BY fc.fiscal_month`,
    [fiscalYear]
  )).rows;
  const byPeriod = {};
  for (const r of byPeriodRows) byPeriod[Number(r.period_index)] = Number(r.actual) || 0;

  const byVendor = (await query(
    `SELECT COALESCE(c.name, NULLIF(ol.customer_email, ''), '(no customer on order)') AS name,
            ROUND(SUM(ol.net_amount)::numeric, 2) AS sales,
            COUNT(DISTINCT ol.order_id)::int AS orders
       FROM order_lines ol
       JOIN fiscal_calendar fc ON fc.date = ol.event_date
       LEFT JOIN customers c ON lower(c.email) = lower(ol.customer_email)
      WHERE ol.is_wholesale = true AND fc.fiscal_year = $1
      GROUP BY 1
      HAVING SUM(ol.net_amount) <> 0
      ORDER BY sales DESC
      LIMIT 100`,
    [fiscalYear]
  )).rows.map((r) => ({ name: r.name, sales: Number(r.sales), orders: Number(r.orders) }));

  const { rows: asOfRows } = await query(
    `SELECT to_char(MAX(sd.date), 'YYYY-MM-DD') AS as_of
       FROM shopify_sales_daily sd
       JOIN fiscal_calendar fc ON fc.date = sd.date
      WHERE fc.fiscal_year = $1`,
    [fiscalYear]
  );

  const total = Object.values(byPeriod).reduce((a, b) => a + b, 0);
  return { byPeriod, byVendor, total, asOf: asOfRows[0]?.as_of || null };
}
