/* Product-removal page (Emily's secret link). Same card layout as the buyer
   line sheet, plus on-hand inventory per size. Tick styles → Remove selected →
   POSTs to /api/remove (durable, Postgres-backed). Restore puts items back. */
(() => {
  "use strict";
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const KEY = new URLSearchParams(location.search).get("key") || "";
  const withKey = (u) => u + (u.includes("?") ? "&" : "?") + "key=" + encodeURIComponent(KEY);
  const isCore = (p) => (p.class || "").toLowerCase() === "core";
  const totalOnHand = (p) => p.preorder ? -1 : p.sizes.reduce((a, s) => a + (Number(s.available) || 0), 0);

  let PRODUCTS = [];
  const selected = new Set();          // gids marked for removal
  const filters = { q: "", type: "", klass: "", sort: "title_asc", density: "comfortable" };

  async function boot() {
    let catalog, hidden;
    try {
      [catalog, hidden] = await Promise.all([
        fetch("/data/catalog.json", { cache: "no-store" }).then((r) => r.json()),
        fetch(withKey("/api/hidden"), { cache: "no-store" }).then((r) => r.ok ? r.json() : { removed: [] })
      ]);
    } catch (e) { setStatus("Failed to load: " + e.message, "err"); return; }
    PRODUCTS = (catalog.products || []).filter((p) => p.tier !== "off")
      .sort((a, b) => (a.title || "").localeCompare(b.title || ""));
    fillTypes();
    renderRemoved(hidden.removed || []);
    wire();
    render();
    $("#bar").classList.add("show");
    setStatus(`${PRODUCTS.length} products on the line sheet`, "");
  }

  function fillTypes() {
    const types = [...new Set(PRODUCTS.map((p) => p.type).filter(Boolean))].sort();
    for (const t of types) { const o = document.createElement("option"); o.value = t; o.textContent = t; $("#fType").appendChild(o); }
  }

  function matchesBase(p) {
    if (filters.type && p.type !== filters.type) return false;
    if (filters.q) {
      const q = filters.q.toLowerCase();
      if (!((p.title || "").toLowerCase().includes(q) || (p.color || "").toLowerCase().includes(q))) return false;
    }
    return true;
  }
  function matchesClass(p) {
    if (filters.klass === "core") return isCore(p);
    if (filters.klass === "noncore") return !isCore(p);
    return true;
  }
  function visible() {
    const arr = PRODUCTS.filter((p) => matchesClass(p) && matchesBase(p));
    const cmp = {
      title_asc: (a, b) => (a.title || "").localeCompare(b.title || ""),
      inv_desc: (a, b) => totalOnHand(b) - totalOnHand(a),
      inv_asc: (a, b) => totalOnHand(a) - totalOnHand(b)
    }[filters.sort];
    return arr.sort(cmp);
  }

  function setCounts() {
    const base = PRODUCTS.filter(matchesBase);
    $("#cAll").textContent = base.length;
    $("#cNonCore").textContent = base.filter((p) => !isCore(p)).length;
    $("#cCore").textContent = base.filter((p) => isCore(p)).length;
  }

  function invHTML(p) {
    if (p.preorder) return `<div class="prenote">Pre-order — no stock yet</div>`;
    const cells = p.sizes.map((s) => {
      const a = Number(s.available) || 0;
      return `<div class="sizecell"><span class="sz">${esc(s.size)}</span><span class="av ${a <= 0 ? "zero" : ""}">${a}</span></div>`;
    }).join("");
    return `<div class="invhead">On hand</div><div class="sizerun">${cells}</div>
      <div class="invtotal">Total: <b>${totalOnHand(p)}</b> on hand</div>`;
  }

  function cardHTML(p) {
    const marked = selected.has(p.gid);
    const img = p.image ? `<img src="${esc(p.image)}" alt="${esc(p.title)}" loading="lazy">` : "";
    return `<div class="card ${marked ? "marked" : ""}" data-gid="${esc(p.gid)}">
      <div class="imgwrap">
        <span class="markedflag">Removing</span>
        <label class="removechk" onclick="event.stopPropagation()"><input type="checkbox" ${marked ? "checked" : ""}> Remove</label>
        ${img}
      </div>
      <div class="body">
        <div class="title">${esc(p.title)}</div>
        <div class="meta">${p.type ? esc(p.type) : ""}${p.type && p.color ? '<span class="dot"></span>' : ""}${p.color ? esc(p.color) : ""}</div>
        ${invHTML(p)}
      </div>
    </div>`;
  }

  function render() {
    setCounts();
    const list = visible();
    const grid = $("#grid"), empty = $("#empty");
    grid.className = "grid" + (filters.density === "compact" ? " compact" : "");
    $("#count").textContent = `${list.length} style${list.length === 1 ? "" : "s"}`;
    if (!list.length) { grid.innerHTML = ""; empty.style.display = "block"; syncSel(); return; }
    empty.style.display = "none";
    grid.innerHTML = list.map(cardHTML).join("");
    $$(".card", grid).forEach((card) => card.addEventListener("click", () => toggle(card.dataset.gid)));
    $$(".removechk input", grid).forEach((inp) => inp.addEventListener("change", (e) => {
      toggle(e.target.closest(".card").dataset.gid, e.target.checked);
    }));
    syncSel();
  }

  function toggle(gid, force) {
    const on = force === undefined ? !selected.has(gid) : force;
    if (on) selected.add(gid); else selected.delete(gid);
    const card = $(`.card[data-gid="${CSS.escape(gid)}"]`);
    if (card) { card.classList.toggle("marked", on); const cb = card.querySelector(".removechk input"); if (cb) cb.checked = on; }
    syncSel();
  }

  function syncSel() {
    const n = selected.size;
    $("#selCount").textContent = n;
    $$("#removeBtn, #removeBtn2").forEach((b) => b.disabled = n === 0);
  }

  function renderRemoved(removed) {
    const sec = $("#removedSection"), box = $("#removed");
    if (!removed.length) { sec.style.display = "none"; box.innerHTML = ""; return; }
    sec.style.display = "";
    box.innerHTML = removed.map((r) => `<span class="rchip">${esc(r.title || r.handle)} <button data-restore="${esc(r.handle)}">restore</button></span>`).join("");
    $$("[data-restore]", box).forEach((b) => b.addEventListener("click", () => submit({ restore: [b.dataset.restore] })));
  }

  function setStatus(msg, kind) { const el = $("#status"); el.textContent = msg; el.className = "status " + (kind || ""); }

  async function submit({ add = [], restore = [] }) {
    if (!add.length && !restore.length) return;
    $$("#removeBtn, #removeBtn2").forEach((b) => b.disabled = true);
    setStatus(restore.length ? "Restoring…" : "Removing…", "");
    try {
      const res = await fetch(withKey("/api/remove"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ add, restore })
      });
      const j = await res.json();
      if (!res.ok || !j.ok) {
        const log = $("#log"); log.style.display = "block"; log.textContent = j.error || ("HTTP " + res.status);
        setStatus("Failed — nothing changed.", "err"); return;
      }
      const gone = new Set(add.map((a) => a.handle));
      if (add.length) PRODUCTS = PRODUCTS.filter((p) => !gone.has(p.handle));
      selected.clear();
      renderRemoved(j.removed || []);
      render();
      setStatus(restore.length ? "Restored — buyers see it again." : `Removed ${gone.size} style${gone.size === 1 ? "" : "s"} — gone for good.`, "ok");
    } catch (e) {
      setStatus("Error: " + e.message, "err");
    }
  }

  function doRemove() {
    const add = PRODUCTS.filter((p) => selected.has(p.gid)).map((p) => ({ handle: p.handle, title: p.title }));
    if (!add.length) return;
    if (!confirm(`Remove ${add.length} style${add.length === 1 ? "" : "s"} from the line sheet? Buyers will stop seeing them.`)) return;
    submit({ add });
  }

  function wire() {
    let t;
    $("#q").addEventListener("input", (e) => { clearTimeout(t); t = setTimeout(() => { filters.q = e.target.value.trim(); render(); }, 130); });
    $("#fType").addEventListener("change", (e) => { filters.type = e.target.value; render(); });
    $("#sort").addEventListener("change", (e) => { filters.sort = e.target.value; render(); });
    $("#classSeg").addEventListener("click", (e) => {
      const b = e.target.closest(".tiertab"); if (!b) return;
      filters.klass = b.dataset.v; $$("#classSeg .tiertab").forEach((x) => x.classList.toggle("on", x === b)); render();
    });
    $("#densitySeg").addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      filters.density = b.dataset.v; $$("#densitySeg button").forEach((x) => x.classList.toggle("on", x === b)); render();
    });
    $("#clearSel").addEventListener("click", () => { selected.clear(); render(); });
    $("#removeBtn").addEventListener("click", doRemove);
    $("#removeBtn2").addEventListener("click", doRemove);
  }

  boot();
})();
