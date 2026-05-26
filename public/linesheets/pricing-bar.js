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
    const addPct = Number(pricing.additional_discount_pct) || 0;

    const modeSel = el("select", null, [
      el("option", { value: "pct_off_compare_at" }, "% off MSRP"),
      el("option", { value: "pct_off_current" }, "% off current sale price"),
      el("option", { value: "fixed" }, "fixed $"),
      el("option", { value: "pct_of_higher" }, "% of higher of MSRP or cost")
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

    // Additional bulk discount, applied on top of the default/override.
    const addRow = el("div", { style: "margin-top:10px;" });
    addRow.appendChild(el("label", null, [el("strong", null, "Additional discount: ")]));
    const addInp = el("input", { type: "number", value: addPct, step: "0.5", min: "0", max: "100", style: "width:80px;" });
    addInp.addEventListener("input", () => {
      pricing.additional_discount_pct = Number(addInp.value) || 0;
      onChange();
    });
    addRow.appendChild(addInp);
    addRow.appendChild(el("span", null, "% off the wholesale price"));
    addRow.appendChild(el("span", { class: "muted", style: "margin-left:10px;font-size:11px;" },
      "Stacks on top of the default and any per-product overrides."));
    root.appendChild(addRow);

    // Live storefront sale already baked into Shopify product.price (e.g. a
    // sitewide "additional 30% off markdowns" promo). Grosses current_price
    // back up before "% off current" applies, so the wholesale math is
    // against the pre-promo markdown price instead of the discounted one.
    const liveDisc = Number(pricing.live_storefront_discount_pct) || 0;
    const liveRow = el("div", { style: "margin-top:10px;" });
    liveRow.appendChild(el("label", null, [el("strong", null, "Live storefront sale: ")]));
    const liveInp = el("input", { type: "number", value: liveDisc, step: "0.5", min: "0", max: "99", style: "width:80px;" });
    liveInp.addEventListener("input", () => {
      pricing.live_storefront_discount_pct = Number(liveInp.value) || 0;
      onChange();
    });
    liveRow.appendChild(liveInp);
    liveRow.appendChild(el("span", null, "% already baked into Shopify prices"));
    liveRow.appendChild(el("span", { class: "muted", style: "margin-left:10px;font-size:11px;" },
      "Use this if you're running a sitewide promo that lowered product.price. " +
      "\"% off current\" will then apply to the pre-promo price, not the discounted one."));
    root.appendChild(liveRow);
  }

  w.LineSheets.renderPricingBar = render;
})();
