// In-season (Off Price) admin. Universe = frozen F26 snapshot (off-offering.json),
// all styles In by default. This page lets the admin: remove a style, override
// its price, and set the buyer-facing display order (drag the ⠿ handle, or
// multi-select + Move). adminAuth-gated; reuses the page's Basic credentials.
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

// This page serves two offerings, chosen by path: /op/admin -> "off",
// /op/admin/all -> "offall".
const OID = location.pathname.replace(/\/+$/, "").endsWith("/all") ? "offall" : "off";
const BASE = "/api/offering/" + OID;
if (OID === "offall") {
  document.title = "Yakira Bella — Off Price (All) Admin";
  const h1 = document.querySelector("header.top h1");
  if (h1) h1.childNodes[h1.childNodes.length - 1].textContent = "Off Price — All";
}

const effPrice = (p) => {
  const ov = store.overrides[p.gid];
  return Number.isFinite(Number(ov)) && Number(ov) > 0 ? Math.round(Number(ov)) : p.off_price;
};

// store.products is the canonical ORDER (saved as `order`).
const store = { products: [], removeSet: new Set(), overrides: {}, selected: new Set(), onlyOut: false };
let dragSet = null; // handles currently being dragged

async function loadAll() {
  const { json } = await api(`${BASE}/master`);
  if (json.missing) $("#missingWarn").style.display = "";
  store.products = json.products || []; // already in saved order from the server
  store.removeSet = new Set(json.removes || []);
  store.overrides = {};
  for (const p of store.products) if (p.override != null) store.overrides[p.gid] = p.override;
  store.selected = new Set();
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

const searching = () => !!($("#prodSearch").value || "").trim();

function renderProducts() {
  const q = ($("#prodSearch").value || "").toLowerCase();
  let list = store.products.filter((p) => `${p.title} ${p.color || ""}`.toLowerCase().includes(q));
  if (store.onlyOut) list = list.filter((p) => store.removeSet.has(p.handle));
  const drag = !searching() && !store.onlyOut; // reordering only on the full, unfiltered list
  $("#searchDragHint").style.display = (searching() || store.onlyOut) ? "" : "none";
  $("#prodCount").textContent = `${list.length} shown`;
  $("#prodGrid").innerHTML = list.map((p) => {
    const inOff = !store.removeSet.has(p.handle);
    const sel = store.selected.has(p.handle);
    const ov = store.overrides[p.gid];
    const priceVal = ov != null ? ov : (p.off_price ?? "");
    const img = p.image ? `<img src="${esc(p.image)}" loading="lazy">` : `<div class="noimg">No image</div>`;
    return `<div class="card ${inOff ? "" : "out"} ${sel ? "sel" : ""}" data-h="${esc(p.handle)}" data-gid="${esc(p.gid)}">
      <div class="imgwrap">
        ${img}
        <label class="pick"><input type="checkbox" class="selbox" ${sel ? "checked" : ""}></label>
        <span class="grip ${drag ? "" : "off"}" ${drag ? 'draggable="true"' : ""} title="${drag ? "Drag to reorder" : "Clear search to reorder"}">⠿</span>
        <span class="tpill ${esc(p.type)}">${esc(p.type || "")}</span>
        <span class="spill ${inOff ? "in" : "out"}">${inOff ? "In" : "Out"}</span>
      </div>
      <div class="body">
        <div class="title">${esc(p.title)}</div>
        <div class="meta"><span>${esc(p.color || "—")}</span><span>·</span><span>${p.total_available ?? "—"} avail</span></div>
        <div class="priceRow">
          <span class="was">MSRP <s>${money(p.msrp)}</s></span>
          <span class="pedit"><span class="cur">$</span><input class="price" type="number" min="0" step="1" value="${priceVal}"></span>
        </div>
        <button class="cardbtn toggle">${inOff ? "Remove from sheet" : "Restore to sheet"}</button>
      </div>
    </div>`;
  }).join("") || `<div class="muted">No products.</div>`;

  // toggle in/out
  $$("#prodGrid .toggle").forEach((b) => b.onclick = () => {
    const h = b.closest(".card").dataset.h;
    if (store.removeSet.has(h)) store.removeSet.delete(h); else store.removeSet.add(h);
    renderProducts(); renderSummary();
  });
  // price override (edit right on the card)
  $$("#prodGrid .price").forEach((inp) => inp.oninput = () => {
    const p = store.products.find((x) => x.gid === inp.closest(".card").dataset.gid);
    const v = parseFloat(inp.value);
    if (Number.isFinite(v) && v > 0 && Math.round(v) !== p.off_price) store.overrides[p.gid] = Math.round(v);
    else delete store.overrides[p.gid];
    renderSummary();
  });
  // selection
  $$("#prodGrid .selbox").forEach((cb) => cb.onchange = () => {
    const card = cb.closest(".card"), h = card.dataset.h;
    if (cb.checked) store.selected.add(h); else store.selected.delete(h);
    card.classList.toggle("sel", cb.checked);
    renderSelBar();
  });
  if (drag) wireDrag();
  renderSelBar();
  $("#selAll").checked = list.length > 0 && list.every((p) => store.selected.has(p.handle));
}

// ---------- selection bar ----------
function renderSelBar() {
  const n = store.selected.size;
  $("#selBar").classList.toggle("hide", n === 0);
  $("#selCount").textContent = n;
}
$("#selAll").onchange = () => {
  const q = ($("#prodSearch").value || "").toLowerCase();
  let list = store.products.filter((p) => `${p.title} ${p.color || ""}`.toLowerCase().includes(q));
  if (store.onlyOut) list = list.filter((p) => store.removeSet.has(p.handle));
  if ($("#selAll").checked) list.forEach((p) => store.selected.add(p.handle));
  else list.forEach((p) => store.selected.delete(p.handle));
  renderProducts();
};
$("#clearSelBtn").onclick = () => { store.selected.clear(); renderProducts(); };

// ---------- bulk actions on the checked rows ----------
const selectedProducts = () => store.products.filter((p) => store.selected.has(p.handle));
$("#removeSelBtn").onclick = () => {
  const sel = selectedProducts();
  if (!sel.length) return;
  sel.forEach((p) => store.removeSet.add(p.handle));
  renderProducts(); renderSummary();
  flash($("#saveStatus"), `${sel.length} removed — Save to publish.`, true);
};
$("#restoreSelBtn").onclick = () => {
  const sel = selectedProducts();
  if (!sel.length) return;
  sel.forEach((p) => store.removeSet.delete(p.handle));
  renderProducts(); renderSummary();
  flash($("#saveStatus"), `${sel.length} restored — Save to publish.`, true);
};
$("#setPriceBtn").onclick = () => {
  const sel = selectedProducts();
  if (!sel.length) return;
  const v = parseFloat($("#selPrice").value);
  if (!Number.isFinite(v) || v <= 0) { flash($("#saveStatus"), "Enter a price first.", false); $("#selPrice").focus(); return; }
  const price = Math.round(v);
  // Store an override only where it differs from the baked off_price.
  sel.forEach((p) => { if (price !== p.off_price) store.overrides[p.gid] = price; else delete store.overrides[p.gid]; });
  renderProducts(); renderSummary();
  flash($("#saveStatus"), `Priced ${sel.length} at $${price} — Save to publish.`, true);
};

// ---------- reordering ----------
function reorder(moving, targetHandle, after) {
  const movingSet = new Set(moving);
  if (movingSet.has(targetHandle)) return;
  const rows = store.products.filter((p) => movingSet.has(p.handle));
  const rest = store.products.filter((p) => !movingSet.has(p.handle));
  let idx = rest.findIndex((p) => p.handle === targetHandle);
  if (idx === -1) { store.products = [...rest, ...rows]; return; }
  if (after) idx += 1;
  rest.splice(idx, 0, ...rows);
  store.products = rest;
}
function moveSelected(top) {
  if (!store.selected.size) return;
  const sel = store.products.filter((p) => store.selected.has(p.handle));
  const rest = store.products.filter((p) => !store.selected.has(p.handle));
  store.products = top ? [...sel, ...rest] : [...rest, ...sel];
  renderProducts(); renderSummary();
  flash($("#saveStatus"), "Reordered — Save to publish.", true);
}
$("#moveTopBtn").onclick = () => moveSelected(true);
$("#moveBottomBtn").onclick = () => moveSelected(false);

function wireDrag() {
  const clearIndicators = () => $$("#prodGrid .card").forEach((c) => c.classList.remove("drop-before", "drop-after", "dragging"));
  $$("#prodGrid .grip").forEach((g) => {
    g.addEventListener("dragstart", (e) => {
      const card = g.closest(".card");
      const h = card.dataset.h;
      // If the dragged card is part of a multi-selection, move the whole set.
      dragSet = store.selected.has(h) && store.selected.size > 1 ? [...store.selected] : [h];
      card.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", h);
    });
    g.addEventListener("dragend", () => { dragSet = null; clearIndicators(); });
  });
  const grid = $("#prodGrid");
  grid.addEventListener("dragover", (e) => {
    if (!dragSet) return;
    e.preventDefault();
    const card = e.target.closest(".card");
    if (!card || !card.dataset.h) return;
    const rect = card.getBoundingClientRect();
    const after = (e.clientX - rect.left) > rect.width / 2; // cards flow left→right
    $$("#prodGrid .card").forEach((c) => c.classList.remove("drop-before", "drop-after"));
    card.classList.add(after ? "drop-after" : "drop-before");
  });
  grid.addEventListener("drop", (e) => {
    if (!dragSet) return;
    e.preventDefault();
    const card = e.target.closest(".card");
    if (!card || !card.dataset.h) return;
    const rect = card.getBoundingClientRect();
    const after = (e.clientX - rect.left) > rect.width / 2;
    reorder(dragSet, card.dataset.h, after);
    dragSet = null;
    renderProducts(); renderSummary();
    flash($("#saveStatus"), "Reordered — Save to publish.", true);
  });
}

// ---------- filters + save ----------
$("#prodSearch").addEventListener("input", renderProducts);
$("#onlyOutBtn").onclick = () => { store.onlyOut = !store.onlyOut; $("#onlyOutBtn").classList.toggle("on", store.onlyOut); renderProducts(); };
$("#saveBtn").onclick = async () => {
  const { ok, json } = await api(BASE, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      removes: [...store.removeSet],
      overrides: store.overrides,
      order: store.products.map((p) => p.handle)
    })
  });
  if (!ok) return flash($("#saveStatus"), json.error || "Failed.", false);
  flash($("#saveStatus"), "Saved. Live for buyers now.");
  await loadAll();
};

loadAll();
