// Resolve per-product effective pricing from a pricing JSONB block:
// {
//   default_mode: "pct_off_compare_at" | "pct_off_current" | "fixed",
//   default_value: number,
//   additional_discount_pct: number,   // applied on top of default/override
//   overrides: { "gid://shopify/Product/123": 42.00, ... }
// }

export function defaultPricing() {
  return { default_mode: "pct_off_compare_at", default_value: 50, additional_discount_pct: 0, overrides: {} };
}

function round2(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

export function computeSuggestedPrice(product, pricing) {
  const mode = pricing?.default_mode || "pct_off_compare_at";
  const val = Number(pricing?.default_value);
  if (!Number.isFinite(val)) return null;

  const compareAt = Number(product.compare_at_price || 0);
  const current   = Number(product.current_price || 0);

  switch (mode) {
    case "pct_off_compare_at": {
      const base = compareAt > 0 ? compareAt : current;
      return round2(base * (1 - val / 100));
    }
    case "pct_off_current": {
      const base = current > 0 ? current : compareAt;
      return round2(base * (1 - val / 100));
    }
    case "fixed":
      return round2(val);
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
    const baseWholesale = hasOverride ? round2(Number(override)) : suggested;
    const finalPrice = hasAdditional && Number.isFinite(baseWholesale)
      ? round2(baseWholesale * (1 - addPct / 100))
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
