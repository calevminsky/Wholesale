// Shared Postgres connection pool for the reporting DB (line sheets, inventory).
import pg from "pg";

const connectionString = process.env.REPORTING_DATABASE_URL;

let pool = null;
let disabledReason = null;

if (!connectionString) {
  disabledReason = "REPORTING_DATABASE_URL is not set";
} else {
  const ssl = connectionString.includes("sslmode=disable")
    ? false
    : { rejectUnauthorized: false };

  pool = new pg.Pool({
    connectionString,
    ssl,
    max: 8,
    idleTimeoutMillis: 30_000
  });

  pool.on("error", (err) => {
    console.error("Postgres pool error:", err.message);
  });
}

export function getPool() {
  if (!pool) {
    const err = new Error(`Postgres pool unavailable: ${disabledReason}`);
    err.code = "PG_UNAVAILABLE";
    throw err;
  }
  return pool;
}

export function pgAvailable() {
  return Boolean(pool);
}

export async function query(text, params) {
  const p = getPool();
  return p.query(text, params);
}
