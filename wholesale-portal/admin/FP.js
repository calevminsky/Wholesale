// In-season (Full Price) admin: login allowlist, per-account pricing/access, and
// product curation. All endpoints are adminAuth-gated; the browser reuses the
// Basic credentials it used to load this page (same as admin.js).
"use strict";
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const money = (n) => (n == null ? "—" : "$" + Math.round(Number(n)).toLocaleString());

async function api(path, opts) {
  const res = await fetch(path, opts);
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}
function flash(el, msg, ok = true) {
  el.textContent = msg;
  el.className = "status " + (ok ? "ok" : "err");
  setTimeout(() => { el.textContent = ""; el.className = "status"; }, 4000);
}

const VALID_LEVELS = [50, 40];
const store = { accounts: [], users: [], pricing: {}, master: { products: [], adds: [], removes: [] }, removeSet: new Set(), adds: [] };

// ---------- load everything ----------
async function loadAll() {
  const [acc, users, pricing, master] = await Promise.all([
    api("/api/accounts-list"),
    api("/api/season-users"),
    api("/api/accounts-pricing"),
    api("/api/offering/full/master")
  ]);
  store.accounts = acc.json.accounts || [];
  store.users = users.json.users || [];
  if (users.json.session_configured === false) $("#sessWarn").style.display = "";
  store.pricing = pricing.json.accounts || {};
  store.master = master.json || { products: [] };
  store.removeSet = new Set(store.master.removes || []);
  store.adds = [...(store.master.adds || [])];
  renderAccountSelect();
  renderUsers();
  renderPricing();
  renderProducts();
  renderAdds();
}

const accountName = (cid) => store.accounts.find((a) => String(a.customer_id) === String(cid))?.name || `#${cid}`;

// ---------- 1. allowlist ----------
function renderAccountSelect() {
  $("#uAccount").innerHTML = `<option value="">— select account —</option>` +
    store.accounts.map((a) => `<option value="${a.customer_id}">${esc(a.name)}</option>`).join("");
}
function renderUsers() {
  $("#userRows").innerHTML = store.users.length ? store.users.map((u) => `
    <tr>
      <td>${esc(u.email)}</td>
      <td>${esc(u.account_name || (u.customer_id != null ? accountName(u.customer_id) : "—"))}</td>
      <td class="muted">${u.last_login ? new Date(u.last_login).toLocaleDateString() : "never"}</td>
      <td><button class="btn sm danger" data-del="${esc(u.email)}">Remove</button></td>
    </tr>`).join("") : `<tr><td colspan="4" class="muted">No users yet.</td></tr>`;
  $$("#userRows [data-del]").forEach((b) => b.onclick = async () => {
    if (!confirm(`Remove ${b.dataset.del}?`)) return;
    await api(`/api/season-users/${encodeURIComponent(b.dataset.del)}`, { method: "DELETE" });
    await loadAll();
  });
}
$("#saveUser").onclick = async () => {
  const email = $("#uEmail").value.trim();
  const customer_id = $("#uAccount").value;
  const account_name = customer_id ? accountName(customer_id) : "";
  const password = $("#uPassword").value;
  if (!email) return flash($("#userStatus"), "Email required.", false);
  const { ok, json } = await api("/api/season-users", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, customer_id, account_name, password })
  });
  if (!ok) return flash($("#userStatus"), json.error || "Failed.", false);
  $("#uEmail").value = ""; $("#uPassword").value = ""; $("#uAccount").value = "";
  flash($("#userStatus"), "Saved.");
  await loadAll();
};

