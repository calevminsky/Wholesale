// Parse an uploaded order file (XLSX or CSV) into canonical rows.
//
// Accepts BOTH:
//   - Legacy headers: product_handle, unit_price, XXS, XS, S, M, L, XL, XXL
//   - Customer-friendly headers: Style, Wholesale (or MSRP fallback), size names
//
// Returns: { items: [{handle, unitPrice, sizeQty:{XXS..XXL}}], lineSheetId, exportToken }
import XLSX from "xlsx";
import path from "path";

const SIZES = ["XXS", "XS", "S", "M", "L", "XL", "XXL"];

const HANDLE_KEYS = ["product_handle", "handle", "style", "style #", "style id", "sku"];
const PRICE_KEYS = ["unit_price", "wholesale", "wholesale price", "price"];

function norm(s) {
  return String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function findKey(row, candidates) {
  const keys = Object.keys(row);
  for (const cand of candidates) {
    const hit = keys.find((k) => norm(k) === cand);
    if (hit) return hit;
  }
  return null;
}

// Locate the header row in a 2D array. Return its index, or -1 if none found.
function findHeaderRow(rows2d) {
  for (let i = 0; i < Math.min(rows2d.length, 50); i++) {
    const row = rows2d[i] || [];
    const cells = row.map(norm);
    const hasHandle = cells.some((c) => HANDLE_KEYS.includes(c));
    const hasSize = SIZES.some((s) => cells.includes(s.toLowerCase()));
    if (hasHandle && hasSize) return i;
  }
  return -1;
}

export function parseOrderUpload(file) {
  const ext = path.extname(file.originalname || "").toLowerCase();
  let rows2d;
  let workbookSubject = "";

  if (ext === ".csv") {
    // Light-weight CSV path: parse to 2D array.
    const text = file.buffer.toString("utf8");
    rows2d = text
      .split(/\r?\n/)
      .filter((l) => l.length > 0)
      .map((line) => splitCsvLine(line));
  } else if (ext === ".xlsx" || ext === ".xls") {
    const wb = XLSX.read(file.buffer, { type: "buffer", cellDates: false });
    workbookSubject = wb.Props?.Subject || "";
    const sheetName = wb.SheetNames[0];
    const sheet = wb.Sheets[sheetName];
    rows2d = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", blankrows: false });
  } else {
    throw new Error("Unsupported file type. Upload CSV or XLSX.");
  }

  const headerIdx = findHeaderRow(rows2d);
  if (headerIdx < 0) {
    throw new Error("Couldn't find a header row. Expected a row with 'Style' (or product_handle) plus size columns (XXS, XS, S, M, L, XL, XXL).");
  }
  const header = (rows2d[headerIdx] || []).map((h) => String(h || "").trim());
  const objects = [];
  for (let i = headerIdx + 1; i < rows2d.length; i++) {
    const row = rows2d[i] || [];
    const obj = {};
    let any = false;
    for (let c = 0; c < header.length; c++) {
      const key = header[c];
      if (!key) continue;
      const v = row[c];
      if (v !== undefined && v !== "") any = true;
      obj[key] = v;
    }
    if (any) objects.push(obj);
  }

  const items = [];
  for (const row of objects) {
    const hKey = findKey(row, HANDLE_KEYS);
    if (!hKey) continue;
    const handle = String(row[hKey] || "").trim();
    if (!handle) continue;
    // Skip totals/summary rows that have a label in a non-handle cell but no
    // valid handle — already filtered by !handle, but also skip rows where the
    // "handle" looks like a totals label.
    if (/^total\b/i.test(handle)) continue;

    const pKey = findKey(row, PRICE_KEYS);
    const rawPrice = pKey ? row[pKey] : 0;
    const unitPrice = Number(String(rawPrice ?? "").replace(/[^0-9.\-]/g, ""));
    if (!Number.isFinite(unitPrice)) {
      throw new Error(`Invalid price for ${handle}: ${rawPrice}`);
    }

    const sizeQty = {};
    let totalQty = 0;
    for (const s of SIZES) {
      // Try exact match (case-insensitive) on size column.
      const k = Object.keys(row).find((x) => norm(x) === s.toLowerCase());
      const n = k ? Number(String(row[k] ?? "").replace(/[^0-9.\-]/g, "")) : 0;
      const q = Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
      sizeQty[s] = q;
      totalQty += q;
    }

    if (totalQty === 0) continue; // no quantities ordered — skip
    items.push({ handle, unitPrice, sizeQty });
  }

  // Detect line sheet ID embedded by buildOrderFormXlsx (workbook subject).
  let lineSheetId = null;
  const m = String(workbookSubject || "").match(/line_sheet_id:(\d+)/);
  if (m) lineSheetId = Number(m[1]);

  // Detect export token. Prefer the workbook subject (resists cell edits);
  // fall back to scanning the first ~10 rows for "Reference: TOKEN" — needed
  // because Google Sheets round-trips strip xlsx custom properties.
  let exportToken = null;
  const tm = String(workbookSubject || "").match(/export_token:([A-Z0-9]{6,16})/i);
  if (tm) exportToken = tm[1].toUpperCase();
  if (!exportToken && Array.isArray(rows2d)) {
    for (let i = 0; i < Math.min(rows2d.length, 10); i++) {
      const row = rows2d[i] || [];
      for (const cell of row) {
        const s = String(cell ?? "");
        const cm = s.match(/Reference:\s*([A-Z0-9]{6,16})\b/i);
        if (cm) { exportToken = cm[1].toUpperCase(); break; }
      }
      if (exportToken) break;
    }
  }

  return { items, lineSheetId, exportToken };
}

// Minimal CSV line splitter that handles double-quoted fields.
function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ",") { out.push(cur); cur = ""; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}
