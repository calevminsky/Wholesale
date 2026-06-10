// Shared line-sheet rows so the PDF and Excel always show the same thing.
// One row per style/color: name, color, type, group, size range, MSRP,
// wholesale, availability, and estimated delivery.
const SIZE_ORDER = ["XXS", "XS", "S", "M", "L", "XL", "XXL", "OS"];

function sizeRange(sizes) {
  const present = (sizes || []).map((s) => s.size).filter((s) => SIZE_ORDER.includes(s))
    .sort((a, b) => SIZE_ORDER.indexOf(a) - SIZE_ORDER.indexOf(b));
  if (!present.length) return "";
  if (present.length === 1) return present[0];
  return `${present[0]}–${present[present.length - 1]}`;
}

export function lineSheetRows(catalog, { defaultLeadDays = 14 } = {}) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const fmt = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const deliv = (p) => {
    if (p.est_delivery) { const d = new Date(p.est_delivery + "T00:00:00"); return isNaN(d) ? "TBD" : fmt(d); }
    if (!p.preorder) { const d = new Date(today); d.setDate(d.getDate() + defaultLeadDays); return fmt(d); }
    return "TBD";
  };
  return (catalog.products || [])
    .filter((p) => p.tier !== "off")
    .sort((a, b) => (a.type || "").localeCompare(b.type || "") || (a.title || "").localeCompare(b.title || ""))
    .map((p) => ({
      style: p.title || "",
      color: p.color || "",
      type: p.type || "",
      group: (p.class || "").toLowerCase() === "core" ? "Core" : "Non-Core",
      sizes: sizeRange(p.sizes),
      sizeList: (p.sizes || []).map((s) => s.size).filter((s) => SIZE_ORDER.includes(s)).sort((a, b) => SIZE_ORDER.indexOf(a) - SIZE_ORDER.indexOf(b)),
      msrp: Math.max(p.compare_at || 0, p.retail_price || 0) || null,
      wholesale: Number.isFinite(p.wholesale_price) ? p.wholesale_price : null,
      availability: p.preorder ? "Pre-order" : "In stock",
      delivery: deliv(p),
      image: p.image || "",
      preorder: !!p.preorder
    }));
}
