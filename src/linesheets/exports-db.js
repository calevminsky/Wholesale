// Per-export snapshot of order-form pricing. Each download of an order-form
// XLSX inserts a row here; the token is stamped into the workbook so an
// uploaded file can be diffed against what we sent.
import crypto from "crypto";
import { query } from "../pg.js";

// Crockford-ish base32 — no I/O/0/1 confusion. 8 chars from 5 bytes.
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

function makeToken() {
  const bytes = crypto.randomBytes(5);
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  for (let i = 0; i < 8; i++) {
    out = ALPHABET[Number(n & 31n)] + out;
    n >>= 5n;
  }
  return out;
}

// Build the [{handle, ppu}] list from a rendered linesheet payload.
// Mirrors the inclusion rules in order-form-xlsx.js so the snapshot lines up
// exactly with the rows the customer sees.
export function buildExportItems(payload) {
  const products = Array.isArray(payload?.products) ? payload.products : [];
  const items = [];
  for (const p of products) {
    if (p.excluded) continue;
    const handle = String(p.handle || "").trim();
    if (!handle) continue;
    const ppu = Number(p.effective_price ?? p.current_price ?? 0);
    if (!Number.isFinite(ppu)) continue;
    items.push({ handle, ppu: Math.round(ppu * 100) / 100 });
  }
  return items;
}

export async function createExport({ lineSheetId, customerId, items }) {
  // Tiny retry loop in the (very rare) case of a token collision.
  for (let attempt = 0; attempt < 4; attempt++) {
    const token = makeToken();
    try {
      const { rows } = await query(
        `INSERT INTO line_sheet_exports (token, line_sheet_id, customer_id, items)
         VALUES ($1, $2, $3, $4)
         RETURNING id, token, line_sheet_id, customer_id, exported_at`,
        [token, lineSheetId ?? null, customerId ?? null, JSON.stringify(items || [])]
      );
      return rows[0];
    } catch (e) {
      // 23505 = unique_violation. Retry with a fresh token.
      if (e?.code !== "23505") throw e;
    }
  }
  throw new Error("Could not allocate a unique export token after retries.");
}

export async function getExportByToken(token) {
  if (!token) return null;
  const { rows } = await query(
    `SELECT id, token, line_sheet_id, customer_id, exported_at, items
       FROM line_sheet_exports
      WHERE token = $1`,
    [String(token)]
  );
  return rows[0] || null;
}
