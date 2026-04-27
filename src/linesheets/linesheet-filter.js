// Resolve `linesheet` filter conditions in a filter tree by computing the
// referenced sheet's live product set (matched + pinned − excluded) and
// substituting a concrete `product` condition.
//
// Lets a user write a sheet whose filter says "exclude products from sheet
// 'Margin Builders'". The substitution happens before the SQL is compiled,
// so the existing `product = ANY/<>ALL` predicates do the work.
//
// Cycle-safe: if sheet A references B which references A, we stop at depth
// MAX_DEPTH and treat the deepest ref as an empty set.

import * as db from "./db.js";
import { runFilter, loadProductsByIds } from "./query.js";

const MAX_DEPTH = 4;

// Compute the resolved product ID set for a single line sheet (without
// live-checking Shopify — this is purely the editor's "what's in this view"
// answer). Cached per call chain so the same sheet isn't recomputed twice.
async function resolveSheetIds(sheetId, opts, cache, visited, depth) {
  if (depth > MAX_DEPTH) return new Set();
  if (visited.has(sheetId)) return new Set();
  if (cache.has(sheetId)) return cache.get(sheetId);

  visited.add(sheetId);
  const sheet = await db.getLineSheet(sheetId);
  if (!sheet) {
    cache.set(sheetId, new Set());
    return cache.get(sheetId);
  }

  // Recursively resolve any nested linesheet refs in the inner sheet first.
  const innerTree = await resolveLineSheetReferences(
    sheet.filter_tree || { include: [], globals: [] },
    opts,
    cache,
    visited,
    depth + 1
  );

  const matched = await runFilter(innerTree, opts);
  let pinned = [];
  if ((sheet.pins || []).length) pinned = await loadProductsByIds(sheet.pins, opts);

  const ids = new Set();
  const excludeSet = new Set(sheet.excludes || []);
  for (const p of matched) if (!excludeSet.has(p.product_id)) ids.add(p.product_id);
  for (const p of pinned)  if (!excludeSet.has(p.product_id)) ids.add(p.product_id);

  cache.set(sheetId, ids);
  return ids;
}

// Walk the filter tree and rewrite any `linesheet` conditions in-place into
// resolved `product` conditions. Returns a new tree (does not mutate input).
export async function resolveLineSheetReferences(filterTree, opts = {}, cache = new Map(), visited = new Set(), depth = 0) {
  const tree = JSON.parse(JSON.stringify(filterTree || { include: [], globals: [] }));

  async function rewriteCondition(cond) {
    if (!cond || cond.field !== "linesheet") return cond;
    const ids = Array.isArray(cond.value) ? cond.value.map(Number).filter(Boolean) : [Number(cond.value)].filter(Boolean);
    if (ids.length === 0) return null;

    const allIds = new Set();
    for (const id of ids) {
      const set = await resolveSheetIds(id, opts, cache, new Set(visited), depth);
      for (const pid of set) allIds.add(pid);
    }

    return {
      field: "product",
      op: cond.op === "in" ? "any_of" : "none_of",
      value: Array.from(allIds)
    };
  }

  async function rewriteList(list) {
    const out = [];
    for (const c of list || []) {
      const next = await rewriteCondition(c);
      if (next) out.push(next);
    }
    return out;
  }

  if (Array.isArray(tree.include)) {
    for (const g of tree.include) g.conditions = await rewriteList(g.conditions);
  }
  if (Array.isArray(tree.globals)) {
    tree.globals = await rewriteList(tree.globals);
  }

  return tree;
}
