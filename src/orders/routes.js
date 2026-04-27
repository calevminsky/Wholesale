// Mount /api/orders-draft/* on an Express app.
//
// Note: /api/orders already exists (lists Shopify orders). To avoid clashing,
// the draft/persisted-order routes live under /api/orders-draft.
import { Router } from "express";
import { pgAvailable } from "../pg.js";
import * as db from "./db.js";

export function createOrdersRouter() {
  const r = Router();

  r.use((req, res, next) => {
    if (!pgAvailable()) {
      return res.status(503).json({ error: "Reporting DB unavailable. Set REPORTING_DATABASE_URL." });
    }
    next();
  });

  const parseId = (s) => {
    const n = Number(s);
    return Number.isFinite(n) && Number.isInteger(n) ? n : null;
  };

  // ------- list / create -------
  r.get("/api/orders-draft", async (req, res) => {
    try {
      const rows = await db.listOrders({
        status: req.query.status || undefined,
        customerId: req.query.customer_id ? parseId(req.query.customer_id) : undefined,
        lineSheetId: req.query.line_sheet_id ? parseId(req.query.line_sheet_id) : undefined,
        search: req.query.q
      });
      res.json({ orders: rows });
    } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  r.post("/api/orders-draft", async (req, res) => {
    try {
      const row = await db.createOrder(req.body || {});
      res.json({ order: row });
    } catch (e) { res.status(400).json({ error: String(e?.message || e) }); }
  });

  // ------- get / update / archive / duplicate -------
  r.get("/api/orders-draft/:id", async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(404).json({ error: "Not found" });
    try {
      const row = await db.getOrder(id);
      if (!row) return res.status(404).json({ error: "Not found" });
      const previews = await db.listPreviewSnapshots(id);
      res.json({ order: row, previews });
    } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  r.put("/api/orders-draft/:id", async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(404).json({ error: "Not found" });
    try {
      const row = await db.updateOrder(id, req.body || {});
      if (!row) return res.status(404).json({ error: "Not found, archived, or already submitted" });
      res.json({ order: row });
    } catch (e) { res.status(400).json({ error: String(e?.message || e) }); }
  });

  r.delete("/api/orders-draft/:id", async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(404).json({ error: "Not found" });
    try {
      const ok = await db.archiveOrder(id);
      res.json({ ok });
    } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  r.post("/api/orders-draft/:id/duplicate", async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(404).json({ error: "Not found" });
    try {
      const row = await db.duplicateOrder(id);
      if (!row) return res.status(404).json({ error: "Not found" });
      res.json({ order: row });
    } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  // ------- preview snapshots -------
  r.get("/api/orders-draft/:id/previews", async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(404).json({ error: "Not found" });
    try {
      res.json({ previews: await db.listPreviewSnapshots(id) });
    } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  r.get("/api/orders-draft/:id/previews/:snapshotId", async (req, res) => {
    const id = parseId(req.params.id);
    const snapshotId = parseId(req.params.snapshotId);
    if (id === null || snapshotId === null) return res.status(404).json({ error: "Not found" });
    try {
      const snap = await db.getPreviewSnapshot(snapshotId);
      if (!snap || snap.order_id !== id) return res.status(404).json({ error: "Not found" });
      res.json({ preview: snap });
    } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  return r;
}
