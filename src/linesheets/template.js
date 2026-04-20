// PDF template for a line sheet. Landscape, mirrors the on-screen table.
// Header appears on the first page; footer repeats.

const SIZE_COLS = ["XS", "S", "M", "L", "XL"];

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function money(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return "—";
  return `$${n.toFixed(2)}`;
}

export function buildLineSheetHtml({ sheet, products, groups }) {
  const title = sheet.name || "Line Sheet";
  const customer = sheet.customer || "";
  const opts = sheet.display_opts || {};
  const showMSRP = opts.show_msrp !== false;
  const showInventory = opts.show_inventory !== false;
  const dateStr = new Date().toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "2-digit"
  });

  const header = `
    <div class="header">
      <div class="brand">
        <img src="https://cdn.shopify.com/s/files/1/0079/3998/1409/files/YB_Logo_Text.png?v=1720112556" alt="Yakira Bella">
      </div>
      <div class="meta">
        <div class="title">${escapeHtml(title)}</div>
        ${customer ? `<div class="customer">For: ${escapeHtml(customer)}</div>` : ""}
        <div class="date">${escapeHtml(dateStr)}</div>
      </div>
    </div>
  `;

  const columns = [];
  columns.push({ key: "image", label: "", width: "8%" });
  columns.push({ key: "product", label: "Product", width: "26%" });
  columns.push({ key: "type", label: "Type", width: "8%" });
  if (showMSRP) columns.push({ key: "msrp", label: "MSRP", width: "7%", num: true });
  columns.push({ key: "price", label: "Price", width: "8%", num: true });
  if (showInventory) {
    for (const s of SIZE_COLS) columns.push({ key: `sz_${s}`, label: s, width: "5%", num: true });
    columns.push({ key: "total", label: "Total", width: "7%", num: true });
  }

  function rowHtml(p) {
    const cells = columns.map((col) => {
      if (col.key === "image") {
        return `<td class="img-td">${p.image ? `<img src="${escapeHtml(p.image)}?width=96">` : ""}</td>`;
      }
      if (col.key === "product") {
        const sub = p.style_name && p.style_name !== p.title
          ? `<div class="sub">${escapeHtml(p.style_name)}</div>` : "";
        return `<td class="prod-td"><div>${escapeHtml(p.title || "")}</div>${sub}</td>`;
      }
      if (col.key === "type") return `<td>${escapeHtml(p.product_type || "")}</td>`;
      if (col.key === "msrp") return `<td class="num">${money(p.compare_at_price || p.current_price)}</td>`;
      if (col.key === "price") return `<td class="num">${money(p.effective_price)}</td>`;
      if (col.key === "total") return `<td class="num">${Number(p.inventory_total || 0)}</td>`;
      if (col.key.startsWith("sz_")) {
        const size = col.key.slice(3);
        const qty = Number(p.inventory_by_size?.[size] || 0);
        return `<td class="num${qty === 0 ? " zero" : ""}">${qty || ""}</td>`;
      }
      return "<td></td>";
    }).join("");
    return `<tr>${cells}</tr>`;
  }

  function tableHead() {
    return `<thead><tr>${columns.map(
      (c) => `<th style="width:${c.width}" class="${c.num ? "num" : ""}">${escapeHtml(c.label)}</th>`
    ).join("")}</tr></thead>`;
  }

  const sections = [];
  if (groups && groups.length) {
    for (const g of groups) {
      if (!g.products || g.products.length === 0) continue;
      sections.push(`
        <div class="section">
          <h2 class="group-title">${escapeHtml(g.label || "")}</h2>
          <table class="sheet-tbl">
            ${tableHead()}
            <tbody>${g.products.map(rowHtml).join("")}</tbody>
          </table>
        </div>
      `);
    }
  } else {
    sections.push(`
      <table class="sheet-tbl">
        ${tableHead()}
        <tbody>${products.map(rowHtml).join("")}</tbody>
      </table>
    `);
  }

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    @page { size: Letter landscape; margin: 0.35in 0.35in 0.55in 0.35in; }
    body { margin: 0; padding: 0; font-family: Arial, Helvetica, sans-serif; font-size: 10px; color: #222; }

    .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #000; padding-bottom: 8px; margin-bottom: 10px; }
    .brand img { max-height: 52px; width: auto; }
    .meta { text-align: right; }
    .meta .title { font-size: 18px; font-weight: 700; }
    .meta .customer { font-size: 12px; color: #333; margin-top: 2px; }
    .meta .date { font-size: 10px; color: #666; margin-top: 2px; }

    .sheet-tbl { width: 100%; border-collapse: collapse; }
    .sheet-tbl thead { display: table-header-group; }
    .sheet-tbl th { background: #f3f3f3; border-bottom: 1.5px solid #000; padding: 5px 4px; text-align: left; font-weight: 600; font-size: 10px; }
    .sheet-tbl td { border-bottom: 1px solid #eee; padding: 4px; font-size: 10px; vertical-align: middle; }
    .sheet-tbl .num { text-align: right; }
    .sheet-tbl .zero { color: #bbb; }
    .sheet-tbl tr { page-break-inside: avoid; }

    .img-td { width: 48px; text-align: center; }
    .img-td img { max-width: 44px; max-height: 56px; object-fit: cover; border-radius: 3px; }
    .prod-td { font-weight: 500; }
    .prod-td .sub { color: #666; font-size: 9px; margin-top: 1px; }

    .section { page-break-inside: avoid; margin-top: 12px; }
    .group-title { font-size: 12px; margin: 12px 0 4px 0; border-bottom: 1px solid #aaa; padding-bottom: 2px; }

    .footer { position: fixed; bottom: 0; left: 0; right: 0; text-align: center; font-size: 9px; color: #777; border-top: 1px solid #ccc; padding: 4px 0; }
  </style>
</head>
<body>
  ${header}
  ${sections.join("\n")}
  <div class="footer">${escapeHtml(title)}${customer ? " · " + escapeHtml(customer) : ""} · Prices confidential, subject to change</div>
</body>
</html>`;
}
