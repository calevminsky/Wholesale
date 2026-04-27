// Flat pill-bar filter UI. Each chip = one condition AND'd with the rest.
// Wire format stays { include: [{ conditions: [...] }], globals: [] }.
// Trees with multiple include-groups or globals are read-only from the bar
// (shown as a single "Advanced filter" chip that opens the legacy builder).
(function () {
  const w = window;
  w.LineSheets = w.LineSheets || {};

  const FIELDS = {
    season:        { label: "Season",          type: "multi", metaKey: "seasons",       defaultOp: "in" },
    class:         { label: "Class",           type: "multi", metaKey: "classes",       defaultOp: "in" },
    product_type:  { label: "Type",            type: "multi", metaKey: "product_types", defaultOp: "in" },
    fabric:        { label: "Fabric",          type: "multi", metaKey: "fabrics",       defaultOp: "in" },
    sleeve:        { label: "Sleeve",          type: "multi", metaKey: "sleeves",       defaultOp: "in" },
    tag:           { label: "Tag",             type: "multi", metaKey: "tag_suggestions", defaultOp: "has_any", opLabels: { has_any: "any of", has_all: "all of", has_none: "none of" } },
    price_tier:    { label: "Price tier",      type: "single", defaultOp: "=", options: [
      { value: "any",         label: "Any" },
      { value: "full_price",  label: "Full price" },
      { value: "off_price",   label: "Off price" }
    ] },
    price:         { label: "Price",           type: "num-range", defaultOp: "between" },
    length:        { label: "Length",          type: "num-cmp",   defaultOp: ">=" },
    title:         { label: "Title contains",  type: "text",      defaultOp: "contains" },
    style_name:    { label: "Style name",      type: "text",      defaultOp: "contains" },
    inventory_min: { label: "Min inventory",   type: "num-loc",   defaultOp: ">=" },
    has_inventory: { label: "Has inventory",   type: "bool",      defaultOp: "=" },
    linesheet:     {
      label: "Other line sheet",
      type: "linesheet",
      defaultOp: "not_in",
      opLabels: { not_in: "exclude products from", in: "only products from" }
    }
  };

  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") e.className = v;
      else if (k === "style") e.setAttribute("style", v);
      else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined) e.setAttribute(k, v);
    }
    for (const c of [].concat(children || [])) {
      if (c == null || c === false) continue;
      e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return e;
  }

  // A tree is "simple" if it has at most one include-group and no globals.
  function isSimpleTree(tree) {
    if (!tree) return true;
    const inc = Array.isArray(tree.include) ? tree.include : [];
    const gl = Array.isArray(tree.globals) ? tree.globals : [];
    return gl.length === 0 && inc.length <= 1;
  }

  function getConditions(tree) {
    if (!Array.isArray(tree.include) || tree.include.length === 0) {
      tree.include = [{ conditions: [] }];
    }
    if (!Array.isArray(tree.include[0].conditions)) tree.include[0].conditions = [];
    return tree.include[0].conditions;
  }

  function defaultValueFor(field) {
    const f = FIELDS[field];
    if (!f) return "";
    if (f.type === "multi") return [];
    if (f.type === "linesheet") return [];
    if (f.type === "num-cmp" || f.type === "num-loc") return 0;
    if (f.type === "num-range") return [0, 9999];
    if (f.type === "bool") return true;
    if (f.type === "single") return f.options?.[0]?.value || "";
    return "";
  }

  function chipSummary(cond, meta) {
    const f = FIELDS[cond.field];
    if (!f) return cond.field;
    if (f.type === "multi") {
      const vals = Array.isArray(cond.value) ? cond.value : [];
      const opPrefix = cond.op && cond.op !== (f.defaultOp) ? (f.opLabels?.[cond.op] || cond.op) + " " : "";
      if (vals.length === 0) return `${f.label}: any`;
      if (vals.length === 1) return `${f.label}: ${opPrefix}${vals[0]}`;
      if (vals.length <= 3) return `${f.label}: ${opPrefix}${vals.join(", ")}`;
      return `${f.label}: ${opPrefix}${vals.length} selected`;
    }
    if (f.type === "num-cmp") return `${f.label} ${cond.op} ${cond.value ?? 0}`;
    if (f.type === "num-range") {
      const [lo, hi] = Array.isArray(cond.value) ? cond.value : [0, 0];
      return `${f.label}: $${lo}–$${hi}`;
    }
    if (f.type === "num-loc") {
      const locCount = Array.isArray(cond.locations) ? cond.locations.length : 0;
      return `${f.label} ≥ ${cond.value ?? 0}${locCount ? ` @ ${locCount} loc` : ""}`;
    }
    if (f.type === "bool") return `${f.label}: ${cond.value ? "yes" : "no"}`;
    if (f.type === "single") {
      const opt = (f.options || []).find(o => o.value === cond.value);
      return `${f.label}: ${opt?.label || cond.value}`;
    }
    if (f.type === "text") return cond.value ? `${f.label}: "${cond.value}"` : `${f.label}: …`;
    if (f.type === "linesheet") {
      const ids = Array.isArray(cond.value) ? cond.value : (cond.value ? [cond.value] : []);
      const sheets = (meta && meta.linesheets) || [];
      const names = ids.map((id) => sheets.find((s) => String(s.id) === String(id))?.name).filter(Boolean);
      const opLabel = f.opLabels?.[cond.op] || cond.op;
      if (names.length === 0) return `${opLabel} (pick a sheet)`;
      if (names.length === 1) return `${opLabel} ${names[0]}`;
      return `${opLabel} ${names.length} sheets`;
    }
    return f.label;
  }

  // Popover singleton — only one open at a time.
  let openPopover = null;
  function closePopover() {
    if (openPopover) {
      openPopover.remove();
      openPopover = null;
      document.removeEventListener("mousedown", outsideHandler, true);
      document.removeEventListener("keydown", escHandler, true);
    }
  }
  function outsideHandler(ev) {
    if (openPopover && !openPopover.contains(ev.target) && !ev.target.closest?.(".lsf-chip, .lsf-add")) closePopover();
  }
  function escHandler(ev) { if (ev.key === "Escape") closePopover(); }

  function positionPopover(pop, anchor) {
    const r = anchor.getBoundingClientRect();
    pop.style.position = "absolute";
    pop.style.top  = (window.scrollY + r.bottom + 4) + "px";
    pop.style.left = (window.scrollX + r.left) + "px";
    pop.style.zIndex = "3000";
  }

  function openConditionPopover(anchor, cond, meta, onChange, onDelete) {
    closePopover();
    const f = FIELDS[cond.field];
    if (!f) return;

    const pop = el("div", { class: "lsf-pop" });
    pop.appendChild(el("div", { class: "lsf-pop-hd" }, [
      el("b", null, f.label),
      el("span", { style: "flex:1;" }),
      onDelete ? el("button", { class: "lsf-pop-del", title: "Remove filter", onclick: () => { onDelete(); closePopover(); } }, "Remove") : null
    ]));

    // Operator switcher (only for multi w/ op choices, tag, num-cmp, num-range)
    if (f.type === "multi" && f.opLabels) {
      const ops = Object.keys(f.opLabels);
      const opSel = el("select", { class: "lsf-pop-op" },
        ops.map(o => el("option", { value: o }, f.opLabels[o]))
      );
      opSel.value = cond.op || f.defaultOp;
      opSel.addEventListener("change", () => { cond.op = opSel.value; onChange(); });
      pop.appendChild(el("div", { class: "lsf-pop-row" }, [el("span", { class: "muted" }, "match"), opSel]));
    } else if (f.type === "num-cmp") {
      const opSel = el("select", { class: "lsf-pop-op" },
        ["=", ">=", "<="].map(o => el("option", { value: o }, o))
      );
      opSel.value = cond.op || f.defaultOp;
      opSel.addEventListener("change", () => { cond.op = opSel.value; onChange(); });
      pop.appendChild(el("div", { class: "lsf-pop-row" }, [opSel]));
    } else if (f.type === "linesheet") {
      const opSel = el("select", { class: "lsf-pop-op" },
        Object.entries(f.opLabels || { not_in: "exclude products from", in: "only products from" })
          .map(([v, lab]) => el("option", { value: v }, lab))
      );
      opSel.value = cond.op || f.defaultOp;
      opSel.addEventListener("change", () => { cond.op = opSel.value; onChange(); });
      pop.appendChild(el("div", { class: "lsf-pop-row" }, [el("span", { class: "muted" }, "rule"), opSel]));
    }

    pop.appendChild(renderValueBody(cond, meta, onChange));

    document.body.appendChild(pop);
    positionPopover(pop, anchor);
    openPopover = pop;
    setTimeout(() => {
      document.addEventListener("mousedown", outsideHandler, true);
      document.addEventListener("keydown", escHandler, true);
      const firstInput = pop.querySelector("input[type=text],input[type=search],input[type=number]");
      firstInput?.focus();
    }, 0);
  }

  function renderValueBody(cond, meta, onChange) {
    const f = FIELDS[cond.field];

    if (f.type === "multi") {
      const opts = metaList(meta, f.metaKey);
      const body = el("div", { class: "lsf-pop-body" });

      if (opts.length === 0) {
        body.appendChild(el("div", { class: "muted", style: "padding:8px 0;" },
          "No options available. (Reporting DB not connected?)"));
        return body;
      }

      const search = el("input", { type: "search", placeholder: "Search…", class: "lsf-search" });
      body.appendChild(search);

      const summary = el("div", { class: "lsf-pop-sub muted" });
      body.appendChild(summary);
      const list = el("div", { class: "lsf-pop-list" });
      body.appendChild(list);

      const current = new Set((Array.isArray(cond.value) ? cond.value : []).map(String));

      function updateSummary() {
        summary.textContent = current.size === 0
          ? `${opts.length} available`
          : `${current.size} selected · ${opts.length} available`;
      }

      function paint(filter) {
        list.innerHTML = "";
        const q = (filter || "").toLowerCase().trim();
        const shown = opts.filter(o => !q || String(o).toLowerCase().includes(q));
        for (const o of shown) {
          const id = "opt_" + Math.random().toString(36).slice(2, 8);
          const cb = el("input", { type: "checkbox", id });
          cb.checked = current.has(String(o));
          cb.addEventListener("change", () => {
            if (cb.checked) current.add(String(o));
            else current.delete(String(o));
            cond.value = Array.from(current);
            updateSummary();
            onChange();
          });
          list.appendChild(el("label", { class: "lsf-opt", for: id }, [cb, document.createTextNode(" " + o)]));
        }
        if (shown.length === 0) list.appendChild(el("div", { class: "muted", style: "padding:6px 2px;" }, "No matches."));
      }

      search.addEventListener("input", () => paint(search.value));

      const actions = el("div", { class: "lsf-pop-actions" }, [
        el("button", { onclick: () => {
          for (const o of opts) current.add(String(o));
          cond.value = Array.from(current);
          updateSummary(); paint(search.value); onChange();
        } }, "Select all"),
        el("button", { onclick: () => {
          current.clear(); cond.value = [];
          updateSummary(); paint(search.value); onChange();
        } }, "Clear")
      ]);
      body.appendChild(actions);
      updateSummary();
      paint("");
      return body;
    }

    if (f.type === "num-cmp") {
      const body = el("div", { class: "lsf-pop-body" });
      const inp = el("input", { type: "number", value: Number(cond.value) || 0, class: "lsf-num" });
      inp.addEventListener("input", () => { cond.value = Number(inp.value) || 0; onChange(); });
      body.appendChild(inp);
      return body;
    }

    if (f.type === "num-loc") {
      const body = el("div", { class: "lsf-pop-body" });
      const inp = el("input", { type: "number", value: Number(cond.value) || 0, class: "lsf-num" });
      inp.addEventListener("input", () => { cond.value = Number(inp.value) || 0; onChange(); });
      body.appendChild(el("div", { class: "lsf-pop-row" }, [el("span", { class: "muted" }, "min units"), inp]));

      const locs = meta.locations || [];
      if (locs.length) {
        body.appendChild(el("div", { class: "muted", style: "margin-top:8px;" }, "Limit to locations:"));
        const selected = new Set((cond.locations || []).map(String));
        const list = el("div", { class: "lsf-pop-list" });
        for (const l of locs) {
          const id = "loc_" + l.id;
          const cb = el("input", { type: "checkbox", id });
          cb.checked = selected.has(String(l.id));
          cb.addEventListener("change", () => {
            if (cb.checked) selected.add(String(l.id));
            else selected.delete(String(l.id));
            cond.locations = Array.from(selected);
            onChange();
          });
          list.appendChild(el("label", { class: "lsf-opt", for: id }, [cb, document.createTextNode(" " + (l.name || l.id))]));
        }
        body.appendChild(list);
      }
      return body;
    }

    if (f.type === "num-range") {
      const [lo0, hi0] = Array.isArray(cond.value) ? cond.value : [0, 0];
      const body = el("div", { class: "lsf-pop-body" });
      const lo = el("input", { type: "number", value: lo0, class: "lsf-num" });
      const hi = el("input", { type: "number", value: hi0, class: "lsf-num" });
      const sync = () => { cond.op = "between"; cond.value = [Number(lo.value) || 0, Number(hi.value) || 0]; onChange(); };
      lo.addEventListener("input", sync);
      hi.addEventListener("input", sync);
      body.appendChild(el("div", { class: "lsf-pop-row" }, [
        el("span", { class: "muted" }, "min $"), lo,
        el("span", { class: "muted", style: "margin-left:6px;" }, "max $"), hi
      ]));
      return body;
    }

    if (f.type === "bool") {
      const body = el("div", { class: "lsf-pop-body" });
      const yes = el("input", { type: "radio", name: "bool_" + cond.field, id: "by_" + cond.field });
      const no  = el("input", { type: "radio", name: "bool_" + cond.field, id: "bn_" + cond.field });
      yes.checked = cond.value !== false;
      no.checked  = cond.value === false;
      yes.addEventListener("change", () => { cond.value = true; onChange(); });
      no.addEventListener("change",  () => { cond.value = false; onChange(); });
      body.appendChild(el("label", { class: "lsf-opt", for: "by_" + cond.field }, [yes, document.createTextNode(" Yes")]));
      body.appendChild(el("label", { class: "lsf-opt", for: "bn_" + cond.field }, [no,  document.createTextNode(" No")]));
      return body;
    }

    if (f.type === "single") {
      const body = el("div", { class: "lsf-pop-body" });
      for (const o of f.options || []) {
        const id = "sg_" + cond.field + "_" + o.value;
        const rb = el("input", { type: "radio", name: "sg_" + cond.field, id });
        rb.checked = cond.value === o.value;
        rb.addEventListener("change", () => { cond.value = o.value; onChange(); });
        body.appendChild(el("label", { class: "lsf-opt", for: id }, [rb, document.createTextNode(" " + o.label)]));
      }
      return body;
    }

    if (f.type === "linesheet") {
      const sheets = (meta && meta.linesheets) || [];
      const body = el("div", { class: "lsf-pop-body" });

      if (sheets.length === 0) {
        body.appendChild(el("div", { class: "muted", style: "padding:8px 0;" },
          "No other line sheets yet — save one first to reference it."));
        return body;
      }

      const search = el("input", { type: "search", placeholder: "Search line sheets…", class: "lsf-search" });
      body.appendChild(search);

      const summary = el("div", { class: "lsf-pop-sub muted" });
      body.appendChild(summary);
      const list = el("div", { class: "lsf-pop-list" });
      body.appendChild(list);

      const current = new Set(
        (Array.isArray(cond.value) ? cond.value : (cond.value ? [cond.value] : [])).map(String)
      );

      function updateSummary() {
        summary.textContent = current.size === 0
          ? `${sheets.length} sheets available`
          : `${current.size} selected · ${sheets.length} available`;
      }

      function paint(filterText) {
        list.innerHTML = "";
        const q = (filterText || "").toLowerCase().trim();
        const shown = sheets.filter((s) => {
          if (!q) return true;
          const hay = ((s.name || "") + " " + (s.customer || "")).toLowerCase();
          return hay.includes(q);
        });
        for (const s of shown) {
          const id = "lsfopt_" + s.id;
          const cb = el("input", { type: "checkbox", id });
          cb.checked = current.has(String(s.id));
          cb.addEventListener("change", () => {
            if (cb.checked) current.add(String(s.id));
            else current.delete(String(s.id));
            cond.value = Array.from(current).map((v) => Number(v));
            updateSummary();
            onChange();
          });
          const labelText = s.customer ? `${s.name} · ${s.customer}` : s.name;
          list.appendChild(el("label", { class: "lsf-opt", for: id }, [cb, document.createTextNode(" " + labelText)]));
        }
        if (shown.length === 0) list.appendChild(el("div", { class: "muted", style: "padding:6px 2px;" }, "No matches."));
      }

      search.addEventListener("input", () => paint(search.value));
      updateSummary();
      paint("");
      return body;
    }

    // text
    const body = el("div", { class: "lsf-pop-body" });
    const inp = el("input", { type: "text", value: cond.value || "", class: "lsf-text" });
    inp.addEventListener("input", () => { cond.value = inp.value; onChange(); });
    body.appendChild(inp);
    return body;
  }

  function metaList(meta, key) {
    if (!key) return [];
    const v = meta?.[key];
    return Array.isArray(v) ? v : [];
  }

  function openAddMenu(anchor, usedFields, onPick) {
    closePopover();
    const pop = el("div", { class: "lsf-pop lsf-addmenu" });
    const searchBox = el("input", { type: "search", placeholder: "Add filter…", class: "lsf-search" });
    pop.appendChild(searchBox);

    const list = el("div", { class: "lsf-pop-list" });
    pop.appendChild(list);

    function paint(q) {
      list.innerHTML = "";
      const filter = (q || "").toLowerCase();
      for (const [key, def] of Object.entries(FIELDS)) {
        if (usedFields.has(key) && def.type !== "multi" && def.type !== "num-cmp" && def.type !== "num-range" && def.type !== "tag") {
          // Allow duplicates for some field types where it makes sense; skip otherwise.
        }
        if (usedFields.has(key)) continue;
        if (filter && !def.label.toLowerCase().includes(filter)) continue;
        const row = el("button", {
          class: "lsf-addopt",
          onclick: () => { onPick(key); closePopover(); }
        }, def.label);
        list.appendChild(row);
      }
      if (!list.children.length) list.appendChild(el("div", { class: "muted", style: "padding:6px 2px;" }, "No more filters."));
    }
    searchBox.addEventListener("input", () => paint(searchBox.value));
    paint("");

    document.body.appendChild(pop);
    positionPopover(pop, anchor);
    openPopover = pop;
    setTimeout(() => {
      document.addEventListener("mousedown", outsideHandler, true);
      document.addEventListener("keydown", escHandler, true);
      searchBox.focus();
    }, 0);
  }

  function renderBar(root, tree, meta, onChange) {
    root.innerHTML = "";
    root.classList.add("lsf-bar");

    if (!isSimpleTree(tree)) {
      root.appendChild(el("span", { class: "lsf-chip lsf-chip-adv" }, [
        document.createTextNode("Advanced filter active"),
        el("button", {
          title: "Convert to simple and discard extras",
          onclick: () => {
            if (!confirm("Simplify this filter to the first group? Other groups and always-apply rules will be discarded.")) return;
            const inc = tree.include?.[0] ? [tree.include[0]] : [{ conditions: [] }];
            tree.include = inc;
            tree.globals = [];
            renderBar(root, tree, meta, onChange);
            onChange();
          }
        }, "Simplify")
      ]));
      return;
    }

    const conds = getConditions(tree);
    const used = new Set(conds.map(c => c.field));

    conds.forEach((cond, idx) => {
      const chip = el("button", {
        class: "lsf-chip" + (isIncomplete(cond) ? " lsf-chip-incomplete" : ""),
        title: "Edit filter",
        onclick: (ev) => {
          ev.stopPropagation();
          openConditionPopover(chip, cond, meta, () => {
            // Rebuild chip summary in place
            chip.firstChild.textContent = chipSummary(cond, meta);
            onChange();
          }, () => {
            conds.splice(idx, 1);
            renderBar(root, tree, meta, onChange);
            onChange();
          });
        }
      }, [
        document.createTextNode(chipSummary(cond, meta)),
        el("span", {
          class: "lsf-chip-x",
          title: "Remove",
          onclick: (ev) => {
            ev.stopPropagation();
            conds.splice(idx, 1);
            renderBar(root, tree, meta, onChange);
            onChange();
          }
        }, "×")
      ]);
      root.appendChild(chip);
    });

    const addBtn = el("button", {
      class: "lsf-add",
      onclick: (ev) => {
        ev.stopPropagation();
        openAddMenu(addBtn, used, (fieldKey) => {
          const f = FIELDS[fieldKey];
          const cond = { field: fieldKey, op: f.defaultOp, value: defaultValueFor(fieldKey) };
          conds.push(cond);
          renderBar(root, tree, meta, onChange);
          // Open editor on the just-added chip
          const chips = root.querySelectorAll(".lsf-chip");
          const last = chips[chips.length - 1];
          if (last) {
            openConditionPopover(last, cond, meta, () => {
              last.firstChild.textContent = chipSummary(cond, meta);
              onChange();
            }, () => {
              const i = conds.indexOf(cond);
              if (i >= 0) conds.splice(i, 1);
              renderBar(root, tree, meta, onChange);
              onChange();
            });
          }
          onChange();
        });
      }
    }, "+ Add filter");
    root.appendChild(addBtn);

    if (conds.length > 0) {
      const clear = el("button", {
        class: "lsf-clear",
        onclick: () => {
          if (!confirm("Clear all filters?")) return;
          tree.include = [{ conditions: [] }];
          renderBar(root, tree, meta, onChange);
          onChange();
        }
      }, "Clear all");
      root.appendChild(clear);
    }
  }

  function isIncomplete(cond) {
    const f = FIELDS[cond.field];
    if (!f) return false;
    if (f.type === "multi") return !Array.isArray(cond.value) || cond.value.length === 0;
    if (f.type === "linesheet") return !Array.isArray(cond.value) || cond.value.length === 0;
    if (f.type === "text") return !String(cond.value || "").trim();
    return false;
  }

  w.LineSheets.renderFilterBar = renderBar;
  w.LineSheets.FILTER_FIELDS = FIELDS;
  w.LineSheets.isSimpleTree = isSimpleTree;
  w.LineSheets.closeFilterPopover = closePopover;
})();
