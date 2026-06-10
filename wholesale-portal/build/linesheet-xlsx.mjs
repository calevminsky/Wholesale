// Generates a standard wholesale line-sheet .xlsx from the catalog: one row per
// style/color, with MSRP, wholesale, est. delivery, group, and the size run
// (on-hand qty for in-stock, "x" for pre-order sizes offered).
import ExcelJS from "exceljs";

const SIZE_CORE = ["XXS", "XS", "S", "M", "L", "XL", "XXL"];

export async function lineSheetBuffer(catalog, { defaultLeadDays = 14 } = {}) {
  const products = (catalog.products || [])
    .filter((p) => p.tier !== "off")
    .sort((a, b) => (a.title || "").localeCompare(b.title || ""));
  const hasOS = products.some((p) => p.sizes.some((s) => s.size === "OS"));
  const sizes = hasOS ? [...SIZE_CORE, "OS"] : SIZE_CORE;

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const fmt = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const deliv = (p) => {
    if (p.est_delivery) { const d = new Date(p.est_delivery + "T00:00:00"); return isNaN(d) ? "TBD" : fmt(d); }
    if (!p.preorder) { const d = new Date(today); d.setDate(d.getDate() + defaultLeadDays); return fmt(d); }
    return "TBD";
  };

  const wb = new ExcelJS.Workbook();
  wb.creator = "Yakira Bella Wholesale";
  const ws = wb.addWorksheet("Line Sheet", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = [
    { header: "Style", key: "style", width: 32 },
    { header: "Color", key: "color", width: 18 },
    { header: "Type", key: "type", width: 12 },
    { header: "Group", key: "group", width: 10 },
    { header: "Availability", key: "avail", width: 12 },
    { header: "MSRP", key: "msrp", width: 10, style: { numFmt: "$#,##0" } },
    { header: "Wholesale", key: "ws", width: 11, style: { numFmt: "$#,##0" } },
    { header: "Est. Delivery", key: "deliv", width: 15 },
    ...sizes.map((s) => ({ header: s, key: "sz_" + s, width: 6, style: { alignment: { horizontal: "center" } } }))
  ];

  for (const p of products) {
    const bySize = {};
    for (const s of p.sizes) bySize[s.size] = s;
    const row = {
      style: p.title || "",
      color: p.color || "",
      type: p.type || "",
      group: (p.class || "").toLowerCase() === "core" ? "Core" : "Non-Core",
      avail: p.preorder ? "Pre-order" : "In stock",
      msrp: Math.max(p.compare_at || 0, p.retail_price || 0) || null,
      ws: Number.isFinite(p.wholesale_price) ? p.wholesale_price : null,
      deliv: deliv(p)
    };
    for (const s of sizes) {
      const cell = bySize[s];
      row["sz_" + s] = cell ? (p.preorder ? "x" : (Number(cell.available) || 0)) : "";
    }
    ws.addRow(row);
  }

  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: "FFFFFFFF" } };
  head.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF7C3A2E" } };
  head.alignment = { vertical: "middle" };
  ws.autoFilter = { from: "A1", to: { row: 1, column: ws.columns.length } };

  return wb.xlsx.writeBuffer();
}
