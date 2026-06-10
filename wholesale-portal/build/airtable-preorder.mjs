// airtable-preorder.mjs — Pre-season (F26) wholesale pre-order feed.
//
// Most "Wholesale Fall2026" styles in Airtable are upcoming buys that don't
// exist in Shopify yet (no handle, no on-hand inventory). The availability-
// driven catalog build (build-catalog.mjs) can't source them. This module is
// the bridge: it reads those Airtable rows and turns them into "pre-order"
// catalog cards (no live stock, "book now") that the build merges in AFTER the
// Shopify-sourced products, de-duped so nothing already coming from Shopify is
// doubled.
//
// Source of truth is the Airtable **Wholesale Fall2026** checkbox: a row shows
// up here iff it's checked. To hide a pre-order style from the line sheet,
// uncheck it in Airtable and re-fetch (or add its id/handle to build/hidden.json
// for an instant local hide — see build-catalog.mjs).
//
// Two parts:
//   1. A fetcher (run this file directly) that pulls the checked rows over the
//      Airtable REST API and writes build/airtable-preorder.json — the committed
//      snapshot the build actually reads (same pattern as assignments.json, so
//      the build never needs Airtable creds).
//   2. Helpers (loadPreorderSnapshot / preorderRecordsToRows / sizesFromScale)
//      the catalog build imports to map the snapshot into priced catalog cards.
//
// Refresh the snapshot:  AIRTABLE_API_KEY=pat... node build/airtable-preorder.mjs
//   AIRTABLE_API_KEY   (required for fetch) — a read-only Airtable PAT with
//                      data.records:read on the S26 base.
//   AIRTABLE_BASE_ID   (optional) defaults to the S26 base below.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, ".."); // wholesale-portal/

export const PREORDER_SNAPSHOT_PATH = path.resolve(__dirname, "airtable-preorder.json");

// S26 base → Products table. The checkbox that opts a row into the line sheet.
const BASE_ID = process.env.AIRTABLE_BASE_ID || "apprgpWpvIhpTw15g";
const TABLE_ID = "tblb5qTBvAdDuxdvB";
const WHOLESALE_CHECKBOX = "Wholesale Fall2026";
// Fields we read (by name). Lookups (Type/Class/Style Image) come back as arrays.
const FIELDS = ["Product", "Color", "MSRP", "Status", "Type", "Class", "Size Scale", "Shopify_Product_GID", "Shopify Handle", "Product or Swatch", "Style Image", "TrueETA"];

// Airtable hands out EXPIRING attachment URLs, so we download each style's image
// at fetch time into this dir and store the local path in the snapshot instead.
const IMG_DIR = path.resolve(ROOT, "data", "preorder-img");
const IMG_PUBLIC = "data/preorder-img"; // path the front-end <img src> uses

// Airtable photos arrive as big PNGs (~1MB each). Re-encode every one to a small
// JPEG with sharp (cross-platform — works on macOS and the Linux CI runner),
// longest side 800px, q78 — cuts the committed image set ~8x.
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

// Map an Airtable "Size Scale" choice (e.g. "XS-XL") to an ordered size list.
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
//  - Skips rows whose name is blank (placeholder Airtable rows).
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
      eta: r.eta || null,
      sizes: sizesFromScale(r.size_scale)
    });
  }
  return rows;
}

