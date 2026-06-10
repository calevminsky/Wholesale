// Server-authoritative order assembly. The browser sends only {handle, size_qty}
// per line; the server looks up the wholesale price + product name from the
// catalog (never trusts client prices) and builds the order in the exact shape
// the importer ingests (wholesale_orders.items).
export const SIZE_CORE = ["XXS", "XS", "S", "M", "L", "XL", "XXL"];
export const LOCATIONS = [
  "gid://shopify/Location/68496293985",
  "gid://shopify/Location/31679414369",
  "gid://shopify/Location/20363018337",
  "gid://shopify/Location/62070161505",
  "gid://shopify/Location/33027424353"
];

export function buildOrder({ account, lines, notes, shipping, catalog }) {
  const byHandle = new Map((catalog.products || []).filter((p) => p.tier !== "off").map((p) => [p.handle, p]));
  const items = [];
  let units = 0, subtotal = 0;
  const skipped = [];
  for (const line of lines || []) {
    const p = byHandle.get(line?.handle);
    if (!p || !Number.isFinite(p.wholesale_price)) { if (line?.handle) skipped.push(line.handle); continue; }
    const size_qty = {};
    let any = 0;
    for (const k of SIZE_CORE) { const q = Math.max(0, parseInt(line.size_qty?.[k], 10) || 0); size_qty[k] = q; any += q; }
    if (p.sizes.some((s) => s.size === "OS")) { const q = Math.max(0, parseInt(line.size_qty?.OS, 10) || 0); size_qty.OS = q; any += q; }
    if (!any) continue;
    items.push({ handle: p.handle, product_name: p.title, unit_price: p.wholesale_price, size_qty, _sources: [`(portal:${account.slug})`] });
    units += any;
    subtotal += any * p.wholesale_price;
  }
  const dateStr = new Date().toISOString().slice(0, 10);
  const shipLabel = shipping === "when_ready" ? "Ship when ready" : "Ship all together";
  const userNotes = String(notes || "").trim();
  const order = {
    name: `${account.name} ${dateStr}`,
    customer_id: account.customer_id ?? null,
    line_sheet_id: null,
    location_ids: LOCATIONS,
    shipping: shipping === "when_ready" ? "when_ready" : "all",
    notes: `[${shipLabel}]${userNotes ? " " + userNotes : ""}`,
    source_filename: `wholesale-portal/${account.slug}-${dateStr}.json`,
    items
  };
  return { order, units, subtotal, skipped, dateStr };
}

export function orderCSV(order) {
  const hasOS = order.items.some((it) => "OS" in it.size_qty);
  const cols = ["handle", "product_name", "unit_price", ...SIZE_CORE, ...(hasOS ? ["OS"] : [])];
  const q = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const rows = [cols.join(",")];
  for (const it of order.items) {
    rows.push([it.handle, q(it.product_name), it.unit_price, ...SIZE_CORE.map((k) => it.size_qty[k] || 0), ...(hasOS ? [it.size_qty.OS || 0] : [])].join(","));
  }
  return rows.join("\n");
}

export function orderSummary({ order, units, subtotal, account, buyerEmail }) {
  const lines = order.items.map((it) => {
    const sizes = [...SIZE_CORE, "OS"].filter((k) => it.size_qty[k]).map((k) => `${k}:${it.size_qty[k]}`).join("  ");
    const u = Object.values(it.size_qty).reduce((a, b) => a + b, 0);
    return `  • ${it.product_name} — ${sizes}  (${u} @ $${it.unit_price} = $${u * it.unit_price})`;
  }).join("\n");
  return [
    `Account: ${account.name}${account.customer_id ? ` (customer #${account.customer_id})` : " — no account link (Guest)"}`,
    buyerEmail ? `Buyer email: ${buyerEmail}` : "",
    `Shipping: ${order.shipping === "when_ready" ? "Ship when ready (partial shipments OK)" : "Ship all together"}`,
    order.notes ? `Notes: ${order.notes}` : "",
    "",
    `${order.items.length} styles · ${units} units · $${subtotal} subtotal`,
    "",
    lines
  ].filter((x) => x !== "").join("\n");
}
