// Line sheets list page (Screen 1): saved filters + line sheets.
(function () {
  const w = window;
  w.LineSheets = w.LineSheets || {};

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

  function fmtDate(iso) {
    if (!iso) return "";
    try { return new Date(iso).toLocaleString(); } catch { return String(iso); }
  }

  async function show() {
    document.getElementById("lsListRoot").style.display = "";
    document.getElementById("lsEditorRoot").style.display = "none";
    await render();
  }

  async function hide() {
    document.getElementById("lsListRoot").style.display = "none";
    document.getElementById("lsEditorRoot").style.display = "";
  }

  async function render() {
    const root = document.getElementById("lsListRoot");
    root.innerHTML = "<div class=\"muted\">Loading…</div>";

    let savedFilters = [];
    let sheets = [];
    try {
      const [r1, r2] = await Promise.all([
        fetch("/api/saved-filters").then(r => r.ok ? r.json() : { saved_filters: [] }),
        fetch("/api/linesheets").then(r => r.ok ? r.json() : { linesheets: [] })
      ]);
      savedFilters = r1.saved_filters || [];
      sheets = r2.linesheets || [];
    } catch (err) {
      root.innerHTML = `<div class="muted">Error loading: ${String(err.message || err)}</div>`;
      return;
    }

    root.innerHTML = "";

    // Saved filters
    const sfBox = el("div", { class: "box" });
    sfBox.appendChild(el("div", { class: "row", style: "justify-content:space-between;" }, [
      el("h3", { style: "margin:0;" }, "Saved filters"),
      el("button", { class: "primary", onclick: () => newSavedFilter() }, "+ New saved filter")
    ]));
    if (savedFilters.length === 0) {
      sfBox.appendChild(el("div", { class: "muted", style: "padding:8px;" }, "No saved filters yet."));
    } else {
      const tbl = el("table");
      tbl.appendChild(el("thead", null, el("tr", null, [
        el("th", null, "Name"), el("th", null, "Description"),
        el("th", null, "Line sheets"), el("th", null, "Updated"), el("th", null, "")
      ])));
      const tb = document.createElement("tbody");
      for (const sf of savedFilters) {
        const tr = el("tr", null, [
          el("td", null, el("b", null, sf.name)),
          el("td", null, sf.description || ""),
          el("td", null, String(sf.line_sheet_count || 0)),
          el("td", null, fmtDate(sf.updated_at)),
          el("td", null, [
            el("button", { onclick: async () => { await hide(); w.LineSheets.openEditor(null, { savedFilter: sf }); } }, "Use in new"),
            el("button", { style: "margin-left:4px;", onclick: () => renameSavedFilter(sf) }, "Rename"),
            el("button", {
              style: "margin-left:4px;",
              onclick: async () => {
                if (!confirm(`Delete saved filter "${sf.name}"?`)) return;
                let r = await fetch(`/api/saved-filters/${sf.id}`, { method: "DELETE" });
                if (r.status === 409) {
                  const j = await r.json();
                  if (!confirm(j.error + " Delete anyway?")) return;
                  r = await fetch(`/api/saved-filters/${sf.id}?force=1`, { method: "DELETE" });
                }
                if (!r.ok) return alert("Delete failed: " + (await r.text()));
                render();
              }
            }, "Delete")
          ])
        ]);
        tb.appendChild(tr);
      }
      tbl.appendChild(tb);
      sfBox.appendChild(tbl);
    }
    root.appendChild(sfBox);

    // Line sheets
    const lsBox = el("div", { class: "box", style: "margin-top:12px;" });
    const searchInp = el("input", { type: "text", placeholder: "Search by name or customer", style: "width:280px;" });
    searchInp.addEventListener("input", debounced(async () => {
      const q = searchInp.value.trim();
      const r = await fetch("/api/linesheets?q=" + encodeURIComponent(q));
      if (!r.ok) return;
      const j = await r.json();
      renderLsTable(body, j.linesheets || []);
    }, 200));

    lsBox.appendChild(el("div", { class: "row", style: "justify-content:space-between; align-items:center;" }, [
      el("div", null, [el("h3", { style: "display:inline; margin-right:12px;" }, "Line sheets"), searchInp]),
      el("button", { class: "primary", onclick: () => newLineSheetDialog(savedFilters) }, "+ New line sheet")
    ]));

    const body = el("div");
    renderLsTable(body, sheets);
    lsBox.appendChild(body);
    root.appendChild(lsBox);
  }

  function renderLsTable(root, sheets) {
    root.innerHTML = "";
    if (sheets.length === 0) {
      root.appendChild(el("div", { class: "muted", style: "padding:8px;" }, "No line sheets yet."));
      return;
    }
    const tbl = el("table");
    tbl.appendChild(el("thead", null, el("tr", null, [
      el("th", null, "Name"), el("th", null, "Customer"),
      el("th", null, "Filter"), el("th", null, "Updated"), el("th", null, "")
    ])));
    const tb = document.createElement("tbody");
    for (const s of sheets) {
      const tr = el("tr", null, [
        el("td", null, el("b", null, s.name)),
        el("td", null, s.customer || ""),
        el("td", null, s.saved_filter_name ? el("span", { class: "pill" }, s.saved_filter_name) : el("span", { class: "muted" }, "(ad-hoc)")),
        el("td", null, fmtDate(s.updated_at)),
        el("td", null, [
          el("button", { onclick: () => w.LineSheets.openEditorById(s.id) }, "Edit"),
          el("button", {
            style: "margin-left:4px;",
            onclick: async () => {
              const r = await fetch(`/api/linesheets/${s.id}/duplicate`, { method: "POST" });
              if (!r.ok) return alert("Duplicate failed");
              render();
            }
          }, "Duplicate"),
          el("button", {
            style: "margin-left:4px;",
            onclick: () => window.open(`/api/linesheets/${s.id}/render.pdf`, "_blank")
          }, "PDF"),
          el("button", {
            style: "margin-left:4px;",
            onclick: async () => {
              if (!confirm(`Archive "${s.name}"?`)) return;
              const r = await fetch(`/api/linesheets/${s.id}`, { method: "DELETE" });
              if (!r.ok) return alert("Archive failed");
              render();
            }
          }, "Archive")
        ])
      ]);
      tb.appendChild(tr);
    }
    tbl.appendChild(tb);
    root.appendChild(tbl);
  }

  async function newSavedFilter() {
    const name = prompt("Saved filter name (e.g. 'S26FP'):");
    if (!name) return;
    const r = await fetch("/api/saved-filters", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, filter_tree: { include: [], globals: [] } })
    });
    if (!r.ok) return alert("Failed: " + (await r.text()));
    render();
  }

  async function renameSavedFilter(sf) {
    const name = prompt("New name:", sf.name);
    if (!name || name === sf.name) return;
    const r = await fetch(`/api/saved-filters/${sf.id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name })
    });
    if (!r.ok) return alert("Failed: " + (await r.text()));
    render();
  }

  function newLineSheetDialog(savedFilters) {
    const overlay = el("div", { style: "position:fixed;inset:0;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;z-index:2000;" });
    const card = el("div", { style: "background:#fff;padding:20px;border-radius:10px;min-width:360px;" });
    card.appendChild(el("h3", { style: "margin-top:0;" }, "New line sheet"));
    card.appendChild(el("div", { class: "muted", style: "margin-bottom:12px;" }, "Start from a saved filter or from scratch."));
    const sel = el("select", { style: "width:100%;padding:6px;margin-bottom:12px;" },
      [el("option", { value: "" }, "— Start from scratch —")].concat(savedFilters.map(sf => el("option", { value: sf.id }, sf.name)))
    );
    card.appendChild(sel);
    const row = el("div", { class: "row" });
    row.appendChild(el("button", { onclick: () => document.body.removeChild(overlay) }, "Cancel"));
    row.appendChild(el("button", {
      class: "primary",
      style: "margin-left:auto;",
      onclick: async () => {
        const sf = savedFilters.find(x => String(x.id) === sel.value);
        document.body.removeChild(overlay);
        await hide();
        w.LineSheets.openEditor(null, sf ? { savedFilter: sf } : {});
      }
    }, "Create"));
    card.appendChild(row);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
  }

  function debounced(fn, ms) {
    let t; return function (...a) { clearTimeout(t); t = setTimeout(() => fn.apply(this, a), ms); };
  }

  w.LineSheets.showList = show;
  w.LineSheets.refreshList = render;
  w.LineSheets.openEditorById = async function (id) { await hide(); await w.LineSheets.openEditor(id); };
})();
