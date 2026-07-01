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

// Two off-price offerings share this store, keyed by id:
//   "off"    → the curated in-season F26 selection (data/off-offering.json)
//   "offall" → in-season off + all online marked-down styles (data/off-offering-all.json)
const KEYS = { off: "offering:off", offall: "offering:offall" };
const keyFor = (oid) => KEYS[oid] || KEYS.off;

const dedupe = (arr) => [...new Set((Array.isArray(arr) ? arr : []).filter(Boolean).map(String))];

function normOverrides(o) {
  const out = {};
  for (const [k, v] of Object.entries(o || {})) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) out[k] = Math.round(n);
  }
  return out;
}

export async function getOffConfig(oid = "off") {
  const c = (await getAdminSetting(keyFor(oid))) || {};
  return { removes: dedupe(c.removes), overrides: normOverrides(c.overrides), order: dedupe(c.order) };
}

// Partial update: a field left undefined keeps its current value.
export async function setOffConfig(patch = {}, oid = "off") {
  const cur = await getOffConfig(oid);
  const next = {
    removes: patch.removes !== undefined ? dedupe(patch.removes) : cur.removes,
    overrides: patch.overrides !== undefined ? normOverrides(patch.overrides) : cur.overrides,
    order: patch.order !== undefined ? dedupe(patch.order) : cur.order
  };
  await setAdminSetting(keyFor(oid), next);
  return next;
}
