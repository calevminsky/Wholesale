// Fetch a product image (remote Shopify URL or local pre-order file) and return
// a small JPEG thumbnail buffer for embedding in the Excel line sheet.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function rawBytes(image, shopifyWidth) {
  try {
    if (/^https?:\/\//.test(image)) {
      const u = /cdn\.shopify\.com/.test(image) ? image + (image.includes("?") ? "&" : "?") + "width=" + shopifyWidth : image;
      const res = await fetch(u);
      if (!res.ok) return null;
      return Buffer.from(await res.arrayBuffer());
    }
    const p = path.resolve(ROOT, image);
    if (fs.existsSync(p)) return fs.readFileSync(p);
  } catch { /* skip */ }
  return null;
}

export async function thumbJpeg(image, width = 150) {
  const raw = await rawBytes(image, Math.max(width * 2, 300));
  if (!raw) return null;
  try { return await sharp(raw).rotate().resize({ width, withoutEnlargement: true }).jpeg({ quality: 72 }).toBuffer(); }
  catch { return null; }
}
