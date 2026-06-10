// Sales Plan dashboard: a 4-5-4 monthly plan vs. live Shopify wholesale actuals.
// Mounted into #salesPage. Actuals come from Shopify (orders tagged "Wholesale");
// the plan/targets are stored locally and editable here.
(function () {
  const root = document.getElementById("salesPage");
  if (!root) return;

  const state = { fy: 2026, data: null, loading: false, error: null, busy: false };

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
      if (c == null || c === false) continue;
      node.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
    }
    return node;
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || json.detail || `HTTP ${res.status}`);
    return json;
  }

  const money = (n) => "$" + Math.round(Number(n) || 0).toLocaleString();
  const pct = (n) => (n == null ? "—" : Math.round(n * 100) + "%");

  async function load() {
    state.loading = true; state.error = null; render();
    try {
      state.data = await api(`/api/sales/plan?fy=${state.fy}`);
    } catch (e) {
      state.error = e.message;
    } finally {
      state.loading = false; render();
    }
  }

  async function saveTarget(period_index, target_amount) {
    state.busy = true; render();
    try {
      await api(`/api/sales/plan/target?fy=${state.fy}`, {
        method: "PUT",
        body: JSON.stringify({ period_index, target_amount })
      });
      await load();
    } catch (e) { alert("Could not save target: " + e.message); }
    finally { state.busy = false; }
  }

  async function saveGoal(annual_goal) {
    state.busy = true; render();
    try {
      await api(`/api/sales/plan/goal?fy=${state.fy}`, {
        method: "PUT", body: JSON.stringify({ annual_goal })
      });
      await load();
    } catch (e) { alert("Could not save goal: " + e.message); }
    finally { state.busy = false; }
  }

  async function reseed() {
    if (!confirm("Rebuild the monthly targets from the annual goal?\n\nClosed months get locked to what actually sold; the remaining goal is spread across the open months by selling weeks. This overwrites your current targets.")) return;
    state.busy = true; render();
    try {
      await api(`/api/sales/plan/reseed?fy=${state.fy}`, { method: "POST", body: "{}" });
      await load();
    } catch (e) { alert("Could not rebuild plan: " + e.message); }
    finally { state.busy = false; }
  }

  // ---- KPI header ----
  function kpi(label, value, sub) {
    return el("div", { style: { flex: "1", minWidth: "150px", border: "1px solid #eee", borderRadius: "10px", padding: "12px 14px", background: "#fff" } }, [
      el("div", { class: "muted", style: { fontSize: "12px" } }, label),
      el("div", { style: { fontSize: "22px", fontWeight: "700", margin: "2px 0" } }, value),
      sub ? el("div", { class: "muted", style: { fontSize: "12px" } }, sub) : null
    ]);
  }

  function renderHeader(d) {
    const t = d.totals;
    const goalInput = el("input", {
      type: "number", value: d.annual_goal, step: "1000",
      style: { width: "120px", fontSize: "20px", fontWeight: "700", border: "1px solid #ccc", borderRadius: "6px", padding: "2px 6px" },
      onchange: (e) => saveGoal(Number(e.target.value))
    });
    return el("div", {}, [
      el("div", { style: { display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "stretch" } }, [
        el("div", { style: { flex: "1", minWidth: "170px", border: "1px solid #eee", borderRadius: "10px", padding: "12px 14px", background: "#fff" } }, [
          el("div", { class: "muted", style: { fontSize: "12px" } }, `FY${d.fiscal_year} annual goal`),
          el("div", { style: { display: "flex", alignItems: "center", gap: "4px", margin: "2px 0" } }, [el("span", { style: { fontSize: "20px", fontWeight: "700" } }, "$"), goalInput])
        ]),
        kpi("Booked YTD", money(t.booked_ytd), `${pct(t.attainment_to_goal)} of goal`),
        kpi("Remaining to goal", money(t.remaining_to_goal), `${t.open_periods} months left`),
        kpi("Pace needed", money(t.avg_needed_per_open_period) + "/mo", money(t.avg_needed_per_open_week) + "/wk to close")
      ]),
      el("div", { class: "muted", style: { fontSize: "12px", marginTop: "8px" } }, [
        `Actuals: Shopify orders tagged “Wholesale”, as of ${d.as_of}. `,
        el("span", { class: "pill", style: { fontSize: "11px" } }, d.source === "shopifyql" ? "Shopify Analytics (total sales)" : "Order subtotals (fallback)"),
        d.source !== "shopifyql" ? " — ShopifyQL unavailable; showing merchandise subtotals, which can differ slightly from Analytics." : ""
      ])
    ]);
  }

  // ---- Plan vs actual table ----
  function bar(actual, target) {
    const ratio = target > 0 ? Math.min(actual / target, 1.5) : 0;
    const w = Math.min(ratio, 1) * 100;
    const over = ratio >= 1;
    return el("div", { style: { background: "#f0f0f0", borderRadius: "4px", height: "10px", width: "90px", overflow: "hidden" } }, [
      el("div", { style: { height: "10px", width: w + "%", background: over ? "#1a7f37" : "#3b82f6" } })
    ]);
  }

  function renderPlanTable(d) {
    const rowBg = { closed: "#fafafa", current: "#fff7e6", future: "#fff" };
    const trs = d.periods.map((p) => {
      const targetInput = el("input", {
        type: "number", value: p.target, step: "500",
        style: { width: "90px", textAlign: "right", border: "1px solid #ddd", borderRadius: "6px", padding: "2px 6px", fontVariantNumeric: "tabular-nums" },
        onchange: (e) => saveTarget(p.period_index, Number(e.target.value))
      });
      const deltaColor = p.delta >= 0 ? "#1a7f37" : "#b42318";
      return el("tr", { style: { background: rowBg[p.status] || "#fff" } }, [
        el("td", {}, [
          el("strong", {}, p.label),
          p.status === "current" ? el("span", { class: "pill", style: { marginLeft: "6px", fontSize: "10px" } }, "current") : null
        ]),
        el("td", { class: "muted", style: { fontSize: "12px" } }, `${p.starts_on.slice(5)} – ${p.ends_on.slice(5)} · ${p.weeks}w`),
        el("td", { class: "num" }, targetInput),
        el("td", { class: "num", style: { fontVariantNumeric: "tabular-nums" } }, money(p.actual)),
        el("td", { class: "num", style: { color: deltaColor, fontVariantNumeric: "tabular-nums" } }, (p.delta >= 0 ? "+" : "") + money(p.delta)),
        el("td", { class: "num" }, p.status === "future" ? "—" : pct(p.attainment)),
        el("td", {}, p.status === "future" ? null : bar(p.actual, p.target))
      ]);
    });

    const tot = d.totals;
    const totalRow = el("tr", { style: { borderTop: "2px solid #ddd", fontWeight: "700" } }, [
      el("td", {}, "Total"),
      el("td", { class: "muted", style: { fontSize: "12px" } }, "FY" + d.fiscal_year),
      el("td", { class: "num" }, money(tot.planned_total)),
      el("td", { class: "num" }, money(tot.booked_ytd)),
      el("td", { class: "num", style: { color: tot.booked_ytd - tot.planned_total >= 0 ? "#1a7f37" : "#b42318" } }, money(tot.booked_ytd - tot.planned_total)),
      el("td", { class: "num" }, pct(tot.attainment_to_goal)),
      el("td", {})
    ]);

    const head = el("tr", {}, ["Month", "Period (4-5-4)", "Target", "Actual", "Δ", "Att.", ""]
      .map((h, i) => el("th", { class: i >= 2 && i <= 5 ? "num" : "", style: { textAlign: i >= 2 && i <= 5 ? "right" : "left", borderBottom: "1px solid #eee", padding: "6px 8px", fontSize: "12px" } }, h)));

    return el("div", { class: "box" }, [
      el("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" } }, [
        el("h3", { style: { margin: 0 } }, "Monthly plan vs. actual"),
        el("button", { class: "app-tab", onclick: reseed, disabled: state.busy ? "" : null }, "Rebuild plan to hit goal")
      ]),
      el("div", { class: "order-table-wrap" }, [
        el("table", {}, [el("thead", {}, head), el("tbody", {}, [...trs, totalRow])])
      ]),
      el("div", { class: "muted", style: { fontSize: "12px", marginTop: "6px" } },
        "Targets are editable — type a new number to override. “Rebuild plan” locks closed months to actuals and spreads the rest of the goal across open months by selling weeks.")
    ]);
  }

  // ---- By vendor ----
  function renderVendors(d) {
    const total = d.by_vendor.reduce((s, v) => s + v.sales, 0) || 1;
    const trs = d.by_vendor.map((v) => el("tr", {}, [
      el("td", {}, v.name),
      el("td", { class: "num" }, v.orders),
      el("td", { class: "num", style: { fontVariantNumeric: "tabular-nums" } }, money(v.sales)),
      el("td", { class: "num" }, pct(v.sales / total))
    ]));
    const head = el("tr", {}, ["Vendor", "Orders", "Sales", "% of total"]
      .map((h, i) => el("th", { style: { textAlign: i === 0 ? "left" : "right", borderBottom: "1px solid #eee", padding: "6px 8px", fontSize: "12px" } }, h)));
    return el("div", { class: "box" }, [
      el("h3", { style: { marginTop: 0 } }, `By vendor · FY${d.fiscal_year} to date`),
      el("div", { class: "order-table-wrap" }, [el("table", {}, [el("thead", {}, head), el("tbody", {}, trs)])]),
      d.by_vendor.some((v) => v.name === "(unattributed)")
        ? el("div", { class: "muted", style: { fontSize: "12px", marginTop: "6px" } }, "“(unattributed)” = wholesale-tagged orders with no customer on file in Shopify.")
        : null
    ]);
  }

  function render() {
    root.innerHTML = "";
    if (state.loading && !state.data) {
      root.appendChild(el("div", { class: "muted", style: { padding: "20px" } }, "Loading sales plan…"));
      return;
    }
    if (state.error) {
      root.appendChild(el("div", { class: "box", style: { borderColor: "#f3c2c2", background: "#fff5f5" } }, [
        el("strong", {}, "Couldn’t load sales data. "), state.error,
        el("div", { class: "muted", style: { marginTop: "6px", fontSize: "12px" } }, "Actuals read from Shopify. If this mentions read_reports/permissions, the app token may need the read_reports scope (it then falls back to order subtotals).")
      ]));
      return;
    }
    const d = state.data;
    if (!d) return;
    root.appendChild(el("div", {}, [
      el("h2", { style: { margin: "0 0 4px 0" } }, "Wholesale Sales Plan"),
      renderHeader(d),
      el("div", { style: { height: "14px" } }),
      renderPlanTable(d),
      renderVendors(d)
    ]));
  }

  window.SalesPage = { show: async () => { await load(); } };
})();
