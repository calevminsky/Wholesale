// build-catalog.mjs — Wholesale portal catalog pipeline.
//
// Reads an F26 price-assignment seed, pulls per-size availability from the
// yb_reports Postgres, computes wholesale prices with the SAME engine the
// internal line-sheet builder uses (src/linesheets/pricing.js), resolves real
// Shopify handles, and writes wholesale-portal/data/catalog.json.
//
// The portal is a precomputed static catalog: this script produces the only
// artifact the front-end reads. Run it as the Render Static Site build command
// (or a nightly Cron Job) with REPORTING_DATABASE_URL + Shopify creds set.
//
// Usage:
//   node build/build-catalog.mjs [--seed build/assignments.json]
//                                [--out data/catalog.json]
//                                [--offer F26] [--allow-drafts]
//
// Env (read directly, or from ../.env / ./.env if not already set):
//   REPORTING_DATABASE_URL   (required) — Postgres with inventory_items/_levels
//   SHOPIFY_SHOP             *.myshopify.com
//   SHOPIFY_API_VERSION     e.g. 2025-07
//   SHOPIFY_ADMIN_TOKEN     OR (SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET)
//
// Handles: resolved from build/handles.cache.json first (committed, since
// handles rarely change), then live Shopify for any cache miss. The cache is
// rewritten after a successful build so it stays warm. Products whose handle
// can't be resolved are excluded with a warning (spec §14).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyPricing } from "../../src/linesheets/pricing.js";
import { loadOffPricing, offToPricing } from "./off-pricing.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, ".."); // wholesale-portal/

// ----------------- args -----------------
function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const next = process.argv[i + 1];
  return next && !next.startsWith("--") ? next : true;
}
const SEED_PATH = path.resolve(ROOT, arg("seed", "build/assignments.json"));
const OUT_PATH = path.resolve(ROOT, arg("out", "data/catalog.json"));
const OFFER = arg("offer", "F26");
const ALLOW_DRAFTS = Boolean(arg("allow-drafts", false));
const TIERS_PATH = path.resolve(__dirname, "tiers.config.json");
const HANDLE_CACHE_PATH = path.resolve(__dirname, "handles.cache.json");

// The five fulfillment locations (sum these for availability). Also the
// default location_ids written onto an order header downstream.
const LOCATIONS = [
  "gid://shopify/Location/68496293985", // Warehouse
  "gid://shopify/Location/31679414369", // Cedarhurst
  "gid://shopify/Location/20363018337", // Bogota
  "gid://shopify/Location/62070161505", // Toms River
  "gid://shopify/Location/33027424353"  // Teaneck Store
];

const SIZE_ORDER = ["XXS", "XS", "S", "M", "L", "XL", "XXL", "OS"];

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

// ----------------- color from title -----------------
// Color lives in parentheses, NOT always trailing:
//   "Achieve Skirt (Black) 23\""  -> Black
//   "Mina Swing Skirt 26\" (Black)" -> Black
function parseColor(title) {
  const m = String(title || "").match(/\(([^)]+)\)/);
  return m ? m[1].trim() : null;
}

// ----------------- Shopify token (mirrors server.js getAccessToken) -----------------
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

