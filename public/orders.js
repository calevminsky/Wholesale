// Drafts workflow page: list drafts, create from upload, edit, run preview,
// submit to Shopify. Mounted into #ordersPage.
(function () {
  const root = document.getElementById("ordersPage");
  if (!root) return;

  const SIZES = ["XXS", "XS", "S", "M", "L", "XL", "XXL"];

  const state = {
    view: "list",        // "list" | "edit"
    orders: [],
    customers: [],
    locations: [],
    current: null,       // active draft when view==="edit"
    previews: [],
    loading: false,
    busy: false,
    busyMsg: ""
  };

  function el(tag, attrs = {}, children = []) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") n.className = v;
      else if (k === "style" && typeof v === "object") Object.assign(n.style, v);
      else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v !== undefined && v !== null) n.setAttribute(k, v);
    }
    if (!Array.isArray(children)) children = [children];
    for (const c of children) {
      if (c == null) continue;
      n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return n;
  }

  async function api(path, opts = {}) {
    const isForm = opts.body instanceof FormData;
    const headers = isForm ? {} : { "Content-Type": "application/json" };
    const res = await fetch(path, { headers, ...opts });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  }

  async function loadList() {
    state.loading = true;
    render();
    try {
      const [{ orders }, { customers }, locResp] = await Promise.all([
        api("/api/orders-draft"),
        api("/api/customers"),
        fetch("/api/locations").then((r) => r.json()).catch(() => ({ locations: [] }))
      ]);
      state.orders = orders || [];
      state.customers = customers || [];
      state.locations = locResp.locations || [];
    } catch (e) {
      alert("Couldn't load drafts: " + e.message);
    } finally {
      state.loading = false;
      render();
    }
  }

  async function openDraft(id) {
    state.busy = true; state.busyMsg = "Opening draft…"; render();
    try {
      const { order, previews } = await api(`/api/orders-draft/${id}`);
      state.current = order;
      state.previews = previews || [];
      state.view = "edit";
    } catch (e) {
      alert("Couldn't open: " + e.message);
    } finally {
      state.busy = false;
      render();
    }
  }

  async function deleteDraft(o) {
    if (!confirm(`Archive draft "${o.name || o.id}"? Submitted orders are kept; this only hides the draft.`)) return;
    try {
      await api(`/api/orders-draft/${o.id}`, { method: "DELETE" });
      await loadList();
    } catch (e) {
      alert("Archive failed: " + e.message);
    }
  }

  async function uploadFromFile() {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = ".xlsx,.xls,.csv";
    inp.onchange = async () => {
      const f = inp.files?.[0];
      if (!f) return;
      const fd = new FormData();
      fd.append("file", f);
      state.busy = true; state.busyMsg = "Uploading & creating draft…"; render();
      try {
        const { order } = await api("/api/orders-draft/from-upload", { method: "POST", body: fd });
        state.busy = false;
        await openDraft(order.id);
      } catch (e) {
        state.busy = false;
        alert("Upload failed: " + e.message);
        render();
      }
    };
    inp.click();
  }

  async function newBlankDraft() {
    const name = prompt("Name this draft (e.g. 'Spring 26 - Boutique X'):", "");
    if (!name) return;
    state.busy = true; state.busyMsg = "Creating draft…"; render();
    try {
      const { order } = await api("/api/orders-draft", {
        method: "POST",
        body: JSON.stringify({ name, items: [], location_ids: [] })
      });
      state.busy = false;
      await openDraft(order.id);
    } catch (e) {
      state.busy = false;
      alert("Create failed: " + e.message);
      render();
    }
  }

  async function saveCurrent(patch) {
    if (!state.current) return;
    state.busy = true; state.busyMsg = "Saving…"; render();
    try {
      const { order } = await api(`/api/orders-draft/${state.current.id}`, {
        method: "PUT",
        body: JSON.stringify(patch)
      });
      state.current = order;
      const { previews } = await api(`/api/orders-draft/${state.current.id}/previews`);
      state.previews = previews || [];
    } catch (e) {
      alert("Save failed: " + e.message);
    } finally {
      state.busy = false;
      render();
    }
  }

  async function runPreview() {
    if (!state.current) return;
    state.busy = true; state.busyMsg = "Running availability preview…"; render();
    try {
      const { order } = await api(`/api/orders-draft/${state.current.id}/preview`, { method: "POST" });
      state.current = order;
      const { previews } = await api(`/api/orders-draft/${state.current.id}/previews`);
      state.previews = previews || [];
    } catch (e) {
      alert("Preview failed: " + e.message);
    } finally {
      state.busy = false;
      render();
    }
  }

  async function submitToShopify() {
    if (!state.current) return;
    if (!confirm("Submit this draft to Shopify? This creates a real (unpaid) order. The draft becomes read-only.")) return;
    state.busy = true; state.busyMsg = "Submitting to Shopify… this can take a minute."; render();
    try {
      const resp = await api(`/api/orders-draft/${state.current.id}/submit`, {
        method: "POST",
        body: JSON.stringify({ reserveHours: 48 })
      });
      state.current = resp.order;
      alert(`Submitted. Shopify order: ${resp.order?.shopify_order_name || resp.order?.shopify_order_id || "(see report)"}`);
    } catch (e) {
      alert("Submit failed: " + e.message);
    } finally {
      state.busy = false;
      render();
    }
  }

  // ---------- views ----------

  function statusPill(s) {
    const colors = {
      draft: ["#fafafa", "#666"],
      previewed: ["#eef5ff", "#1a4a8a"],
      submitted: ["#e7f6e7", "#2a6e2a"],
      cancelled: ["#fbe7e7", "#8a2a2a"]
    };
    const [bg, fg] = colors[s] || colors.draft;
    return el("span", {
      style: {
        background: bg, color: fg, padding: "2px 10px",
        borderRadius: "999px", fontSize: "12px", fontWeight: 600
      }
    }, s);
  }

  function renderList() {
    const wrap = el("div");
    wrap.appendChild(el("div", { class: "row" }, [
      el("h2", { style: { margin: 0 } }, "Orders"),
      el("button", { class: "primary", onclick: uploadFromFile }, "Upload customer's order form"),
      el("button", { onclick: newBlankDraft }, "+ Blank draft")
    ]));
    wrap.appendChild(el("p", { class: "muted" },
      "Each draft saves to the database. You can leave the screen and come back. Nothing hits Shopify until you press Submit."));

    if (state.loading) {
      wrap.appendChild(el("p", { class: "muted" }, "Loading…"));
      return wrap;
    }
    if (!state.orders.length) {
      wrap.appendChild(el("p", { class: "muted" },
        "No drafts yet. Upload a customer's order form, or build one from scratch."));
      return wrap;
    }

    const tbl = el("table");
    tbl.appendChild(el("thead", {}, [el("tr", {}, [
      el("th", {}, "Status"),
      el("th", {}, "Name"),
      el("th", {}, "Customer"),
      el("th", {}, "Line Sheet"),
      el("th", {}, "Items"),
      el("th", {}, "Last Preview"),
      el("th", {}, "Updated"),
      el("th", {}, "")
    ])]));
    const body = el("tbody");
    for (const o of state.orders) {
      const itemCount = Array.isArray(o.items) ? o.items.length : 0;
      const lastPrev = o.last_preview_at ? new Date(o.last_preview_at).toLocaleString() : "—";
      const updated = o.updated_at ? new Date(o.updated_at).toLocaleString() : "";
      body.appendChild(el("tr", {}, [
        el("td", {}, statusPill(o.status)),
        el("td", {}, [el("a", { href: "#", onclick: (e) => { e.preventDefault(); openDraft(o.id); } }, o.name || `#${o.id}`)]),
        el("td", {}, o.customer_name || ""),
        el("td", {}, o.line_sheet_name || ""),
        el("td", {}, String(itemCount)),
        el("td", {}, lastPrev),
        el("td", {}, updated),
        el("td", { style: { textAlign: "right" } }, [
          el("button", { onclick: () => openDraft(o.id) }, "Open"),
          " ",
          o.status !== "submitted"
            ? el("button", { onclick: () => deleteDraft(o) }, "Archive")
            : null
        ])
      ]));
    }
    tbl.appendChild(body);
    wrap.appendChild(tbl);
    return wrap;
  }

  function renderEditor() {
    const o = state.current;
    if (!o) return el("div", {}, "No draft.");
    const isReadOnly = o.status === "submitted" || !!o.archived_at;

    const wrap = el("div");

    // Header
    wrap.appendChild(el("div", { class: "row" }, [
      el("button", { onclick: async () => { state.view = "list"; state.current = null; await loadList(); } }, "← All drafts"),
      el("h2", { style: { margin: 0 } }, o.name || `Draft #${o.id}`),
      statusPill(o.status),
      o.shopify_order_name ? el("span", { class: "muted" }, `Shopify: ${o.shopify_order_name}`) : null
    ]));

    // Step strip — makes the workflow obvious for a non-technical manager.
    if (!isReadOnly) {
      const items = Array.isArray(o.items) ? o.items : [];
      const selectedLocs = Array.isArray(o.location_ids) ? o.location_ids : [];
      const stepDone = {
        1: items.length > 0 && selectedLocs.length > 0,
        2: o.status === "previewed",
        3: o.status === "submitted"
      };
      const stepActive = stepDone[2] ? 3 : (stepDone[1] ? 2 : 1);
      const steps = [
        { n: 1, label: "Pick locations" },
        { n: 2, label: "Run preview" },
        { n: 3, label: "Submit to Shopify" }
      ];
      const strip = el("div", { class: "ord-steps" });
      for (const s of steps) {
        const cls = "ord-step"
          + (stepDone[s.n] ? " ord-step-done" : "")
          + (stepActive === s.n && !stepDone[s.n] ? " ord-step-active" : "");
        strip.appendChild(el("div", { class: cls }, [
          el("span", { class: "ord-step-num" }, stepDone[s.n] ? "✓" : String(s.n)),
          el("span", { class: "ord-step-lbl" }, s.label)
        ]));
      }
      wrap.appendChild(strip);
    }

    // Top form: name, customer, notes
    const form = el("div", { class: "box" });
    const nameInp = el("input", { type: "text", value: o.name || "" });
    nameInp.disabled = isReadOnly;
    nameInp.addEventListener("change", () => saveCurrent({ name: nameInp.value }));

    const custSel = el("select");
    custSel.disabled = isReadOnly;
    custSel.appendChild(el("option", { value: "" }, "— No customer —"));
    for (const c of state.customers) {
      const opt = el("option", { value: String(c.id) }, c.name);
      if (o.customer_id === c.id) opt.selected = true;
      custSel.appendChild(opt);
    }
    custSel.addEventListener("change", () => saveCurrent({ customer_id: custSel.value ? Number(custSel.value) : null }));

    const notesInp = el("textarea", {});
    notesInp.value = o.notes || "";
    notesInp.disabled = isReadOnly;
    notesInp.addEventListener("change", () => saveCurrent({ notes: notesInp.value }));

    form.appendChild(el("div", { class: "row" }, [el("label", { style: { width: "120px" } }, "Name"), nameInp]));
    form.appendChild(el("div", { class: "row" }, [el("label", { style: { width: "120px" } }, "Customer"), custSel]));
    form.appendChild(el("div", { class: "row" }, [el("label", { style: { width: "120px", alignSelf: "flex-start" } }, "Notes"), notesInp]));
    wrap.appendChild(form);

    // Locations picker (drain order)
    const locBox = el("div", { class: "box" });
    locBox.appendChild(el("h3", { style: { marginTop: 0 } }, "Locations (drain order)"));
    locBox.appendChild(el("p", { class: "muted" }, "Drag to reorder. Allocation drains the first location first."));
    const locList = el("div");
    const selectedLocs = Array.isArray(o.location_ids) ? [...o.location_ids] : [];
    // Show selected first, then unselected
    const locById = new Map(state.locations.map((l) => [l.id, l]));
    const orderedSelected = selectedLocs.map((id) => locById.get(id)).filter(Boolean);
    const unselected = state.locations.filter((l) => !selectedLocs.includes(l.id));
    for (const l of [...orderedSelected, ...unselected]) {
      const checked = selectedLocs.includes(l.id);
      const cb = el("input", { type: "checkbox" });
      cb.checked = checked;
      cb.disabled = isReadOnly;
      cb.addEventListener("change", () => {
        const idx = selectedLocs.indexOf(l.id);
        if (cb.checked && idx < 0) selectedLocs.push(l.id);
        else if (!cb.checked && idx >= 0) selectedLocs.splice(idx, 1);
        saveCurrent({ location_ids: selectedLocs });
      });
      locList.appendChild(el("div", { class: "loc" }, [cb, el("span", {}, l.name || l.id)]));
    }
    locBox.appendChild(locList);
    wrap.appendChild(locBox);

    // Items table
    const itemsBox = el("div", { class: "box" });
    itemsBox.appendChild(el("h3", { style: { marginTop: 0 } }, "Items"));
    const items = Array.isArray(o.items) ? o.items : [];
    if (!items.length) {
      itemsBox.appendChild(el("p", { class: "muted" }, "No items yet. Drafts created from a customer's filled order form will land here automatically."));
    } else {
      const tbl = el("table");
      tbl.appendChild(el("thead", {}, [el("tr", {}, [
        el("th", {}, "Style"),
        el("th", {}, "Wholesale"),
        ...SIZES.map((s) => el("th", {}, s)),
        el("th", {}, "Total")
      ])]));
      const tbody = el("tbody");
      let grand = 0;
      for (const it of items) {
        const sq = it.size_qty || it.sizeQty || {};
        let rowTotal = 0;
        const tds = [
          el("td", {}, it.handle),
          el("td", {}, `$${Number(it.unit_price ?? it.unitPrice ?? 0).toFixed(2)}`)
        ];
        for (const s of SIZES) {
          const q = Number(sq[s] || 0);
          rowTotal += q;
          tds.push(el("td", {}, q ? String(q) : ""));
        }
        tds.push(el("td", {}, String(rowTotal)));
        grand += rowTotal;
        tbody.appendChild(el("tr", {}, tds));
      }
      tbody.appendChild(el("tr", {}, [
        el("td", { colspan: "2", style: { textAlign: "right", fontWeight: 600 } }, "Total units"),
        ...SIZES.map(() => el("td", {}, "")),
        el("td", { style: { fontWeight: 600 } }, String(grand))
      ]));
      tbl.appendChild(tbody);
      itemsBox.appendChild(tbl);
    }
    wrap.appendChild(itemsBox);

    // Action bar — Submit is gated behind a successful preview so the
    // manager always sees what's fulfillable before anything hits Shopify.
    const actions = el("div", { class: "row", style: { marginTop: "12px", alignItems: "center" } });
    if (!isReadOnly) {
      const hasItems = items.length > 0;
      const hasLocs = selectedLocs.length > 0;
      const hasFreshPreview = o.status === "previewed";

      const previewBtn = el("button", { class: "primary", onclick: runPreview }, "Run Availability Preview");
      previewBtn.disabled = !hasItems || !hasLocs;
      actions.appendChild(previewBtn);

      const submitBtn = el("button", {
        onclick: submitToShopify,
        title: hasFreshPreview
          ? "Create the Shopify order using the preview's allocation"
          : "Run preview first, then submit"
      }, "Submit to Shopify");
      submitBtn.disabled = !hasItems || !hasLocs || !hasFreshPreview;
      actions.appendChild(submitBtn);

      // Inline hint for whatever step the manager is on right now.
      let hint = "";
      if (!hasItems) hint = "Add items to the draft first.";
      else if (!hasLocs) hint = "Pick at least one location to start.";
      else if (!hasFreshPreview) hint = "Run preview before submitting.";
      else hint = "Ready to submit.";
      actions.appendChild(el("span", { class: "muted", style: { marginLeft: "8px" } }, hint));
    }
    wrap.appendChild(actions);

    // Preview history
    if (state.previews.length) {
      const histBox = el("div", { class: "box" });
      histBox.appendChild(el("h3", { style: { marginTop: 0 } }, "Preview History"));
      const list = el("ul");
      for (const p of state.previews) {
        const when = p.created_at ? new Date(p.created_at).toLocaleString() : "";
        list.appendChild(el("li", {}, [
          when,
          " ",
          p.is_stale ? el("span", { class: "muted" }, "(stale)") : el("span", { style: { color: "#2a6e2a", fontWeight: 600 } }, "(current)")
        ]));
      }
      histBox.appendChild(list);
      wrap.appendChild(histBox);
    }

    return wrap;
  }

  function renderBusy() {
    if (!state.busy) return null;
    return el("div", {
      style: {
        position: "fixed", bottom: "30px", right: "30px",
        background: "#111", color: "#fff", padding: "10px 18px",
        borderRadius: "8px", zIndex: 2000
      }
    }, state.busyMsg || "Working…");
  }

  function render() {
    root.innerHTML = "";
    root.appendChild(state.view === "edit" ? renderEditor() : renderList());
    const busy = renderBusy();
    if (busy) root.appendChild(busy);
  }

  window.OrdersPage = {
    show: async () => { state.view = "list"; await loadList(); }
  };
})();
