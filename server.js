// server.js
import express from "express";
import multer from "multer";
import { parse as parseCsv } from "csv-parse/sync";
import XLSX from "xlsx";
import path from "path";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.static("public"));

const SHOP = process.env.SHOPIFY_SHOP; // must be *.myshopify.com
const VERSION = process.env.SHOPIFY_API_VERSION || "2025-01";

// Option A: long-lived Admin token (custom app created inside Shopify admin)
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

// Option B: client credentials (Dev Dashboard style) => mint 24h token
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

if (!SHOP) {
  console.error("Missing SHOPIFY_SHOP env var (must be your *.myshopify.com domain).");
  process.exit(1);
}
if (!ADMIN_TOKEN && !(CLIENT_ID && CLIENT_SECRET)) {
  console.error(
    "Missing auth env vars. Provide either SHOPIFY_ADMIN_TOKEN OR (SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET)."
  );
  process.exit(1);
}

const SIZES = ["XXS", "XS", "S", "M", "L", "XL", "XXL"];
const AUTO_TAGS = ["Wholesale"];

// Speed: cache product lookups across requests (safe + huge speed win)
const productCache = new Map(); // handle -> productByHandle result or null

// ----------------- Auth: access token -----------------

let cachedAccessToken = null;
let tokenExpiresAtMs = 0;

async function getAccessToken() {
  if (ADMIN_TOKEN) return ADMIN_TOKEN;

  const now = Date.now();
  if (cachedAccessToken && now < tokenExpiresAtMs - 5 * 60_000) return cachedAccessToken;

  const url = `https://${SHOP}/admin/oauth/access_token`;
  const body = new URLSearchParams();
  body.set("grant_type", "client_credentials");
  body.set("client_id", CLIENT_ID);
  body.set("client_secret", CLIENT_SECRET);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  const json = await res.json();
  if (!res.ok || !json.access_token) {
    throw new Error(`Token exchange failed: ${res.status} ${JSON.stringify(json)}`);
  }

  cachedAccessToken = json.access_token;
  const expiresInSec = Number(json.expires_in || 86400);
  tokenExpiresAtMs = Date.now() + expiresInSec * 1000;
  return cachedAccessToken;
}

// ----------------- Shopify GraphQL helper -----------------

