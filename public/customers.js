// Customers admin: list, create, edit. Each account carries a primary contact
// (CRM-lite — activity tracking can roll in later). Mounted into #customersPage.
(function () {
  const root = document.getElementById("customersPage");
  if (!root) return;

  const state = { customers: [], editing: null, loading: false, search: "" };

  const TIERS = ["", "Full Price", "Off Price"];

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
      const q = state.search.trim();
      const { customers } = await api("/api/customers" + (q ? `?q=${encodeURIComponent(q)}` : ""));
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
      price_tier: "",
      yb_print_label: false,
      discount_pct_off_msrp: "",
      shipping_address: { name: "", address1: "", address2: "", city: "", state: "", zip: "", country: "" },
      notes: "",
      contact: { id: null, name: "", role: "", email: "", phone: "" }
    };
  }

  // Pull the full record (with contacts) before editing so we can edit the contact.
  async function startEdit(c) {
    if (!c) { state.editing = emptyForm(); return render(); }
    let full = c;
    try {
      const r = await api(`/api/customers/${c.id}`);
      full = r.customer || c;
    } catch (_) { /* fall back to list row */ }
    const primary = (full.contacts || []).find((x) => x.is_primary) || (full.contacts || [])[0] || null;
    state.editing = {
      id: full.id,
      name: full.name || "",
      email: full.email || "",
      phone: full.phone || "",
      price_tier: full.price_tier || "",
      yb_print_label: Boolean(full.yb_print_label),
      discount_pct_off_msrp: full.discount_pct_off_msrp ?? "",
      shipping_address: { name: "", address1: "", address2: "", city: "", state: "", zip: "", country: "", ...(full.shipping_address || {}) },
      notes: full.notes || "",
      contact: primary
        ? { id: primary.id, name: primary.name || "", role: primary.role || "", email: primary.email || "", phone: primary.phone || "" }
        : { id: null, name: "", role: "", email: "", phone: "" }
    };
    render();
  }

  async function save() {
    const f = state.editing;
    const body = {
      name: f.name.trim(),
      email: f.email.trim() || null,
      phone: f.phone.trim() || null,
      price_tier: f.price_tier || null,
      yb_print_label: f.yb_print_label,
      discount_pct_off_msrp: f.discount_pct_off_msrp === "" ? null : Number(f.discount_pct_off_msrp),
      shipping_address: cleanAddress(f.shipping_address),
      notes: f.notes.trim() || null
    };
    if (!body.name) return alert("Name is required.");
    try {
      let customerId = f.id;
      if (customerId) {
        await api(`/api/customers/${customerId}`, { method: "PUT", body: JSON.stringify(body) });
      } else {
        const r = await api("/api/customers", { method: "POST", body: JSON.stringify(body) });
        customerId = r.customer.id;
      }
      await saveContact(customerId, f.contact);
      state.editing = null;
      await loadList();
    } catch (e) {
      alert("Save failed: " + e.message);
    }
  }

  // Upsert the single primary contact. Empty name => leave/clear nothing.
  async function saveContact(customerId, c) {
    const name = (c.name || "").trim();
    const payload = {
      name,
      role: (c.role || "").trim() || null,
      email: (c.email || "").trim() || null,
      phone: (c.phone || "").trim() || null,
      is_primary: true
    };
    if (c.id) {
      if (!name) return; // don't blank out an existing contact's required name
      await api(`/api/contacts/${c.id}`, { method: "PUT", body: JSON.stringify(payload) });
    } else if (name) {
      await api(`/api/customers/${customerId}/contacts`, { method: "POST", body: JSON.stringify(payload) });
    }
  }

  function cleanAddress(a) {
    const out = {};
    for (const [k, v] of Object.entries(a || {})) {
      const s = (v == null ? "" : String(v)).trim();
      if (s) out[k] = s;
    }
    return out;
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

  function tierBadge(t) {
    if (!t) return el("span", { class: "muted" }, "—");
    const off = /off/i.test(t);
    return el("span", {
      style: {
        display: "inline-block", padding: "2px 8px", borderRadius: "999px", fontSize: "12px",
        background: off ? "#fdecec" : "#e7f6e7", color: off ? "#a12a2a" : "#2a6e2a"
      }
    }, t);
  }

  function renderList() {
    const wrap = el("div");
    wrap.appendChild(el("div", { class: "row" }, [
      el("h2", { style: { margin: 0 } }, "Customers"),
      el("span", { class: "muted" }, `${state.customers.length} shown`),
      el("button", { class: "primary", style: { marginLeft: "auto" }, onclick: () => startEdit(null) }, "+ New Customer")
    ]));

    const searchInp = el("input", { type: "search", placeholder: "Search name or email…", value: state.search, style: { maxWidth: "320px" } });
    let t;
    searchInp.addEventListener("input", (e) => {
      state.search = e.target.value;
      clearTimeout(t);
      t = setTimeout(loadList, 200);
    });
    wrap.appendChild(el("div", { class: "row", style: { marginTop: "8px" } }, [searchInp]));

    if (state.loading) {
      wrap.appendChild(el("p", { class: "muted" }, "Loading…"));
      return wrap;
    }
    if (!state.customers.length) {
      wrap.appendChild(el("p", { class: "muted" }, state.search ? "No matches." : "No customers yet."));
      return wrap;
    }

    const table = el("table");
    const thead = el("thead", {}, [el("tr", {}, [
      el("th", {}, "Account"),
      el("th", {}, "Primary Contact"),
      el("th", {}, "Email"),
      el("th", {}, "Phone"),
      el("th", {}, "Tier"),
      el("th", {}, "")
    ])]);
    const tbody = el("tbody");
    for (const c of state.customers) {
      const pc = c.primary_contact;
      tbody.appendChild(el("tr", {}, [
        el("td", {}, c.name),
        el("td", {}, pc ? el("span", {}, [pc.name, pc.role ? el("span", { class: "muted" }, ` · ${pc.role}`) : null]) : el("span", { class: "muted" }, "—")),
        el("td", {}, c.email || (pc && pc.email) || ""),
        el("td", {}, c.phone || (pc && pc.phone) || ""),
        el("td", {}, tierBadge(c.price_tier)),
        el("td", { style: { textAlign: "right", whiteSpace: "nowrap" } }, [
          el("button", { onclick: () => startEdit(c) }, "Edit"),
          " ",
          el("button", { onclick: () => archive(c) }, "Archive")
        ])
      ]));
    }
    table.appendChild(thead);
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }

  function renderForm() {
    const f = state.editing;
    const wrap = el("div", { class: "box", style: { maxWidth: "680px" } });
    wrap.appendChild(el("h2", { style: { marginTop: 0 } }, f.id ? "Edit Customer" : "New Customer"));

    const fld = (label, input) => el("div", { class: "row" }, [
      el("label", { style: { width: "160px", fontWeight: 600 } }, label),
      input
    ]);

    const bind = (obj, key, attrs = {}) => {
      const inp = el("input", { type: "text", value: obj[key] ?? "", ...attrs });
      inp.addEventListener("input", (e) => obj[key] = e.target.value);
      return inp;
    };

    // Account
    wrap.appendChild(fld("Account Name *", bind(f, "name")));
    wrap.appendChild(fld("Account Email", bind(f, "email")));
    wrap.appendChild(fld("Account Phone", bind(f, "phone")));

    const tierSel = el("select", {}, TIERS.map((t) =>
      el("option", { value: t, ...(t === f.price_tier ? { selected: "selected" } : {}) }, t || "—")));
    tierSel.addEventListener("change", (e) => f.price_tier = e.target.value);
    wrap.appendChild(fld("Price Tier", tierSel));

    const printChk = el("input", { type: "checkbox" });
    printChk.checked = Boolean(f.yb_print_label);
    printChk.addEventListener("change", (e) => f.yb_print_label = e.target.checked);
    wrap.appendChild(fld("YB Print Label?", el("label", { style: { display: "flex", alignItems: "center", gap: "6px", fontWeight: 400 } }, [printChk, "Print the YB label for this account"])));

    const tierPct = el("input", { type: "number", min: "0", max: "100", step: "1", value: f.discount_pct_off_msrp, style: { width: "100px" } });
    tierPct.addEventListener("input", (e) => f.discount_pct_off_msrp = e.target.value);
    wrap.appendChild(fld("% off MSRP", el("div", {}, [tierPct, el("span", { class: "muted", style: { marginLeft: "8px" } }, "Default for new line sheets; overridable per product.")])));

    // Primary contact
    wrap.appendChild(el("h3", { style: { margin: "18px 0 6px" } }, "Primary Contact"));
    wrap.appendChild(fld("Name", bind(f.contact, "name")));
    wrap.appendChild(fld("Role", bind(f.contact, "role", { placeholder: "Buyer, Owner…" })));
    wrap.appendChild(fld("Email", bind(f.contact, "email")));
    wrap.appendChild(fld("Phone", bind(f.contact, "phone")));

    // Shipping address
    wrap.appendChild(el("h3", { style: { margin: "18px 0 6px" } }, "Shipping Address"));
    wrap.appendChild(fld("Ship-to Name", bind(f.shipping_address, "name")));
    wrap.appendChild(fld("Address 1", bind(f.shipping_address, "address1")));
    wrap.appendChild(fld("Address 2", bind(f.shipping_address, "address2")));
    wrap.appendChild(fld("City", bind(f.shipping_address, "city")));
    wrap.appendChild(fld("State", bind(f.shipping_address, "state", { style: { width: "100px" } })));
    wrap.appendChild(fld("Zip", bind(f.shipping_address, "zip", { style: { width: "120px" } })));
    wrap.appendChild(fld("Country", bind(f.shipping_address, "country")));

    // Notes
    const notesInp = el("textarea", {});
    notesInp.value = f.notes;
    notesInp.addEventListener("input", (e) => f.notes = e.target.value);
    wrap.appendChild(el("h3", { style: { margin: "18px 0 6px" } }, "Notes"));
    wrap.appendChild(notesInp);

    wrap.appendChild(el("div", { class: "row", style: { marginTop: "16px" } }, [
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
