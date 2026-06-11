// Durable admin settings in Postgres — survives every Render redeploy.
// Use this for any config the admin edits at runtime (ETA overrides, etc.)
// so that a git commit can never accidentally wipe the data.
import pg from "pg";

let pool = null;
function getPool() {
  if (!pool) {
    const cs = process.env.REPORTING_DATABASE_URL;
    if (!cs) throw new Error("REPORTING_DATABASE_URL is not set");
    pool = new pg.Pool({ connectionString: cs });
  }
  return pool;
}

const INIT_SQL = `
  CREATE TABLE IF NOT EXISTS wholesale_portal_settings (
    key  TEXT PRIMARY KEY,
    value JSONB NOT NULL DEFAULT '{}'
  )`;

export async function initAdminSettings(seeds = {}) {
  const db = getPool();
  await db.query(INIT_SQL);
  for (const [key, value] of Object.entries(seeds)) {
    if (value && Object.keys(value).length > 0) {
      await db.query(
        `INSERT INTO wholesale_portal_settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO NOTHING`,
        [key, value]
      );
    }
  }
}

export async function getAdminSetting(key) {
  const { rows } = await getPool().query(
    `SELECT value FROM wholesale_portal_settings WHERE key = $1`,
    [key]
  );
  return rows.length ? rows[0].value : null;
}

export async function setAdminSetting(key, value) {
  await getPool().query(
    `INSERT INTO wholesale_portal_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value]
  );
}
