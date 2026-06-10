// Wholesale line-sheet .xlsx — an order form: one row per style/color with a
// photo and a blank size grid the buyer fills in with quantities and sends back.
import ExcelJS from "exceljs";
import { lineSheetRows } from "./linesheet-data.mjs";
import { thumbJpeg } from "./image-fetch.mjs";

const SIZE_ORDER = ["XXS", "XS", "S", "M", "L", "XL", "XXL", "OS"];

export async function lineSheetBuffer(catalog, opts = {}) {
  const rows = lineSheetRows(catalog, opts);

  // size columns = every size that appears in the offer, in order
  const present = new Set();
  rows.forEach((r) => (r.sizeList || []).forEach((s) => present.add(s)));
  const sizeCols = SIZE_ORDER.filter((s) => present.has(s));

  const wb = new ExcelJS.Workbook();
  wb.creator = "Yakira Bella Wholesale";
  const ws = wb.addWorksheet("Line Sheet", { views: [{ state: "frozen", xSplit: 2, ySplit: 1 }] });
  ws.columns = [
    { header: "Photo", key: "img", width: 11 },
    { header: "Style", key: "style", width: 32 },
    { header: "Color", key: "color", width: 18 },
    { header: "Type", key: "type", width: 11 },
    { header: "Group", key: "group", width: 9 },
    { header: "MSRP", key: "msrp", width: 9, style: { numFmt: "$#,##0" } },
    { header: "Wholesale", key: "wholesale", width: 10, style: { numFmt: "$#,##0" } },
    { header: "Est. Delivery", key: "delivery", width: 14 },
    ...sizeCols.map((s) => ({ header: s, key: "sz_" + s, width: 6, style: { alignment: { horizontal: "center" } } }))
  ];
  const firstSizeCol = 9; // 1-based column index where sizes start (after the 8 info cols)
  const thin = { style: "thin", color: { argb: "FFD8CFC2" } };

  // fetch thumbnails in parallel
  const thumbs = new Array(rows.length).fill(null);
  let i = 0;
  await Promise.all(Array.from({ length: 12 }, async () => {
    while (i < rows.length) { const k = i++; if (rows[k].image) thumbs[k] = await thumbJpeg(rows[k].image, 150); }
  }));

  rows.forEach((r) => {
    const data = { style: r.style, color: r.color, type: r.type, group: r.group, msrp: r.msrp, wholesale: r.wholesale, delivery: r.delivery };
    const offered = new Set(r.sizeList || []);
    sizeCols.forEach((s) => { data["sz_" + s] = offered.has(s) ? null : "–"; }); // blank = orderable, – = not offered
    const row = ws.addRow(data);
    row.height = 60;
    row.alignment = { vertical: "middle" };
    // outline the fillable size grid
    sizeCols.forEach((s, ci) => {
      const cell = row.getCell(firstSizeCol + ci);
      cell.border = { top: thin, left: thin, bottom: thin, right: thin };
      cell.alignment = { horizontal: "center", vertical: "middle" };
      if (!offered.has(s)) cell.font = { color: { argb: "FFB0A89E" } };
    });
  });

  rows.forEach((r, idx) => {
    const buf = thumbs[idx];
    if (!buf) return;
    const id = wb.addImage({ buffer: buf, extension: "jpeg" });
    const excelRow = idx + 2;
    ws.addImage(id, { tl: { col: 0.1, row: (excelRow - 1) + 0.08 }, ext: { width: 54, height: 72 } });
  });

  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: "FFFFFFFF" } };
  head.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF7C3A2E" } };
  head.alignment = { vertical: "middle", horizontal: "left" };
  sizeCols.forEach((s, ci) => { head.getCell(firstSizeCol + ci).alignment = { horizontal: "center", vertical: "middle" }; });
  ws.autoFilter = { from: "A1", to: { row: 1, column: 8 } };

  return wb.xlsx.writeBuffer();
}
