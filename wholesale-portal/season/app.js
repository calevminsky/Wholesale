// In-season wholesale portal (Full Price). Login-gated; pricing comes from the
// server per account. The browser sends only {handle, size_qty} on submit — the
// server recomputes prices, so nothing here is price-authoritative.
"use strict";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const money = (n) => "$" + (Math.round(Number(n) || 0)).toLocaleString();
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const state = {
  account: null,
  guest: null,          // { company, email } when entered via the no-login gate
  publicOff: false,     // browsing Off Price without a session (gate or direct link)
  entitlements: { full: false },
  level: 50,
  offering: "full",
  meta: {},            // catalog meta (size_order, delivery_default_days…)
  products: [],        // current offering's products
  cart: {},            // handle -> { size_qty: {SIZE:qty}, product }
  q: "",
  sort: "featured",
  density: "comfortable",
  shipping: "all"
};

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 2600);
}

async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: "same-origin", headers: { "Content-Type": "application/json" }, ...opts });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

// Public (no-login) endpoint base for each off-price offering.
const pubBase = (o) => (o === "offall" ? "/api/offall" : "/api/offprice");
const offLabel = (o) => (o === "offall" ? "Off Price — All" : "Off Price");

// ---------- auth ----------
async function boot() {
  const params = new URLSearchParams(location.search);
  const p = location.pathname.replace(/\/+$/, "");
  // Which off-price offering does this entry point target?
  const wantsAll = p === "/offprice-all" || params.get("o") === "offall" || params.has("offall");
  const oid = wantsAll ? "offall" : "off";
  const { json } = await api("/api/season/me");
  if (json.account) { applyMe(json); await loadOffering(state.offering); return; }
  // Keyed no-login link: ?bypass=<key> (validated server-side, same key as the
  // F26 portal) opens the offering directly — company + email at checkout.
  const bypassKey = params.get("bypass");
  if (bypassKey) {
    const g = await api(`/api/gate?key=${encodeURIComponent(bypassKey)}`);
    if (g.json?.ok) return enterPublicOff(oid);
  }
  // Clean-path form of the same direct entry.
  if (p === "/offprice" || p === "/offprice-all" || params.has("op") || params.has("offprice") || params.has("offall")) return enterPublicOff(oid);
  // Otherwise default to the no-login Off Price gate (company + email up front).
  showGate();
}

function enterPublicOff(oid = "off") {
  state.publicOff = true;
  state.guest = null;
  state.account = { name: "" };
  state.entitlements = { full: false, off: oid === "off", offall: oid === "offall" };
  state.offering = oid;
  $("#gateOverlay").classList.remove("show");
  $("#loginOverlay").classList.remove("show");
  $("#acctLine").innerHTML = `${offLabel(oid)} · <a id="switchLink">Have a Full Price login? Sign in</a>`;
  $("#switchLink").onclick = showLogin;
  renderTabs();
  loadOffering(oid);
}

function showGate() {
  $("#loginOverlay").classList.remove("show");
  $("#gateOverlay").classList.add("show");
  $("#gateCompany").focus();
}
function showLogin() {
  $("#gateOverlay").classList.remove("show");
  $("#loginOverlay").classList.add("show");
  $("#loginEmail").focus();
}

// Enter Off Price as a guest (no account): just company + email.
$("#gateForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const company = $("#gateCompany").value.trim();
  const email = $("#gateEmail").value.trim();
  $("#gateErr").textContent = "";
  if (!company) { $("#gateErr").textContent = "Enter your company or store name."; return; }
  if (!email || !/.+@.+\..+/.test(email)) { $("#gateErr").textContent = "Enter a valid email."; return; }
  state.guest = { company, email };
  state.publicOff = true;
  state.account = { name: company };
  state.entitlements = { full: false, off: true };
  state.offering = "off";
  api("/api/visit", { method: "POST", body: JSON.stringify({ company, email }) }).catch(() => {}); // lead capture
  $("#gateOverlay").classList.remove("show");
  $("#acctLine").innerHTML = `Browsing as <b>${esc(company)}</b> · <a id="switchLink">Sign in for Full Price</a>`;
  $("#switchLink").onclick = showLogin;
  renderTabs();
  await loadOffering("off");
});
$("#toSignIn").onclick = showLogin;
$("#toGuest").onclick = showGate;

