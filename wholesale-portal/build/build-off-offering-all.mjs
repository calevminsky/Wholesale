// build-off-offering-all.mjs — the broad "Off Price — All" snapshot.
//
// Union of:
//   A) the curated in-season Off Price selection (data/off-offering.json), and
//   B) every online-published, marked-down style (data/full-offering.json) that
//      is non-core and has >= 10 units in Bogota + Warehouse.
// Priced by type: Dress $15 / Skirt $10 / Top $5. Writes data/off-offering-all.json.
//
// Run this AFTER build-full-offering + build-off-offering (it reads their output).
// Needs REPORTING_DATABASE_URL for the class / per-location-stock filter (the rest
// comes from the two local snapshots — no Shopify calls).
//
// Usage:  REPORTING_DATABASE_URL=... node build/build-off-offering-all.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RULE = { Dress: 15, Skirt: 10, Top: 5 };
const TYPE_ORDER = { Dress: 0, Skirt: 1, Top: 2 };
const WAREHOUSE = "gid://shopify/Location/68496293985";
const BOGOTA = "gid://shopify/Location/20363018337";
const MIN_UNITS = 10;

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

async function main() {
  loadDotenvIfNeeded();
  if (!process.env.REPORTING_DATABASE_URL) { console.error("FATAL: REPORTING_DATABASE_URL is not set."); process.exit(1); }
  const off = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "off-offering.json"), "utf8"));
  const full = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "full-offering.json"), "utf8"));

  // DB: the eligible website markdown set (product_ids). class != Core, on sale,
  // Dress/Skirt/Top, >= MIN_UNITS in Bogota + Warehouse, active.
  const ssl = process.env.REPORTING_DATABASE_URL.includes("sslmode=disable") ? false : { rejectUnauthorized: false };
  const pool = new pg.Pool({ connectionString: process.env.REPORTING_DATABASE_URL, ssl, max: 4 });
  const sql = `
    WITH hdr AS (
      SELECT DISTINCT ON (product_id) product_id, product_type, class, product_status,
             price::float AS price, compare_at_price::float AS compare_at
      FROM inventory_items ORDER BY product_id, variant_id
    ),
    loc AS (
      SELECT ii.product_id, SUM(COALESCE(il.available,0))::int AS avail
      FROM inventory_items ii
      JOIN inventory_levels il ON il.inventory_item_id = ii.inventory_item_id AND il.location_id = ANY($1)
      GROUP BY ii.product_id
    )
    SELECT h.product_id FROM hdr h JOIN loc l USING (product_id)
    WHERE h.product_status = 'ACTIVE' AND COALESCE(h.class,'') <> 'Core'
      AND h.compare_at IS NOT NULL AND h.price < h.compare_at
      AND h.product_type IN ('Dress','Skirt','Top') AND l.avail >= $2`;
  const { rows } = await pool.query(sql, [[WAREHOUSE, BOGOTA], MIN_UNITS]);
  await pool.end();
  const eligible = new Set(rows.map((r) => String(r.product_id).split("/").pop()));

  const byId = new Map();
  for (const p of off.products) byId.set(String(p.product_id), { ...p }); // Set A (keeps baked off_price)
  let addedB = 0;
  for (const p of full.products) {                                        // Set B (online-published markdowns)
    const id = String(p.product_id);
    if (!eligible.has(id) || byId.has(id)) continue;
    const op = RULE[p.type];
    if (op == null) continue;
    byId.set(id, { ...p, off_price: op, list_wholesale: null });
    addedB++;
  }
  const products = [...byId.values()]
    .sort((a, b) => (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9) || String(a.title).localeCompare(String(b.title)));

  const out = {
    generated_at: new Date().toISOString(), offering: "offall", offer: "INSEASON", currency: "USD",
    size_order: off.size_order, delivery_default_days: off.delivery_default_days || 14, locations: off.locations,
    rule: RULE, note: "In-season Off Price + all online-published marked-down styles (non-core, >=10 Bogota+Warehouse). Dress $15 / Skirt $10 / Top $5.",
    counts: { products: products.length }, products
  };
  fs.writeFileSync(path.join(ROOT, "data", "off-offering-all.json"), JSON.stringify(out, null, 2));
  console.log(`Wrote ${products.length} -> data/off-offering-all.json (in-season ${off.products.length}, +website ${addedB}, eligible ${eligible.size})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
