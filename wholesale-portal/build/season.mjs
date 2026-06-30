// In-season ("current season") portal logic: load the Full Price offering master
// (built by build-full-offering.mjs), price it PER ACCOUNT at request time using
// the same engine the internal line-sheet builder uses, build a server-authoritative
// order, and hand it to the importer as a draft.
//
// Pricing is never trusted from the client. The browser sends only {handle, size_qty};
// the unit price is recomputed here from the master + the account's level.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyPricing } from "../../src/linesheets/pricing.js";
import { SIZE_CORE, LOCATIONS } from "./orderfile.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MASTER_PATH = path.join(__dirname, "..", "data", "full-offering.json");

// The standard full-price level — shown slashed next to a better (e.g. 40%) price.
const STANDARD_LEVEL = 50;

// ---- master loader (cached by mtime, like server.mjs readCatalog) ----
let _master = null, _mtime = 0;
export function readFullOffering() {
  if (!fs.existsSync(MASTER_PATH)) return { products: [], offering: "full", missing: true };
  const st = fs.statSync(MASTER_PATH);
  if (!_master || st.mtimeMs !== _mtime) {
    _master = JSON.parse(fs.readFileSync(MASTER_PATH, "utf8"));
    _mtime = st.mtimeMs;
  }
  return _master;
}

// Price products at <level>% of MSRP. Returns Map: gid -> whole-dollar price.
// pct_of_higher uses compare_at when set, else current_price (== MSRP for a
// not-marked-down item), and never drops below unit_cost.
export function priceAt(products, level) {
  const rows = (products || []).map((p) => ({
    product_id: p.gid,
    compare_at_price: p.compare_at,
    current_price: p.current_price ?? p.msrp,
    unit_cost: p.unit_cost
  }));
  const pricing = { default_mode: "pct_of_higher", default_value: level, additional_discount_pct: 0, live_storefront_discount_pct: 0, overrides: {} };
  const out = new Map();
  for (const r of applyPricing(rows, pricing)) out.set(r.product_id, r.effective_price);
  return out;
}

// Assemble the buyer-facing, per-account Full Price catalog.
export function buildSeasonCatalog({ master, removes = [], hidden = new Set(), level }) {
  const removeSet = new Set(removes);
  const base = (master.products || []).filter((p) => !removeSet.has(p.handle) && !hidden.has(p.handle));
  const priced = priceAt(base, level);
  const listPriced = level === STANDARD_LEVEL ? priced : priceAt(base, STANDARD_LEVEL);
  return base
    .map((p) => ({
      product_id: p.product_id,
      gid: p.gid,
      handle: p.handle,
      title: p.title,
      color: p.color,
      type: p.type,
      class: p.class,
      style_name: p.style_name,
      status: p.status,
      image: p.image,
      msrp: p.msrp,
      compare_at: p.compare_at,
      retail_price: p.current_price,
      wholesale_price: priced.get(p.gid) ?? null,
      list_wholesale: listPriced.get(p.gid) ?? null,
      total_available: p.total_available,
      sizes: p.sizes
    }))
    .filter((p) => Number.isFinite(p.wholesale_price) && p.wholesale_price > 0);
}

// Build the order in the exact shape the importer's /api/orders-draft ingests
// (wholesale_orders.items). Prices are recomputed server-side from the master.
export function buildSeasonOrder({ account, lines, notes, shipping, level, master }) {
  const byHandle = new Map((master.products || []).map((p) => [p.handle, p]));
  const priced = priceAt(master.products || [], level);
  const items = [];
  let units = 0, subtotal = 0;
  const skipped = [];
  for (const line of lines || []) {
    const p = byHandle.get(line?.handle);
    const price = p ? priced.get(p.gid) : null;
    if (!p || !Number.isFinite(price)) { if (line?.handle) skipped.push(line.handle); continue; }
    const size_qty = {};
    let any = 0;
    for (const k of SIZE_CORE) { const q = Math.max(0, parseInt(line.size_qty?.[k], 10) || 0); size_qty[k] = q; any += q; }
    if (p.sizes.some((s) => s.size === "OS")) { const q = Math.max(0, parseInt(line.size_qty?.OS, 10) || 0); size_qty.OS = q; any += q; }
    if (!any) continue;
    items.push({ handle: p.handle, product_name: p.title, unit_price: price, size_qty, _sources: [`(season:full:${account.slug})`] });
    units += any;
    subtotal += any * price;
  }
  const dateStr = new Date().toISOString().slice(0, 10);
  const shipLabel = shipping === "when_ready" ? "Ship when ready" : "Ship all together";
  const userNotes = String(notes || "").trim();
  const order = {
    name: `In-Season Full — ${account.name} — ${dateStr}`,
    customer_id: account.customer_id ?? null,
    line_sheet_id: null,
    location_ids: LOCATIONS,
    shipping: shipping === "when_ready" ? "when_ready" : "all",
    notes: `[In-Season · Full Price · ${level}% of MSRP] [${shipLabel}]${userNotes ? " " + userNotes : ""}`,
    source_filename: `wholesale-portal/season-full/${account.slug}-${dateStr}.json`,
    items
  };
  return { order, units, subtotal, skipped, dateStr };
}

