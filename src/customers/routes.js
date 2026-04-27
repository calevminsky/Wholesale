// Mount /api/customers/* on an Express app.
import { Router } from "express";
import { pgAvailable } from "../pg.js";
import * as db from "./db.js";

export function createCustomersRouter() {
  const r = Router();

  r.use((req, res, next) => {
    if (!pgAvailable()) {
      return res.status(503).json({ error: "Reporting DB unavailable. Set REPORTING_DATABASE_URL." });
    }
    next();
  });

  r.get("/api/customers", async (req, res) => {
    try {
      const customers = await db.listCustomers({ search: req.query.q });
      res.json({ customers });
    } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  r.post("/api/customers", async (req, res) => {
    try {
      const row = await db.createCustomer(req.body || {});
      res.json({ customer: row });
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg.includes("uniq_customers_name_lower_active")) {
        return res.status(409).json({ error: "A customer with that name already exists." });
      }
      res.status(400).json({ error: msg });
    }
  });

  const parseId = (s) => {
    const n = Number(s);
    return Number.isFinite(n) && Number.isInteger(n) ? n : null;
  };

  r.get("/api/customers/:id", async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(404).json({ error: "Not found" });
    try {
      const row = await db.getCustomer(id);
      if (!row) return res.status(404).json({ error: "Not found" });
      res.json({ customer: row });
    } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  r.put("/api/customers/:id", async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(404).json({ error: "Not found" });
    try {
      const row = await db.updateCustomer(id, req.body || {});
      if (!row) return res.status(404).json({ error: "Not found" });
      res.json({ customer: row });
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg.includes("uniq_customers_name_lower_active")) {
        return res.status(409).json({ error: "A customer with that name already exists." });
      }
      res.status(400).json({ error: msg });
    }
  });

  r.delete("/api/customers/:id", async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(404).json({ error: "Not found" });
    try {
      const ok = await db.archiveCustomer(id);
      res.json({ ok });
    } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  return r;
}
