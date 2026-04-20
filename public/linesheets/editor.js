// Line sheet editor (Screen 2).
(function () {
  const w = window;
  w.LineSheets = w.LineSheets || {};

  const SIZE_COLS = ["XS", "S", "M", "L", "XL"];
  let meta = null;
  let state = null;
  let previewTimer = null;
  let sortKey = "style_name";
  let sortDir = "asc";
  let selected = new Set();

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

  function escHtml(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  async function loadMeta() {
    if (meta) return meta;
    const r = await fetch("/api/linesheets/meta");
    meta = r.ok ? await r.json() : { seasons: [], classes: [], product_types: [], locations: [], fabrics: [], sleeves: [] };
    meta.tag_suggestions = ["KNIT", "WOVEN", "Long Sleeve", "Short Sleeve", "Sleeveless", "nada-ignore"];
    return meta;
  }

  async function open(sheetId, opts = {}) {
    await loadMeta();
    const container = document.getElementById("lsEditorRoot");
    container.innerHTML = "<div class=\"muted\">Loading…</div>";

    if (sheetId) {
      const r = await fetch(`/api/linesheets/${sheetId}`);
      const j = await r.json();
      state = {
        id: j.linesheet.id,
        name: j.linesheet.name,
        customer: j.linesheet.customer || "",
        description: j.linesheet.description || "",
        filter_tree: j.linesheet.filter_tree || { include: [], globals: [] },
        saved_filter_id: j.linesheet.saved_filter_id || null,
        saved_filter_name: j.linesheet.saved_filter_name || null,
        pins: j.linesheet.pins || [],
        excludes: j.linesheet.excludes || [],
        pricing: Object.assign({ default_mode: "pct_off_compare_at", default_value: 50, overrides: {} }, j.linesheet.pricing || {}),
        display_opts: j.linesheet.display_opts || {},
        products: j.products || [],
        counts: j.counts || {}
      };
    } else {
      const base = opts.savedFilter || null;
      state = {
        id: null,
        name: "",
        customer: "",
        description: "",
        filter_tree: base?.filter_tree || { include: [], globals: [] },
        saved_filter_id: base?.id || null,
        saved_filter_name: base?.name || null,
        pins: [],
        excludes: [],
        pricing: { default_mode: "pct_off_compare_at", default_value: 50, overrides: {} },
        display_opts: {},
        products: [],
        counts: {}
      };
      await refreshPreview();
    }

    renderAll();
  }

  function renderAll() {
    const root = document.getElementById("lsEditorRoot");
    root.innerHTML = "";
    root.appendChild(renderMetaBox());
    root.appendChild(renderFilterBox());
    root.appendChild(renderPricingBox());
    root.appendChild(renderCountsBar());
    root.appendChild(renderProductTable());
    root.appendChild(renderDisplayOpts());
    root.appendChild(renderFooter());
  }

  function renderMetaBox() {
    const nameInp = el("input", { type: "text", value: state.name, placeholder: "Line sheet name", style: "width:260px;" });
    nameInp.addEventListener("input", () => state.name = nameInp.value);
    const custInp = el("input", { type: "text", value: state.customer, placeholder: "Customer", style: "width:240px;" });
    custInp.addEventListener("input", () => state.customer = custInp.value);
    const descInp = el("input", { type: "text", value: state.description, placeholder: "Description", style: "width:320px;" });
    descInp.addEventListener("input", () => state.description = descInp.value);

    return el("div", { class: "box" }, [
      el("div", { class: "row" }, [
        el("label", null, [el("b", null, "Name ")]), nameInp,
        el("label", { style: "margin-left:12px;" }, [el("b", null, "Customer ")]), custInp,
        el("label", { style: "margin-left:12px;" }, [el("b", null, "Description ")]), descInp
      ])
    ]);
  }

  function renderFilterBox() {
    const box = el("div", { class: "box" });
    const hdr = el("div", { class: "row" }, [
      el("b", null, "Filter "),
      state.saved_filter_name ? el("span", { class: "pill" }, `Using: ${state.saved_filter_name}`) : el("span", { class: "muted" }, "(ad-hoc)")
    ]);
    box.appendChild(hdr);

    if (state.saved_filter_name) {
      hdr.appendChild(el("button", {
        style: "margin-left:8px;",
        onclick: () => {
          if (confirm(`Unlink from saved filter "${state.saved_filter_name}"? The filter will stay in this line sheet but won't be tied to the saved filter.`)) {
            state.saved_filter_id = null; state.saved_filter_name = null; renderAll();
          }
        }
      }, "Unlink"));
      hdr.appendChild(el("button", {
        style: "margin-left:6px;",
        onclick: async () => {
          const name = prompt("Save current filter as new saved filter. Name:");
          if (!name) return;
          const r = await fetch("/api/saved-filters", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, filter_tree: state.filter_tree })
          });
          if (!r.ok) return alert("Failed: " + (await r.text()));
          const j = await r.json();
          state.saved_filter_id = j.saved_filter.id;
          state.saved_filter_name = j.saved_filter.name;
          renderAll();
        }
      }, "Save as new filter"));
      hdr.appendChild(el("button", {
        style: "margin-left:6px;",
        onclick: async () => {
          if (!confirm(`Overwrite saved filter "${state.saved_filter_name}" with the current filter? This affects every line sheet linked to it.`)) return;
          const r = await fetch(`/api/saved-filters/${state.saved_filter_id}`, {
            method: "PUT", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filter_tree: state.filter_tree })
          });
          if (!r.ok) return alert("Failed: " + (await r.text()));
          alert("Saved filter updated.");
        }
      }, `Update "${state.saved_filter_name}"`));
    } else {
      hdr.appendChild(el("button", {
        style: "margin-left:8px;",
        onclick: async () => {
          const name = prompt("Name for new saved filter:");
          if (!name) return;
          const r = await fetch("/api/saved-filters", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, filter_tree: state.filter_tree })
          });
          if (!r.ok) return alert("Failed: " + (await r.text()));
          const j = await r.json();
          state.saved_filter_id = j.saved_filter.id;
          state.saved_filter_name = j.saved_filter.name;
          renderAll();
        }
      }, "Save as filter"));
    }

    const builder = el("div", { class: "ls-fb" });
    box.appendChild(builder);
    const rebuild = () => {
      w.LineSheets.renderFilterBuilder(builder, state.filter_tree, meta, () => { rebuild(); debouncePreview(); });
    };
    rebuild();

    return box;
  }

  function renderPricingBox() {
    const box = el("div", { class: "box" });
    const bar = el("div", { class: "row" });
    box.appendChild(bar);
    const overrideCount = Object.keys(state.pricing.overrides || {}).length;
    w.LineSheets.renderPricingBar(bar, state.pricing, {
      onChange: () => debouncePreview(),
      onApplyAll: () => {
        if (overrideCount && !confirm(`Clear ${overrideCount} hand-edited override(s) and apply default to all?`)) return;
        state.pricing.overrides = {};
        debouncePreview();
      },
      onResetOverrides: () => { state.pricing.overrides = {}; debouncePreview(); },
      overrideCount
    });
    return box;
  }

  function renderCountsBar() {
    const c = state.counts || {};
    const bar = el("div", { class: "row", style: "margin-top:12px;" }, [
      el("span", { class: "pill" }, `Matched: ${c.matched ?? 0}`),
      el("span", { class: "pill" }, `Pinned: ${c.pinned ?? 0}`),
      el("span", { class: "pill" }, `Excluded: ${c.excluded ?? 0}`),
      el("span", { class: "pill" }, `Final: ${c.final ?? 0}`)
    ]);
    const bulk = el("button", {
      style: "margin-left:12px;",
      onclick: () => {
        if (selected.size === 0) return alert("Select rows first.");
        for (const id of selected) if (!state.excludes.includes(id)) state.excludes.push(id);
        selected.clear();
        debouncePreview();
      }
    }, "Exclude selected");
    bar.appendChild(bulk);

    // Typeahead for pin
    const pinWrap = el("span", { style: "position:relative; margin-left:12px;" });
    const pinInput = el("input", { type: "text", placeholder: "+ Add product by name…", style: "width:260px;" });
    const pinResults = el("div", { style: "position:absolute; top:28px; left:0; background:#fff; border:1px solid #ddd; border-radius:6px; max-height:260px; overflow:auto; display:none; z-index:1000; min-width:280px;" });
    pinWrap.appendChild(pinInput); pinWrap.appendChild(pinResults);

    let searchT = null;
    pinInput.addEventListener("input", () => {
      clearTimeout(searchT);
      const q = pinInput.value.trim();
      if (q.length < 2) { pinResults.style.display = "none"; return; }
      searchT = setTimeout(async () => {
        const r = await fetch("/api/products/search?q=" + encodeURIComponent(q));
        const j = await r.json();
        pinResults.innerHTML = "";
        for (const p of j.products || []) {
          const row = el("div", {
            style: "display:flex; gap:8px; align-items:center; padding:6px; cursor:pointer; border-bottom:1px solid #f0f0f0;",
            onclick: () => {
              pinResults.style.display = "none";
              pinInput.value = "";
              const productId = p.id;
              if (!productId) { alert("Product id unavailable"); return; }
              if (!state.pins.includes(productId)) state.pins.push(productId);
              debouncePreview();
            }
          }, [
            p.imageUrl ? el("img", { src: p.imageUrl + "?width=40", style: "width:32px;height:32px;object-fit:cover;border-radius:4px;" }) : el("div", { style: "width:32px;height:32px;background:#eee;border-radius:4px;" }),
            el("span", null, p.title)
          ]);
          pinResults.appendChild(row);
        }
        pinResults.style.display = (j.products || []).length ? "block" : "none";
      }, 220);
    });
    bar.appendChild(pinWrap);

    return bar;
  }

  function renderProductTable() {
    const wrap = el("div", { class: "box", style: "overflow-x:auto; margin-top:8px;" });

    if (!state.products || state.products.length === 0) {
      wrap.appendChild(el("div", { class: "muted" }, "No products match this filter."));
      return wrap;
    }

    const tbl = el("table", { class: "ls-tbl" });
    tbl.appendChild(buildHeader());
    tbl.appendChild(buildBody());
    wrap.appendChild(tbl);
    return wrap;
  }

  function buildHeader() {
    const cells = [
      { key: "_chk", label: "" },
      { key: "image", label: "" },
      { key: "style_name", label: "Product", sortable: true },
      { key: "product_type", label: "Type", sortable: true },
      { key: "compare_at_price", label: "MSRP", sortable: true },
      { key: "effective_price", label: "Price", sortable: true }
    ];
    for (const s of SIZE_COLS) cells.push({ key: `sz_${s}`, label: s });
    cells.push({ key: "inventory_total", label: "Total", sortable: true });
    cells.push({ key: "_act", label: "" });

    const tr = el("tr");
    for (const c of cells) {
      const th = el("th", {
        style: c.sortable ? "cursor:pointer;" : "",
        onclick: c.sortable ? () => {
          if (sortKey === c.key) sortDir = sortDir === "asc" ? "desc" : "asc";
          else { sortKey = c.key; sortDir = "asc"; }
          renderAll();
        } : null
      }, c.label + (sortKey === c.key ? (sortDir === "asc" ? " ▲" : " ▼") : ""));
      tr.appendChild(th);
    }
    return el("thead", null, tr);
  }

  function buildBody() {
    const products = sortProducts(state.products);
    const tb = document.createElement("tbody");

    for (const p of products) {
      const isExcluded = !!p.excluded;
      const isPinned = p.source === "pinned" || state.pins.includes(p.product_id);
      const tr = el("tr", { class: "ls-row" + (isExcluded ? " ls-excluded" : "") });

      // checkbox
      const cb = el("input", { type: "checkbox" });
      cb.checked = selected.has(p.product_id);
      cb.addEventListener("change", () => {
        if (cb.checked) selected.add(p.product_id);
        else selected.delete(p.product_id);
      });
      tr.appendChild(el("td", { style: "text-align:center;" }, [cb]));

      // image
      tr.appendChild(el("td", { style: "text-align:center;" },
        p.image ? [el("img", { src: p.image + "?width=80", style: "width:40px;height:48px;object-fit:cover;border-radius:4px;" })] : ""));

      // product title + sub
      tr.appendChild(el("td", { class: "ls-prod" }, [
        el("div", null, p.title || ""),
        p.style_name && p.style_name !== p.title ? el("div", { class: "muted" }, p.style_name) : null,
        isPinned ? el("span", { class: "pill", style: "margin-top:2px;font-size:10px;" }, "pinned") : null
      ]));

      tr.appendChild(el("td", null, p.product_type || ""));
      tr.appendChild(el("td", { class: "num" }, fmtMoney(p.compare_at_price || p.current_price)));

      // editable price
      const priceInp = el("input", {
        type: "number", step: "0.01", value: p.effective_price ?? "",
        style: "width:80px;text-align:right;" + (p.has_override ? "font-weight:700;" : "")
      });
      priceInp.addEventListener("change", () => {
        const v = priceInp.value.trim();
        if (v === "" || v === "=") {
          delete state.pricing.overrides[p.product_id];
        } else {
          state.pricing.overrides[p.product_id] = Number(v);
        }
        debouncePreview();
      });
      tr.appendChild(el("td", { class: "num" }, [priceInp]));

      // sizes
      for (const s of SIZE_COLS) {
        const qty = Number(p.inventory_by_size?.[s] || 0);
        tr.appendChild(el("td", { class: "num" + (qty === 0 ? " ls-zero" : "") }, qty ? String(qty) : ""));
      }
      tr.appendChild(el("td", { class: "num" }, String(p.inventory_total || 0)));

      // actions
      const actCell = el("td", { style: "text-align:center;" });
      if (isExcluded) {
        actCell.appendChild(el("button", {
          title: "Un-exclude",
          onclick: () => { state.excludes = state.excludes.filter(id => id !== p.product_id); debouncePreview(); }
        }, "↺"));
      } else {
        actCell.appendChild(el("button", {
          title: "Exclude",
          onclick: () => { if (!state.excludes.includes(p.product_id)) state.excludes.push(p.product_id); debouncePreview(); }
        }, "✕"));
        if (!isPinned) {
          actCell.appendChild(el("button", {
            title: "Pin",
            style: "margin-left:4px;",
            onclick: () => { if (!state.pins.includes(p.product_id)) state.pins.push(p.product_id); debouncePreview(); }
          }, "⭐"));
        } else {
          actCell.appendChild(el("button", {
            title: "Unpin",
            style: "margin-left:4px;",
            onclick: () => { state.pins = state.pins.filter(id => id !== p.product_id); debouncePreview(); }
          }, "☆"));
        }
      }
      tr.appendChild(actCell);

      tb.appendChild(tr);
    }
    return tb;
  }

  function sortProducts(arr) {
    const dir = sortDir === "desc" ? -1 : 1;
    const copy = [...arr];
    copy.sort((a, b) => {
      let av, bv;
      if (sortKey === "style_name") { av = a.style_name || a.title || ""; bv = b.style_name || b.title || ""; return dir * String(av).localeCompare(String(bv)); }
      if (sortKey === "product_type") return dir * String(a.product_type || "").localeCompare(String(b.product_type || ""));
      if (sortKey === "compare_at_price") return dir * ((a.compare_at_price || 0) - (b.compare_at_price || 0));
      if (sortKey === "effective_price") return dir * ((a.effective_price || 0) - (b.effective_price || 0));
      if (sortKey === "inventory_total") return dir * ((a.inventory_total || 0) - (b.inventory_total || 0));
      return 0;
    });
    return copy;
  }

  function renderDisplayOpts() {
    const opts = state.display_opts;
    const box = el("div", { class: "box", style: "margin-top:8px;" });
    const details = el("details", null);
    details.appendChild(el("summary", null, "Display options"));

    const makeCheckbox = (key, label, defaultVal) => {
      const id = "opt_" + key;
      const inp = el("input", { type: "checkbox", id });
      inp.checked = opts[key] ?? defaultVal;
      inp.addEventListener("change", () => { opts[key] = inp.checked; });
      return el("label", { for: id, style: "margin-right:16px;" }, [inp, document.createTextNode(" " + label)]);
    };

    const row1 = el("div", { class: "row" }, [
      makeCheckbox("show_inventory", "Show inventory columns on PDF", true),
      makeCheckbox("show_msrp", "Show MSRP on PDF", true),
      makeCheckbox("exclude_nada_ignore", "Exclude nada-ignore", true)
    ]);

    const groupSel = el("select", null, ["none", "season", "product_type", "class"].map(v => el("option", { value: v }, v)));
    groupSel.value = opts.group_by || "none";
    groupSel.addEventListener("change", () => { opts.group_by = groupSel.value === "none" ? null : groupSel.value; });

    const sortSel = el("select", null, [
      el("option", { value: "style_name" }, "style_name"),
      el("option", { value: "title" }, "title"),
      el("option", { value: "price_asc" }, "price asc"),
      el("option", { value: "price_desc" }, "price desc")
    ]);
    sortSel.value = opts.sort || "style_name";
    sortSel.addEventListener("change", () => { opts.sort = sortSel.value; });

    const minInv = el("input", { type: "number", value: opts.min_live_inventory ?? 1, style: "width:60px;" });
    minInv.addEventListener("change", () => { opts.min_live_inventory = Number(minInv.value); });

    const staleSel = el("select", null, ["drop", "flag", "ignore"].map(v => el("option", { value: v }, v)));
    staleSel.value = opts.stale_behavior || "drop";
    staleSel.addEventListener("change", () => { opts.stale_behavior = staleSel.value; });

    const row2 = el("div", { class: "row" }, [
      el("label", null, "Group by: "), groupSel,
      el("label", { style: "margin-left:12px;" }, "Sort: "), sortSel,
      el("label", { style: "margin-left:12px;" }, "Min live inv: "), minInv,
      el("label", { style: "margin-left:12px;" }, "Stale: "), staleSel
    ]);

    details.appendChild(row1);
    details.appendChild(row2);
    box.appendChild(details);
    return box;
  }

  function renderFooter() {
    const row = el("div", { class: "row", style: "margin-top:12px;" });
    row.appendChild(el("button", { onclick: () => w.LineSheets.showList() }, "Cancel"));
    row.appendChild(el("button", { class: "primary", style: "margin-left:auto;", onclick: () => save(false) }, "Save"));
    row.appendChild(el("button", { class: "primary", style: "margin-left:6px;", onclick: () => save(true) }, "Save & Render PDF"));
    return row;
  }

  function fmtMoney(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n === 0) return "—";
    return "$" + n.toFixed(2);
  }

  function debouncePreview() {
    // Re-render non-table chrome immediately so the UI reflects state changes.
    renderAll();
    clearTimeout(previewTimer);
    previewTimer = setTimeout(refreshPreview, 250);
  }

  async function refreshPreview() {
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
      if (!r.ok) { console.warn("preview failed", await r.text()); return; }
      const j = await r.json();
      state.products = j.products || [];
      state.counts = j.counts || {};
      renderAll();
    } catch (err) {
      console.error(err);
    }
  }

  async function save(thenRender) {
    if (!state.name.trim()) { alert("Name is required."); return; }
    const body = {
      name: state.name.trim(),
      customer: state.customer || null,
      description: state.description || null,
      filter_tree: state.filter_tree,
      saved_filter_id: state.saved_filter_id,
      pins: state.pins,
      excludes: state.excludes,
      pricing: state.pricing,
      display_opts: state.display_opts
    };
    const url = state.id ? `/api/linesheets/${state.id}` : "/api/linesheets";
    const r = await fetch(url, {
      method: state.id ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!r.ok) return alert("Save failed: " + (await r.text()));
    const j = await r.json();
    state.id = j.linesheet.id;
    if (thenRender) {
      window.open(`/api/linesheets/${state.id}/render.pdf`, "_blank");
    } else {
      alert("Saved.");
    }
    w.LineSheets.refreshList?.();
  }

  w.LineSheets.openEditor = open;
})();
