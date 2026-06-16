// build-full-offering.mjs — In-season "Full Price" offering master.
//
// Unlike build-catalog.mjs (which is seeded from a curated F26 assignment file),
// this discovers the in-season universe straight from Shopify: every product that
// is ACTIVE and published to the Online Store. It then enriches each with per-size
// availability + MSRP/cost from the yb_reports Postgres (the same inventory tables
// build-catalog uses) and writes wholesale-portal/data/full-offering.json.
//
// It does NOT price the products. Full-price wholesale is a per-account number
// (50% or 40% of MSRP), so pricing happens at request time in server.mjs using
// the same applyPricing engine. The master only carries the raw inputs
// (compare_at / current_price / unit_cost) so the runtime can price per account.
//
// Manual control:
//   - "adds"    (settings key "offering:full".adds, list of handles) are resolved
//     against Shopify and merged in even if not ACTIVE/published — lets the admin
//     surface something the discovery rule misses.
//   - "removes" are applied at REQUEST time in server.mjs (instant, no rebuild),
//     so they are intentionally NOT applied here.
//
// Usage:
//   node build/build-full-offering.mjs [--out data/full-offering.json]
//
// Env (read directly, or from ../.env / ./.env if not already set):
//   REPORTING_DATABASE_URL   (required) — Postgres with inventory_items/_levels
//   SHOPIFY_SHOP             *.myshopify.com
//   SHOPIFY_API_VERSION     e.g. 2025-07
//   SHOPIFY_ADMIN_TOKEN     OR (SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, ".."); // wholesale-portal/

// ----------------- args -----------------
function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const next = process.argv[i + 1];
  return next && !next.startsWith("--") ? next : true;
}
const OUT_PATH = path.resolve(ROOT, arg("out", "data/full-offering.json"));

// The five fulfillment locations (sum these for availability). Kept in sync with
// build-catalog.mjs — these are also the default location_ids on an order header.
const LOCATIONS = [
  "gid://shopify/Location/68496293985", // Warehouse
  "gid://shopify/Location/31679414369", // Cedarhurst
  "gid://shopify/Location/20363018337", // Bogota
  "gid://shopify/Location/62070161505", // Toms River
  "gid://shopify/Location/33027424353"  // Teaneck Store
];

const SIZE_ORDER = ["XXS", "XS", "S", "M", "L", "XL", "XXL", "OS"];
const DEFAULT_LEAD_DAYS = 14; // in-stock styles quote a flat lead time (client-computed)

// Product types that are never part of a wholesale offering.
const EXCLUDE_TYPES = new Set(["gift card", "gift cards"]);

// ----------------- color from title (mirrors build-catalog.mjs) -----------------
function parseColor(title) {
  const m = String(title || "").match(/\(([^)]+)\)/);
  return m ? m[1].trim() : null;
}

// ----------------- minimal .env loader (no override of real env) -----------------
function loadDotenvIfNeeded() {
  if (process.env.REPORTING_DATABASE_URL) return;
  for (const p of [path.resolve(ROOT, "..", ".env"), path.resolve(ROOT, ".env")]) {
    if (!fs.existsSync(p)) continue;
    const text = fs.readFileSync(p, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const key = m[1];
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    }
  }
}

// ----------------- Shopify (mirrors build-catalog.mjs) -----------------
const SHOP = process.env.SHOPIFY_SHOP;
const VERSION = process.env.SHOPIFY_API_VERSION || "2025-07";
let cachedToken = null;
async function getShopifyToken() {
  if (cachedToken) return cachedToken;
  if (process.env.SHOPIFY_ADMIN_TOKEN) return (cachedToken = process.env.SHOPIFY_ADMIN_TOKEN);
  const id = process.env.SHOPIFY_CLIENT_ID;
  const secret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!id || !secret || !SHOP) return null;
  const body = new URLSearchParams();
  body.set("grant_type", "client_credentials");
  body.set("client_id", id);
  body.set("client_secret", secret);
  const res = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) throw new Error(`Shopify token exchange failed: ${res.status}`);
  return (cachedToken = json.access_token);
}

