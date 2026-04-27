// PDF template for a line sheet. Portrait layout so images can be larger.
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
  // Default: hide inventory from the customer. `hide_inventory` (new) wins;
  // fall back to legacy `show_inventory` if it's explicitly set.
  const showInventory = opts.hide_inventory !== undefined
    ? !opts.hide_inventory
    : (opts.show_inventory === true);
  const notesByProduct = opts.notes_by_product || {};
  const allProducts = (products && products.length)
    ? products
    : (groups || []).flatMap((g) => g.products || []);
  const showNotes = (opts.show_notes !== false)
    && allProducts.some((p) => (notesByProduct[p.product_id] || "").trim());
  // "Pairs With" surfaces the theme.upsell_list metafield as a
  // comma-separated list of product names so the customer can scan/search
  // the line sheet for them. Only renders when at least one product has it.
  const showPairs = (opts.show_pairs !== false)
    && allProducts.some((p) => Array.isArray(p.upsell_list) && p.upsell_list.length);

  const dateStr = new Date().toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "2-digit"
  });

  const pricing = sheet.pricing || {};
  const additionalPct = Number(pricing.additional_discount_pct) || 0;
  const additionalNote = additionalPct > 0
    ? `<div class="discount-note">All prices reflect an additional ${additionalPct}% off.</div>`
    : "";

  const header = `
    <div class="header">
      <div class="brand">
        <img src="https://cdn.shopify.com/s/files/1/0079/3998/1409/files/YB_Logo_Text.png?v=1720112556" alt="Yakira Bella">
      </div>
      <div class="meta">
        <div class="title">${escapeHtml(title)}</div>
        ${customer ? `<div class="customer">For ${escapeHtml(customer)}</div>` : ""}
        <div class="date">${escapeHtml(dateStr)}</div>
      </div>
    </div>
    ${additionalNote}
  `;

  // Column layout. Portrait has ~7.6in usable width; we trade the size grid
  // for a bigger image when inventory is hidden (the common case).
  const columns = [];
  if (showInventory) {
    columns.push({ key: "image", label: "", width: "12%" });
    columns.push({ key: "product", label: "Product", width: "32%" });
    if (showMSRP) columns.push({ key: "msrp", label: "MSRP", width: "8%", num: true });
    columns.push({ key: "price", label: "Price", width: "12%", num: true });
    if (showPairs) columns.push({ key: "pairs", label: "Pairs With", width: "13%" });
    if (showNotes) columns.push({ key: "notes", label: "Notes", width: "13%" });
    for (const s of SIZE_COLS) columns.push({ key: `sz_${s}`, label: s, width: "4%", num: true });
    columns.push({ key: "total", label: "Total", width: "6%", num: true });
  } else {
    // No inventory grid → image gets ~3x the width.
    const productWidth = (() => {
      let w = 50;
      if (showPairs) w -= 14;
      if (showNotes) w -= 14;
      return w + "%";
    })();
    columns.push({ key: "image", label: "", width: "20%" });
    columns.push({ key: "product", label: "Product", width: productWidth });
    if (showMSRP) columns.push({ key: "msrp", label: "MSRP", width: "9%", num: true });
    columns.push({ key: "price", label: "Price", width: "12%", num: true });
    if (showPairs) columns.push({ key: "pairs", label: "Pairs With", width: "14%" });
    if (showNotes) columns.push({ key: "notes", label: "Notes", width: "14%" });
  }

  function priceCell(p) {
    const wholesale = Number.isFinite(p.base_wholesale_price) ? p.base_wholesale_price : p.effective_price;
    const final = p.effective_price;
    const showStrike = p.additional_discount_applied && Number.isFinite(wholesale) && wholesale !== final;
    if (showStrike) {
      return `<td class="num price-c"><span class="was">${money(wholesale)}</span> <span class="now">${money(final)}</span></td>`;
    }
    return `<td class="num price-c">${money(final)}</td>`;
  }

  function rowHtml(p) {
    const cells = columns.map((col) => {
      if (col.key === "image") {
        // Larger image (?width hint) + larger CSS box. Browsers respect the
        // CSS cap so older 96-wide hints still render fine.
        return `<td class="img-td">${p.image ? `<img src="${escapeHtml(p.image)}?width=240">` : ""}</td>`;
      }
      if (col.key === "product") {
        return `<td class="prod-td"><div>${escapeHtml(p.title || "")}</div></td>`;
      }
      if (col.key === "msrp") return `<td class="num msrp-c">${money(p.compare_at_price || p.current_price)}</td>`;
      if (col.key === "price") return priceCell(p);
      if (col.key === "notes") {
        const note = notesByProduct[p.product_id] || "";
        return `<td class="notes-td">${escapeHtml(note)}</td>`;
      }
      if (col.key === "pairs") {
        const list = Array.isArray(p.upsell_list) ? p.upsell_list : [];
        const text = list.map((u) => u.title).filter(Boolean).join(", ");
        return `<td class="pairs-td">${escapeHtml(text)}</td>`;
      }
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
    @page { size: Letter portrait; margin: 0.4in 0.4in 0.55in 0.4in; }
    body {
      margin: 0; padding: 0;
      font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
      font-size: 10px;
      color: #1a1a1a;
      -webkit-font-smoothing: antialiased;
    }

    .header {
      display: flex; justify-content: space-between; align-items: flex-end;
      border-bottom: 1.5px solid #1a1a1a;
      padding-bottom: 10px;
      margin-bottom: 14px;
    }
    .brand img { max-height: 56px; width: auto; }
    .meta { text-align: right; }
    .meta .title { font-size: 20px; font-weight: 700; letter-spacing: 0.2px; }
    .meta .customer { font-size: 11px; color: #444; margin-top: 3px; letter-spacing: 0.3px; text-transform: uppercase; }
    .meta .date { font-size: 9.5px; color: #888; margin-top: 3px; }

    .discount-note {
      font-size: 10px; font-style: italic; color: #b00020;
      margin: -6px 0 12px; text-align: right;
    }

    .sheet-tbl { width: 100%; border-collapse: collapse; }
    .sheet-tbl thead { display: table-header-group; }
    .sheet-tbl th {
      background: #fafafa;
      border-bottom: 1.5px solid #1a1a1a;
      padding: 6px 5px;
      text-align: left;
      font-weight: 600;
      font-size: 9.5px;
      letter-spacing: 0.3px;
      text-transform: uppercase;
      color: #555;
    }
    .sheet-tbl td {
      border-bottom: 1px solid #eee;
      padding: 8px 5px;
      font-size: 10px;
      vertical-align: middle;
    }
    .sheet-tbl .num { text-align: right; }
    .sheet-tbl .zero { color: #ccc; }
    .sheet-tbl tr { page-break-inside: avoid; }

    .img-td { text-align: center; padding: 6px 4px; }
    .img-td img { max-width: 120px; max-height: 150px; object-fit: cover; border-radius: 3px; }
    .prod-td { font-weight: 500; line-height: 1.35; }

    /* MSRP de-emphasized; price emphasized as the headline number. */
    .sheet-tbl th.msrp-h, .sheet-tbl td.msrp-c { color: #888; }
    .sheet-tbl td.price-c { font-weight: 600; font-size: 11px; }
    .sheet-tbl .num .was {
      color: #aaa;
      text-decoration: line-through;
      margin-right: 4px;
      font-weight: 400;
      font-size: 9.5px;
    }
    .sheet-tbl .num .now { color: #b00020; font-weight: 700; }

    .notes-td { font-size: 9px; color: #555; line-height: 1.35; white-space: pre-wrap; }
    .pairs-td { font-size: 9px; color: #555; line-height: 1.35; }

    .section { page-break-inside: avoid; margin-top: 14px; }
    .group-title {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.5px;
      text-transform: uppercase;
      color: #1a1a1a;
      margin: 16px 0 6px;
      padding-bottom: 4px;
      border-bottom: 1px solid #1a1a1a;
    }
  </style>
</head>
<body>
  ${header}
  ${sections.join("\n")}
</body>
</html>`;
}
