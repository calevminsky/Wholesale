// Pick list PDF for warehouse and store workers.
// Generates one page per location, an optional combined Bogota+Warehouse page,
// and a Total page at the end.
const SIZES = ["XXS", "XS", "S", "M", "L", "XL", "XXL"];

function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function buildPickListHtml({ order, snapshot, snapshotIsStale }) {
  if (!snapshot) {
    return `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:2rem;">
      <p><strong>No preview snapshot.</strong> Run Preview first, then print the pick list.</p>
    </body></html>`;
  }

  const locationIdToName = snapshot.locationIdToName || {};
  const locationIdsInOrder = snapshot.locationIdsInOrder || Object.keys(locationIdToName);

  // perLocAlloc[locId][handle][size] = allocated qty
  const perLocAlloc = {};
  for (const entry of (snapshot.report?.availabilitySeen || [])) {
    const { handle, size, allocations } = entry;
    if (!handle || !size) continue;
    for (const { locationId, qty } of (allocations || [])) {
      if (qty <= 0) continue;
      if (!perLocAlloc[locationId]) perLocAlloc[locationId] = {};
      if (!perLocAlloc[locationId][handle]) perLocAlloc[locationId][handle] = {};
      perLocAlloc[locationId][handle][size] =
        (perLocAlloc[locationId][handle][size] || 0) + qty;
    }
  }

  const activeLocIds = locationIdsInOrder.filter(
    lid => perLocAlloc[lid] && Object.keys(perLocAlloc[lid]).length > 0
  );

  // Product name: prefer allocator metadata, then stored name, then handle
  const metaByHandle = snapshot.metaByHandle || {};
  const allItems = Array.isArray(order.items) ? order.items : [];
  const nameByHandle = {};
  for (const it of allItems) {
    nameByHandle[it.handle] = metaByHandle[it.handle]?.title || it.product_name || it.handle;
  }
  for (const [h, m] of Object.entries(metaByHandle)) {
    if (!nameByHandle[h]) nameByHandle[h] = m.title || h;
  }

  // All handles that appear in any location's allocation, sorted by product name
  const allHandles = [...new Set(
    activeLocIds.flatMap(lid => Object.keys(perLocAlloc[lid] || {}))
  )].sort((a, b) => (nameByHandle[a] || a).localeCompare(nameByHandle[b] || b));

  const customerName = order.customer_name || snapshot.customer || "";
  const draftName    = order.name || `Draft #${order.id}`;
  const orderNum     = order.shopify_order_name || "";
  const notes        = order.notes || snapshot.notes || "";
  const dateStr = new Date().toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric"
  });
  const ranAt = snapshot.ranAt
    ? new Date(snapshot.ranAt).toLocaleString("en-US", {
        month: "short", day: "numeric", year: "numeric",
        hour: "numeric", minute: "2-digit"
      })
    : "";

  // Determine if combined Bogota+Warehouse page is needed
  const bogotaIds    = activeLocIds.filter(lid => (locationIdToName[lid] || "").toLowerCase().includes("bogota"));
  const warehouseIds = activeLocIds.filter(lid => (locationIdToName[lid] || "").toLowerCase().includes("warehouse"));
  const showCombined = bogotaIds.length > 0 && warehouseIds.length > 0;
  const combinedIds  = [...bogotaIds, ...warehouseIds];
  // If combined covers every active location, the combined page IS the total — skip a redundant total
  const combinedIsTotal = showCombined && combinedIds.length === activeLocIds.length;

  const sections = activeLocIds.map(lid => ({
    title: locationIdToName[lid] || lid,
    locIds: [lid]
  }));

  if (showCombined) {
    const combinedTitle = combinedIds.map(id => locationIdToName[id]).join(" + ")
      + (combinedIsTotal ? "" : " (Combined)");
    sections.push({ title: combinedTitle, locIds: combinedIds });
  }

  if (!combinedIsTotal) {
    sections.push({ title: "Total — All Locations", locIds: activeLocIds });
  }

  const staleBar = snapshotIsStale
    ? `<div class="stale">⚠ Preview may be outdated — re-run Preview for current availability</div>`
    : "";

  const meta = { customerName, draftName, orderNum, notes, dateStr, ranAt, staleBar };
  const pages = sections.map((sec, i) =>
    renderPage({ ...sec, allHandles, perLocAlloc, nameByHandle, meta, isLast: i === sections.length - 1 })
  );

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>${CSS}</style>
</head>
<body>
${pages.join("\n")}
</body>
</html>`;
}

function renderPage({ title, locIds, allHandles, perLocAlloc, nameByHandle, meta, isLast }) {
  // Sum allocation across the given locations
  const pageData = {};
  for (const locId of locIds) {
    for (const [handle, sizeMap] of Object.entries(perLocAlloc[locId] || {})) {
      if (!pageData[handle]) pageData[handle] = {};
      for (const [size, qty] of Object.entries(sizeMap)) {
        pageData[handle][size] = (pageData[handle][size] || 0) + qty;
      }
    }
  }

  const handles = allHandles.filter(h => {
    const d = pageData[h];
    return d && Object.values(d).some(q => q > 0);
  });

  const pageClass = `page${isLast ? "" : " break-after"}`;

  if (!handles.length) {
    return `<div class="${pageClass}">
      ${renderHeader(title, meta)}
      <p class="empty">No items allocated to this location.</p>
    </div>`;
  }

  // Only show sizes that have a non-zero qty on this page
  const activeSizes = SIZES.filter(s => handles.some(h => (pageData[h]?.[s] || 0) > 0));

  const colTotals = Object.fromEntries(activeSizes.map(s => [s, 0]));
  let grandTotal = 0;

  const rowsHtml = handles.map(handle => {
    const d = pageData[handle] || {};
    let rowTotal = 0;
    const cells = activeSizes.map(s => {
      const qty = d[s] || 0;
      colTotals[s] += qty;
      rowTotal += qty;
      return `<td class="sz${qty ? "" : " zero"}">${qty || ""}</td>`;
    }).join("");
    grandTotal += rowTotal;

    const name = nameByHandle[handle] || handle;
    const showHandle = name !== handle;
    return `<tr>
      <td class="pn">
        <div class="pn-title">${esc(name)}</div>
        ${showHandle ? `<div class="pn-handle">${esc(handle)}</div>` : ""}
      </td>
      ${cells}
      <td class="tot">${rowTotal}</td>
    </tr>`;
  }).join("");

  const footCells = activeSizes.map(s =>
    `<td class="sz">${colTotals[s] || ""}</td>`
  ).join("");

  return `<div class="${pageClass}">
    ${renderHeader(title, meta)}
    <table class="pt">
      <thead>
        <tr>
          <th class="pn">Product</th>
          ${activeSizes.map(s => `<th class="sz">${esc(s)}</th>`).join("")}
          <th class="tot">Total</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
      <tfoot>
        <tr class="tr-foot">
          <td class="pn">TOTAL</td>
          ${footCells}
          <td class="tot">${grandTotal}</td>
        </tr>
      </tfoot>
    </table>
  </div>`;
}

function renderHeader(title, { customerName, draftName, orderNum, notes, dateStr, ranAt, staleBar }) {
  const parts = [
    orderNum
      ? `<span class="ml">Order</span> <span class="mv">${esc(orderNum)}</span>`
      : `<span class="ml">Draft</span> <span class="mv">${esc(draftName)}</span>`,
    customerName ? `<span class="ml">Customer</span> <span class="mv">${esc(customerName)}</span>` : null,
    notes ? `<span class="ml">Notes</span> <span class="mv">${esc(notes)}</span>` : null,
    ranAt ? `<span class="ml muted">Preview</span> <span class="mv muted">${esc(ranAt)}</span>` : null
  ].filter(Boolean).join(`<span class="sep"> &middot; </span>`);

  return `
    <div class="page-hd">
      <div class="loc-name">${esc(title)}</div>
      <div class="hd-date">${esc(dateStr)}</div>
    </div>
    ${staleBar}
    <div class="meta-bar">${parts}</div>`;
}

const CSS = `
@page { size: Letter portrait; margin: 0.45in 0.5in 0.4in 0.5in; }
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
  color: #111;
  -webkit-font-smoothing: antialiased;
}

