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
import { loadEtaOverrides } from "./build/eta-overrides.mjs";
import { initAdminSettings, getAdminSetting, setAdminSetting } from "./build/admin-settings-store.mjs";
import { getHiddenHandles, listHidden, addHidden, removeHidden } from "./build/hidden-store.mjs";
import { lineSheetBuffer } from "./build/linesheet-xlsx.mjs";
import { lineSheetPdf } from "./build/linesheet-pdf.mjs";
import { buildOrder, orderCSV, orderSummary } from "./build/orderfile.mjs";
import { buyerReceiptHtml, teamNotificationHtml } from "./build/email-templates.mjs";
import { logVisit, listVisits } from "./build/visits-store.mjs";
import { saveOrder, listOrders, getOrderCsv } from "./build/orders-store.mjs";
import { readFullOffering, buildSeasonCatalog, buildSeasonOrder, postDraftToImporter, readOffOffering, buildOffCatalog, buildOffOrder, applyOrder } from "./build/season.mjs";
import {
  getFullOfferingConfig, setFullOfferingConfig,
  getAccountsPricing, setAccountsPricing, resolveAccountPricing,
  VALID_FULL_LEVELS
} from "./build/offering-store.mjs";
import { getOffConfig, setOffConfig } from "./build/off-offering-store.mjs";
import {
  hashPassword, verifyPassword, signSession, verifySession, sessionConfigured, SESSION_COOKIE,
  getUserForAuth, listUsers, upsertUser, deleteUser, updateLastLogin
} from "./build/auth-store.mjs";
import { listCustomers } from "./build/customers-store.mjs";
// Mailgun — called via the REST API directly (no extra package needed in Node 18+).
async function sendMail({ from, to, replyTo, subject, text, html, attachments = [] }) {
  const key = process.env.MAILGUN_API_KEY;
  const domain = process.env.MAILGUN_DOMAIN;
  if (!key || !domain) throw new Error("MAILGUN_API_KEY or MAILGUN_DOMAIN not set");
  const form = new FormData();
  form.append("from", from);
  (Array.isArray(to) ? to : [to]).forEach((t) => form.append("to", t));
  if (replyTo) form.append("h:Reply-To", replyTo);
  form.append("subject", subject);
  form.append("text", text);
  if (html) form.append("html", html);
  for (const a of attachments) {
    form.append("attachment", new Blob([a.content], { type: a.type }), a.filename);
  }
  const auth = Buffer.from(`api:${key}`).toString("base64");
  const res = await fetch(`https://api.mailgun.net/v3/${domain}/messages`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}` },
    body: form
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Mailgun ${res.status}: ${detail.slice(0, 200)}`);
  }
}

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

// ---- ETA overrides (serve-time, no rebuild needed) ----
// Stored in Postgres so git commits can never accidentally wipe them.
// Loaded from DB at startup; updated in-memory when admin saves.
let _etaOverrides = {};
function etaOverridesMap() { return _etaOverrides; }

