// Wave submit: turn the currently-fulfillable slice of the portal preorder
// drafts into real Shopify orders, without touching draft status.
//
// Wave quantity per order line = active reservations (any source — transferred
// units sit at Wholesale already, pending on-hand holds follow via the pull
// sheet) + a FIFO take of delivered-but-not-counted PO units against open
// demand (same oldest-order-first rule closeout's receipt reservations use, so
// what we commit per account today is what the ledger hands them at count-in),
// minus anything a previous wave already submitted.
//
// The Shopify order is committed entirely at the Wholesale Holding Location.
// For the delivered-not-counted units that location goes AVAILABLE-NEGATIVE on
// purpose: yb-pd's receiving scan-close pushes those units to Wholesale and
// the balance walks back to zero as the team counts them in.
import { getPool } from "../pg.js";

const tail = (id) => String(id ?? "").replace(/^.*\//, "");
const variantGid = (id) => `gid://shopify/ProductVariant/${tail(id)}`;

// ---------- plan (read-only) ----------

export async function computeWavePlan() {
  const pool = getPool();

  // Portal draft lines still in play, with their active-reservation totals.
  // Same population rule as the open-demand views.
  const { rows: lines } = await pool.query(`
    SELECT l.order_id, o.name AS order_name, o.customer_id,
           l.id AS order_line_id, l.handle, l.size, l.qty, l.unit_price,
           COALESCE(l.shopify_variant_id, pv.shopify_variant_id::text) AS svid,
           COALESCE(res.qty, 0) AS reserved
      FROM wholesale_order_lines l
      JOIN wholesale_orders o ON o.id = l.order_id
      LEFT JOIN pd.variant pv ON pv.id = l.variant_id
      LEFT JOIN LATERAL (
            SELECT SUM(r.qty)::int AS qty FROM wholesale_reservations r
             WHERE r.order_line_id = l.id AND r.released_at IS NULL) res ON TRUE
     WHERE o.origin = 'portal' AND o.archived_at IS NULL
       AND o.status NOT IN ('submitted','cancelled')
       AND l.qty > 0
       AND COALESCE(l.shopify_variant_id, pv.shopify_variant_id::text) IS NOT NULL
     ORDER BY o.created_at, l.order_id, l.id`);

  // Delivered-but-not-counted supply per variant. Receipt reservations only
  // exist once a PO closes, so 'delivered' units are never double-counted.
  const { rows: deliveredRows } = await pool.query(`
    SELECT v.shopify_variant_id::text AS svid, SUM(pl.qty_shipped)::int AS qty
      FROM pd.po_line pl
      JOIN pd.purchase_order po ON po.id = pl.po_id
      JOIN pd.variant v ON v.id = pl.variant_id
     WHERE po.status = 'delivered' AND v.shopify_variant_id IS NOT NULL
       AND pl.qty_shipped > 0
     GROUP BY 1`);
  const deliveredByVariant = new Map(deliveredRows.map((r) => [tail(r.svid), r.qty]));

  // What earlier waves already submitted, per order line.
  const { rows: waved } = await pool.query(`
    SELECT (li->>'order_line_id')::bigint AS order_line_id,
           SUM((li->>'qty')::int)::int AS qty
      FROM wholesale_wave_orders w, jsonb_array_elements(w.lines) li
     GROUP BY 1`);
  const wavedByLine = new Map(waved.map((r) => [Number(r.order_line_id), r.qty]));

  // FIFO walk (lines are already ordered oldest-order-first): reservations are
  // owned outright; open demand (qty - reserved) draws from delivered supply.
  const orders = new Map();
  for (const l of lines) {
    const svid = tail(l.svid);
    const open = Math.max(0, l.qty - l.reserved);
    const pool_ = deliveredByVariant.get(svid) || 0;
    const deliveredTake = Math.min(open, pool_);
    if (deliveredTake > 0) deliveredByVariant.set(svid, pool_ - deliveredTake);

    const already = wavedByLine.get(Number(l.order_line_id)) || 0;
    const qty = Math.max(0, Math.min(l.qty, l.reserved + deliveredTake) - already);
    if (qty <= 0) continue;

    let o = orders.get(l.order_id);
    if (!o) {
      o = { order_id: l.order_id, order_name: l.order_name, customer_id: l.customer_id,
            lines: [], units: 0, amount: 0 };
      orders.set(l.order_id, o);
    }
    o.lines.push({
      order_line_id: Number(l.order_line_id),
      handle: l.handle, size: l.size, qty,
      unit_price: l.unit_price == null ? null : Number(l.unit_price),
      shopify_variant_id: variantGid(svid),
      reserved: Math.min(l.reserved, qty),
      delivered: Math.max(0, qty - l.reserved)
    });
    o.units += qty;
    o.amount += qty * (Number(l.unit_price) || 0);
  }
  return [...orders.values()];
}

// ---------- submit ----------

// Creates one Shopify order per planned portal draft via the exact same
// pipeline in-season orders use (submitAllocationToShopify), with two wave
// opt-ins: fulfillment pinned to the Wholesale location past its available
// cap, and wave tags. Records each result in wholesale_wave_orders.
export async function submitWave({
  plan,
  submitAllocationToShopify,
  getAllLocations,
  getCustomerShopifyId, // async (customer_id) -> gid | null
  orderIds = null       // restrict to these wholesale_orders ids
}) {
  const pool = getPool();
  const locs = await getAllLocations();
  const whl = (locs || []).find((l) => String(l.name || "").toLowerCase().includes("wholesale"));
  if (!whl) throw new Error("Wholesale location not found in Shopify locations.");
  const whlId = String(whl.id);

  // inventoryItemId per variant (needed by the rebalancer's allocation plan).
  const svids = [...new Set(plan.flatMap((o) => o.lines.map((l) => tail(l.shopify_variant_id))))];
  const { rows: items } = await pool.query(
    `SELECT regexp_replace(variant_id, '^.*/', '') AS svid, inventory_item_id
       FROM public.inventory_items
      WHERE regexp_replace(variant_id, '^.*/', '') = ANY($1::text[])`, [svids]);
  const invItemByVariant = new Map(items.map((r) => [r.svid, r.inventory_item_id]));

  const results = [];
  for (const o of plan) {
    if (orderIds && !orderIds.includes(o.order_id)) continue;
    if (!o.lines.length) continue;

    const missing = o.lines.filter((l) => !invItemByVariant.get(tail(l.shopify_variant_id)));
    if (missing.length) {
      throw new Error(`Order ${o.order_id} (${o.order_name}): no inventory item for ` +
        missing.map((l) => `${l.handle}/${l.size}`).join(", "));
    }

    const draftLineItems = [];
    const allocationPlan = new Map();
    for (const l of o.lines) {
      const vid = l.shopify_variant_id;
      const priceStr = String(l.unit_price ?? 0);
      const existing = draftLineItems.find((li) => li.variantId === vid && li.unitPrice === priceStr);
      if (existing) existing.quantity += l.qty;
      else draftLineItems.push({ variantId: vid, quantity: l.qty, unitPrice: priceStr });

      const prev = allocationPlan.get(vid);
      if (prev) prev.allocations[0].qty += l.qty;
      else allocationPlan.set(vid, {
        inventoryItemId: invItemByVariant.get(tail(vid)),
        allocations: [{ locationId: whlId, qty: l.qty }]
      });
    }

    const customerId = o.customer_id && getCustomerShopifyId
      ? await getCustomerShopifyId(o.customer_id) : null;

    const { orderResults, attachments } = await submitAllocationToShopify({
      allocationPlan,
      draftLineItems,
      locationIdsInOrder: [whlId],
      locationIdToName: { [whlId]: whl.name },
      customer: o.order_name,
      notes: `Wave 1 of portal preorder draft #${o.order_id}`,
      uploadFileName: `wave-${o.order_id}.xlsx`,
      report: { requestedSeen: [] },
      reserveHours: 0,
      customerId,
      ignoreDestinationCap: true,
      extraTags: ["Preorder-Wave", `portal-draft-${o.order_id}`]
    });

    const first = orderResults[0];
    await pool.query(
      `INSERT INTO wholesale_wave_orders (order_id, shopify_order_id, shopify_order_name, lines)
       VALUES ($1, $2, $3, $4)`,
      [o.order_id, first?.orderId || null, first?.orderName || null, JSON.stringify(o.lines)]);

    results.push({
      order_id: o.order_id, order_name: o.order_name,
      shopify_order_id: first?.orderId || null,
      shopify_order_name: first?.orderName || null,
      units: o.units, amount: o.amount,
      orderResults, attachments
    });
  }
  return results;
}
