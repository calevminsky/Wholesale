// airtable-preorder.mjs — Pre-season (F26) wholesale pre-order feed.
//
// NOTE: this file is still named "airtable-preorder" for continuity (the snapshot
// it writes, the build import, the rebuild trigger and the resync workflow all
// reference that name), but it NO LONGER reads Airtable. The source of truth is
// now **pd** (the product-development app's Postgres schema, `pd.*`), which lives
// in the same yb_reports database the catalog build already connects to. The old
// Airtable "Wholesale Fall2026" checkbox is replaced by pd's per-season wholesale
// tagging table, pd.colorway_wholesale (season = 'F26').
//
// Most wholesale styles are upcoming buys that don't exist in Shopify yet (no
// handle, no on-hand inventory). The availability-driven catalog build
// (build-catalog.mjs) can't source them. This module is the bridge: it reads the
// wholesale-tagged colorways from pd and turns them into "pre-order" catalog cards
// (no live stock, "book now") that the build merges in AFTER the Shopify-sourced
// products, de-duped so nothing already coming from Shopify is doubled.
//
// A colorway shows up here iff it's tagged wholesale for one of PD_WHOLESALE_SEASONS
// in pd (toggle it in the pd product hub / grid). Colorways that already carry a
// Shopify product GID are skipped here — they flow through the Shopify path and are
// de-duped there. To hide a pre-order style from the line sheet, untag its wholesale
// season in pd and re-fetch (or add its id/handle to build/hidden.json for an
// instant local hide — see build-catalog.mjs).
//
// Two parts:
//   1. A fetcher (run this file directly) that queries the wholesale-tagged
//      colorways from pd and writes build/airtable-preorder.json — the committed
//      snapshot the build actually reads (same pattern as assignments.json, so
//      the build never needs to re-query pd).
//   2. Helpers (loadPreorderSnapshot / preorderRecordsToRows / sizesFromScale)
//      the catalog build imports to map the snapshot into priced catalog cards.
//
// Refresh the snapshot:  node build/airtable-preorder.mjs
//   REPORTING_DATABASE_URL  (required for fetch) — the yb_reports Postgres that
//                           holds the pd.* schema. Falls back to PD_DATABASE_URL.
//   PD_WHOLESALE_SEASONS    (optional) comma-separated seasons to pull; default "F26".

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, ".."); // wholesale-portal/

export const PREORDER_SNAPSHOT_PATH = path.resolve(__dirname, "airtable-preorder.json");

// Which pd wholesale seasons feed the pre-order line sheet. F26 ("Fall 2026") is
// the original "Wholesale Fall2026" set; add more (e.g. "F26,S27") via env.
const SEASONS = (process.env.PD_WHOLESALE_SEASONS || "F26")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// pd stores image bytes in pd.asset; we re-encode each to a small committed JPEG so
// the front-end serves a local file (no dependency on pd being up, and no expiring
// URLs — pd.asset.source_url still points at Airtable's expiring CDN, so we use the
// stored bytes instead).
const IMG_DIR = path.resolve(ROOT, "data", "preorder-img");
const IMG_PUBLIC = "data/preorder-img"; // path the front-end <img src> uses

// pd images arrive as big PNGs (~0.5MB each). Re-encode every one to a small JPEG
// with sharp (cross-platform — works on macOS and the Linux CI runner), longest
// side 800px, q78 — cuts the committed image set ~8x.
async function compressToJpeg(buf, id) {
  const out = path.join(IMG_DIR, `${id}.jpg`);
  await sharp(buf).rotate().resize({ width: 800, height: 1100, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 78 }).toFile(out);
  return `${id}.jpg`;
}

const SIZE_ORDER = ["XXS", "XS", "S", "M", "L", "XL", "XXL"];
const DEFAULT_SCALE = ["XS", "S", "M", "L", "XL"];

