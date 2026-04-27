// Compile a line-sheet filter tree into a parameterized SQL query over the
// existing `inventory_items` + `inventory_levels` tables, and return
// product-level aggregated rows (with per-size inventory breakdown).
//
// Schema expectations:
//   inventory_items(variant_id, product_id, inventory_item_id, variant_title, sku,
//                   product_title, product_type, product_status, product_image,
//                   season, class, style_name, product_group, tags (TEXT JSON),
//                   collections, price, compare_at_price, ...)
//   inventory_levels(inventory_item_id, location_id, location_name, available, ...)
import { query } from "../pg.js";

const SIZE_BUCKETS = ["XXS", "XS", "S", "M", "L", "XL", "XXL"];

// Build a safe parameter counter.
function ctx() {
  return { params: [], push(v) { this.params.push(v); return `$${this.params.length}`; } };
}

function emitCondition(cond, c) {
  const { field, op, value } = cond || {};
  switch (field) {
    case "season":
      return listOp("season", op, value, c);
    case "class":
      return listOp("class", op, value, c);
    case "product_type":
      return listOp("product_type", op, value, c);
    case "product_group":
      if (op === "contains") return `product_group ILIKE ${c.push("%" + String(value) + "%")}`;
      return listOp("product_group", op === "not_in" ? "not_in" : "in", value, c);
    case "style_name":
      if (op === "contains") return `style_name ILIKE ${c.push("%" + String(value) + "%")}`;
      return listOp("style_name", op === "not_in" ? "not_in" : "in", value, c);
    case "title":
      return `product_title ILIKE ${c.push("%" + String(value) + "%")}`;
    case "product":
      if (op === "none_of") return `product_id <> ALL(${c.push(asArr(value))}::text[])`;
      return `product_id = ANY(${c.push(asArr(value))}::text[])`;

    // `linesheet` should already be substituted with `product` by
    // resolveLineSheetReferences before reaching the SQL compiler. Treat any
    // leftover as a no-op so a stale tree never hard-fails the query.
    case "linesheet":
      return "TRUE";

    case "tag": {
      const arr = asArr(value);
      if (op === "has_all") return `tags_json @> ${c.push(JSON.stringify(arr))}::jsonb`;
      if (op === "has_none") return `NOT (tags_json ?| ${c.push(arr)}::text[])`;
      return `tags_json ?| ${c.push(arr)}::text[]`;
    }

    case "length": {
      // Parsed from tags like "Length: 42"
      if (op === "=") return `length_val = ${c.push(Number(value))}`;
      if (op === "in") return `length_val = ANY(${c.push(asArr(value).map(Number))}::int[])`;
      if (op === ">=") return `length_val >= ${c.push(Number(value))}`;
      if (op === "<=") return `length_val <= ${c.push(Number(value))}`;
      return "TRUE";
    }

    case "fabric":
      // KNIT / WOVEN come from tags.
      return tagListOp(["KNIT", "WOVEN"], op, value, c);

    case "sleeve":
      return tagListOp(["Long Sleeve", "Short Sleeve", "Sleeveless"], op, value, c);

    case "price_tier": {
      if (value === "full_price") return `min_price >= min_compare_at`;
      if (value === "off_price") return `min_price <  min_compare_at`;
      return "TRUE";
    }

    case "price": {
      if (op === ">=") return `min_price >= ${c.push(Number(value))}`;
      if (op === "<=") return `min_price <= ${c.push(Number(value))}`;
      if (op === "between") {
        const [lo, hi] = Array.isArray(value) ? value : [0, 0];
        return `min_price BETWEEN ${c.push(Number(lo))} AND ${c.push(Number(hi))}`;
      }
      return "TRUE";
    }

    case "has_inventory":
      return value ? `total_inventory > 0` : `total_inventory = 0`;

    case "has_image":
      return value
        ? `product_image IS NOT NULL AND product_image <> ''`
        : `(product_image IS NULL OR product_image = '')`;

    case "inventory_min": {
      // Handled at global level — pushed down into variant_inv aggregation.
      // Here we express it against product-level aggregate.
      const n = Number(value || 0);
      const locs = Array.isArray(cond.locations) ? cond.locations : null;
      if (locs && locs.length) {
        return `filtered_inventory >= ${c.push(n)}`;
      }
      return `total_inventory >= ${c.push(n)}`;
    }

    default:
      return "TRUE";
  }
}

function listOp(col, op, value, c) {
  const arr = asArr(value);
  if (arr.length === 0) return "TRUE";
  if (op === "not_in") return `${col} <> ALL(${c.push(arr)}::text[])`;
  return `${col} = ANY(${c.push(arr)}::text[])`;
}

