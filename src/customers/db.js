// CRUD for customers.
import { query } from "../pg.js";

const BASE_COLS = `
  id, name, email, phone, shipping_address,
  discount_pct_off_msrp, default_location_ids, notes,
  archived_at, created_at, updated_at
`;

export async function listCustomers({ search } = {}) {
  const params = [];
  let where = `archived_at IS NULL`;
  if (search && search.trim()) {
    const needle = `%${search.trim().toLowerCase()}%`;
    params.push(needle, needle);
    where += ` AND (LOWER(name) LIKE $${params.length - 1} OR LOWER(COALESCE(email,'')) LIKE $${params.length})`;
  }
  const { rows } = await query(
    `SELECT ${BASE_COLS}
       FROM customers
      WHERE ${where}
      ORDER BY updated_at DESC`,
    params
  );
  return rows;
}

export async function getCustomer(id) {
  const { rows } = await query(
    `SELECT ${BASE_COLS} FROM customers WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

export async function createCustomer(payload) {
  const {
    name,
    email = null,
    phone = null,
    shipping_address = {},
    discount_pct_off_msrp = null,
    default_location_ids = [],
    notes = null
  } = payload;

  if (!name || !String(name).trim()) {
    throw new Error("name is required");
  }

  const { rows } = await query(
    `INSERT INTO customers (name, email, phone, shipping_address,
                            discount_pct_off_msrp, default_location_ids, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING ${BASE_COLS}`,
    [
      String(name).trim(),
      email,
      phone,
      shipping_address,
      discount_pct_off_msrp,
      default_location_ids,
      notes
    ]
  );
  return rows[0];
}

export async function updateCustomer(id, payload) {
  const params = [id];
  const fields = [];
  const set = (col, val) => {
    if (val === undefined) return;
    params.push(val);
    fields.push(`${col} = $${params.length}`);
  };
  set("name", payload.name);
  set("email", payload.email);
  set("phone", payload.phone);
  set("shipping_address", payload.shipping_address);
  set("discount_pct_off_msrp", payload.discount_pct_off_msrp);
  set("default_location_ids", payload.default_location_ids);
  set("notes", payload.notes);

  if (fields.length === 0) return getCustomer(id);
  fields.push(`updated_at = NOW()`);

  const { rows } = await query(
    `UPDATE customers SET ${fields.join(", ")}
      WHERE id = $1 AND archived_at IS NULL
      RETURNING ${BASE_COLS}`,
    params
  );
  return rows[0] || null;
}

export async function archiveCustomer(id) {
  const { rowCount } = await query(
    `UPDATE customers SET archived_at = NOW()
      WHERE id = $1 AND archived_at IS NULL`,
    [id]
  );
  return rowCount > 0;
}
