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
import { getHiddenHandles, listHidden, addHidden, removeHidden } from "./build/hidden-store.mjs";
import { lineSheetBuffer } from "./build/linesheet-xlsx.mjs";
import { lineSheetPdf } from "./build/linesheet-pdf.mjs";
import { buildOrder, orderCSV, orderSummary } from "./build/orderfile.mjs";
import { logVisit, listVisits } from "./build/visits-store.mjs";
import sgMail from "@sendgrid/mail";

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

// ---- removals: served catalog is filtered by the durable DB hide list ----
// catalog.json is cached (re-read when the file changes); the hide list is
// cached briefly and force-refreshed on every removal so changes are instant.
let _catalog = null, _catalogMtime = 0;
function readCatalog() {
  const f = path.join(__dirname, "data", "catalog.json");
  const st = fs.statSync(f);
  if (!_catalog || st.mtimeMs !== _catalogMtime) { _catalog = JSON.parse(fs.readFileSync(f, "utf8")); _catalogMtime = st.mtimeMs; }
  return _catalog;
}
let _hidden = new Set(), _hiddenAt = 0;
async function hiddenSet(force = false) {
  if (force || Date.now() - _hiddenAt > 15_000) {
    try { _hidden = new Set(await getHiddenHandles()); _hiddenAt = Date.now(); }
    catch (e) { console.error("hidden refresh failed:", e.message); } // keep last good set
  }
  return _hidden;
}

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

