// Durable admin config for the Off Price offering, stored in the same
// wholesale_portal_settings Postgres table the rest of the admin uses.
//
//   key "offering:off" -> {
//     removes:   [handle...]      // styles taken OUT of the frozen snapshot
//     overrides: { "<gid>": dollars } // exact wholesale price, overriding the
//                                     // baked off_price for that style
//     order:     [handle...]      // admin's custom display order (the "featured"
//                                 // order buyers see); handles not listed fall
//                                 // to the end in snapshot (title) order
//   }
//
// The product universe is the committed snapshot data/off-offering.json (the
// F26 off-price selection, all in by default, each carrying a baked off_price).
// This config layer only lets the admin remove a style or re-price one — no DB
// write is required for the offering to work out of the box.
import { getAdminSetting, setAdminSetting } from "./admin-settings-store.mjs";

const KEY = "offering:off";

const dedupe = (arr) => [...new Set((Array.isArray(arr) ? arr : []).filter(Boolean).map(String))];

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
  return { removes: dedupe(c.removes), overrides: normOverrides(c.overrides), order: dedupe(c.order) };
}

// Partial update: a field left undefined keeps its current value.
export async function setOffConfig(patch = {}) {
  const cur = await getOffConfig();
  const next = {
    removes: patch.removes !== undefined ? dedupe(patch.removes) : cur.removes,
    overrides: patch.overrides !== undefined ? normOverrides(patch.overrides) : cur.overrides,
    order: patch.order !== undefined ? dedupe(patch.order) : cur.order
  };
  await setAdminSetting(KEY, next);
  return next;
}
