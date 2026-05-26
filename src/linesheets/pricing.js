// Resolve per-product effective pricing from a pricing JSONB block:
// {
//   default_mode: "pct_off_compare_at" | "pct_off_current" | "fixed" | "pct_of_higher",
//   default_value: number,
//   additional_discount_pct: number,   // applied on top of default/override
//   live_storefront_discount_pct: number, // % already baked into Shopify
//                                         // product.price (e.g. a sitewide
//                                         // sale). Grosses current_price back
//                                         // up before pct_off_current is
//                                         // applied — so "50% off current"
//                                         // gives 50% off the pre-sale price.
//   overrides: { "gid://shopify/Product/123": 42.00, ... }
// }

export function defaultPricing() {
  return { default_mode: "pct_off_compare_at", default_value: 50, additional_discount_pct: 0, live_storefront_discount_pct: 0, overrides: {} };
}

// Wholesale prices are always whole dollars (end in .00) — no .99 endings.
function roundWhole(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

export function computeSuggestedPrice(product, pricing) {
  const mode = pricing?.default_mode || "pct_off_compare_at";
  const val = Number(pricing?.default_value);
  if (!Number.isFinite(val)) return null;

  const compareAt = Number(product.compare_at_price || 0);
  const currentRaw = Number(product.current_price || 0);
  // Gross up current_price to "undo" a live storefront sale that's baked
  // into product.price. Only meaningful for pct_off_current — the other
  // modes don't use current_price directly.
  const liveDisc = Number(pricing?.live_storefront_discount_pct) || 0;
  const grossUpFactor = liveDisc > 0 && liveDisc < 100 ? 1 / (1 - liveDisc / 100) : 1;
  const current = currentRaw * grossUpFactor;

  switch (mode) {
    case "pct_off_compare_at": {
      const base = compareAt > 0 ? compareAt : current;
      return roundWhole(base * (1 - val / 100));
    }
    case "pct_off_current": {
      const base = current > 0 ? current : compareAt;
      return roundWhole(base * (1 - val / 100));
    }
    case "fixed":
      return roundWhole(val);
    case "pct_of_higher": {
      // Price = higher of (val% of compare_at) vs cost — never drops below cost
      const cost = Number(product.unit_cost || 0);
      const msrpBase = compareAt > 0 ? compareAt : current;
      const pctOfMsrp = msrpBase * (val / 100);
      const base = Math.max(pctOfMsrp, cost);
      if (base <= 0) return null;
      return Math.round(base);
    }
    default:
      return null;
  }
}

export function applyPricing(products, pricing) {
  const overrides = pricing?.overrides || {};
  const addPct = Number(pricing?.additional_discount_pct) || 0;
  const hasAdditional = addPct > 0;
  return products.map((p) => {
    const suggested = computeSuggestedPrice(p, pricing);
    const override = overrides[p.product_id];
    const hasOverride = override !== undefined && override !== null && override !== "";
    const baseWholesale = hasOverride ? roundWhole(Number(override)) : suggested;
    const finalPrice = hasAdditional && Number.isFinite(baseWholesale)
      ? roundWhole(baseWholesale * (1 - addPct / 100))
      : baseWholesale;
    return {
      ...p,
      suggested_price: suggested,
      base_wholesale_price: baseWholesale,
      effective_price: finalPrice,
      has_override: hasOverride,
      additional_discount_applied: hasAdditional
    };
  });
}
