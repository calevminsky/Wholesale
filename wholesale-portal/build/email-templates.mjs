// HTML email templates for order notifications.
// All styles are inlined for maximum email-client compatibility.

const SIZE_CORE = ["XXS", "XS", "S", "M", "L", "XL", "XXL", "OS"];
const money = (n) => "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ---- Buyer receipt ----
export function buyerReceiptHtml({ order, units, subtotal, account, ref }) {
  const shipLabel = order.shipping === "when_ready" ? "Ship when ready (partial shipments OK)" : "Ship all together";
  const notes = String(order.notes || "").replace(/^\[.*?\]\s*/, "").trim();

  const rows = order.items.map((it) => {
    const sizes = SIZE_CORE.filter((k) => it.size_qty?.[k]).map((k) => `${k}&nbsp;×&nbsp;${it.size_qty[k]}`).join(", ");
    const qty = SIZE_CORE.reduce((s, k) => s + (it.size_qty?.[k] || 0), 0);
    return `
      <tr>
        <td style="padding:12px 0;border-bottom:1px solid #EDE6DC;font-size:14px;color:#211C17;font-weight:600;line-height:1.3">${esc(it.product_name)}</td>
        <td style="padding:12px 8px;border-bottom:1px solid #EDE6DC;font-size:13px;color:#8A8178;white-space:nowrap">${sizes}</td>
        <td style="padding:12px 0;border-bottom:1px solid #EDE6DC;font-size:13px;color:#8A8178;text-align:right;white-space:nowrap">${qty} × ${money(it.unit_price)}</td>
        <td style="padding:12px 0 12px 16px;border-bottom:1px solid #EDE6DC;font-size:14px;color:#211C17;font-weight:600;text-align:right;white-space:nowrap">${money(qty * it.unit_price)}</td>
      </tr>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Your Yakira Bella order</title>
</head>
<body style="margin:0;padding:0;background:#FAF7F2;font-family:Georgia,serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#FAF7F2;padding:40px 16px">
  <tr><td align="center">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">

      <!-- header -->
      <tr><td style="padding-bottom:28px;text-align:center">
        <p style="margin:0 0 4px;font-family:Georgia,serif;font-size:22px;font-weight:normal;color:#7C3A2E;letter-spacing:.01em">Yakira Bella</p>
        <p style="margin:0;font-size:11px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:#8A8178;font-family:Arial,sans-serif">Wholesale</p>
      </td></tr>

      <!-- card -->
      <tr><td style="background:#FFFFFF;border-radius:16px;padding:36px 36px 32px;box-shadow:0 4px 24px rgba(33,28,23,.08)">

        <!-- checkmark + heading -->
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr><td style="text-align:center;padding-bottom:24px">
            <div style="display:inline-block;width:48px;height:48px;background:#EAF2EC;border-radius:50%;line-height:48px;text-align:center;font-size:22px">✓</div>
            <h1 style="margin:14px 0 6px;font-family:Georgia,serif;font-size:24px;font-weight:normal;color:#211C17">Order received!</h1>
            <p style="margin:0;font-size:14px;color:#8A8178;font-family:Arial,sans-serif;line-height:1.5">Thanks, <strong style="color:#211C17">${esc(account.name)}</strong> — we got it and will confirm shortly.</p>
          </td></tr>
        </table>

        <!-- ref pill -->
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px">
          <tr><td style="background:#FAF7F2;border-radius:8px;padding:10px 14px">
            <span style="font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#8A8178;font-family:Arial,sans-serif">Order reference</span>
            <span style="float:right;font-size:13px;font-family:monospace;color:#211C17;font-weight:600">${esc(ref)}</span>
          </td></tr>
        </table>

        <!-- items table -->
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <th style="text-align:left;font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#8A8178;padding-bottom:8px;font-family:Arial,sans-serif">Style</th>
            <th style="text-align:left;font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#8A8178;padding-bottom:8px;padding-left:8px;font-family:Arial,sans-serif">Sizes</th>
            <th style="text-align:right;font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#8A8178;padding-bottom:8px;font-family:Arial,sans-serif">Qty</th>
            <th style="text-align:right;font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#8A8178;padding-bottom:8px;padding-left:16px;font-family:Arial,sans-serif">Total</th>
          </tr>
          ${rows}
          <!-- subtotal -->
          <tr>
            <td colspan="3" style="padding-top:14px;font-size:13px;color:#8A8178;font-family:Arial,sans-serif">${units} unit${units === 1 ? "" : "s"} · ${order.items.length} style${order.items.length === 1 ? "" : "s"}</td>
            <td style="padding-top:14px;text-align:right;font-size:18px;font-weight:700;color:#7C3A2E;font-family:Arial,sans-serif">${money(subtotal)}</td>
          </tr>
        </table>

        <!-- divider -->
        <div style="border-top:1px solid #EDE6DC;margin:24px 0"></div>

        <!-- shipping + notes -->
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#8A8178;padding-bottom:4px;font-family:Arial,sans-serif">Shipping</td>
          </tr>
          <tr>
            <td style="font-size:14px;color:#211C17;font-family:Arial,sans-serif">${esc(shipLabel)}</td>
          </tr>
          ${notes ? `
          <tr><td style="padding-top:14px;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#8A8178;padding-bottom:4px;font-family:Arial,sans-serif">Notes</td></tr>
          <tr><td style="font-size:14px;color:#211C17;font-family:Arial,sans-serif">${esc(notes)}</td></tr>` : ""}
        </table>

        <!-- divider -->
        <div style="border-top:1px solid #EDE6DC;margin:24px 0"></div>

        <!-- footer note -->
        <p style="margin:0;font-size:13px;color:#8A8178;line-height:1.6;font-family:Arial,sans-serif;text-align:center">
          Questions about your order? Just reply to this email.<br>
          We'll be in touch to confirm availability and timing.
        </p>

      </td></tr>

      <!-- bottom brand -->
      <tr><td style="padding-top:28px;text-align:center">
        <p style="margin:0;font-size:12px;color:#B0A89E;font-family:Arial,sans-serif">Yakira Bella · Wholesale</p>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;
}

// ---- Internal team notification ----
export function teamNotificationHtml({ order, units, subtotal, account, buyerEmail, ref }) {
  const shipLabel = order.shipping === "when_ready" ? "Ship when ready" : "Ship all together";
  const notes = String(order.notes || "").replace(/^\[.*?\]\s*/, "").trim();

  const rows = order.items.map((it) => {
    const sizes = SIZE_CORE.filter((k) => it.size_qty?.[k]).map((k) => `${k} ×${it.size_qty[k]}`).join("  ");
    const qty = SIZE_CORE.reduce((s, k) => s + (it.size_qty?.[k] || 0), 0);
    return `
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #EDE6DC;font-size:13px;color:#211C17;font-weight:600">${esc(it.product_name)}</td>
        <td style="padding:10px 8px;border-bottom:1px solid #EDE6DC;font-size:12px;color:#8A8178;font-family:monospace">${esc(sizes)}</td>
        <td style="padding:10px 0;border-bottom:1px solid #EDE6DC;font-size:13px;color:#211C17;text-align:right;font-weight:600">${money(qty * it.unit_price)}</td>
      </tr>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>New wholesale order</title></head>
<body style="margin:0;padding:0;background:#FAF7F2;font-family:Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#FAF7F2;padding:32px 16px">
  <tr><td align="center">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:540px">

      <tr><td style="background:#7C3A2E;border-radius:12px 12px 0 0;padding:20px 28px">
        <p style="margin:0;font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:rgba(255,255,255,.65)">New wholesale order</p>
        <h1 style="margin:4px 0 0;font-size:20px;font-weight:600;color:#FFFFFF;font-family:Georgia,serif">${esc(account.name)}</h1>
      </td></tr>

      <tr><td style="background:#FFFFFF;border-radius:0 0 12px 12px;padding:24px 28px">

        <!-- summary pills -->
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px">
          <tr>
            <td style="background:#FAF7F2;border-radius:8px;padding:8px 12px;text-align:center;width:30%">
              <div style="font-size:20px;font-weight:700;color:#7C3A2E">${money(subtotal)}</div>
              <div style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#8A8178;margin-top:2px">Subtotal</div>
            </td>
            <td width="8"></td>
            <td style="background:#FAF7F2;border-radius:8px;padding:8px 12px;text-align:center;width:30%">
              <div style="font-size:20px;font-weight:700;color:#211C17">${units}</div>
              <div style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#8A8178;margin-top:2px">Units</div>
            </td>
            <td width="8"></td>
            <td style="background:#FAF7F2;border-radius:8px;padding:8px 12px;text-align:center;width:30%">
              <div style="font-size:20px;font-weight:700;color:#211C17">${order.items.length}</div>
              <div style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#8A8178;margin-top:2px">Styles</div>
            </td>
          </tr>
        </table>

        <!-- buyer info -->
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px">
          ${buyerEmail ? `<tr><td style="font-size:12px;color:#8A8178;padding-bottom:2px">Buyer email</td><td style="font-size:13px;color:#211C17;text-align:right">${esc(buyerEmail)}</td></tr>` : ""}
          <tr><td style="font-size:12px;color:#8A8178;padding-bottom:2px">Shipping</td><td style="font-size:13px;color:#211C17;text-align:right">${esc(shipLabel)}</td></tr>
          <tr><td style="font-size:12px;color:#8A8178;padding-bottom:2px">Reference</td><td style="font-size:13px;color:#211C17;text-align:right;font-family:monospace">${esc(ref)}</td></tr>
          ${notes ? `<tr><td style="font-size:12px;color:#8A8178;padding-top:4px">Notes</td><td style="font-size:13px;color:#211C17;text-align:right">${esc(notes)}</td></tr>` : ""}
        </table>

        <div style="border-top:1px solid #EDE6DC;margin-bottom:16px"></div>

        <!-- items -->
        <table width="100%" cellpadding="0" cellspacing="0">
          ${rows}
        </table>

        <p style="margin:20px 0 0;font-size:12px;color:#B0A89E;text-align:center">CSV attached — ready to import.</p>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;
}
