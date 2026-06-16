// Live read of the importer's `customers` table (same yb_reports Postgres the
// portal already uses). The in-season admin maps logins + pricing to these, so
// it must reflect the real, current customer list — not the build-time
// accounts.json snapshot, which only exists for the F26 token links.
import pg from "pg";

let pool = null;
function getPool() {
  if (!pool) {
    const cs = process.env.REPORTING_DATABASE_URL;
    if (!cs) throw new Error("REPORTING_DATABASE_URL is not set");
    const ssl = cs.includes("sslmode=disable") ? false : { rejectUnauthorized: false };
    pool = new pg.Pool({ connectionString: cs, ssl, max: 3, idleTimeoutMillis: 30_000 });
    pool.on("error", (e) => console.error("customers-store pool error:", e.message));
  }
  return pool;
}

// All non-archived customers, alphabetical. price_tier is the importer's account
// type (e.g. "Full Price" / "Off Price"), surfaced as a hint for the admin.
export async function listCustomers() {
  const r = await getPool().query(
    `SELECT id, name, price_tier FROM customers WHERE archived_at IS NULL ORDER BY name`
  );
  return r.rows.map((x) => ({ customer_id: x.id, name: x.name, price_tier: x.price_tier || null }));
}
