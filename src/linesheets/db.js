// CRUD for saved_filters and line_sheets.
import { query, getPool } from "../pg.js";

// ---------- saved_filters ----------

export async function listSavedFilters() {
  const { rows } = await query(
    `SELECT id, name, description, filter_tree, created_at, updated_at,
            (SELECT COUNT(*)::int FROM line_sheets ls
              WHERE ls.saved_filter_id = sf.id AND ls.archived_at IS NULL) AS line_sheet_count
       FROM saved_filters sf
       ORDER BY updated_at DESC`
  );
  return rows;
}

export async function getSavedFilter(id) {
  const { rows } = await query(
    `SELECT id, name, description, filter_tree, created_at, updated_at
       FROM saved_filters WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

export async function createSavedFilter({ name, description, filter_tree }) {
  const { rows } = await query(
    `INSERT INTO saved_filters (name, description, filter_tree)
     VALUES ($1, $2, $3)
     RETURNING id, name, description, filter_tree, created_at, updated_at`,
    [name, description || null, filter_tree || { include: [], globals: [] }]
  );
  return rows[0];
}

export async function updateSavedFilter(id, { name, description, filter_tree }) {
  const { rows } = await query(
    `UPDATE saved_filters
        SET name = COALESCE($2, name),
            description = COALESCE($3, description),
            filter_tree = COALESCE($4, filter_tree),
            updated_at = NOW()
      WHERE id = $1
      RETURNING id, name, description, filter_tree, created_at, updated_at`,
    [id, name ?? null, description ?? null, filter_tree ?? null]
  );
  return rows[0] || null;
}

export async function deleteSavedFilter(id) {
  const { rowCount } = await query(`DELETE FROM saved_filters WHERE id = $1`, [id]);
  return rowCount > 0;
}

export async function countLineSheetsUsingFilter(id) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM line_sheets WHERE saved_filter_id = $1 AND archived_at IS NULL`,
    [id]
  );
  return rows[0]?.n || 0;
}

// ---------- line_sheets ----------

export async function listLineSheets({ search, customerId } = {}) {
  const params = [];
  const conds = [`ls.archived_at IS NULL`];
  if (search && search.trim()) {
    const needle = `%${search.trim().toLowerCase()}%`;
    params.push(needle, needle, needle);
    conds.push(
      `(LOWER(ls.name) LIKE $${params.length - 2}
        OR LOWER(COALESCE(ls.customer,'')) LIKE $${params.length - 1}
        OR LOWER(COALESCE(c.name,'')) LIKE $${params.length})`
    );
  }
  if (customerId) {
    params.push(customerId);
    conds.push(`ls.customer_id = $${params.length}`);
  }
  const { rows } = await query(
    `SELECT ls.id, ls.name, ls.customer, ls.customer_id, c.name AS customer_name,
            ls.description,
            ls.saved_filter_id, sf.name AS saved_filter_name,
            ls.pins, ls.excludes, ls.pricing, ls.display_opts,
            ls.updated_at, ls.created_at
       FROM line_sheets ls
       LEFT JOIN saved_filters sf ON sf.id = ls.saved_filter_id
       LEFT JOIN customers c ON c.id = ls.customer_id
      WHERE ${conds.join(" AND ")}
      ORDER BY ls.updated_at DESC`,
    params
  );
  return rows;
}

export async function getLineSheet(id) {
  const { rows } = await query(
    `SELECT ls.*, sf.name AS saved_filter_name, c.name AS customer_name
       FROM line_sheets ls
       LEFT JOIN saved_filters sf ON sf.id = ls.saved_filter_id
       LEFT JOIN customers c ON c.id = ls.customer_id
      WHERE ls.id = $1`,
    [id]
  );
  return rows[0] || null;
}

export async function createLineSheet(payload) {
  const {
    name,
    customer = null,
    customer_id = null,
    description = null,
    filter_tree = { include: [], globals: [] },
    saved_filter_id = null,
    pins = [],
    excludes = [],
    pricing = {},
    display_opts = {}
  } = payload;

  const { rows } = await query(
    `INSERT INTO line_sheets (name, customer, customer_id, description, filter_tree, saved_filter_id,
                               pins, excludes, pricing, display_opts)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [name, customer, customer_id, description, filter_tree, saved_filter_id, pins, excludes, pricing, display_opts]
  );
  return rows[0];
}

export async function updateLineSheet(id, payload) {
  const fields = [];
  const params = [id];
  const set = (col, val) => {
    if (val === undefined) return;
    params.push(val);
    fields.push(`${col} = $${params.length}`);
  };
  set("name", payload.name);
  set("customer", payload.customer);
  set("customer_id", payload.customer_id);
  set("description", payload.description);
  set("filter_tree", payload.filter_tree);
  set("saved_filter_id", payload.saved_filter_id);
  set("pins", payload.pins);
  set("excludes", payload.excludes);
  set("pricing", payload.pricing);
  set("display_opts", payload.display_opts);

  if (fields.length === 0) return getLineSheet(id);
  fields.push(`updated_at = NOW()`);

  // If pricing changed, snapshot the previous value into the audit log in the
  // same transaction so we never have a price change without a paired history row.
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    let priceBefore = null;
    if (payload.pricing !== undefined) {
      const { rows: prevRows } = await client.query(
        `SELECT pricing FROM line_sheets WHERE id = $1 FOR UPDATE`,
        [id]
      );
      if (prevRows.length === 0) {
        await client.query("ROLLBACK");
        return null;
      }
      priceBefore = prevRows[0].pricing;
    }

    const { rows } = await client.query(
      `UPDATE line_sheets SET ${fields.join(", ")} WHERE id = $1 RETURNING *`,
      params
    );
    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return null;
    }

    if (payload.pricing !== undefined &&
        JSON.stringify(priceBefore || {}) !== JSON.stringify(payload.pricing || {})) {
      await client.query(
        `INSERT INTO line_sheet_price_history (line_sheet_id, pricing_before, pricing_after)
         VALUES ($1, $2, $3)`,
        [id, priceBefore || {}, payload.pricing]
      );
    }

    await client.query("COMMIT");
    return rows[0];
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function listLineSheetPriceHistory(id) {
  const { rows } = await query(
    `SELECT id, line_sheet_id, pricing_before, pricing_after, changed_at
       FROM line_sheet_price_history
      WHERE line_sheet_id = $1
      ORDER BY changed_at DESC`,
    [id]
  );
  return rows;
}

export async function archiveLineSheet(id) {
  const { rowCount } = await query(
    `UPDATE line_sheets SET archived_at = NOW() WHERE id = $1 AND archived_at IS NULL`,
    [id]
  );
  return rowCount > 0;
}

export async function duplicateLineSheet(id) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: src } = await client.query(
      `SELECT name, customer, customer_id, description, filter_tree, saved_filter_id,
              pins, excludes, pricing, display_opts
         FROM line_sheets
        WHERE id = $1 AND archived_at IS NULL
        FOR UPDATE`,
      [id]
    );
    if (src.length === 0) {
      await client.query("ROLLBACK");
      return null;
    }
    const s = src[0];
    const { rows } = await client.query(
      `INSERT INTO line_sheets (name, customer, customer_id, description, filter_tree,
                                 saved_filter_id, pins, excludes, pricing, display_opts)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        `${s.name} (copy)`,
        s.customer,
        s.customer_id,
        s.description,
        s.filter_tree,
        s.saved_filter_id,
        s.pins || [],
        s.excludes || [],
        s.pricing || {},
        s.display_opts || {}
      ]
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