// "Achieve Skirt (Black) 23\"" -> "achieve-skirt-black-23"
export function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/["'’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Normalize a title for de-dupe: lowercased, collapsed whitespace, quotes off.
export function normTitle(s) {
  return String(s || "").toLowerCase().replace(/["'’]/g, "").replace(/\s+/g, " ").trim();
}

// Map a "Size Scale" choice (e.g. "XS-XL") to an ordered size list. Used as a
// fallback when a colorway has no variants to read real sizes from.
export function sizesFromScale(scale) {
  const raw = String(scale || "").trim().toUpperCase();
  if (!raw) return [...DEFAULT_SCALE];
  if (raw === "OS" || raw.includes("ONE SIZE")) return ["OS"];
  const m = raw.match(/^([A-Z]+)\s*[-–]\s*([A-Z]+)$/);
  if (m) {
    const a = SIZE_ORDER.indexOf(m[1]);
    const b = SIZE_ORDER.indexOf(m[2]);
    if (a !== -1 && b !== -1 && a <= b) return SIZE_ORDER.slice(a, b + 1);
  }
  return [...DEFAULT_SCALE];
}

// pg hands back a Date for a `date` column; render it as a plain YYYY-MM-DD
// (no timezone shift). Accepts a Date, a string, or null.
function isoDate(v) {
  if (!v) return null;
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, "0");
    const d = String(v.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(v).slice(0, 10) || null;
}

// Sort a raw list of variant sizes into a sensible order (XS, S, M, L, XL...).
function orderSizes(sizes) {
  const clean = [...new Set((sizes || []).map((s) => String(s || "").trim().toUpperCase()).filter(Boolean))];
  if (!clean.length) return null;
  return clean.sort((a, b) => {
    const ia = SIZE_ORDER.indexOf(a);
    const ib = SIZE_ORDER.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
}

export function loadPreorderSnapshot() {
  if (!fs.existsSync(PREORDER_SNAPSHOT_PATH)) return { records: [] };
  try {
    const j = JSON.parse(fs.readFileSync(PREORDER_SNAPSHOT_PATH, "utf8"));
    return { records: Array.isArray(j.records) ? j.records : [] };
  } catch {
    return { records: [] };
  }
}

// Turn snapshot records into pre-priced catalog rows. Pricing is applied by the
// caller (build-catalog.mjs) with the shared engine. We only shape the data.
//  - Skips rows whose name is blank (placeholder rows).
//  - Skips rows that carry a Shopify GID — those belong to the Shopify path and
//    are handled (and de-duped) there; this feed is for not-yet-in-Shopify buys.
export function preorderRecordsToRows(records) {
  const rows = [];
  for (const r of records || []) {
    const name = String(r.name || "").trim();
    if (!name) continue;
    if (r.shopify_gid) continue; // real Shopify product → not a pre-order
    if (String(r.status || "").trim().toLowerCase() === "cancelled") continue; // killed buy
    const msrp = Number(r.msrp) || 0;
    rows.push({
      airtable_id: r.airtable_id,
      title: name,
      color: r.color || null,
      type: r.type || null,
      class: r.class || null,
      status: r.status || null,
      msrp,
      handle: r.handle || slugify(name),
      image: r.image || null,
      ship_start: r.ship_start || null,
      ship_cancel: r.ship_cancel || null,
      // Prefer real variant sizes captured from pd; fall back to the size-scale string.
      sizes: Array.isArray(r.sizes) && r.sizes.length ? r.sizes : sizesFromScale(r.size_scale)
    });
  }
  return rows;
}

// ----------------- fetcher (run directly) -----------------
function loadDotenvIfNeeded() {
  if (process.env.REPORTING_DATABASE_URL || process.env.PD_DATABASE_URL) return;
  for (const p of [path.resolve(ROOT, "..", ".env"), path.resolve(ROOT, ".env")]) {
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!(m[1] in process.env)) process.env[m[1]] = v;
    }
  }
}

function makePool() {
  const url = process.env.REPORTING_DATABASE_URL || process.env.PD_DATABASE_URL;
  if (!url) throw new Error("REPORTING_DATABASE_URL (or PD_DATABASE_URL) not set — needed to read pd wholesale colorways.");
  const ssl = url.includes("sslmode=disable") ? false : { rejectUnauthorized: false };
  return new pg.Pool({ connectionString: url, ssl, max: 4 });
}

// Pull every wholesale-tagged colorway (for the chosen seasons) with its style
// info and real variant sizes. Bytes for images are fetched per-record below.
async function fetchAll(pool) {
  const { rows } = await pool.query(
    `SELECT c.id,
            s.name        AS style_name,
            c.color,
            c.msrp,
            c.size_scale,
            s.type,
            s.class,
            c.shopify_gid,
            c.shopify_handle,
            c.wholesale_start,
            c.wholesale_cancel,
            (SELECT array_agg(v.size) FROM pd.variant v WHERE v.colorway_id = c.id) AS variant_sizes
       FROM pd.colorway c
       JOIN pd.style s ON s.id = c.style_id
      WHERE c.id IN (SELECT colorway_id FROM pd.colorway_wholesale WHERE season = ANY($1::text[]))
      ORDER BY s.name, c.color`,
    [SEASONS]
  );
  return rows.map((r) => {
    const color = r.color ? String(r.color).trim() : null;
    const styleName = String(r.style_name || "").trim();
    // Reconstruct the Airtable "Product" title shape: "Style (Color)" — keeps each
    // colorway uniquely titled so the build's title de-dupe doesn't collapse colors.
    const name = color ? `${styleName} (${color})` : styleName;
    return {
      airtable_id: String(r.id), // pd colorway id (field name kept for downstream compat)
      name,
      color,
      msrp: Number(r.msrp) || 0,
      // pd colorways don't carry a buy/PO status the line sheet cares about; the
      // build shows these as "PREORDER" when status is null.
      status: null,
      type: r.type || null,
      class: r.class || null,
      size_scale: r.size_scale || null,
      sizes: orderSizes(r.variant_sizes),
      shopify_gid: r.shopify_gid || null,
      handle: r.shopify_handle || null,
      // PO delivery window from pd (the dates we demand vendor delivery). The build
      // derives the customer delivery date from the cancel date (cancel + 7d).
      // Null → "Delivery TBD".
      ship_start: isoDate(r.wholesale_start),
      ship_cancel: isoDate(r.wholesale_cancel),
      image: null
    };
  });
}

// Download each style's image from pd.asset (the stored bytes, not the expiring
// source_url) into IMG_DIR; set record.image to the committed local path.
// Best-effort: a missing/failed image just leaves the record without one.
async function downloadImages(pool, records) {
  fs.mkdirSync(IMG_DIR, { recursive: true });
  const jobs = records.filter((r) => String(r.name || "").trim() && !r.shopify_gid);
  let ok = 0;
  const QUEUE = [...jobs];
  async function worker() {
    while (QUEUE.length) {
      const r = QUEUE.shift();
      try {
        const { rows } = await pool.query(
          `SELECT bytes FROM pd.asset
            WHERE colorway_id = $1 AND kind = 'image' AND bytes IS NOT NULL
            ORDER BY id LIMIT 1`,
          [Number(r.airtable_id)]
        );
        const buf = rows[0]?.bytes;
        if (!buf || !buf.length) continue; // no image stored → leave r.image unset
        const file = await compressToJpeg(buf, r.airtable_id); // -> "<id>.jpg"
        r.image = `${IMG_PUBLIC}/${file}`;
        ok++;
      } catch { /* leave r.image unset */ }
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  return ok;
}

async function main() {
  loadDotenvIfNeeded();
  const pool = makePool();
  try {
    const records = await fetchAll(pool);
    const imgOk = await downloadImages(pool, records);
    const snapshot = {
      fetched_at: new Date().toISOString(),
      source: "pd.colorway_wholesale",
      seasons: SEASONS,
      count: records.length,
      records
    };
    fs.writeFileSync(PREORDER_SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2));
    const named = records.filter((r) => String(r.name || "").trim());
    const withGid = records.filter((r) => r.shopify_gid);
    const withMsrp = named.filter((r) => !r.shopify_gid && Number(r.msrp) > 0);
    console.log(`Wrote ${path.relative(ROOT, PREORDER_SNAPSHOT_PATH)} (pd wholesale: ${SEASONS.join(", ")})`);
    console.log(`  ${records.length} tagged colorways | ${named.length} named | ${withGid.length} already in Shopify (skipped as pre-order) | ${withMsrp.length} pre-order with a price | ${imgOk} images downloaded`);
  } finally {
    await pool.end();
  }
}

// Run as a script (not when imported).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
