// In-season (Off Price) admin. The product universe is the frozen F26 snapshot
// (data/off-offering.json) — every style is in by default. This page only lets
// the admin remove a style or override its price. adminAuth-gated; the browser
// reuses the Basic credentials it used to load this page.
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

// Effective price for a row = pending override else baked off_price.
const effPrice = (p) => {
  const ov = store.overrides[p.gid];
  return Number.isFinite(Number(ov)) && Number(ov) > 0 ? Math.round(Number(ov)) : p.off_price;
};

const store = { products: [], removeSet: new Set(), overrides: {}, onlyOut: false };

async function loadAll() {
  const { json } = await api("/api/offering/off/master");
  if (json.missing) $("#missingWarn").style.display = "";
  store.products = json.products || [];
  store.removeSet = new Set(json.removes || []);
  store.overrides = {};
  for (const p of store.products) if (p.override != null) store.overrides[p.gid] = p.override;
  renderSummary();
  renderProducts();
}

function renderSummary() {
  const inN = store.products.filter((p) => !store.removeSet.has(p.handle)).length;
  const t = { Top: 0, Skirt: 0, Dress: 0 };
  for (const p of store.products) if (!store.removeSet.has(p.handle) && t[p.type] != null) t[p.type]++;
  let units = 0, val = 0;
  for (const p of store.products) {
    if (store.removeSet.has(p.handle)) continue;
    const u = Number(p.total_available) || 0;
    units += u; val += u * (effPrice(p) || 0);
  }
  $("#summary").innerHTML =
    `<span><b>${inN}</b> / ${store.products.length} styles in offering</span>` +
    `<span><b>${t.Top}</b> tops · <b>${t.Skirt}</b> skirts · <b>${t.Dress}</b> dresses</span>` +
    `<span><b>${units.toLocaleString()}</b> units · <b>${money(val)}</b> at off price</span>`;
}

function renderProducts() {
  const q = ($("#prodSearch").value || "").toLowerCase();
  let list = store.products.filter((p) => `${p.title} ${p.color || ""}`.toLowerCase().includes(q));
  if (store.onlyOut) list = list.filter((p) => store.removeSet.has(p.handle));
  $("#prodCount").textContent = `${list.length} shown`;
  $("#prodRows").innerHTML = list.map((p) => {
    const inOff = !store.removeSet.has(p.handle);
    const ov = store.overrides[p.gid];
    return `<tr data-h="${esc(p.handle)}" data-gid="${esc(p.gid)}" class="${inOff ? "" : "out"}">
      <td>${p.image ? `<img class="thumb" src="${esc(p.image)}">` : ""}</td>
      <td><span class="tname">${esc(p.title)}</span><div class="tcolor">${esc(p.handle)}</div></td>
      <td><span class="tpill ${esc(p.type)}">${esc(p.type || "")}</span></td>
      <td class="num">${money(p.msrp)}</td>
      <td class="num"><input class="price" type="number" min="0" step="1" value="${ov != null ? ov : (p.off_price ?? "")}"></td>
      <td class="num">${p.total_available ?? "—"}</td>
      <td><button class="btn sm toggle"><span class="pill ${inOff ? "" : "out"}">${inOff ? "In" : "Out"}</span></button></td>
    </tr>`;
  }).join("") || `<tr><td colspan="7" class="muted">No products.</td></tr>`;
  $$("#prodRows .toggle").forEach((b) => b.onclick = () => {
    const h = b.closest("tr").dataset.h;
    if (store.removeSet.has(h)) store.removeSet.delete(h); else store.removeSet.add(h);
    renderProducts(); renderSummary();
  });
  $$("#prodRows .price").forEach((inp) => inp.oninput = () => {
    const p = store.products.find((x) => x.gid === inp.closest("tr").dataset.gid);
    const v = parseFloat(inp.value);
    // Store an override only when it differs from the baked off_price.
    if (Number.isFinite(v) && v > 0 && Math.round(v) !== p.off_price) store.overrides[p.gid] = Math.round(v);
    else delete store.overrides[p.gid];
    renderSummary();
  });
}
$("#prodSearch").addEventListener("input", renderProducts);
$("#onlyOutBtn").onclick = () => { store.onlyOut = !store.onlyOut; $("#onlyOutBtn").classList.toggle("on", store.onlyOut); renderProducts(); };
$("#saveBtn").onclick = async () => {
  const { ok, json } = await api("/api/offering/off", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ removes: [...store.removeSet], overrides: store.overrides })
  });
  if (!ok) return flash($("#saveStatus"), json.error || "Failed.", false);
  flash($("#saveStatus"), "Saved. Live for buyers now.");
  await loadAll();
};

loadAll();
