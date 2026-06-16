// Durable config for the in-season "offerings" portal, stored in the same
// wholesale_portal_settings Postgres table the rest of the admin uses.
//
//   key "offering:full"   -> { adds: [handle...], removes: [handle...] }
//        adds    = surface a product the discovery rule missed (baked in at build)
//        removes = hide a discovered product (applied at request time, instant)
//
//   key "accounts-pricing" -> { "<customer_id>": { full_level: 50|40, full_enabled: bool } }
//        full_level   = % of MSRP this account pays on the Full Price tab (default 50)
//        full_enabled = whether the account sees the Full Price tab (default true)
import { getAdminSetting, setAdminSetting } from "./admin-settings-store.mjs";

const FULL_KEY = "offering:full";
const PRICING_KEY = "accounts-pricing";

export const DEFAULT_FULL_LEVEL = 50;
export const VALID_FULL_LEVELS = [50, 40];

const dedupe = (arr) => [...new Set((Array.isArray(arr) ? arr : []).filter(Boolean).map(String))];

export async function getFullOfferingConfig() {
  const cfg = (await getAdminSetting(FULL_KEY)) || {};
  return { adds: dedupe(cfg.adds), removes: dedupe(cfg.removes) };
}

export async function setFullOfferingConfig({ adds, removes } = {}) {
  const clean = { adds: dedupe(adds), removes: dedupe(removes) };
  await setAdminSetting(FULL_KEY, clean);
  return clean;
}

export async function getAccountsPricing() {
  return (await getAdminSetting(PRICING_KEY)) || {};
}

// Normalize the whole map before saving — only valid levels, boolean flags.
export async function setAccountsPricing(map) {
  const clean = {};
  for (const [cid, v] of Object.entries(map || {})) {
    const lvl = Number(v?.full_level);
    clean[String(cid)] = {
      full_level: VALID_FULL_LEVELS.includes(lvl) ? lvl : DEFAULT_FULL_LEVEL,
      full_enabled: v?.full_enabled !== false
    };
  }
  await setAdminSetting(PRICING_KEY, clean);
  return clean;
}

// Resolve the effective pricing/entitlement for one account. Unknown accounts
// fall back to the default (50% of MSRP, Full tab enabled) so the portal works
// out of the box before anyone is explicitly configured.
export function resolveAccountPricing(map, customerId) {
  const rec = customerId != null ? map?.[String(customerId)] : null;
  const lvl = Number(rec?.full_level);
  return {
    full_level: VALID_FULL_LEVELS.includes(lvl) ? lvl : DEFAULT_FULL_LEVEL,
    full_enabled: rec ? rec.full_enabled !== false : true
  };
}
