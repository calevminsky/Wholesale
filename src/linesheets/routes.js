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
      const sheets = await db.listLineSheets({ search: req.query.q });
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

  r.get("/api/linesheets/:id", async (req, res) => {
    try {
      const sheet = await db.getLineSheet(Number(req.params.id));
      if (!sheet) return res.status(404).json({ error: "Not found" });
      const preview = await computePreview(sheet);
      res.json({ linesheet: sheet, ...preview });
    } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  r.put("/api/linesheets/:id", async (req, res) => {
    try {
      const row = await db.updateLineSheet(Number(req.params.id), req.body || {});
      if (!row) return res.status(404).json({ error: "Not found" });
      res.json({ linesheet: row });
    } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  r.post("/api/linesheets/:id/duplicate", async (req, res) => {
    try {
      const row = await db.duplicateLineSheet(Number(req.params.id));
      if (!row) return res.status(404).json({ error: "Not found" });
      res.json({ linesheet: row });
    } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  r.delete("/api/linesheets/:id", async (req, res) => {
    try {
      const ok = await db.archiveLineSheet(Number(req.params.id));
      res.json({ ok });
    } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  // ------- Preview (ephemeral, no DB write) -------
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

  // ------- Render (live-checked) -------
  r.get("/api/linesheets/:id/render.pdf", async (req, res) => {
    try {
      const sheet = await db.getLineSheet(Number(req.params.id));
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
    try {
      const sheet = await db.getLineSheet(Number(req.params.id));
      if (!sheet) return res.status(404).json({ error: "Not found" });
      const payload = await buildRenderedPayload(sheet, { shopifyGraphQL, liveCheck: true });
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(renderHtml(payload));
    } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  // ------- Meta (for dropdowns) -------
  r.get("/api/linesheets/meta", async (_req, res) => {
    try {
      const seasons = await distinct("season");
      const classes = await distinct("class");
      const types   = await distinct("product_type");

      const fabrics = ["KNIT", "WOVEN"];
      const sleeves = ["Long Sleeve", "Short Sleeve", "Sleeveless"];

      const { rows: lengthRows } = await query(`
        SELECT DISTINCT (substring(t FROM '^Length:\\s*([0-9]+)'))::int AS len
          FROM inventory_items ii,
               LATERAL jsonb_array_elements_text(
                 CASE WHEN ii.tags IS NOT NULL AND ii.tags <> '' THEN ii.tags::jsonb ELSE '[]'::jsonb END
               ) t
         WHERE t ~* '^Length:\\s*[0-9]+'
         ORDER BY len
      `);

      const { rows: locRows } = await query(`
        SELECT DISTINCT location_id AS id, location_name AS name
          FROM inventory_levels
         WHERE location_id IS NOT NULL
         ORDER BY location_name
      `);

      res.json({
        seasons, classes, product_types: types,
        fabrics, sleeves,
        lengths: lengthRows.map(r => r.len).filter(Boolean),
        locations: locRows
      });
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

async function computePreview(sheet) {
  const filterTree = sheet.filter_tree || { include: [], globals: [] };
  const pricing = { ...defaultPricing(), ...(sheet.pricing || {}) };
  const opts = sheet.display_opts || {};

  let matched = await runFilter(filterTree);
  const excludeNadaIgnore = opts.exclude_nada_ignore !== false;
  if (excludeNadaIgnore) {
    matched = matched.filter((p) => !(p.tags || []).includes("nada-ignore"));
  }

  let pinned = [];
  if ((sheet.pins || []).length) pinned = await loadProductsByIds(sheet.pins);

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