// ----------------- fetcher (run directly) -----------------
function loadDotenvIfNeeded() {
  if (process.env.AIRTABLE_API_KEY) return;
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

// Lookup/array cells -> first value's name or the string itself.
function flatCell(v) {
  if (v == null) return null;
  if (Array.isArray(v)) return v.length ? flatCell(v[0]) : null;
  if (typeof v === "object") return v.name ?? v.text ?? null;
  return v;
}

// First attachment from an attachment field (array) OR a lookup of attachments
// ({ valuesByLinkedRecordId: { rec: [att,...] } }).
function firstAttachment(cell) {
  if (!cell) return null;
  if (Array.isArray(cell)) return cell[0] || null;
  if (cell.valuesByLinkedRecordId) {
    for (const arr of Object.values(cell.valuesByLinkedRecordId)) {
      if (Array.isArray(arr) && arr.length) return arr[0];
    }
  }
  return null;
}
function pickImage(...cells) {
  for (const c of cells) {
    const att = firstAttachment(c);
    const url = att && (att.thumbnails?.large?.url || att.thumbnails?.full?.url || att.url);
    if (url) return { url, ext: att.type === "image/png" ? "png" : "jpg" };
  }
  return null;
}

// Download each style's image into IMG_DIR (small concurrency); set record.image
// to the committed local path. Best-effort: a failed download just leaves no image.
async function downloadImages(records) {
  fs.mkdirSync(IMG_DIR, { recursive: true });
  const jobs = records.filter((r) => r._img && String(r.name || "").trim() && !r.shopify_gid);
  let ok = 0;
  const QUEUE = [...jobs];
  async function worker() {
    while (QUEUE.length) {
      const r = QUEUE.shift();
      try {
        const res = await fetch(r._img.url);
        if (!res.ok) throw new Error(String(res.status));
        const buf = Buffer.from(await res.arrayBuffer());
        const file = await compressToJpeg(buf, r.airtable_id); // -> "<id>.jpg"
        r.image = `${IMG_PUBLIC}/${file}`;
        ok++;
      } catch { /* leave r.image unset */ }
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  for (const r of records) delete r._img; // don't persist the temp URL
  return ok;
}

async function fetchAll() {
  const key = process.env.AIRTABLE_API_KEY;
  if (!key) throw new Error("AIRTABLE_API_KEY not set — get a read-only Airtable PAT (data.records:read on the S26 base).");
  const out = [];
  let offset = null;
  do {
    const u = new URL(`https://api.airtable.com/v0/${BASE_ID}/${TABLE_ID}`);
    u.searchParams.set("filterByFormula", `{${WHOLESALE_CHECKBOX}}=1`);
    u.searchParams.set("pageSize", "100");
    for (const f of FIELDS) u.searchParams.append("fields[]", f);
    if (offset) u.searchParams.set("offset", offset);
    const res = await fetch(u, { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) throw new Error(`Airtable ${res.status}: ${await res.text().catch(() => "")}`);
    const j = await res.json();
    for (const rec of j.records || []) {
      const f = rec.fields || {};
      out.push({
        airtable_id: rec.id,
        name: flatCell(f.Product),
        color: flatCell(f.Color),
        msrp: Number(f.MSRP) || 0,
        status: flatCell(f.Status),
        type: flatCell(f.Type),
        class: flatCell(f.Class),
        size_scale: flatCell(f["Size Scale"]),
        shopify_gid: flatCell(f.Shopify_Product_GID) || null,
        handle: flatCell(f["Shopify Handle"]) || null,
        eta: (flatCell(f.TrueETA) || "").slice(0, 10) || null, // best-known arrival (YYYY-MM-DD)
        image: null,
        _img: pickImage(f["Product or Swatch"], f["Style Image"])
      });
    }
    offset = j.offset || null;
  } while (offset);
  return out;
}

async function main() {
  loadDotenvIfNeeded();
  const records = await fetchAll();
  const imgOk = await downloadImages(records);
  const snapshot = { fetched_at: new Date().toISOString(), source: `${BASE_ID}/${TABLE_ID}`, checkbox: WHOLESALE_CHECKBOX, count: records.length, records };
  fs.writeFileSync(PREORDER_SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2));
  const named = records.filter((r) => String(r.name || "").trim());
  const withGid = records.filter((r) => r.shopify_gid);
  const withMsrp = named.filter((r) => !r.shopify_gid && Number(r.msrp) > 0);
  console.log(`Wrote ${path.relative(ROOT, PREORDER_SNAPSHOT_PATH)}`);
  console.log(`  ${records.length} checked rows | ${named.length} named | ${withGid.length} already in Shopify (skipped as pre-order) | ${withMsrp.length} pre-order with a price | ${imgOk} images downloaded`);
}

// Run as a script (not when imported).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
