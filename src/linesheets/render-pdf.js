// Orchestrate live-check + PDF render for a saved line sheet.
import { runFilter, loadProductsByIds } from "./query.js";
import { applyPricing, defaultPricing } from "./pricing.js";
import { livecheckProducts } from "./shopify-livecheck.js";
import { buildLineSheetHtml } from "./template.js";

// Merge pinned rows into matched rows without duplicates; apply excludes.
function composeProducts(matched, pinned, excludes) {
  const excludeSet = new Set(excludes || []);
  const byId = new Map();
  for (const p of matched) byId.set(p.product_id, { ...p, source: "matched" });
  for (const p of pinned) {
    if (byId.has(p.product_id)) continue;
    byId.set(p.product_id, { ...p, source: "pinned" });
  }
  const out = [];
  for (const p of byId.values()) {
    p.excluded = excludeSet.has(p.product_id);
    if (!p.excluded) out.push(p);
  }
  return out;
}

function groupBy(products, key) {
  const map = new Map();
  for (const p of products) {
    const k = p[key] || "(none)";
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(p);
  }
  return Array.from(map.entries()).map(([label, arr]) => ({ label, products: arr }));
}

function sortProducts(products, sortKey) {
  const ageOf = (p) => {
    const m = String(p.product_id || "").match(/(\d+)$/);
    return m ? Number(m[1]) : 0;
  };
  const cmp = (a, b) => {
    switch (sortKey) {
      case "newest":         return ageOf(b) - ageOf(a);
      case "price_asc":      return (a.effective_price || 0) - (b.effective_price || 0);
      case "price_desc":     return (b.effective_price || 0) - (a.effective_price || 0);
      case "style_desc":     return String(b.style_name || b.title || "").localeCompare(String(a.style_name || a.title || ""));
      case "inventory_desc": return (b.inventory_total || 0) - (a.inventory_total || 0);
      case "inventory_asc":  return (a.inventory_total || 0) - (b.inventory_total || 0);
      case "title":          return String(a.title || "").localeCompare(String(b.title || ""));
      case "style_asc":
      case "style_name":
      default:
        return String(a.style_name || a.title || "").localeCompare(String(b.style_name || b.title || ""));
    }
  };
  return [...products].sort(cmp);
}

export async function buildRenderedPayload(sheet, { shopifyGraphQL, liveCheck = true } = {}) {
  const filterTree = sheet.filter_tree || { include: [], globals: [] };
  const pricing = { ...defaultPricing(), ...(sheet.pricing || {}) };
  const opts = sheet.display_opts || {};

  let matched = await runFilter(filterTree);
  let pinned = [];
  if ((sheet.pins || []).length) pinned = await loadProductsByIds(sheet.pins);

  let products = composeProducts(matched, pinned, sheet.excludes || []);

  // Live-check Shopify for current price / inventory
  if (liveCheck && shopifyGraphQL) {
    try {
      const ids = products.map((p) => p.product_id);
      const liveMap = await livecheckProducts(ids, shopifyGraphQL);
      const staleBehavior = opts.stale_behavior || "drop";
      const filtered = [];
      for (const p of products) {
        const live = liveMap.get(p.product_id);
        if (!live) {
          if (staleBehavior === "drop") continue;
          if (staleBehavior === "flag") p.stale = true;
          filtered.push(p);
          continue;
        }
        if (live.status && live.status !== "ACTIVE") {
          if (staleBehavior === "drop") continue;
          if (staleBehavior === "flag") p.stale = true;
        }
        p.compare_at_price = live.compare_at_price || p.compare_at_price;
        p.current_price = live.current_price || p.current_price;
        if (live.handle) p.handle = live.handle;
        if (live.inventory_total !== undefined) {
          p.inventory_total_live = live.inventory_total;
        }
        if (Array.isArray(live.upsell_list)) p.upsell_list = live.upsell_list;
        filtered.push(p);
      }
      products = filtered;
    } catch (err) {
      console.warn("Shopify live-check failed:", err?.message || err);
    }
  }

  // Inventory minimum filter (render-time)
  const minInv = Number(opts.min_live_inventory ?? 1);
  if (minInv > 0) {
    products = products.filter((p) => Number(p.inventory_total || 0) >= minInv);
  }

  // Apply pricing (after live-check updates compare_at/current).
  products = applyPricing(products, pricing);

  // Sort
  products = sortProducts(products, opts.sort || "style_name");

  // Grouping
  const groupKey = opts.group_by;
  const validGroupKeys = new Set(["season", "product_type", "class"]);
  const groups = validGroupKeys.has(groupKey) ? groupBy(products, groupKey) : null;

  return { products, groups, sheet, pricing };
}

export function renderHtml(payload) {
  return buildLineSheetHtml(payload);
}
