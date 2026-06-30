// Durable config for the in-season "Off Price" offering, stored in the same
// wholesale_portal_settings Postgres table the rest of the admin uses.
//
//   key "offering:off" -> {
//     picks:   [handle...]   // the products Calev hand-picked into Off Price
//     pricing: {
//       default:   { mode, value }      // the ONE global off-price rule
//       overrides: { "<gid>": dollars } // optional per-product exact price
//     }
//   }
//
// Unlike Full Price (per-account % of MSRP), Off Price is a single rule that
// applies to every account. Products are opt-IN: a style only appears once it's
// in `picks`. The universe to pick from is the same in-season master that Full
// Price discovers (data/full-offering.json), so no second catalog build runs.
import { getAdminSetting, setAdminSetting } from "./admin-settings-store.mjs";
import { OFF_MODES } from "./off-pricing.mjs";

const KEY = "offering:off";

const dedupe = (arr) => [...new Set((Array.isArray(arr) ? arr : []).filter(Boolean).map(String))];

function normRule(r) {
  const mode = OFF_MODES.some((m) => m.id === r?.mode) ? r.mode : "ride_current";
  const value = Number(r?.value) || 0;
  return { mode, value };
}

function normOverrides(o) {
  const out = {};
  for (const [k, v] of Object.entries(o || {})) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) out[k] = Math.round(n);
  }
  return out;
}

export async function getOffConfig() {
  const c = (await getAdminSetting(KEY)) || {};
  return {
    picks: dedupe(c.picks),
    pricing: { default: normRule(c.pricing?.default), overrides: normOverrides(c.pricing?.overrides) }
  };
}

// Partial update: any field left undefined keeps its current value. `overrides`
// is a top-level convenience that lands under pricing.overrides (the shape the
// pricing engine reads via off-pricing.mjs offToPricing).
export async function setOffConfig(patch = {}) {
  const cur = await getOffConfig();
  const next = {
    picks: patch.picks !== undefined ? dedupe(patch.picks) : cur.picks,
    pricing: {
      default: patch.pricing?.default !== undefined ? normRule(patch.pricing.default) : cur.pricing.default,
      overrides: patch.overrides !== undefined ? normOverrides(patch.overrides) : cur.pricing.overrides
    }
  };
  await setAdminSetting(KEY, next);
  return next;
}

export { OFF_MODES };
