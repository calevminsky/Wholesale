// CRUD for saved_filters and line_sheets.
import { query } from "../pg.js";

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

export async function listLineSheets({ search } = {}) {
  const params = [];
  let where = `archived_at IS NULL`;
  if (search && search.trim()) {
    params.push(`%${search.trim().toLowerCase()}%`);
    where += ` AND (LOWER(name) LIKE $${params.length} OR LOWER(COALESCE(customer,'')) LIKE $${params.length})`;
  }
  const { rows } = await query(
    `SELECT ls.id, ls.name, ls.customer, ls.description,
            ls.saved_filter_id, sf.name AS saved_filter_name,
            ls.pins, ls.excludes, ls.pricing, ls.display_opts,
            ls.updated_at, ls.created_at
       FROM line_sheets ls
       LEFT JOIN saved_filters sf ON sf.id = ls.saved_filter_id
      WHERE ${where}
      ORDER BY ls.updated_at DESC`,
    params
  );
  return rows;
}

export async function getLineSheet(id) {
  const { rows } = await query(
    `SELECT ls.*, sf.name AS saved_filter_name
       FROM line_sheets ls
       LEFT JOIN saved_filters sf ON sf.id = ls.saved_filter_id
      WHERE ls.id = $1`,
    [id]
  );
  return rows[0] || null;
}

export async function createLineSheet(payload) {
  const {
    name,
    customer = null,
    description = null,
    filter_tree = { include: [], globals: [] },
    saved_filter_id = null,
    pins = [],
    excludes = [],
    pricing = {},
    display_opts = {}
  } = payload;

  const { rows } = await query(
    `INSERT INTO line_sheets (name, customer, description, filter_tree, saved_filter_id,
                               pins, excludes, pricing, display_opts)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [name, customer, description, filter_tree, saved_filter_id, pins, excludes, pricing, display_opts]
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
  set("description", payload.description);
  set("filter_tree", payload.filter_tree);
  set("saved_filter_id", payload.saved_filter_id);
  set("pins", payload.pins);
  set("excludes", payload.excludes);
  set("pricing", payload.pricing);
  set("display_opts", payload.display_opts);

  if (fields.length === 0) return getLineSheet(id);
  fields.push(`updated_at = NOW()`);

  const { rows } = await query(
    `UPDATE line_sheets SET ${fields.join(", ")} WHERE id = $1 RETURNING *`,
    params
  );
  return rows[0] || null;
}

export async function archiveLineSheet(id) {
  const { rowCount } = await query(
    `UPDATE line_sheets SET archived_at = NOW() WHERE id = $1 AND archived_at IS NULL`,
    [id]
  );
  return rowCount > 0;
}

export async function duplicateLineSheet(id) {
  const src = await getLineSheet(id);
  if (!src) return null;
  const copy = await createLineSheet({
    name: `${src.name} (copy)`,
    customer: src.customer,
    description: src.description,
    filter_tree: src.filter_tree,
    saved_filter_id: src.saved_filter_id,
    pins: src.pins || [],
    excludes: src.excludes || [],
    pricing: src.pricing || {},
    display_opts: src.display_opts || {}
  });
  return copy;
}