.page {}
.break-after { break-after: page; }

.page-hd {
  display: flex; justify-content: space-between; align-items: flex-end;
  border-bottom: 2.5px solid #111;
  padding-bottom: 5px; margin-bottom: 7px;
}
.loc-name {
  font-size: 22px; font-weight: 700; letter-spacing: -0.3px;
  text-transform: uppercase; line-height: 1;
}
.hd-date { font-size: 10px; color: #666; }

.stale {
  background: #fff7e0; border: 1px solid #f59e0b; border-radius: 3px;
  padding: 4px 8px; font-size: 10px; color: #92400e; margin-bottom: 6px;
}

.meta-bar {
  background: #f5f5f5; border: 1px solid #e0e0e0; border-radius: 3px;
  padding: 5px 10px; margin-bottom: 10px;
  font-size: 10.5px; line-height: 1.6; color: #333;
}
.ml  { font-weight: 700; color: #222; margin-right: 3px; }
.mv  { color: #222; }
.sep { color: #bbb; margin: 0 6px; }
.muted { color: #aaa; }

.pt { width: 100%; border-collapse: collapse; font-size: 11px; }

.pt thead th {
  background: #111; color: #fff;
  padding: 5px 8px;
  font-size: 9.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.4px;
}
.pt th.pn  { text-align: left; }
.pt th.sz  { text-align: center; min-width: 30px; }
.pt th.tot { text-align: right; min-width: 44px; }

.pt tbody tr:nth-child(even) { background: #f9f9f9; }
.pt tbody tr { page-break-inside: avoid; }
.pt tbody td { padding: 5px 8px; border-bottom: 1px solid #ebebeb; vertical-align: middle; }

.pt td.sz  { text-align: center; }
.pt td.tot { text-align: right; font-weight: 600; }
.zero { color: #ddd; }

.pn-title  { font-size: 12px; font-weight: 600; line-height: 1.2; }
.pn-handle { font-size: 9px; color: #aaa; margin-top: 1px; }

.pt tfoot .tr-foot td {
  background: #e8e8e8; font-weight: 700;
  border-top: 2px solid #111; border-bottom: none;
  padding: 6px 8px;
  text-transform: uppercase; letter-spacing: 0.3px; font-size: 10.5px; color: #333;
}

.empty { color: #999; font-style: italic; padding: 20px 0; font-size: 11px; }
`;
