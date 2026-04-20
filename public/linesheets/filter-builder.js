// Two-level filter builder: include-groups (OR'd), each group is conditions (AND'd),
// plus flat globals (AND'd). Emits the tree schema defined in the spec.
(function () {
  const w = window;
  w.LineSheets = w.LineSheets || {};

  const FIELDS = {
    season:        { label: "Season",      type: "enum", ops: ["in", "not_in"] },
    class:         { label: "Class",       type: "enum", ops: ["in", "not_in"] },
    product_type:  { label: "Type",        type: "enum", ops: ["in", "not_in"] },
    style_name:    { label: "Style name",  type: "text", ops: ["contains", "in"] },
    product_group: { label: "Group",       type: "text", ops: ["in", "contains"] },
    title:         { label: "Title",       type: "text", ops: ["contains"] },
    tag:           { label: "Tag",         type: "tags", ops: ["has_any", "has_all", "has_none"] },
    length:        { label: "Length",      type: "num",  ops: ["=", ">=", "<="] },
    fabric:        { label: "Fabric",      type: "enum", ops: ["in", "not_in"] },
    sleeve:        { label: "Sleeve",      type: "enum", ops: ["in", "not_in"] },
    price_tier:    { label: "Price tier",  type: "single", ops: ["="] },
    price:         { label: "Price",       type: "num",  ops: [">=", "<=", "between"] },
    inventory_min: { label: "Inv ≥",       type: "num",  ops: [">="] },
    has_inventory: { label: "Has inv.",    type: "bool", ops: ["="] }
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
      if (c == null) continue;
      e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return e;
  }

  function defaultValueFor(field) {
    const f = FIELDS[field];
    if (!f) return "";
    if (f.type === "enum" || f.type === "tags") return [];
    if (f.type === "num") return 0;
    if (f.type === "bool") return true;
    if (f.type === "single") return "full_price";
    return "";
  }

  function renderValueInput(cond, meta, onChange) {
    const f = FIELDS[cond.field];
    if (!f) return document.createTextNode("");

    if (f.type === "num") {
      if (cond.op === "between") {
        const [lo, hi] = Array.isArray(cond.value) ? cond.value : [0, 0];
        const loEl = el("input", { type: "number", value: lo, style: "width:72px;" });
        const hiEl = el("input", { type: "number", value: hi, style: "width:72px;" });
        loEl.addEventListener("input", () => { cond.value = [Number(loEl.value), Number(hiEl.value)]; onChange(); });
        hiEl.addEventListener("input", () => { cond.value = [Number(loEl.value), Number(hiEl.value)]; onChange(); });
        return el("span", null, [loEl, document.createTextNode(" to "), hiEl]);
      }
      const inp = el("input", { type: "number", value: cond.value ?? 0, style: "width:80px;" });
      inp.addEventListener("input", () => { cond.value = Number(inp.value); onChange(); });
      return inp;
    }

    if (f.type === "text") {
      if (cond.op === "in") {
        const inp = el("input", { type: "text", placeholder: "comma-separated", value: Array.isArray(cond.value) ? cond.value.join(", ") : "", style: "width:240px;" });
        inp.addEventListener("input", () => { cond.value = inp.value.split(",").map(s => s.trim()).filter(Boolean); onChange(); });
        return inp;
      }
      const inp = el("input", { type: "text", value: cond.value || "", style: "width:240px;" });
      inp.addEventListener("input", () => { cond.value = inp.value; onChange(); });
      return inp;
    }

    if (f.type === "bool") {
      const sel = el("select", null, [el("option", { value: "true" }, "true"), el("option", { value: "false" }, "false")]);
      sel.value = cond.value ? "true" : "false";
      sel.addEventListener("change", () => { cond.value = sel.value === "true"; onChange(); });
      return sel;
    }

    if (f.type === "single") {
      // price_tier
      const sel = el("select", null, [
        el("option", { value: "any" }, "any"),
        el("option", { value: "full_price" }, "full price"),
        el("option", { value: "off_price" }, "off price")
      ]);
      sel.value = cond.value || "full_price";
      sel.addEventListener("change", () => { cond.value = sel.value; onChange(); });
      return sel;
    }

    // enum / tags: multi-pick
    const options = optionsForField(cond.field, meta);
    const wrap = el("div", { class: "ls-chip-wrap" });
    const current = new Set(Array.isArray(cond.value) ? cond.value.map(String) : []);
    function refresh() {
      wrap.innerHTML = "";
      const sel = el("select", null, [el("option", { value: "" }, "+ add…")].concat(
        options.filter(o => !current.has(String(o))).map(o => el("option", { value: o }, String(o)))
      ));
      sel.addEventListener("change", () => {
        if (sel.value) { current.add(sel.value); cond.value = Array.from(current); onChange(); refresh(); }
      });
      wrap.appendChild(sel);
      for (const v of current) {
        const chip = el("span", { class: "ls-chip" }, [
          document.createTextNode(v),
          el("button", { onclick: () => { current.delete(v); cond.value = Array.from(current); onChange(); refresh(); } }, "×")
        ]);
        wrap.appendChild(chip);
      }
    }
    refresh();
    return wrap;
  }

  function optionsForField(field, meta) {
    switch (field) {
      case "season":       return meta.seasons || [];
      case "class":        return meta.classes || [];
      case "product_type": return meta.product_types || [];
      case "fabric":       return meta.fabrics || [];
      case "sleeve":       return meta.sleeves || [];
      case "tag":          return meta.tag_suggestions || [];
      default:             return [];
    }
  }

  function renderCondition(cond, meta, onChange, onRemove) {
    const fieldSel = el("select", { class: "ls-fld" },
      Object.keys(FIELDS).map(k => el("option", { value: k }, FIELDS[k].label))
    );
    fieldSel.value = cond.field;
    fieldSel.addEventListener("change", () => {
      cond.field = fieldSel.value;
      const ops = FIELDS[cond.field].ops;
      cond.op = ops[0];
      cond.value = defaultValueFor(cond.field);
      onChange();
    });

    const ops = FIELDS[cond.field]?.ops || [];
    const opSel = el("select", { class: "ls-op" }, ops.map(o => el("option", { value: o }, o)));
    opSel.value = cond.op;
    opSel.addEventListener("change", () => { cond.op = opSel.value; onChange(); });

    const valEl = renderValueInput(cond, meta, onChange);

    // Optional location filter for inventory_min
    const extras = [];
    if (cond.field === "inventory_min") {
      const locWrap = el("span", { class: "ls-chip-wrap" });
      const locs = meta.locations || [];
      const selected = new Set((cond.locations || []).map(String));
      function refreshLocs() {
        locWrap.innerHTML = "";
        const sel = el("select", null, [el("option", { value: "" }, "+ location…")].concat(
          locs.filter(l => !selected.has(l.id)).map(l => el("option", { value: l.id }, l.name || l.id))
        ));
        sel.addEventListener("change", () => {
          if (sel.value) { selected.add(sel.value); cond.locations = Array.from(selected); onChange(); refreshLocs(); }
        });
        locWrap.appendChild(sel);
        for (const id of selected) {
          const name = locs.find(l => l.id === id)?.name || id;
          locWrap.appendChild(el("span", { class: "ls-chip" }, [
            document.createTextNode(name),
            el("button", { onclick: () => { selected.delete(id); cond.locations = Array.from(selected); onChange(); refreshLocs(); } }, "×")
          ]));
        }
      }
      refreshLocs();
      extras.push(el("span", { style: "margin-left:6px;" }, [el("small", { class: "muted" }, " at "), locWrap]));
    }

    const row = el("div", { class: "ls-cond" }, [
      fieldSel, opSel, valEl, ...extras,
      el("button", { class: "ls-x", onclick: onRemove, title: "Remove" }, "×")
    ]);
    return row;
  }

  function renderFilter(root, tree, meta, onChange) {
    root.innerHTML = "";

    // Include groups
    const groupsWrap = el("div", { class: "ls-groups" });
    if (!Array.isArray(tree.include)) tree.include = [];
    if (!Array.isArray(tree.globals)) tree.globals = [];

    tree.include.forEach((group, gi) => {
      if (!Array.isArray(group.conditions)) group.conditions = [];
      const gBox = el("div", { class: "ls-group" }, [
        el("div", { class: "ls-group-hd" }, [
          el("strong", null, `Group ${gi + 1}`),
          el("span", { class: "muted" }, " (conditions AND'd within group; groups OR'd together)"),
          el("button", { style: "float:right", onclick: () => { tree.include.splice(gi, 1); onChange(); } }, "Remove group")
        ])
      ]);
      group.conditions.forEach((cond, ci) => {
        gBox.appendChild(renderCondition(cond, meta, onChange, () => {
          group.conditions.splice(ci, 1); onChange();
        }));
      });
      gBox.appendChild(el("button", {
        class: "ls-add",
        onclick: () => {
          group.conditions.push({ field: "season", op: "in", value: [] });
          onChange();
        }
      }, "+ AND condition"));
      groupsWrap.appendChild(gBox);
    });

    const addGroup = el("button", {
      class: "ls-add-group",
      onclick: () => {
        tree.include.push({ conditions: [{ field: "season", op: "in", value: [] }] });
        onChange();
      }
    }, "+ OR group");
    groupsWrap.appendChild(addGroup);

    // Global filters
    const globalsWrap = el("div", { class: "ls-globals" }, [
      el("div", { class: "ls-group-hd" }, [
        el("strong", null, "Global filters"),
        el("span", { class: "muted" }, " (AND'd with all groups)")
      ])
    ]);
    tree.globals.forEach((cond, ci) => {
      globalsWrap.appendChild(renderCondition(cond, meta, onChange, () => {
        tree.globals.splice(ci, 1); onChange();
      }));
    });
    globalsWrap.appendChild(el("button", {
      class: "ls-add",
      onclick: () => { tree.globals.push({ field: "price_tier", op: "=", value: "full_price" }); onChange(); }
    }, "+ global"));

    root.appendChild(groupsWrap);
    root.appendChild(globalsWrap);
  }

  w.LineSheets.renderFilterBuilder = renderFilter;
  w.LineSheets.FIELDS = FIELDS;
})();