// ---------- 2. pricing ----------
function renderPricing() {
  const q = ($("#acctSearch").value || "").toLowerCase();
  const list = store.accounts.filter((a) => a.name.toLowerCase().includes(q));
  $("#acctCount").textContent = `${list.length} accounts`;
  $("#acctRows").innerHTML = list.map((a) => {
    const rec = store.pricing[String(a.customer_id)] || {};
    const level = VALID_LEVELS.includes(Number(rec.full_level)) ? Number(rec.full_level) : 50;
    const enabled = rec.full_enabled !== false;
    return `<tr data-cid="${a.customer_id}">
      <td class="tname">${esc(a.name)}</td>
      <td><select class="pLevel">${VALID_LEVELS.map((v) => `<option value="${v}" ${v === level ? "selected" : ""}>${v}% of MSRP</option>`).join("")}</select></td>
      <td><label class="muted"><input type="checkbox" class="pEnabled" ${enabled ? "checked" : ""}> visible</label></td>
    </tr>`;
  }).join("");
}
$("#acctSearch").addEventListener("input", renderPricing);
$("#savePricing").onclick = async () => {
  // Read current rows into the in-memory map (so search-filtered edits persist),
  // then keep only non-default entries.
  $$("#acctRows tr").forEach((tr) => {
    const cid = tr.dataset.cid;
    store.pricing[cid] = { full_level: Number(tr.querySelector(".pLevel").value), full_enabled: tr.querySelector(".pEnabled").checked };
  });
  const map = {};
  for (const [cid, v] of Object.entries(store.pricing)) {
    if (Number(v.full_level) !== 50 || v.full_enabled === false) map[cid] = v;
  }
  const { ok, json } = await api("/api/accounts-pricing", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accounts: map })
  });
  if (!ok) return flash($("#pricingStatus"), json.error || "Failed.", false);
  store.pricing = json.saved || map;
  flash($("#pricingStatus"), "Saved.");
};

// ---------- 3. curation ----------
function renderProducts() {
  const q = ($("#prodSearch").value || "").toLowerCase();
  const list = (store.master.products || []).filter((p) => `${p.title} ${p.color || ""}`.toLowerCase().includes(q));
  const shown = list.length, removed = list.filter((p) => store.removeSet.has(p.handle)).length;
  $("#prodCount").textContent = store.master.missing ? "catalog not built yet" : `${shown} styles · ${removed} removed`;
  $("#prodRows").innerHTML = list.map((p) => {
    const inOffering = !store.removeSet.has(p.handle);
    return `<tr>
      <td>${p.image ? `<img class="thumb" src="${esc(p.image)}">` : ""}</td>
      <td><span class="tname">${esc(p.title)}</span><div class="tcolor">${esc(p.handle)}</div></td>
      <td class="num">${money(p.msrp)}</td>
      <td class="num">${p.total_available ?? "—"}</td>
      <td><button class="btn sm toggle" data-h="${esc(p.handle)}">
        <span class="pill ${inOffering ? "" : "out"}">${inOffering ? "In" : "Removed"}</span>
      </button></td>
    </tr>`;
  }).join("") || `<tr><td colspan="5" class="muted">No products.</td></tr>`;
  $$("#prodRows .toggle").forEach((b) => b.onclick = () => {
    const h = b.dataset.h;
    if (store.removeSet.has(h)) store.removeSet.delete(h); else store.removeSet.add(h);
    renderProducts();
  });
}
$("#prodSearch").addEventListener("input", renderProducts);
function renderAdds() {
  $("#addsList").innerHTML = store.adds.length
    ? "Force-added: " + store.adds.map((h) => `${esc(h)} <a href="#" data-rmadd="${esc(h)}" style="color:var(--accent)">✕</a>`).join(", ")
    : "";
  $$("#addsList [data-rmadd]").forEach((a) => a.onclick = (e) => { e.preventDefault(); store.adds = store.adds.filter((x) => x !== a.dataset.rmadd); renderAdds(); });
}
$("#addBtn").onclick = () => {
  const h = $("#addHandle").value.trim();
  if (h && !store.adds.includes(h)) store.adds.push(h);
  $("#addHandle").value = "";
  renderAdds();
};
$("#saveOffering").onclick = async () => {
  const { ok, json } = await api("/api/offering/full", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ adds: store.adds, removes: [...store.removeSet] })
  });
  if (!ok) return flash($("#offeringStatus"), json.error || "Failed.", false);
  flash($("#offeringStatus"), "Saved. Removes apply now; force-adds apply on next catalog build.");
};

loadAll();
