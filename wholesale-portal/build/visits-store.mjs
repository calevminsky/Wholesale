// Lead capture: every visitor who enters via the public gate (company + email)
// is recorded in Postgres, deduped by email (visit count + last seen). Durable,
// so it survives redeploys. Shown on the admin page.
import pg from "pg";

let pool = null;
function getPool() {
  if (!pool) {
    const cs = process.env.REPORTING_DATABASE_URL;
    if (!cs) throw new Error("REPORTING_DATABASE_URL is not set");
    const ssl = cs.includes("sslmode=disable") ? false : { rejectUnauthorized: false };
    pool = new pg.Pool({ connectionString: cs, ssl, max: 3, idleTimeoutMillis: 30_000 });
    pool.on("error", (e) => console.error("visits-store pool error:", e.message));
  }
  return pool;
}

let ensured = false;
async function ensureTable() {
  if (ensured) return;
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS wholesale_portal_visits (
      email       TEXT PRIMARY KEY,
      company     TEXT,
      first_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
      visits      INTEGER NOT NULL DEFAULT 1
    )`);
  ensured = true;
}

export async function logVisit(company, email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e) return;
  await ensureTable();
  await getPool().query(
    `INSERT INTO wholesale_portal_visits (email, company) VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET company = EXCLUDED.company, last_seen = now(),
       visits = wholesale_portal_visits.visits + 1`,
    [e, String(company || "").trim()]
  );
}

export async function listVisits() {
  await ensureTable();
  const r = await getPool().query(
    `SELECT email, company, first_seen, last_seen, visits FROM wholesale_portal_visits ORDER BY last_seen DESC`
  );
  return r.rows;
}
