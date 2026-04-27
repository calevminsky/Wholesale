// Mount /api/saved-filters/* and /api/linesheets/* on an Express app.
// Takes dependencies (shopifyGraphQL, renderPdfFromHtml) from server.js to avoid duplication.
import { Router } from "express";
import { pgAvailable, query } from "../pg.js";
import * as db from "./db.js";
import { runFilter, loadProductsByIds } from "./query.js";
import { applyPricing, defaultPricing } from "./pricing.js";
import { buildRenderedPayload, renderHtml } from "./render-pdf.js";

export function createLineSheetsRouter({ shopifyGraphQL, renderPdfFromHtml }) {
  const r = Router();

  // Guard: every route requires the reporting DB.
  r.use((req, res, next) => {
    if (!pgAvailable()) {
      return res.status(503).json({ error: "Reporting DB unavailable. Set REPORTING_DATABASE_URL." });
    }
    next();
  });

  // ------- Saved filters -------
  r.get("/api/saved-filters", async (_req, res) => {
    try { res.json({ saved_filters: await db.listSavedFilters() }); }
    catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  r.post("/api/saved-filters", async (req, res) => {
    try {
      const { name, description, filter_tree } = req.body || {};
      if (!name) return res.status(400).json({ error: "name is required" });
      const row = await db.createSavedFilter({ name, description, filter_tree });
      res.json({ saved_filter: row });
    } catch (e) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  r.get("/api/saved-filters/:id", async (req, res) => {
    try {
      const row = await db.getSavedFilter(Number(req.params.id));
      if (!row) return res.status(404).json({ error: "Not found" });
      res.json({ saved_filter: row });
    } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  r.put("/api/saved-filters/:id", async (req, res) => {
    try {
      const row = await db.updateSavedFilter(Number(req.params.id), req.body || {});
      if (!row) return res.status(404).json({ error: "Not found" });
      res.json({ saved_filter: row });
    } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  r.delete("/api/saved-filters/:id", async (req, res) => {
    try {
      const id = Number(req.params.id);
      const inUse = await db.countLineSheetsUsingFilter(id);
      if (inUse > 0 && !req.query.force) {
        return res.status(409).json({
          error: `Filter is used by ${inUse} line sheet(s). Pass ?force=1 to delete anyway.`,
          in_use: inUse
        });
      }
      const ok = await db.deleteSavedFilter(id);
      res.json({ ok });
    } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  // ------- Line sheets -------
  r.get("/api/linesheets", async (req, res) => {
    try {
      const sheets = await db.listLineSheets({
        search: req.query.q,
        customerId: req.query.customer_id ? Number(req.query.customer_id) || undefined : undefined
      });
      res.json({ linesheets: sheets });
    } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  r.post("/api/linesheets", async (req, res) => {
    try {
      const p = req.body || {};
      if (!p.name) return res.status(400).json({ error: "name is required" });
      const row = await db.createLineSheet({
        name: p.name,
        customer: p.customer,
        customer_id: p.customer_id || null,
        description: p.description,
        filter_tree: p.filter_tree || { include: [], globals: [] },
        saved_filter_id: p.saved_filter_id || null,
        pins: p.pins || [],
        excludes: p.excludes || [],
        pricing: p.pricing || defaultPricing(),
        display_opts: p.display_opts || {}
      });
      res.json({ linesheet: row });
    } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  // ------- Preview (ephemeral, no DB write) -------
  // Must be registered BEFORE /:id so POST /preview isn't shadowed.
  r.post("/api/linesheets/preview", async (req, res) => {
    try {
      const body = req.body || {};
      const sheet = {
        filter_tree: body.filter_tree || { include: [], globals: [] },
        pins: body.pins || [],
        excludes: body.excludes || [],
        pricing: body.pricing || defaultPricing(),
        display_opts: body.display_opts || {}
      };
      res.json(await computePreview(sheet));
    } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  // ------- Meta (for dropdowns) -------
  // MUST be registered BEFORE /:id, otherwise /meta hits the :id handler
  // with id="meta" and Number("meta")=NaN, which Postgres rejects.
  r.get("/api/linesheets/meta", async (_req, res) => {
    const warnings = [];
    const safe = async (label, fn) => {
      try { return await fn(); }
      catch (e) { warnings.push(`${label}: ${e?.message || e}`); return null; }
    };
    try {
      const [seasons, classes, types, lengths, locations] = await Promise.all([
        safe("seasons",       () => distinct("season")),
        safe("classes",       () => distinct("class")),
        safe("product_types", () => distinct("product_type")),
        safe("lengths",       () => distinctLengths()),
        safe("locations",     () => distinctLocations())
      ]);

      res.json({
        _v: "meta-v2",
        seasons:       seasons  || [],
        classes:       classes  || [],
        product_types: types    || [],
        fabrics:       ["KNIT", "WOVEN"],
        sleeves:       ["Long Sleeve", "Short Sleeve", "Sleeveless"],
        lengths:       (lengths || []).filter(Boolean),
        locations:     locations || [],
        warnings
      });
    } catch (e) {
      // Safety net — should be unreachable since safe() never throws, but
      // if some unexpected thing slips through, return a 200 with empty
      // lists and a warning rather than a 500.
      res.json({
        _v: "meta-v2-fallback",
        seasons: [], classes: [], product_types: [],
        fabrics: ["KNIT", "WOVEN"],
        sleeves: ["Long Sleeve", "Short Sleeve", "Sleeveless"],
        lengths: [], locations: [],
        warnings: [`fatal: ${e?.message || e}`]
      });
    }
  });

  // ------- Line sheet by id (MUST be after /meta and /preview) -------
  const parseId = (s) => {
    const n = Number(s);
    return Number.isFinite(n) && Number.isInteger(n) ? n : null;
  };

  r.get("/api/linesheets/:id", async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(404).json({ error: "Not found" });
    try {
      const sheet = await db.getLineSheet(id);
      if (!sheet) return res.status(404).json({ error: "Not found" });
      const preview = await computePreview(sheet);
      res.json({ linesheet: sheet, ...preview });
    } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  r.put("/api/linesheets/:id", async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(404).json({ error: "Not found" });
    try {
      const row = await db.updateLineSheet(id, req.body || {});
      if (!row) return res.status(404).json({ error: "Not found" });
      res.json({ linesheet: row });
    } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  r.post("/api/linesheets/:id/duplicate", async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(404).json({ error: "Not found" });
    try {
      const row = await db.duplicateLineSheet(id);
      if (!row) return res.status(404).json({ error: "Not found" });
      res.json({ linesheet: row });
    } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  r.delete("/api/linesheets/:id", async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(404).json({ error: "Not found" });
    try {
      const ok = await db.archiveLineSheet(id);
      res.json({ ok });
    } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  r.get("/api/linesheets/:id/price-history", async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(404).json({ error: "Not found" });
    try {
      const history = await db.listLineSheetPriceHistory(id);
      res.json({ history });
    } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  r.get("/api/linesheets/:id/render.pdf", async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(404).json({ error: "Not found" });
    try {
      const sheet = await db.getLineSheet(id);
      if (!sheet) return res.status(404).json({ error: "Not found" });
      const payload = await buildRenderedPayload(sheet, { shopifyGraphQL, liveCheck: true });
      const html = renderHtml(payload);
      const { pdfBuffer } = await renderPdfFromHtml(html);
      if (!pdfBuffer) {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        return res.send(html);
      }
      const safe = String(sheet.name || "linesheet").replace(/[^A-Za-z0-9\-_ ]+/g, "").replace(/\s+/g, "_") || "linesheet";
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${safe}.pdf"`);
      res.send(Buffer.from(pdfBuffer));
    } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  r.get("/api/linesheets/:id/render.html", async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(404).json({ error: "Not found" });
    try {
      const sheet = await db.getLineSheet(id);
      if (!sheet) return res.status(404).json({ error: "Not found" });
      const payload = await buildRenderedPayload(sheet, { shopifyGraphQL, liveCheck: true });
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(renderHtml(payload));
    } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  return r;
}

async function distinct(col) {
  const { rows } = await query(
    `SELECT DISTINCT ${col} AS v FROM inventory_items WHERE ${col} IS NOT NULL AND ${col} <> '' ORDER BY ${col}`
  );
  return rows.map((r) => r.v);
}

async function distinctLengths() {
  // Two guards:
  //  1. Only consider rows whose tags start with '[' (valid JSON array); otherwise
  //     ::jsonb would throw on legacy rows with non-JSON tag strings.
  //  2. Do the integer cast as text→numeric→int with NULLIF/regex, so any
  //     non-digit match (even an edge case in the POSIX regex) becomes NULL
  //     instead of failing the whole query.
  const { rows } = await query(`
    WITH raw AS (
      SELECT jsonb_array_elements_text(ii.tags::jsonb) AS t
        FROM inventory_items ii
       WHERE ii.tags IS NOT NULL
         AND ii.tags LIKE '[%'
    ),
    parsed AS (
      SELECT NULLIF(regexp_replace(t, '^[Ll]ength:[[:space:]]*([0-9]+).*$', '\\1'), t) AS raw_digits
        FROM raw
       WHERE t ~* '^length:[[:space:]]*[0-9]+'
    )
    SELECT DISTINCT raw_digits::int AS len
      FROM parsed
     WHERE raw_digits ~ '^[0-9]+$'
     ORDER BY len
  `);
  return rows.map((r) => r.len);
}

async function distinctLocations() {
  const { rows } = await query(`
    SELECT DISTINCT location_id AS id, location_name AS name
      FROM inventory_levels
     WHERE location_id IS NOT NULL
     ORDER BY location_name
  `);
  return rows;
}

async function computePreview(sheet) {
  const filterTree = sheet.filter_tree || { include: [], globals: [] };
  const pricing = { ...defaultPricing(), ...(sheet.pricing || {}) };
  const opts = sheet.display_opts || {};

  const runOpts = {
    atsLocations: Array.isArray(opts.ats_locations) ? opts.ats_locations : []
  };
  let matched = await runFilter(filterTree, runOpts);

  let pinned = [];
  if ((sheet.pins || []).length) pinned = await loadProductsByIds(sheet.pins, runOpts);

  const matchedIds = new Set(matched.map((p) => p.product_id));
  const excludeSet = new Set(sheet.excludes || []);

  // Tag source for UI
  const all = [];
  for (const p of matched) all.push({ ...p, source: matchedIds.has(p.product_id) ? "matched" : "matched" });
  for (const p of pinned) {
    if (matchedIds.has(p.product_id)) continue;
    all.push({ ...p, source: "pinned" });
  }

  const priced = applyPricing(all, pricing);
  const withFlags = priced.map((p) => ({ ...p, excluded: excludeSet.has(p.product_id) }));

  const counts = {
    matched: matched.length,
    pinned: pinned.length,
    excluded: withFlags.filter((p) => p.excluded).length,
    final: withFlags.filter((p) => !p.excluded).length
  };

  const capped = withFlags.length >= 500;

  return { counts, products: withFlags, capped };
}
