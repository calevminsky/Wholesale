// Shared off-price rules model. The admin backend (server.mjs) reads/writes
// off-pricing.json; the catalog build (build-catalog.mjs) consumes it for the
// Off tier. Full price stays governed by tiers.config.json (50% of MSRP).
//
// off-pricing.json shape:
// {
//   "default": { "mode": "ride_current"|"pct_off_msrp"|"pct_off_current"|"fixed", "value": <number> },
//   "overrides": { "gid://shopify/Product/123": <wholesale_price_dollars>, ... }
// }
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const OFF_PRICING_PATH = path.resolve(__dirname, "off-pricing.json");

export const OFF_MODES = [
  { id: "ride_current", label: "Ride the current (marked-down) price" },
  { id: "pct_off_msrp", label: "% off MSRP (compare-at)" },
  { id: "pct_off_current", label: "% off the current price" },
  { id: "fixed", label: "Flat price for every off style" }
];

export function loadOffPricing() {
  if (fs.existsSync(OFF_PRICING_PATH)) {
    try { return normalize(JSON.parse(fs.readFileSync(OFF_PRICING_PATH, "utf8"))); } catch {}
  }
  return { default: { mode: "ride_current", value: 0 }, overrides: {} };
}

export function saveOffPricing(cfg) {
  fs.writeFileSync(OFF_PRICING_PATH, JSON.stringify(normalize(cfg), null, 2));
}

function normalize(cfg) {
  const mode = OFF_MODES.some((m) => m.id === cfg?.default?.mode) ? cfg.default.mode : "ride_current";
  const value = Number(cfg?.default?.value) || 0;
  const overrides = {};
  for (const [k, v] of Object.entries(cfg?.overrides || {})) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) overrides[k] = Math.round(n);
  }
  return { default: { mode, value }, overrides };
}

// Map the admin-friendly off rule onto the line-sheet pricing engine shape
// (src/linesheets/pricing.js) so off prices use the exact same math as the
// internal builder.
export function offToPricing(cfg) {
  const c = normalize(cfg);
  const map = {
    ride_current: { default_mode: "pct_off_current", default_value: 0 },
    pct_off_msrp: { default_mode: "pct_off_compare_at", default_value: c.default.value },
    pct_off_current: { default_mode: "pct_off_current", default_value: c.default.value },
    fixed: { default_mode: "fixed", default_value: c.default.value }
  };
  return { ...(map[c.default.mode] || map.ride_current), additional_discount_pct: 0, live_storefront_discount_pct: 0, overrides: c.overrides };
}
