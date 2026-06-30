// build-off-offering.mjs — Off Price offering snapshot.
//
// The Off Price tab serves a FIXED selection (the F26 off-price line sheet), not
// the live in-season catalog. This script (re)builds data/off-offering.json from
// the id list + per-type prices in data/off-seed.json:
//   - identity (handle/title/image/type/status) from Shopify by product id
//   - per-size availability + MSRP/cost from yb_reports Postgres
//   - falls back to the point-in-time sizes/prices captured in off-seed.json when
//     a style has no reporting inventory rows (e.g. an unpublished draft)
//   - bakes off_price per style from the rule (Tops $5 / Skirts $10 / Dresses $15)
//
// Usage:  REPORTING_DATABASE_URL=... SHOPIFY_* ... node build/build-off-offering.mjs
//
// Env: REPORTING_DATABASE_URL, SHOPIFY_SHOP, SHOPIFY_API_VERSION,
//      SHOPIFY_ADMIN_TOKEN (or SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SEED_PATH = path.resolve(ROOT, "data", "off-seed.json");
const OUT_PATH = path.resolve(ROOT, "data", "off-offering.json");

const LOCATIONS = [
  "gid://shopify/Location/68496293985", "gid://shopify/Location/31679414369",
  "gid://shopify/Location/20363018337", "gid://shopify/Location/62070161505",
  "gid://shopify/Location/33027424353"
];
const SIZE_ORDER = ["XXS", "XS", "S", "M", "L", "XL", "XXL", "OS"];
const parseColor = (t) => { const m = String(t || "").match(/\(([^)]+)\)/); return m ? m[1].trim() : null; };

function loadDotenvIfNeeded() {
  if (process.env.REPORTING_DATABASE_URL) return;
  for (const p of [path.resolve(ROOT, "..", ".env"), path.resolve(ROOT, ".env")]) {
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
    }
  }
}

const SHOP = process.env.SHOPIFY_SHOP;
const VERSION = process.env.SHOPIFY_API_VERSION || "2025-07";
let cachedToken = null;
async function getShopifyToken() {
  if (cachedToken) return cachedToken;
  if (process.env.SHOPIFY_ADMIN_TOKEN) return (cachedToken = process.env.SHOPIFY_ADMIN_TOKEN);
  const id = process.env.SHOPIFY_CLIENT_ID, secret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!id || !secret || !SHOP) return null;
  const body = new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret });
  const res = await fetch(`https://${SHOP}/admin/oauth/access_token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) throw new Error(`Shopify token exchange failed: ${res.status}`);
  return (cachedToken = json.access_token);
}
async function shopifyGraphQL(query, variables) {
  const token = await getShopifyToken();
  if (!token) throw new Error("no-shopify-creds");
  const res = await fetch(`https://${SHOP}/admin/api/${VERSION}/graphql.json`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables })
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.errors) throw new Error(`Shopify GraphQL error: ${JSON.stringify(json.errors || res.status)}`);
  return json.data;
}

const NODES_QUERY = `query Nodes($ids:[ID!]!){ nodes(ids:$ids){ ... on Product { id handle title productType status featuredImage { url } } } }`;
async function resolveIdentities(gids) {
  const out = new Map();
  for (let i = 0; i < gids.length; i += 50) {
    const data = await shopifyGraphQL(NODES_QUERY, { ids: gids.slice(i, i + 50) });
    for (const n of data.nodes || []) {
      if (n?.id) out.set(n.id, { handle: n.handle, title: n.title, type: n.productType, status: n.status, image: n.featuredImage?.url || null });
    }
  }
  return out;
}

