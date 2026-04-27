// CRUD for wholesale_orders (drafts) and wholesale_order_previews (snapshots).
import { query, getPool } from "../pg.js";

const ORDER_COLS = `
  o.id, o.status, o.customer_id, o.line_sheet_id, o.name, o.notes,
  o.location_ids, o.items, o.source_filename,
  o.shopify_order_id, o.shopify_order_name, o.submitted_at,
  o.archived_at, o.created_at, o.updated_at
`;

const ORDER_LIST_COLS = `
  ${ORDER_COLS},
  c.name AS customer_name,
  ls.name AS line_sheet_name,
  (SELECT COUNT(*)::int FROM wholesale_order_previews p WHERE p.order_id = o.id) AS preview_count,
  (SELECT MAX(p.created_at) FROM wholesale_order_previews p WHERE p.order_id = o.id) AS last_preview_at
`;

export async function listOrders({ status, customerId, lineSheetId, search } = {}) {
  const params = [];
  const conds = [`o.archived_at IS NULL`];

  if (status) {
    params.push(status);
    conds.push(`o.status = $${params.length}`);
  }
  if (customerId) {
    params.push(customerId);
    conds.push(`o.customer_id = $${params.length}`);
  }
  if (lineSheetId) {
    params.push(lineSheetId);
    conds.push(`o.line_sheet_id = $${params.length}`);
  }
  if (search && search.trim()) {
    const needle = `%${search.trim().toLowerCase()}%`;
    params.push(needle, needle);
    conds.push(`(LOWER(COALESCE(o.name,'')) LIKE $${params.length - 1}
              OR LOWER(COALESCE(c.name,'')) LIKE $${params.length})`);
  }

  const { rows } = await query(
    `SELECT ${ORDER_LIST_COLS}
       FROM wholesale_orders o
       LEFT JOIN customers c ON c.id = o.customer_id
       LEFT JOIN line_sheets ls ON ls.id = o.line_sheet_id
      WHERE ${conds.join(" AND ")}
      ORDER BY o.updated_at DESC`,
    params
  );
  return rows;
}

export async function getOrder(id) {
  const { rows } = await query(
    `SELECT ${ORDER_LIST_COLS}
       FROM wholesale_orders o
       LEFT JOIN customers c ON c.id = o.customer_id
       LEFT JOIN line_sheets ls ON ls.id = o.line_sheet_id
      WHERE o.id = $1`,
    [id]
  );
  return rows[0] || null;
}

export async function createOrder(payload) {
  const {
    customer_id = null,
    line_sheet_id = null,
    name = null,
    notes = null,
    location_ids = [],
    items = [],
    source_filename = null
  } = payload;

  const { rows } = await query(
    `INSERT INTO wholesale_orders
       (customer_id, line_sheet_id, name, notes, location_ids, items, source_filename)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING ${ORDER_COLS.replace(/o\./g, "")}`,
    [customer_id, line_sheet_id, name, notes, location_ids, JSON.stringify(items), source_filename]
  );
  // Re-fetch with joined columns so the API shape stays consistent.
  return getOrder(rows[0].id);
}