// Resolve gid -> { handle, status }. Cache-first, then live Shopify in batches.
async function resolveHandles(gids) {
  let cache = {};
  if (fs.existsSync(HANDLE_CACHE_PATH)) {
    try { cache = JSON.parse(fs.readFileSync(HANDLE_CACHE_PATH, "utf8")); } catch { cache = {}; }
  }
  const out = {};
  const misses = [];
  for (const gid of gids) {
    if (cache[gid]?.handle) out[gid] = cache[gid];
    else misses.push(gid);
  }
  if (misses.length) {
    let token = null;
    try { token = await getShopifyToken(); } catch (e) { console.warn(`  ! Shopify auth failed: ${e.message}`); }
    if (!token) {
      console.warn(`  ! ${misses.length} product(s) missing from handle cache and no Shopify creds — they will be excluded.`);
    } else {
      const QUERY = `query Handles($ids: [ID!]!) { nodes(ids: $ids) { ... on Product { id handle status } } }`;
      for (let i = 0; i < misses.length; i += 100) {
        const batch = misses.slice(i, i + 100);
        try {
          const data = await shopifyGraphQL(QUERY, { ids: batch });
          for (const n of data.nodes || []) {
            if (n?.id && n?.handle) out[n.id] = cache[n.id] = { handle: n.handle, status: n.status || null };
          }
        } catch (e) {
          console.warn(`  ! Handle batch ${i / 100} failed: ${e.message}`);
        }
      }
      // Keep the committed cache warm for the next build.
      try { fs.writeFileSync(HANDLE_CACHE_PATH, JSON.stringify(cache, null, 2)); } catch {}
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

  // 1. Seed: keep products assigned full/off, drop unassigned.
  const seed = JSON.parse(fs.readFileSync(SEED_PATH, "utf8"));
  const assigned = (seed.products || []).filter((p) => p.assignment === "full" || p.assignment === "off");
  const tierByGid = new Map();
  for (const p of assigned) {
    const gid = p.gid || `gid://shopify/Product/${p.id}`;
    tierByGid.set(gid, p.assignment);
  }
  const gids = [...tierByGid.keys()];
  console.log(`Seed: ${assigned.length} assigned (${seed.full?.length || 0} full / ${seed.off?.length || 0} off) from ${path.basename(SEED_PATH)}`);

  const tiers = JSON.parse(fs.readFileSync(TIERS_PATH, "utf8"));

  // 2. Postgres: header rows + per-size availability across the 5 locations.
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

  // Group variants by product.
  const variantsByGid = new Map();
  for (const v of variantRes.rows) {
    if (!variantsByGid.has(v.product_id)) variantsByGid.set(v.product_id, []);
    variantsByGid.get(v.product_id).push(v);
  }

  // 3. Resolve handles.
  const handleMap = await resolveHandles(gids);

  // 4. Build per-tier product lists and price them with the shared engine.
  // Full tier rule comes from tiers.config.json (50% of MSRP). Off tier rule
  // comes from off-pricing.json (set in the admin backend) + per-product overrides.
  // applyPricing expects: { product_id, compare_at_price, current_price, unit_cost }.
  const offCfg = loadOffPricing();
  const pricingByTier = { full: tiers.full, off: offToPricing(offCfg) };
  const priced = new Map(); // gid -> wholesale_price
  for (const tier of ["full", "off"]) {
    const rows = headerRes.rows
      .filter((r) => tierByGid.get(r.product_id) === tier)
      .map((r) => ({
        product_id: r.product_id,
        compare_at_price: r.compare_at,
        current_price: r.retail_price,
        unit_cost: r.unit_cost
      }));
    for (const p of applyPricing(rows, pricingByTier[tier])) priced.set(p.product_id, p.effective_price);
  }
  // "list" wholesale = the standard full-tier price (50% of MSRP) for EVERY
  // product. Off-price cards show this slashed next to the lower off price.
  const listPriced = new Map();
  const allRows = headerRes.rows.map((r) => ({ product_id: r.product_id, compare_at_price: r.compare_at, current_price: r.retail_price, unit_cost: r.unit_cost }));
  for (const p of applyPricing(allRows, tiers.full)) listPriced.set(p.product_id, p.effective_price);

  // 5. Assemble catalog products.
  const products = [];
  const dropped = { draft: [], no_handle: [], no_variants: [], no_price: [] };
  for (const r of headerRes.rows) {
    const gid = r.product_id;
    const tier = tierByGid.get(gid);
    const status = (r.product_status || "").toUpperCase();
    if (status === "DRAFT" && !ALLOW_DRAFTS) { dropped.draft.push(gid); continue; }
    const handleEntry = handleMap[gid];
    if (!handleEntry?.handle) { dropped.no_handle.push(gid); continue; }

    const rawVariants = variantsByGid.get(gid) || [];
    const sizes = rawVariants
      .filter((v) => v.size && SIZE_ORDER.includes(String(v.size).toUpperCase()))
      .map((v) => ({ size: String(v.size).toUpperCase(), sku: v.sku || null, available: Number(v.available) || 0 }))
      .sort((a, b) => SIZE_ORDER.indexOf(a.size) - SIZE_ORDER.indexOf(b.size));
    if (!sizes.length) { dropped.no_variants.push(gid); continue; }

    const wholesale = priced.get(gid);
    if (!Number.isFinite(wholesale) || wholesale <= 0) { dropped.no_price.push(gid); continue; }

    const numericId = gid.split("/").pop();
    products.push({
      product_id: numericId,
      gid,
      handle: handleEntry.handle,
      title: r.product_title,
      color: parseColor(r.product_title),
      type: r.product_type || null,
      class: r.class || null,
      style_name: r.style_name || null,
      tier,
      status,
      image: r.product_image || null,
      retail_price: r.retail_price != null ? Number(r.retail_price) : null,
      compare_at: r.compare_at != null ? Number(r.compare_at) : null,
      wholesale_price: wholesale,
      list_wholesale: listPriced.get(gid) ?? null,
      total_available: sizes.reduce((s, x) => s + x.available, 0),
      sizes
    });
  }

  products.sort((a, b) => (a.title || "").localeCompare(b.title || ""));

  const catalog = {
    generated_at: new Date().toISOString(),
    offer: OFFER,
    currency: "USD",
    size_order: SIZE_ORDER,
    locations: LOCATIONS,
    tier_rules: { full: summarizeRule(tiers.full), off: summarizeRule(tiers.off) },
    counts: {
      full: products.filter((p) => p.tier === "full").length,
      off: products.filter((p) => p.tier === "off").length,
      total: products.length
    },
    products
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(catalog, null, 2));

  // 6. Report.
  console.log(`\nWrote ${path.relative(ROOT, OUT_PATH)}`);
  console.log(`  Products: ${catalog.counts.total} (${catalog.counts.full} full / ${catalog.counts.off} off)`);
  const droppedTotal = Object.values(dropped).reduce((s, a) => s + a.length, 0);
  if (droppedTotal) {
    console.log(`  Dropped ${droppedTotal}: draft=${dropped.draft.length}, no_handle=${dropped.no_handle.length}, no_variants=${dropped.no_variants.length}, no_price=${dropped.no_price.length}`);
    for (const [k, arr] of Object.entries(dropped)) {
      if (arr.length) console.log(`    ${k}: ${arr.slice(0, 8).join(", ")}${arr.length > 8 ? ` …(+${arr.length - 8})` : ""}`);
    }
  }
  // Flag styles whose wholesale price gives the buyer no discount off MSRP
  // (e.g. an Off-tier style that isn't actually marked down in Shopify, so
  // "ride current price" lands at full retail). Not an error — a pricing heads-up.
  const noDiscount = products.filter((p) => {
    const msrp = Math.max(p.compare_at || 0, p.retail_price || 0);
    return msrp > 0 && p.wholesale_price >= msrp;
  });
  if (noDiscount.length) {
    console.log(`  ⚠ ${noDiscount.length} style(s) priced at/above MSRP (no wholesale discount) — mostly Off-tier styles not marked down in Shopify:`);
    const off = noDiscount.filter((p) => p.tier === "off").map((p) => p.handle);
    console.log(`    off: ${off.slice(0, 10).join(", ")}${off.length > 10 ? ` …(+${off.length - 10})` : ""}`);
  }

  // Spot-check sample.
  for (const p of products.slice(0, 3)) {
    console.log(`  e.g. ${p.handle} | ${p.tier} | retail $${p.retail_price} -> wholesale $${p.wholesale_price} | sizes ${p.sizes.map((s) => `${s.size}:${s.available}`).join(" ")}`);
  }
}

function summarizeRule(rule) {
  return {
    mode: rule.default_mode,
    value: rule.default_value,
    additional_discount_pct: rule.additional_discount_pct || 0,
    live_storefront_discount_pct: rule.live_storefront_discount_pct || 0
  };
}

main().catch((e) => { console.error(e); process.exit(1); });
