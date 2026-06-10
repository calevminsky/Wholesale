/* Yakira Bella — Wholesale Portal front-end.
   Reads the precomputed catalog.json, lets a buyer key quantities per size,
   and assembles an order in the exact shape the internal importer ingests.
   No server in this pass: Submit builds + downloads the items-JSON and an
   importer-ready CSV (email / auto-submit wiring lands in the next pass). */
(() => {
  "use strict";

  const SIZE_CORE = ["XXS", "XS", "S", "M", "L", "XL", "XXL"]; // always zero-filled
  const LOCATIONS = [
    "gid://shopify/Location/68496293985",
    "gid://shopify/Location/31679414369",
    "gid://shopify/Location/20363018337",
    "gid://shopify/Location/62070161505",
    "gid://shopify/Location/33027424353"
  ];
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const money = (n) => "$" + Math.round(n).toLocaleString();
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  // base title = title with the parenthetical color removed ("Achieve Skirt (Black) 23\"" -> "Achieve Skirt 23\"")
  const baseTitle = (t) => String(t || "").replace(/\s*\([^)]*\)\s*/, " ").replace(/\s+/g, " ").trim();

  // ---------- estimated delivery ----------
  // In-stock styles: today + catalog.delivery_default_days (computed live, so it
  // stays fresh). Pre-stock styles carry an absolute est_delivery (ETA + buffer)
  // baked in at build; null means no ETA known yet.
  const fmtShort = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const isoLocal = (d) => d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` : null;
  function deliveryDate(p) {
    if (p.est_delivery) { const d = new Date(p.est_delivery + "T00:00:00"); return isNaN(d) ? null : d; }
    if (!p.preorder) { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + (Number(CATALOG?.delivery_default_days) || 14)); return d; }
    return null; // pre-stock with no ETA
  }
  const deliveryTime = (p) => { const d = deliveryDate(p); return d ? d.getTime() : Infinity; };
  const deliveryLabel = (p) => { const d = deliveryDate(p); return d ? "Est. delivery " + fmtShort(d) : "Delivery TBD"; };
  const deliveryHTML = (p) => `<div class="deliv ${deliveryDate(p) ? "" : "tbd"}">${deliveryLabel(p)}</div>`;

  // ---------- account (display-only this pass) ----------
  const token = new URLSearchParams(location.search).get("t") || "";
  let account = { name: "Guest", slug: "guest", customer_id: null };

  // ---------- state ----------
  let CATALOG = null;
  let PRODUCTS = [];
  const byGid = new Map();
  const filters = { q: "", type: "", color: "", deliv: "", klass: "noncore", sort: "title_asc", view: "color", density: "comfortable" };
  const isCore = (p) => (p.class || "").toLowerCase() === "core";
  let cart = {};                 // gid -> { [size]: qty }
  const selectedVariant = {};    // groupKey -> gid currently shown in a grouped card

  const cartKey = () => `yb_portal_cart_${token || "guest"}`;
  function loadCart() { try { cart = JSON.parse(localStorage.getItem(cartKey())) || {}; } catch { cart = {}; } }
  function saveCart() { try { localStorage.setItem(cartKey(), JSON.stringify(cart)); } catch {} }

  // ---------- derived ----------
  function lineUnits(gid) { const s = cart[gid] || {}; return Object.values(s).reduce((a, b) => a + (Number(b) || 0), 0); }
  function lineSubtotal(gid) { const p = byGid.get(gid); return p ? lineUnits(gid) * p.wholesale_price : 0; }
  function cartLines() { return Object.keys(cart).filter((gid) => lineUnits(gid) > 0).map((gid) => byGid.get(gid)).filter(Boolean); }
  function totals() {
    const lines = cartLines();
    return {
      styles: lines.length,
      units: lines.reduce((a, p) => a + lineUnits(p.gid), 0),
      subtotal: lines.reduce((a, p) => a + lineSubtotal(p.gid), 0)
    };
  }

  // ---------- boot ----------
  async function boot() {
    try {
      const res = await fetch("data/catalog.json", { cache: "no-store" });
      CATALOG = await res.json();
    } catch (e) {
      $("#grid").innerHTML = `<div class="empty"><div class="big">Catalog unavailable</div><div>Could not load the catalog. Please refresh.</div></div>`;
      return;
    }
    // Off-price is removed from the line sheet for now — only full-price styles show.
    PRODUCTS = (CATALOG.products || []).filter((p) => p.tier !== "off");
    PRODUCTS.forEach((p) => byGid.set(p.gid, p));
    if (CATALOG.offer) $("#offerName").textContent = `${CATALOG.offer} Collection`;

    if (token) {
      try {
        // Resolve just this token's account (name/slug/customer_id) — the full
        // accounts list with emails is never exposed to the browser.
        const j = await (await fetch(`api/account?token=${encodeURIComponent(token)}`, { cache: "no-store" })).json();
        if (j.account) account = { name: j.account.name, slug: j.account.slug, customer_id: j.account.customer_id ?? null };
      } catch {}
    }
    $("#acctLine").innerHTML = `Browsing as <b>${esc(account.name)}</b>`;

    buildFilterOptions();
    loadCart();
    wireEvents();
    render();
    refreshCart();
  }

  function buildFilterOptions() {
    const uniq = (key) => [...new Set(PRODUCTS.map((p) => p[key]).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));
    fillSelect("#fType", uniq("type"));
    fillSelect("#fColor", uniq("color"));
    // Delivery cutoffs ("By <date>") from the distinct delivery dates in the catalog.
    const dates = [...new Set(PRODUCTS.map((p) => isoLocal(deliveryDate(p))).filter(Boolean))].sort();
    const el = $("#fDeliv");
    for (const iso of dates) {
      const o = document.createElement("option");
      o.value = iso; o.textContent = "By " + fmtShort(new Date(iso + "T00:00:00"));
      el.appendChild(o);
    }
  }
  function fillSelect(sel, vals) {
    const el = $(sel);
    for (const v of vals) { const o = document.createElement("option"); o.value = v; o.textContent = v; el.appendChild(o); }
  }

  // ---------- filtering / sorting ----------
  function matchesBase(p) { // everything except tier (used for tier counts)
    if (filters.type && p.type !== filters.type) return false;
    if (filters.color && p.color !== filters.color) return false;
    if (filters.deliv) { // "on or before" the chosen cutoff
      const cutoff = new Date(filters.deliv + "T00:00:00").getTime();
      const t = deliveryTime(p);
      if (!isFinite(t) || t > cutoff) return false;
    }
    if (filters.q) {
      const q = filters.q.toLowerCase();
      const hay = [p.title, p.color, p.style_name, deliveryLabel(p), p.est_delivery].filter(Boolean).join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }
  function matchesClass(p) {
    if (filters.klass === "core") return isCore(p);
    if (filters.klass === "noncore") return !isCore(p);
    return true; // "" = all
  }
  function matches(p) { return matchesClass(p) && matchesBase(p); }

  // group variants of the same style+tier into one card
  function groupsOf(list) {
    const map = new Map();
    for (const p of list) {
      const key = baseTitle(p.title) + "|" + p.tier;
      if (!map.has(key)) map.set(key, { key, base: baseTitle(p.title), tier: p.tier, type: p.type, variants: [] });
      map.get(key).variants.push(p);
    }
    const groups = [...map.values()];
    for (const g of groups) {
      g.variants.sort((a, b) => (a.color || "").localeCompare(b.color || ""));
      g.minPrice = Math.min(...g.variants.map((v) => v.wholesale_price));
      g.maxPrice = Math.max(...g.variants.map((v) => v.wholesale_price));
      g.totalAvail = g.variants.reduce((s, v) => s + (v.total_available || 0), 0);
      g.minDeliv = Math.min(...g.variants.map(deliveryTime));
    }
    return groups;
  }

  function sortItems(arr, keyer) {
    const dir = {
      title_asc: (a, b) => keyer.title(a).localeCompare(keyer.title(b)),
      price_desc: (a, b) => keyer.price(b) - keyer.price(a),
      price_asc: (a, b) => keyer.price(a) - keyer.price(b),
      avail_desc: (a, b) => keyer.avail(b) - keyer.avail(a),
      deliv_asc: (a, b) => keyer.deliv(a) - keyer.deliv(b),
      deliv_desc: (a, b) => keyer.deliv(b) - keyer.deliv(a)
    }[filters.sort];
    return arr.slice().sort(dir);
  }

  // ---------- Core / Non-Core counts ----------
  function setClassCounts() {
    const base = PRODUCTS.filter(matchesBase);
    const count = (arr) => filters.view === "style" ? groupsOf(arr).length : arr.length;
    $("#cNonCore").textContent = count(base.filter((p) => !isCore(p)));
    $("#cCore").textContent = count(base.filter((p) => isCore(p)));
    $("#cAll").textContent = count(base);
  }

  // ---------- render ----------
  function render() {
    setClassCounts();
    const grid = $("#grid"), empty = $("#empty");
    grid.className = "grid" + (filters.density === "compact" ? " compact" : "");
    const matched = PRODUCTS.filter(matches);

    let html, n;
    if (filters.view === "style") {
      const groups = sortItems(groupsOf(matched), { title: (g) => g.base, price: (g) => g.minPrice, avail: (g) => g.totalAvail, deliv: (g) => g.minDeliv });
      n = groups.length;
      html = groups.map(groupCardHTML).join("");
    } else {
      const items = sortItems(matched, { title: (p) => p.title || "", price: (p) => p.wholesale_price, avail: (p) => p.total_available || 0, deliv: deliveryTime });
      n = items.length;
      html = items.map(flatCardHTML).join("");
    }
    $("#count").textContent = `${n} ${filters.view === "style" ? "style" : "option"}${n === 1 ? "" : "s"}`;
    if (!n) { grid.innerHTML = ""; empty.style.display = "block"; return; }
    empty.style.display = "none";
    grid.innerHTML = html;
    wireCards(grid);
  }

  function priceHTML(p) {
    // Always show MSRP + Wholesale, clearly labeled. For off-price styles whose
    // wholesale beats the standard (full-tier) wholesale, show that regular
    // wholesale slashed next to the lower off price.
    const msrp = Math.max(p.compare_at || 0, p.retail_price || 0);
    const ws = p.wholesale_price;
    // Pre-order styles still being priced: no wholesale figure yet.
    if (p.preorder && (ws == null || !Number.isFinite(ws))) {
      return `
        <div class="prow"><span class="plabel">${msrp > 0 ? "MSRP" : ""}</span><span class="pmsrp">${msrp > 0 ? money(msrp) : ""}</span></div>
        <div class="prow"><span class="plabel">Wholesale</span><span class="ws tbd">Price TBD</span></div>`;
    }
    const list = Number(p.list_wholesale) || ws;
    const slashed = p.tier === "off" && list > ws + 0.5;
    return `
      <div class="prow"><span class="plabel">MSRP</span><span class="pmsrp">${money(msrp)}</span></div>
      <div class="prow"><span class="plabel">Wholesale</span>
        ${slashed ? `<span class="pold">${money(list)}</span>` : ""}
        <span class="ws">${money(ws)}</span>
      </div>`;
  }

  function sizeRunHTML(p) {
    // Unpriced pre-orders can't be ordered yet.
    if (p.preorder && (p.wholesale_price == null || !Number.isFinite(p.wholesale_price))) {
      return `<div class="prenote">Not yet priced — check back to order.</div>`;
    }
    // No stock display or ceilings — buyers can enter any quantity per size.
    return p.sizes.map((s) => {
      const q = Number((cart[p.gid] || {})[s.size] || 0);
      return `<div class="sizecell">
        <span class="sz">${s.size}</span>
        <input type="number" min="0" inputmode="numeric" data-gid="${p.gid}" data-size="${s.size}" value="${q || ""}" placeholder="0" class="${q > 0 ? "has" : ""}">
      </div>`;
    }).join("");
  }

  // Tier badges removed (line sheet is full-price only for now).
  function badgeHTML() { return ""; }

  // flat (by color) card
  function flatCardHTML(p) {
    const has = lineUnits(p.gid) > 0;
    const img = p.image ? `<img src="${esc(p.image)}" alt="${esc(p.title)}" loading="lazy">` : "";
    return `<div class="card ${has ? "has-qty" : ""}" data-gid="${p.gid}">
      <div class="imgwrap">${badgeHTML(p)}${img}</div>
      <div class="body">
        <div class="title">${esc(p.title)}</div>
        <div class="meta">${p.type ? esc(p.type) : ""}${p.type && p.color ? '<span class="dot"></span>' : ""}${p.color ? esc(p.color) : ""}</div>
        <div class="price">${priceHTML(p)}</div>
        ${deliveryHTML(p)}
        <div class="sizerun">${sizeRunHTML(p)}</div>
        <div class="linesub" data-sub="${p.gid}">${has ? lineSubLabel(p.gid) : ""}</div>
      </div>
    </div>`;
  }

  // grouped (by style) card — color variants combined, buyer picks a color
  function groupCardHTML(g) {
    let sel = selectedVariant[g.key];
    if (!sel || !g.variants.some((v) => v.gid === sel)) sel = (g.variants.find((v) => v.total_available > 0) || g.variants[0]).gid;
    selectedVariant[g.key] = sel;
    const anyHas = g.variants.some((v) => lineUnits(v.gid) > 0);
    const selP = byGid.get(sel);

    const chips = g.variants.map((v) => {
      const on = v.gid === sel, filled = lineUnits(v.gid) > 0;
      const sw = v.image ? `<img src="${esc(v.image)}" alt="">` : `<span class="noimg"></span>`;
      return `<button class="chip ${on ? "on" : ""} ${filled ? "filled" : ""}" data-gid="${v.gid}" data-img="${esc(v.image || "")}" title="${esc(v.color || "")}">${sw}<span class="cn">${esc(v.color || "—")}</span></button>`;
    }).join("");

    const variants = g.variants.map((v) => {
      const has = lineUnits(v.gid) > 0;
      return `<div class="variant" data-vgid="${v.gid}" ${v.gid === sel ? "" : "hidden"}>
        <div class="price">${priceHTML(v)}</div>
        ${deliveryHTML(v)}
        <div class="sizerun">${sizeRunHTML(v)}</div>
        <div class="linesub" data-sub="${v.gid}">${has ? lineSubLabel(v.gid) : ""}</div>
      </div>`;
    }).join("");

    const img = selP.image ? `<img class="mainimg" src="${esc(selP.image)}" alt="${esc(g.base)}" loading="lazy">` : `<img class="mainimg">`;
    return `<div class="card group ${anyHas ? "has-qty" : ""}" data-group="${esc(g.key)}">
      <div class="imgwrap">${badgeHTML(g)}${img}</div>
      <div class="body">
        <div class="title">${esc(g.base)}</div>
        <div class="meta">${g.type ? esc(g.type) : ""}${g.type ? '<span class="dot"></span>' : ""}${g.variants.length} color${g.variants.length === 1 ? "" : "s"}</div>
        <div class="colorchips">${chips}</div>
        <div class="variants">${variants}</div>
      </div>
    </div>`;
  }

  function lineSubLabel(gid) {
    const u = lineUnits(gid);
    if (!u) return "";
    return `<b>${u}</b> unit${u === 1 ? "" : "s"} · <b>${money(lineSubtotal(gid))}</b>`;
  }

  // ---------- card wiring ----------
  function wireCards(grid) {
    $$(".sizecell input", grid).forEach((inp) => {
      inp.addEventListener("input", onQtyInput);
      inp.addEventListener("focus", () => inp.select());
    });
    $$(".colorchips .chip", grid).forEach((chip) => chip.addEventListener("click", onChipClick));
  }

  function onChipClick(e) {
    const chip = e.currentTarget;
    const card = chip.closest(".card");
    const gid = chip.dataset.gid;
    $$(".chip", card).forEach((c) => c.classList.toggle("on", c === chip));
    $$(".variant", card).forEach((v) => { v.hidden = v.dataset.vgid !== gid; });
    const main = card.querySelector(".mainimg");
    if (main && chip.dataset.img) main.src = chip.dataset.img;
    const g = card.dataset.group;
    if (g) selectedVariant[g] = gid;
  }

  function onQtyInput(e) {
    const inp = e.target;
    const gid = inp.dataset.gid, size = inp.dataset.size;
    let v = parseInt(inp.value, 10);
    if (!Number.isFinite(v) || v < 0) v = 0;
    if (!cart[gid]) cart[gid] = {};
    if (v > 0) cart[gid][size] = v; else delete cart[gid][size];
    if (Object.keys(cart[gid]).length === 0) delete cart[gid];
    inp.classList.toggle("has", v > 0);
    const card = inp.closest(".card");
    const sub = card.querySelector(`[data-sub="${CSS.escape(gid)}"]`);
    if (sub) sub.innerHTML = lineSubLabel(gid);
    // chip "has units" dot (grouped view)
    const chip = card.querySelector(`.chip[data-gid="${CSS.escape(gid)}"]`);
    if (chip) chip.classList.toggle("filled", lineUnits(gid) > 0);
    // card highlight: any variant with units
    const anyHas = $$(".sizecell input", card).some((i) => Number(i.value) > 0) ||
      [...new Set($$(".sizecell input", card).map((i) => i.dataset.gid))].some((g) => lineUnits(g) > 0);
    card.classList.toggle("has-qty", anyHas);
    saveCart();
    refreshCart();
  }

  // ---------- cart summary ----------
  function refreshCart() {
    const t = totals();
    $("#miniStyles").textContent = t.styles;
    $("#miniUnits").textContent = t.units;
    $("#miniSubtotal").textContent = money(t.subtotal);
    $("#barStyles").textContent = t.styles;
    $("#barUnits").textContent = t.units;
    $("#barSubtotal").textContent = money(t.subtotal);
    const any = t.styles > 0;
    $("#reviewBtn").disabled = !any;
    $("#cartbar").classList.toggle("show", any);
  }

  // ---------- review ----------
  function openReview() {
    const lines = cartLines();
    if (!lines.length) return;
    const t = totals();
    const rows = lines.map((p) => {
      const sizes = p.sizes.filter((s) => (cart[p.gid] || {})[s.size]).map((s) => `${s.size}·${cart[p.gid][s.size]}`).join("  ");
      const u = lineUnits(p.gid);
      return `<div class="rline">
        ${p.image ? `<img class="thumb" src="${esc(p.image)}" alt="">` : `<div class="thumb"></div>`}
        <div class="info">
          <div class="t">${esc(p.title)}</div>
          <div class="b">${sizes} &nbsp;·&nbsp; ${u} unit${u === 1 ? "" : "s"} @ ${money(p.wholesale_price)}</div>
          <button class="rm" data-rm="${p.gid}">Remove</button>
        </div>
        <div class="ext"><div class="x">${money(lineSubtotal(p.gid))}</div><div class="u">${u}×${money(p.wholesale_price)}</div></div>
      </div>`;
    }).join("");
    const ship = loadShipping();
    $("#reviewContent").innerHTML =
      `<div class="tiergroup">${rows}</div>` +
      `<div class="field"><label>Shipping</label>
         <div class="seg ship" id="shipSeg">
           <button data-v="all" class="${ship === "all" ? "on" : ""}">Ship all together</button>
           <button data-v="when_ready" class="${ship === "when_ready" ? "on" : ""}">Ship when ready</button>
         </div>
         <div class="note-info" style="margin-top:6px">${ship === "when_ready" ? "We’ll ship pieces as they’re ready (partial shipments)." : "We’ll hold the order and ship it complete in one go."}</div>
       </div>
       <div class="field"><label>Your email</label><input id="buyerEmail" type="email" inputmode="email" placeholder="you@boutique.com" value="${esc(loadEmail())}"></div>
       <div class="field"><label class="chkrow"><input type="checkbox" id="sendReceipt" ${loadReceiptPref() ? "checked" : ""}> Email me a copy of this order</label></div>
       <div class="field"><label>Notes / PO number</label><textarea id="notes" rows="2" placeholder="e.g. PO 8842">${esc(loadNotes())}</textarea></div>
       <div class="totrow"><span>${t.styles} styles · ${t.units} units</span><span></span></div>
       <div class="totrow grand"><span>Order subtotal</span><span class="v">${money(t.subtotal)}</span></div>`;
    $("#reviewFootInfo").innerHTML = `Account: <b>${esc(account.name)}</b>`;
    // reset footer (it may have been left in the post-submit "Done" state)
    $("#submitBtn").style.display = ""; $("#submitBtn").disabled = false; $("#submitBtn").textContent = "Submit order";
    $("#backToBrowse").textContent = "Keep shopping";
    $$("[data-rm]", $("#reviewContent")).forEach((b) => b.addEventListener("click", () => { delete cart[b.dataset.rm]; saveCart(); render(); refreshCart(); openReview(); }));
    $("#notes").addEventListener("input", (e) => saveNotes(e.target.value));
    $("#buyerEmail").addEventListener("input", (e) => saveEmail(e.target.value));
    $("#sendReceipt").addEventListener("change", (e) => saveReceiptPref(e.target.checked));
    $("#shipSeg").addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      saveShipping(b.dataset.v); openReview();
    });
    $("#reviewOverlay").classList.add("show");
  }
  function closeReview() { $("#reviewOverlay").classList.remove("show"); }

  const notesKey = () => `yb_portal_notes_${token || "guest"}`;
  function loadNotes() { return localStorage.getItem(notesKey()) || ""; }
  function saveNotes(v) { localStorage.setItem(notesKey(), v); }
  const shipKey = () => `yb_portal_ship_${token || "guest"}`;
  function loadShipping() { return localStorage.getItem(shipKey()) || "all"; }
  function saveShipping(v) { localStorage.setItem(shipKey(), v); }
  const emailKey = () => `yb_portal_email_${token || "guest"}`;
  function loadEmail() { return localStorage.getItem(emailKey()) || ""; }
  function saveEmail(v) { localStorage.setItem(emailKey(), v); }
  const rcptKey = () => `yb_portal_receipt_${token || "guest"}`;
  function loadReceiptPref() { return localStorage.getItem(rcptKey()) === "1"; }
  function saveReceiptPref(v) { localStorage.setItem(rcptKey(), v ? "1" : "0"); }

  // ---------- order submission ----------
  // The order is assembled server-side (server-authoritative pricing) from just
  // {handle, size_qty} per line — see build/orderfile.mjs + POST /api/orders.
  async function submit() {
    const lines = cartLines().map((p) => ({ handle: p.handle, size_qty: cart[p.gid] }));
    if (!lines.length) return;
    const email = (loadEmail() || "").trim();
    if (!/.+@.+\..+/.test(email)) { toast("Please enter your email so we can confirm your order."); $("#buyerEmail")?.focus(); return; }
    const btn = $("#submitBtn");
    btn.disabled = true; btn.textContent = "Submitting…";
    try {
      const res = await fetch("api/orders", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, lines, notes: loadNotes(), shipping: loadShipping(), buyerEmail: email, sendReceipt: loadReceiptPref() })
      });
      const j = await res.json();
      if (!res.ok || !j.ok) { toast(j.error || "Couldn’t submit — please try again."); btn.disabled = false; btn.textContent = "Submit order"; return; }
      showConfirmation(j);
      cart = {}; saveCart(); refreshCart();
    } catch (e) {
      toast("Network error — please try again."); btn.disabled = false; btn.textContent = "Submit order";
    }
  }

  function showConfirmation(j) {
    $("#reviewContent").innerHTML = `<div class="confirm">
      <div class="confirm-check">✓</div>
      <h3>Order received</h3>
      <p>Thanks, ${esc(account.name)}! Your order — <b>${j.styles} ${j.styles === 1 ? "style" : "styles"} · ${j.units} units · ${money(j.subtotal)}</b> — was sent to our wholesale team. We’ll confirm shortly${loadReceiptPref() ? ", and a copy is on its way to your inbox" : ""}.</p>
      <p class="ref">Reference: <b>${esc(j.ref)}</b></p>
    </div>`;
    $("#reviewFootInfo").textContent = "";
    $("#submitBtn").style.display = "none";
    $("#backToBrowse").textContent = "Done";
  }

  // ---------- print ----------
  // Print exactly what's on screen: the print stylesheet hides the chrome
  // (header, toolbar, cart bar) and keeps the live card grid as-is.
  // Card images are loading="lazy", so anything below the first screen hasn't
  // loaded — it would print blank. Eager-load every image and wait before print.
  async function printCatalog() {
    const imgs = $$("#grid img");
    const waits = imgs.map((im) => {
      if (im.complete && im.naturalWidth > 0) return Promise.resolve();
      im.loading = "eager";
      return new Promise((res) => {
        im.addEventListener("load", res, { once: true });
        im.addEventListener("error", res, { once: true });
        const src = im.currentSrc || im.getAttribute("src"); // nudge images the lazy loader never started
        if (src) { im.removeAttribute("src"); im.setAttribute("src", src); }
      });
    });
    // don't hang forever if a stray image 404s
    await Promise.race([Promise.all(waits), new Promise((r) => setTimeout(r, 10000))]);
    window.print();
  }

  // ---------- toast ----------
  let toastT;
  function toast(msg) {
    const el = $("#toast"); el.textContent = msg; el.classList.add("show");
    clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove("show"), 3200);
  }

  // ---------- events ----------
  function wireEvents() {
    let qt;
    $("#q").addEventListener("input", (e) => { clearTimeout(qt); qt = setTimeout(() => { filters.q = e.target.value.trim(); render(); }, 140); });
    $("#fType").addEventListener("change", (e) => { filters.type = e.target.value; render(); });
    $("#fColor").addEventListener("change", (e) => { filters.color = e.target.value; render(); });
    $("#fDeliv").addEventListener("change", (e) => { filters.deliv = e.target.value; render(); });
    $("#sort").addEventListener("change", (e) => { filters.sort = e.target.value; render(); });
    $("#classSeg").addEventListener("click", (e) => {
      const b = e.target.closest(".tiertab"); if (!b) return;
      filters.klass = b.dataset.v; $$("#classSeg .tiertab").forEach((x) => x.classList.toggle("on", x === b)); render();
    });
    $("#viewSeg").addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      filters.view = b.dataset.v; $$("#viewSeg button").forEach((x) => x.classList.toggle("on", x === b));
      // By color is incompatible with the color filter dropdown only cosmetically; keep both.
      $("#fColor").style.display = filters.view === "style" ? "none" : "";
      render();
    });
    $("#densitySeg").addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      filters.density = b.dataset.v; $$("#densitySeg button").forEach((x) => x.classList.toggle("on", x === b)); render();
    });
    $("#xlsxBtn").addEventListener("click", () => { window.location.href = "api/linesheet.xlsx"; });
    $("#printBtn").addEventListener("click", printCatalog);
    $("#reviewBtn").addEventListener("click", openReview);
    $("#reviewBtn2").addEventListener("click", openReview);
    $("#closeReview").addEventListener("click", closeReview);
    $("#backToBrowse").addEventListener("click", closeReview);
    $("#submitBtn").addEventListener("click", submit);
    $("#clearCart").addEventListener("click", () => {
      if (!confirm("Clear all quantities from the cart?")) return;
      cart = {}; saveCart(); render(); refreshCart();
    });
    $("#reviewOverlay").addEventListener("click", (e) => { if (e.target.id === "reviewOverlay") closeReview(); });
    // reflect the default filters in the controls (default: Non-Core, By color)
    $$("#classSeg .tiertab").forEach((x) => x.classList.toggle("on", x.dataset.v === filters.klass));
    $$("#viewSeg button").forEach((x) => x.classList.toggle("on", x.dataset.v === filters.view));
    $("#fColor").style.display = filters.view === "style" ? "none" : "";
  }

  boot();
})();
