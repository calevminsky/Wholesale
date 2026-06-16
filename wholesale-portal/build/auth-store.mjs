// Email + password auth for the in-season portal, with an admin-managed
// allowlist: only emails an admin has added (each mapped to a customer_id) can
// log in. Buyers cannot self-register.
//
// - Passwords hashed with scrypt (Node built-in; no bcrypt dependency).
// - Sessions are stateless HMAC-signed cookies (SESSION_SECRET) — no session
//   table to maintain. A login resolves to { email, customer_id } which the
//   season routes turn into pricing/entitlements.
//
// Table wholesale_portal_users lives in the same yb_reports Postgres as the
// other portal stores (durable across redeploys).
import pg from "pg";
import crypto from "node:crypto";

let pool = null;
function getPool() {
  if (!pool) {
    const cs = process.env.REPORTING_DATABASE_URL;
    if (!cs) throw new Error("REPORTING_DATABASE_URL is not set");
    const ssl = cs.includes("sslmode=disable") ? false : { rejectUnauthorized: false };
    pool = new pg.Pool({ connectionString: cs, ssl, max: 3, idleTimeoutMillis: 30_000 });
    pool.on("error", (e) => console.error("auth-store pool error:", e.message));
  }
  return pool;
}

let ensured = false;
async function ensureTable() {
  if (ensured) return;
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS wholesale_portal_users (
      email         TEXT PRIMARY KEY,
      customer_id   INTEGER,
      account_name  TEXT,
      password_hash TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_login    TIMESTAMPTZ
    )`);
  ensured = true;
}

const normEmail = (e) => String(e || "").trim().toLowerCase();

// ---- password hashing (scrypt: "scrypt$<salthex>$<hashhex>") ----
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}
export function verifyPassword(pw, stored) {
  try {
    const [scheme, saltHex, hashHex] = String(stored || "").split("$");
    if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
    const expected = Buffer.from(hashHex, "hex");
    const actual = crypto.scryptSync(String(pw), Buffer.from(saltHex, "hex"), expected.length);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// ---- HMAC-signed session cookie ----
export const SESSION_COOKIE = "yb_season_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
function sessionSecret() {
  return process.env.SESSION_SECRET || "";
}
export function sessionConfigured() {
  return !!sessionSecret();
}
export function signSession({ email, customer_id }) {
  const payload = { email: normEmail(email), customer_id: customer_id ?? null, exp: Date.now() + SESSION_TTL_MS };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", sessionSecret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}
export function verifySession(token) {
  if (!sessionSecret()) return null;
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig) return null;
  const expected = crypto.createHmac("sha256", sessionSecret()).update(body).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// ---- user CRUD (admin allowlist) ----
export async function getUserForAuth(email) {
  await ensureTable();
  const r = await getPool().query(
    `SELECT email, customer_id, account_name, password_hash FROM wholesale_portal_users WHERE email = $1`,
    [normEmail(email)]
  );
  return r.rows[0] || null;
}

export async function listUsers() {
  await ensureTable();
  const r = await getPool().query(
    `SELECT email, customer_id, account_name, created_at, last_login FROM wholesale_portal_users ORDER BY account_name, email`
  );
  return r.rows;
}

// Create or update an allowlist entry. Password is optional on update (omit to
// keep the existing one); required when creating a new user.
export async function upsertUser({ email, customer_id, account_name, password }) {
  await ensureTable();
  const e = normEmail(email);
  if (!e || !/.+@.+\..+/.test(e)) throw new Error("A valid email is required.");
  const existing = await getUserForAuth(e);
  if (!existing && !password) throw new Error("A password is required to create a new user.");
  const p = getPool();
  if (password) {
    const hash = hashPassword(password);
    await p.query(
      `INSERT INTO wholesale_portal_users (email, customer_id, account_name, password_hash)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO UPDATE SET
         customer_id = EXCLUDED.customer_id,
         account_name = EXCLUDED.account_name,
         password_hash = EXCLUDED.password_hash`,
      [e, customer_id ?? null, account_name || null, hash]
    );
  } else {
    await p.query(
      `UPDATE wholesale_portal_users SET customer_id = $2, account_name = $3 WHERE email = $1`,
      [e, customer_id ?? null, account_name || null]
    );
  }
  return { email: e, customer_id: customer_id ?? null, account_name: account_name || null };
}

export async function deleteUser(email) {
  await ensureTable();
  await getPool().query(`DELETE FROM wholesale_portal_users WHERE email = $1`, [normEmail(email)]);
}

export async function updateLastLogin(email) {
  try {
    await getPool().query(`UPDATE wholesale_portal_users SET last_login = now() WHERE email = $1`, [normEmail(email)]);
  } catch (e) {
    console.warn("updateLastLogin failed:", e.message);
  }
}