function tagListOp(universe, op, value, c) {
  const arr = asArr(value).filter((v) => universe.includes(String(v)));
  if (arr.length === 0) return "TRUE";
  if (op === "not_in") return `NOT (tags_json ?| ${c.push(arr)}::text[])`;
  return `tags_json ?| ${c.push(arr)}::text[]`;
}

function asArr(v) {
  if (Array.isArray(v)) return v.map(String);
  if (v === null || v === undefined || v === "") return [];
  return [String(v)];
}

function emitGroup(group, c) {
  const conds = (group?.conditions || []).map((cn) => emitCondition(cn, c)).filter(Boolean);
  if (conds.length === 0) return "TRUE";
  return `(${conds.join(" AND ")})`;
}

export function compileFilterTree(tree, opts = {}) {
  const c = ctx();
  const include = Array.isArray(tree?.include) ? tree.include : [];
  const globals = Array.isArray(tree?.globals) ? tree.globals : [];

  // Locations drive both:
  //   (a) the filtered_inventory column used by the inventory_min filter
  //       (kept for legacy use), and
  //   (b) when `opts.atsLocations` is set, which locations count toward
  //       the *displayed* inventory totals — i.e. the ATS view.
  // Pick atsLocations first (if any), else the inventory_min.locations fallback.
  let filterLocations = null;
  if (Array.isArray(opts.atsLocations) && opts.atsLocations.length) {
    filterLocations = opts.atsLocations.map(String);
  } else {
    for (const g of globals) {
      if (g?.field === "inventory_min" && Array.isArray(g.locations) && g.locations.length) {
        filterLocations = g.locations.map(String);
        break;
      }
    }
  }
  const useAtsOverride = Array.isArray(opts.atsLocations) && opts.atsLocations.length > 0;
  const filterLocsParam = c.push(filterLocations || []);

  const includeExpr = include.length === 0
    ? "TRUE"
    : `(${include.map((g) => emitGroup(g, c)).join(" OR ")})`;

  const globalExprs = globals.map((g) => emitCondition(g, c)).filter(Boolean);
  const globalExpr = globalExprs.length ? globalExprs.join(" AND ") : "TRUE";

  // Notes on the defensive bits below:
  //  * tags_json: guard the ::jsonb cast on legacy rows where tags isn't a
  //    JSON array (would otherwise throw "cannot extract elements from a scalar"
  //    or an invalid-JSON error and kill the whole query).
  //  * size / length: use regexp_match (scalar) inside COALESCE; the previous
  //    regexp_matches is set-returning and rejected inside COALESCE on newer
  //    Postgres. Use [[:space:]] instead of \\s so this is POSIX-clean.
  //  * length_val: guard the ::int cast by verifying the captured group is
  //    all digits; any non-digit slipping through (e.g. legacy "Length: NaN"
  //    tag) becomes NULL rather than throwing.
  const sql = `
    WITH variant_inv AS (
      SELECT
        ii.product_id,
        ii.variant_id,
        ii.variant_title,
        ii.product_title,
        ii.style_name,
        ii.product_type,
        ii.product_group,
        ii.product_image,
        ii.season,
        ii.class,
        ii.tags,
        CASE
          WHEN ii.tags IS NOT NULL AND ii.tags LIKE '[%'
            THEN ii.tags::jsonb
          ELSE '[]'::jsonb
        END AS tags_json,
        ii.price::numeric AS price,
        ii.compare_at_price::numeric AS compare_at_price,
        -- Size: prefer "Size: X" tag, else parse a size token from variant_title.
        COALESCE(
          (SELECT (regexp_match(t, '^[Ss]ize:[[:space:]]*(.+)$'))[1]
             FROM jsonb_array_elements_text(
                    CASE WHEN ii.tags IS NOT NULL AND ii.tags LIKE '[%' THEN ii.tags::jsonb ELSE '[]'::jsonb END
                  ) t
            WHERE t ~* '^size:[[:space:]]*' LIMIT 1),
          (regexp_match(COALESCE(ii.variant_title,''), '(?:^|[^A-Za-z])(XXS|XS|S|M|L|XL|XXL)(?:[^A-Za-z]|$)'))[1]
        ) AS size,
        -- Length parsed from "Length: NN" tag.
        (SELECT CASE WHEN cap ~ '^[0-9]+$' THEN cap::int ELSE NULL END
           FROM (
             SELECT (regexp_match(t, '^[Ll]ength:[[:space:]]*([0-9]+)'))[1] AS cap
               FROM jsonb_array_elements_text(
                      CASE WHEN ii.tags IS NOT NULL AND ii.tags LIKE '[%' THEN ii.tags::jsonb ELSE '[]'::jsonb END
                    ) t
              WHERE t ~* '^length:[[:space:]]*[0-9]+'
              LIMIT 1
           ) sub) AS length_val,
        ${useAtsOverride
          ? `COALESCE(SUM(il.available) FILTER (WHERE il.location_id = ANY(${filterLocsParam}::text[])), 0)::int AS variant_total_inv,`
          : `COALESCE(SUM(il.available), 0)::int AS variant_total_inv,`}
        COALESCE(SUM(il.available) FILTER (WHERE il.location_id = ANY(${filterLocsParam}::text[])), 0)::int AS variant_filtered_inv
      FROM inventory_items ii
      LEFT JOIN inventory_levels il ON il.inventory_item_id = ii.inventory_item_id
      WHERE UPPER(COALESCE(ii.product_status, 'ACTIVE')) = 'ACTIVE'
      GROUP BY ii.variant_id, ii.product_id, ii.variant_title, ii.product_title,
               ii.style_name, ii.product_type, ii.product_group, ii.product_image,
               ii.season, ii.class, ii.tags, ii.price, ii.compare_at_price
    ),
    size_agg AS (
      SELECT product_id,
             COALESCE(size, 'other') AS size,
             SUM(variant_total_inv)::int AS size_total
        FROM variant_inv
       GROUP BY product_id, COALESCE(size, 'other')
    ),
    size_map AS (
      SELECT product_id, jsonb_object_agg(size, size_total) AS inventory_by_size
        FROM size_agg
       GROUP BY product_id
    ),
    product_agg AS (
      SELECT
        vi.product_id,
        MIN(vi.product_title) AS product_title,
        MIN(vi.style_name)    AS style_name,
        MIN(vi.product_type)  AS product_type,
        MIN(vi.product_group) AS product_group,
        MIN(vi.product_image) AS product_image,
        MIN(vi.season)        AS season,
        MIN(vi.class)         AS class,
        -- Pick any variant's tags_json (product-level tags are shared across variants).
        (ARRAY_AGG(vi.tags_json))[1] AS tags_json,
        MIN(vi.length_val)    AS length_val,
        MIN(vi.price)         AS min_price,
        MIN(vi.compare_at_price) AS min_compare_at,
        sm.inventory_by_size  AS inventory_by_size,
        SUM(vi.variant_total_inv)::int    AS total_inventory,
        SUM(vi.variant_filtered_inv)::int AS filtered_inventory
      FROM variant_inv vi
      LEFT JOIN size_map sm USING (product_id)
      GROUP BY vi.product_id, sm.inventory_by_size
    )
    SELECT * FROM product_agg
     WHERE ${includeExpr}
       AND ${globalExpr}
     ORDER BY LOWER(COALESCE(style_name, product_title)), LOWER(product_title)
     LIMIT 500
  `;

  return { sql, params: c.params, filterLocations };
}

