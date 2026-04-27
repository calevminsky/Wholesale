// Live-check Shopify for current price, compare-at, and total inventory.
// The caller provides a `shopifyGraphQL(query, variables)` function from server.js.

const BATCH = 50;
const CONCURRENCY = 3;

export async function livecheckProducts(productIds, shopifyGraphQL) {
  const unique = Array.from(new Set(productIds.filter(Boolean)));
  if (unique.length === 0) return new Map();

  const batches = [];
  for (let i = 0; i < unique.length; i += BATCH) batches.push(unique.slice(i, i + BATCH));

  const out = new Map();
  const running = new Set();

  async function runBatch(ids) {
    const data = await shopifyGraphQL(NODES_QUERY, { ids });
    for (const n of data?.nodes || []) {
      if (!n || !n.id) continue;
      const compareAt = extractMoney(
        n.compareAtPriceRange?.maxVariantCompareAtPrice ||
        n.compareAtPriceRange?.minVariantCompareAtPrice
      );
      const current = extractMoney(n.priceRangeV2?.minVariantPrice);
      let inv = 0;
      for (const v of (n.variants?.nodes || [])) inv += Number(v.inventoryQuantity || 0);
      out.set(n.id, {
        product_id: n.id,
        handle: n.handle || "",
        title: n.title,
        image: n.featuredImage?.url ? n.featuredImage.url.split("?")[0] : "",
        compare_at_price: compareAt,
        current_price: current,
        inventory_total: inv,
        status: String(n.status || "").toUpperCase()
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
      }
    }
  }
`;
