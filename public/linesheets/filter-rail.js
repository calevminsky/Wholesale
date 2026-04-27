// Plain-language filter rail for line sheets. Always-visible left sidebar of
// checkbox lists for the dimensions a wholesale manager actually filters by.
//
// Talks to the existing filter_tree schema:
//   { include: [{ conditions: [{field, op, value, locations?}, ...] }],
//     globals: [...] }
//
// The rail handles the "simple" subset: a single include-group plus a known
// set of globals. Anything else is treated as advanced — the rail dims out
// and offers a button to drop back to the chip-style builder.
//
// Important: degrading to advanced does NOT discard data. The user only loses
// state if they explicitly click the "switch to simple filters" button,
// which confirms first.
(function () {
  const w = window;
  w.LineSheets = w.LineSheets || {};

  // Primary dimensions, in display order.
  const PRIMARY_DIMENSIONS = [
    { key: "season",       label: "Season",        metaKey: "seasons" },
    { key: "class",        label: "Class",         metaKey: "classes" },
    { key: "product_type", label: "Type",          metaKey: "product_types" }
  ];

  // Less-common dimensions hidden behind a "More filters" disclosure.
  const SECONDARY_DIMENSIONS = [
    { key: "fabric", label: "Fabric", metaKey: "fabrics" },
    { key: "sleeve", label: "Sleeve", metaKey: "sleeves" }
  ];

  const ALL_DIMENSIONS = [...PRIMARY_DIMENSIONS, ...SECONDARY_DIMENSIONS];

  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") e.className = v;
      else if (k === "style") e.setAttribute("style", v);
      else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined) e.setAttribute(k, v);
    }
    for (const c of [].concat(children || [])) {
      if (c == null) continue;
      e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return e;
  }

  // ---------- compile: tree -> simple state ----------
  function compile(tree) {
    const out = {
      simple: true,
      complexReason: null,
      dims: Object.fromEntries(ALL_DIMENSIONS.map((d) => [d.key, []])),
      priceMin: null,
      priceMax: null,
      hasInventory: null,
      hasImage: null,
      stockMin: null
    };

    if (!tree || typeof tree !== "object") return out;

    const include = Array.isArray(tree.include) ? tree.include : [];
    const globals = Array.isArray(tree.globals) ? tree.globals : [];

    if (include.length > 1) {
      out.simple = false;
      out.complexReason = "Multiple OR groups";
      return out;
    }
    const group0 = include[0]?.conditions || [];

    for (const c of [...group0, ...globals]) {
      if (!c || !c.field) continue;
      const dim = ALL_DIMENSIONS.find((d) => d.key === c.field);
      if (dim) {
        if (c.op !== "in") {
          out.simple = false;
          out.complexReason = `${dim.label} uses op "${c.op}"`;
          return out;
        }
        const vs = Array.isArray(c.value) ? c.value : [c.value];
        out.dims[dim.key] = [...out.dims[dim.key], ...vs.filter(Boolean)];
        continue;
      }
      if (c.field === "price") {
        if (c.op === ">=") out.priceMin = Number(c.value);
        else if (c.op === "<=") out.priceMax = Number(c.value);
        else if (c.op === "between" && Array.isArray(c.value)) {
          out.priceMin = Number(c.value[0]);
          out.priceMax = Number(c.value[1]);
        } else {
          out.simple = false;
          out.complexReason = `Price uses op "${c.op}"`;
          return out;
        }
        continue;
      }
      if (c.field === "has_inventory") { out.hasInventory = !!c.value; continue; }
      if (c.field === "has_image")     { out.hasImage     = !!c.value; continue; }
      if (c.field === "inventory_min") {
        const n = Number(c.value);
        if (Number.isFinite(n) && n >= 0) out.stockMin = n;
        continue;
      }
      // Anything else — degrade.
      out.simple = false;
      out.complexReason = `Filter on "${c.field}" not in simple view`;
      return out;
    }
    return out;
  }

  // ---------- decode: simple state -> tree ----------
  function decode(simple) {
    const conditions = [];
    for (const d of ALL_DIMENSIONS) {
      const vs = (simple.dims[d.key] || []).filter(Boolean);
      if (vs.length) conditions.push({ field: d.key, op: "in", value: vs });
    }
    if (simple.priceMin != null && simple.priceMax != null) {
      conditions.push({ field: "price", op: "between", value: [simple.priceMin, simple.priceMax] });
    } else if (simple.priceMin != null) {
      conditions.push({ field: "price", op: ">=", value: simple.priceMin });
    } else if (simple.priceMax != null) {
      conditions.push({ field: "price", op: "<=", value: simple.priceMax });
    }
    const globals = [];
    if (simple.hasInventory) globals.push({ field: "has_inventory", op: "=", value: true });
    if (simple.hasImage)     globals.push({ field: "has_image",     op: "=", value: true });
    if (simple.stockMin != null && simple.stockMin > 0) {
      // Locations come from display_opts.ats_locations (set by the rail's
      // Stock section), not from the condition itself, so the inventory
      // column display matches the filter.
      globals.push({ field: "inventory_min", op: ">=", value: simple.stockMin });
    }
    return { include: [{ conditions }], globals };
  }

  // ---------- render ----------
  // opts:
  //   onChange()                    — call after a tree change
  //   getStockLocations() -> string[] — current ATS locations
  //   setStockLocations(arr)        — write ATS locations + trigger preview
  function render(root, tree, meta, opts) {
    const onChange = opts?.onChange || (() => {});
    const getStockLocations = opts?.getStockLocations || (() => []);
    const setStockLocations = opts?.setStockLocations || (() => {});

    root.innerHTML = "";
    root.className = "ls-rail";

    const compiled = compile(tree);

    if (!compiled.simple) {
      root.appendChild(el("div", { class: "ls-rail-complex" }, [
        el("div", { class: "ls-rail-complex-title" }, "Advanced filter active"),
        el("div", { class: "muted", style: "margin:6px 0 10px 0; font-size:12px;" }, compiled.complexReason || ""),
        el("div", { class: "muted", style: "margin-bottom:10px; font-size:12px;" },
          "Use the Advanced filter expander below to edit. Switching to simple filters will discard rules the simple view can't represent."),
        el("button", {
          class: "primary",
          style: "width:100%;",
          onclick: () => {
            if (!confirm("Reset to a simple filter? Custom OR rules and unsupported conditions will be discarded.")) return;
            const empty = decode({
              dims: Object.fromEntries(ALL_DIMENSIONS.map((d) => [d.key, []])),
              priceMin: null, priceMax: null,
              hasInventory: null, hasImage: null, stockMin: null
            });
            tree.include = empty.include;
            tree.globals = empty.globals;
            onChange();
          }
        }, "Switch to simple filters")
      ]));
      return;
    }

    // Heading
    root.appendChild(el("div", { class: "ls-rail-hd" }, [
      el("strong", null, "Filters"),
      el("button", {
        class: "ls-rail-clear",
        title: "Clear all filters",
        onclick: () => {
          const empty = decode({
            dims: Object.fromEntries(ALL_DIMENSIONS.map((d) => [d.key, []])),
            priceMin: null, priceMax: null,
            hasInventory: null, hasImage: null, stockMin: null
          });
          tree.include = empty.include;
          tree.globals = empty.globals;
          setStockLocations([]);
          onChange();
        }
      }, "Clear all")
    ]));

    // Stock section first — it's the primary filter the manager touches.
    root.appendChild(renderStockSection(meta, compiled, getStockLocations,
      (nextLocs) => setStockLocations(nextLocs),
      (nextMin) => {
        compiled.stockMin = nextMin;
        applyTree(tree, compiled, onChange);
      }
    ));

    // Primary dimensions (Season, Class, Type).
    for (const dim of PRIMARY_DIMENSIONS) {
      const sec = renderDimensionSection(dim, meta, compiled, (next) => {
        compiled.dims[dim.key] = next;
        applyTree(tree, compiled, onChange);
      });
      if (sec) root.appendChild(sec);
    }

    // Has-image toggle.
    root.appendChild(renderHasImageToggle(compiled, (next) => {
      compiled.hasImage = next;
      applyTree(tree, compiled, onChange);
    }));

    // Price range.
    root.appendChild(renderPriceSection(compiled, (next) => {
      compiled.priceMin = next.priceMin;
      compiled.priceMax = next.priceMax;
      applyTree(tree, compiled, onChange);
    }));

    // Secondary dimensions (Fabric, Sleeve) hidden behind a disclosure unless
    // they already have a value — we don't want to spring-clean the user's
    // saved selections.
    const anySecondary = SECONDARY_DIMENSIONS.some((d) => (compiled.dims[d.key] || []).length);
    const more = el("details", { class: "ls-rail-more" });
    if (anySecondary) more.setAttribute("open", "");
    more.appendChild(el("summary", null, "More filters"));
    for (const dim of SECONDARY_DIMENSIONS) {
      const sec = renderDimensionSection(dim, meta, compiled, (next) => {
        compiled.dims[dim.key] = next;
        applyTree(tree, compiled, onChange);
      });
      if (sec) more.appendChild(sec);
    }
    root.appendChild(more);
  }

  function applyTree(tree, compiled, onChange) {
    const next = decode(compiled);
    tree.include = next.include;
    tree.globals = next.globals;
    onChange();
  }

  function renderDimensionSection(dim, meta, compiled, onSelected) {
    const options = (meta?.[dim.metaKey] || []).map((v) =>
      typeof v === "object"
        ? { id: v.id || v.value || String(v), label: v.name || v.label || String(v.id || v) }
        : { id: v, label: String(v) }
    );
    const selected = compiled.dims[dim.key] || [];
    if (!options.length && !selected.length) return null;
    return renderCheckboxSection(dim.label, options, selected, onSelected);
  }

  function renderCheckboxSection(label, options, selected, onChange) {
    const sec = el("div", { class: "ls-rail-sec" });
    const collapsed = options.length > 12;
    const summary = selected.length ? ` (${selected.length})` : "";
    sec.appendChild(el("div", { class: "ls-rail-sec-hd" }, [
      el("span", { class: "ls-rail-sec-title" }, label),
      el("span", { class: "ls-rail-sec-count" }, summary)
    ]));

    const body = el("div", { class: "ls-rail-sec-body" });
    let filterText = "";
    let searchInp = null;
    if (collapsed) {
      searchInp = el("input", {
        type: "text",
        class: "ls-rail-search",
        placeholder: `Search ${label.toLowerCase()}…`
      });
      searchInp.addEventListener("input", () => {
        filterText = searchInp.value.trim().toLowerCase();
        renderOptions();
      });
      body.appendChild(searchInp);
    }
    const list = el("div", { class: "ls-rail-list" });
    body.appendChild(list);

    const renderOptions = () => {
      list.innerHTML = "";
      const visible = filterText
        ? options.filter((o) => o.label.toLowerCase().includes(filterText))
        : options;
      const selectedSet = new Set(selected);
      const sel = visible.filter((o) => selectedSet.has(o.id));
      const unsel = visible.filter((o) => !selectedSet.has(o.id));
      const order = filterText ? visible : [...sel, ...unsel];
      for (const opt of order) {
        const cb = el("input", { type: "checkbox" });
        cb.checked = selectedSet.has(opt.id);
        cb.addEventListener("change", () => {
          let next;
          if (cb.checked) next = [...selected.filter((s) => s !== opt.id), opt.id];
          else next = selected.filter((s) => s !== opt.id);
          onChange(next);
        });
        list.appendChild(el("label", { class: "ls-rail-opt" }, [cb, document.createTextNode(opt.label)]));
      }
      // Selected items that aren't in the meta options anymore — keep them
      // visible so the user can clear them.
      if (!filterText) {
        const known = new Set(options.map((o) => o.id));
        for (const id of selected) {
          if (known.has(id)) continue;
          const cb = el("input", { type: "checkbox" });
          cb.checked = true;
          cb.addEventListener("change", () => onChange(selected.filter((s) => s !== id)));
          list.appendChild(el("label", { class: "ls-rail-opt" }, [
            cb,
            el("span", { style: "color:#999;" }, String(id) + " (legacy)")
          ]));
        }
      }
      if (!list.firstChild) {
        list.appendChild(el("div", { class: "muted", style: "padding:6px 4px;" }, "No matches."));
      }
    };
    renderOptions();
    sec.appendChild(body);
    return sec;
  }

  function renderStockSection(meta, compiled, getStockLocations, setStockLocations, setMin) {
    const sec = el("div", { class: "ls-rail-sec" });
    const locations = (meta?.locations || []).map((l) => ({
      id: String(l.id || l), label: l.name || l.id || String(l)
    }));
    const currentLocs = (getStockLocations() || []).map(String);

    const sumLabel =
      (currentLocs.length ? `· ${currentLocs.length} loc${currentLocs.length === 1 ? "" : "s"}` : "") +
      (compiled.stockMin && compiled.stockMin > 0 ? ` · ≥ ${compiled.stockMin}` : "");

    sec.appendChild(el("div", { class: "ls-rail-sec-hd" }, [
      el("span", { class: "ls-rail-sec-title" }, "Stock"),
      el("span", { class: "ls-rail-sec-count" }, sumLabel)
    ]));

    const body = el("div", { class: "ls-rail-sec-body" });

    if (locations.length) {
      body.appendChild(el("div", { class: "muted", style: "font-size:12px; margin-bottom:4px;" },
        "Count inventory from"));
      const list = el("div", { class: "ls-rail-list", style: "max-height:160px;" });
      for (const loc of locations) {
        const cb = el("input", { type: "checkbox" });
        cb.checked = currentLocs.includes(loc.id);
        cb.addEventListener("change", () => {
          const next = cb.checked
            ? [...currentLocs.filter((x) => x !== loc.id), loc.id]
            : currentLocs.filter((x) => x !== loc.id);
          setStockLocations(next);
        });
        list.appendChild(el("label", { class: "ls-rail-opt" }, [cb, document.createTextNode(loc.label)]));
      }
      body.appendChild(list);
      if (currentLocs.length === 0) {
        body.appendChild(el("div", { class: "muted", style: "font-size:11px; margin:2px 0 8px 2px;" },
          "(empty = all locations)"));
      }
    } else {
      body.appendChild(el("div", { class: "muted", style: "font-size:12px;" }, "No locations available."));
    }

    body.appendChild(el("div", { class: "ls-rail-row", style: "margin-top:4px;" }, [
      el("span", { class: "muted", style: "font-size:12px; min-width:96px;" }, "Combined units ≥"),
      (() => {
        const inp = el("input", {
          type: "number",
          min: "0",
          step: "1",
          class: "ls-rail-num",
          placeholder: "0"
        });
        if (compiled.stockMin != null && compiled.stockMin > 0) inp.value = String(compiled.stockMin);
        inp.addEventListener("change", () => {
          const n = inp.value === "" ? 0 : Number(inp.value);
          setMin(Number.isFinite(n) && n > 0 ? n : null);
        });
        return inp;
      })()
    ]));

    sec.appendChild(body);
    return sec;
  }

  function renderHasImageToggle(compiled, onChange) {
    const sec = el("div", { class: "ls-rail-sec" });
    const cb = el("input", { type: "checkbox" });
    cb.checked = !!compiled.hasImage;
    cb.addEventListener("change", () => onChange(cb.checked));
    sec.appendChild(el("label", { class: "ls-rail-opt", style: "padding:8px 4px;" },
      [cb, document.createTextNode("Hide products without an image")]));
    return sec;
  }

  function renderPriceSection(compiled, onChange) {
    const sec = el("div", { class: "ls-rail-sec" });
    const summary = (compiled.priceMin != null || compiled.priceMax != null) ? " (set)" : "";
    sec.appendChild(el("div", { class: "ls-rail-sec-hd" }, [
      el("span", { class: "ls-rail-sec-title" }, "Price"),
      el("span", { class: "ls-rail-sec-count" }, summary)
    ]));
    const body = el("div", { class: "ls-rail-sec-body" });

    const minInp = el("input", { type: "number", min: "0", step: "1", class: "ls-rail-num", placeholder: "min" });
    if (compiled.priceMin != null) minInp.value = String(compiled.priceMin);
    const maxInp = el("input", { type: "number", min: "0", step: "1", class: "ls-rail-num", placeholder: "max" });
    if (compiled.priceMax != null) maxInp.value = String(compiled.priceMax);

    const fire = () => {
      const min = minInp.value === "" ? null : Number(minInp.value);
      const max = maxInp.value === "" ? null : Number(maxInp.value);
      onChange({ priceMin: Number.isFinite(min) ? min : null, priceMax: Number.isFinite(max) ? max : null });
    };
    minInp.addEventListener("change", fire);
    maxInp.addEventListener("change", fire);

    body.appendChild(el("div", { class: "ls-rail-row" }, [
      el("span", { class: "muted", style: "width:30px;" }, "$"),
      minInp,
      el("span", { class: "muted", style: "padding:0 4px;" }, "to"),
      maxInp
    ]));
    sec.appendChild(body);
    return sec;
  }

  w.LineSheets.renderFilterRail = render;
  w.LineSheets.compileFilterTree = compile;
})();
