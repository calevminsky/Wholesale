// Mount /api/orders-draft/* on an Express app.
//
// Note: /api/orders already exists (lists Shopify orders). To avoid clashing,
// the draft/persisted-order routes live under /api/orders-draft.
import { Router } from "express";
import { pgAvailable } from "../pg.js";
import * as db from "./db.js";
import * as customersDb from "../customers/db.js";
import { parseOrderUpload } from "./parse-upload.js";
import { getExportByToken } from "../linesheets/exports-db.js";
import { buildDraftOrderHtml } from "./draft-order-template.js";

// Default locations to pre-select on a brand-new draft. Substring match against
// location names from getAllLocations(). Edit if the org's defaults change.
const DEFAULT_LOCATION_NAME_PATTERNS = ["bogota", "warehouse"];

async function defaultLocationIds(getAllLocations) {
  if (typeof getAllLocations !== "function") return [];
  try {
    const locs = await getAllLocations();
    if (!Array.isArray(locs)) return [];
    const ids = [];
    for (const pat of DEFAULT_LOCATION_NAME_PATTERNS) {
      const hit = locs.find((l) => String(l.name || "").toLowerCase().includes(pat));
      if (hit && !ids.includes(String(hit.id))) ids.push(String(hit.id));
    }
    return ids;
  } catch {
    return [];
  }
}

