// Portal Links: every buyer / admin / keyed link for each portal offering,
// fetched live from the buyer portal via /api/portal-links (the portal is the
// source of truth for its URLs and secret keys). Mounted into #linksPage.
(function () {
  const root = document.getElementById("linksPage");
  if (!root) return;

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  let loadedAt = 0;

  async function show(force = false) {
    if (!force && Date.now() - loadedAt < 5 * 60_000) return;
    root.innerHTML = '<p class="muted">Loading portal links…</p>';
    try {
      const res = await fetch("/api/portal-links");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      render(json);
      loadedAt = Date.now();
    } catch (e) {
      root.innerHTML = `<div class="box"><b>Couldn't load portal links.</b> <span class="muted">${esc(e.message)}</span>
        <div style="margin-top:8px;"><button id="linksRetry">Retry</button></div></div>`;
      document.getElementById("linksRetry").onclick = () => show(true);
    }
  }

  function linkRow(l) {
    const url = l.url
      ? `<a href="${esc(l.url)}" target="_blank" rel="noopener" style="word-break:break-all;">${esc(l.url)}</a>
         <button class="copy-link-btn" data-url="${esc(l.url)}" style="margin-left:8px;">Copy</button>`
      : `<span class="muted">— not configured —</span>`;
    return `<tr>
      <td style="white-space:nowrap;vertical-align:top;width:1%;"><b>${esc(l.label)}</b></td>
      <td style="vertical-align:top;">${url}
        ${l.note ? `<div class="muted" style="margin-top:2px;">${esc(l.note)}</div>` : ""}
      </td>
    </tr>`;
  }

  function render(data) {
    root.innerHTML = `
      <div class="row" style="justify-content:space-between;">
        <p class="muted" style="margin:0;">All links live on the buyer portal (${esc(data.base)}). Keyed links are secrets — only share them with the person they're for.</p>
        <button id="linksRefresh">Refresh</button>
      </div>
      ${data.sections.map((s) => `
        <h2>${esc(s.title)}</h2>
        <div class="box"><table style="border-collapse:collapse;">${s.links.map(linkRow).join("")}</table></div>
      `).join("")}`;
    document.getElementById("linksRefresh").onclick = () => show(true);
    root.querySelectorAll(".copy-link-btn").forEach((b) => b.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(b.dataset.url);
        const prev = b.textContent;
        b.textContent = "Copied ✓";
        setTimeout(() => { b.textContent = prev; }, 1200);
      } catch { /* clipboard blocked — the link is still selectable */ }
    }));
  }

  window.LinksPage = { show };
})();