async function shopifyGraphQL(query, variables) {
  const token = await getShopifyToken();
  if (!token) throw new Error("no-shopify-creds");
  const res = await fetch(`https://${SHOP}/admin/api/${VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables })
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.errors) throw new Error(`Shopify GraphQL error: ${JSON.stringify(json.errors || res.status)}`);
  return json.data;
}

// Discover every ACTIVE product published to the Online Store. We filter on a
// non-null onlineStoreUrl (true online-store visibility) rather than the broader
// published_status, so unlisted/other-channel products don't leak in.
const DISCOVER_QUERY = `
  query Discover($q: String!, $after: String) {
    products(first: 50, query: $q, after: $after) {
      edges {
        node {
          id handle title status productType
          onlineStoreUrl
          featuredImage { url }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`;

async function discoverOnlineProducts() {
  const found = new Map(); // gid -> { handle, title, image, productType }
  let after = null;
  let pages = 0;
  for (;;) {
    const data = await shopifyGraphQL(DISCOVER_QUERY, {
      q: "status:active published_status:published",
      after
    });
    const conn = data.products;
    for (const { node } of conn.edges || []) {
      if (!node?.id) continue;
      if (!node.onlineStoreUrl) continue; // not visible on the online store
      if (EXCLUDE_TYPES.has(String(node.productType || "").toLowerCase())) continue;
      found.set(node.id, {
        handle: node.handle || null,
        title: node.title || null,
        image: node.featuredImage?.url || null,
        productType: node.productType || null
      });
    }
    pages++;
    if (!conn.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  console.log(`Shopify: discovered ${found.size} active + online-published product(s) over ${pages} page(s).`);
  return found;
}

// Resolve a list of admin "add" handles to Shopify products (even drafts/unlisted).
async function resolveAddHandles(handles) {
  const out = new Map(); // gid -> { handle, title, image, productType }
  const QUERY = `query ByHandle($handle: String!) {
    productByHandle(handle: $handle) { id handle title productType featuredImage { url } }
  }`;
  for (const handle of handles) {
    try {
      const data = await shopifyGraphQL(QUERY, { handle });
      const n = data.productByHandle;
      if (n?.id) {
        out.set(n.id, {
          handle: n.handle || handle,
          title: n.title || null,
          image: n.featuredImage?.url || null,
          productType: n.productType || null
        });
      } else {
        console.warn(`  ! add handle not found in Shopify: ${handle}`);
      }
    } catch (e) {
      console.warn(`  ! add handle "${handle}" failed: ${e.message}`);
    }
  }
  return out;
}

// ----------------- main -----------------
async function main() {
  loadDotenvIfNeeded();
  if (!process.env.REPORTING_DATABASE_URL) {
    console.error("FATAL: REPORTING_DATABASE_URL is not set.");
    process.exit(1);
  }

  // 1. Discover the in-season universe from Shopify + merge admin adds.
  const shopByGid = await discoverOnlineProducts();

  let adds = [];
  try {
    const { getAdminSetting } = await import("./admin-settings-store.mjs");
    const cfg = (await getAdminSetting("offering:full")) || {};
    adds = Array.isArray(cfg.adds) ? cfg.adds.filter(Boolean) : [];
  } catch (e) {
    console.warn(`  ! could not read offering:full adds: ${e.message}`);
  }
  const addsNotAlready = adds.filter((h) => ![...shopByGid.values()].some((v) => v.handle === h));
  if (addsNotAlready.length) {
    console.log(`Resolving ${addsNotAlready.length} manual add handle(s)…`);
    const added = await resolveAddHandles(addsNotAlready);
    for (const [gid, meta] of added) shopByGid.set(gid, meta);
  }

  const gids = [...shopByGid.keys()];
  if (!gids.length) {
    console.error("FATAL: no products discovered — refusing to write an empty offering.");
    process.exit(1);
  }

  // 2. Postgres: MSRP/cost header + per-size availability across the 5 locations.
  const ssl = process.env.REPORTING_DATABASE_URL.includes("sslmode=disable") ? false : { rejectUnauthorized: false };
  const pool = new pg.Pool({ connectionString: process.env.REPORTING_DATABASE_URL, ssl, max: 4 });

  const headerSql = `
    SELECT DISTINCT ON (ii.product_id)
      ii.product_id, ii.product_title, ii.product_image, ii.season,
      ii.product_status, ii.product_type, ii.class, ii.style_name,
      ii.price::float AS retail_price,
      ii.compare_at_price::float AS compare_at,
      ii.unit_cost::float AS unit_cost
    FROM inventory_items ii
    WHERE ii.product_id = ANY($1)
    ORDER BY ii.product_id`;
  const variantSql = `
    SELECT ii.product_id, ii.variant_title AS size, ii.sku,
           SUM(COALESCE(il.available, 0))::int AS available
    FROM inventory_items ii
    LEFT JOIN inventory_levels il
      ON il.inventory_item_id = ii.inventory_item_id
     AND il.location_id = ANY($2)
    WHERE ii.product_id = ANY($1)
    GROUP BY ii.product_id, ii.variant_title, ii.sku`;

  const [headerRes, variantRes] = await Promise.all([
    pool.query(headerSql, [gids]),
    pool.query(variantSql, [gids, LOCATIONS])
  ]);
  await pool.end();

  const headerByGid = new Map(headerRes.rows.map((r) => [r.product_id, r]));
  const variantsByGid = new Map();
  for (const v of variantRes.rows) {
    if (!variantsByGid.has(v.product_id)) variantsByGid.set(v.product_id, []);
    variantsByGid.get(v.product_id).push(v);
  }

  // 3. Assemble the master. We keep raw pricing inputs (compare_at/current/cost)
  //    and let server.mjs price per account at request time.
  const products = [];
  const dropped = { no_inventory: [], no_variants: [], no_msrp: [] };
  for (const gid of gids) {
    const meta = shopByGid.get(gid);
    const h = headerByGid.get(gid);
    if (!h) { dropped.no_inventory.push(gid); continue; } // in Shopify, not in reporting yet

    const rawVariants = variantsByGid.get(gid) || [];
    const sizes = rawVariants
      .filter((v) => v.size && SIZE_ORDER.includes(String(v.size).toUpperCase()))
      .map((v) => ({ size: String(v.size).toUpperCase(), sku: v.sku || null, available: Number(v.available) || 0 }))
      .sort((a, b) => SIZE_ORDER.indexOf(a.size) - SIZE_ORDER.indexOf(b.size));
    if (!sizes.length) { dropped.no_variants.push(gid); continue; }

    // MSRP = compare_at if set (item on sale), else the regular price. pricing.js
    // pct_of_higher applies the same fallback; we record it for transparency.
    const compareAt = h.compare_at != null ? Number(h.compare_at) : null;
    const retail = h.retail_price != null ? Number(h.retail_price) : null;
    const msrp = (compareAt && compareAt > 0) ? compareAt : retail;
    if (!Number.isFinite(msrp) || msrp <= 0) { dropped.no_msrp.push(gid); continue; }

    const numericId = gid.split("/").pop();
    products.push({
      product_id: numericId,
      gid,
      handle: meta.handle || h.product_title /* fallback never expected */,
      title: h.product_title || meta.title,
      color: parseColor(h.product_title || meta.title),
      type: h.product_type || meta.productType || null,
      class: h.class || null,
      style_name: h.style_name || null,
      status: (h.product_status || "ACTIVE").toUpperCase(),
      image: meta.image || h.product_image || null,
      // raw pricing inputs (server prices per account):
      msrp,
      compare_at: compareAt,
      current_price: retail,
      unit_cost: h.unit_cost != null ? Number(h.unit_cost) : null,
      total_available: sizes.reduce((s, x) => s + x.available, 0),
      sizes
    });
  }

  products.sort((a, b) => String(a.title || "").localeCompare(String(b.title || "")));

  const out = {
    generated_at: new Date().toISOString(),
    offering: "full",
    offer: "INSEASON",
    currency: "USD",
    size_order: SIZE_ORDER,
    delivery_default_days: DEFAULT_LEAD_DAYS,
    locations: LOCATIONS,
    counts: {
      discovered: gids.length,
      products: products.length,
      dropped_no_inventory: dropped.no_inventory.length,
      dropped_no_variants: dropped.no_variants.length,
      dropped_no_msrp: dropped.no_msrp.length
    },
    products
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.log(
    `Wrote ${products.length} product(s) -> ${path.relative(ROOT, OUT_PATH)} ` +
    `(dropped: ${dropped.no_inventory.length} no-inventory, ${dropped.no_variants.length} no-variants, ${dropped.no_msrp.length} no-msrp)`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