export function createOrdersRouter({
  runAllocation,
  upload,
  submitAllocationToShopify,
  sendEmailWithAttachments,
  getAllLocations,
  renderPdfFromHtml
} = {}) {
  const r = Router();

  r.use((req, res, next) => {
    if (!pgAvailable()) {
      return res.status(503).json({ error: "Reporting DB unavailable. Set REPORTING_DATABASE_URL." });
    }
    next();
  });

  const parseId = (s) => {
    const n = Number(s);
    return Number.isFinite(n) && Number.isInteger(n) ? n : null;
  };

  // ------- list / create -------
  r.get("/api/orders-draft", async (req, res) => {
    try {
      const rows = await db.listOrders({
        status: req.query.status || undefined,
        customerId: req.query.customer_id ? parseId(req.query.customer_id) : undefined,
        lineSheetId: req.query.line_sheet_id ? parseId(req.query.line_sheet_id) : undefined,
        search: req.query.q
      });
      res.json({ orders: rows });
    } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  r.post("/api/orders-draft", async (req, res) => {
    try {
      const payload = { ...(req.body || {}) };
      // Default locations to Bogota + Warehouse if the caller didn't pick any.
      if (!Array.isArray(payload.location_ids) || payload.location_ids.length === 0) {
        payload.location_ids = await defaultLocationIds(getAllLocations);
      }
      const row = await db.createOrder(payload);
      res.json({ order: row });
    } catch (e) { res.status(400).json({ error: String(e?.message || e) }); }
  });

  // Upload an XLSX/CSV to create a draft. Detects line-sheet-derived files via
  // hidden workbook metadata; falls back to header sniffing for hand-crafted
  // files. Body fields (multipart): file, customer_id?, line_sheet_id?, name?,
  // notes?, location_ids? (JSON array string).
  if (upload) {
    r.post("/api/orders-draft/from-upload", upload.single("file"), async (req, res) => {
      try {
        if (!req.file?.buffer) return res.status(400).json({ error: "Missing file." });
        const parsed = parseOrderUpload(req.file);
        if (!parsed.items.length) {
          return res.status(400).json({ error: "No order rows with quantities found in the file." });
        }

        let locationIds = [];
        if (req.body.location_ids) {
          try {
            const v = JSON.parse(req.body.location_ids);
            if (Array.isArray(v)) locationIds = v.filter((x) => typeof x === "string");
          } catch { /* ignore — leave empty */ }
        }
        // No locations supplied by the UI? Pre-fill with the org defaults
        // (Bogota + Warehouse). Manager can change them in the editor.
        if (!locationIds.length) {
          locationIds = await defaultLocationIds(getAllLocations);
        }

        const customerId = req.body.customer_id ? parseId(req.body.customer_id) : null;
        const explicitLineSheetId = req.body.line_sheet_id ? parseId(req.body.line_sheet_id) : null;
        const lineSheetId = explicitLineSheetId ?? parsed.lineSheetId ?? null;

        // If no customer was passed but the line sheet has one, inherit it.
        let inheritedCustomerId = customerId;
        if (!inheritedCustomerId && lineSheetId) {
          // Light query — avoid pulling the linesheets db module by going through
          // the customers db isn't right; instead just leave inheritedCustomerId
          // null and let the UI link it after the fact. The draft is still
          // associated with the line sheet, which is the more important link.
        }

        const items = parsed.items.map((it) => ({
          handle: it.handle,
          unit_price: it.unitPrice,
          size_qty: it.sizeQty,
          product_name: it.productName || null
        }));

        // If we recognize the export token, diff submitted PPUs against the
        // frozen snapshot. Mismatches are stored on the draft for the manager
        // to resolve before submission.
        let exportToken = parsed.exportToken || null;
        let priceMismatches = [];
        let resolvedLineSheetId = lineSheetId;
        let resolvedCustomerId = inheritedCustomerId;
        if (exportToken) {
          const snap = await getExportByToken(exportToken);
          if (snap) {
            const expectedByHandle = new Map(
              (Array.isArray(snap.items) ? snap.items : [])
                .map((r) => [String(r.handle), Number(r.ppu)])
            );
            for (const it of items) {
              const expected = expectedByHandle.get(it.handle);
              if (expected === undefined) continue;
              const got = Math.round(Number(it.unit_price) * 100) / 100;
              const exp = Math.round(expected * 100) / 100;
              if (got !== exp) {
                priceMismatches.push({ handle: it.handle, expected: exp, submitted: got });
              }
            }
            // Use snapshot's links if the upload didn't carry them explicitly.
            resolvedLineSheetId = resolvedLineSheetId ?? snap.line_sheet_id ?? null;
            resolvedCustomerId = resolvedCustomerId ?? snap.customer_id ?? null;
          } else {
            // Token present but unknown — keep it on the order as a breadcrumb,
            // but don't pretend we verified anything.
            exportToken = null;
          }
        }

        const order = await db.createOrder({
          customer_id: resolvedCustomerId,
          line_sheet_id: resolvedLineSheetId,
          name: req.body.name || `Order ${new Date().toISOString().slice(0, 10)}`,
          notes: req.body.notes || null,
          location_ids: locationIds,
          items,
          source_filename: req.file.originalname || null,
          export_token: exportToken,
          price_mismatches: priceMismatches
        });

        res.json({ order });
      } catch (e) {
        res.status(400).json({ error: String(e?.message || e) });
      }
    });
  }

  // ------- get / update / archive / duplicate -------
  r.get("/api/orders-draft/:id", async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(404).json({ error: "Not found" });
    try {
      const row = await db.getOrder(id);
      if (!row) return res.status(404).json({ error: "Not found" });
      const previews = await db.listPreviewSnapshots(id);
      res.json({ order: row, previews });
    } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  r.put("/api/orders-draft/:id", async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(404).json({ error: "Not found" });
    try {
      const row = await db.updateOrder(id, req.body || {});
      if (!row) return res.status(404).json({ error: "Not found, archived, or already submitted" });
      res.json({ order: row });
    } catch (e) { res.status(400).json({ error: String(e?.message || e) }); }
  });

  r.delete("/api/orders-draft/:id", async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(404).json({ error: "Not found" });
    try {
      const ok = await db.archiveOrder(id);
      res.json({ ok });
    } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  r.post("/api/orders-draft/:id/duplicate", async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(404).json({ error: "Not found" });
    try {
      const row = await db.duplicateOrder(id);
      if (!row) return res.status(404).json({ error: "Not found" });
      res.json({ order: row });
    } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  // ------- resolve price mismatches -------
  // strategy: "snapshot" rewrites unit_price to the originally-exported PPU;
  //           "customer" accepts the customer's submitted prices.
  // Either way, price_mismatches is cleared.
  r.post("/api/orders-draft/:id/resolve-mismatches", async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(404).json({ error: "Not found" });
    const strategy = String(req.body?.strategy || "").toLowerCase();
    if (strategy !== "snapshot" && strategy !== "customer") {
      return res.status(400).json({ error: "strategy must be 'snapshot' or 'customer'" });
    }
    try {
      const order = await db.getOrder(id);
      if (!order) return res.status(404).json({ error: "Not found" });

      let ppuByHandle = {};
      if (strategy === "snapshot") {
        if (!order.export_token) {
          return res.status(400).json({ error: "No export token on this draft; cannot restore snapshot prices." });
        }
        const snap = await getExportByToken(order.export_token);
        if (!snap) {
          return res.status(400).json({ error: "Export snapshot not found for this draft." });
        }
        for (const r of (Array.isArray(snap.items) ? snap.items : [])) {
          ppuByHandle[String(r.handle)] = Math.round(Number(r.ppu) * 100) / 100;
        }
      }

      const updated = await db.resolvePriceMismatches(id, strategy, ppuByHandle);
      if (!updated) return res.status(409).json({ error: "Order is archived or already submitted." });
      res.json({ order: updated });
    } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  // ------- preview snapshots -------
  r.get("/api/orders-draft/:id/previews", async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(404).json({ error: "Not found" });
    try {
      res.json({ previews: await db.listPreviewSnapshots(id) });
    } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  r.get("/api/orders-draft/:id/previews/:snapshotId", async (req, res) => {
    const id = parseId(req.params.id);
    const snapshotId = parseId(req.params.snapshotId);
    if (id === null || snapshotId === null) return res.status(404).json({ error: "Not found" });
    try {
      const snap = await db.getPreviewSnapshot(snapshotId);
      if (!snap || snap.order_id !== id) return res.status(404).json({ error: "Not found" });
      res.json({ preview: snap });
    } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  // ------- run preview against the draft -------
  // Allocates against current inventory, saves a snapshot, sets status='previewed'.
  // Does NOT touch Shopify.
  r.post("/api/orders-draft/:id/preview", async (req, res) => {
    if (!runAllocation) {
      return res.status(500).json({ error: "Allocator not wired into orders router." });
    }
    const id = parseId(req.params.id);
    if (id === null) return res.status(404).json({ error: "Not found" });
    try {
      const order = await db.getOrder(id);
      if (!order) return res.status(404).json({ error: "Not found" });
      if (order.archived_at) return res.status(409).json({ error: "Order is archived." });
      if (order.status === "submitted") {
        return res.status(409).json({ error: "Order already submitted; previews are read-only." });
      }
      if (!Array.isArray(order.location_ids) || order.location_ids.length === 0) {
        return res.status(400).json({ error: "Pick at least one location before running preview." });
      }
      const items = Array.isArray(order.items) ? order.items : [];
      if (items.length === 0) {
        return res.status(400).json({ error: "Add at least one item before running preview." });
      }

      // Build the requested-items shape the allocator wants.
      const requested = items
        .map((it) => ({
          handle: String(it.handle || "").trim(),
          unitPrice: Number(it.unit_price ?? it.unitPrice ?? 0),
          sizeQty: it.size_qty || it.sizeQty || {}
        }))
        .filter((it) => it.handle);

      let customerName = "";
      if (order.customer_id) {
        const c = await customersDb.getCustomer(order.customer_id);
        customerName = c?.name || "";
      }

      const result = await runAllocation({
        locationIdsInOrder: order.location_ids,
        requested,
        customer: customerName,
        notes: order.notes || "",
        uploadFileName: order.source_filename || `${(order.name || "draft").replace(/\W+/g, "_")}.xlsx`
      });

      // Snapshot what's safe to serialize (allocationPlan is a Map; recompute on submit).
      const snapshot = {
        report: result.report,
        locationIdToName: result.locationIdToName,
        locationIdsInOrder: result.locationIdsInOrder,
        metaByHandle: result.metaByHandle,
        customer: result.customer,
        notes: result.notes,
        uploadFileName: result.uploadFileName,
        ranAt: new Date().toISOString()
      };

      const saved = await db.savePreviewSnapshot(id, snapshot);
      if (!saved) return res.status(409).json({ error: "Could not save snapshot (order missing or already submitted)." });

      const fresh = await db.getOrder(id);
      res.json({ order: fresh, preview: { ...saved, snapshot } });
    } catch (e) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // ------- submit draft to Shopify -------
  // Re-runs allocation (in case inventory changed since the last preview), then
  // creates the Shopify order(s). Marks the draft as 'submitted' on success.
  r.post("/api/orders-draft/:id/submit", async (req, res) => {
    if (!runAllocation || !submitAllocationToShopify) {
      return res.status(500).json({ error: "Submission helpers not wired into orders router." });
    }
    const id = parseId(req.params.id);
    if (id === null) return res.status(404).json({ error: "Not found" });
    try {
      const order = await db.getOrder(id);
      if (!order) return res.status(404).json({ error: "Not found" });
      if (order.archived_at) return res.status(409).json({ error: "Order is archived." });
      if (order.status === "submitted") {
        return res.status(409).json({ error: "Already submitted.", shopify_order_id: order.shopify_order_id });
      }
      if (!Array.isArray(order.location_ids) || order.location_ids.length === 0) {
        return res.status(400).json({ error: "Pick at least one location before submitting." });
      }
      const items = Array.isArray(order.items) ? order.items : [];
      if (items.length === 0) {
        return res.status(400).json({ error: "No items to submit." });
      }

      const requested = items
        .map((it) => ({
          handle: String(it.handle || "").trim(),
          unitPrice: Number(it.unit_price ?? it.unitPrice ?? 0),
          sizeQty: it.size_qty || it.sizeQty || {}
        }))
        .filter((it) => it.handle);

      let customerName = "";
      if (order.customer_id) {
        const c = await customersDb.getCustomer(order.customer_id);
        customerName = c?.name || "";
      }

      const allocResult = await runAllocation({
        locationIdsInOrder: order.location_ids,
        requested,
        customer: customerName,
        notes: order.notes || "",
        uploadFileName: order.source_filename || `${(order.name || "draft").replace(/\W+/g, "_")}.xlsx`
      });

      if (!allocResult.draftLineItems.length) {
        return res.status(400).json({
          error: "Nothing fulfillable from selected locations.",
          report: allocResult.report
        });
      }

      const reserveHours = Number(req.body?.reserveHours ?? 48);
      const { orderResults, attachments } = await submitAllocationToShopify({
        ...allocResult,
        reserveHours
      });

      const first = orderResults[0];
      const updated = await db.markSubmitted(id, {
        shopify_order_id: first?.orderId || null,
        shopify_order_name: first?.orderName || null
      });

      // Send the same email the legacy /api/import sends. If SendGrid isn't
      // configured this is a no-op.
      let emailStatus = null;
      if (sendEmailWithAttachments && attachments.length) {
        try {
          const orderNames = orderResults.map((o) => o.orderName).join(", ");
          emailStatus = await sendEmailWithAttachments({
            subject: orderResults.length > 1
              ? `Wholesale Orders ${orderNames} — Final XLSX + Packing Slips`
              : `Wholesale Order ${first.orderName} — Final XLSX + Packing Slip`,
            text:
              `Order(s): ${orderNames}\n` +
              `Customer: ${customerName || "(none)"}\n` +
              `Notes: ${order.notes || "(none)"}\n` +
              `Requested: ${allocResult.report.requestedUnits}, ` +
              `Allocated: ${allocResult.report.allocatedUnits}, ` +
              `Dropped: ${allocResult.report.droppedUnits}\n`,
            attachments
          });
        } catch (e) {
          emailStatus = { error: String(e?.message || e) };
        }
      }

      const fresh = await db.getOrder(id);
      res.json({
        ok: true,
        order: fresh || updated,
        orderResults,
        report: allocResult.report,
        emailStatus
      });
    } catch (e) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // ------- draft order PDF -------
  r.get("/api/orders-draft/:id/draft-order.pdf", async (req, res) => {
    if (!renderPdfFromHtml) {
      return res.status(503).json({ error: "PDF renderer not wired into orders router." });
    }
    const id = parseId(req.params.id);
    if (id === null) return res.status(404).json({ error: "Not found" });
    try {
      const order = await db.getOrder(id);
      if (!order) return res.status(404).json({ error: "Not found" });

      // Use the latest preview snapshot (even if stale) so the PDF reflects
      // the most recent allocation run. Falls back gracefully if none exists.
      const snap = await db.getLatestPreviewSnapshot(id);
      const snapshot = snap?.snapshot || null;

      const html = buildDraftOrderHtml({ order, snapshot });
      const { pdfBuffer } = await renderPdfFromHtml(html, null, {
        format: "Letter",
        printBackground: true
      });
      if (!pdfBuffer) return res.status(500).json({ error: "PDF generation failed." });

      const safe = String(order.name || `draft-${id}`)
        .replace(/[^A-Za-z0-9\-_ ]+/g, "").replace(/\s+/g, "_") || `draft-${id}`;
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="${safe}_order.pdf"`);
      res.send(Buffer.from(pdfBuffer));
    } catch (e) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  return r;
}