function applyMe(me) {
  state.guest = null; // a real session supersedes any guest/public entry
  state.publicOff = false;
  state.account = me.account;
  state.entitlements = me.entitlements || { full: false };
  state.level = me.pricing?.full_level || 50;
  $("#loginOverlay").classList.remove("show");
  $("#acctLine").innerHTML = `Signed in as <b>${esc(me.account.name)}</b> · <a id="logoutLink">Log out</a>`;
  $("#logoutLink").onclick = logout;
  renderTabs();
}

async function logout() {
  await api("/api/season/logout", { method: "POST" });
  location.reload();
}

$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("#loginEmail").value.trim();
  const password = $("#loginPassword").value;
  $("#loginErr").textContent = "";
  if (!email || !password) { $("#loginErr").textContent = "Enter your email and password."; return; }
  $("#loginGo").disabled = true;
  const { ok, json } = await api("/api/season/login", { method: "POST", body: JSON.stringify({ email, password }) });
  $("#loginGo").disabled = false;
  if (!ok) { $("#loginErr").textContent = json.error || "Sign in failed."; return; }
  const me = await api("/api/season/me");
  applyMe(me.json);
  await loadOffering(state.offering);
});

// ---------- tabs (offerings) ----------
function renderTabs() {
  const tabs = [];
  if (state.entitlements.full) tabs.push({ v: "full", label: "Full Price" });
  if (state.entitlements.off) tabs.push({ v: "off", label: "Off Price" });
  if (state.entitlements.offall) tabs.push({ v: "offall", label: "Off Price — All" });
  // If the current offering isn't entitled (e.g. full disabled), fall back to the first tab.
  if (tabs.length && !tabs.some((t) => t.v === state.offering)) state.offering = tabs[0].v;
  $("#tabBar").innerHTML = tabs.map((t) =>
    `<button class="tiertab ${t.v === state.offering ? "on" : ""}" data-v="${t.v}">${t.label}</button>`
  ).join("");
  $$("#tabBar .tiertab").forEach((b) => b.onclick = () => { state.offering = b.dataset.v; renderTabs(); loadOffering(state.offering); });
}

// ---------- catalog ----------
async function loadOffering(offering) {
  // Public Off Price (gate or direct link) uses the no-session endpoint;
  // signed-in accounts use the per-account season catalog.
  const url = state.publicOff && (offering === "off" || offering === "offall")
    ? `${pubBase(offering)}/catalog`
    : `/api/season/catalog?offering=${encodeURIComponent(offering)}`;
  const { ok, status, json } = await api(url);
  if (!ok) {
    state.products = [];
    render();
    const msg = status === 503 ? "This catalog isn't ready yet — check back shortly." : (json.error || "Couldn't load the catalog.");
    $("#noticeBanner").style.display = "";
    $("#noticeBanner").textContent = msg;
    return;
  }
  $("#noticeBanner").style.display = "none";
  state.meta = json;
  state.products = json.products || [];
  state.level = json.pricing?.full_level || state.level;
  render();
}

