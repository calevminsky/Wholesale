// On-hand reservation sweep: reserve Warehouse stock against open wholesale
// demand, FIFO by order age. Add-only — existing reservations are never
// rebalanced (policy: wholesale-first, no scarcity arbitration).
//
// Double-count guard: only active on-hand reservations that are NOT yet
// transferred subtract from Warehouse availability — once the transfer
// executes, the Shopify Warehouse count drops by itself. Receipt-source
// reservations never subtract (their units were pushed straight to the
// Wholesale location at PO closeout and never sat in the Warehouse count).
import { getPool } from "../pg.js";

export async function sweepOnHandReservations() {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // One sweep at a time, cluster-wide.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('wholesale_reserve_sweep'))`);

    // Warehouse availability net of pending (untransferred) on-hand holds.
    const { rows: avail } = await client.query(
      `SELECT pv.id AS variant_id,
              GREATEST(0, MAX(il.available)
                - COALESCE((SELECT SUM(r.qty) FROM wholesale_reservations r
                             WHERE r.variant_id = pv.id
                               AND r.source = 'on_hand'
                               AND r.released_at IS NULL
                               AND r.transferred_at IS NULL), 0))::int AS net_available
         FROM wholesale_open_demand d
         JOIN pd.variant pv ON pv.id = d.variant_id
         JOIN public.inventory_items ii ON ii.variant_id = pv.shopify_variant_id::text
         JOIN public.inventory_levels il ON il.inventory_item_id = ii.inventory_item_id
                                        AND il.location_name = 'Warehouse'
        WHERE pv.shopify_variant_id IS NOT NULL
        GROUP BY pv.id`
    );
    const netByVariant = new Map(avail.map((r) => [String(r.variant_id), r.net_available]));

    const { rows: demand } = await client.query(
      `SELECT order_line_id, variant_id, open_qty
         FROM wholesale_open_demand_lines
        ORDER BY order_created_at, order_line_id`
    );

    let reservedUnits = 0;
    for (const d of demand) {
      const key = String(d.variant_id);
      const net = netByVariant.get(key) || 0;
      if (net <= 0) continue;
      const take = Math.min(net, d.open_qty);
      await client.query(
        `INSERT INTO wholesale_reservations (order_line_id, variant_id, qty, source)
         VALUES ($1, $2, $3, 'on_hand')`,
        [d.order_line_id, d.variant_id, take]
      );
      netByVariant.set(key, net - take);
      reservedUnits += take;
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
