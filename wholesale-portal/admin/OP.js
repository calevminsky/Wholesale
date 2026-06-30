// In-season (Off Price) admin: one global pricing rule + a hand-picked product
// list. All endpoints are adminAuth-gated; the browser reuses the Basic
// credentials it used to load this page (same as FP.js).
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

// Which modes use the value field, and how it's labelled.
const VALUE_HINT = {
  ride_current: null,                 // no value — rides the current marked-down price
  pct_off_msrp: "% off MSRP",
  pct_off_current: "% off current",
  fixed: "Flat $ price"
};

const store = { products: [], pickSet: new Set(), overrides: {}, rule: { mode: "ride_current", value: 0 }, modes: [], onlyIn: false };

// ---------- load ----------
async function loadAll() {
  const { json } = await api("/api/offering/off/master");
  store.modes = json.modes || [];
  store.rule = json.pricing?.default || { mode: "ride_current", value: 0 };
  store.overrides = { ...(json.pricing?.overrides || {}) };
  store.pickSet = new Set(json.picks || []);
  store.products = json.products || [];
  if (json.missing) $("#missingWarn").style.display = "";
  renderRule();
  renderProducts();
}

// ---------- 1. rule ----------
function renderRule() {
  $("#ruleMode").innerHTML = store.modes.map((m) => `<option value="${m.id}" ${m.id === store.rule.mode ? "selected" : ""}>${esc(m.label)}</option>`).join("");
  $("#ruleValue").value = store.rule.value ?? 0;
  syncValueField();
}
function syncValueField() {
  const mode = $("#ruleMode").value;
  const hint = VALUE_HINT[mode];
  $("#valueFld").style.display = hint ? "" : "none";
  if (hint) $("#valueFld").querySelector("label").textContent = hint;
}
$("#ruleMode").addEventListener("change", syncValueField);
$("#saveRule").onclick = async () => {
  const mode = $("#ruleMode").value;
  const value = VALUE_HINT[mode] ? (parseFloat($("#ruleValue").value) || 0) : 0;
  const { ok, json } = await api("/api/offering/off", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pricing: { default: { mode, value } } })
  });
  if (!ok) return flash($("#ruleStatus"), json.error || "Failed.", false);
  flash($("#ruleStatus"), "Saved. Prices below updated.");
  await loadAll(); // refresh the previewed off prices
};

// ---------- 2. products ----------
function renderProducts() {
  const q = ($("#prodSearch").value || "").toLowerCase();
  let list = store.products.filter((p) => `${p.title} ${p.color || ""}`.toLowerCase().includes(q));
  if (store.onlyIn) list = list.filter((p) => store.pickSet.has(p.handle));
  const inCount = store.products.filter((p) => store.pickSet.has(p.handle)).length;
  $("#prodCount").textContent = `${list.length} shown · ${inCount} in offering`;
  $("#prodRows").innerHTML = list.map((p) => {
    const picked = store.pickSet.has(p.handle);
    const ovr = store.overrides[p.gid];
    return `<tr data-h="${esc(p.handle)}" data-gid="${esc(p.gid)}">
      <td>${p.image ? `<img class="thumb" src="${esc(p.image)}">` : ""}</td>
      <td><span class="tname">${esc(p.title)}</span><div class="tcolor">${esc(p.handle)}</div></td>
      <td class="num">${money(p.msrp)}</td>
      <td class="num off-price">${money(p.off_price)}</td>
      <td class="num"><input class="ovr" type="number" min="0" step="1" placeholder="—" value="${ovr ?? ""}"></td>
      <td class="num">${p.total_available ?? "—"}</td>
      <td><button class="btn sm toggle"><span class="pill ${picked ? "" : "out"}">${picked ? "In" : "Out"}</span></button></td>
    </tr>`;
  }).join("") || `<tr><td colspan="7" class="muted">No products.</td></tr>`;
  $$("#prodRows .toggle").forEach((b) => b.onclick = () => {
    const h = b.closest("tr").dataset.h;
    if (store.pickSet.has(h)) store.pickSet.delete(h); else store.pickSet.add(h);
    renderProducts();
  });
  $$("#prodRows .ovr").forEach((inp) => inp.oninput = () => {
    const gid = inp.closest("tr").dataset.gid;
    const v = parseFloat(inp.value);
    if (Number.isFinite(v) && v > 0) store.overrides[gid] = Math.round(v);
    else delete store.overrides[gid];
  });
}
$("#prodSearch").addEventListener("input", renderProducts);
$("#onlyInBtn").onclick = () => { store.onlyIn = !store.onlyIn; $("#onlyInBtn").classList.toggle("primary", store.onlyIn); renderProducts(); };
$("#saveProducts").onclick = async () => {
  const { ok, json } = await api("/api/offering/off", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ picks: [...store.pickSet], overrides: store.overrides })
  });
  if (!ok) return flash($("#productStatus"), json.error || "Failed.", false);
  flash($("#productStatus"), "Saved. Live for buyers now.");
  await loadAll();
};

loadAll();