async function shopifyGraphQL(query, variables = {}) {
  const token = await getAccessToken();

  const res = await fetch(`https://${SHOP}/admin/api/${VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token
    },
    body: JSON.stringify({ query, variables })
  });

  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors, null, 2));
  return json.data;
}

// ----------------- Currency code (for priceOverride) -----------------

let cachedCurrencyCode = null;

async function getShopCurrencyCode() {
  if (cachedCurrencyCode) return cachedCurrencyCode;
  const q = `query { shop { currencyCode } }`;
  const data = await shopifyGraphQL(q, {});
  cachedCurrencyCode = data.shop.currencyCode;
  return cachedCurrencyCode;
}

// ----------------- Shopify queries/mutations -----------------

async function getAllLocations() {
  const q = `
    query Locations($first: Int!, $after: String) {
      locations(first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { id name }
      }
    }
  `;
  let after = null;
  const out = [];
  for (;;) {
    const data = await shopifyGraphQL(q, { first: 100, after });
    out.push(...data.locations.nodes);
    if (!data.locations.pageInfo.hasNextPage) break;
    after = data.locations.pageInfo.endCursor;
  }
  return out;
}

async function getProductVariantsByHandle(handle) {
  const q = `
    query ProductByHandle($handle: String!) {
      productByHandle(handle: $handle) {
        id
        title
        variants(first: 100) {
          nodes {
            id
            title
            selectedOptions { name value }
            inventoryItem { id }
          }
        }
      }
    }
  `;
  const data = await shopifyGraphQL(q, { handle });
  return data.productByHandle;
}

// Shopify: inventory via inventoryItem.inventoryLevel(locationId)
async function getAvailableAtLocation(inventoryItemId, locationId) {
  const q = `
    query Inv($inventoryItemId: ID!, $locationId: ID!) {
      inventoryItem(id: $inventoryItemId) {
        inventoryLevel(locationId: $locationId) {
          quantities(names: ["available"]) { name quantity }
        }
      }
    }
  `;
  const data = await shopifyGraphQL(q, { inventoryItemId, locationId });

  const level = data.inventoryItem?.inventoryLevel;
  if (!level) return 0;
  const avail = level.quantities.find(x => x.name === "available")?.quantity ?? 0;
  return Number(avail) || 0;
}

function findVariantForSize(variants, size) {
  // Robust: match any option whose name includes "size" (case-insensitive)
  const sizeLower = String(size).toLowerCase();
  return (
    variants.find(v =>
      v.selectedOptions.some(o => String(o.name).toLowerCase().includes("size") && String(o.value).toLowerCase() === sizeLower)
    ) || null
  );
}

// ---------- Allocation (best-effort, partial allowed) ----------

// Key: `${inventoryItemId}::${locationId}` -> remaining available during THIS run
function makeAvailKey(inventoryItemId, locationId) {
  return `${inventoryItemId}::${locationId}`;
}

// Allocation: split across locations in given priority order, KEEP PARTIALS.
// Uses remainingAvailMap to decrement availability in-memory for the run.
async function allocateVariantQty({
  inventoryItemId,
  requestedQty,
  locationIdsInOrder,
  remainingAvailMap,
  availabilityDebug
}) {
  let remaining = requestedQty;
  const allocations = [];

  for (const locId of locationIdsInOrder) {
    if (remaining <= 0) break;

    const key = makeAvailKey(inventoryItemId, locId);

    if (!remainingAvailMap.has(key)) {
      const avail = await getAvailableAtLocation(inventoryItemId, locId);
      remainingAvailMap.set(key, avail);
      if (availabilityDebug) availabilityDebug[locId] = Math.max(0, avail); // report safety
    }

    const availNow = remainingAvailMap.get(key) || 0;
    if (availNow <= 0) continue;

    const take = Math.min(availNow, remaining);
    if (take > 0) {
      allocations.push({ locationId: locId, qty: take });
      remainingAvailMap.set(key, availNow - take);
      remaining -= take;
    }
  }

  return { allocations, dropped: remaining };
}

// Draft create with Wholesale tag + priceOverride
async function draftOrderCreate({ lineItems, reserveHours }) {
  const reserveUntilIso =
    reserveHours && Number(reserveHours) > 0
      ? new Date(Date.now() + Number(reserveHours) * 3600_000).toISOString()
      : null;

  const currencyCode = await getShopCurrencyCode();

  const mutation = `
    mutation CreateDraft($input: DraftOrderInput!) {
      draftOrderCreate(input: $input) {
        draftOrder { id invoiceUrl }
        userErrors { field message }
      }
    }
  `;

  const input = {
    tags: AUTO_TAGS,
    lineItems: lineItems.map(li => ({
      variantId: li.variantId,
      quantity: li.quantity,
      priceOverride: { amount: String(li.unitPrice), currencyCode }
    }))
  };

  if (reserveUntilIso) input.reserveInventoryUntil = reserveUntilIso;

  const data = await shopifyGraphQL(mutation, { input });
  const errs = data.draftOrderCreate.userErrors || [];
  if (errs.length) throw new Error(`draftOrderCreate errors: ${JSON.stringify(errs, null, 2)}`);
  return data.draftOrderCreate.draftOrder;
}

// Complete draft as unpaid
async function draftOrderComplete(draftOrderId) {
  const mutation = `
    mutation CompleteDraft($id: ID!, $paymentPending: Boolean!) {
      draftOrderComplete(id: $id, paymentPending: $paymentPending) {
        draftOrder { id order { id name } }
        userErrors { field message }
      }
    }
  `;
  const data = await shopifyGraphQL(mutation, { id: draftOrderId, paymentPending: true });
  const errs = data.draftOrderComplete.userErrors || [];
  if (errs.length) throw new Error(`draftOrderComplete errors: ${JSON.stringify(errs, null, 2)}`);
  return data.draftOrderComplete.draftOrder.order;
}

async function getFulfillmentOrdersForOrder(orderId) {
  const q = `
    query OrderFOs($id: ID!) {
      order(id: $id) {
        fulfillmentOrders(first: 50) {
          nodes {
            id
            assignedLocation { location { id name } }
            status
            lineItems(first: 250) {
              nodes {
                id
                remainingQuantity
                lineItem { variant { id } }
              }
            }
          }
        }
      }
    }
  `;
  const data = await shopifyGraphQL(q, { id: orderId });
  return data.order.fulfillmentOrders.nodes;
}

async function fulfillmentOrderMove({ fulfillmentOrderId, newLocationId, moveLineItems }) {
  const m = `
    mutation MoveFO($id: ID!, $newLocationId: ID!, $items: [FulfillmentOrderLineItemInput!]!) {
      fulfillmentOrderMove(
        id: $id,
        newLocationId: $newLocationId,
        fulfillmentOrderLineItems: $items
      ) {
        movedFulfillmentOrder { id status assignedLocation { location { id name } } }
        originalFulfillmentOrder { id status assignedLocation { location { id name } } }
        userErrors { field message }
      }
    }
  `;

  const data = await shopifyGraphQL(m, {
    id: fulfillmentOrderId,
    newLocationId,
    items: moveLineItems
  });

  const errs = data.fulfillmentOrderMove.userErrors || [];
  if (errs.length) throw new Error(`fulfillmentOrderMove errors: ${JSON.stringify(errs, null, 2)}`);
  return data.fulfillmentOrderMove;
}

// Enforce allocation by moving FO line items; re-fetch after moves (handles Shopify splitting FOs)
async function enforceFulfillmentLocations(orderId, allocationPlan) {
  const moveLog = [];

  for (const [variantId, desiredAllocations] of allocationPlan.entries()) {
    for (const want of desiredAllocations) {
      let need = want.qty;
      if (need <= 0) continue;

      while (need > 0) {
        const fos = await getFulfillmentOrdersForOrder(orderId);

        let source = null;

        for (const fo of fos) {
          const foLocId = fo.assignedLocation?.location?.id;

          for (const li of fo.lineItems.nodes) {
            const vId = li.lineItem?.variant?.id;
            if (vId !== variantId) continue;
            if ((li.remainingQuantity || 0) <= 0) continue;

            // If already at desired location, just consume need (no move)
            if (foLocId === want.locationId) {
              const take = Math.min(li.remainingQuantity, need);
              need -= take;
              source = null;
              break;
            }

            source = {
              fulfillmentOrderId: fo.id,
              fulfillmentOrderLineItemId: li.id,
              remainingQuantity: li.remainingQuantity,
              fromLocation: fo.assignedLocation?.location?.name || "Unknown"
            };
            break;
          }
          if (need <= 0) break;
          if (source) break;
        }

        if (need <= 0) break;
        if (!source) break;

        const moveQty = Math.min(source.remainingQuantity, need);

        const result = await fulfillmentOrderMove({
          fulfillmentOrderId: source.fulfillmentOrderId,
          newLocationId: want.locationId,
          moveLineItems: [{ id: source.fulfillmentOrderLineItemId, quantity: moveQty }]
        });

        moveLog.push({
          variantId,
          movedQty: moveQty,
          from: source.fromLocation,
          toLocationId: want.locationId,
          movedFulfillmentOrder: result.movedFulfillmentOrder?.id || null,
          originalFulfillmentOrder: result.originalFulfillmentOrder?.id || null
        });

        need -= moveQty;
      }
    }
  }

  return moveLog;
}

async function summarizeFulfillmentByLocation(orderId) {
  const fos = await getFulfillmentOrdersForOrder(orderId);

  const summary = {};
  const detail = fos.map(fo => {
    const locName = fo.assignedLocation?.location?.name || "Unknown";
    const qty = fo.lineItems.nodes.reduce((s, li) => s + (li.remainingQuantity || 0), 0);
    summary[locName] = (summary[locName] || 0) + qty;

    return {
      fulfillmentOrderId: fo.id,
      location: locName,
      locationId: fo.assignedLocation?.location?.id || null,
      status: fo.status,
      lines: fo.lineItems.nodes.map(li => ({
        fulfillmentOrderLineItemId: li.id,
        variantId: li.lineItem?.variant?.id || null,
        remainingQuantity: li.remainingQuantity
      }))
    };
  });

  return { summary, fulfillmentOrders: detail };
}

// ----------------- Upload parsing (CSV + XLSX) -----------------

function parseUpload(file) {
  const ext = path.extname(file.originalname || "").toLowerCase();

  if (ext === ".csv") {
    const text = file.buffer.toString("utf8");
    return parseCsv(text, {
      columns: true,
      skip_empty_lines: true,
      trim: true
    });
  }

  if (ext === ".xlsx") {
    const workbook = XLSX.read(file.buffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    return XLSX.utils.sheet_to_json(sheet, { defval: "" });
  }

  throw new Error("Unsupported file type. Upload CSV or XLSX.");
}

// ----------------- Report XLSX builder (1 sheet per used location) -----------------

function safeSheetName(name) {
  return String(name).replace(/[\[\]\*\/\\\?\:]/g, " ").slice(0, 31) || "Sheet";
}

/**
 * Builds XLSX where:
 * - One sheet per location actually used in allocations
 * - Rows = Product Title (primary), with Handle as a second column
 * - Columns = XXS..XXL, values = fulfillable qty FROM THAT LOCATION
 */
function buildLocationWorkbook({ locationIdToName, availabilitySeen, productMetaByHandle }) {
  const sizes = ["XXS", "XS", "S", "M", "L", "XL", "XXL"];

  // locationId -> handle -> size -> qty
  const locMap = new Map();

  for (const entry of availabilitySeen) {
    const handle = entry.handle;
    const size = entry.size;

    for (const a of entry.allocations || []) {
      const locId = a.locationId;
      const qty = Number(a.qty || 0);
      if (!qty) continue;

      if (!locMap.has(locId)) locMap.set(locId, new Map());
      const handleMap = locMap.get(locId);

      if (!handleMap.has(handle)) {
        const sizeMap = new Map();
        for (const s of sizes) sizeMap.set(s, 0);
        handleMap.set(handle, sizeMap);
      }

      const sizeMap = handleMap.get(handle);
      sizeMap.set(size, (sizeMap.get(size) || 0) + qty);
    }
  }

  const wb = XLSX.utils.book_new();

  for (const [locId, handleMap] of locMap.entries()) {
    const locName = locationIdToName[locId] || locId;

    // Header: Title + Handle
    const header = ["Product Title", "Handle", ...sizes, "Total"];
    const rows = [header];

    // Build rows; sort by title then handle
    const handles = Array.from(handleMap.keys());
    handles.sort((a, b) => {
      const ta = (productMetaByHandle[a]?.title || "").toLowerCase();
      const tb = (productMetaByHandle[b]?.title || "").toLowerCase();
      if (ta < tb) return -1;
      if (ta > tb) return 1;
      return a.localeCompare(b);
    });

    for (const handle of handles) {
      const sizeMap = handleMap.get(handle);
      const title = productMetaByHandle[handle]?.title || "";

      const row = [title, handle];
      let total = 0;

      for (const s of sizes) {
        const v = Number(sizeMap.get(s) || 0);
        row.push(v);
        total += v;
      }
      row.push(total);
      rows.push(row);
    }

    // Totals row
    const totalsRow = ["TOTAL", "", ...sizes.map(() => 0), 0];
    for (let r = 1; r < rows.length; r++) {
      for (let c = 2; c < 2 + sizes.length; c++) totalsRow[c] += rows[r][c];
      totalsRow[2 + sizes.length] += rows[r][2 + sizes.length];
    }
    rows.push([]);
    rows.push(totalsRow);

    const ws = XLSX.utils.aoa_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, safeSheetName(locName));
  }

  // If nothing allocated anywhere, still return a workbook with one sheet explaining it
  if (wb.SheetNames.length === 0) {
    const ws = XLSX.utils.aoa_to_sheet([["No fulfillable units in selected locations."]]);
    XLSX.utils.book_append_sheet(wb, ws, "Report");
  }

  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

// ----------------- Shared allocator used by Preview / Import / Report -----------------

async function runAllocationOnly(req) {
  const { locationIdsJson } = req.body;

  const locationIdsInOrder = JSON.parse(locationIdsJson || "[]");
  if (!Array.isArray(locationIdsInOrder) || locationIdsInOrder.length === 0) {
    throw new Error("Select at least one location.");
  }
  if (!req.file?.buffer) throw new Error("Missing CSV/XLSX file.");

  const locations = await getAllLocations();
  const locationIdToName = Object.fromEntries(locations.map(l => [l.id, l.name]));

  const records = parseUpload(req.file);

  const requested = [];
  for (const row of records) {
    const handle = (row.product_handle || "").toString().trim();
    if (!handle) continue;

    const unitPrice = Number((row.unit_price ?? "").toString().trim());
    if (!Number.isFinite(unitPrice)) throw new Error(`Invalid unit_price for handle ${handle}`);

    const sizeQty = {};
    for (const s of SIZES) {
      const n = Number((row[s] ?? "").toString().trim() || 0);
      sizeQty[s] = Number.isFinite(n) ? n : 0;
    }

    requested.push({ handle, unitPrice, sizeQty });
  }

  const remainingAvailMap = new Map();
  const allocationPlan = new Map(); // variantId -> [{locationId, qty}]
  const draftLineItems = []; // [{variantId, quantity, unitPrice}]
  const productMetaByHandle = {}; // handle -> {title}

  const report = {
    tagApplied: AUTO_TAGS,
    requestedUnits: 0,
    allocatedUnits: 0,
    droppedUnits: 0,
    missingHandles: [],
    availabilitySeen: [],
    lines: []
  };

  for (const item of requested) {
    let product = productCache.get(item.handle);
    if (product === undefined) {
      product = await getProductVariantsByHandle(item.handle);
      productCache.set(item.handle, product || null);
    }

    if (!product) {
      report.missingHandles.push(item.handle);
      continue;
    }

    productMetaByHandle[item.handle] = { title: product.title };

    for (const size of SIZES) {
      const qty = item.sizeQty[size];
      if (!qty || qty <= 0) continue;

      report.requestedUnits += qty;

      const variant = findVariantForSize(product.variants.nodes, size);
      if (!variant) {
        report.droppedUnits += qty;
        report.lines.push({
          handle: item.handle,
          size,
          requested: qty,
          allocated: 0,
          dropped: qty,
          reason: "No variant for size"
        });
        continue;
      }

      const availabilityDebug = {};
      const { allocations, dropped } = await allocateVariantQty({
        inventoryItemId: variant.inventoryItem.id,
        requestedQty: qty,
        locationIdsInOrder,
        remainingAvailMap,
        availabilityDebug
      });

      report.availabilitySeen.push({
        handle: item.handle,
        size,
        inventoryItemId: variant.inventoryItem.id,
        availabilityByLocationId: availabilityDebug,
        allocations
      });

      const allocatedQty = allocations.reduce((sum, a) => sum + a.qty, 0);

      if (allocatedQty > 0) {
        const priceStr = String(item.unitPrice);

        const existing = draftLineItems.find(
          li => li.variantId === variant.id && li.unitPrice === priceStr
        );
        if (existing) existing.quantity += allocatedQty;
        else draftLineItems.push({ variantId: variant.id, quantity: allocatedQty, unitPrice: priceStr });

        const prev = allocationPlan.get(variant.id) || [];
        const merged = [...prev];
        for (const a of allocations) {
          const m = merged.find(x => x.locationId === a.locationId);
          if (m) m.qty += a.qty;
          else merged.push({ locationId: a.locationId, qty: a.qty });
        }
        allocationPlan.set(variant.id, merged);

        report.allocatedUnits += allocatedQty;
      }

      if (dropped > 0) report.droppedUnits += dropped;

      report.lines.push({
        handle: item.handle,
        size,
        requested: qty,
        allocated: allocatedQty,
        dropped,
        reason: dropped > 0 ? "Insufficient stock in selected locations" : ""
      });
    }
  }

  return { report, allocationPlan, draftLineItems, locationIdToName, productMetaByHandle, locationIdsInOrder };
}

// ----------------- Routes -----------------

app.get("/api/locations", async (_req, res) => {
  try {
    const locations = await getAllLocations();
    res.json({ locations });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Preview only (no draft/order created)
app.post("/api/preview", upload.single("file"), async (req, res) => {
  try {
    const result = await runAllocationOnly(req);
    res.json({ ok: true, mode: "preview", ...result });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// XLSX report (one sheet per used location)
app.post("/api/report.xlsx", upload.single("file"), async (req, res) => {
  try {
    const result = await runAllocationOnly(req);
    const xlsxBuffer = buildLocationWorkbook({
      locationIdToName: result.locationIdToName,
      availabilitySeen: result.report.availabilitySeen,
      productMetaByHandle: result.productMetaByHandle
    });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename="fulfillment_report.xlsx"`);
    res.send(xlsxBuffer);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Import (draft -> complete unpaid -> move fulfillment)
app.post("/api/import", upload.single("file"), async (req, res) => {
  try {
    const { reserveHours = "48" } = req.body;

    const {
      report,
      allocationPlan,
      draftLineItems,
      locationIdToName,
      productMetaByHandle
    } = await runAllocationOnly(req);

    if (draftLineItems.length === 0) {
      return res.status(400).json({
        error: "Nothing fulfillable from selected locations. No order created.",
        report
      });
    }

    // Create draft (tagged Wholesale) with priceOverride
    const draft = await draftOrderCreate({
      lineItems: draftLineItems,
      reserveHours: Number(reserveHours)
    });

    // Complete => real order (UNPAID)
    const order = await draftOrderComplete(draft.id);

    // Enforce fulfillment locations
    const moveLog = await enforceFulfillmentLocations(order.id, allocationPlan);

    // Final fulfillment snapshot
    const finalFulfillment = await summarizeFulfillmentByLocation(order.id);

    res.json({
      ok: true,
      tags: AUTO_TAGS,
      draftOrderId: draft.id,
      orderId: order.id,
      orderName: order.name,
      moveLog,
      report,
      finalFulfillment,
      locationIdToName,
      productMetaByHandle
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Wholesale importer running on http://localhost:${port}`));
