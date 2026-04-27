// Line sheet editor — single unified page.
// Top: view switcher + save/export actions. Below: filter pill-bar, sort+counts,
// product table (paginated), collapsible pricing & display options.
(function () {
  const w = window;
  w.LineSheets = w.LineSheets || {};

  const SIZE_COLS = ["XS", "S", "M", "L", "XL"];
  const PAGE_SIZE = 100;

  let meta = null;
  let savedSheets = [];
  let state = null;
  let initialState = null;
  let previewTimer = null;
  let inflightPreview = 0;
  let sortMode = "newest";
  let rowLimit = PAGE_SIZE;
  let selected = new Set();

  // Autosave state. Only active once the sheet has been saved at least once
  // (i.e. has an id). Brand-new drafts still require an explicit name + Save.
  let autosaveTimer = null;
  let savingNow = false;
  let lastSavedAt = null;
  let saveError = null;
  const AUTOSAVE_DEBOUNCE_MS = 1500;

  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") e.className = v;
      else if (k === "style") e.setAttribute("style", v);
      else if (k === "html") e.innerHTML = v;
      else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined) e.setAttribute(k, v);
    }
    for (const c of [].concat(children || [])) {
      if (c == null || c === false) continue;
      e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return e;
  }

  function fmtMoney(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n === 0) return "—";
    return "$" + n.toFixed(2);
  }

  function defaultFilterTree() {
    return {
      include: [{ conditions: [{ field: "season", op: "in", value: ["Spring 2026"] }] }],
      globals: []
    };
  }

  // Locations to pre-select on a brand-new sheet. Matched against the
  // location names from /api/linesheets/meta as case-insensitive substrings,
  // so renaming a location from "Bogota Warehouse" to "Bogotá Hub" still
  // matches "bogota". Edit this list if the org's defaults change.
  const DEFAULT_STOCK_LOCATION_PATTERNS = ["bogota", "warehouse"];

  function defaultStockLocationIds() {
    const locs = (meta && meta.locations) || [];
    if (!locs.length) return [];
    const ids = [];
    for (const pat of DEFAULT_STOCK_LOCATION_PATTERNS) {
      const hit = locs.find((l) => String(l.name || "").toLowerCase().includes(pat));
      if (hit && !ids.includes(String(hit.id))) ids.push(String(hit.id));
    }
    return ids;
  }

  // Label for the inventory column header so the user can see at a glance
  // which locations are being counted in those numbers.
  function inventoryHeaderLabel() {
    const ids = (state?.display_opts?.ats_locations || []).map(String);
    if (!ids.length) return "Total";
    const locs = (meta && meta.locations) || [];
    const names = ids
      .map((id) => locs.find((l) => String(l.id) === id)?.name)
      .filter(Boolean);
    if (!names.length) return `Total (${ids.length} locs)`;
    if (names.length <= 2) return `Total at ${names.join(" + ")}`;
    return `Total at ${names[0]} + ${names.length - 1} more`;
  }

  function defaultState() {
    return {
      id: null,
      name: "",
      customer: "",
      description: "",
      filter_tree: defaultFilterTree(),
      saved_filter_id: null,
      saved_filter_name: null,
      pins: [],
      excludes: [],
      pricing: { default_mode: "pct_off_compare_at", default_value: 50, additional_discount_pct: 0, overrides: {} },
      display_opts: { ats_locations: defaultStockLocationIds() },
      products: [],
      counts: {},
      capped: false,
      loading: false,
      metaError: null,
      previewError: null
    };
  }

  async function loadMeta() {
    const r = await fetch("/api/linesheets/meta");
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      meta = { seasons: [], classes: [], product_types: [], locations: [], fabrics: [], sleeves: [] };
      state && (state.metaError = j.error || `Meta unavailable (HTTP ${r.status})`);
    } else {
      meta = await r.json();
    }
    meta.tag_suggestions = Array.from(new Set([
      "KNIT", "WOVEN", "Long Sleeve", "Short Sleeve", "Sleeveless", "nada-ignore",
      ...(meta.tag_suggestions || [])
    ]));
    return meta;
  }

  async function loadSavedSheets() {
    try {
      const r = await fetch("/api/linesheets");
      if (!r.ok) return [];
      const j = await r.json();
      savedSheets = j.linesheets || [];
    } catch { savedSheets = []; }
    return savedSheets;
  }

  async function bootstrap(container) {
    if (!container) return;
    container.innerHTML = "<div class=\"muted\" style=\"padding:20px;\">Loading…</div>";

    state = defaultState();
    await Promise.all([loadMeta(), loadSavedSheets()]);

    // defaultState() runs before meta is loaded, so the location-based
    // defaults can't resolve. Fill them in now that meta is here.
    if (!state.id && (!state.display_opts.ats_locations || state.display_opts.ats_locations.length === 0)) {
      state.display_opts.ats_locations = defaultStockLocationIds();
    }

    initialState = snapshot(state);
    selected = new Set();
    rowLimit = PAGE_SIZE;

    renderShell(container);
    await refreshPreview();
  }

  function snapshot(s) {
    return JSON.stringify({
      id: s.id, name: s.name, customer: s.customer, description: s.description,
      filter_tree: s.filter_tree, pins: s.pins, excludes: s.excludes,
      pricing: s.pricing, display_opts: s.display_opts
    });
  }

  function isDirty() {
    return initialState !== snapshot(state);
  }

  async function openSaved(id) {
    const container = document.getElementById("lsEditorRoot");
    container.innerHTML = "<div class=\"muted\" style=\"padding:20px;\">Loading…</div>";
    const r = await fetch(`/api/linesheets/${id}`);
    if (!r.ok) {
      container.innerHTML = "<div class=\"muted\">Failed to load.</div>";
      return;
    }
    const j = await r.json();
    const l = j.linesheet;
    state = {
      id: l.id,
      name: l.name,
      customer: l.customer || "",
      description: l.description || "",
      filter_tree: l.filter_tree || defaultFilterTree(),
      saved_filter_id: l.saved_filter_id || null,
      saved_filter_name: l.saved_filter_name || null,
      pins: l.pins || [],
      excludes: l.excludes || [],
      pricing: Object.assign({ default_mode: "pct_off_compare_at", default_value: 50, additional_discount_pct: 0, overrides: {} }, l.pricing || {}),
      display_opts: Object.assign({ ats_locations: [] }, l.display_opts || {}),
      products: j.products || [],
      counts: j.counts || {},
      capped: !!j.capped,
      loading: false,
      metaError: null
    };
    if (state.display_opts.sort) sortMode = state.display_opts.sort;
    initialState = snapshot(state);
    selected = new Set();
    rowLimit = PAGE_SIZE;
    lastSavedAt = null;     // shows just "Saved" until the next autosave
    saveError = null;
    clearTimeout(autosaveTimer);
    renderShell(container);
  }

  function newDraft() {
    const container = document.getElementById("lsEditorRoot");
    state = defaultState();
    initialState = snapshot(state);
    lastSavedAt = null;
    saveError = null;
    clearTimeout(autosaveTimer);
    selected = new Set();
    rowLimit = PAGE_SIZE;
    renderShell(container);
    refreshPreview();
  }

  // --- DOM ---

  function renderShell(root) {
    root.innerHTML = "";
    root.classList.add("ls-page");

    root.appendChild(renderHeader());

    // Body: filter rail on the left, main column on the right.
    const body = el("div", { class: "ls-body" });
    body.appendChild(renderFilterRail());
    const main = el("div", { class: "ls-main" });
    main.appendChild(renderControlsRow());
    main.appendChild(renderTableArea());
    main.appendChild(renderAdvancedArea());
    body.appendChild(main);
    root.appendChild(body);

    root.appendChild(renderBulkBar()); // fixed footer, only shows when selection
  }

  function renderFilterRail() {
    const wrap = el("div", { class: "ls-rail-wrap" });
    if (state.metaError) {
      wrap.appendChild(el("div", { class: "ls-warn" }, [
        el("b", null, "Filter options unavailable. "),
        document.createTextNode(state.metaError + " — filters will work once the reporting DB is connected.")
      ]));
    }
    if (state.previewError) {
      wrap.appendChild(el("div", { class: "ls-warn" }, [
        el("b", null, "Couldn't load products. "),
        document.createTextNode(state.previewError)
      ]));
    }
    const railRoot = el("div");
    const railOpts = {
      onChange: () => paintRail(),
      getStockLocations: () => state.display_opts.ats_locations || [],
      setStockLocations: (arr) => {
        state.display_opts.ats_locations = arr.map(String);
        paintRail();
      }
    };
    function paintRail() {
      rowLimit = PAGE_SIZE; // reset pagination on filter change
      debouncePreview();
      w.LineSheets.renderFilterRail(railRoot, state.filter_tree, meta, railOpts);
    }
    w.LineSheets.renderFilterRail(railRoot, state.filter_tree, meta, railOpts);
    wrap.appendChild(railRoot);

    // Advanced filter expandable: kept available for power users.
    const advWrap = el("details", { class: "ls-rail-adv" });
    advWrap.appendChild(el("summary", null, "Advanced filter…"));
    const advBar = el("div", { class: "lsf-bar" });
    w.LineSheets.renderFilterBar(advBar, state.filter_tree, meta, () => {
      rowLimit = PAGE_SIZE;
      debouncePreview();
    });
    advWrap.appendChild(advBar);
    wrap.appendChild(advWrap);

    return wrap;
  }

  function renderHeader() {
    const hdr = el("div", { class: "ls-hd" });

    // Left: view switcher + name
    const left = el("div", { class: "ls-hd-l" });

    const viewSel = el("select", { class: "ls-views" });
    viewSel.appendChild(el("option", { value: "__new__" }, "+ New view"));
    if (savedSheets.length) viewSel.appendChild(el("option", { value: "", disabled: "disabled" }, "── Saved views ──"));
    for (const s of savedSheets) {
      const label = s.customer ? `${s.name} · ${s.customer}` : s.name;
      viewSel.appendChild(el("option", { value: String(s.id) }, label));
    }
    viewSel.value = state.id ? String(state.id) : "__new__";
    viewSel.addEventListener("change", async () => {
      if (isDirty() && !confirm("Discard unsaved changes to this view?")) {
        viewSel.value = state.id ? String(state.id) : "__new__";
        return;
      }
      if (viewSel.value === "__new__") newDraft();
      else openSaved(Number(viewSel.value));
    });
    left.appendChild(viewSel);

    const nameLabel = el("div", { class: "ls-hd-title" }, [
      document.createTextNode(state.name || "Untitled view")
    ]);
    left.appendChild(nameLabel);

    const statusEl = el("span", { id: "ls-save-status", class: "ls-save-status" }, saveStatusText());
    statusEl.classList.toggle("ls-save-status-warn", savingNow || !!saveError || isDirty() || !state.id);
    statusEl.classList.toggle("ls-save-status-ok", !savingNow && !saveError && !isDirty() && !!state.id);
    left.appendChild(statusEl);

    hdr.appendChild(left);

    // Right: actions
    const right = el("div", { class: "ls-hd-r" });

    right.appendChild(el("button", {
      onclick: () => editNameDialog()
    }, state.name ? "Rename" : "Name view"));

    right.appendChild(el("button", {
      class: "primary",
      onclick: () => save({ rename: false })
    }, state.id ? "Save" : "Save view"));

    right.appendChild(el("button", {
      onclick: () => save({ saveAs: true })
    }, "Save as…"));

    right.appendChild(el("button", {
      class: "primary",
      onclick: exportPdf
    }, "Export PDF"));

    right.appendChild(el("button", {
      onclick: exportOrderForm,
      title: "Customer-friendly XLSX with MSRP and wholesale pre-filled. Customer fills in quantities and emails it back."
    }, "Export Order Form"));

    // Overflow menu
    const more = el("div", { class: "ls-more" });
    const moreBtn = el("button", { class: "ls-more-btn", title: "More actions" }, "⋯");
    const moreMenu = el("div", { class: "ls-more-menu" });
    moreMenu.appendChild(el("button", {
      onclick: async () => {
        if (!state.id) return alert("Save the view first.");
        const r = await fetch(`/api/linesheets/${state.id}/duplicate`, { method: "POST" });
        if (!r.ok) return alert("Duplicate failed");
        const j = await r.json();
        await loadSavedSheets();
        openSaved(j.linesheet.id);
      }
    }, "Duplicate view"));
    moreMenu.appendChild(el("button", {
      onclick: async () => {
        if (!state.id) return alert("This view isn't saved yet.");
        if (!confirm(`Archive "${state.name}"?`)) return;
        const r = await fetch(`/api/linesheets/${state.id}`, { method: "DELETE" });
        if (!r.ok) return alert("Archive failed");
        await loadSavedSheets();
        newDraft();
      }
    }, "Archive view"));
    moreMenu.appendChild(el("button", {
      onclick: () => { if (state.id) window.open(`/api/linesheets/${state.id}/render.html`, "_blank"); else alert("Save the view first."); }
    }, "Preview in browser"));
    moreBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      moreMenu.classList.toggle("open");
    });
    document.addEventListener("click", () => moreMenu.classList.remove("open"));
    more.appendChild(moreBtn);
    more.appendChild(moreMenu);
    right.appendChild(more);

    hdr.appendChild(right);

    return hdr;
  }

  function renderFilterArea() {
    const wrap = el("div", { class: "ls-filter-area" });

    if (state.metaError) {
      wrap.appendChild(el("div", { class: "ls-warn" }, [
        el("b", null, "Filter options unavailable. "),
        document.createTextNode(state.metaError + " — filters will work once the reporting DB is connected.")
      ]));
    }
    if (state.previewError) {
      wrap.appendChild(el("div", { class: "ls-warn" }, [
        el("b", null, "Couldn't load products. "),
        document.createTextNode(state.previewError)
      ]));
    }

    const bar = el("div", { class: "lsf-bar" });
    w.LineSheets.renderFilterBar(bar, state.filter_tree, meta, () => {
      rowLimit = PAGE_SIZE; // reset pagination on filter change
      debouncePreview();
    });
    wrap.appendChild(bar);

    return wrap;
  }

  function renderControlsRow() {
    const row = el("div", { class: "ls-controls" });

    // Sort
    const sortSel = el("select", { class: "ls-sort" }, [
      el("option", { value: "newest" }, "Sort: Newest first"),
      el("option", { value: "style_asc" }, "Sort: Style name (A→Z)"),
      el("option", { value: "style_desc" }, "Sort: Style name (Z→A)"),
      el("option", { value: "price_asc" }, "Sort: Price (low→high)"),
      el("option", { value: "price_desc" }, "Sort: Price (high→low)"),
      el("option", { value: "inventory_desc" }, "Sort: Inventory (most)"),
      el("option", { value: "inventory_asc" }, "Sort: Inventory (least)")
    ]);
    sortSel.value = sortMode;
    sortSel.addEventListener("change", () => { sortMode = sortSel.value; renderTableBody(); });
    row.appendChild(sortSel);

    // The Stock section in the left rail now controls which locations count
    // toward the inventory column, so the standalone "Available at:" picker
    // is no longer needed here.

    // Add product by name (pin)
    const pinWrap = el("div", { class: "ls-addprod" });
    const pinInput = el("input", { type: "search", placeholder: "+ Add product by name…", class: "ls-addprod-inp" });
    const pinResults = el("div", { class: "ls-addprod-res" });
    pinWrap.appendChild(pinInput); pinWrap.appendChild(pinResults);

    let searchT = null;
    pinInput.addEventListener("input", () => {
      clearTimeout(searchT);
      const q = pinInput.value.trim();
      if (q.length < 2) { pinResults.style.display = "none"; return; }
      searchT = setTimeout(async () => {
        const r = await fetch("/api/products/search?q=" + encodeURIComponent(q));
        if (!r.ok) { pinResults.style.display = "none"; return; }
        const j = await r.json();
        pinResults.innerHTML = "";
        for (const p of j.products || []) {
          const rr = el("div", {
            class: "ls-addprod-row",
            onclick: () => {
              pinResults.style.display = "none";
              pinInput.value = "";
              if (!p.id) { alert("Product id unavailable"); return; }
              if (!state.pins.includes(p.id)) state.pins.push(p.id);
              debouncePreview();
            }
          }, [
            p.imageUrl ? el("img", { src: p.imageUrl + "?width=40" }) : el("div", { class: "ls-addprod-noimg" }),
            el("span", null, p.title)
          ]);
          pinResults.appendChild(rr);
        }
        pinResults.style.display = (j.products || []).length ? "block" : "none";
      }, 220);
    });
    pinInput.addEventListener("blur", () => setTimeout(() => pinResults.style.display = "none", 180));
    row.appendChild(pinWrap);

    // Counts
    const spacer = el("div", { style: "flex:1;" });
    row.appendChild(spacer);

    const c = state.counts || {};
    const countText = state.loading ? "Loading…" :
      `${c.final ?? 0} in view` +
      (c.excluded ? ` · ${c.excluded} excluded` : "") +
      (c.pinned ? ` · ${c.pinned} pinned` : "") +
      (state.capped ? " · capped at 500" : "");
    row.appendChild(el("div", { class: "ls-counts" }, countText));

    return row;
  }

  function renderTableArea() {
    const wrap = el("div", { class: "ls-table-wrap", id: "lsTableWrap" });
    renderTableBodyInto(wrap);
    return wrap;
  }

  function renderTableBody() {
    const wrap = document.getElementById("lsTableWrap");
    if (!wrap) return;
    renderTableBodyInto(wrap);
    // Also refresh counts/header dependent bits
    const shell = document.getElementById("lsEditorRoot");
    const controls = shell.querySelector(".ls-controls");
    if (controls) controls.replaceWith(renderControlsRow());
    const bulkOld = shell.querySelector(".ls-bulk");
    if (bulkOld) bulkOld.replaceWith(renderBulkBar());
    const hdrOld = shell.querySelector(".ls-hd");
    if (hdrOld) hdrOld.replaceWith(renderHeader());
  }

  function renderTableBodyInto(wrap) {
    wrap.innerHTML = "";

    if (state.loading) {
      wrap.appendChild(el("div", { class: "muted", style: "padding:20px;text-align:center;" }, "Loading products…"));
      return;
    }

    const all = sortProducts(state.products || []);
    if (all.length === 0) {
      const emptyMsg = state.metaError
        ? "Connect the reporting DB to load products."
        : state.previewError
          ? "A database error prevented loading. See the banner above."
          : "No products match the current filters. Try removing a filter or clicking + Add filter above.";
      wrap.appendChild(el("div", { class: "ls-empty" }, [
        el("div", { class: "ls-empty-title" }, "No products"),
        el("div", { class: "muted" }, emptyMsg)
      ]));
      return;
    }

    const rows = all.slice(0, rowLimit);

    const tbl = el("table", { class: "ls-tbl" });
    tbl.appendChild(renderColgroup());
    tbl.appendChild(renderTableHead(all));
    const tbody = document.createElement("tbody");
    for (const p of rows) tbody.appendChild(renderTableRow(p));
    tbl.appendChild(tbody);
    wrap.appendChild(tbl);

    if (all.length > rowLimit) {
      const more = el("div", { class: "ls-more-row" }, [
        el("button", {
          onclick: () => {
            rowLimit = Math.min(rowLimit + PAGE_SIZE, all.length);
            renderTableBody();
          }
        }, `Show ${Math.min(PAGE_SIZE, all.length - rowLimit)} more`),
        el("span", { class: "muted", style: "margin-left:12px;" }, `Showing ${rowLimit} of ${all.length}`)
      ]);
      wrap.appendChild(more);
    } else if (all.length > PAGE_SIZE) {
      wrap.appendChild(el("div", { class: "muted", style: "padding:8px 2px;" }, `Showing all ${all.length}`));
    }
  }

  // Column widths (px). Kept in one place so <colgroup>, <thead>, and
  // <tbody> stay aligned when we change the layout. Changes here are the
  // single source of truth — the actual <th>/<td> get no explicit width.
  const COL_WIDTHS = {
    chk:   36,
    img:   60,
    prod:  320,
    msrp:  80,
    price: 110,
    notes: 180,
    size:  48,
    total: 64,
    act:   74
  };

  function renderColgroup() {
    const g = document.createElement("colgroup");
    const add = (w) => g.appendChild(Object.assign(document.createElement("col"), { style: `width:${w}px` }));
    add(COL_WIDTHS.chk);
    add(COL_WIDTHS.img);
    add(COL_WIDTHS.prod);
    add(COL_WIDTHS.msrp);
    add(COL_WIDTHS.price);
    add(COL_WIDTHS.notes);
    for (let i = 0; i < SIZE_COLS.length; i++) add(COL_WIDTHS.size);
    add(COL_WIDTHS.total);
    add(COL_WIDTHS.act);
    return g;
  }

  function renderTableHead(all) {
    const cols = [
      { key: "_chk", label: selectAllCell(all), align: "center" },
      { key: "image", label: "", align: "center" },
      { key: "style_name", label: "Product", align: "left" },
      { key: "compare_at_price", label: "MSRP", align: "right" },
      { key: "effective_price", label: "Price", align: "right" },
      { key: "notes", label: "Notes", align: "left" }
    ];
    for (const s of SIZE_COLS) cols.push({ key: `sz_${s}`, label: s, align: "center" });
    cols.push({ key: "inventory_total", label: inventoryHeaderLabel(), align: "right" });
    cols.push({ key: "_act", label: "", align: "center" });

    const tr = el("tr");
    for (const c of cols) {
      const th = el("th", { style: `text-align:${c.align}` });
      if (typeof c.label === "string") th.textContent = c.label; else th.appendChild(c.label);
      tr.appendChild(th);
    }
    return el("thead", null, tr);
  }

  function selectAllCell(all) {
    const cb = el("input", { type: "checkbox", title: "Select all shown" });
    const visibleIds = all.slice(0, rowLimit).map(p => p.product_id);
    cb.checked = visibleIds.length > 0 && visibleIds.every(id => selected.has(id));
    cb.addEventListener("change", () => {
      if (cb.checked) visibleIds.forEach(id => selected.add(id));
      else visibleIds.forEach(id => selected.delete(id));
      renderTableBody();
    });
    return cb;
  }

  function renderTableRow(p) {
    const isExcluded = !!p.excluded;
    const isPinned = p.source === "pinned" || state.pins.includes(p.product_id);
    const classes = ["ls-row"];
    if (isExcluded) classes.push("ls-excluded");
    if (isPinned)   classes.push("ls-pinned");

    const tr = el("tr", { class: classes.join(" ") });

    // checkbox
    const cb = el("input", { type: "checkbox" });
    cb.checked = selected.has(p.product_id);
    cb.addEventListener("change", () => {
      if (cb.checked) selected.add(p.product_id);
      else selected.delete(p.product_id);
      // refresh bulk bar
      const shell = document.getElementById("lsEditorRoot");
      const bulkOld = shell.querySelector(".ls-bulk");
      if (bulkOld) bulkOld.replaceWith(renderBulkBar());
    });
    tr.appendChild(el("td", { class: "ls-chk" }, [cb]));

    // image
    tr.appendChild(el("td", { class: "ls-img" },
      p.image ? [el("img", { src: p.image + "?width=80" })] : ""));

    // title
    const upsell = Array.isArray(p.upsell_list) ? p.upsell_list : [];
    const upsellNames = upsell.map((u) => u.title).filter(Boolean);
    tr.appendChild(el("td", { class: "ls-prod" }, [
      el("div", { class: "ls-prod-title" }, p.title || ""),
      upsellNames.length
        ? el("div", { class: "ls-prod-upsell", title: "From the theme.upsell_list metafield. Customers see these in the Pairs With column on the PDF." },
            "Pairs with: " + upsellNames.join(", "))
        : null,
      el("div", { class: "ls-prod-badges" }, [
        isPinned ? el("span", { class: "ls-badge ls-badge-pin", title: "Always included regardless of filters" }, "always included") : null,
        isExcluded ? el("span", { class: "ls-badge ls-badge-ex", title: "Hidden from this sheet" }, "hidden") : null,
        p.price_tier === "off_price" ? el("span", { class: "ls-badge ls-badge-off" }, "off price") : null
      ])
    ]));

    tr.appendChild(el("td", { class: "num" }, fmtMoney(p.compare_at_price || p.current_price)));

    // Price: click-to-edit. Stores into state.pricing.overrides[product_id];
    // shows a reset arrow when overridden so the manager can revert to the
    // global default. Submitted/archived sheets stay editable here too.
    tr.appendChild(renderPriceCell(p));

    // Notes: click-to-edit free-text per product, persisted in
    // state.display_opts.notes_by_product[product_id].
    tr.appendChild(renderNotesCell(p));

    for (const s of SIZE_COLS) {
      const qty = Number(p.inventory_by_size?.[s] || 0);
      tr.appendChild(el("td", { class: "num" + (qty === 0 ? " ls-zero" : "") }, qty ? String(qty) : ""));
    }
    tr.appendChild(el("td", { class: "num" }, String(p.inventory_total || 0)));

    // actions
    const act = el("td", { class: "ls-act" });
    if (isExcluded) {
      act.appendChild(iconBtn("↺", "Show again", () => {
        state.excludes = state.excludes.filter(id => id !== p.product_id);
        debouncePreview();
      }));
    } else {
      act.appendChild(iconBtn("✕", "Hide from this sheet", () => {
        if (!state.excludes.includes(p.product_id)) state.excludes.push(p.product_id);
        debouncePreview();
      }));
      act.appendChild(iconBtn(
        isPinned ? "☆" : "⭐",
        isPinned ? "Stop always including" : "Always include (even if filters change)",
        () => {
          if (isPinned) state.pins = state.pins.filter(id => id !== p.product_id);
          else if (!state.pins.includes(p.product_id)) state.pins.push(p.product_id);
          debouncePreview();
        }
      ));
    }
    tr.appendChild(act);

    return tr;
  }

  function iconBtn(sym, title, onclick) {
    return el("button", { class: "ls-iconbtn", title, onclick }, sym);
  }

  function renderNotesCell(p) {
    const notes = state.display_opts.notes_by_product || {};
    const current = notes[p.product_id] || "";
    const td = el("td", {
      class: "ls-notes-cell" + (current ? " has-note" : ""),
      title: "Click to add a note for this product"
    });

    const renderView = () => {
      td.innerHTML = "";
      td.classList.remove("editing");
      if (current) {
        td.appendChild(el("span", { class: "ls-notes-text" }, current));
      } else {
        td.appendChild(el("span", { class: "muted" }, "+ note"));
      }
    };

    td.addEventListener("click", () => {
      if (td.classList.contains("editing")) return;
      td.classList.add("editing");
      td.innerHTML = "";
      const inp = el("textarea", { class: "ls-notes-input", rows: "2" });
      inp.value = current;
      td.appendChild(inp);
      inp.focus();
      // Place caret at end so the user can keep typing
      inp.setSelectionRange(inp.value.length, inp.value.length);

      const commit = () => {
        const next = inp.value;
        const map = state.display_opts.notes_by_product || {};
        if (next.trim() === "") delete map[p.product_id];
        else map[p.product_id] = next;
        state.display_opts.notes_by_product = map;
        // Saving fires the autosave debounce + repaints the row.
        debouncePreview();
      };
      const cancel = () => debouncePreview();
      inp.addEventListener("blur", commit);
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); inp.blur(); }
        else if (e.key === "Escape") { e.preventDefault(); cancel(); }
      });
    });

    renderView();
    return td;
  }

  function renderPriceCell(p) {
    const td = el("td", {
      class: "num ls-price ls-price-edit" + (p.has_override ? " has-override" : ""),
      title: "Click to set a custom price for this product"
    });

    const valueSpan = el("span", { class: "ls-price-val" }, fmtMoney(p.effective_price ?? 0));
    td.appendChild(valueSpan);

    if (p.has_override) {
      td.appendChild(el("button", {
        class: "ls-price-reset",
        title: "Reset to default pricing",
        onclick: (ev) => {
          ev.stopPropagation();
          if (state.pricing.overrides) delete state.pricing.overrides[p.product_id];
          debouncePreview();
        }
      }, "↺"));
    }

    td.addEventListener("click", (ev) => {
      // Don't re-enter edit mode while typing
      if (td.classList.contains("editing")) return;
      td.classList.add("editing");
      td.innerHTML = "";
      const inp = el("input", {
        type: "number",
        step: "0.01",
        min: "0",
        class: "ls-price-input",
        value: String(p.effective_price ?? 0)
      });
      td.appendChild(inp);
      inp.focus();
      inp.select();

      const commit = () => {
        const raw = inp.value.trim();
        if (raw === "") {
          // Empty = remove override
          if (state.pricing.overrides) delete state.pricing.overrides[p.product_id];
        } else {
          const n = Number(raw);
          if (Number.isFinite(n) && n >= 0) {
            state.pricing.overrides = state.pricing.overrides || {};
            state.pricing.overrides[p.product_id] = Math.round(n * 100) / 100;
          }
        }
        debouncePreview();
      };
      const cancel = () => debouncePreview(); // re-renders the cell
      inp.addEventListener("blur", commit);
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); inp.blur(); }
        else if (e.key === "Escape") { e.preventDefault(); cancel(); }
      });
    });

    return td;
  }

  function sortProducts(arr) {
    const copy = [...arr];
    // Stable primary partitioning: pinned first, excluded last
    const pinSet = new Set(state.pins || []);
    const exSet = new Set(state.excludes || []);
    copy.sort((a, b) => {
      const aPin = pinSet.has(a.product_id) ? 1 : 0;
      const bPin = pinSet.has(b.product_id) ? 1 : 0;
      if (aPin !== bPin) return bPin - aPin;
      const aEx = exSet.has(a.product_id) ? 1 : 0;
      const bEx = exSet.has(b.product_id) ? 1 : 0;
      if (aEx !== bEx) return aEx - bEx;
      return compareBy(a, b);
    });
    return copy;
  }

  function compareBy(a, b) {
    switch (sortMode) {
      case "newest": return productAge(b) - productAge(a);
      case "style_asc":  return String(a.style_name || a.title || "").localeCompare(String(b.style_name || b.title || ""));
      case "style_desc": return String(b.style_name || b.title || "").localeCompare(String(a.style_name || a.title || ""));
      case "price_asc":  return (a.effective_price ?? a.current_price ?? 0) - (b.effective_price ?? b.current_price ?? 0);
      case "price_desc": return (b.effective_price ?? b.current_price ?? 0) - (a.effective_price ?? a.current_price ?? 0);
      case "inventory_desc": return (b.inventory_total || 0) - (a.inventory_total || 0);
      case "inventory_asc":  return (a.inventory_total || 0) - (b.inventory_total || 0);
      default: return 0;
    }
  }

  // Shopify numeric product IDs are monotonically increasing; use them as newness proxy.
  function productAge(p) {
    const m = String(p.product_id || "").match(/(\d+)$/);
    return m ? Number(m[1]) : 0;
  }

  function renderAtsLocationsPicker() {
    const wrap = el("div", { class: "ls-ats" });
    const locs = (meta && meta.locations) || [];
    const selectedIds = new Set((state.display_opts.ats_locations || []).map(String));
    const label = (() => {
      if (selectedIds.size === 0) return "All locations";
      if (selectedIds.size === 1) {
        const id = [...selectedIds][0];
        return (locs.find(l => String(l.id) === id)?.name) || "1 location";
      }
      return `${selectedIds.size} locations`;
    })();

    const btn = el("button", { class: "ls-ats-btn" }, `Available at: ${label} ▾`);
    const pop = el("div", { class: "ls-ats-pop" });

    function closePop() { pop.style.display = "none"; document.removeEventListener("click", outside, true); }
    function outside(ev) { if (!wrap.contains(ev.target)) closePop(); }

    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const opening = pop.style.display !== "block";
      pop.style.display = opening ? "block" : "none";
      if (opening) setTimeout(() => document.addEventListener("click", outside, true), 0);
      else document.removeEventListener("click", outside, true);
    });

    if (locs.length === 0) {
      pop.appendChild(el("div", { class: "muted", style: "padding:6px;" }, "No locations available."));
    } else {
      const header = el("div", { class: "ls-ats-hdr" }, [
        el("b", null, "Count inventory from:"),
        el("div", { class: "muted", style: "font-size:11px;" }, "Empty = all locations")
      ]);
      pop.appendChild(header);

      const list = el("div", { class: "ls-ats-list" });
      for (const l of locs) {
        const id = "ats_" + l.id;
        const cb = el("input", { type: "checkbox", id });
        cb.checked = selectedIds.has(String(l.id));
        cb.addEventListener("change", () => {
          if (cb.checked) selectedIds.add(String(l.id));
          else selectedIds.delete(String(l.id));
          state.display_opts.ats_locations = [...selectedIds];
          rowLimit = PAGE_SIZE;
          debouncePreview();
        });
        list.appendChild(el("label", { class: "lsf-opt", for: id }, [cb, document.createTextNode(" " + (l.name || l.id))]));
      }
      pop.appendChild(list);

      const actions = el("div", { class: "lsf-pop-actions" }, [
        el("button", { onclick: () => {
          selectedIds.clear();
          state.display_opts.ats_locations = [];
          debouncePreview();
          closePop();
        } }, "All locations")
      ]);
      pop.appendChild(actions);
    }

    wrap.appendChild(btn);
    wrap.appendChild(pop);
    return wrap;
  }

  function renderBulkBar() {
    const bar = el("div", { class: "ls-bulk" + (selected.size > 0 ? " active" : "") });
    if (selected.size === 0) return bar;

    bar.appendChild(el("span", { class: "ls-bulk-count" }, `${selected.size} selected`));
    bar.appendChild(el("button", {
      onclick: () => {
        for (const id of selected) if (!state.excludes.includes(id)) state.excludes.push(id);
        selected.clear();
        debouncePreview();
      }
    }, "Hide"));
    bar.appendChild(el("button", {
      onclick: () => {
        for (const id of selected) if (!state.pins.includes(id)) state.pins.push(id);
        selected.clear();
        debouncePreview();
      }
    }, "Always include"));
    bar.appendChild(el("button", {
      onclick: () => {
        state.excludes = state.excludes.filter(id => !selected.has(id));
        selected.clear();
        debouncePreview();
      }
    }, "Show again"));
    bar.appendChild(el("button", {
      class: "ls-bulk-x",
      onclick: () => { selected.clear(); renderTableBody(); }
    }, "Clear"));
    return bar;
  }

  function renderAdvancedArea() {
    const box = el("div", { class: "ls-adv" });

    // Pricing
    const pricingDet = el("details", { open: "" });
    pricingDet.appendChild(el("summary", null, priceSummary()));
    const pb = el("div", { class: "ls-adv-body" });
    pricingDet.appendChild(pb);
    const overrideCount = Object.keys(state.pricing.overrides || {}).length;
    w.LineSheets.renderPricingBar(pb, state.pricing, {
      onChange: () => debouncePreview(),
      onApplyAll: () => {
        if (overrideCount && !confirm(`Clear ${overrideCount} hand-edited override(s) and apply default to all?`)) return;
        state.pricing.overrides = {};
        debouncePreview();
      },
      onResetOverrides: () => { state.pricing.overrides = {}; debouncePreview(); },
      overrideCount
    });
    box.appendChild(pricingDet);

    // Display options
    const dispDet = el("details", null);
    dispDet.appendChild(el("summary", null, "Display options"));
    dispDet.appendChild(renderDisplayOptsBody());
    box.appendChild(dispDet);

    // Metadata (customer, description)
    const metaDet = el("details", null);
    metaDet.appendChild(el("summary", null, "Customer & description"));
    const mb = el("div", { class: "ls-adv-body" });
    const cust = el("input", { type: "text", value: state.customer, placeholder: "Customer (e.g. 'Boutique A')" });
    cust.addEventListener("input", () => state.customer = cust.value);
    const desc = el("input", { type: "text", value: state.description, placeholder: "Internal description" });
    desc.addEventListener("input", () => state.description = desc.value);
    mb.appendChild(el("div", { class: "ls-row" }, [el("label", null, "Customer: "), cust]));
    mb.appendChild(el("div", { class: "ls-row", style: "margin-top:8px;" }, [el("label", null, "Description: "), desc]));
    metaDet.appendChild(mb);
    box.appendChild(metaDet);

    return box;
  }

  function priceSummary() {
    const m = state.pricing.default_mode;
    const v = state.pricing.default_value;
    const add = Number(state.pricing.additional_discount_pct) || 0;
    const count = Object.keys(state.pricing.overrides || {}).length;
    const label = m === "fixed" ? `Fixed $${v}` :
                  m === "pct_off_current" ? `${v}% off current` :
                  `${v}% off MSRP`;
    const addLabel = add > 0 ? ` · then ${add}% extra off` : "";
    return `Pricing: ${label}${addLabel}${count ? ` · ${count} overrides` : ""}`;
  }

  function renderDisplayOptsBody() {
    const opts = state.display_opts;
    const body = el("div", { class: "ls-adv-body" });

    const makeCheckbox = (key, label, defaultVal) => {
      const id = "opt_" + key;
      const inp = el("input", { type: "checkbox", id });
      inp.checked = opts[key] ?? defaultVal;
      inp.addEventListener("change", () => { opts[key] = inp.checked; });
      return el("label", { for: id, class: "ls-chkbox" }, [inp, document.createTextNode(" " + label)]);
    };

    // Inventory visibility: stored as `hide_inventory` so the natural default
    // (checkbox checked = hidden) flows through unchanged on saved sheets.
    // Migrate legacy show_inventory if present.
    if (opts.hide_inventory === undefined && opts.show_inventory !== undefined) {
      opts.hide_inventory = !opts.show_inventory;
    }

    body.appendChild(el("div", { class: "ls-row" }, [
      makeCheckbox("hide_inventory", "Hide inventory from customer (PDF)", true),
      makeCheckbox("show_msrp", "Show MSRP on PDF", true),
      makeCheckbox("show_notes", "Show notes column on PDF", true),
      makeCheckbox("show_pairs", "Show pairs-with column on PDF", true)
    ]));

    const groupSel = el("select", null, ["none", "season", "product_type", "class"].map(v => el("option", { value: v }, v)));
    groupSel.value = opts.group_by || "none";
    groupSel.addEventListener("change", () => { opts.group_by = groupSel.value === "none" ? null : groupSel.value; });

    const minInv = el("input", { type: "number", value: opts.min_live_inventory ?? 1, style: "width:60px;" });
    minInv.addEventListener("change", () => { opts.min_live_inventory = Number(minInv.value); });

    const staleSel = el("select", null, ["drop", "flag", "ignore"].map(v => el("option", { value: v }, v)));
    staleSel.value = opts.stale_behavior || "drop";
    staleSel.addEventListener("change", () => { opts.stale_behavior = staleSel.value; });

    body.appendChild(el("div", { class: "ls-row", style: "margin-top:8px;" }, [
      el("label", null, "Group by: "), groupSel,
      el("label", { style: "margin-left:12px;" }, "Min live inv: "), minInv,
      el("label", { style: "margin-left:12px;" }, "Stale behavior: "), staleSel
    ]));

    return body;
  }

  // --- Actions ---

  function debouncePreview() {
    clearTimeout(previewTimer);
    // Repaint chrome that reflects state (dirty, counts, badges)
    renderTableBody();
    previewTimer = setTimeout(refreshPreview, 220);
    scheduleAutosave();
    refreshSaveStatus();
  }

  function scheduleAutosave() {
    if (!state || !state.id) return;        // unnamed drafts: no autosave
    if (!isDirty()) return;
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => { autosave(); }, AUTOSAVE_DEBOUNCE_MS);
  }

  async function autosave() {
    if (!state || !state.id || !isDirty() || savingNow) return;
    savingNow = true;
    saveError = null;
    refreshSaveStatus();
    try {
      await save({ silent: true, fromAutosave: true });
      lastSavedAt = Date.now();
    } catch (e) {
      saveError = e?.message || String(e);
    } finally {
      savingNow = false;
      refreshSaveStatus();
    }
  }

  function saveStatusText() {
    if (!state) return "";
    if (!state.id) return "Not saved yet";
    if (savingNow) return "Saving…";
    if (saveError) return `Save failed — ${saveError}`;
    if (isDirty()) return "Unsaved changes";
    if (lastSavedAt) return `Saved ${secondsAgo(lastSavedAt)}`;
    return "Saved";
  }

  function secondsAgo(ts) {
    const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (sec < 5) return "just now";
    if (sec < 60) return `${sec}s ago`;
    const m = Math.floor(sec / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.floor(m / 60);
    return `${h}h ago`;
  }

  // Repaint just the saved-status pill in the header without re-rendering
  // everything else (which would steal focus from open inputs).
  function refreshSaveStatus() {
    const node = document.getElementById("ls-save-status");
    if (!node) return;
    node.textContent = saveStatusText();
    node.className = "ls-save-status" + (
      savingNow || saveError || isDirty() || !state?.id ? " ls-save-status-warn" : " ls-save-status-ok"
    );
  }
  // Tick the "X seconds ago" label every 5s.
  setInterval(refreshSaveStatus, 5000);

  // Warn before navigation if there are unsaved changes (autosave usually
  // catches everything, but this protects against in-flight failures).
  window.addEventListener("beforeunload", (e) => {
    if (state && isDirty()) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  async function refreshPreview() {
    state.loading = true;
    renderTableBody();
    const token = ++inflightPreview;
    try {
      const r = await fetch("/api/linesheets/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filter_tree: state.filter_tree,
          pins: state.pins,
          excludes: state.excludes,
          pricing: state.pricing,
          display_opts: state.display_opts
        })
      });
      if (token !== inflightPreview) return;
      if (!r.ok) {
        let errMsg = `HTTP ${r.status}`;
        try {
          const j = await r.json();
          errMsg = j.error || errMsg;
        } catch { try { errMsg = await r.text(); } catch {} }
        state.loading = false;
        state.previewError = errMsg;
        state.products = [];
        state.counts = {};
        renderTableBody();
        return;
      }
      state.previewError = null;
      const j = await r.json();
      state.products = j.products || [];
      state.counts = j.counts || {};
      state.capped = !!j.capped;
      state.loading = false;
      renderTableBody();
    } catch (err) {
      if (token !== inflightPreview) return;
      state.loading = false;
      renderTableBody();
    }
  }

  async function save({ saveAs = false, silent = false, fromAutosave = false } = {}) {
    let nameToUse = state.name;
    if (saveAs || !state.id) {
      const prompted = prompt(saveAs ? "Save as new view. Name:" : "Name this view:", state.name || seasonSuggestion());
      if (!prompted || !prompted.trim()) return null;
      nameToUse = prompted.trim();
    }

    // Mirror current sort into display_opts so the PDF matches the table.
    state.display_opts.sort = sortMode;

    const body = {
      name: nameToUse,
      customer: state.customer || null,
      description: state.description || null,
      filter_tree: state.filter_tree,
      saved_filter_id: state.saved_filter_id,
      pins: state.pins,
      excludes: state.excludes,
      pricing: state.pricing,
      display_opts: state.display_opts
    };
    const url = (saveAs || !state.id) ? "/api/linesheets" : `/api/linesheets/${state.id}`;
    const method = (saveAs || !state.id) ? "POST" : "PUT";
    const r = await fetch(url, {
      method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    });
    if (!r.ok) {
      const msg = await r.text();
      if (fromAutosave) throw new Error(msg || `HTTP ${r.status}`);
      alert("Save failed: " + msg);
      return null;
    }
    const j = await r.json();
    state.id = j.linesheet.id;
    state.name = j.linesheet.name;
    initialState = snapshot(state);
    lastSavedAt = Date.now();
    saveError = null;
    await loadSavedSheets();
    // Autosave avoids re-rendering the whole shell so it doesn't steal focus
    // from inputs the user is still typing in.
    if (!fromAutosave) renderShell(document.getElementById("lsEditorRoot"));
    refreshSaveStatus();
    if (!silent) flash(`Saved "${state.name}"`);
    return state.id;
  }

  function seasonSuggestion() {
    const conds = state.filter_tree?.include?.[0]?.conditions || [];
    const season = conds.find(c => c.field === "season")?.value;
    if (Array.isArray(season) && season.length === 1) return season[0];
    return "";
  }

  // Always flush local edits before opening any server-rendered export, so
  // recent state (excludes, pins, pricing, notes) is guaranteed to be in the
  // DB by the time the export route reads it. Cancels any in-flight autosave
  // debounce so we don't race with it.
  async function flushAndExport(urlPath) {
    clearTimeout(autosaveTimer);
    // Wait for any in-flight autosave to settle before issuing our own.
    while (savingNow) await new Promise((r) => setTimeout(r, 50));

    let id = state.id;
    if (!id || isDirty()) {
      id = await save({ silent: true });
      if (!id) return; // user cancelled the name prompt or save failed
    }
    window.open(`/api/linesheets/${id}/${urlPath}`, "_blank");
  }

  async function exportPdf()       { return flushAndExport("render.pdf"); }
  async function exportOrderForm() { return flushAndExport("order-form.xlsx"); }

  function editNameDialog() {
    const next = prompt("View name:", state.name);
    if (next && next.trim() && next !== state.name) {
      state.name = next.trim();
      renderShell(document.getElementById("lsEditorRoot"));
    }
  }

  function flash(msg) {
    const f = el("div", { class: "ls-flash" }, msg);
    document.body.appendChild(f);
    setTimeout(() => f.classList.add("show"), 10);
    setTimeout(() => { f.classList.remove("show"); setTimeout(() => f.remove(), 300); }, 1800);
  }

  // --- Public API ---

  w.LineSheets.bootstrap = bootstrap;
  w.LineSheets.openSaved = openSaved;
  w.LineSheets.newDraft = newDraft;
})();
