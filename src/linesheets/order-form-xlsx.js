// Build a customer-facing order-form XLSX from a rendered line sheet payload.
//
// The customer fills in size-column quantities and emails the file back. The
// manager uploads it via the wholesale importer, which parses the same
// columns we write here:
//   Handle | Product | Price | XXS | XS | S | M | L | XL | XXL | Total | Total Cost
//
// Hidden metadata in the workbook subject lets the importer link the upload
// back to the originating line sheet without requiring the user to pick it
// from a dropdown.
import ExcelJS from "exceljs";

const SIZES = ["XXS", "XS", "S", "M", "L", "XL", "XXL"];

// Magic marker stored in the workbook's custom properties so the importer can
// detect line-sheet-derived uploads regardless of column reordering.
export const ORDER_FORM_MAGIC = "WHOLESALE_ORDER_FORM_V1";

const COLS = {
  handle:    1,
  product:   2,
  price:     3,
  firstSize: 4,
  total:     4 + SIZES.length,
  totalCost: 5 + SIZES.length
};
const N_COLS = COLS.totalCost;

export async function buildOrderFormXlsx(payload, { customer } = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Wholesale Importer";
  wb.created = new Date();

  // Custom workbook properties — survive cell edits, used by importer to
  // recognize the file came from us.
  wb.company = ORDER_FORM_MAGIC;
  if (payload.sheet?.id) wb.subject = `line_sheet_id:${payload.sheet.id}`;

  const ws = wb.addWorksheet("Order Form", {
    views: [{ state: "frozen", ySplit: 6 }]
  });

  // ----- Header block (rows 1-4) -----
  const sheetName = payload.sheet?.name || "Line Sheet";
  const customerName = customer || payload.sheet?.customer_name || payload.sheet?.customer || "";
  const lastColLetter = colLetter(N_COLS);

  ws.getCell("A1").value = sheetName;
  ws.getCell("A1").font = { size: 16, bold: true };
  ws.mergeCells(`A1:${lastColLetter}1`);

  ws.getCell("A2").value = customerName ? `Customer: ${customerName}` : "Fill in quantities below and email this file back.";
  ws.mergeCells(`A2:${lastColLetter}2`);

  ws.getCell("A3").value = `Generated ${new Date().toISOString().slice(0, 10)}`;
  ws.getCell("A3").font = { italic: true, color: { argb: "FF666666" } };
  ws.mergeCells(`A3:${lastColLetter}3`);

  ws.getCell("A4").value = "Type quantities into the size columns. Prices are pre-filled.";
  ws.getCell("A4").font = { italic: true, color: { argb: "FF666666" } };
  ws.mergeCells(`A4:${lastColLetter}4`);

  // ----- Header row (row 6) -----
  const headers = ["Handle", "Product", "Price", ...SIZES, "Total", "Total Cost"];
  const headerRow = ws.getRow(6);
  headers.forEach((h, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = h;
    cell.font = { bold: true };
    cell.alignment = { horizontal: i >= 2 ? "center" : "left" };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFEFEF" } };
    cell.border = { bottom: { style: "thin", color: { argb: "FF999999" } } };
  });
  headerRow.height = 22;

  // ----- Body rows -----
  const products = Array.isArray(payload.products) ? payload.products : [];
  let r = 7;
  for (const p of products) {
    if (p.excluded) continue;
    const handle = String(p.handle || "").trim();
    if (!handle) continue; // importer needs the handle

    // Full product name = title (which already includes style + color in
    // Shopify), falling back to style_name only if title is missing.
    const productName = (p.title || p.style_name || "").trim();
    const price = Number(p.effective_price ?? p.current_price ?? 0);

    const row = ws.getRow(r);
    row.getCell(COLS.handle).value = handle;
    row.getCell(COLS.product).value = productName;
    row.getCell(COLS.price).value = price;
    row.getCell(COLS.price).numFmt = '"$"#,##0.00';

    // Size cells: blank, ready for the customer to type
    for (let i = 0; i < SIZES.length; i++) {
      const c = row.getCell(COLS.firstSize + i);
      c.value = null;
      c.alignment = { horizontal: "center" };
    }

    // Total = sum of size cells
    const sizeStart = colLetter(COLS.firstSize);
    const sizeEnd = colLetter(COLS.firstSize + SIZES.length - 1);
    row.getCell(COLS.total).value = { formula: `SUM(${sizeStart}${r}:${sizeEnd}${r})` };
    row.getCell(COLS.total).alignment = { horizontal: "center" };

    // Total Cost = price × total
    const priceCol = colLetter(COLS.price);
    const totalCol = colLetter(COLS.total);
    row.getCell(COLS.totalCost).value = { formula: `${priceCol}${r}*${totalCol}${r}` };
    row.getCell(COLS.totalCost).numFmt = '"$"#,##0.00';
    row.getCell(COLS.totalCost).alignment = { horizontal: "right" };

    r++;
  }

  // ----- Footer totals row -----
  if (r > 7) {
    const totalsRow = ws.getRow(r);
    totalsRow.getCell(COLS.product).value = "Totals";
    totalsRow.getCell(COLS.product).font = { bold: true };
    totalsRow.getCell(COLS.product).alignment = { horizontal: "right" };
    for (let i = 0; i < SIZES.length; i++) {
      const c = colLetter(COLS.firstSize + i);
      const cell = totalsRow.getCell(COLS.firstSize + i);
      cell.value = { formula: `SUM(${c}7:${c}${r - 1})` };
      cell.alignment = { horizontal: "center" };
      cell.font = { bold: true };
    }
    const totC = colLetter(COLS.total);
    totalsRow.getCell(COLS.total).value = { formula: `SUM(${totC}7:${totC}${r - 1})` };
    totalsRow.getCell(COLS.total).font = { bold: true };
    totalsRow.getCell(COLS.total).alignment = { horizontal: "center" };

    const tcCol = colLetter(COLS.totalCost);
    totalsRow.getCell(COLS.totalCost).value = { formula: `SUM(${tcCol}7:${tcCol}${r - 1})` };
    totalsRow.getCell(COLS.totalCost).numFmt = '"$"#,##0.00';
    totalsRow.getCell(COLS.totalCost).font = { bold: true };
    totalsRow.getCell(COLS.totalCost).alignment = { horizontal: "right" };
  }

  // ----- Column widths -----
  ws.getColumn(COLS.handle).width  = 18;
  ws.getColumn(COLS.product).width = 36;
  ws.getColumn(COLS.price).width   = 10;
  for (let i = 0; i < SIZES.length; i++) ws.getColumn(COLS.firstSize + i).width = 6;
  ws.getColumn(COLS.total).width     = 8;
  ws.getColumn(COLS.totalCost).width = 12;

  return wb.xlsx.writeBuffer();
}

function colLetter(idx /* 1-based */) {
  let n = idx;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
