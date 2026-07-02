// On-hand reservation sweep: reserve Warehouse + Bogota stock (Warehouse
// drained first — same building) against open wholesale demand, FIFO by
// order age. Add-only — existing reservations are never rebalanced (policy:
// wholesale-first, no scarcity arbitration). Each reservation records its
// from_location so the transfer moves Shopify inventory from the right place.
//
// Keys: demand lines carry a Shopify variant id (from pd.variant for
// pd-resolved lines, or directly for Shopify-only in-stock lines). pd stores
// mostly bare-numeric ids while inventory_items.variant_id is a full GID, so
// every comparison uses the numeric tail (regexp_replace(x,'^.*/','')).
//
// Double-count guard: only active on-hand reservations that are NOT yet
// transferred subtract from Warehouse availability — once the transfer
// executes, the Shopify Warehouse count drops by itself. Receipt-source
// reservations never subtract (their units were pushed straight to the
// Wholesale location at PO closeout and never sat in the Warehouse count).
import { getPool } from "../pg.js";

const tail = (id) => String(id).replace(/^.*\//, "");

export async function sweepOnHandReservations() {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // One sweep at a time, cluster-wide.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('wholesale_reserve_sweep'))`);

    // Availability per (variant, location) for the pullable locations, net of
    // pending (untransferred) on-hand holds already placed at that location.
    const PULL_ORDER = ["Warehouse", "Bogota"];
    const { rows: avail } = await client.query(
      `WITH demand_variants AS (
         SELECT DISTINCT regexp_replace(shopify_variant_id, '^.*/', '') AS svid
           FROM wholesale_open_demand_lines
          WHERE shopify_variant_id IS NOT NULL
       )
       SELECT dv.svid, il.location_name,
              GREATEST(0, MAX(il.available)
                - COALESCE((SELECT SUM(r.qty) FROM wholesale_reservations r
                             WHERE regexp_replace(r.shopify_variant_id, '^.*/', '') = dv.svid
                               AND r.source = 'on_hand'
                               AND COALESCE(r.from_location, 'Warehouse') = il.location_name
                               AND r.released_at IS NULL
                               AND r.transferred_at IS NULL), 0))::int AS net_available
         FROM demand_variants dv
         JOIN public.inventory_items ii ON regexp_replace(ii.variant_id, '^.*/', '') = dv.svid
         JOIN public.inventory_levels il ON il.inventory_item_id = ii.inventory_item_id
                                        AND il.location_name = ANY($1::text[])
        GROUP BY dv.svid, il.location_name`,
      [PULL_ORDER]
    );
    // (svid -> location -> net available)
    const netByVariant = new Map();
    for (const r of avail) {
      let byLoc = netByVariant.get(r.svid);
      if (!byLoc) { byLoc = new Map(); netByVariant.set(r.svid, byLoc); }
      byLoc.set(r.location_name, r.net_available);
    }

    const { rows: demand } = await client.query(
      `SELECT order_line_id, variant_id, shopify_variant_id, open_qty
         FROM wholesale_open_demand_lines
        WHERE shopify_variant_id IS NOT NULL
        ORDER BY order_created_at, order_line_id`
    );

    let reservedUnits = 0;
    for (const d of demand) {
      const byLoc = netByVariant.get(tail(d.shopify_variant_id));
      if (!byLoc) continue;
      let need = d.open_qty;
      for (const loc of PULL_ORDER) {
        if (need <= 0) break;
        const net = byLoc.get(loc) || 0;
        if (net <= 0) continue;
        const take = Math.min(net, need);
        await client.query(
          `INSERT INTO wholesale_reservations (order_line_id, variant_id, shopify_variant_id, qty, source, from_location)
           VALUES ($1, $2, $3, $4, 'on_hand', $5)`,
          [d.order_line_id, d.variant_id, d.shopify_variant_id, take, loc]
        );
        byLoc.set(loc, net - take);
        need -= take;
        reservedUnits += take;
      }
    }

    await client.query("COMMIT");
    return { reservedUnits, variantsConsidered: netByVariant.size };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
