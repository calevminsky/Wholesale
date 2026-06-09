// Durable product-removal store. Removals live in the yb_reports Postgres (not
// on the ephemeral container disk), so once Emily submits, a style stays removed
// across every redeploy/restart. The buyer catalog is filtered by this list at
// serve time, so removals take effect immediately — no rebuild required.
import pg from "pg";

let pool = null;
function getPool() {
  if (!pool) {
    const cs = process.env.REPORTING_DATABASE_URL;
    if (!cs) throw new Error("REPORTING_DATABASE_URL is not set");
    const ssl = cs.includes("sslmode=disable") ? false : { rejectUnauthorized: false };
    pool = new pg.Pool({ connectionString: cs, ssl, max: 3, idleTimeoutMillis: 30_000 });
    pool.on("error", (e) => console.error("hidden-store pool error:", e.message));
  }
  return pool;
}

let ensured = false;
async function ensureTable() {
  if (ensured) return;
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS wholesale_portal_hidden (
      handle      TEXT PRIMARY KEY,
      title       TEXT,
      removed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  ensured = true;
}

// All removed handles (for filtering the catalog + the build).
export async function getHiddenHandles() {
  await ensureTable();
  const r = await getPool().query(`SELECT handle FROM wholesale_portal_hidden`);
  return r.rows.map((x) => x.handle);
}

// Removed handles + titles, newest first (for the "Currently removed" list).
export async function listHidden() {
  await ensureTable();
  const r = await getPool().query(`SELECT handle, title FROM wholesale_portal_hidden ORDER BY removed_at DESC`);
  return r.rows;
}

export async function addHidden(items) {
  await ensureTable();
  const p = getPool();
  for (const it of items) {
    if (!it?.handle) continue;
    await p.query(
      `INSERT INTO wholesale_portal_hidden (handle, title) VALUES ($1, $2)
       ON CONFLICT (handle) DO UPDATE SET title = EXCLUDED.title`,
      [it.handle, it.title || it.handle]
    );
  }
}

export async function removeHidden(handles) {
  await ensureTable();
  const p = getPool();
  for (const h of handles) await p.query(`DELETE FROM wholesale_portal_hidden WHERE handle = $1`, [h]);
}
