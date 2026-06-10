// Live wholesale ACTUALS from Shopify. Wholesale orders are identified by the
// "Wholesale" order tag (the importer auto-tags them; some are tagged manually
// in Shopify). The local importer DB only holds the subset that flowed through
// this app, so Shopify is the source of truth for "what did we actually sell".
//
// Primary path: ShopifyQL (shopifyqlQuery, Admin API 2025-10+) so the numbers
// match Shopify Analytics' "total sales" exactly. Falls back to aggregating the
// orders connection if ShopifyQL isn't available (e.g. missing read_reports).

import { generatePeriods, periodIndexFor } from "./calendar.js";

const QL_API_VERSION = "2025-10";
const WHOLESALE_TAG = "Wholesale";

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// shopifyqlQuery rows can come back as arrays (positional) or objects (keyed).
// Normalize to an array of objects keyed by column name.
function normalizeRows(tableData) {
  if (!tableData) return [];
  const cols = (tableData.columns || []).map((c) => c.name);
  return (tableData.rows || []).map((row) => {
    if (Array.isArray(row)) {
      const obj = {};
      cols.forEach((name, i) => { obj[name] = row[i]; });
      return obj;
    }
    return row;
  });
}

async function runShopifyQL(shopifyGraphQL, qlString) {
  const data = await shopifyGraphQL(
    `query($q: String!) {
       shopifyqlQuery(query: $q) {
         tableData { columns { name dataType } rows }
         parseErrors
       }
     }`,
    { q: qlString },
    { apiVersion: QL_API_VERSION }
  );
  const r = data && data.shopifyqlQuery;
  if (!r) throw new Error("shopifyqlQuery field unavailable");
  if (Array.isArray(r.parseErrors) && r.parseErrors.length) {
    throw new Error("ShopifyQL parse error: " + r.parseErrors.join("; "));
  }
  return normalizeRows(r.tableData);
}

// The window we ask Shopify about: from the FY start up to today (capped at the
// FY end). Returns { startsOn, endsOn } as 'YYYY-MM-DD'.
function actualWindow(fiscalYear, today) {
  const periods = generatePeriods(fiscalYear);
  const startsOn = periods[0].starts_on;
  const fyEnd = periods[11].ends_on;
  const todayStr = (today || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const endsOn = todayStr < fyEnd ? todayStr : fyEnd;
  return { startsOn, endsOn };
}

// ---- Primary: ShopifyQL ----
async function viaShopifyQL(shopifyGraphQL, fiscalYear, win) {
  const byDay = await runShopifyQL(
    shopifyGraphQL,
    `FROM sales SHOW total_sales ` +
    `WHERE order_tags CONTAINS '${WHOLESALE_TAG}' ` +
    `TIMESERIES day SINCE ${win.startsOn} UNTIL ${win.endsOn}`
  );
  const byPeriod = {};
  for (const row of byDay) {
    const day = String(row.day || row.$ts || Object.values(row)[0] || "").slice(0, 10);
    const idx = periodIndexFor(day, fiscalYear);
    if (idx) byPeriod[idx] = (byPeriod[idx] || 0) + num(row.total_sales);
  }

  const vendorRows = await runShopifyQL(
    shopifyGraphQL,
    `FROM sales SHOW total_sales, orders ` +
    `WHERE order_tags CONTAINS '${WHOLESALE_TAG}' ` +
    `GROUP BY customer_name SINCE ${win.startsOn} UNTIL ${win.endsOn} ` +
    `ORDER BY total_sales DESC LIMIT 100`
  );
  const byVendor = vendorRows
    .map((row) => ({
      name: String(row.customer_name || "").trim() || "(unattributed)",
      sales: num(row.total_sales),
      orders: num(row.orders)
    }))
    .filter((v) => v.sales > 0 || v.orders > 0);

  return { byPeriod, byVendor, source: "shopifyql" };
}

// ---- Fallback: orders connection ----
// Note: counts merchandise subtotal (after discounts, before tax/shipping), so
// totals can differ slightly from Analytics' "total sales". Also subject to the
// 60-day orders window unless the app has read_all_orders.
async function viaOrders(shopifyGraphQL, fiscalYear, win) {
  const q =
    `tag:'${WHOLESALE_TAG}' processed_at:>=${win.startsOn} processed_at:<=${win.endsOn}`;
  const byPeriod = {};
  const vendorMap = new Map();
  let after = null;
  for (let page = 0; page < 40; page++) {
    const data = await shopifyGraphQL(
      `query($q: String!, $after: String) {
         orders(first: 250, query: $q, after: $after, sortKey: PROCESSED_AT) {
           edges { node {
             processedAt
             currentSubtotalPriceSet { shopMoney { amount } }
             customer { displayName }
           } }
           pageInfo { hasNextPage endCursor }
         }
       }`,
      { q, after }
    );
    const conn = data.orders;
    for (const e of conn.edges) {
      const n = e.node;
      const day = String(n.processedAt || "").slice(0, 10);
      const amt = num(n.currentSubtotalPriceSet?.shopMoney?.amount);
      const idx = periodIndexFor(day, fiscalYear);
      if (idx) byPeriod[idx] = (byPeriod[idx] || 0) + amt;
      const name = (n.customer?.displayName || "").trim() || "(unattributed)";
      const cur = vendorMap.get(name) || { name, sales: 0, orders: 0 };
      cur.sales += amt;
      cur.orders += 1;
      vendorMap.set(name, cur);
    }
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  const byVendor = [...vendorMap.values()].sort((a, b) => b.sales - a.sales);
  return { byPeriod, byVendor, source: "orders" };
}

// Returns { byPeriod:{1..12:amount}, byVendor:[{name,sales,orders}],
//           total, source, asOf, window:{startsOn,endsOn} }.
export async function fetchWholesaleActuals({ shopifyGraphQL, fiscalYear, today }) {
  const win = actualWindow(fiscalYear, today);
  let result;
  try {
    result = await viaShopifyQL(shopifyGraphQL, fiscalYear, win);
  } catch (err) {
    console.warn("Sales: ShopifyQL unavailable, falling back to orders —", err.message);
    result = await viaOrders(shopifyGraphQL, fiscalYear, win);
  }
  const total = Object.values(result.byPeriod).reduce((a, b) => a + b, 0);
  return {
    ...result,
    total,
    asOf: win.endsOn,
    window: win
  };
}
