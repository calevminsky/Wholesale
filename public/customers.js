// Customers admin: list, create, edit. Mounted into #customersPage.
(function () {
  const root = document.getElementById("customersPage");
  if (!root) return;

  const state = { customers: [], editing: null, loading: false };

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") node.className = v;
      else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v !== undefined && v !== null) node.setAttribute(k, v);
    }
    if (!Array.isArray(children)) children = [children];
    for (const c of children) {
      if (c == null) continue;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return node;
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...opts
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  }

  async function loadList() {
    state.loading = true;
    render();
    try {
      const { customers } = await api("/api/customers");
      state.customers = customers || [];
    } catch (e) {
      alert("Couldn't load customers: " + e.message);
      state.customers = [];
    } finally {
      state.loading = false;
      render();
    }
  }

  function emptyForm() {
    return {
      id: null,
      name: "",
      email: "",
      phone: "",
      discount_pct_off_msrp: "",
      shipping_address: { address1: "", city: "", state: "", zip: "", country: "" },
      notes: ""
    };
  }

  function startEdit(c) {
    state.editing = c
      ? {
          id: c.id,
          name: c.name || "",
          email: c.email || "",
          phone: c.phone || "",
          discount_pct_off_msrp: c.discount_pct_off_msrp ?? "",
          shipping_address: c.shipping_address || {},
          notes: c.notes || ""
        }
      : emptyForm();
    render();
  }

  async function save() {
    const f = state.editing;
    const body = {
      name: f.name.trim(),
      email: f.email.trim() || null,
      phone: f.phone.trim() || null,
      discount_pct_off_msrp: f.discount_pct_off_msrp === "" ? null : Number(f.discount_pct_off_msrp),
      shipping_address: f.shipping_address || {},
      notes: f.notes.trim() || null
    };
    if (!body.name) return alert("Name is required.");
    try {
      if (f.id) {
        await api(`/api/customers/${f.id}`, { method: "PUT", body: JSON.stringify(body) });
      } else {
        await api("/api/customers", { method: "POST", body: JSON.stringify(body) });
      }
      state.editing = null;
      await loadList();
    } catch (e) {
      alert("Save failed: " + e.message);
    }
  }

  async function archive(c) {
    if (!confirm(`Archive customer "${c.name}"? Their existing line sheets and orders stay; new ones can't pick them.`)) return;
    try {
      await api(`/api/customers/${c.id}`, { method: "DELETE" });
      await loadList();
    } catch (e) {
      alert("Archive failed: " + e.message);
    }
  }

  function renderList() {
    const wrap = el("div");
    wrap.appendChild(el("div", { class: "row" }, [
      el("h2", { style: { margin: 0 } }, "Customers"),
      el("button", { class: "primary", onclick: () => startEdit(null) }, "+ New Customer")
    ]));

    if (state.loading) {
      wrap.appendChild(el("p", { class: "muted" }, "Loading…"));
      return wrap;
    }
    if (!state.customers.length) {
      wrap.appendChild(el("p", { class: "muted" }, "No customers yet. Add one to start linking line sheets and orders."));
      return wrap;
    }

    const table = el("table");
    const thead = el("thead", {}, [el("tr", {}, [
      el("th", {}, "Name"),
      el("th", {}, "Email"),
      el("th", {}, "Phone"),
      el("th", {}, "Tier (% off MSRP)"),
      el("th", {}, "")
    ])]);
    const tbody = el("tbody");
    for (const c of state.customers) {
      const row = el("tr", {}, [
        el("td", {}, c.name),
        el("td", {}, c.email || ""),
        el("td", {}, c.phone || ""),
        el("td", {}, c.discount_pct_off_msrp != null ? `${Number(c.discount_pct_off_msrp).toFixed(0)}%` : "—"),
        el("td", { style: { textAlign: "right" } }, [
          el("button", { onclick: () => startEdit(c) }, "Edit"),
          " ",
          el("button", { onclick: () => archive(c) }, "Archive")
        ])
      ]);
      tbody.appendChild(row);
    }
    table.appendChild(thead);
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }

  function renderForm() {
    const f = state.editing;
    const wrap = el("div", { class: "box", style: { maxWidth: "640px" } });
    wrap.appendChild(el("h2", { style: { marginTop: 0 } }, f.id ? "Edit Customer" : "New Customer"));

    const fld = (label, input) => el("div", { class: "row" }, [
      el("label", { style: { width: "180px", fontWeight: 600 } }, label),
      input
    ]);

    const nameInp = el("input", { type: "text", value: f.name });
    nameInp.addEventListener("input", (e) => f.name = e.target.value);

    const emailInp = el("input", { type: "text", value: f.email });
    emailInp.addEventListener("input", (e) => f.email = e.target.value);

    const phoneInp = el("input", { type: "text", value: f.phone });
    phoneInp.addEventListener("input", (e) => f.phone = e.target.value);

    const tierInp = el("input", { type: "number", min: "0", max: "100", step: "1", value: f.discount_pct_off_msrp });
    tierInp.style.width = "100px";
    tierInp.addEventListener("input", (e) => f.discount_pct_off_msrp = e.target.value);

    const notesInp = el("textarea", {});
    notesInp.value = f.notes;
    notesInp.addEventListener("input", (e) => f.notes = e.target.value);

    wrap.appendChild(fld("Name *", nameInp));
    wrap.appendChild(fld("Email", emailInp));
    wrap.appendChild(fld("Phone", phoneInp));
    wrap.appendChild(fld("Tier (% off MSRP)", el("div", {}, [
      tierInp,
      el("span", { class: "muted", style: { marginLeft: "8px" } },
        "Default for new line sheets. You can still override per product.")
    ])));
    wrap.appendChild(fld("Notes", notesInp));

    wrap.appendChild(el("div", { class: "row", style: { marginTop: "12px" } }, [
      el("button", { class: "primary", onclick: save }, "Save"),
      el("button", { onclick: () => { state.editing = null; render(); } }, "Cancel")
    ]));

    return wrap;
  }

  function render() {
    root.innerHTML = "";
    root.appendChild(state.editing ? renderForm() : renderList());
  }

  // Public init.
  window.CustomersPage = {
    show: async () => { await loadList(); render(); }
  };
})();
