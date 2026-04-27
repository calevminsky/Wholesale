// Pricing controls above the product table.
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
      if (c == null) continue;
      e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return e;
  }

  function render(root, pricing, { onChange, onApplyAll, onResetOverrides, overrideCount }) {
    root.innerHTML = "";

    const mode = pricing.default_mode || "pct_off_compare_at";
    const val = pricing.default_value ?? 50;

    const modeSel = el("select", null, [
      el("option", { value: "pct_off_compare_at" }, "% off MSRP"),
      el("option", { value: "pct_off_current" }, "% off current sale price"),
      el("option", { value: "fixed" }, "fixed $")
    ]);
    modeSel.value = mode;
    modeSel.addEventListener("change", () => { pricing.default_mode = modeSel.value; onChange(); });

    const valInp = el("input", { type: "number", value: val, step: "0.01", style: "width:80px;" });
    valInp.addEventListener("input", () => { pricing.default_value = Number(valInp.value); onChange(); });

    const unit = el("span", null, mode === "fixed" ? "$" : "%");
    modeSel.addEventListener("change", () => { unit.textContent = modeSel.value === "fixed" ? "$" : "%"; });

    root.appendChild(el("label", null, [el("strong", null, "Default price: ")]));
    root.appendChild(modeSel);
    root.appendChild(valInp);
    root.appendChild(unit);

    root.appendChild(el("button", { style: "margin-left:16px;", onclick: onApplyAll }, "Apply to all"));
    root.appendChild(el("button", {
      style: "margin-left:6px;",
      title: "Removes all per-product price tweaks and uses the default for everything",
      onclick: () => {
        if (!overrideCount) return;
        if (confirm(`Reset ${overrideCount} custom price(s) to the default?`)) onResetOverrides();
      }
    }, `Reset custom prices (${overrideCount || 0})`));
  }

  w.LineSheets.renderPricingBar = render;
})();