export async function updateOrder(id, payload) {
  const params = [id];
  const fields = [];
  const set = (col, val, transform) => {
    if (val === undefined) return;
    params.push(transform ? transform(val) : val);
    fields.push(`${col} = $${params.length}`);
  };
  set("customer_id", payload.customer_id);
  set("line_sheet_id", payload.line_sheet_id);
  set("name", payload.name);
  set("notes", payload.notes);
  set("location_ids", payload.location_ids);
  set("items", payload.items, (v) => JSON.stringify(v));
  set("source_filename", payload.source_filename);

  // Edits to a previewed order revert it to draft and mark snapshots stale.
  // Submitted orders are read-only here.
  const itemsOrLocsChanged = payload.items !== undefined || payload.location_ids !== undefined;

  if (fields.length === 0) return getOrder(id);
  fields.push(`updated_at = NOW()`);

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `UPDATE wholesale_orders
          SET ${fields.join(", ")}
        WHERE id = $1
          AND archived_at IS NULL
          AND status IN ('draft','previewed')
        RETURNING id, status`,
      params
    );
    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return null;
    }
    if (itemsOrLocsChanged && rows[0].status === "previewed") {
      await client.query(
        `UPDATE wholesale_orders SET status = 'draft' WHERE id = $1`,
        [id]
      );
      await client.query(
        `UPDATE wholesale_order_previews SET is_stale = TRUE WHERE order_id = $1`,
        [id]
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return getOrder(id);
}

export async function archiveOrder(id) {
  const { rowCount } = await query(
    `UPDATE wholesale_orders SET archived_at = NOW()
      WHERE id = $1 AND archived_at IS NULL`,
    [id]
  );
  return rowCount > 0;
}

export async function duplicateOrder(id) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: src } = await client.query(
      `SELECT customer_id, line_sheet_id, name, notes, location_ids, items, source_filename
         FROM wholesale_orders WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (src.length === 0) {
      await client.query("ROLLBACK");
      return null;
    }
    const s = src[0];
    const { rows } = await client.query(
      `INSERT INTO wholesale_orders
         (customer_id, line_sheet_id, name, notes, location_ids, items, source_filename)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id`,
      [
        s.customer_id,
        s.line_sheet_id,
        s.name ? `${s.name} (copy)` : null,
        s.notes,
        s.location_ids,
        s.items,
        s.source_filename
      ]
    );
    await client.query("COMMIT");
    return getOrder(rows[0].id);
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// ---------- preview snapshots ----------

export async function savePreviewSnapshot(orderId, snapshot) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rowCount } = await client.query(
      `UPDATE wholesale_orders
          SET status = 'previewed', updated_at = NOW()
        WHERE id = $1 AND archived_at IS NULL
          AND status IN ('draft','previewed')`,
      [orderId]
    );
    if (rowCount === 0) {
      await client.query("ROLLBACK");
      return null;
    }
    // Mark older snapshots stale; the newest is the current "promised availability".
    await client.query(
      `UPDATE wholesale_order_previews SET is_stale = TRUE WHERE order_id = $1`,
      [orderId]
    );
    const { rows } = await client.query(
      `INSERT INTO wholesale_order_previews (order_id, snapshot)
       VALUES ($1, $2)
       RETURNING id, order_id, snapshot, is_stale, created_at`,
      [orderId, snapshot]
    );
    await client.query("COMMIT");
    return rows[0];
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function listPreviewSnapshots(orderId) {
  const { rows } = await query(
    `SELECT id, order_id, is_stale, created_at
       FROM wholesale_order_previews
      WHERE order_id = $1
      ORDER BY created_at DESC`,
    [orderId]
  );
  return rows;
}

export async function getPreviewSnapshot(snapshotId) {
  const { rows } = await query(
    `SELECT id, order_id, snapshot, is_stale, created_at
       FROM wholesale_order_previews
      WHERE id = $1`,
    [snapshotId]
  );
  return rows[0] || null;
}

export async function getLatestPreviewSnapshot(orderId) {
  const { rows } = await query(
    `SELECT id, order_id, snapshot, is_stale, created_at
       FROM wholesale_order_previews
      WHERE order_id = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [orderId]
  );
  return rows[0] || null;
}

export async function markSubmitted(orderId, { shopify_order_id, shopify_order_name }) {
  const { rows } = await query(
    `UPDATE wholesale_orders
        SET status = 'submitted',
            shopify_order_id = $2,
            shopify_order_name = $3,
            submitted_at = NOW(),
            updated_at = NOW()
      WHERE id = $1 AND status IN ('draft','previewed')
      RETURNING id`,
    [orderId, shopify_order_id, shopify_order_name || null]
  );
  return rows[0] || null;
}