// ============================================================================
// Off Price offering. Its own frozen snapshot (data/off-offering.json — the F26
// off-price selection), NOT the in-season master. Every style is in by default
// and carries a baked off_price (Tops $5 / Skirts $10 / Dresses $15). The admin
// config only `removes` styles or `overrides` individual prices; pricing is the
// same for every account.
// ============================================================================

const OFF_MASTER_PATH = path.join(__dirname, "..", "data", "off-offering.json");
let _off = null, _offMtime = 0;
export function readOffOffering() {
  if (!fs.existsSync(OFF_MASTER_PATH)) return { products: [], offering: "off", missing: true };
  const st = fs.statSync(OFF_MASTER_PATH);
  if (!_off || st.mtimeMs !== _offMtime) {
    _off = JSON.parse(fs.readFileSync(OFF_MASTER_PATH, "utf8"));
    _offMtime = st.mtimeMs;
  }
  return _off;
}

// Effective Off Price for a snapshot product: an admin override wins, else the
// baked off_price.
function offPriceFor(p, overrides = {}) {
  const ov = overrides[p.gid];
  if (Number.isFinite(Number(ov)) && Number(ov) > 0) return Math.round(Number(ov));
  return Number.isFinite(Number(p.off_price)) ? Math.round(Number(p.off_price)) : null;
}

// Buyer-facing Off Price catalog: all snapshot styles minus removes/hidden.
export function buildOffCatalog({ master, removes = [], hidden = new Set(), overrides = {} }) {
  const removeSet = new Set(removes);
  const base = (master.products || []).filter((p) => !removeSet.has(p.handle) && !hidden.has(p.handle));
  return base
    .map((p) => ({
      product_id: p.product_id,
      gid: p.gid,
      handle: p.handle,
      title: p.title,
      color: p.color,
      type: p.type,
      class: p.class,
      style_name: p.style_name,
      status: p.status,
      image: p.image,
      msrp: p.msrp,
      compare_at: p.compare_at,
      retail_price: p.current_price,
      wholesale_price: offPriceFor(p, overrides),
      list_wholesale: null,
      total_available: p.total_available,
      sizes: p.sizes
    }))
    .filter((p) => Number.isFinite(p.wholesale_price) && p.wholesale_price > 0);
}

// Server-authoritative Off Price order. Any snapshot style not removed is
// orderable; the unit price is recomputed here (override else baked off_price),
// never trusted from the client. Same importer-draft shape as buildSeasonOrder.
export function buildOffOrder({ account, lines, notes, shipping, master, removes = [], overrides = {} }) {
  const removeSet = new Set(removes);
  const byHandle = new Map((master.products || []).filter((p) => !removeSet.has(p.handle)).map((p) => [p.handle, p]));
  const items = [];
  let units = 0, subtotal = 0;
  const skipped = [];
  for (const line of lines || []) {
    const p = byHandle.get(line?.handle);
    const price = p ? offPriceFor(p, overrides) : null;
    if (!p || !Number.isFinite(price)) { if (line?.handle) skipped.push(line.handle); continue; }
    const size_qty = {};
    let any = 0;
    for (const k of SIZE_CORE) { const q = Math.max(0, parseInt(line.size_qty?.[k], 10) || 0); size_qty[k] = q; any += q; }
    if (p.sizes.some((s) => s.size === "OS")) { const q = Math.max(0, parseInt(line.size_qty?.OS, 10) || 0); size_qty.OS = q; any += q; }
    if (!any) continue;
    items.push({ handle: p.handle, product_name: p.title, unit_price: price, size_qty, _sources: [`(season:off:${account.slug})`] });
    units += any;
    subtotal += any * price;
  }
  const dateStr = new Date().toISOString().slice(0, 10);
  const shipLabel = shipping === "when_ready" ? "Ship when ready" : "Ship all together";
  const userNotes = String(notes || "").trim();
  const order = {
    name: `In-Season Off — ${account.name} — ${dateStr}`,
    customer_id: account.customer_id ?? null,
    line_sheet_id: null,
    location_ids: LOCATIONS,
    shipping: shipping === "when_ready" ? "when_ready" : "all",
    notes: `[In-Season · Off Price] [${shipLabel}]${userNotes ? " " + userNotes : ""}`,
    source_filename: `wholesale-portal/season-off/${account.slug}-${dateStr}.json`,
    items
  };
  return { order, units, subtotal, skipped, dateStr };
}

// POST the draft to the importer's /api/orders-draft (HTTP Basic; the importer
// ignores the username and matches the password against WHOLESALE_PASSWORD).
export async function postDraftToImporter(order) {
  const base = process.env.IMPORTER_BASE_URL;
  const pass = process.env.IMPORTER_PASSWORD;
  if (!base || !pass) {
    return { ok: false, status: 0, error: "Order routing isn't configured (IMPORTER_BASE_URL / IMPORTER_PASSWORD)." };
  }
  const auth = Buffer.from(`portal:${pass}`).toString("base64");
  const url = `${base.replace(/\/+$/, "")}/api/orders-draft`;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
      body: JSON.stringify(order)
    });
  } catch (e) {
    return { ok: false, status: 0, error: `Could not reach importer: ${e.message}` };
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, status: res.status, error: `Importer ${res.status}: ${JSON.stringify(json).slice(0, 200)}` };
  return { ok: true, status: res.status, order: json.order || json };
}