function estDelivery() {
  const days = Number(state.meta.delivery_default_days) || 14;
  const d = new Date(Date.now() + days * 864e5);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function visibleProducts() {
  let list = state.products.slice();
  const q = state.q.trim().toLowerCase();
  if (q) list = list.filter((p) => `${p.title} ${p.color || ""} ${p.style_name || ""}`.toLowerCase().includes(q));
  const by = {
    title_asc: (a, b) => String(a.title).localeCompare(String(b.title)),
    price_desc: (a, b) => b.wholesale_price - a.wholesale_price,
    price_asc: (a, b) => a.wholesale_price - b.wholesale_price
  }[state.sort];
  if (by) list.sort(by); // "featured" keeps the server (admin) order
  return list;
}

function priceRows(p) {
  const hasList = Number.isFinite(p.list_wholesale) && p.list_wholesale > p.wholesale_price;
  return `
    <div class="price">
      ${p.msrp ? `<div class="prow"><span class="plabel">MSRP</span><span class="pmsrp">${money(p.msrp)}</span></div>` : ""}
      <div class="prow">
        <span class="plabel">Your price</span>
        ${hasList ? `<span class="pold">${money(p.list_wholesale)}</span>` : ""}
        <span class="ws">${money(p.wholesale_price)}</span>
      </div>
    </div>`;
}

function sizeRun(p) {
  const cart = state.cart[p.handle]?.size_qty || {};
  return `<div class="sizerun">` + p.sizes.map((s) => {
    const qty = cart[s.size] || "";
    const av = Number(s.available);
    return `<div class="sizecell">
      <span class="sz">${esc(s.size)}</span>
      <input type="number" min="0" inputmode="numeric" data-handle="${esc(p.handle)}" data-size="${esc(s.size)}" value="${qty}">
      <span class="av ${av <= 0 ? "zero" : ""}">${Number.isFinite(av) ? av : ""}</span>
    </div>`;
  }).join("") + `</div><div class="linesub" data-sub="${esc(p.handle)}"></div>`;
}

function render() {
  $("#offerName").textContent = state.offering === "full" ? "In-Season · Full Price"
    : state.offering === "off" ? "In-Season · Off Price"
    : state.offering === "offall" ? "Off Price — All"
    : "In-Season";
  // Printable line sheet (PDF / Excel) — available for the off-price offerings.
  const showDl = (state.offering === "off" || state.offering === "offall") ? "" : "none";
  $("#pdfBtn").style.display = showDl;
  $("#xlsxBtn").style.display = showDl;
  const list = visibleProducts();
  $("#count").textContent = `${list.length} style${list.length === 1 ? "" : "s"}`;
  const grid = $("#grid");
  grid.className = "grid" + (state.density === "compact" ? " compact" : "");
  $("#empty").style.display = list.length ? "none" : "";
  grid.innerHTML = list.map((p) => {
    const inCart = !!state.cart[p.handle];
    const img = p.image
      ? `<img src="${esc(p.image)}" alt="${esc(p.title)}" loading="lazy">`
      : `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--muted);font-size:12px">No image</div>`;
    return `<div class="card ${inCart ? "has-qty" : ""}" data-card="${esc(p.handle)}">
      <div class="imgwrap">${img}</div>
      <div class="body">
        <div class="title">${esc(p.title)}</div>
        <div class="meta">${p.color ? `<span>${esc(p.color)}</span><span class="dot"></span>` : ""}<span>${esc(p.type || "")}</span></div>
        <span class="deliv">Ships ~${estDelivery()}</span>
        ${priceRows(p)}
        ${sizeRun(p)}
      </div>
    </div>`;
  }).join("");
  $$("#grid .sizecell input").forEach((inp) => inp.addEventListener("input", onQty));
  list.forEach((p) => updateLineSub(p.handle));
  updateTotals();
}

// ---------- cart ----------
const productByHandle = (h) => state.products.find((p) => p.handle === h);

function onQty(e) {
  const handle = e.target.dataset.handle;
  const size = e.target.dataset.size;
  const qty = Math.max(0, parseInt(e.target.value, 10) || 0);
  const p = productByHandle(handle);
  if (!p) return;
  if (!state.cart[handle]) state.cart[handle] = { size_qty: {}, product: p };
  if (qty > 0) state.cart[handle].size_qty[size] = qty;
  else delete state.cart[handle].size_qty[size];
  if (!Object.keys(state.cart[handle].size_qty).length) delete state.cart[handle];

  const sz = p.sizes.find((s) => s.size === size);
  e.target.classList.toggle("has", qty > 0);
  e.target.classList.toggle("over", sz && Number.isFinite(sz.available) && qty > sz.available);
  $(`[data-card="${CSS.escape(handle)}"]`)?.classList.toggle("has-qty", !!state.cart[handle]);
  updateLineSub(handle);
  updateTotals();
}

function lineUnits(handle) {
  return Object.values(state.cart[handle]?.size_qty || {}).reduce((a, b) => a + b, 0);
}
function updateLineSub(handle) {
  const el = $(`[data-sub="${CSS.escape(handle)}"]`);
  if (!el) return;
  const u = lineUnits(handle);
  const p = productByHandle(handle);
  el.innerHTML = u ? `<b>${u}</b> unit${u === 1 ? "" : "s"} · ${money(u * p.wholesale_price)}` : "";
}

function cartTotals() {
  let styles = 0, units = 0, subtotal = 0;
  for (const handle of Object.keys(state.cart)) {
    const p = productByHandle(handle) || state.cart[handle].product;
    const u = lineUnits(handle);
    if (!u) continue;
    styles++; units += u; subtotal += u * (p.wholesale_price || 0);
  }
  return { styles, units, subtotal };
}

function updateTotals() {
  const { styles, units, subtotal } = cartTotals();
  $("#miniStyles").textContent = styles;
  $("#miniUnits").textContent = units;
  $("#miniSubtotal").textContent = money(subtotal);
  $("#barStyles").textContent = styles;
  $("#barUnits").textContent = units;
  $("#barSubtotal").textContent = money(subtotal);
  const has = units > 0;
  $("#reviewBtn").disabled = !has;
  $("#cartbar").classList.toggle("show", has);
}

// ---------- review + submit ----------
function openReview() {
  const items = Object.keys(state.cart).map((h) => ({ p: productByHandle(h) || state.cart[h].product, sq: state.cart[h].size_qty, u: lineUnits(h) })).filter((x) => x.u);
  if (!items.length) return;
  const { units, subtotal } = cartTotals();
  $("#reviewContent").innerHTML = `
    <div class="tiergroup">
      <h3>Your order · ${state.account ? esc(state.account.name) : ""}</h3>
      ${items.map(({ p, sq, u }) => {
        const sizes = p.sizes.filter((s) => sq[s.size]).map((s) => `${s.size}:${sq[s.size]}`).join("  ");
        return `<div class="rline">
          ${p.image ? `<img class="thumb" src="${esc(p.image)}">` : `<div class="thumb"></div>`}
          <div class="info"><div class="t">${esc(p.title)}</div><div class="b">${esc(sizes)}</div>
            <button class="rm" data-rm="${esc(p.handle)}">Remove</button></div>
          <div class="ext"><div class="x">${money(u * p.wholesale_price)}</div><div class="u">${u} @ ${money(p.wholesale_price)}</div></div>
        </div>`;
      }).join("")}
    </div>
    ${state.publicOff && !(state.guest && state.guest.company) ? `
    <div class="field"><label>Company / store name</label><input id="ckCompany" type="text" autocomplete="organization" placeholder="Your store"></div>
    <div class="field"><label>Email</label><input id="ckEmail" type="email" autocomplete="email" placeholder="you@store.com"></div>` : ""}
    <div class="field">
      <label>Shipping</label>
      <div class="seg ship" id="shipSeg">
        <button data-v="all" class="${state.shipping === "all" ? "on" : ""}">Ship all together</button>
        <button data-v="when_ready" class="${state.shipping === "when_ready" ? "on" : ""}">Ship when ready</button>
      </div>
    </div>
    <div class="field"><label>Notes (optional)</label><textarea id="orderNotes" rows="2" placeholder="Anything we should know…"></textarea></div>
    <div class="totrow grand"><span>Total · ${units} units</span><span class="v">${money(subtotal)}</span></div>`;
  $("#reviewFootInfo").textContent = `${items.length} styles · pricing confirmed by Yakira Bella`;
  $$("#reviewContent [data-rm]").forEach((b) => b.onclick = () => { delete state.cart[b.dataset.rm]; render(); items.length > 1 ? openReview() : closeReview(); });
  $$("#shipSeg button").forEach((b) => b.onclick = () => { state.shipping = b.dataset.v; $$("#shipSeg button").forEach((x) => x.classList.toggle("on", x === b)); });
  $("#reviewOverlay").classList.add("show");
}
function closeReview() { $("#reviewOverlay").classList.remove("show"); }

async function submitOrder() {
  const lines = Object.keys(state.cart).map((h) => ({ handle: h, size_qty: state.cart[h].size_qty })).filter((l) => Object.keys(l.size_qty).length);
  if (!lines.length) return;
  const notes = $("#orderNotes")?.value || "";
  let req;
  if (state.publicOff && (state.offering === "off" || state.offering === "offall")) {
    // Company/email come from the gate, or are collected here on the direct link.
    let company = state.guest?.company, email = state.guest?.email;
    if (!company) {
      company = ($("#ckCompany")?.value || "").trim();
      email = ($("#ckEmail")?.value || "").trim();
      if (!company) { toast("Please enter your company name."); $("#ckCompany")?.focus(); return; }
      if (!email || !/.+@.+\..+/.test(email)) { toast("Please enter a valid email."); $("#ckEmail")?.focus(); return; }
    }
    req = api(`${pubBase(state.offering)}/orders`, { method: "POST", body: JSON.stringify({ company, email, lines, notes, shipping: state.shipping }) });
  } else {
    req = api("/api/season/orders", { method: "POST", body: JSON.stringify({ offering: state.offering, lines, notes, shipping: state.shipping }) });
  }
  $("#submitBtn").disabled = true;
  const { ok, json } = await req;
  $("#submitBtn").disabled = false;
  if (!ok) { toast(json.error || "Order failed — please try again."); return; }
  state.cart = {};
  $("#reviewContent").innerHTML = `<div class="confirm">
    <div class="confirm-check">✓</div>
    <h3>Order received</h3>
    <p>Thank you! Your order for <b>${json.units}</b> units (${money(json.subtotal)}) has been sent to our team and will be confirmed shortly.</p>
    ${json.draft_id ? `<p class="ref">Reference #${esc(json.draft_id)}</p>` : ""}
  </div>`;
  $("#reviewFootInfo").textContent = "";
  $("#submitBtn").style.display = "none";
  $("#backToBrowse").textContent = "Done";
  render();
}

// ---------- wiring ----------
$("#q").addEventListener("input", (e) => { state.q = e.target.value; render(); });
$("#sort").addEventListener("change", (e) => { state.sort = e.target.value; render(); });
$$("#densitySeg button").forEach((b) => b.onclick = () => { state.density = b.dataset.v; $$("#densitySeg button").forEach((x) => x.classList.toggle("on", x === b)); render(); });
$("#reviewBtn").onclick = openReview;
$("#reviewBtn2").onclick = openReview;
$("#closeReview").onclick = closeReview;
$("#backToBrowse").onclick = () => { closeReview(); $("#submitBtn").style.display = ""; $("#backToBrowse").textContent = "Keep shopping"; };
$("#submitBtn").onclick = submitOrder;
$("#clearCart").onclick = () => { state.cart = {}; render(); toast("Cart cleared"); };

// ---------- printable line sheet (Off Price) ----------
$("#pdfBtn").onclick = async () => {
  toast("Building PDF…");
  try {
    const res = await fetch(`${pubBase(state.offering)}/linesheet.pdf`);
    if (!res.ok) throw new Error();
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url; a.download = `yakira-bella-${state.offering === "offall" ? "off-price-all" : "off-price"}.pdf`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch { toast("Couldn't build the PDF — please try again."); }
};
$("#xlsxBtn").onclick = () => { window.location.href = `${pubBase(state.offering)}/linesheet.xlsx`; };

boot();
