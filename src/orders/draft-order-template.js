// HTML template for a customer-facing draft order confirmation PDF.
const SIZES = ["XXS", "XS", "S", "M", "L", "XL", "XXL"];

function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function money(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return "—";
  return `$${n.toFixed(2)}`;
}

export function buildDraftOrderHtml({ order, snapshot }) {
  const allItems = Array.isArray(order.items) ? order.items : [];
  const customerName = order.customer_name || "";
  const draftName = order.name || `Draft #${order.id}`;
  const dateStr = new Date().toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric"
  });

  // Build per-handle, per-size allocation lookup from snapshot.
  const previewLines = {};
  const metaByHandle = {};
  if (snapshot) {
    for (const line of (snapshot.report?.lines || [])) {
      if (!previewLines[line.handle]) previewLines[line.handle] = {};
      previewLines[line.handle][line.size] = { requested: line.requested, allocated: line.allocated };
    }
    Object.assign(metaByHandle, snapshot.metaByHandle || {});
  }

  const hasPreview = !!snapshot;

  const rows = allItems
    .filter(it => {
      const sq = it.size_qty || it.sizeQty || {};
      return SIZES.some(s => Number(sq[s] || 0) > 0);
    })
    .map(it => {
      const sq = it.size_qty || it.sizeQty || {};
      const handle = it.handle;
      const meta = metaByHandle[handle] || {};
      const title = it.product_name || meta.title || handle;
      const imageUrl = meta.imageUrl || "";
      const unitPrice = Number(it.unit_price ?? it.unitPrice ?? 0);

      const sizeData = {};
      let totalOrdered = 0, totalConfirmed = 0;

      for (const s of SIZES) {
        const ordered = Number(sq[s] || 0);
        const pl = previewLines[handle]?.[s];
        const confirmed = hasPreview ? (pl ? pl.allocated : 0) : ordered;
        sizeData[s] = { ordered, confirmed };
        totalOrdered += ordered;
        totalConfirmed += confirmed;
      }

      const rowValue = unitPrice * totalConfirmed;
      return { handle, title, imageUrl, unitPrice, sizeData, totalOrdered, totalConfirmed, rowValue };
    });

  const activeSizes = SIZES.filter(s =>
    rows.some(r => r.sizeData[s].ordered > 0 || r.sizeData[s].confirmed > 0)
  );

  const hasImages = rows.some(r => r.imageUrl);
  const grandConfirmed = rows.reduce((n, r) => n + r.totalConfirmed, 0);
  const grandValue     = rows.reduce((n, r) => n + r.rowValue, 0);

  // Size cell: if shortfall, show ordered struck-through above confirmed.
  // No row-level highlighting — keep it clean.
  function sizeCell(r, s) {
    const { ordered, confirmed } = r.sizeData[s];
    if (ordered === 0 && confirmed === 0) return `<td class="num"></td>`;

    if (!hasPreview || confirmed === ordered) {
      return `<td class="num${confirmed === 0 ? " zero" : ""}">${confirmed || ""}</td>`;
    }
    if (confirmed === 0) {
      return `<td class="num short"><span class="was">${ordered}</span><span class="none">—</span></td>`;
    }
    return `<td class="num short"><span class="was">${ordered}</span><span class="fill">${confirmed}</span></td>`;
  }

  function rowHtml(r) {
    const sizeCells = activeSizes.map(s => sizeCell(r, s)).join("");
    return `<tr>
      ${hasImages ? `<td class="img-td">${r.imageUrl ? `<img src="${esc(r.imageUrl)}?width=140">` : ""}</td>` : ""}
      <td class="prod-td">
        <div class="prod-name">${esc(r.title)}</div>
        ${r.title !== r.handle ? `<div class="prod-handle">${esc(r.handle)}</div>` : ""}
      </td>
      <td class="num price-c">${money(r.unitPrice)}</td>
      ${sizeCells}
      <td class="num total-units">${r.totalConfirmed}</td>
      <td class="num row-value">${r.rowValue > 0 ? money(r.rowValue) : "—"}</td>
    </tr>`;
  }

  const colImg   = hasImages ? `<th style="width:9%"></th>` : "";
  const prodW    = hasImages ? "26%" : "35%";
  const sizeCols = activeSizes.map(s => `<th class="num" style="width:5%">${esc(s)}</th>`).join("");
  const thead = `<thead><tr>
    ${colImg}
    <th style="width:${prodW};text-align:left">Product</th>
    <th class="num" style="width:8%">Wholesale</th>
    ${sizeCols}
    <th class="num" style="width:7%">Units</th>
    <th class="num" style="width:9%">Value</th>
  </tr></thead>`;

  // Footer: subtotal → shipping (TBD) → total, right-aligned under Value column.
  const tfootEmpty = activeSizes.map(() => `<td></td>`).join("");
  const colSpanLeft = (hasImages ? 1 : 0) + 2; // img? + product + wholesale
  const tfoot = `<tfoot>
    <tr class="subtotal-row">
      ${hasImages ? `<td></td>` : ""}
      <td colspan="2" class="summary-label">Subtotal</td>
      ${tfootEmpty}
      <td class="num summary-units">${grandConfirmed}</td>
      <td class="num summary-value">${money(grandValue)}</td>
    </tr>
    <tr class="shipping-row">
      ${hasImages ? `<td></td>` : ""}
      <td colspan="2" class="summary-label">Shipping</td>
      ${tfootEmpty}
      <td></td>
      <td class="num shipping-tbd">TBD</td>
    </tr>
    <tr class="total-row">
      ${hasImages ? `<td></td>` : ""}
      <td colspan="2" class="total-label">Total</td>
      ${tfootEmpty}
      <td></td>
      <td class="num total-value">${money(grandValue)} + shipping</td>
    </tr>
  </tfoot>`;

  let ranAtStr = "";
  if (snapshot?.ranAt) {
    try {
      ranAtStr = new Date(snapshot.ranAt).toLocaleString("en-US", {
        year: "numeric", month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit"
      });
    } catch { /* ignore */ }
  }

  const previewNote = hasPreview
    ? `<p class="preview-note">Availability confirmed${ranAtStr ? ` as of ${esc(ranAtStr)}` : ""}.</p>`
    : `<p class="preview-note">Quantities shown are as ordered — availability not yet confirmed.</p>`;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    @page { size: Letter portrait; margin: 0.35in 0.4in 0.5in 0.4in; }
    body {
      margin: 0; padding: 0;
      font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
      font-size: 9.5px; color: #1a1a1a;
      -webkit-font-smoothing: antialiased;
    }

    .header {
      display: flex; justify-content: space-between; align-items: flex-end;
      border-bottom: 1.5px solid #1a1a1a;
      padding-bottom: 6px; margin-bottom: 10px;
    }
    .brand img { max-height: 38px; width: auto; }
    .meta { text-align: right; }
    .meta .doc-title { font-size: 16px; font-weight: 700; letter-spacing: 0.2px; line-height: 1.15; }
    .meta .customer  { font-size: 10px; color: #444; margin-top: 3px; letter-spacing: 0.4px; text-transform: uppercase; }
    .meta .date      { font-size: 8.5px; color: #888; margin-top: 2px; }
    .meta .ref       { font-size: 8px; color: #bbb; margin-top: 1px; }

    .preview-note { font-size: 8.5px; color: #888; margin: 0 0 5px; }

    .sheet-tbl { width: 100%; border-collapse: collapse; table-layout: fixed; }
    .sheet-tbl thead { display: table-header-group; }
    .sheet-tbl th {
      background: #fafafa; border-bottom: 1.5px solid #1a1a1a;
      padding: 4px; text-align: left;
      font-weight: 600; font-size: 8px; letter-spacing: 0.4px;
      text-transform: uppercase; color: #555;
    }
    .sheet-tbl th.num { text-align: right; }
    .sheet-tbl td {
      border-bottom: 1px solid #eee; padding: 4px;
      font-size: 9px; vertical-align: middle; overflow: hidden;
    }
    .sheet-tbl .num { text-align: right; }
    .sheet-tbl .zero { color: #ddd; }
    .sheet-tbl tr { page-break-inside: avoid; }

    .img-td { text-align: center; padding: 3px 2px; }
    .img-td img { max-width: 62px; max-height: 72px; object-fit: cover; border-radius: 3px; }

    .prod-td { vertical-align: middle; }
    .prod-name   { font-weight: 600; line-height: 1.25; }
    .prod-handle { font-size: 7.5px; color: #bbb; margin-top: 1px; }

    td.price-c     { color: #555; }
    td.total-units { font-weight: 600; }
    td.row-value   { font-weight: 600; }

    /* Shortfall size cells only — no row-level treatment */
    td.short { line-height: 1.4; }
    span.was  { display: block; text-decoration: line-through; color: #ccc; font-size: 8px; }
    span.fill { display: block; font-weight: 700; color: #d97706; }
    span.none { display: block; font-weight: 700; color: #bbb; font-size: 8px; }

    /* Footer summary rows */
    .subtotal-row td, .shipping-row td, .total-row td {
      border-bottom: none; padding: 4px 4px 2px;
    }
    .subtotal-row td { border-top: 1.5px solid #1a1a1a; }
    .summary-label  { font-size: 8.5px; color: #888; }
    .summary-units  { font-size: 9px; font-weight: 600; }
    .summary-value  { font-size: 9px; font-weight: 600; }
    .shipping-tbd   { font-size: 9px; color: #aaa; font-style: italic; }
    .total-label    { font-size: 9.5px; font-weight: 700; letter-spacing: 0.3px; text-transform: uppercase; }
    .total-value    { font-size: 10px; font-weight: 700; }

    .footer-note {
      margin-top: 16px; padding-top: 6px;
      border-top: 1px solid #eee;
      font-size: 8px; color: #bbb; text-align: center; line-height: 1.5;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="brand">
      <img src="https://cdn.shopify.com/s/files/1/0079/3998/1409/files/YB_Logo_Text.png?v=1720112556" alt="Yakira Bella">
    </div>
    <div class="meta">
      <div class="doc-title">${hasPreview ? "Order Confirmation" : "Draft Order"}</div>
      ${customerName ? `<div class="customer">${esc(customerName)}</div>` : ""}
      <div class="date">${esc(dateStr)}</div>
      <div class="ref">${esc(draftName)}</div>
    </div>
  </div>

  ${previewNote}

  <table class="sheet-tbl">
    ${thead}
    <tbody>${rows.map(rowHtml).join("")}</tbody>
    ${tfoot}
  </table>

  <div class="footer-note">
    This is a draft order confirmation — not a final invoice.<br>
    Prices and quantities are subject to final confirmation prior to shipment.
  </div>
</body>
</html>`;
}
