// Bootstrap shim — the editor is now the whole page.
(function () {
  const w = window;
  w.LineSheets = w.LineSheets || {};

  async function show() {
    const editorRoot = document.getElementById("lsEditorRoot");
    const listRoot = document.getElementById("lsListRoot");
    if (listRoot) listRoot.style.display = "none";
    if (editorRoot) editorRoot.style.display = "";
    await w.LineSheets.bootstrap(editorRoot);
  }

  w.LineSheets.showList = show;
  w.LineSheets.refreshList = async () => { /* no-op, kept for API compatibility */ };
  w.LineSheets.openEditorById = async (id) => { await show(); await w.LineSheets.openSaved(id); };
  w.LineSheets.openEditor = async (id) => { await show(); if (id) await w.LineSheets.openSaved(id); };
})();
