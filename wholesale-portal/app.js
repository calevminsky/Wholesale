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

  // ---------- account (display-only this pass) ----------
  const token = new URLSearchParams(location.search).get("t") || "";
  let account = { name: "Guest", slug: "guest", customer_id: null };

  // ---------- state ----------
  let CATALOG = null;
  let PRODUCTS = [];
  const byGid = new Map();
  const filters = { q: "", type: "", color: "", tier: "full", sort: "title_asc", view: "color", density: "comfortable" };
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
    PRODUCTS = CATALOG.products || [];
    PRODUCTS.forEach((p) => byGid.set(p.gid, p));
    if (CATALOG.offer) $("#offerName").textContent = `${CATALOG.offer} Collection`;

    if (token) {
      try {
        const acc = await (await fetch("build/accounts.json", { cache: "no-store" })).json();
        const hit = acc.accounts?.[token];
        if (hit) account = { name: hit.name, slug: hit.slug, customer_id: hit.customer_id ?? null };
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
  }
  function fillSelect(sel, vals) {
    const el = $(sel);
    for (const v of vals) { const o = document.createElement("option"); o.value = v; o.textContent = v; el.appendChild(o); }
  }

  // ---------- filtering / sorting ----------
  function matchesBase(p) { // everything except tier (used for tier counts)
    if (filters.type && p.type !== filters.type) return false;
    if (filters.color && p.color !== filters.color) return false;
    if (filters.q) {
      const q = filters.q.toLowerCase();
      if (!((p.title || "").toLowerCase().includes(q) || (p.color || "").toLowerCase().includes(q) || (p.style_name || "").toLowerCase().includes(q))) return false;
    }
    return true;
  }
  function matches(p) {
    if (filters.tier === "preorder") return p.preorder && matchesBase(p);
    if (filters.tier) return !p.preorder && p.tier === filters.tier && matchesBase(p);
    return matchesBase(p); // "All" includes pre-order
  }

  // group variants of the same style into one card (pre-order kept separate from
  // the in-stock tiers so a "book now" style never merges into a Full-price card)
  function groupsOf(list) {
    const map = new Map();
    for (const p of list) {
      const key = baseTitle(p.title) + "|" + (p.preorder ? "pre" : p.tier);
      if (!map.has(key)) map.set(key, { key, base: baseTitle(p.title), tier: p.tier, preorder: !!p.preorder, type: p.type, variants: [] });
      map.get(key).variants.push(p);
    }
    const groups = [...map.values()];
    for (const g of groups) {
      g.variants.sort((a, b) => (a.color || "").localeCompare(b.color || ""));
      g.minPrice = Math.min(...g.variants.map((v) => v.wholesale_price));
      g.maxPrice = Math.max(...g.variants.map((v) => v.wholesale_price));
      g.totalAvail = g.variants.reduce((s, v) => s + (v.total_available || 0), 0);
    }
    return groups;
  }

  function sortItems(arr, keyer) {
    const dir = {
      title_asc: (a, b) => keyer.title(a).localeCompare(keyer.title(b)),
      price_desc: (a, b) => keyer.price(b) - keyer.price(a),
      price_asc: (a, b) => keyer.price(a) - keyer.price(b),
      avail_desc: (a, b) => keyer.avail(b) - keyer.avail(a)
    }[filters.sort];
    return arr.slice().sort(dir);
  }

  // ---------- tier counts ----------
  function setTierCounts() {
    const base = PRODUCTS.filter(matchesBase);
    const count = (arr) => filters.view === "style" ? groupsOf(arr).length : arr.length;
    $("#cAll").textContent = count(base);
    $("#cFull").textContent = count(base.filter((p) => p.tier === "full" && !p.preorder));
    $("#cOff").textContent = count(base.filter((p) => p.tier === "off"));
    const pre = $("#cPre"); if (pre) pre.textContent = count(base.filter((p) => p.preorder));
  }

  // ---------- render ----------
  function render() {
    setTierCounts();
    const banner = $("#noticeBanner");
    if (banner) {
      if (filters.tier === "preorder") {
        banner.style.display = "block";
        banner.innerHTML = `<b>Pre-order · F26</b> — book now; these arrive when the season lands. No live stock counts, and a few are still being priced.`;
      } else banner.style.display = "none";
    }
    const grid = $("#grid"), empty = $("#empty");
    grid.className = "grid" + (filters.density === "compact" ? " compact" : "");
    const matched = PRODUCTS.filter(matches);

    let html, n;
    if (filters.view === "style") {
      const groups = sortItems(groupsOf(matched), { title: (g) => g.base, price: (g) => g.minPrice, avail: (g) => g.totalAvail });
      n = groups.length;
      html = groups.map(groupCardHTML).join("");
    } else {
      const items = sortItems(matched, { title: (p) => p.title || "", price: (p) => p.wholesale_price, avail: (p) => p.total_available || 0 });
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
    // Pre-order: no live availability. Unpriced ones can't be ordered yet.
    if (p.preorder) {
      if (p.wholesale_price == null || !Number.isFinite(p.wholesale_price)) {
        return `<div class="prenote">Not yet priced — check back to order.</div>`;
      }
      return p.sizes.map((s) => {
        const q = Number((cart[p.gid] || {})[s.size] || 0);
        return `<div class="sizecell pre">
          <span class="sz">${s.size}</span>
          <input type="number" min="0" inputmode="numeric" data-gid="${p.gid}" data-size="${s.size}" data-avail="" value="${q || ""}" placeholder="0" class="${q > 0 ? "has" : ""}">
          <span class="av pre">pre-order</span>
        </div>`;
      }).join("");
    }
    return p.sizes.map((s) => {
      const q = Number((cart[p.gid] || {})[s.size] || 0);
      const sold = s.available <= 0;
      const over = q > s.available;
      return `<div class="sizecell ${sold ? "soldout" : ""}">
        <span class="sz">${s.size}</span>
        <input type="number" min="0" inputmode="numeric" data-gid="${p.gid}" data-size="${s.size}" data-avail="${s.available}" value="${q || ""}" placeholder="0" class="${q > 0 ? "has" : ""} ${over ? "over" : ""}">
        <span class="av ${sold ? "zero" : ""}">${sold ? "0 left" : s.available + " left"}</span>
      </div>`;
    }).join("");
  }

  function badgeHTML(o) {
    if (o && o.preorder) return `<div class="badges"><span class="badge preorder">Pre-order</span></div>`;
    const tier = o && o.tier;
    return `<div class="badges"><span class="badge ${tier}">${tier === "full" ? "Full price" : "Off price"}</span></div>`;
  }

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
    // Pre-order inputs carry an empty data-avail → no stock ceiling.
    const avail = inp.dataset.avail === "" ? Infinity : Number(inp.dataset.avail);
    let v = parseInt(inp.value, 10);
    if (!Number.isFinite(v) || v < 0) v = 0;
    if (!cart[gid]) cart[gid] = {};
    if (v > 0) cart[gid][size] = v; else delete cart[gid][size];
    if (Object.keys(cart[gid]).length === 0) delete cart[gid];
    inp.classList.toggle("has", v > 0);
    inp.classList.toggle("over", v > avail);
    inp.title = v > avail ? `Only ${avail} in stock — backorder allowed` : "";
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
    const groups = { full: lines.filter((p) => p.tier === "full"), off: lines.filter((p) => p.tier === "off") };
    const groupHTML = (label, arr, cls) => {
      if (!arr.length) return "";
      const rows = arr.map((p) => {
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
      return `<div class="tiergroup"><h3><span class="badge ${cls}">${label}</span> ${arr.length} style${arr.length === 1 ? "" : "s"}</h3>${rows}</div>`;
    };
    const ship = loadShipping();
    $("#reviewContent").innerHTML =
      groupHTML("Full Price", groups.full, "full") +
      groupHTML("Off Price", groups.off, "off") +
      `<div class="field"><label>Shipping</label>
         <div class="seg ship" id="shipSeg">
           <button data-v="all" class="${ship === "all" ? "on" : ""}">Ship all together</button>
           <button data-v="when_ready" class="${ship === "when_ready" ? "on" : ""}">Ship when ready</button>
         </div>
         <div class="note-info" style="margin-top:6px">${ship === "when_ready" ? "We’ll ship pieces as they’re ready (partial shipments)." : "We’ll hold the order and ship it complete in one go."}</div>
       </div>
       <div class="field"><label>Notes / PO number</label><textarea id="notes" rows="2" placeholder="e.g. PO 8842">${esc(loadNotes())}</textarea></div>
       <div class="totrow"><span>${t.styles} styles · ${t.units} units</span><span></span></div>
       <div class="totrow grand"><span>Order subtotal</span><span class="v">${money(t.subtotal)}</span></div>`;
    $("#reviewFootInfo").innerHTML = `Account: <b>${esc(account.name)}</b>`;
    $$("[data-rm]", $("#reviewContent")).forEach((b) => b.addEventListener("click", () => { delete cart[b.dataset.rm]; saveCart(); render(); refreshCart(); openReview(); }));
    $("#notes").addEventListener("input", (e) => saveNotes(e.target.value));
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

  // ---------- order assembly (matches wholesale_orders.items exactly) ----------
  function buildOrder() {
    const lines = cartLines();
    const items = lines.map((p) => {
      const size_qty = {};
      for (const k of SIZE_CORE) size_qty[k] = Number((cart[p.gid] || {})[k] || 0);
      if (p.sizes.some((s) => s.size === "OS")) size_qty.OS = Number((cart[p.gid] || {}).OS || 0);
      return { handle: p.handle, product_name: p.title, unit_price: p.wholesale_price, size_qty, _sources: [`(portal:${account.slug})`] };
    });
    const ship = loadShipping();
    const shipLabel = ship === "when_ready" ? "Ship when ready" : "Ship all together";
    const userNotes = loadNotes().trim();
    const notes = `[${shipLabel}]${userNotes ? " " + userNotes : ""}`;
    const dateStr = new Date().toISOString().slice(0, 10);
    return {
      name: `${account.name} ${dateStr}`,
      customer_id: account.customer_id ?? null,
      line_sheet_id: null,
      location_ids: LOCATIONS,
      shipping: ship,                 // "all" | "when_ready" (also surfaced in notes for the importer)
      notes,
      source_filename: `wholesale-portal/${account.slug}-${dateStr}.json`,
      items
    };
  }

  function buildCSV(order) {
    const hasOS = order.items.some((it) => "OS" in it.size_qty);
    const cols = ["handle", "product_name", "unit_price", ...SIZE_CORE, ...(hasOS ? ["OS"] : [])];
    const q = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const rows = [cols.join(",")];
    for (const it of order.items) {
      rows.push([it.handle, q(it.product_name), it.unit_price, ...SIZE_CORE.map((k) => it.size_qty[k] || 0), ...(hasOS ? [it.size_qty.OS || 0] : [])].join(","));
    }
    return rows.join("\n");
  }

  function download(filename, text, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; document.body.appendChild(a); a.click();
    a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function submit() {
    const order = buildOrder();
    if (!order.items.length) return;
    const dateStr = new Date().toISOString().slice(0, 10);
    const base = `${account.slug}-${dateStr}`;
    download(`${base}.csv`, buildCSV(order), "text/csv");
    download(`${base}.json`, JSON.stringify(order, null, 2), "application/json");
    console.log("[wholesale-portal] order object (matches wholesale_orders.items):", order);
    toast("Order files downloaded — hand to the wholesale team to upload.");
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
    $("#sort").addEventListener("change", (e) => { filters.sort = e.target.value; render(); });
    $("#tierSeg").addEventListener("click", (e) => {
      const b = e.target.closest(".tiertab"); if (!b) return;
      filters.tier = b.dataset.v; $$("#tierSeg .tiertab").forEach((x) => x.classList.toggle("on", x === b)); render();
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
    // reflect the default filters in the controls (default: Full price, By color)
    $$("#tierSeg .tiertab").forEach((x) => x.classList.toggle("on", x.dataset.v === filters.tier));
    $$("#viewSeg button").forEach((x) => x.classList.toggle("on", x.dataset.v === filters.view));
    $("#fColor").style.display = filters.view === "style" ? "none" : "";
  }

  boot();
})();
