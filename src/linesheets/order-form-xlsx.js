// Build a customer-facing order-form XLSX from a rendered line sheet payload.
//
// The customer fills in quantity cells and emails the file back. The manager
// uploads it via the wholesale importer, which parses both the friendly headers
// here AND the original developer headers (product_handle / unit_price / size
// columns) so old workflows keep working.
//
// Hidden metadata in row 1 of the data sheet lets the importer link an upload
// back to the originating line sheet.
import ExcelJS from "exceljs";

const SIZES = ["XXS", "XS", "S", "M", "L", "XL", "XXL"];

// Magic marker stored in the workbook's custom properties so the importer can
// detect line-sheet-derived uploads regardless of column reordering.
export const ORDER_FORM_MAGIC = "WHOLESALE_ORDER_FORM_V1";

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

  // ----- Header block -----
  const sheetName = payload.sheet?.name || "Line Sheet";
  const customerName = customer || payload.sheet?.customer_name || payload.sheet?.customer || "";

  ws.getCell("A1").value = sheetName;
  ws.getCell("A1").font = { size: 16, bold: true };
  ws.mergeCells("A1:L1");

  ws.getCell("A2").value = customerName ? `Customer: ${customerName}` : "Fill in quantities below and email this file back.";
  ws.mergeCells("A2:L2");

  ws.getCell("A3").value = `Generated ${new Date().toISOString().slice(0, 10)}`;
  ws.getCell("A3").font = { italic: true, color: { argb: "FF666666" } };
  ws.mergeCells("A3:L3");

  ws.getCell("A4").value = "Type quantities into the size columns. Wholesale prices are pre-filled.";
  ws.getCell("A4").font = { italic: true, color: { argb: "FF666666" } };
  ws.mergeCells("A4:L4");

  // ----- Header row (row 6) -----
  // Column A holds the Shopify product handle (the importer's product_handle).
  // We label it "Style" for the customer; the importer treats it as the SKU key.
  const headers = ["Style", "Product", "MSRP", "Wholesale", ...SIZES, "Total"];
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
    if (!handle) continue; // can't include products without a handle (importer needs it)

    const msrp = Number(p.compare_at_price || p.current_price || 0);
    const wholesale = Number(p.effective_price ?? p.current_price ?? 0);

    const row = ws.getRow(r);
    row.getCell(1).value = handle;
    row.getCell(2).value = p.style_name || p.title || "";
    row.getCell(3).value = msrp;
    row.getCell(3).numFmt = '"$"#,##0.00';
    row.getCell(4).value = wholesale;
    row.getCell(4).numFmt = '"$"#,##0.00';

    // Size cells: blank, ready for the customer to type
    for (let i = 0; i < SIZES.length; i++) {
      row.getCell(5 + i).value = null;
      row.getCell(5 + i).alignment = { horizontal: "center" };
    }

    // Total: SUM across size cells
    const startCol = colLetter(5);
    const endCol = colLetter(5 + SIZES.length - 1);
    row.getCell(5 + SIZES.length).value = { formula: `SUM(${startCol}${r}:${endCol}${r})` };
    row.getCell(5 + SIZES.length).alignment = { horizontal: "center" };

    r++;
  }

  // ----- Totals row -----
  if (r > 7) {
    const totalsRow = ws.getRow(r);
    totalsRow.getCell(2).value = "Total Units";
    totalsRow.getCell(2).font = { bold: true };
    totalsRow.getCell(2).alignment = { horizontal: "right" };
    for (let i = 0; i < SIZES.length; i++) {
      const col = colLetter(5 + i);
      totalsRow.getCell(5 + i).value = { formula: `SUM(${col}7:${col}${r - 1})` };
      totalsRow.getCell(5 + i).alignment = { horizontal: "center" };
      totalsRow.getCell(5 + i).font = { bold: true };
    }
    const totCol = colLetter(5 + SIZES.length);
    totalsRow.getCell(5 + SIZES.length).value = { formula: `SUM(${totCol}7:${totCol}${r - 1})` };
    totalsRow.getCell(5 + SIZES.length).font = { bold: true };
    totalsRow.getCell(5 + SIZES.length).alignment = { horizontal: "center" };
  }

  // ----- Column widths -----
  ws.getColumn(1).width = 18; // Style (handle)
  ws.getColumn(2).width = 32; // Product
  ws.getColumn(3).width = 10; // MSRP
  ws.getColumn(4).width = 12; // Wholesale
  for (let i = 0; i < SIZES.length; i++) ws.getColumn(5 + i).width = 6;
  ws.getColumn(5 + SIZES.length).width = 8; // Total

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
