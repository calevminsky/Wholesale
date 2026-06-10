// Wholesale line-sheet PDF, composed with pdf-lib so the embedded images are the
// original compressed JPEGs (not re-rasterized) — keeps the file small and
// predictable. One card per style/color: photo, name, color/sizes, price, ETA.
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lineSheetRows } from "./linesheet-data.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ACCENT = rgb(0.486, 0.227, 0.180);
const INK = rgb(0.129, 0.110, 0.090);
const GRAY = rgb(0.541, 0.506, 0.470);
const OFF = rgb(0.710, 0.380, 0.165);
const money = (n) => "$" + Math.round(n).toLocaleString();

async function imageBytes(image) {
  try {
    if (/^https?:\/\//.test(image)) {
      const u = /cdn\.shopify\.com/.test(image) ? image + (image.includes("?") ? "&" : "?") + "width=400" : image;
      const res = await fetch(u);
      if (!res.ok) return null;
      return new Uint8Array(await res.arrayBuffer());
    }
    const p = path.resolve(ROOT, image); // local pre-order image (data/preorder-img/…)
    if (fs.existsSync(p)) return new Uint8Array(fs.readFileSync(p));
  } catch { /* skip */ }
  return null;
}

async function embed(doc, bytes) {
  if (!bytes || bytes.length < 4) return null;
  const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8;
  try { return isJpg ? await doc.embedJpg(bytes) : await doc.embedPng(bytes); }
  catch { try { return await doc.embedPng(bytes); } catch { return null; } }
}

export async function lineSheetPdf(catalog, opts = {}) {
  const rows = lineSheetRows(catalog, opts);
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  // fetch + embed images with bounded concurrency
  const imgs = new Array(rows.length).fill(null);
  let i = 0;
  await Promise.all(Array.from({ length: 12 }, async () => {
    while (i < rows.length) {
      const k = i++;
      if (rows[k].image) imgs[k] = await embed(doc, await imageBytes(rows[k].image));
    }
  }));

  const PW = 612, PH = 792, M = 36, COLS = 3, GAP = 16, ROWGAP = 16;
  const cellW = (PW - 2 * M - (COLS - 1) * GAP) / COLS;
  const imgH = cellW * 4 / 3;
  const TEXT = 50;
  const cellH = imgH + TEXT;

  const trunc = (s, f, size, max) => {
    s = String(s || "");
    if (f.widthOfTextAtSize(s, size) <= max) return s;
    while (s.length > 1 && f.widthOfTextAtSize(s + "…", size) > max) s = s.slice(0, -1);
    return s + "…";
  };

  let page = null, topY = 0, col = 0, firstPage = true;
  function addPage() {
    page = doc.addPage([PW, PH]);
    let t = PH - M;
    if (firstPage) {
      page.drawText("YAKIRA BELLA · WHOLESALE", { x: M, y: t - 9, size: 8, font: bold, color: GRAY });
      page.drawText(`${catalog.offer || ""} Line Sheet`, { x: M, y: t - 28, size: 16, font: bold, color: INK });
      const ds = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
      page.drawText(`${ds}   ·   ${rows.length} styles`, { x: M, y: t - 42, size: 9, font, color: GRAY });
      page.drawLine({ start: { x: M, y: t - 50 }, end: { x: PW - M, y: t - 50 }, thickness: 1, color: INK });
      t -= 62;
      firstPage = false;
    }
    topY = t; col = 0;
  }
  addPage();

  for (let k = 0; k < rows.length; k++) {
    if (col === 0 && topY - cellH < M) addPage();
    const r = rows[k];
    const cx = M + col * (cellW + GAP);
    const im = imgs[k];
    if (im) {
      let w = cellW, h = cellW * im.height / im.width;
      if (h > imgH) { h = imgH; w = imgH * im.width / im.height; }
      page.drawImage(im, { x: cx + (cellW - w) / 2, y: topY - imgH + (imgH - h) / 2, width: w, height: h });
    }
    let ty = topY - imgH - 11;
    page.drawText(trunc(r.style, bold, 9, cellW), { x: cx, y: ty, size: 9, font: bold, color: INK }); ty -= 11;
    const meta = [r.color, r.sizes].filter(Boolean).join(" · ");
    page.drawText(trunc(meta, font, 7.5, cellW), { x: cx, y: ty, size: 7.5, font, color: GRAY }); ty -= 13;
    if (r.wholesale) {
      page.drawText(money(r.wholesale), { x: cx, y: ty, size: 11, font: bold, color: ACCENT });
      if (r.msrp && r.msrp > r.wholesale + 0.5) {
        const wsW = bold.widthOfTextAtSize(money(r.wholesale), 11);
        page.drawText("MSRP " + money(r.msrp), { x: cx + wsW + 6, y: ty + 1, size: 7, font, color: GRAY });
      }
    } else {
      page.drawText("Price TBD", { x: cx, y: ty, size: 9, font: bold, color: OFF });
    }
    ty -= 11;
    page.drawText(trunc((r.preorder ? "Pre-order · " : "") + "Est. " + r.delivery, font, 6.5, cellW), { x: cx, y: ty, size: 6.5, font, color: GRAY });

    col++;
    if (col >= COLS) { col = 0; topY -= (cellH + ROWGAP); }
  }

  return doc.save();
}
