// CRUD for customers.
import { query } from "../pg.js";

const BASE_COLS = `
  id, name, email, phone, shopify_id, shipping_address,
  discount_pct_off_msrp, default_location_ids, notes,
  price_tier, yb_print_label,
  archived_at, created_at, updated_at
`;

export async function listCustomers({ search } = {}) {
  const params = [];
  let where = `c.archived_at IS NULL`;
  if (search && search.trim()) {
    const needle = `%${search.trim().toLowerCase()}%`;
    params.push(needle, needle);
    where += ` AND (LOWER(c.name) LIKE $${params.length - 1} OR LOWER(COALESCE(c.email,'')) LIKE $${params.length})`;
  }
  const cols = BASE_COLS.split(",").map((s) => "c." + s.trim()).join(", ");
  const { rows } = await query(
    `SELECT ${cols},
            (SELECT to_jsonb(ct) FROM (
               SELECT id, name, role, email, phone
                 FROM contacts
                WHERE customer_id = c.id AND is_primary AND archived_at IS NULL
                LIMIT 1
             ) ct) AS primary_contact
       FROM customers c
      WHERE ${where}
      ORDER BY c.updated_at DESC`,
    params
  );
  return rows;
}

export async function findByShopifyId(shopifyId) {
  if (!shopifyId) return null;
  const { rows } = await query(
    `SELECT ${BASE_COLS} FROM customers
      WHERE shopify_id = $1 AND archived_at IS NULL
      LIMIT 1`,
    [shopifyId]
  );
  return rows[0] || null;
}

export async function findByEmail(email) {
  if (!email) return null;
  const { rows } = await query(
    `SELECT ${BASE_COLS} FROM customers
      WHERE LOWER(email) = LOWER($1) AND archived_at IS NULL
      LIMIT 1`,
    [email]
  );
  return rows[0] || null;
}

export async function getCustomer(id) {
  const { rows } = await query(
    `SELECT ${BASE_COLS} FROM customers WHERE id = $1`,
    [id]
  );
  const customer = rows[0] || null;
  if (customer) customer.contacts = await listContacts(id);
  return customer;
}

export async function createCustomer(payload) {
  const {
    name,
    email = null,
    phone = null,
    shopify_id = null,
    shipping_address = {},
    discount_pct_off_msrp = null,
    default_location_ids = [],
    notes = null,
    price_tier = null,
    yb_print_label = null
  } = payload;

  if (!name || !String(name).trim()) {
    throw new Error("name is required");
  }

  const { rows } = await query(
    `INSERT INTO customers (name, email, phone, shopify_id, shipping_address,
                            discount_pct_off_msrp, default_location_ids, notes,
                            price_tier, yb_print_label)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING ${BASE_COLS}`,
    [
      String(name).trim(),
      email,
      phone,
      shopify_id,
      shipping_address,
      discount_pct_off_msrp,
      default_location_ids,
      notes,
      price_tier,
      yb_print_label
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
  set("shopify_id", payload.shopify_id);
  set("shipping_address", payload.shipping_address);
  set("discount_pct_off_msrp", payload.discount_pct_off_msrp);
  set("default_location_ids", payload.default_location_ids);
  set("notes", payload.notes);
  set("price_tier", payload.price_tier);
  set("yb_print_label", payload.yb_print_label);

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

// ---------- contacts ----------

const CONTACT_COLS = `
  id, customer_id, name, role, email, phone, is_primary, notes,
  archived_at, created_at, updated_at
`;

export async function listContacts(customerId) {
  const { rows } = await query(
    `SELECT ${CONTACT_COLS} FROM contacts
      WHERE customer_id = $1 AND archived_at IS NULL
      ORDER BY is_primary DESC, name ASC`,
    [customerId]
  );
  return rows;
}

export async function createContact(customerId, payload) {
  const {
    name,
    role = null,
    email = null,
    phone = null,
    is_primary = false,
    notes = null
  } = payload;

  if (!name || !String(name).trim()) {
    throw new Error("contact name is required");
  }

  // Only one primary per customer — demote any existing primary first.
  if (is_primary) await clearPrimary(customerId);

  const { rows } = await query(
    `INSERT INTO contacts (customer_id, name, role, email, phone, is_primary, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING ${CONTACT_COLS}`,
    [customerId, String(name).trim(), role, email, phone, Boolean(is_primary), notes]
  );
  return rows[0];
}

export async function updateContact(contactId, payload) {
  const current = await getContact(contactId);
  if (!current) return null;

  if (payload.is_primary === true && !current.is_primary) {
    await clearPrimary(current.customer_id);
  }

  const params = [contactId];
  const fields = [];
  const set = (col, val) => {
    if (val === undefined) return;
    params.push(val);
    fields.push(`${col} = $${params.length}`);
  };
  set("name", payload.name);
  set("role", payload.role);
  set("email", payload.email);
  set("phone", payload.phone);
  set("is_primary", payload.is_primary);
  set("notes", payload.notes);

  if (fields.length === 0) return current;
  fields.push(`updated_at = NOW()`);

  const { rows } = await query(
    `UPDATE contacts SET ${fields.join(", ")}
      WHERE id = $1 AND archived_at IS NULL
      RETURNING ${CONTACT_COLS}`,
    params
  );
  return rows[0] || null;
}

export async function archiveContact(contactId) {
  const { rowCount } = await query(
    `UPDATE contacts SET archived_at = NOW()
      WHERE id = $1 AND archived_at IS NULL`,
    [contactId]
  );
  return rowCount > 0;
}

export async function getContact(contactId) {
  const { rows } = await query(
    `SELECT ${CONTACT_COLS} FROM contacts WHERE id = $1`,
    [contactId]
  );
  return rows[0] || null;
}

async function clearPrimary(customerId) {
  await query(
    `UPDATE contacts SET is_primary = FALSE, updated_at = NOW()
      WHERE customer_id = $1 AND is_primary AND archived_at IS NULL`,
    [customerId]
  );
}
