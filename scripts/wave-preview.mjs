// Read-only preview of the wave plan. Run: node scripts/wave-preview.mjs
import { computeWavePlan } from "../src/orders/wave.js";
const plan = await computeWavePlan();
let U = 0, A = 0;
for (const o of plan) {
  console.log(`\n#${o.order_id}  ${o.order_name} — ${o.units} u  $${o.amount.toFixed(0)}`);
  for (const l of o.lines) {
    const src = [l.reserved ? `${l.reserved} reserved` : null, l.delivered ? `${l.delivered} delivered` : null]
      .filter(Boolean).join(" + ");
    console.log(`   ${String(l.qty).padStart(2)} × ${l.handle} [${l.size}]  (${src})`);
  }
  U += o.units; A += o.amount;
}
console.log(`\nTOTAL: ${plan.length} orders, ${U} units, $${A.toFixed(0)}`);
process.exit(0);