// ---- gate bypass: a secret link (?bypass=KEY) skips the entry popup ----
// Validated server-side so the key is never embedded in the page.
const GATE_BYPASS_KEY = process.env.GATE_BYPASS_KEY || "";
app.get("/api/gate", (req, res) => {
  res.json({ ok: !!GATE_BYPASS_KEY && String(req.query.key || "") === GATE_BYPASS_KEY });
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
// Refresh the pre-order snapshot from pd (when the DB is reachable) then rebuild
// the catalog. Shared by the admin "Save & rebuild" and the curate/remove page.
// (`skipAirtable` is kept as the flag name for back-compat with the admin/curate UI.)
async function doRebuild(log, { skipAirtable = false, allowDrafts = false } = {}) {
  const hasDb = process.env.REPORTING_DATABASE_URL || process.env.PD_DATABASE_URL;
  if (hasDb && !skipAirtable) {
    const code = await runStep(["build/airtable-preorder.mjs"], log);
    if (code !== 0) log.text += `\n! pd pre-order fetch exited ${code} — building with the existing snapshot.\n`;
  } else if (!hasDb) {
    log.text += "i REPORTING_DATABASE_URL not set — skipping pd pre-order refresh (in-stock only).\n";
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

// ---- durable resync: trigger the GitHub Action (it commits the refreshed
// catalog, so the result survives redeploys — unlike /api/rebuild which writes
// to this container's ephemeral disk). Needs GITHUB_DISPATCH_TOKEN on the server.
const GH_REPO = process.env.GITHUB_REPO || "calevminsky/wholesale";
app.post("/api/resync", adminAuth, async (_req, res) => {
  const token = process.env.GITHUB_DISPATCH_TOKEN || "";
  if (!token) return res.status(400).json({ ok: false, error: "GITHUB_DISPATCH_TOKEN is not set on the server." });
  try {
    const r = await fetch(`https://api.github.com/repos/${GH_REPO}/dispatches`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "yb-wholesale-portal"
      },
      body: JSON.stringify({ event_type: "resync" })
    });
    if (r.status === 204) return res.json({ ok: true });
    const detail = await r.text().catch(() => "");
    res.status(502).json({ ok: false, error: `GitHub dispatch failed: ${r.status} ${detail.slice(0, 200)}` });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ---- curate / remove products (Emily's secret link) ----
// The page is key-gated; curate.js itself carries no secrets and loads via the
// static handler. All data lives behind the key-gated /api/* routes below.
app.get("/curate", curateAuth, (_req, res) => res.sendFile(path.join(__dirname, "curate", "index.html")));

// Current removals (for the "Currently removed" / restore list).
app.get("/api/hidden", curateAuth, async (_req, res) => {
  try { res.json({ removed: await listHidden() }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Add/restore removals. Stored in Postgres (durable across redeploys) and
// applied to the served catalog immediately — no rebuild needed. Keyed by
// handle, which is unique for both in-stock and pre-order styles.
app.post("/api/remove", curateAuth, async (req, res) => {
  const add = Array.isArray(req.body?.add) ? req.body.add : [];          // [{handle, title}]
  const restore = Array.isArray(req.body?.restore) ? req.body.restore : []; // [handle]
  try {
    if (add.length) await addHidden(add);
    if (restore.length) await removeHidden(restore);
    await hiddenSet(true); // refresh the serve-time filter right away
    res.json({ ok: true, removed: await listHidden() });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ---- catalog (filtered by the durable removal list, applied at serve time) ----
app.get("/data/catalog.json", async (_req, res) => {
  try {
    const cat = readCatalog();
    const hide = await hiddenSet();
    res.json(hide.size ? { ...cat, products: (cat.products || []).filter((p) => !hide.has(p.handle)) } : cat);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---- lead capture: record gate entries (public write, admin read) ----
app.post("/api/visit", async (req, res) => {
  const { company, email } = req.body || {};
  if (!email || !/.+@.+\..+/.test(String(email))) return res.json({ ok: false });
  try { await logVisit(company, email); res.json({ ok: true }); }
  catch (e) { console.warn("logVisit failed:", e.message); res.json({ ok: false }); }
});
app.get("/api/visits", adminAuth, async (_req, res) => {
  try { res.json({ visits: await listVisits() }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---- submit an order: email it to the wholesale team (+ optional buyer copy) ----
const ORDER_FROM = process.env.ORDER_FROM || process.env.EMAIL_FROM || "";
const ORDER_TEAM = (process.env.WHOLESALE_TEAM_EMAIL || "atarag@yakirabella.com,calev@yakirabella.com")
  .split(",").map((s) => s.trim()).filter(Boolean);

function accountForToken(token) {
  if (!token) return null;
  try {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, "build", "accounts.json"), "utf8"));
    const h = data.accounts?.[token];
    return h ? { name: h.name, slug: h.slug, customer_id: h.customer_id ?? null } : null;
  } catch { return null; }
}

const slugify = (s) => String(s || "").toLowerCase().replace(/['"]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "guest";

app.post("/api/orders", async (req, res) => {
  try {
    const { token, company, lines, notes, shipping, buyerEmail, sendReceipt } = req.body || {};
    // A per-account token wins (carries customer_id); otherwise use the company
    // name the visitor entered at the gate.
    const co = String(company || "").trim();
    const account = accountForToken(token) || { name: co || "Guest", slug: slugify(co || "guest"), customer_id: null };
    const cat = readCatalog();
    const { order, units, subtotal } = buildOrder({ account, lines, notes, shipping, catalog: cat });
    if (!order.items.length) return res.status(400).json({ ok: false, error: "Your cart had no orderable lines." });

    const email = String(buyerEmail || "").trim();
    const date = order.source_filename.match(/(\d{4}-\d{2}-\d{2})/)?.[1] || "";
    const base = `${account.slug}-${date}`;
    const csv = orderCSV(order);
    const json = JSON.stringify(order, null, 2);
    const summary = orderSummary({ order, units, subtotal, account, buyerEmail: email });

    if (!process.env.SENDGRID_API_KEY || !ORDER_FROM) {
      return res.status(503).json({ ok: false, error: "Order email isn't configured on the server (SENDGRID_API_KEY / ORDER_FROM)." });
    }
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    const attachments = [
      { content: Buffer.from(csv).toString("base64"), filename: `${base}.csv`, type: "text/csv", disposition: "attachment" },
      { content: Buffer.from(json).toString("base64"), filename: `${base}.json`, type: "application/json", disposition: "attachment" }
    ];
    await sgMail.send({
      to: ORDER_TEAM,
      from: ORDER_FROM,
      ...(email ? { replyTo: email } : {}),
      subject: `New wholesale order — ${account.name} — ${units} units / $${subtotal}`,
      text: `A new wholesale order came in through the portal.\n\n${summary}\n\nThe attached CSV uploads straight into the wholesale importer.`,
      attachments
    });
    if (sendReceipt && email) {
      await sgMail.send({
        to: email,
        from: ORDER_FROM,
        subject: `Your Yakira Bella wholesale order (${account.name})`,
        text: `Thanks! We received your order and will confirm shortly.\n\n${summary}`,
        attachments: [attachments[0]]
      }).catch((e) => console.warn("buyer receipt failed:", e.message));
    }
    res.json({ ok: true, ref: base, units, subtotal, styles: order.items.length, account: account.name });
  } catch (e) {
    const detail = e?.response?.body?.errors?.[0]?.message || e.message || String(e);
    res.status(500).json({ ok: false, error: detail });
  }
});

// ---- line sheet as Excel (same filtered set buyers see) ----
app.get("/api/linesheet.xlsx", async (_req, res) => {
  try {
    const cat = readCatalog();
    const hide = await hiddenSet();
    const filtered = hide.size ? { ...cat, products: (cat.products || []).filter((p) => !hide.has(p.handle)) } : cat;
    const buf = await lineSheetBuffer(filtered, { defaultLeadDays: Number(cat.delivery_default_days) || 14 });
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="yakira-bella-line-sheet-${date}.xlsx"`);
    res.send(Buffer.from(buf));
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/linesheet.pdf", async (req, res) => {
  try {
    const cat = readCatalog();
    const hide = await hiddenSet();
    const filtered = hide.size ? { ...cat, products: (cat.products || []).filter((p) => !hide.has(p.handle)) } : cat;
    const pdf = await lineSheetPdf(filtered, { defaultLeadDays: Number(cat.delivery_default_days) || 14 });
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="yakira-bella-line-sheet-${date}.pdf"`);
    res.send(Buffer.from(pdf));
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
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
