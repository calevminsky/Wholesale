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

// ---- removal (curate) auth: secret key in the URL (?key=) ----
// Emily's product-removal link. Disabled (404) until CURATE_KEY is set, so an
// unguessable link is required — no password prompt.
const CURATE_KEY = process.env.CURATE_KEY || "";
function curateAuth(req, res, next) {
  if (CURATE_KEY && String(req.query.key || "") === CURATE_KEY) return next();
  res.status(404).send("Not found.");
}

// ---- manual hide list (build/hidden.json) ----
const HIDDEN_PATH = path.join(__dirname, "build", "hidden.json");
function loadHidden() {
  try {
    const j = JSON.parse(fs.readFileSync(HIDDEN_PATH, "utf8"));
    return { ids: j.ids || [], handles: j.handles || [], titles: j.titles || [], _removed: j._removed || [] };
  } catch {
    return { ids: [], handles: [], titles: [], _removed: [] };
  }
}
function saveHidden(h) { fs.writeFileSync(HIDDEN_PATH, JSON.stringify(h, null, 2)); }

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

// ---- account resolution (buyer portal) ----
// Returns ONLY the public-facing fields for a known token (name, slug,
// customer_id). Never the email, and an unknown token reveals nothing — so the
// full accounts list (tokens + emails) is never exposed to buyers.
app.get("/api/account", (req, res) => {
  const token = String(req.query.token || "");
  if (!token) return res.json({ account: null });
  try {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, "build", "accounts.json"), "utf8"));
    const hit = data.accounts?.[token];
    if (!hit) return res.json({ account: null });
    res.json({ account: { name: hit.name, slug: hit.slug, customer_id: hit.customer_id ?? null } });
  } catch {
    res.json({ account: null });
  }
});

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
// Refresh Airtable (when creds present) then rebuild the catalog. Shared by the
// admin "Save & rebuild" and the curate/remove page.
async function doRebuild(log, { skipAirtable = false, allowDrafts = false } = {}) {
  if (process.env.AIRTABLE_API_KEY && !skipAirtable) {
    const code = await runStep(["build/airtable-preorder.mjs"], log);
    if (code !== 0) log.text += `\n! Airtable fetch exited ${code} — building with the existing snapshot.\n`;
  } else if (!process.env.AIRTABLE_API_KEY) {
    log.text += "i AIRTABLE_API_KEY not set — skipping Airtable refresh (in-stock only).\n";
  }
  const args = ["build/build-catalog.mjs"];
  if (allowDrafts) args.push("--allow-drafts");
  return runStep(args, log);
}

app.post("/api/rebuild", adminAuth, async (req, res) => {
  if (rebuilding) return res.status(409).json({ ok: false, error: "A rebuild is already running." });
  rebuilding = true;
  const log = { text: "" };
  try {
    const code = await doRebuild(log, { skipAirtable: req.body?.skipAirtable, allowDrafts: req.body?.allowDrafts });
    rebuilding = false;
    res.json({ ok: code === 0, code, log: log.text });
  } catch (e) {
    rebuilding = false;
    res.status(500).json({ ok: false, error: String(e.message || e), log: log.text });
  }
});

// ---- curate / remove products (Emily's secret link) ----
// The page is key-gated; curate.js itself carries no secrets and loads via the
// static handler. All data lives behind the key-gated /api/* routes below.
app.get("/curate", curateAuth, (_req, res) => res.sendFile(path.join(__dirname, "curate", "index.html")));

// Current removals, for the "restore" section.
app.get("/api/hidden", curateAuth, (_req, res) => res.json({ removed: loadHidden()._removed }));

// Add/restore removals, then rebuild so buyers see the change.
app.post("/api/remove", curateAuth, async (req, res) => {
  if (rebuilding) return res.status(409).json({ ok: false, error: "A rebuild is already running." });
  const add = Array.isArray(req.body?.add) ? req.body.add : [];        // [{handle, title, gid}]
  const restore = Array.isArray(req.body?.restore) ? req.body.restore : []; // [handle]
  // Key removals by handle only — it's unique for both in-stock (real Shopify
  // handle) and pre-order (slug) styles, so add/restore stay symmetric.
  const h = loadHidden();
  const handleSet = new Set(h.handles);
  const removedByHandle = new Map(h._removed.map((r) => [r.handle, r]));
  for (const it of add) {
    if (!it?.handle) continue;
    handleSet.add(it.handle);
    removedByHandle.set(it.handle, { handle: it.handle, title: it.title || it.handle });
  }
  for (const handle of restore) {
    handleSet.delete(handle);
    removedByHandle.delete(handle);
  }
  const next = { ids: h.ids, handles: [...handleSet], titles: h.titles, _removed: [...removedByHandle.values()] };
  saveHidden(next);

  rebuilding = true;
  const log = { text: "" };
  try {
    const code = await doRebuild(log, {});
    rebuilding = false;
    res.json({ ok: code === 0, code, removed: next._removed, log: log.text });
  } catch (e) {
    rebuilding = false;
    res.status(500).json({ ok: false, error: String(e.message || e), log: log.text });
  }
});

// ---- static buyer portal (index, app.js, styles, data/) ----
// Block the build/ folder: it holds accounts.json (tokens + emails),
// off-pricing.json, the assignment seed, and the handle cache — none of which
// should be publicly fetchable. Buyers get account info via /api/account.
app.use((req, res, next) => {
  if (req.path === "/build" || req.path.startsWith("/build/")) return res.status(404).send("Not found");
  next();
});
app.use(express.static(__dirname, { extensions: ["html"] }));

app.listen(PORT, () => console.log(`Wholesale portal on :${PORT}  (admin at /admin${process.env.ADMIN_PASSWORD ? "" : " — OPEN, set ADMIN_PASSWORD"})`));
