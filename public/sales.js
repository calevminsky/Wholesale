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

  // This dashboard is read-only. The plan (goal + monthly targets) is edited in
  // the password-gated admin page at /admin/sales-plan.

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
    return el("div", {}, [
      el("div", { style: { display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "stretch" } }, [
        kpi(`FY${d.fiscal_year} annual goal`, money(d.annual_goal)),
        kpi("Booked YTD", money(t.booked_ytd), `${pct(t.attainment_to_goal)} of goal`),
        kpi("Remaining to goal", money(t.remaining_to_goal), `${t.open_periods} months left`),
        kpi("Pace needed", money(t.avg_needed_per_open_period) + "/mo", money(t.avg_needed_per_open_week) + "/wk to close")
      ]),
      el("div", { class: "muted", style: { fontSize: "12px", marginTop: "8px" } }, [
        `Actuals from yb_reports${d.as_of ? `, through ${d.as_of}` : ""}. `,
        el("span", { class: "pill", style: { fontSize: "11px" } }, "shopify_sales_daily · total_wholesale")
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
      const deltaColor = p.delta >= 0 ? "#1a7f37" : "#b42318";
      return el("tr", { style: { background: rowBg[p.status] || "#fff" } }, [
        el("td", {}, [
          el("strong", {}, p.label),
          p.status === "current" ? el("span", { class: "pill", style: { marginLeft: "6px", fontSize: "10px" } }, "current") : null
        ]),
        el("td", { class: "muted", style: { fontSize: "12px" } }, `${p.starts_on.slice(5)} – ${p.ends_on.slice(5)} · ${p.weeks}w`),
        el("td", { class: "num", style: { fontVariantNumeric: "tabular-nums" } }, money(p.target)),
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
      el("h3", { style: { margin: "0 0 8px 0" } }, "Monthly plan vs. actual"),
      el("div", { class: "order-table-wrap" }, [
        el("table", {}, [el("thead", {}, head), el("tbody", {}, [...trs, totalRow])])
      ]),
      el("div", { class: "muted", style: { fontSize: "12px", marginTop: "6px" } },
        "Read-only. Closed months are locked to actuals; the rest of the goal is spread across open months by selling weeks. The goal and targets are edited in the gated admin page.")
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
      el("div", { class: "muted", style: { fontSize: "12px", marginTop: "6px" } },
        "From order_lines (is_wholesale), net of returns — names from the customers table where the email matches, otherwise the order email. Totals can differ slightly from the headline rollup.")
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
        el("div", { class: "muted", style: { marginTop: "6px", fontSize: "12px" } }, "Actuals read from the yb_reports DB (shopify_sales_daily, order_lines, fiscal_calendar). Check REPORTING_DATABASE_URL is set and those tables are populated.")
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
