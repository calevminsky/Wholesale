// Wholesale portal server: serves the buyer-facing portal (static) AND a
// password-gated admin where Calev sets off-price rules + per-product
// overrides, then rebuilds the catalog. Full price stays governed by
// tiers.config.json. The buyer portal itself is open; only /admin and the
// write/rebuild APIs require ADMIN_PASSWORD (HTTP Basic).
//
// Run:  node server.mjs           (PORT defaults to 10000)
// Env:  ADMIN_PASSWORD (gate admin; unset = open, dev only)
//       REPORTING_DATABASE_URL + Shopify creds (for rebuild)
import express from "express";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadOffPricing, saveOffPricing, OFF_MODES } from "./build/off-pricing.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 10000;
const app = express();
app.use(express.json({ limit: "1mb" }));

// ---- admin auth (Basic; open when ADMIN_PASSWORD unset) ----
function adminAuth(req, res, next) {
  const pw = process.env.ADMIN_PASSWORD || "";
  if (!pw) return next();
  const h = req.headers.authorization || "";
  if (h.startsWith("Basic ")) {
    const dec = Buffer.from(h.slice(6), "base64").toString("utf8");
    if (dec.slice(dec.indexOf(":") + 1) === pw) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="Portal Admin"').status(401).send("Authentication required.");
}

// ---- admin page ----
app.get("/admin", adminAuth, (_req, res) => res.sendFile(path.join(__dirname, "admin", "index.html")));
app.get("/admin/admin.js", adminAuth, (_req, res) => res.sendFile(path.join(__dirname, "admin", "admin.js")));

// ---- off-pricing API ----
app.get("/api/off-pricing", (_req, res) => res.json({ ...loadOffPricing(), modes: OFF_MODES }));

app.post("/api/off-pricing", adminAuth, (req, res) => {
  try {
    const cfg = { default: req.body?.default || {}, overrides: req.body?.overrides || {} };
    saveOffPricing(cfg);
    res.json({ ok: true, saved: loadOffPricing() });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

// ---- rebuild catalog ----
// Runs one node script, appending its output to `log`. Resolves with the exit code.
function runStep(scriptArgs, log) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", scriptArgs, { cwd: __dirname, env: process.env });
    child.stdout.on("data", (d) => (log.text += d));
    child.stderr.on("data", (d) => (log.text += d));
    child.on("close", (code) => resolve(code));
    child.on("error", reject);
  });
}

let rebuilding = false;
app.post("/api/rebuild", adminAuth, async (req, res) => {
  if (rebuilding) return res.status(409).json({ ok: false, error: "A rebuild is already running." });
  rebuilding = true;
  const log = { text: "" };
  try {
    // Refresh the Airtable pre-order snapshot first (delivery dates, prices,
    // images) when creds are present; skip cleanly otherwise so the in-stock
    // build still works. `skipAirtable:true` forces a build-only refresh.
    if (process.env.AIRTABLE_API_KEY && !req.body?.skipAirtable) {
      const code = await runStep(["build/airtable-preorder.mjs"], log);
      if (code !== 0) log.text += `\n! Airtable fetch exited ${code} — building with the existing snapshot.\n`;
    } else if (!process.env.AIRTABLE_API_KEY) {
      log.text += "i AIRTABLE_API_KEY not set — skipping Airtable refresh (in-stock only).\n";
    }
    const args = ["build/build-catalog.mjs"];
    if (req.body?.allowDrafts) args.push("--allow-drafts");
    const code = await runStep(args, log);
    rebuilding = false;
    res.json({ ok: code === 0, code, log: log.text });
  } catch (e) {
    rebuilding = false;
    res.status(500).json({ ok: false, error: String(e.message || e), log: log.text });
  }
});

// ---- static buyer portal (index, app.js, styles, data/, build/*.json) ----
app.use(express.static(__dirname, { extensions: ["html"] }));

app.listen(PORT, () => console.log(`Wholesale portal on :${PORT}  (admin at /admin${process.env.ADMIN_PASSWORD ? "" : " — OPEN, set ADMIN_PASSWORD"})`));
