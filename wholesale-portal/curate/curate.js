/* Product-removal page (Emily's secret link). Lists the line-sheet products,
   lets her tick the ones to remove, POSTs to /api/remove (which writes
   build/hidden.json and rebuilds the catalog). Restore puts items back. */
(() => {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const KEY = new URLSearchParams(location.search).get("key") || "";
  const withKey = (u) => u + (u.includes("?") ? "&" : "?") + "key=" + encodeURIComponent(KEY);

  let PRODUCTS = [];          // selectable line-sheet products (non-off)
  const selected = new Set(); // gids ticked for removal
  let q = "", fType = "";

  async function boot() {
    let catalog, hidden;
    try {
      [catalog, hidden] = await Promise.all([
        fetch("/data/catalog.json", { cache: "no-store" }).then((r) => r.json()),
        fetch(withKey("/api/hidden"), { cache: "no-store" }).then((r) => r.ok ? r.json() : { removed: [] })
      ]);
    } catch (e) { setStatus("Failed to load: " + e.message, "err"); return; }
    // Same set buyers see: full-price, not already removed.
    PRODUCTS = (catalog.products || []).filter((p) => p.tier !== "off")
      .sort((a, b) => (a.title || "").localeCompare(b.title || ""));
    fillTypes();
    renderRemoved(hidden.removed || []);
    render();
    wire();
    setStatus(`${PRODUCTS.length} products on the line sheet`, "");
  }

  function fillTypes() {
    const types = [...new Set(PRODUCTS.map((p) => p.type).filter(Boolean))].sort();
    for (const t of types) { const o = document.createElement("option"); o.value = t; o.textContent = t; $("#fType").appendChild(o); }
  }

  function visible() {
    const ql = q.toLowerCase();
    return PRODUCTS.filter((p) =>
      (!fType || p.type === fType) &&
      (!ql || (p.title || "").toLowerCase().includes(ql) || (p.color || "").toLowerCase().includes(ql)));
  }

  function render() {
    const list = visible();
    $("#count").textContent = `${list.length} shown`;
    $("#grid").innerHTML = list.map((p) => `
      <label class="tile ${selected.has(p.gid) ? "sel" : ""}" data-gid="${esc(p.gid)}">
        <input type="checkbox" ${selected.has(p.gid) ? "checked" : ""}>
        ${p.image ? `<img src="${esc(p.image)}" alt="">` : `<span class="noimg"></span>`}
        <span><span class="t">${esc(p.title)}</span><br><span class="c">${esc(p.type || "")}${p.type && p.color ? " · " : ""}${esc(p.color || "")}</span></span>
      </label>`).join("");
    $("#grid").querySelectorAll(".tile").forEach((t) => {
      t.addEventListener("change", (e) => {
        const gid = t.dataset.gid;
        if (e.target.checked) selected.add(gid); else selected.delete(gid);
        t.classList.toggle("sel", e.target.checked);
        syncSel();
      });
    });
    syncSel();
  }

  function syncSel() {
    $("#selinfo").textContent = selected.size ? `${selected.size} selected to remove` : "";
    $("#removeBtn").disabled = selected.size === 0;
  }

  function renderRemoved(removed) {
    const sec = $("#removedSection"), box = $("#removed");
    if (!removed.length) { sec.style.display = "none"; box.innerHTML = ""; return; }
    sec.style.display = "";
    box.innerHTML = removed.map((r) => `<span class="rchip">${esc(r.title || r.handle)} <button data-restore="${esc(r.handle)}">restore</button></span>`).join("");
    box.querySelectorAll("[data-restore]").forEach((b) => b.addEventListener("click", () => submit({ restore: [b.dataset.restore] })));
  }

  function setStatus(msg, kind) { const el = $("#status"); el.textContent = msg; el.className = "status " + (kind || ""); }

  async function submit({ add = [], restore = [] }) {
    if (!add.length && !restore.length) return;
    $("#removeBtn").disabled = true;
    setStatus(restore.length ? "Restoring…" : "Removing & rebuilding the line sheet…", "");
    const log = $("#log"); log.style.display = "block"; log.textContent = "Working…";
    try {
      const res = await fetch(withKey("/api/remove"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ add, restore })
      });
      const j = await res.json();
      log.textContent = j.log || j.error || "(no output)";
      log.scrollTop = log.scrollHeight;
      if (!res.ok || !j.ok) { setStatus("Failed (see log).", "err"); return; }
      // Drop removed items from the local list; clear selection.
      const goneHandles = new Set(add.map((a) => a.handle));
      if (add.length) PRODUCTS = PRODUCTS.filter((p) => !goneHandles.has(p.handle));
      selected.clear();
      renderRemoved(j.removed || []);
      render();
      setStatus(restore.length ? "Restored — buyers see it again." : "Removed — buyers no longer see those styles.", "ok");
    } catch (e) {
      setStatus("Error: " + e.message, "err");
    } finally {
      syncSel();
    }
  }

  function wire() {
    let t;
    $("#search").addEventListener("input", (e) => { clearTimeout(t); t = setTimeout(() => { q = e.target.value.trim(); render(); }, 120); });
    $("#fType").addEventListener("change", (e) => { fType = e.target.value; render(); });
    $("#clearSel").addEventListener("click", () => { selected.clear(); render(); });
    $("#removeBtn").addEventListener("click", () => {
      const add = PRODUCTS.filter((p) => selected.has(p.gid)).map((p) => ({ handle: p.handle, title: p.title, gid: p.gid }));
      if (!add.length) return;
      if (!confirm(`Remove ${add.length} style${add.length === 1 ? "" : "s"} from the line sheet? Buyers will stop seeing them.`)) return;
      submit({ add });
    });
  }

  boot();
})();
