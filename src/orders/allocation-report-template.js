// Internal allocation report: shows which units come from which location.
// Based on the preview snapshot's availabilitySeen[] allocations.
const SIZES = ["XXS", "XS", "S", "M", "L", "XL", "XXL"];

function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function buildAllocationReportHtml({ order, snapshot }) {
  if (!snapshot) return "<html><body><p>No preview snapshot available.</p></body></html>";

  const customerName = order.customer_name || "";
  const draftName = order.name || `Draft #${order.id}`;
  const dateStr = new Date().toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric"
  });

  const locationIdToName = snapshot.locationIdToName || {};
  const locationIdsInOrder = snapshot.locationIdsInOrder || Object.keys(locationIdToName);
  // Only include locations that actually filled something
  const activeLocIds = locationIdsInOrder.filter(lid =>
    (snapshot.report?.availabilitySeen || []).some(e =>
      (e.allocations || []).some(a => a.locationId === lid && a.qty > 0)
    )
  );

  const metaByHandle = snapshot.metaByHandle || {};
  const allItems = Array.isArray(order.items) ? order.items : [];

  // Build per-handle, per-size allocation breakdown.
  // allocMap[handle][size] = { requested, allocated, byLoc: {locId: qty} }
  const allocMap = {};
  for (const entry of (snapshot.report?.availabilitySeen || [])) {
    const { handle, size, allocations } = entry;
    if (!handle || !size) continue;
    if (!allocMap[handle]) allocMap[handle] = {};
    if (!allocMap[handle][size]) allocMap[handle][size] = { requested: 0, allocated: 0, byLoc: {} };
    const cell = allocMap[handle][size];
    for (const { locationId, qty } of (allocations || [])) {
      cell.byLoc[locationId] = (cell.byLoc[locationId] || 0) + qty;
      cell.allocated += qty;
    }
  }

  // Also pull requested from report.lines
  for (const line of (snapshot.report?.lines || [])) {
    if (allocMap[line.handle]?.[line.size]) {
      allocMap[line.handle][line.size].requested = line.requested;
    }
  }

  // Build display rows — one per item, ordered by the items array
  const rows = allItems
    .filter(it => {
      const sq = it.size_qty || it.sizeQty || {};
      return SIZES.some(s => Number(sq[s] || 0) > 0);
    })
    .map(it => {
      const handle = it.handle;
      const meta = metaByHandle[handle] || {};
      const title = it.product_name || meta.title || handle;
      const unitPrice = Number(it.unit_price ?? it.unitPrice ?? 0);

      // Active sizes for this item
      const sq = it.size_qty || it.sizeQty || {};
      const itemSizes = SIZES.filter(s => Number(sq[s] || 0) > 0);

      const sizeSummary = {}; // size → { requested, allocated, byLoc }
      let totalRequested = 0, totalAllocated = 0;
      for (const s of itemSizes) {
        const cell = allocMap[handle]?.[s] || { requested: Number(sq[s] || 0), allocated: 0, byLoc: {} };
        sizeSummary[s] = cell;
        totalRequested += cell.requested || Number(sq[s] || 0);
        totalAllocated += cell.allocated;
      }

      return { handle, title, unitPrice, itemSizes, sizeSummary, totalRequested, totalAllocated };
    });

  const grandRequested = rows.reduce((n, r) => n + r.totalRequested, 0);
  const grandAllocated = rows.reduce((n, r) => n + r.totalAllocated, 0);

  // Active sizes across ALL items
  const activeSizes = SIZES.filter(s => rows.some(r => r.itemSizes.includes(s)));

  function locationCell(r, s, locId) {
    const qty = r.sizeSummary[s]?.byLoc?.[locId] || 0;
    return `<td class="num${qty === 0 ? " zero" : ""}">${qty || ""}</td>`;
  }

  function rowHtml(r) {
    const hasShortfall = r.totalAllocated < r.totalRequested;
    const cells = activeLocIds.flatMap(locId =>
      activeSizes.map(s => locationCell(r, s, locId))
    ).join("");
    return `<tr${hasShortfall ? ' class="short-row"' : ""}>
      <td class="prod-td">
        <div class="prod-name">${esc(r.title)}</div>
        ${r.title !== r.handle ? `<div class="prod-handle">${esc(r.handle)}</div>` : ""}
      </td>
      ${cells}
      <td class="num total-c${hasShortfall ? " amber" : ""}">${r.totalAllocated}${hasShortfall ? `<span class="req"> / ${r.totalRequested}</span>` : ""}</td>
    </tr>`;
  }

  // Header: one column group per location, subdivided by active sizes
  const locHeaders = activeLocIds.map(locId => {
    const name = locationIdToName[locId] || locId;
    return `<th colspan="${activeSizes.length}" class="loc-header">${esc(name)}</th>`;
  }).join("");

  const sizeSubHeaders = activeLocIds.map(() =>
    activeSizes.map(s => `<th class="num size-h">${esc(s)}</th>`).join("")
  ).join("");

  const thead = `<thead>
    <tr>
      <th rowspan="2" style="width:22%;text-align:left;vertical-align:bottom">Product</th>
      ${locHeaders}
      <th rowspan="2" class="num total-h" style="width:7%;vertical-align:bottom">Total</th>
    </tr>
    <tr>${sizeSubHeaders}</tr>
  </thead>`;

  // Grand total row
  const totalCells = activeLocIds.flatMap(locId =>
    activeSizes.map(s => {
      const qty = rows.reduce((n, r) => n + (r.sizeSummary[s]?.byLoc?.[locId] || 0), 0);
      return `<td class="num${qty === 0 ? " zero" : ""}">${qty || ""}</td>`;
    })
  ).join("");

  const tfoot = `<tfoot><tr class="total-row">
    <td class="total-label">Total</td>
    ${totalCells}
    <td class="num total-c">${grandAllocated}${grandAllocated < grandRequested ? `<span class="req"> / ${grandRequested}</span>` : ""}</td>
  </tr></tfoot>`;

  let ranAtStr = "";
  if (snapshot.ranAt) {
    try {
      ranAtStr = new Date(snapshot.ranAt).toLocaleString("en-US", {
        year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
      });
    } catch { /* ignore */ }
  }

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    @page { size: Letter landscape; margin: 0.3in 0.35in 0.45in 0.35in; }
    body {
      margin: 0; padding: 0;
      font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
      font-size: 8.5px; color: #1a1a1a;
      -webkit-font-smoothing: antialiased;
    }

    .header {
      display: flex; justify-content: space-between; align-items: flex-end;
      border-bottom: 1.5px solid #1a1a1a;
      padding-bottom: 4px; margin-bottom: 8px;
    }
    .brand img { max-height: 30px; width: auto; }
    .meta-left .doc-title  { font-size: 13px; font-weight: 700; }
    .meta-left .sub        { font-size: 8.5px; color: #555; margin-top: 2px; }
    .meta-right            { text-align: right; font-size: 8px; color: #888; line-height: 1.5; }
    .internal-tag { font-size: 8px; color: #b00020; font-weight: 700;
                    letter-spacing: 0.5px; text-transform: uppercase; }

    .sheet-tbl { width: 100%; border-collapse: collapse; table-layout: fixed; }
    .sheet-tbl thead { display: table-header-group; }
    .sheet-tbl th {
      background: #fafafa; border-bottom: 1.2px solid #1a1a1a;
      padding: 3px 3px; text-align: left;
      font-weight: 600; font-size: 7.5px; letter-spacing: 0.3px;
      text-transform: uppercase; color: #555;
    }
    .sheet-tbl th.num { text-align: right; }
    .loc-header {
      background: #f0f4ff; border-bottom: 1px solid #c0c8e8 !important;
      text-align: center !important; font-size: 8px; color: #1a3a7a;
      border-right: 1.5px solid #c0c8e8;
    }
    .size-h { font-size: 7px; color: #888; background: #f9faff; border-right: 1px solid #e8ecf8; }
    .total-h { background: #f5f5f5; }
    .sheet-tbl td {
      border-bottom: 1px solid #eee; padding: 3px;
      font-size: 8.5px; vertical-align: middle; overflow: hidden;
    }
    .sheet-tbl .num { text-align: right; }
    .sheet-tbl .zero { color: #ddd; }
    .sheet-tbl tr { page-break-inside: avoid; }

    /* location group borders */
    ${activeLocIds.map((_, i) => {
      const startCol = 2 + i * activeSizes.length; // 1-indexed cols
      return ``;
    }).join("")}
    td:nth-child(${activeSizes.length + 1}n) { border-right: 1.5px solid #e0e5f5; }

    .prod-td { vertical-align: middle; }
    .prod-name   { font-weight: 600; line-height: 1.2; }
    .prod-handle { font-size: 7px; color: #bbb; margin-top: 1px; }

    .short-row td { background: #fffbf0; }
    .total-c { font-weight: 600; }
    .total-c.amber { color: #d97706; }
    .req { font-weight: 400; color: #bbb; font-size: 7.5px; }

    .total-row td {
      border-top: 1.5px solid #1a1a1a; border-bottom: none;
      padding: 4px 3px; font-weight: 700;
    }
    .total-label { font-size: 8px; font-weight: 700; letter-spacing: 0.3px; text-transform: uppercase; color: #555; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <div class="meta-left">
        <div class="doc-title">Allocation Report — Internal</div>
        <div class="sub">${customerName ? `${esc(customerName)} · ` : ""}${esc(draftName)}</div>
      </div>
    </div>
    <div class="meta-right">
      <div class="internal-tag">Internal only — do not share</div>
      <div>Preview run ${esc(ranAtStr)}</div>
      <div>${esc(dateStr)}</div>
    </div>
  </div>

  <table class="sheet-tbl">
    ${thead}
    <tbody>${rows.map(rowHtml).join("")}</tbody>
    ${tfoot}
  </table>
</body>
</html>`;
}
