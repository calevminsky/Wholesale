// Persistent order log: every submitted wholesale order is saved to Postgres
// so it's durable across redeploys and visible in the admin as a backup.
import pg from "pg";
import { orderCSV } from "./orderfile.mjs";

let pool = null;
function getPool() {
  if (!pool) {
    const cs = process.env.REPORTING_DATABASE_URL;
    if (!cs) throw new Error("REPORTING_DATABASE_URL is not set");
    const ssl = cs.includes("sslmode=disable") ? false : { rejectUnauthorized: false };
    pool = new pg.Pool({ connectionString: cs, ssl, max: 3, idleTimeoutMillis: 30_000 });
    pool.on("error", (e) => console.error("orders-store pool error:", e.message));
  }
  return pool;
}

let ensured = false;
async function ensureTable() {
  if (ensured) return;
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS wholesale_portal_orders (
      id           SERIAL PRIMARY KEY,
      ref          TEXT NOT NULL,
      account_name TEXT NOT NULL,
      buyer_email  TEXT,
      units        INTEGER NOT NULL DEFAULT 0,
      subtotal     NUMERIC(10,2) NOT NULL DEFAULT 0,
      styles       INTEGER NOT NULL DEFAULT 0,
      shipping     TEXT,
      notes        TEXT,
      items        JSONB NOT NULL DEFAULT '[]',
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  ensured = true;
}

export async function saveOrder({ ref, accountName, buyerEmail, units, subtotal, order }) {
  await ensureTable();
  const { rows } = await getPool().query(
    `INSERT INTO wholesale_portal_orders (ref, account_name, buyer_email, units, subtotal, styles, shipping, notes, items)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [
      ref,
      String(accountName || ""),
      String(buyerEmail || "") || null,
      units,
      subtotal,
      order.items.length,
      order.shipping || null,
      order.notes || null,
      JSON.stringify(order.items)
    ]
  );
  return rows[0].id;
}

export async function listOrders() {
  await ensureTable();
  const r = await getPool().query(
    `SELECT id, ref, account_name, buyer_email, units, subtotal, styles, shipping, notes, submitted_at
     FROM wholesale_portal_orders ORDER BY submitted_at DESC LIMIT 200`
  );
  return r.rows;
}

export async function getOrderCsv(id) {
  await ensureTable();
  const r = await getPool().query(
    `SELECT ref, items FROM wholesale_portal_orders WHERE id = $1`,
    [Number(id)]
  );
  if (!r.rows.length) return null;
  const { ref, items } = r.rows[0];
  return { ref, csv: orderCSV({ items }) };
}
