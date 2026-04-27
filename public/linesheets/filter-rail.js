// Plain-language filter rail for line sheets. Always-visible left sidebar of
// checkbox lists for the dimensions a wholesale manager actually filters by.
//
// Talks to the existing filter_tree schema:
//   { include: [{ conditions: [{field, op, value}, ...] }], globals: [...] }
//
// The rail handles the "simple" subset: a single include-group with conditions
// from a known set of dimensions, no ORs across groups, and a small set of
// operators. Anything else is treated as "advanced" — the rail dims out and
// shows a button to fall back to the chip-style filter bar.
(function () {
  const w = window;
  w.LineSheets = w.LineSheets || {};

  // Dimensions the rail handles, in display order.
  const DIMENSIONS = [
    { key: "season",       label: "Season",        metaKey: "seasons" },
    { key: "class",        label: "Class",         metaKey: "classes" },
    { key: "product_type", label: "Type",          metaKey: "product_types" },
    { key: "fabric",       label: "Fabric",        metaKey: "fabrics" },
    { key: "sleeve",       label: "Sleeve",        metaKey: "sleeves" }
  ];

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
  // Returns { simple: bool, dims: {key: [values]}, priceMin, priceMax, hasInventory, complexReason }
  function compile(tree) {
    const out = {
      simple: true,
      dims: {},
      priceMin: null,
      priceMax: null,
      hasInventory: null,
      complexReason: null
    };
    for (const d of DIMENSIONS) out.dims[d.key] = [];

    if (!tree || typeof tree !== "object") return out;

    const include = Array.isArray(tree.include) ? tree.include : [];
    const globals = Array.isArray(tree.globals) ? tree.globals : [];

    if (include.length > 1) {
      out.simple = false;
      out.complexReason = "Multiple OR groups";
      return out;
    }
    const group0 = include[0]?.conditions || [];
    const all = [...group0, ...globals];

    for (const c of all) {
      if (!c || !c.field) continue;
      const dim = DIMENSIONS.find((d) => d.key === c.field);
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
      if (c.field === "has_inventory") {
        if (c.op === "=" || c.op === undefined) {
          out.hasInventory = !!c.value;
          continue;
        }
      }
      // Unknown field or operator — degrade.
      out.simple = false;
      out.complexReason = `Filter on "${c.field}" not in simple view`;
      return out;
    }
    return out;
  }

  // ---------- decode: simple state -> tree ----------
  function decode(simple) {
    const conditions = [];
    for (const d of DIMENSIONS) {
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
    if (simple.hasInventory) {
      conditions.push({ field: "has_inventory", op: "=", value: true });
    }
    return { include: [{ conditions }], globals: [] };
  }

  // ---------- render ----------
  function render(root, tree, meta, onChange) {
    root.innerHTML = "";
    root.className = "ls-rail";

    const compiled = compile(tree);

    if (!compiled.simple) {
      root.appendChild(el("div", { class: "ls-rail-complex" }, [
        el("div", { class: "ls-rail-complex-title" }, "Advanced filter active"),
        el("div", { class: "muted", style: "margin:6px 0 10px 0; font-size:12px;" }, compiled.complexReason || ""),
        el("button", {
          class: "primary",
          style: "width:100%;",
          onclick: () => {
            if (!confirm("Reset to a simple filter? Custom OR rules and unsupported conditions will be discarded.")) return;
            // Wipe and re-render fresh in simple mode.
            const empty = decode({
              dims: Object.fromEntries(DIMENSIONS.map((d) => [d.key, []])),
              priceMin: null,
              priceMax: null,
              hasInventory: null
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
            dims: Object.fromEntries(DIMENSIONS.map((d) => [d.key, []])),
            priceMin: null,
            priceMax: null,
            hasInventory: null
          });
          tree.include = empty.include;
          tree.globals = empty.globals;
          onChange();
        }
      }, "Clear all")
    ]));

    // Dimension sections
    for (const dim of DIMENSIONS) {
      const options = (meta?.[dim.metaKey] || []).map((v) =>
        typeof v === "object" ? { id: v.id || v.value || String(v), label: v.name || v.label || String(v.id || v) } : { id: v, label: String(v) }
      );
      if (!options.length) continue;
      root.appendChild(renderCheckboxSection(dim, options, compiled.dims[dim.key] || [], (next) => {
        compiled.dims[dim.key] = next;
        const newTree = decode(compiled);
        tree.include = newTree.include;
        tree.globals = newTree.globals;
        onChange();
      }));
    }

    // Price range
    root.appendChild(renderPriceSection(compiled, (next) => {
      compiled.priceMin = next.priceMin;
      compiled.priceMax = next.priceMax;
      const newTree = decode(compiled);
      tree.include = newTree.include;
      tree.globals = newTree.globals;
      onChange();
    }));

    // Has inventory toggle
    root.appendChild(renderInventoryToggle(compiled, (next) => {
      compiled.hasInventory = next;
      const newTree = decode(compiled);
      tree.include = newTree.include;
      tree.globals = newTree.globals;
      onChange();
    }));
  }

  function renderCheckboxSection(dim, options, selected, onChange) {
    const sec = el("div", { class: "ls-rail-sec" });
    const collapsed = options.length > 12;
    const summary = selected.length ? ` (${selected.length})` : "";
    const head = el("div", { class: "ls-rail-sec-hd" }, [
      el("span", { class: "ls-rail-sec-title" }, dim.label),
      el("span", { class: "ls-rail-sec-count" }, summary)
    ]);
    sec.appendChild(head);

    const body = el("div", { class: "ls-rail-sec-body" });
    let filterText = "";
    let searchInp = null;
    if (collapsed) {
      searchInp = el("input", {
        type: "text",
        class: "ls-rail-search",
        placeholder: `Search ${dim.label.toLowerCase()}…`
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
      // Selected first, then a divider, then the rest.
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
      if (!order.length) {
        list.appendChild(el("div", { class: "muted", style: "padding:6px 4px;" }, "No matches."));
      }
    };
    renderOptions();

    sec.appendChild(body);
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

  function renderInventoryToggle(compiled, onChange) {
    const sec = el("div", { class: "ls-rail-sec" });
    const cb = el("input", { type: "checkbox" });
    cb.checked = !!compiled.hasInventory;
    cb.addEventListener("change", () => onChange(cb.checked));
    sec.appendChild(el("label", { class: "ls-rail-opt", style: "padding:8px 4px;" },
      [cb, document.createTextNode("Only products with inventory")]));
    return sec;
  }

  w.LineSheets.renderFilterRail = render;
  w.LineSheets.compileFilterTree = compile;
})();
