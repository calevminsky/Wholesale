// Live-check Shopify for current price, compare-at, and total inventory.
// The caller provides a `shopifyGraphQL(query, variables)` function from server.js.

const BATCH = 50;
const CONCURRENCY = 3;

export async function livecheckProducts(productIds, shopifyGraphQL, opts = {}) {
  const unique = Array.from(new Set(productIds.filter(Boolean)));
  if (unique.length === 0) return new Map();
  const includeCost = !!opts.includeCost;

  const batches = [];
  for (let i = 0; i < unique.length; i += BATCH) batches.push(unique.slice(i, i + BATCH));

  const out = new Map();
  const running = new Set();
  const queryStr = includeCost ? NODES_QUERY_WITH_COST : NODES_QUERY;

  async function runBatch(ids) {
    const data = await shopifyGraphQL(queryStr, { ids });
    for (const n of data?.nodes || []) {
      if (!n || !n.id) continue;
      const compareAt = extractMoney(
        n.compareAtPriceRange?.maxVariantCompareAtPrice ||
        n.compareAtPriceRange?.minVariantCompareAtPrice
      );
      const current = extractMoney(n.priceRangeV2?.minVariantPrice);
      let inv = 0;
      let costSum = 0;
      let costCount = 0;
      for (const v of (n.variants?.nodes || [])) {
        inv += Number(v.inventoryQuantity || 0);
        if (includeCost) {
          const c = Number(v.inventoryItem?.unitCost?.amount);
          if (Number.isFinite(c) && c > 0) { costSum += c; costCount += 1; }
        }
      }
      const unitCost = costCount ? costSum / costCount : 0;

      // Upsell metafield. Could be a list.product_reference (preferred — we
      // get titles via the references field), or a list of plain text names.
      // Either way we end up with an array of display names for the customer
      // to ctrl-F in the line sheet PDF.
      const upsellRefs = (n.upsellMetafield?.references?.nodes || [])
        .filter((r) => r && r.title)
        .map((r) => ({ title: r.title, handle: r.handle || "" }));
      let upsellList = upsellRefs;
      if (!upsellList.length && n.upsellMetafield?.value) {
        try {
          const parsed = JSON.parse(n.upsellMetafield.value);
          if (Array.isArray(parsed)) {
            upsellList = parsed
              .map((v) => (typeof v === "string" ? { title: v, handle: "" } : null))
              .filter(Boolean);
          }
        } catch {
          // Not JSON — treat as a single comma-separated string.
          upsellList = String(n.upsellMetafield.value)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
            .map((title) => ({ title, handle: "" }));
        }
      }

      out.set(n.id, {
        product_id: n.id,
        handle: n.handle || "",
        title: n.title,
        image: n.featuredImage?.url ? n.featuredImage.url.split("?")[0] : "",
        compare_at_price: compareAt,
        current_price: current,
        inventory_total: inv,
        unit_cost: unitCost,
        status: String(n.status || "").toUpperCase(),
        upsell_list: upsellList
      });
    }
  }

  for (const b of batches) {
    while (running.size >= CONCURRENCY) {
      await Promise.race(running);
    }
    const p = runBatch(b).catch((err) => {
      console.warn("livecheck batch failed:", err?.message || err);
    }).finally(() => running.delete(p));
    running.add(p);
  }
  await Promise.all(running);

  return out;
}

function extractMoney(m) {
  if (!m) return 0;
  const n = Number(m.amount ?? m);
  return Number.isFinite(n) ? n : 0;
}

const NODES_QUERY = `
  query LivecheckProducts($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        handle
        title
        status
        featuredImage { url }
        priceRangeV2 { minVariantPrice { amount currencyCode } }
        compareAtPriceRange {
          maxVariantCompareAtPrice { amount currencyCode }
          minVariantCompareAtPrice { amount currencyCode }
        }
        variants(first: 100) {
          nodes { id inventoryQuantity }
        }
        upsellMetafield: metafield(namespace: "theme", key: "upsell_list") {
          value
          type
          references(first: 25) {
            nodes {
              ... on Product { id title handle }
            }
          }
        }
      }
    }
  }
`;

// Same as NODES_QUERY but adds inventoryItem.unitCost on each variant. Only
// used by the internal-review layout — keeps the customer-facing payload as
// small as before, since costs aren't needed there and require read_inventory.
const NODES_QUERY_WITH_COST = `
  query LivecheckProductsWithCost($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        handle
        title
        status
        featuredImage { url }
        priceRangeV2 { minVariantPrice { amount currencyCode } }
        compareAtPriceRange {
          maxVariantCompareAtPrice { amount currencyCode }
          minVariantCompareAtPrice { amount currencyCode }
        }
        variants(first: 100) {
          nodes {
            id
            inventoryQuantity
            inventoryItem { unitCost { amount } }
          }
        }
        upsellMetafield: metafield(namespace: "theme", key: "upsell_list") {
          value
          type
          references(first: 25) {
            nodes {
              ... on Product { id title handle }
            }
          }
        }
      }
    }
  }
`;