// Run a filter tree and return aggregated product rows.
export async function runFilter(tree, opts = {}) {
  const { sql, params } = compileFilterTree(tree || { include: [], globals: [] }, opts);
  const { rows } = await query(sql, params);
  return rows.map(normalizeRow);
}

// Load extra products by explicit product_id (used for pins).
export async function loadProductsByIds(productIds, opts = {}) {
  if (!productIds || productIds.length === 0) return [];
  const { sql, params } = compileFilterTree({
    include: [{ conditions: [{ field: "product", op: "any_of", value: productIds }] }],
    globals: []
  }, opts);
  const { rows } = await query(sql, params);
  return rows.map(normalizeRow);
}

function normalizeRow(r) {
  const invSize = r.inventory_by_size || {};
  const sized = {};
  for (const s of SIZE_BUCKETS) sized[s] = Number(invSize[s] || 0);
  let other = 0;
  for (const [k, v] of Object.entries(invSize)) {
    if (!SIZE_BUCKETS.includes(k)) other += Number(v || 0);
  }
  if (other > 0) sized.other = other;

  const tagsJson = r.tags_json || [];
  return {
    product_id: r.product_id,
    title: r.product_title,
    style_name: r.style_name,
    product_type: r.product_type,
    product_group: r.product_group,
    image: (r.product_image || "").split("?")[0] || "",
    season: r.season,
    class: r.class,
    tags: Array.isArray(tagsJson) ? tagsJson : [],
    length: r.length_val != null ? Number(r.length_val) : null,
    compare_at_price: num(r.min_compare_at),
    current_price: num(r.min_price),
    price_tier: (num(r.min_price) < num(r.min_compare_at)) ? "off_price" : "full_price",
    inventory_by_size: sized,
    inventory_total: Number(r.total_inventory || 0)
  };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

export { SIZE_BUCKETS };
