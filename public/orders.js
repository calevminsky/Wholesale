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
    previewSnapshot: null, // full snapshot for the current non-stale preview
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
      state.previewSnapshot = null;

      // Load full data for the current (non-stale) snapshot if one exists.
      const currentSnap = previews?.find((p) => !p.is_stale);
      if (currentSnap) {
        try {
          const { preview } = await api(`/api/orders-draft/${id}/previews/${currentSnap.id}`);
          state.previewSnapshot = preview?.snapshot || null;
        } catch { /* non-fatal */ }
      }
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
    // If items or locations change, the preview is no longer valid.
    if (patch.items !== undefined || patch.location_ids !== undefined) {
      state.previewSnapshot = null;
    }
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
    state.busy = true; state.busyMsg = "Saving & running availability preview…"; render();
    try {
      // Flush any in-memory item edits (typed but not yet blurred) before running.
      await api(`/api/orders-draft/${state.current.id}`, {
        method: "PUT",
        body: JSON.stringify({ items: state.current.items })
      });
      const result = await api(`/api/orders-draft/${state.current.id}/preview`, { method: "POST" });
      state.current = result.order;
      state.previewSnapshot = result.preview?.snapshot || null;
      const { previews } = await api(`/api/orders-draft/${state.current.id}/previews`);
      state.previews = previews || [];
    } catch (e) {
      alert("Preview failed: " + e.message);
    } finally {
      state.busy = false;
      render();
    }
  }

  async function resolveMismatches(strategy) {
    if (!state.current) return;
    const label = strategy === "snapshot" ? "original" : "customer";
    if (!confirm(`Apply ${label} prices to all flagged lines?`)) return;
    state.busy = true; state.busyMsg = "Applying prices…"; render();
    try {
      const { order } = await api(`/api/orders-draft/${state.current.id}/resolve-mismatches`, {
        method: "POST",
        body: JSON.stringify({ strategy })
      });
      state.current = order;
    } catch (e) {
      alert("Resolve failed: " + e.message);
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

    // Build a lookup from the current non-stale preview snapshot.
    // Keys are "handle:size", values are {requested, allocated, dropped}.
    const previewMap = new Map();
    if (state.previewSnapshot?.report?.lines) {
      for (const line of state.previewSnapshot.report.lines) {
        previewMap.set(`${line.handle}:${line.size}`, line);
      }
    }
    const hasPreview = previewMap.size > 0;

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

    // Locations picker with drag-to-reorder
    const locBox = el("div", { class: "box" });
    locBox.appendChild(el("h3", { style: { marginTop: 0 } }, "Locations (drain order)"));
    locBox.appendChild(el("p", { class: "muted" }, "Check locations to include. Drag checked rows to set drain order — first is drained first."));
    const locList = el("div");
    const selectedLocs = Array.isArray(o.location_ids) ? [...o.location_ids] : [];
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
        saveCurrent({ location_ids: [...selectedLocs] });
      });

      const row = el("div", {
        class: "loc",
        draggable: isReadOnly ? "false" : "true",
        style: { cursor: isReadOnly ? "default" : "grab", userSelect: "none" }
      });
      row.dataset.locId = l.id;

      const grip = el("span", {
        style: { marginRight: "6px", opacity: "0.35", fontSize: "14px", cursor: "grab" }
      }, "⠿");

      if (!isReadOnly) {
        row.addEventListener("dragstart", (e) => {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", l.id);
          row.style.opacity = "0.45";
        });
        row.addEventListener("dragend", () => {
          row.style.opacity = "";
        });
        row.addEventListener("dragover", (e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          row.style.outline = "2px dashed #6b7280";
        });
        row.addEventListener("dragleave", () => {
          row.style.outline = "";
        });
        row.addEventListener("drop", (e) => {
          e.preventDefault();
          row.style.outline = "";
          const fromId = e.dataTransfer.getData("text/plain");
          const toId = l.id;
          if (fromId === toId) return;
          const fromIdx = selectedLocs.indexOf(fromId);
          const toIdx = selectedLocs.indexOf(toId);
          // Only reorder within the selected set
          if (fromIdx < 0 || toIdx < 0) return;
          selectedLocs.splice(fromIdx, 1);
          selectedLocs.splice(toIdx, 0, fromId);
          saveCurrent({ location_ids: [...selectedLocs] });
        });
      }

      row.appendChild(grip);
      row.appendChild(cb);
      row.appendChild(el("span", { style: { marginLeft: "4px" } }, l.name || l.id));
      locList.appendChild(row);
    }
    locBox.appendChild(locList);
    wrap.appendChild(locBox);

    // Price-mismatch banner
    const mismatches = Array.isArray(o.price_mismatches) ? o.price_mismatches : [];
    if (mismatches.length) {
      const banner = el("div", {
        class: "box",
        style: {
          background: "#fff7e6",
          borderLeft: "4px solid #d97706",
          marginTop: "12px"
        }
      });
      banner.appendChild(el("h3", { style: { marginTop: 0, color: "#92400e" } },
        `${mismatches.length} price ${mismatches.length === 1 ? "change" : "changes"} vs. the original order form`));
      const list = el("table", { style: { marginBottom: "8px" } });
      list.appendChild(el("thead", {}, [el("tr", {}, [
        el("th", {}, "Style"),
        el("th", {}, "Original"),
        el("th", {}, "Customer typed"),
        el("th", {}, "Δ")
      ])]));
      const tb = el("tbody");
      for (const m of mismatches) {
        const delta = Number(m.submitted) - Number(m.expected);
        const sign = delta > 0 ? "+" : "";
        tb.appendChild(el("tr", {}, [
          el("td", {}, m.handle),
          el("td", {}, `$${Number(m.expected).toFixed(2)}`),
          el("td", {}, `$${Number(m.submitted).toFixed(2)}`),
          el("td", { style: { color: delta < 0 ? "#b91c1c" : "#065f46" } },
            `${sign}$${delta.toFixed(2)}`)
        ]));
      }
      list.appendChild(tb);
      banner.appendChild(list);
      if (!isReadOnly) {
        const btnRow = el("div", { class: "row" });
        btnRow.appendChild(el("button", { class: "primary",
          onclick: () => resolveMismatches("snapshot") }, "Use my original prices"));
        btnRow.appendChild(el("button", {
          onclick: () => resolveMismatches("customer") }, "Accept customer prices"));
        banner.appendChild(btnRow);
      }
      wrap.appendChild(banner);
    } else if (o.export_token) {
      wrap.appendChild(el("p", { class: "muted", style: { marginTop: "8px" } },
        `Verified against original export ${o.export_token}.`));
    }

    // Items table — editable spreadsheet grid
    const itemsBox = el("div", { class: "box" });
    const itemsHeader = el("div", { class: "row", style: { marginBottom: "8px" } });
    itemsHeader.appendChild(el("h3", { style: { margin: 0 } }, "Items"));

    if (hasPreview) {
      const rep = state.previewSnapshot.report;
      const ranAt = state.previewSnapshot.ranAt
        ? new Date(state.previewSnapshot.ranAt).toLocaleString() : "";
      const summaryParts = [
        `Requested: ${rep.requestedUnits}`,
        `Allocated: ${rep.allocatedUnits}`,
        rep.droppedUnits > 0 ? `⚠ Short: ${rep.droppedUnits}` : null
      ].filter(Boolean);
      const summaryEl = el("span", {
        style: { fontSize: "13px", color: rep.droppedUnits > 0 ? "#d97706" : "#2a6e2a" }
      }, `Preview ${ranAt} — ${summaryParts.join(" · ")}`);
      itemsHeader.appendChild(summaryEl);
    }
    itemsBox.appendChild(itemsHeader);

    // Only show items that have at least one non-zero quantity ordered.
    const items = (Array.isArray(o.items) ? o.items : []).filter((it) => {
      const sq = it.size_qty || it.sizeQty || {};
      return SIZES.some((s) => Number(sq[s] || 0) > 0);
    });

    if (!items.length) {
      itemsBox.appendChild(el("p", { class: "muted" }, "No items yet. Drafts created from a customer's filled order form will land here automatically."));
    } else {
      if (hasPreview) {
        itemsBox.appendChild(el("p", {
          style: { fontSize: "12px", color: "#777", marginBottom: "6px", marginTop: "0" }
        }, "Each size shows: ordered → [available to fill]. Edit the available column to adjust your order, then re-run the preview."));
      }

      const tbl = el("table", { style: { borderCollapse: "collapse" } });
      const headerRow = el("tr", {}, [
        el("th", { style: { textAlign: "left" } }, "Product"),
        el("th", { style: { textAlign: "left" } }, "Wholesale"),
        ...SIZES.map((s) => el("th", { style: { textAlign: "center", minWidth: hasPreview ? "90px" : "52px" } }, s)),
        el("th", {}, "Total"),
        el("th", {}, "")
      ]);
      tbl.appendChild(el("thead", {}, [headerRow]));

      const tbody = el("tbody");
      let grand = 0;

      for (let idx = 0; idx < items.length; idx++) {
        const it = items[idx];
        // Find matching entry in state.current.items so in-memory edits go to the right slot.
        const liveItem = (state.current.items || []).find((x) => x.handle === it.handle) || it;
        const sq = liveItem.size_qty || liveItem.sizeQty || {};
        let rowTotal = 0;

        // Product name: prefer stored product_name, then metaByHandle from snapshot, then handle
        const productName = it.product_name ||
          state.previewSnapshot?.metaByHandle?.[it.handle]?.title || "";
        const nameCell = el("td", { style: { paddingRight: "12px", verticalAlign: "middle" } });
        if (productName && productName !== it.handle) {
          nameCell.appendChild(el("div", { style: { fontWeight: 500, whiteSpace: "nowrap" } }, productName));
          nameCell.appendChild(el("div", { style: { fontSize: "11px", color: "#999", whiteSpace: "nowrap" } }, it.handle));
        } else {
          nameCell.appendChild(document.createTextNode(it.handle));
        }

        const tds = [
          nameCell,
          el("td", { style: { whiteSpace: "nowrap", paddingRight: "12px", verticalAlign: "middle" } },
            `$${Number(it.unit_price ?? it.unitPrice ?? 0).toFixed(2)}`)
        ];

        for (const s of SIZES) {
          const orderedQty = Number(sq[s] || 0);
          rowTotal += orderedQty;
          grand += orderedQty;

          const cell = el("td", {
            style: { padding: "3px", textAlign: "center", verticalAlign: "middle" }
          });

          if (hasPreview) {
            // Two-part cell: ordered (read-only) → available (editable input)
            const pd = previewMap.get(`${it.handle}:${s}`);
            const allocatedQty = pd ? pd.allocated : (orderedQty > 0 ? 0 : null);

            if (orderedQty === 0 && allocatedQty === null) {
              // Nothing ordered here — blank
            } else {
              const wrapper = el("div", {
                style: { display: "flex", alignItems: "center", justifyContent: "center", gap: "3px" }
              });

              if (orderedQty > 0) {
                wrapper.appendChild(el("span", {
                  style: { fontSize: "13px", color: "#555", minWidth: "18px", textAlign: "right" }
                }, String(orderedQty)));
                wrapper.appendChild(el("span", { style: { color: "#ccc", fontSize: "11px" } }, "→"));
              }

              // Color the available input by fulfillment status
              const avail = allocatedQty ?? 0;
              const borderColor = avail === 0 ? "#fca5a5" : avail < orderedQty ? "#fbbf24" : "#86efac";
              const textColor   = avail === 0 ? "#b91c1c" : avail < orderedQty ? "#b45309" : "#166534";

              const inp = el("input", {
                type: "number", min: "0",
                value: String(avail),
                style: {
                  width: "44px", textAlign: "center",
                  border: `1px solid ${borderColor}`,
                  borderRadius: "3px", padding: "2px 3px",
                  fontSize: "13px", color: textColor
                }
              });
              inp.addEventListener("input", () => {
                const newVal = Math.max(0, parseInt(inp.value, 10) || 0);
                if (!liveItem.size_qty) liveItem.size_qty = {};
                liveItem.size_qty[s] = newVal;
              });
              inp.addEventListener("blur", () => {
                saveCurrent({ items: state.current.items });
              });

              wrapper.appendChild(inp);
              cell.appendChild(wrapper);
            }
          } else if (isReadOnly) {
            cell.appendChild(document.createTextNode(orderedQty ? String(orderedQty) : ""));
          } else {
            // No preview yet — single editable input
            const inp = el("input", {
              type: "number", min: "0",
              value: orderedQty > 0 ? String(orderedQty) : "",
              style: {
                width: "48px", textAlign: "center",
                border: "1px solid #d0d0d0",
                borderRadius: "3px", padding: "2px 4px",
                fontSize: "13px"
              }
            });
            inp.addEventListener("input", () => {
              const newVal = Math.max(0, parseInt(inp.value, 10) || 0);
              if (!liveItem.size_qty) liveItem.size_qty = {};
              liveItem.size_qty[s] = newVal;
            });
            inp.addEventListener("blur", () => {
              saveCurrent({ items: state.current.items });
            });
            cell.appendChild(inp);
          }

          tds.push(cell);
        }

        tds.push(el("td", {
          style: { textAlign: "right", paddingLeft: "8px", fontWeight: 500, verticalAlign: "middle", whiteSpace: "nowrap" }
        }, String(rowTotal)));

        // Delete row button
        if (!isReadOnly) {
          const delBtn = el("button", {
            style: { padding: "0 5px", fontSize: "12px", lineHeight: "18px", marginLeft: "4px" },
            onclick: () => {
              state.current.items = (state.current.items || []).filter((x) => x.handle !== it.handle);
              saveCurrent({ items: state.current.items });
            }
          }, "×");
          tds.push(el("td", { style: { verticalAlign: "middle" } }, [delBtn]));
        } else {
          tds.push(el("td", {}, ""));
        }

        tbody.appendChild(el("tr", {}, tds));
      }

      // Grand total row
      tbody.appendChild(el("tr", {
        style: { borderTop: "2px solid #ccc" }
      }, [
        el("td", { colspan: "2", style: { textAlign: "right", fontWeight: 600, paddingRight: "8px" } }, "Total units"),
        ...SIZES.map(() => el("td", {}, "")),
        el("td", { style: { fontWeight: 600, textAlign: "right", paddingLeft: "6px" } }, String(grand)),
        el("td", {}, "")
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

    // Print button — available as long as there are items, whether or not preview has run.
    if (items.length > 0) {
      const printBtn = el("button", {
        style: { marginLeft: "auto" },
        onclick: () => window.open(`/api/orders-draft/${o.id}/draft-order.pdf`, "_blank")
      }, hasPreview ? "Print Order Confirmation" : "Print Draft Order");
      actions.appendChild(printBtn);
    }

    wrap.appendChild(actions);

    // Preview history (compact)
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