// Shared helper: apply hidden-product filter + ETA overrides, used by all three
// buyer-facing catalog/linesheet endpoints so they all stay consistent.
async function catalogForBuyers() {
  const cat = readCatalog();
  const hide = await hiddenSet();
  const etas = etaOverridesMap();
  let products = cat.products || [];
  if (hide.size) products = products.filter((p) => !hide.has(p.handle));
  if (Object.keys(etas).length) {
    products = products.map((p) => {
      const ov = etas[p.gid];
      return ov !== undefined ? { ...p, est_delivery: ov || null } : p;
    });
  }
  return { ...cat, products };
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
// In-season admins: Full Price (/admin/FP) and Off Price (/admin/OP), both live.
app.get("/admin/FP", adminAuth, (_req, res) => res.sendFile(path.join(__dirname, "admin", "FP.html")));
app.get("/admin/FP.js", adminAuth, (_req, res) => res.sendFile(path.join(__dirname, "admin", "FP.js")));
app.get("/admin/OP", adminAuth, (_req, res) => res.sendFile(path.join(__dirname, "admin", "OP.html")));
app.get("/admin/OP.js", adminAuth, (_req, res) => res.sendFile(path.join(__dirname, "admin", "OP.js")));
// Alias: /op/admin (and its script) -> the same Off Price admin page.
app.get("/op/admin", adminAuth, (_req, res) => res.sendFile(path.join(__dirname, "admin", "OP.html")));
app.get("/op/admin.js", adminAuth, (_req, res) => res.sendFile(path.join(__dirname, "admin", "OP.js")));
// Back-compat: the old /admin/season path now points at Full Price.
app.get("/admin/season", adminAuth, (_req, res) => res.redirect("/admin/FP"));

// ---- in-season portal page (login-gated client-side; APIs enforce the session) ----
app.get(["/season", "/season/"], (_req, res) => res.sendFile(path.join(__dirname, "season", "index.html")));
// Direct Off Price link — same page, but the client skips the gate and opens
// straight into Off Price (company + email is collected at checkout instead).
app.get(["/offprice", "/offprice/"], (_req, res) => res.sendFile(path.join(__dirname, "season", "index.html")));

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
    persistFileToGit("wholesale-portal/build/off-pricing.json", JSON.stringify(loadOffPricing(), null, 2))
      .catch((e) => console.warn("off-pricing git persist failed:", e.message));
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

// Persist a file to git via the Contents API so it survives Render redeploys.
// Fire-and-forget — callers don't await; failures are logged but don't block the response.
async function persistFileToGit(repoPath, content) {
  const token = process.env.GITHUB_DISPATCH_TOKEN;
  if (!token) return;
  const apiUrl = `https://api.github.com/repos/${GH_REPO}/contents/${repoPath}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "yb-wholesale-portal"
  };
  const getRes = await fetch(apiUrl, { headers });
  const sha = getRes.ok ? (await getRes.json()).sha : undefined;
  const body = { message: `Admin: update ${repoPath.split("/").pop()}`, content: Buffer.from(content).toString("base64") };
  if (sha) body.sha = sha;
  const putRes = await fetch(apiUrl, { method: "PUT", headers, body: JSON.stringify(body) });
  if (!putRes.ok) throw new Error(`GitHub Contents API ${putRes.status}`);
}
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

// ---- ETA override API (admin only) ----
app.get("/api/eta-overrides", adminAuth, (_req, res) => {
  res.json({ overrides: etaOverridesMap() });
});

app.post("/api/eta-overrides", adminAuth, async (req, res) => {
  try {
    const raw = req.body?.overrides || {};
    const clean = {};
    for (const [gid, date] of Object.entries(raw)) {
      if (date && /^\d{4}-\d{2}-\d{2}$/.test(String(date))) clean[gid] = date;
    }
    await setAdminSetting("eta-overrides", clean);
    _etaOverrides = clean;
    res.json({ ok: true, saved: clean });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ---- catalog (hidden filter + ETA overrides applied at serve time) ----
app.get("/data/catalog.json", async (_req, res) => {
  try {
    res.json(await catalogForBuyers());
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

app.get("/api/orders", adminAuth, async (_req, res) => {
  try { res.json({ orders: await listOrders() }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.get("/api/orders/:id/csv", adminAuth, async (req, res) => {
  try {
    const result = await getOrderCsv(req.params.id);
    if (!result) return res.status(404).json({ error: "Order not found" });
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${result.ref}.csv"`);
    res.send(result.csv);
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
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

    // Always save to DB first — the admin log works even if email isn't configured.
    saveOrder({ ref: base, accountName: account.name, buyerEmail: email, units, subtotal, order })
      .catch((e) => console.warn("saveOrder failed:", e.message));

    if (!process.env.MAILGUN_API_KEY || !process.env.MAILGUN_DOMAIN || !ORDER_FROM) {
      return res.status(503).json({ ok: false, error: "Order email isn't configured on the server (MAILGUN_API_KEY / MAILGUN_DOMAIN / ORDER_FROM)." });
    }
    const attachments = [
      { content: Buffer.from(csv), filename: `${base}.csv`, type: "text/csv" },
      { content: Buffer.from(json), filename: `${base}.json`, type: "application/json" }
    ];
    await sendMail({
      to: ORDER_TEAM,
      from: ORDER_FROM,
      replyTo: email || undefined,
      subject: `New wholesale order — ${account.name} — ${units} units / $${subtotal}`,
      text: `New wholesale order from ${account.name}. ${units} units · $${subtotal}. CSV attached.`,
      html: teamNotificationHtml({ order, units, subtotal, account, buyerEmail: email, ref: base }),
      attachments
    });
    if (sendReceipt && email) {
      sendMail({
        to: email,
        from: ORDER_FROM,
        subject: `Your Yakira Bella wholesale order — ${account.name}`,
        text: `Thanks! We received your order and will confirm shortly.\n\n${summary}`,
        html: buyerReceiptHtml({ order, units, subtotal, account, ref: base }),
        attachments: [attachments[0]]
      }).catch((e) => console.warn("buyer receipt failed:", e.message));
    }
    res.json({ ok: true, ref: base, units, subtotal, styles: order.items.length, account: account.name });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// ============================================================================
// In-season ("current season") offerings — Full Price tab. Separate, additive
// surface: none of the F26 routes above are touched. Catalog source is
// data/full-offering.json (build-full-offering.mjs); pricing is per-account.
// ============================================================================

// ---- session cookie helpers (manual parse; no cookie-parser dep) ----
function readCookie(req, name) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq > -1 && part.slice(0, eq) === name) return decodeURIComponent(part.slice(eq + 1));
  }
  return null;
}
function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === "production";
  const attrs = [`${SESSION_COOKIE}=${encodeURIComponent(token)}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${60 * 60 * 24 * 30}`];
  if (secure) attrs.push("Secure");
  res.append("Set-Cookie", attrs.join("; "));
}
function clearSessionCookie(res) {
  res.append("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// Resolve the logged-in account (+ pricing/entitlements) from the session cookie.
// Returns null when there's no valid session.
async function seasonAccountFromReq(req) {
  const session = verifySession(readCookie(req, SESSION_COOKIE));
  if (!session?.email) return null;
  const user = await getUserForAuth(session.email).catch(() => null);
  if (!user) return null; // user removed since the session was issued
  const account = {
    name: user.account_name || user.email,
    slug: slugify(user.account_name || user.email),
    customer_id: user.customer_id ?? null
  };
  const map = await getAccountsPricing().catch(() => ({}));
  const pricing = resolveAccountPricing(map, account.customer_id);
  return { account, pricing, email: user.email };
}

// Require a valid session; 401 otherwise. Attaches req.season = {account,pricing,email}.
async function requireSeasonSession(req, res, next) {
  try {
    const ctx = await seasonAccountFromReq(req);
    if (!ctx) return res.status(401).json({ ok: false, error: "Not signed in." });
    req.season = ctx;
    next();
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}

// ---- login / logout / me ----
app.post("/api/season/login", async (req, res) => {
  try {
    if (!sessionConfigured()) return res.status(503).json({ ok: false, error: "Login isn't configured on the server (SESSION_SECRET)." });
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    if (!email || !password) return res.status(400).json({ ok: false, error: "Email and password are required." });
    const user = await getUserForAuth(email);
    // Same generic message whether the email is unknown or the password is wrong.
    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ ok: false, error: "Incorrect email or password." });
    }
    setSessionCookie(res, signSession({ email: user.email, customer_id: user.customer_id }));
    updateLastLogin(user.email);
    res.json({ ok: true, account: { name: user.account_name || user.email, customer_id: user.customer_id ?? null } });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/api/season/logout", (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get("/api/season/me", async (req, res) => {
  const ctx = await seasonAccountFromReq(req).catch(() => null);
  if (!ctx) return res.json({ account: null });
  res.json({
    account: { name: ctx.account.name, customer_id: ctx.account.customer_id, email: ctx.email },
    // Off Price is open to every signed-in account (one global rule, no per-account gate).
    entitlements: { full: ctx.pricing.full_enabled, off: true },
    pricing: { full_level: ctx.pricing.full_level }
  });
});

// Buyer-facing per-account catalog for a tab (offering=full | off). Login required.
app.get("/api/season/catalog", requireSeasonSession, async (req, res) => {
  try {
    const offering = String(req.query.offering || "full");
    if (offering !== "full" && offering !== "off") return res.status(404).json({ error: "Unknown offering." });
    const { account, pricing } = req.season;

    // ---- Off Price: frozen F26 snapshot, all-in minus admin removes ----
    if (offering === "off") {
      const master = readOffOffering();
      if (master.missing) {
        return res.status(503).json({ error: "The Off Price offering hasn't been built yet (run build-off-offering)." });
      }
      const cfg = await getOffConfig().catch(() => ({ removes: [], overrides: {}, order: [] }));
      const hidden = await hiddenSet();
      const products = buildOffCatalog({ master, removes: cfg.removes, hidden, overrides: cfg.overrides, order: cfg.order });
      return res.json({
        offering: "off",
        offer: "INSEASON",
        currency: master.currency || "USD",
        size_order: master.size_order,
        delivery_default_days: master.delivery_default_days || 14,
        generated_at: master.generated_at || null,
        account: { name: account.name, slug: account.slug, customer_id: account.customer_id },
        entitlements: { off: true },
        counts: { products: products.length },
        products
      });
    }

    if (!pricing.full_enabled) return res.status(403).json({ error: "This account isn't enabled for the Full Price offering." });
    const master = readFullOffering();
    if (master.missing) {
      return res.status(503).json({ error: "The Full Price offering hasn't been built yet (run build-full-offering)." });
    }
    const { removes } = await getFullOfferingConfig().catch(() => ({ removes: [] }));
    const hidden = await hiddenSet();
    const products = buildSeasonCatalog({ master, removes, hidden, level: pricing.full_level });
    res.json({
      offering: "full",
      offer: "INSEASON",
      currency: master.currency || "USD",
      size_order: master.size_order,
      delivery_default_days: master.delivery_default_days || 14,
      generated_at: master.generated_at || null,
      account: { name: account.name, slug: account.slug, customer_id: account.customer_id },
      entitlements: { full: pricing.full_enabled },
      pricing: { full_level: pricing.full_level },
      counts: { products: products.length },
      products
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Submit an in-season order -> create a DRAFT in the importer (allocation runs
// there). Login required; server-authoritative pricing.
app.post("/api/season/orders", requireSeasonSession, async (req, res) => {
  try {
    const { offering, lines, notes, shipping } = req.body || {};
    if (offering && offering !== "full" && offering !== "off") return res.status(400).json({ ok: false, error: "Unknown offering." });
    const { account, pricing, email } = req.season;

    // ---- Off Price order: frozen snapshot, server-authoritative pricing ----
    if (offering === "off") {
      const offMaster = readOffOffering();
      if (offMaster.missing) return res.status(503).json({ ok: false, error: "Off Price offering not built yet." });
      const cfg = await getOffConfig().catch(() => ({ removes: [], overrides: {} }));
      const { order, units, subtotal } = buildOffOrder({ account, lines, notes, shipping, master: offMaster, removes: cfg.removes, overrides: cfg.overrides });
      if (!order.items.length) return res.status(400).json({ ok: false, error: "Your cart had no orderable lines." });
      const result = await postDraftToImporter(order);
      if (!result.ok) return res.status(502).json({ ok: false, error: result.error });
      saveOrder({ ref: `${account.slug}-off-${order.source_filename.match(/(\d{4}-\d{2}-\d{2})/)?.[1] || ""}`, accountName: account.name, buyerEmail: email, units, subtotal, order })
        .catch((e) => console.warn("season(off) saveOrder failed:", e.message));
      return res.json({ ok: true, draft_id: result.order?.id ?? null, units, subtotal, styles: order.items.length, account: account.name });
    }

    const master = readFullOffering();
    if (master.missing) return res.status(503).json({ ok: false, error: "Offering not built yet." });
    if (!pricing.full_enabled) return res.status(403).json({ ok: false, error: "This account isn't enabled for the Full Price offering." });

    const { order, units, subtotal } = buildSeasonOrder({ account, lines, notes, shipping, level: pricing.full_level, master });
    if (!order.items.length) return res.status(400).json({ ok: false, error: "Your cart had no orderable lines." });

    const result = await postDraftToImporter(order);
    if (!result.ok) return res.status(502).json({ ok: false, error: result.error });

    // Log to the portal's own order table too (best-effort, mirrors /api/orders).
    saveOrder({ ref: `${account.slug}-${order.source_filename.match(/(\d{4}-\d{2}-\d{2})/)?.[1] || ""}`, accountName: account.name, buyerEmail: email, units, subtotal, order })
      .catch((e) => console.warn("season saveOrder failed:", e.message));

    res.json({
      ok: true,
      draft_id: result.order?.id ?? null,
      units, subtotal, styles: order.items.length,
      account: account.name, level: pricing.full_level
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ============================================================================
// Off Price — PUBLIC (no login). Pricing is one global rule for everyone, so
// there's nothing per-account to gate: buyers just enter company + email (like
// the F26 portal) and browse/order. Orders still route to the importer as drafts.
// ============================================================================
app.get("/api/offprice/catalog", async (_req, res) => {
  try {
    const master = readOffOffering();
    if (master.missing) return res.status(503).json({ error: "The Off Price offering hasn't been built yet." });
    const cfg = await getOffConfig().catch(() => ({ removes: [], overrides: {}, order: [] }));
    const hidden = await hiddenSet();
    const products = buildOffCatalog({ master, removes: cfg.removes, hidden, overrides: cfg.overrides, order: cfg.order });
    res.json({
      offering: "off", offer: "INSEASON", currency: master.currency || "USD",
      size_order: master.size_order, delivery_default_days: master.delivery_default_days || 14,
      generated_at: master.generated_at || null, counts: { products: products.length }, products
    });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.post("/api/offprice/orders", async (req, res) => {
  try {
    const { company, email, lines, notes, shipping } = req.body || {};
    const co = String(company || "").trim();
    if (!co) return res.status(400).json({ ok: false, error: "Please enter your company name." });
    const account = { name: co, slug: slugify(co), customer_id: null };
    const master = readOffOffering();
    if (master.missing) return res.status(503).json({ ok: false, error: "Off Price offering not built yet." });
    const cfg = await getOffConfig().catch(() => ({ removes: [], overrides: {}, order: [] }));
    const { order, units, subtotal } = buildOffOrder({ account, lines, notes, shipping, master, removes: cfg.removes, overrides: cfg.overrides });
    if (!order.items.length) return res.status(400).json({ ok: false, error: "Your cart had no orderable lines." });
    const result = await postDraftToImporter(order);
    if (!result.ok) return res.status(502).json({ ok: false, error: result.error });
    const buyerEmail = String(email || "").trim();
    saveOrder({ ref: `${account.slug}-off-${order.source_filename.match(/(\d{4}-\d{2}-\d{2})/)?.[1] || ""}`, accountName: account.name, buyerEmail, units, subtotal, order })
      .catch((e) => console.warn("offprice saveOrder failed:", e.message));
    if (buyerEmail) logVisit(co, buyerEmail).catch(() => {}); // lead capture, same as the gate
    res.json({ ok: true, draft_id: result.order?.id ?? null, units, subtotal, styles: order.items.length, account: account.name });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// ---- admin: offering curation (adds/removes) ----
app.get("/api/offering/full", adminAuth, async (_req, res) => {
  try { res.json(await getFullOfferingConfig()); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post("/api/offering/full", adminAuth, async (req, res) => {
  try {
    const saved = await setFullOfferingConfig({ adds: req.body?.adds, removes: req.body?.removes });
    res.json({ ok: true, saved });
  } catch (e) { res.status(400).json({ ok: false, error: String(e.message || e) }); }
});

// Admin: the full discovered universe (unpriced, removes NOT applied) so the
// curation UI can show every product with an in/out toggle.
app.get("/api/offering/full/master", adminAuth, async (_req, res) => {
  try {
    const master = readFullOffering();
    const cfg = await getFullOfferingConfig().catch(() => ({ adds: [], removes: [] }));
    const products = (master.products || []).map((p) => ({
      handle: p.handle, title: p.title, color: p.color, image: p.image,
      msrp: p.msrp, total_available: p.total_available
    }));
    res.json({ generated_at: master.generated_at || null, missing: !!master.missing, products, ...cfg });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---- admin: Off Price offering (frozen snapshot; remove or re-price styles) ----
app.get("/api/offering/off", adminAuth, async (_req, res) => {
  try { res.json(await getOffConfig()); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post("/api/offering/off", adminAuth, async (req, res) => {
  try {
    const saved = await setOffConfig({ removes: req.body?.removes, overrides: req.body?.overrides, order: req.body?.order });
    res.json({ ok: true, saved });
  } catch (e) { res.status(400).json({ ok: false, error: String(e.message || e) }); }
});

// Admin: the full Off Price snapshot (in the saved display order) with each
// style's effective price and whether it's currently in the offering.
app.get("/api/offering/off/master", adminAuth, async (_req, res) => {
  try {
    const master = readOffOffering();
    const cfg = await getOffConfig().catch(() => ({ removes: [], overrides: {}, order: [] }));
    const removeSet = new Set(cfg.removes);
    const ordered = applyOrder(master.products || [], cfg.order);
    const products = ordered.map((p) => ({
      handle: p.handle, title: p.title, color: p.color, image: p.image, gid: p.gid, type: p.type,
      msrp: p.msrp, compare_at: p.compare_at, current_price: p.current_price,
      total_available: p.total_available,
      off_price: p.off_price ?? null,
      override: cfg.overrides[p.gid] ?? null,
      in_offering: !removeSet.has(p.handle)
    }));
    res.json({ generated_at: master.generated_at || null, missing: !!master.missing, rule: master.rule || null, products, removes: cfg.removes, order: cfg.order });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---- admin: per-account pricing/entitlements ----
app.get("/api/accounts-pricing", adminAuth, async (_req, res) => {
  try { res.json({ accounts: await getAccountsPricing(), valid_levels: VALID_FULL_LEVELS }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post("/api/accounts-pricing", adminAuth, async (req, res) => {
  try {
    const saved = await setAccountsPricing(req.body?.accounts || {});
    res.json({ ok: true, saved });
  } catch (e) { res.status(400).json({ ok: false, error: String(e.message || e) }); }
});

// ---- admin: known accounts (id + name) to map users/pricing against ----
// Pulled LIVE from the importer's `customers` table so the admin sees every
// current account. Falls back to the build/accounts.json snapshot only if the
// DB is unreachable. Returns no tokens or emails.
app.get("/api/accounts-list", adminAuth, async (_req, res) => {
  try {
    const accounts = await listCustomers();
    res.json({ accounts });
  } catch (e) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(__dirname, "build", "accounts.json"), "utf8"));
      const seen = new Map();
      for (const a of Object.values(data.accounts || {})) {
        if (a?.customer_id != null && !seen.has(a.customer_id)) seen.set(a.customer_id, a.name);
      }
      const accounts = [...seen.entries()].map(([customer_id, name]) => ({ customer_id, name }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
      res.json({ accounts, fallback: true, error: String(e.message || e) });
    } catch (e2) {
      res.json({ accounts: [], error: String(e.message || e) });
    }
  }
});

// ---- admin: login allowlist (in-season portal users) ----
app.get("/api/season-users", adminAuth, async (_req, res) => {
  try { res.json({ users: await listUsers(), session_configured: sessionConfigured() }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post("/api/season-users", adminAuth, async (req, res) => {
  try {
    const saved = await upsertUser({
      email: req.body?.email,
      customer_id: req.body?.customer_id != null && req.body.customer_id !== "" ? parseInt(req.body.customer_id, 10) : null,
      account_name: req.body?.account_name,
      password: req.body?.password || null
    });
    res.json({ ok: true, saved });
  } catch (e) { res.status(400).json({ ok: false, error: String(e.message || e) }); }
});
app.delete("/api/season-users/:email", adminAuth, async (req, res) => {
  try { await deleteUser(req.params.email); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// ---- line sheet as Excel (same filtered set buyers see) ----
app.get("/api/linesheet.xlsx", async (_req, res) => {
  try {
    const cat = await catalogForBuyers();
    const buf = await lineSheetBuffer(cat, { defaultLeadDays: Number(cat.delivery_default_days) || 14 });
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="yakira-bella-line-sheet-${date}.xlsx"`);
    res.send(Buffer.from(buf));
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/linesheet.pdf", async (_req, res) => {
  try {
    const cat = await catalogForBuyers();
    const pdf = await lineSheetPdf(cat, { defaultLeadDays: Number(cat.delivery_default_days) || 14 });
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

async function start() {
  try {
    const fileEta = loadEtaOverrides();
    await initAdminSettings(Object.keys(fileEta).length ? { "eta-overrides": fileEta } : {});
    _etaOverrides = (await getAdminSetting("eta-overrides")) || {};
    console.log(`ETA overrides loaded from Postgres (${Object.keys(_etaOverrides).length} entries)`);
  } catch (e) {
    console.error("Admin settings init failed — falling back to file:", e.message);
    _etaOverrides = loadEtaOverrides();
  }
  app.listen(PORT, () => console.log(`Wholesale portal on :${PORT}  (admin at /admin${process.env.ADMIN_PASSWORD ? "" : " — OPEN, set ADMIN_PASSWORD"})`));
}
start();