async function main() {
  loadDotenvIfNeeded();
  if (!process.env.REPORTING_DATABASE_URL) { console.error("FATAL: REPORTING_DATABASE_URL is not set."); process.exit(1); }
  const seed = JSON.parse(fs.readFileSync(SEED_PATH, "utf8"));
  const rule = seed.rule || { Top: 5, Skirt: 10, Dress: 15 };
  const items = seed.items || [];
  const gids = items.map((i) => i.gid);

  const ids = await resolveIdentities(gids);

  const ssl = process.env.REPORTING_DATABASE_URL.includes("sslmode=disable") ? false : { rejectUnauthorized: false };
  const pool = new pg.Pool({ connectionString: process.env.REPORTING_DATABASE_URL, ssl, max: 4 });
  const variantSql = `
    SELECT ii.product_id, ii.variant_title AS size, ii.sku,
           SUM(COALESCE(il.available,0))::int AS available,
           MAX(ii.price::float) AS retail_price, MAX(ii.compare_at_price::float) AS compare_at,
           MAX(ii.unit_cost::float) AS unit_cost
    FROM inventory_items ii
    LEFT JOIN inventory_levels il ON il.inventory_item_id = ii.inventory_item_id AND il.location_id = ANY($2)
    WHERE ii.product_id = ANY($1)
    GROUP BY ii.product_id, ii.variant_title, ii.sku`;
  const variantRes = await pool.query(variantSql, [gids, LOCATIONS]);
  await pool.end();
  const dbByGid = new Map();
  for (const v of variantRes.rows) { if (!dbByGid.has(v.product_id)) dbByGid.set(v.product_id, []); dbByGid.get(v.product_id).push(v); }

  const products = [];
  const stats = { db: 0, raw: 0, no_identity: 0 };
  for (const it of items) {
    const meta = ids.get(it.gid);
    if (!meta?.handle) { stats.no_identity++; console.warn(`  ! no Shopify identity for ${it.gid} (${it.title})`); continue; }
    const rows = dbByGid.get(it.gid) || [];
    let sizes, compare, current, cost = null;
    if (rows.length) {
      sizes = rows.filter((v) => v.size && SIZE_ORDER.includes(String(v.size).toUpperCase()))
        .map((v) => ({ size: String(v.size).toUpperCase(), sku: v.sku || null, available: Number(v.available) || 0 }))
        .sort((a, b) => SIZE_ORDER.indexOf(a.size) - SIZE_ORDER.indexOf(b.size));
      compare = rows[0].compare_at != null ? Number(rows[0].compare_at) : null;
      current = rows[0].retail_price != null ? Number(rows[0].retail_price) : null;
      cost = rows[0].unit_cost != null ? Number(rows[0].unit_cost) : null;
      stats.db++;
    } else {
      const sz = it.sizes_raw || {};
      sizes = Object.keys(sz).filter((s) => SIZE_ORDER.includes(String(s).toUpperCase()))
        .map((s) => ({ size: String(s).toUpperCase(), sku: null, available: Number(sz[s]) || 0 }))
        .sort((a, b) => SIZE_ORDER.indexOf(a.size) - SIZE_ORDER.indexOf(b.size));
      compare = it.msrp != null ? Number(it.msrp) : null;
      current = it.current_price != null ? Number(it.current_price) : null;
      stats.raw++;
    }
    const title = meta.title || it.title;
    const type = meta.type || it.type;
    const msrp = (compare && compare > 0) ? compare : current;
    products.push({
      product_id: it.id, gid: it.gid, handle: meta.handle, title, color: parseColor(title), type,
      class: null, style_name: null, status: (meta.status || "DRAFT").toUpperCase(), image: meta.image || it.image || null,
      msrp, compare_at: compare, current_price: current, unit_cost: cost,
      total_available: sizes.reduce((s, x) => s + x.available, 0), sizes,
      off_price: Math.round(Number(rule[type] ?? it.off_price) || 0)
    });
  }
  products.sort((a, b) => String(a.title || "").localeCompare(String(b.title || "")));

  const out = {
    generated_at: new Date().toISOString(), offering: "off", offer: "INSEASON", currency: "USD",
    size_order: SIZE_ORDER, delivery_default_days: 14, locations: LOCATIONS, rule,
    counts: { selected: items.length, products: products.length },
    products
  };
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.log(`Wrote ${products.length}/${items.length} -> ${path.relative(ROOT, OUT_PATH)} (db ${stats.db}, raw-fallback ${stats.raw}, dropped ${stats.no_identity})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
