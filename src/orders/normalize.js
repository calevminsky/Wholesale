// Normalize wholesale_orders.items JSONB into wholesale_order_lines rows
// resolved to pd variants. This is the single choke point every item write
// flows through (create / update / resolve-mismatches / duplicate / uploads).
//
// Resolution: handle -> pd.colorway, then (colorway, size) -> pd.variant.
//   1. Exact match on pd.colorway.shopify_handle.
//   2. Fallback: slugified "Style (Color)" name — the exact shape the portal's
//      preorder catalog builds handles from (see
//      wholesale-portal/build/airtable-preorder.mjs), so pure preorder handles
//      resolve even before the product exists in Shopify.
// Unresolved lines are kept (variant_id NULL + resolution flag), never dropped.
import { getPool } from "../pg.js";

// Same slugify as wholesale-portal/build/airtable-preorder.mjs — keep in sync.
export function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/["'’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// slug -> colorway id map built from pd ("Style (Color)" names). Cached
// briefly; pd's catalog changes rarely relative to order traffic.
let slugCache = null;
let slugCacheAt = 0;
const SLUG_CACHE_MS = 5 * 60 * 1000;

async function getSlugMap(client) {
  const now = Date.now();
  if (slugCache && now - slugCacheAt < SLUG_CACHE_MS) return slugCache;
  const { rows } = await client.query(
    `SELECT c.id, c.shopify_handle, s.name AS style_name, c.color
       FROM pd.colorway c
       JOIN pd.style s ON s.id = c.style_id`
  );
  const map = new Map();
  const put = (slug, id) => { if (slug && !map.has(slug)) map.set(slug, id); };
  for (const r of rows) {
    if (r.shopify_handle) map.set(String(r.shopify_handle).trim(), r.id);
    const name = r.color ? `${String(r.style_name).trim()} (${String(r.color).trim()})` : String(r.style_name).trim();
    put(slugify(name), r.id);
  }
  // Historical names from pd's audit log: products get renamed after orders
  // are placed (e.g. "Hallie Dress Long Sleeve" -> "Rosana Dress"), leaving
  // order handles pointing at names that no longer exist. Map slugs of every
  // OLD style name / colorway color to the same colorway. Current names were
  // added first, so they always win a collision (name reuse).
  const { rows: renames } = await client.query(`
    SELECT c.id, al.old_row->>'name' AS old_style_name, c.color
      FROM pd.audit_log al
      JOIN pd.colorway c ON c.style_id = al.row_id
     WHERE al.table_name = 'style' AND al.old_row->>'name' IS NOT NULL
    UNION
    SELECT c.id, s.name, al.old_row->>'color'
      FROM pd.audit_log al
      JOIN pd.colorway c ON c.id = al.row_id
      JOIN pd.style s ON s.id = c.style_id
     WHERE al.table_name = 'colorway' AND al.old_row->>'color' IS NOT NULL`);
  for (const r of renames) {
    const styleName = String(r.old_style_name || "").trim();
    if (!styleName) continue;
    const name = r.color ? `${styleName} (${String(r.color).trim()})` : styleName;
    put(slugify(name), r.id);
  }
  slugCache = map;
  slugCacheAt = now;
  return map;
}

// slug -> { size -> shopify variant_id } from the synced Shopify catalog
// (public.inventory_items). Shopify handles are slugified product titles, so
// slugify(product_title) recovers the handle. This is the fallback for
// in-stock portal items that never existed in pd — they behave like regular
// stock that just needs the Warehouse -> Wholesale move.
let shopifyCache = null;
let shopifyCacheAt = 0;

async function getShopifyMap(client) {
  const now = Date.now();
  if (shopifyCache && now - shopifyCacheAt < SLUG_CACHE_MS) return shopifyCache;
  // Two Shopify products can share a title (a relisted style gets a "-N"
  // handle suffix). First row wins per (slug, size), so order newest product
  // first — Shopify ids are monotonic, and the relisted product is the one
  // actually being sold.
  const { rows } = await client.query(
    `SELECT product_title, variant_title, variant_id FROM public.inventory_items
      ORDER BY NULLIF(regexp_replace(variant_id, '\\D', '', 'g'), '')::numeric DESC NULLS LAST`
  );
  const map = new Map();
  for (const r of rows) {
    const slug = slugify(r.product_title);
    if (!slug) continue;
    let sizes = map.get(slug);
    if (!sizes) { sizes = new Map(); map.set(slug, sizes); }
    const size = String(r.variant_title || "").trim().toUpperCase();
    if (size && !sizes.has(size)) sizes.set(size, r.variant_id);
  }
  shopifyCache = map;
  shopifyCacheAt = now;
  return map;
}

export function invalidateSlugCache() {
  slugCache = null;
  shopifyCache = null;
}

// Explode an order's items JSONB into (handle, size, qty, unit_price) rows.
// Items look like {handle, product_name, unit_price, size_qty:{XXS..XXL[,OS]}}.
function explodeItems(items) {
  const out = new Map(); // "handle|size" -> row (last write wins on dupes)
  for (const it of Array.isArray(items) ? items : []) {
    const handle = String(it.handle || "").trim();
    if (!handle) continue;
    const sizeQty = it.size_qty && typeof it.size_qty === "object" ? it.size_qty : {};
    for (const [size, rawQty] of Object.entries(sizeQty)) {
      const qty = Math.max(0, Math.round(Number(rawQty) || 0));
      if (qty <= 0) continue;
      const key = `${handle}|${size}`;
      const prev = out.get(key);
      out.set(key, {
        handle,
        size,
        qty: (prev ? prev.qty : 0) + qty,
        unit_price: Number(it.unit_price) || null
      });
    }
  }
  return [...out.values()];
}

// Sync wholesale_order_lines for one order from its items JSONB, releasing
// reservations that an edit orphaned. Returns {resolved, unresolved:[...]}.
export async function syncOrderLines(orderId) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: ord } = await client.query(
      `SELECT items FROM wholesale_orders WHERE id = $1 FOR UPDATE`,
      [orderId]
    );
    if (ord.length === 0) {
      await client.query("ROLLBACK");
      return null;
    }

    const lines = explodeItems(ord[0].items);
    const slugMap = await getSlugMap(client);
    const shopifyMap = await getShopifyMap(client);

    let resolved = 0;
    const unresolved = [];
    for (const line of lines) {
      // Candidate handles: as-is, re-slugified, and with a trailing "-N"
      // stripped (Shopify appends -1/-2… when a handle is reused, but the
      // product title — and therefore pd — has no suffix).
      const candidates = [...new Set([line.handle, slugify(line.handle), line.handle.replace(/-\d+$/, "")])];
      // 1. pd colorway (preorders + everything pd knows about) …
      const colorwayId = candidates.map((h) => slugMap.get(h)).find((v) => v != null) ?? null;
      let variantId = null;
      let shopifyVariantId = null;
      let resolution = "unresolved_handle";
      if (colorwayId != null) {
        const { rows: v } = await client.query(
          `SELECT id, shopify_variant_id FROM pd.variant WHERE colorway_id = $1 AND size = $2`,
          [colorwayId, line.size]
        );
        if (v.length) {
          variantId = v[0].id;
          shopifyVariantId = v[0].shopify_variant_id != null ? String(v[0].shopify_variant_id) : null;
          resolution = "resolved";
        } else {
          resolution = "unresolved_size";
        }
      }
      // 2. … else the Shopify catalog directly (in-stock styles not in pd).
      if (resolution !== "resolved") {
        const sizes = candidates.map((h) => shopifyMap.get(h)).find((v) => v != null);
        const sv = sizes?.get(String(line.size).trim().toUpperCase());
        if (sv) {
          shopifyVariantId = String(sv);
          resolution = "resolved_shopify";
        }
      }
      if (resolution === "resolved" || resolution === "resolved_shopify") resolved++;
      else unresolved.push({ handle: line.handle, size: line.size, qty: line.qty, reason: resolution });

      await client.query(
        `INSERT INTO wholesale_order_lines
           (order_id, handle, size, qty, unit_price, colorway_id, variant_id, shopify_variant_id, resolution)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (order_id, handle, size) DO UPDATE
           SET qty = EXCLUDED.qty,
               unit_price = EXCLUDED.unit_price,
               colorway_id = EXCLUDED.colorway_id,
               variant_id = EXCLUDED.variant_id,
               shopify_variant_id = EXCLUDED.shopify_variant_id,
               resolution = EXCLUDED.resolution,
               updated_at = NOW()`,
        [orderId, line.handle, line.size, line.qty, line.unit_price, colorwayId, variantId, shopifyVariantId, resolution]
      );
    }

    // Lines no longer present in items: qty -> 0 (kept for reservation history).
    if (lines.length) {
      await client.query(
        `UPDATE wholesale_order_lines
            SET qty = 0, updated_at = NOW()
          WHERE order_id = $1 AND qty <> 0
            AND (handle, size) NOT IN (${lines.map((_, i) => `($${i * 2 + 2}, $${i * 2 + 3})`).join(",")})`,
        [orderId, ...lines.flatMap((l) => [l.handle, l.size])]
      );
    } else {
      await client.query(
        `UPDATE wholesale_order_lines SET qty = 0, updated_at = NOW()
          WHERE order_id = $1 AND qty <> 0`,
        [orderId]
      );
    }

    // Release over-reservations an edit created: newest first, preferring rows
    // not yet transferred (a released-but-transferred row = units sitting at
    // Wholesale with no owner -> "return to Warehouse" on the dashboard).
    const { rows: over } = await client.query(
      `SELECT l.id AS line_id, l.qty,
              COALESCE(SUM(r.qty) FILTER (WHERE r.released_at IS NULL), 0)::int AS reserved
         FROM wholesale_order_lines l
         LEFT JOIN wholesale_reservations r ON r.order_line_id = l.id
        WHERE l.order_id = $1
        GROUP BY l.id, l.qty
       HAVING COALESCE(SUM(r.qty) FILTER (WHERE r.released_at IS NULL), 0) > l.qty`,
      [orderId]
    );
    for (const o of over) {
      let excess = o.reserved - o.qty;
      const { rows: resv } = await client.query(
        `SELECT id, qty FROM wholesale_reservations
          WHERE order_line_id = $1 AND released_at IS NULL
          ORDER BY (transferred_at IS NULL) DESC, created_at DESC`,
        [o.line_id]
      );
      for (const r of resv) {
        if (excess <= 0) break;
        if (r.qty <= excess) {
          await client.query(
            `UPDATE wholesale_reservations SET released_at = NOW() WHERE id = $1`,
            [r.id]
          );
          excess -= r.qty;
        } else {
          // Split: shrink the live row, record the released remainder.
          await client.query(
            `UPDATE wholesale_reservations SET qty = qty - $2 WHERE id = $1`,
            [r.id, excess]
          );
          await client.query(
            `INSERT INTO wholesale_reservations
               (order_line_id, variant_id, shopify_variant_id, qty, source, po_id, created_at, from_location, transferred_at, released_at)
             SELECT order_line_id, variant_id, shopify_variant_id, $2, source, po_id, created_at, from_location, transferred_at, NOW()
               FROM wholesale_reservations WHERE id = $1`,
            [r.id, excess]
          );
          excess = 0;
        }
      }
    }

    await client.query("COMMIT");
    return { resolved, unresolved };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
