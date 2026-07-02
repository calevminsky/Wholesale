// One-time backfill: normalize items -> wholesale_order_lines for every
// non-archived wholesale order, then run the on-hand reservation sweep.
// Run: node --env-file=.env scripts/backfill-order-lines.mjs
import { query, getPool } from "../src/pg.js";
import { syncOrderLines } from "../src/orders/normalize.js";
import { sweepOnHandReservations } from "../src/orders/reserve.js";

const { rows } = await query(
  `SELECT id, name, status FROM wholesale_orders
    WHERE archived_at IS NULL
    ORDER BY id`
);
console.log(`${rows.length} orders to normalize`);

let totalUnresolved = 0;
for (const o of rows) {
  const r = await syncOrderLines(o.id);
  const bad = r?.unresolved?.length || 0;
  totalUnresolved += bad;
  console.log(
    `#${o.id} [${o.status}] ${o.name || ""} — resolved ${r?.resolved ?? 0}, unresolved ${bad}` +
      (bad ? `: ${r.unresolved.map((u) => `${u.handle}/${u.size}`).join(", ")}` : "")
  );
}

const sweep = await sweepOnHandReservations();
console.log(`Sweep: reserved ${sweep.reservedUnits} on-hand units`);
if (totalUnresolved) console.log(`⚠ ${totalUnresolved} unresolved lines — fix handles in pd, then POST /api/orders-draft/:id/renormalize`);

await getPool().end();
