// Wholesale line-sheet .xlsx — one clean row per style/color, sortable/filterable.
import ExcelJS from "exceljs";
import { lineSheetRows } from "./linesheet-data.mjs";

export async function lineSheetBuffer(catalog, opts = {}) {
  const rows = lineSheetRows(catalog, opts);

  const wb = new ExcelJS.Workbook();
  wb.creator = "Yakira Bella Wholesale";
  const ws = wb.addWorksheet("Line Sheet", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = [
    { header: "Style", key: "style", width: 34 },
    { header: "Color", key: "color", width: 20 },
    { header: "Type", key: "type", width: 12 },
    { header: "Group", key: "group", width: 10 },
    { header: "Sizes", key: "sizes", width: 10 },
    { header: "MSRP", key: "msrp", width: 10, style: { numFmt: "$#,##0" } },
    { header: "Wholesale", key: "wholesale", width: 11, style: { numFmt: "$#,##0" } },
    { header: "Availability", key: "availability", width: 12 },
    { header: "Est. Delivery", key: "delivery", width: 15 }
  ];
  for (const r of rows) ws.addRow(r);

  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: "FFFFFFFF" } };
  head.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF7C3A2E" } };
  head.alignment = { vertical: "middle" };
  ws.autoFilter = { from: "A1", to: { row: 1, column: ws.columns.length } };

  return wb.xlsx.writeBuffer();
}
