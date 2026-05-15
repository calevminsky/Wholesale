// Pick list PDF for warehouse and store workers.
// Page order: Total → Bogota+Warehouse combined → stores → Warehouse → Bogota.
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

  // Product name / image lookup
  const metaByHandle = snapshot.metaByHandle || {};
  const allItems = Array.isArray(order.items) ? order.items : [];
  const nameByHandle = {};
  const imageByHandle = {};
  for (const it of allItems) {
    nameByHandle[it.handle] = metaByHandle[it.handle]?.title || it.product_name || it.handle;
  }
  for (const [h, m] of Object.entries(metaByHandle)) {
    if (!nameByHandle[h]) nameByHandle[h] = m.title || h;
    if (m.imageUrl) imageByHandle[h] = m.imageUrl;
  }

  // All handles sorted by product name
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
  const submittedAt = snapshot.submittedAt || snapshot.ranAt;
  const ranAt = submittedAt
    ? new Date(submittedAt).toLocaleString("en-US", {
        month: "short", day: "numeric", year: "numeric",
        hour: "numeric", minute: "2-digit"
      })
    : "";
  const ranLabel = snapshot.submittedAt ? "Submitted" : "Preview";

  // ---- classify locations ----
  const bogotaIds    = activeLocIds.filter(lid => (locationIdToName[lid] || "").toLowerCase().includes("bogota"));
  const warehouseIds = activeLocIds.filter(lid => (locationIdToName[lid] || "").toLowerCase().includes("warehouse"));
  const storeIds     = activeLocIds.filter(
    lid => !bogotaIds.includes(lid) && !warehouseIds.includes(lid)
  );
  const combinedIds  = [...bogotaIds, ...warehouseIds];
  const showCombined = bogotaIds.length > 0 && warehouseIds.length > 0;

  // ---- page order: Total → Combined → stores → Warehouse → Bogota ----
  const sections = [];

  // 1. Total
  sections.push({ title: "Total — All Locations", locIds: activeLocIds, isTotal: true });

  // 2. Combined Bogota + Warehouse
  if (showCombined) {
    sections.push({
      title: combinedIds.map(id => locationIdToName[id]).join(" + "),
      locIds: combinedIds
    });
  }

  // 3. Store locations (anything that isn't Bogota or Warehouse)
  for (const lid of storeIds) {
    sections.push({ title: locationIdToName[lid] || lid, locIds: [lid] });
  }

  // 4. Warehouse (individual)
  for (const lid of warehouseIds) {
    sections.push({ title: locationIdToName[lid] || lid, locIds: [lid] });
  }

  // 5. Bogota (individual)
  for (const lid of bogotaIds) {
    sections.push({ title: locationIdToName[lid] || lid, locIds: [lid] });
  }

  const staleBar = snapshotIsStale
    ? `<div class="stale">⚠ Snapshot may be outdated — re-run Preview for current availability</div>`
    : "";

  const meta = { customerName, draftName, orderNum, notes, dateStr, ranAt, ranLabel, staleBar };
  const pages = sections.map((sec, i) =>
    renderPage({ ...sec, allHandles, perLocAlloc, nameByHandle, imageByHandle, meta, isLast: i === sections.length - 1 })
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

function renderPage({ title, locIds, allHandles, perLocAlloc, nameByHandle, imageByHandle, meta, isLast, isTotal }) {
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
      ${renderHeader(title, meta, isTotal)}
      <p class="empty">No items allocated to this location.</p>
    </div>`;
  }

  const activeSizes = SIZES.filter(s => handles.some(h => (pageData[h]?.[s] || 0) > 0));
  const hasImages = handles.some(h => imageByHandle?.[h]);

  const colTotals = Object.fromEntries(activeSizes.map(s => [s, 0]));
  let grandTotal = 0;

  const rowsHtml = handles.map((handle, rowIdx) => {
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
    const rowClass = rowIdx % 2 === 0 ? "row-even" : "row-odd";
    const imgUrl = imageByHandle?.[handle];
    const imgCell = hasImages
      ? `<td class="img-cell">${imgUrl ? `<img src="${esc(imgUrl)}?width=100" alt="">` : ""}</td>`
      : "";
    return `<tr class="${rowClass}">
      ${imgCell}
      <td class="pn">
        <span class="pn-title">${esc(name)}</span>
        ${showHandle ? `<br><span class="pn-handle">${esc(handle)}</span>` : ""}
      </td>
      ${cells}
      <td class="tot">${rowTotal}</td>
    </tr>`;
  }).join("");

  const footCells = activeSizes.map(s =>
    `<td class="sz foot-sz">${colTotals[s] || ""}</td>`
  ).join("");

  const imgHeader = hasImages ? `<th class="img-cell"></th>` : "";
  const imgFooter = hasImages ? `<td class="img-cell"></td>` : "";

  return `<div class="${pageClass}">
    ${renderHeader(title, meta, isTotal)}
    <table class="pt">
      <thead>
        <tr>
          ${imgHeader}
          <th class="pn">Product</th>
          ${activeSizes.map(s => `<th class="sz">${esc(s)}</th>`).join("")}
          <th class="tot">Total</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
      <tfoot>
        <tr>
          ${imgFooter}
          <td class="pn foot-label">TOTAL</td>
          ${footCells}
          <td class="tot foot-sz">${grandTotal}</td>
        </tr>
      </tfoot>
    </table>
  </div>`;
}

function renderHeader(title, { customerName, draftName, orderNum, notes, dateStr, ranAt, ranLabel, staleBar }, isTotal) {
  const parts = [
    orderNum
      ? `<span class="ml">Order</span> <span class="mv">${esc(orderNum)}</span>`
      : `<span class="ml">Draft</span> <span class="mv">${esc(draftName)}</span>`,
    customerName ? `<span class="ml">Customer</span> <span class="mv">${esc(customerName)}</span>` : null,
    notes ? `<span class="ml">Notes</span> <span class="mv">${esc(notes)}</span>` : null,
    ranAt ? `<span class="ml muted">${esc(ranLabel)}</span> <span class="mv muted">${esc(ranAt)}</span>` : null
  ].filter(Boolean).join(`<span class="sep"> &middot; </span>`);

  const titleClass = isTotal ? "loc-name loc-total" : "loc-name";

  return `
    <div class="page-hd">
      <div class="${titleClass}">${esc(title)}</div>
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
  border-bottom: 2px solid #111;
  padding-bottom: 5px; margin-bottom: 6px;
}
.loc-name {
  font-size: 20px; font-weight: 700; letter-spacing: -0.2px;
  text-transform: uppercase; line-height: 1;
}
.loc-total { color: #1a3a7a; }
.hd-date { font-size: 10px; color: #666; }

.stale {
  background: #fff7e0; border: 1px solid #f59e0b; border-radius: 3px;
  padding: 4px 8px; font-size: 10px; color: #92400e; margin-bottom: 6px;
}

.meta-bar {
  background: #f0f4f8; border: 1px solid #d0dae8; border-radius: 2px;
  padding: 4px 8px; margin-bottom: 8px;
  font-size: 10px; line-height: 1.6; color: #333;
}
.ml  { font-weight: 700; color: #1a3a7a; margin-right: 3px; }
.mv  { color: #222; }
.sep { color: #bbb; margin: 0 5px; }
.muted { color: #aaa; }

/* spreadsheet-style table */
.pt {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
  border: 1.5px solid #9ab;
}

.pt thead th {
  background: #d0dcea;
  color: #1a2a4a;
  padding: 5px 7px;
  font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.3px;
  border: 1px solid #9ab;
  white-space: nowrap;
}
.pt th.pn  { text-align: left; }
.pt th.sz  { text-align: center; min-width: 32px; }
.pt th.tot {
  text-align: right; min-width: 44px;
  background: #c4d8c4; color: #1a3a1a;
}

.pt tbody td {
  padding: 4px 7px;
  border: 1px solid #cdd5dd;
  vertical-align: middle;
}
.row-even td { background: #ffffff; }
.row-odd  td { background: #f3f6f9; }
.pt tbody tr { page-break-inside: avoid; }

.pt td.sz  { text-align: center; }
.pt td.tot {
  text-align: right; font-weight: 600;
  background: #eaf2ea;
  border-left: 1.5px solid #9ab;
}
.row-odd td.tot  { background: #e2ede2; }
.zero { color: #ccc; }

.pn-title  { font-size: 11.5px; font-weight: 600; }
.pn-handle { font-size: 9px; color: #aaa; }

.img-cell { width: 54px; padding: 3px 4px; text-align: center; border: 1px solid #cdd5dd; }
.img-cell img { width: 46px; height: 46px; object-fit: contain; display: block; margin: 0 auto; }

/* footer total row */
.pt tfoot td {
  background: #d0dcea;
  font-weight: 700; font-size: 11px;
  border: 1px solid #9ab;
  border-top: 2px solid #6a8aaa;
  padding: 5px 7px;
}
.pt tfoot .foot-label {
  text-transform: uppercase; letter-spacing: 0.3px;
  font-size: 10px; color: #1a2a4a;
}
.pt tfoot .foot-sz  { text-align: center; }
.pt tfoot td.tot    { background: #c4d8c4; color: #1a3a1a; text-align: right; border-left: 1.5px solid #9ab; }

.empty { color: #999; font-style: italic; padding: 16px 0; font-size: 11px; }
`;
