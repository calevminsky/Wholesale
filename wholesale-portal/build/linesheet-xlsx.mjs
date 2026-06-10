// Wholesale line-sheet .xlsx — one row per style/color with a product photo.
import ExcelJS from "exceljs";
import { lineSheetRows } from "./linesheet-data.mjs";
import { thumbJpeg } from "./image-fetch.mjs";

export async function lineSheetBuffer(catalog, opts = {}) {
  const rows = lineSheetRows(catalog, opts);

  const wb = new ExcelJS.Workbook();
  wb.creator = "Yakira Bella Wholesale";
  const ws = wb.addWorksheet("Line Sheet", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = [
    { header: "Photo", key: "img", width: 11 },
    { header: "Style", key: "style", width: 34 },
    { header: "Color", key: "color", width: 20 },
    { header: "Type", key: "type", width: 12 },
    { header: "Group", key: "group", width: 10 },
    { header: "MSRP", key: "msrp", width: 10, style: { numFmt: "$#,##0" } },
    { header: "Wholesale", key: "wholesale", width: 11, style: { numFmt: "$#,##0" } },
    { header: "Est. Delivery", key: "delivery", width: 15 }
  ];

  // fetch thumbnails in parallel
  const thumbs = new Array(rows.length).fill(null);
  let i = 0;
  await Promise.all(Array.from({ length: 12 }, async () => {
    while (i < rows.length) { const k = i++; if (rows[k].image) thumbs[k] = await thumbJpeg(rows[k].image, 150); }
  }));

  rows.forEach((r) => {
    const row = ws.addRow({ style: r.style, color: r.color, type: r.type, group: r.group, msrp: r.msrp, wholesale: r.wholesale, delivery: r.delivery });
    row.height = 60; // ~80px, room for the photo
    row.alignment = { vertical: "middle" };
  });

  rows.forEach((r, idx) => {
    const buf = thumbs[idx];
    if (!buf) return;
    const id = wb.addImage({ buffer: buf, extension: "jpeg" });
    const excelRow = idx + 2; // header is row 1
    ws.addImage(id, { tl: { col: 0.1, row: (excelRow - 1) + 0.08 }, ext: { width: 54, height: 72 } });
  });

  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: "FFFFFFFF" } };
  head.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF7C3A2E" } };
  head.alignment = { vertical: "middle" };
  ws.autoFilter = { from: "A1", to: { row: 1, column: ws.columns.length } };

  return wb.xlsx.writeBuffer();
}
