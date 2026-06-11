/* Off-price rules admin. Reads the off-tier products from the catalog, lets
   Calev set a default off rule + per-style overrides, saves to off-pricing.json
   (via /api/off-pricing) and rebuilds the catalog (/api/rebuild). */
(() => {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const money = (n) => "$" + Math.round(n).toLocaleString();
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  let MODES = [], rule = { mode: "ride_current", value: 0 }, overrides = {}, OFF = [];
  const needsValue = (m) => m === "pct_off_msrp" || m === "pct_off_current" || m === "fixed";

  // mirror of build/off-pricing.mjs + pricing.js math, whole-dollar (preview only)
  function rulePrice(p) {
    const compare = Number(p.compare_at || 0), cur = Number(p.retail_price || 0);
    switch (rule.mode) {
      case "pct_off_msrp": return Math.round((compare > 0 ? compare : cur) * (1 - rule.value / 100));
      case "pct_off_current": return Math.round((cur > 0 ? cur : compare) * (1 - rule.value / 100));
      case "fixed": return Math.round(rule.value);
      default: return Math.round(cur); // ride_current
    }
  }

  // ---- ETA overrides ----
  let PREORDERS = [], etaOverrides = {};

  function fmtEta(iso) { if (!iso) return ""; const [y, m, d] = iso.split("-"); return `${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][+m-1]} ${+d}, ${y}`; }

  function renderEtaRows() {
    const q = ($("#etaSearch").value || "").toLowerCase();
    const list = PREORDERS.filter((p) => !q || (p.title || "").toLowerCase().includes(q) || (p.color || "").toLowerCase().includes(q));
    const n = Object.keys(etaOverrides).length;
    $("#etaOvrCount").textContent = n ? `${n} override${n === 1 ? "" : "s"} set` : "no overrides";
    $("#etaRows").innerHTML = list.map((p) => {
      const pdEta = p.est_delivery_pd || null; // original from catalog (before override)
      const ov = etaOverrides[p.gid] || "";
      return `<tr data-gid="${p.gid}">
        <td>${p.image ? `<img class="thumb" src="${esc(p.image)}">` : `<div class="thumb"></div>`}</td>
        <td><div class="tname">${esc(p.title)}</div><div class="tcolor">${esc(p.color || "")}</div></td>
        <td class="computed">${pdEta ? fmtEta(pdEta) : `<span class="tbd">TBD</span>`}</td>
        <td><input type="date" class="eta-inp ${ov ? "set" : ""}" data-gid="${p.gid}" value="${ov}"></td>
      </tr>`;
    }).join("");
    $("#etaRows").querySelectorAll(".eta-inp").forEach((inp) => inp.addEventListener("change", onEtaChange));
  }

  function onEtaChange(e) {
    const gid = e.target.dataset.gid;
    const v = e.target.value;
    if (v) etaOverrides[gid] = v; else delete etaOverrides[gid];
    e.target.classList.toggle("set", !!v);
    const n = Object.keys(etaOverrides).length;
    $("#etaOvrCount").textContent = n ? `${n} override${n === 1 ? "" : "s"} set` : "no overrides";
  }

  async function saveEta() {
    const btn = $("#saveEta"), st = $("#etaStatus");
    btn.disabled = true; st.textContent = "Saving…"; st.className = "status";
    try {
      const res = await fetch("/api/eta-overrides", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ overrides: etaOverrides }) });
      const j = await res.json();
      if (!res.ok || !j.ok) { st.textContent = "Save failed: " + (j.error || res.status); st.className = "status err"; }
      else { st.textContent = "Saved — buyers see the new dates immediately."; st.className = "status ok"; etaOverrides = j.saved; renderEtaRows(); }
    } catch (e) { st.textContent = "Error: " + e.message; st.className = "status err"; }
    finally { btn.disabled = false; }
  }

  async function boot() {
    const [cfg, catalog, etaCfg] = await Promise.all([
      fetch("/api/off-pricing").then((r) => r.json()),
      fetch("/data/catalog.json", { cache: "no-store" }).then((r) => r.json()),
      fetch("/api/eta-overrides").then((r) => r.json()).catch(() => ({ overrides: {} }))
    ]);
    etaOverrides = etaCfg.overrides || {};
    // Tag each pre-order with its pd-derived ETA (before any override is applied)
    // so the "From PO" column always shows the source date.
    PREORDERS = (catalog.products || []).filter((p) => p.preorder).sort((a, b) => (a.title || "").localeCompare(b.title || ""));
    // The catalog served to the admin already has overrides baked in, so recover
    // the original pd ETA from the saved overrides map: if overridden, the "real"
    // pd date is unknown from catalog alone — mark it as unknown.
    PREORDERS = PREORDERS.map((p) => ({ ...p, est_delivery_pd: etaOverrides[p.gid] ? null : p.est_delivery }));
    renderEtaRows();
    MODES = cfg.modes || [];
    rule = cfg.default || rule;
    overrides = cfg.overrides || {};
    OFF = (catalog.products || []).filter((p) => p.tier === "off").sort((a, b) => (a.title || "").localeCompare(b.title || ""));

    $("#mode").innerHTML = MODES.map((m) => `<option value="${m.id}">${esc(m.label)}</option>`).join("");
    $("#mode").value = rule.mode;
    $("#value").value = rule.value || 0;
    syncValVisibility();
    renderRows();
    setStatus(`${OFF.length} off-price styles · prices are whole dollars`, "");
    wire();
    loadLeads();
  }

  // ---- leads (who entered via the public gate) ----
  let LEADS = [];
  const fmtDate = (s) => { if (!s) return ""; const d = new Date(s); return isNaN(d) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); };
  async function loadLeads() {
    try { LEADS = (await fetch("/api/visits").then((r) => r.ok ? r.json() : { visits: [] })).visits || []; }
    catch { LEADS = []; }
    renderLeads();
  }
  function renderLeads() {
    const q = ($("#leadSearch").value || "").toLowerCase();
    const list = LEADS.filter((v) => !q || (v.company || "").toLowerCase().includes(q) || (v.email || "").toLowerCase().includes(q));
    $("#leadRows").innerHTML = list.map((v) =>
      `<tr><td class="tname">${esc(v.company || "—")}</td><td>${esc(v.email)}</td><td class="num">${v.visits}</td><td>${fmtDate(v.first_seen)}</td><td>${fmtDate(v.last_seen)}</td></tr>`
    ).join("");
    $("#leadCount").textContent = LEADS.length ? `${LEADS.length} contact${LEADS.length === 1 ? "" : "s"}` : "none yet";
  }

  function syncValVisibility() {
    $("#valWrap").style.display = needsValue(rule.mode) ? "" : "none";
    $("#valLabel").textContent = rule.mode === "fixed" ? "Flat price ($)" : "Percent (%)";
  }

  function renderRows() {
    const q = ($("#search").value || "").toLowerCase();
    const list = OFF.filter((p) => !q || (p.title || "").toLowerCase().includes(q) || (p.color || "").toLowerCase().includes(q));
    $("#rows").innerHTML = list.map((p) => {
      const ov = overrides[p.gid];
      const rp = rulePrice(p);
      return `<tr data-gid="${p.gid}">
        <td>${p.image ? `<img class="thumb" src="${esc(p.image)}">` : `<div class="thumb"></div>`}</td>
        <td><div class="tname">${esc(p.title)}</div><div class="tcolor">${esc(p.color || "")}</div></td>
        <td class="num computed">${p.compare_at ? money(p.compare_at) : "—"}</td>
        <td class="num computed">${p.retail_price ? money(p.retail_price) : "—"}</td>
        <td class="num"><b>${money(rp)}</b></td>
        <td class="num"><input class="ovr ${ov ? "set" : ""}" type="number" min="0" step="1" value="${ov || ""}" placeholder="${rp}" data-gid="${p.gid}"></td>
      </tr>`;
    }).join("");
    $("#rows").querySelectorAll(".ovr").forEach((inp) => inp.addEventListener("input", onOverride));
    const n = Object.keys(overrides).length;
    $("#ovrCount").textContent = n ? `${n} override${n === 1 ? "" : "s"} set` : "no overrides";
  }

  function onOverride(e) {
    const gid = e.target.dataset.gid;
    const v = parseInt(e.target.value, 10);
    if (Number.isFinite(v) && v > 0) overrides[gid] = v; else delete overrides[gid];
    e.target.classList.toggle("set", !!overrides[gid]);
    const n = Object.keys(overrides).length;
    $("#ovrCount").textContent = n ? `${n} override${n === 1 ? "" : "s"} set` : "no overrides";
  }

  function setStatus(msg, kind) { const el = $("#status"); el.textContent = msg; el.className = "status " + (kind || ""); }

  async function save() {
    setStatus("Saving…", "");
    const res = await fetch("/api/off-pricing", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ default: rule, overrides })
    });
    const j = await res.json();
    if (!res.ok || !j.ok) { setStatus("Save failed: " + (j.error || res.status), "err"); return false; }
    overrides = j.saved.overrides; rule = j.saved.default;
    renderRows();
    setStatus("Saved. Rebuild the catalog to apply prices for buyers.", "ok");
    return true;
  }

  async function rebuild() {
    if (!(await save())) return;
    $("#rebuild").disabled = true; $("#saveRule").disabled = true;
    setStatus("Rebuilding catalog… (queries inventory + prices)", "");
    const log = $("#log"); log.style.display = "block"; log.textContent = "Running build…";
    try {
      const res = await fetch("/api/rebuild", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const j = await res.json();
      log.textContent = j.log || j.error || "(no output)";
      log.scrollTop = log.scrollHeight;
      setStatus(j.ok ? "Catalog rebuilt — buyers now see the new off prices." : "Rebuild failed (see log).", j.ok ? "ok" : "err");
    } catch (e) {
      setStatus("Rebuild error: " + e.message, "err");
    } finally {
      $("#rebuild").disabled = false; $("#saveRule").disabled = false;
    }
  }

  // Durable resync: triggers the GitHub Action (re-pull + rebuild + commit).
  async function resync() {
    const btn = $("#resync"), st = $("#resyncStatus");
    btn.disabled = true; st.textContent = "Starting resync…"; st.className = "status";
    try {
      const res = await fetch("/api/resync", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const j = await res.json();
      if (!res.ok || !j.ok) { st.textContent = "Failed: " + (j.error || res.status); st.className = "status err"; }
      else { st.textContent = "Resync started — products/images/prices refresh and go live in ~2–3 minutes. You can leave this page."; st.className = "status ok"; }
    } catch (e) { st.textContent = "Error: " + e.message; st.className = "status err"; }
    finally { setTimeout(() => { btn.disabled = false; }, 5000); }
  }

  function wire() {
    $("#resync").addEventListener("click", resync);
    $("#mode").addEventListener("change", (e) => { rule.mode = e.target.value; syncValVisibility(); renderRows(); });
    $("#value").addEventListener("input", (e) => { rule.value = Number(e.target.value) || 0; renderRows(); });
    let t; $("#search").addEventListener("input", () => { clearTimeout(t); t = setTimeout(renderRows, 120); });
    $("#saveRule").addEventListener("click", save);
    $("#rebuild").addEventListener("click", rebuild);
    $("#clearOvr").addEventListener("click", () => { if (Object.keys(overrides).length && confirm("Remove all per-style overrides?")) { overrides = {}; renderRows(); } });
    $("#refreshLeads").addEventListener("click", loadLeads);
    let lt; $("#leadSearch").addEventListener("input", () => { clearTimeout(lt); lt = setTimeout(renderLeads, 120); });
    $("#saveEta").addEventListener("click", saveEta);
    let et; $("#etaSearch").addEventListener("input", () => { clearTimeout(et); et = setTimeout(renderEtaRows, 120); });
  }

  boot().catch((e) => setStatus("Failed to load: " + e.message, "err"));
})();
