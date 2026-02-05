// server.js
import express from "express";
import multer from "multer";
import { parse as parseCsv } from "csv-parse/sync";
import XLSX from "xlsx";
import path from "path";
import crypto from "crypto";
import ExcelJS from "exceljs";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.static("public"));

const SHOP = process.env.SHOPIFY_SHOP; // must be *.myshopify.com
const VERSION = process.env.SHOPIFY_API_VERSION || "2025-01";

// Option A: long-lived Admin token (custom app created inside Shopify admin)
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

// Option B: client credentials => mint token
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
const AUTO_TAGS = ["Wholesale", "Spreadsheet"];

// Cache product lookups across requests
const productCache = new Map(); // handle -> productByHandle result or null

// ----------------- Run store (so reports match runs) -----------------

const runStore = new Map(); // runId -> { createdAt, ...payload }
const RUN_TTL_MS = 30 * 60 * 1000;

function newRunId() {
  return crypto.randomBytes(12).toString("hex");
}

function saveRun(payload) {
  const runId = newRunId();
  runStore.set(runId, { createdAt: Date.now(), ...payload });
  return runId;
}

function getRun(runId) {
  const r = runStore.get(runId);
  if (!r) return null;
  if (Date.now() - r.createdAt > RUN_TTL_MS) {
    runStore.delete(runId);
    return null;
  }
  return r;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, r] of runStore.entries()) {
    if (now - r.createdAt > RUN_TTL_MS) runStore.delete(id);
  }
}, 5 * 60 * 1000);

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

  const reqId = res.headers.get("x-request-id") || res.headers.get("x-shopify-request-id") || null;

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }

  if (!res.ok || json.errors) {
    const detail = {
      status: res.status,
      requestId: reqId,
      errors: json.errors || null,
      raw: json.raw || null
    };
    throw new Error(`Shopify GraphQL error: ${JSON.stringify(detail, null, 2)}`);
  }

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
        featuredImage { url }
        images(first: 1) { nodes { url } }
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
  const sizeLower = String(size).toLowerCase();
  return (
    variants.find(v =>
      v.selectedOptions.some(
        o =>
          String(o.name).toLowerCase().includes("size") &&
          String(o.value).toLowerCase() === sizeLower
      )
    ) || null
  );
}

// ---------- Allocation (best-effort, partial allowed) ----------

function makeAvailKey(inventoryItemId, locationId) {
  return `${inventoryItemId}::${locationId}`;
}

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
    }

    const availNow = remainingAvailMap.get(key) || 0;
    if (availabilityDebug) availabilityDebug[locId] = Math.max(0, availNow);

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

// Draft create with Wholesale tag + priceOverride + optional reserveInventoryUntil
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
                lineItem { id variant { id inventoryItem { id } } }
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

async function waitForFulfillmentOrders(orderId, maxRetries = 30, delayMs = 500) {
  for (let i = 0; i < maxRetries; i++) {
    const fos = await getFulfillmentOrdersForOrder(orderId);
    if (fos.length > 0) return fos;
    await new Promise(r => setTimeout(r, delayMs));
  }
  throw new Error(`Fulfillment orders not created after ${Math.round((maxRetries * delayMs) / 1000)}s`);
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

// ----------------- Rebalance logic -----------------

function buildCurrentAllocationFromFOs(fos) {
  const byVariant = new Map();
  for (const fo of fos) {
    const locId = fo.assignedLocation?.location?.id || null;
    if (!locId) continue;

    for (const n of fo.lineItems.nodes) {
      const variantId = n.lineItem?.variant?.id || null;
      const qty = Number(n.remainingQuantity || 0);
      if (!variantId || qty <= 0) continue;

      if (!byVariant.has(variantId)) byVariant.set(variantId, new Map());
      const byLoc = byVariant.get(variantId);

      if (!byLoc.has(locId)) byLoc.set(locId, []);
      byLoc.get(locId).push({
        fulfillmentOrderId: fo.id,
        fulfillmentOrderLineItemId: n.id,
        qty
      });
    }
  }
  return byVariant;
}

async function enforceFulfillmentLocationsRebalance({
  orderId,
  allocationPlan,
  allowedLocationIds,
  drainOrderLocationIds
}) {
  const moveLog = [];
  const blocked = [];

  const allowedSet = new Set(allowedLocationIds);
  const drainIndex = new Map(drainOrderLocationIds.map((id, idx) => [id, idx]));

  const destRemain = new Map(); // inventoryItemId::locationId -> remaining cap

  async function getDestRemainMonotonic(inventoryItemId, locationId) {
    const key = `${inventoryItemId}::${locationId}`;
    const live = Math.max(0, Number(await getAvailableAtLocation(inventoryItemId, locationId)) || 0);

    if (!destRemain.has(key)) {
      destRemain.set(key, live);
      return live;
    }
    const cur = destRemain.get(key);
    const merged = Math.min(cur, live);
    destRemain.set(key, merged);
    return merged;
  }

  function consumeDestRemain(inventoryItemId, locationId, qty) {
    const key = `${inventoryItemId}::${locationId}`;
    const cur = destRemain.get(key) ?? 0;
    destRemain.set(key, Math.max(0, cur - qty));
  }

  const fos = await getFulfillmentOrdersForOrder(orderId);
  const currentByVariant = buildCurrentAllocationFromFOs(fos);

  for (const [variantId, plan] of allocationPlan.entries()) {
    const inventoryItemId = plan.inventoryItemId;

    const desiredByLoc = new Map();
    for (const a of plan.allocations || []) {
      if (!allowedSet.has(a.locationId)) continue;
      desiredByLoc.set(a.locationId, (desiredByLoc.get(a.locationId) || 0) + Number(a.qty || 0));
    }

    const curLocLines = currentByVariant.get(variantId) || new Map();
    const currentByLoc = new Map();
    for (const [locId, lines] of curLocLines.entries()) {
      const total = lines.reduce((s, x) => s + x.qty, 0);
      currentByLoc.set(locId, total);
    }

    const needs = [];
    for (const [locId, desiredQty] of desiredByLoc.entries()) {
      const currentQty = currentByLoc.get(locId) || 0;
      const delta = desiredQty - currentQty;
      if (delta > 0) needs.push({ locId, qty: delta });
    }

    const excesses = [];
    for (const [locId, currentQty] of currentByLoc.entries()) {
      const desiredQty = desiredByLoc.get(locId) || 0;
      const delta = currentQty - desiredQty;
      if (delta > 0) excesses.push({ locId, qty: delta, disallowed: !allowedSet.has(locId) });
    }

    needs.sort((a, b) => (drainIndex.get(a.locId) ?? 9999) - (drainIndex.get(b.locId) ?? 9999));
    excesses.sort((a, b) => Number(b.disallowed) - Number(a.disallowed));

    for (const need of needs) {
      let remainingNeed = need.qty;

      while (remainingNeed > 0) {
        if (!allowedSet.has(need.locId)) break;

        const destCap = await getDestRemainMonotonic(inventoryItemId, need.locId);
        if (destCap <= 0) {
          blocked.push({
            variantId,
            toLocationId: need.locId,
            blockedQty: remainingNeed,
            reason: "Destination Available cap reached"
          });
          break;
        }

        const src = excesses.find(x => x.qty > 0);
        if (!src) {
          blocked.push({
            variantId,
            toLocationId: need.locId,
            blockedQty: remainingNeed,
            reason: "No source excess remaining"
          });
          break;
        }

        const srcLines = (curLocLines.get(src.locId) || []).filter(x => x.qty > 0);
        if (srcLines.length === 0) {
          src.qty = 0;
          continue;
        }

        const line = srcLines[0];
        const moveQty = Math.min(line.qty, src.qty, remainingNeed, destCap);
        if (moveQty <= 0) break;

        try {
          const result = await fulfillmentOrderMove({
            fulfillmentOrderId: line.fulfillmentOrderId,
            newLocationId: need.locId,
            moveLineItems: [{ id: line.fulfillmentOrderLineItemId, quantity: moveQty }]
          });

          moveLog.push({
            variantId,
            movedQty: moveQty,
            fromLocationId: src.locId,
            toLocationId: need.locId,
            movedFulfillmentOrder: result.movedFulfillmentOrder?.id || null,
            originalFulfillmentOrder: result.originalFulfillmentOrder?.id || null
          });

          line.qty -= moveQty;
          src.qty -= moveQty;
          remainingNeed -= moveQty;
          consumeDestRemain(inventoryItemId, need.locId, moveQty);
        } catch (e) {
          blocked.push({
            variantId,
            fromLocationId: src.locId,
            toLocationId: need.locId,
            attemptedQty: moveQty,
            reason: String(e?.message || e)
          });
          src.qty = 0;
        }
      }
    }
  }

  return { moveLog, blocked };
}

async function summarizeFulfillmentByLocation(orderId) {
  const fos = await getFulfillmentOrdersForOrder(orderId);
  const summary = {};
  for (const fo of fos) {
    const locName = fo.assignedLocation?.location?.name || "Unknown";
    const qty = fo.lineItems.nodes.reduce((s, li) => s + (li.remainingQuantity || 0), 0);
    summary[locName] = (summary[locName] || 0) + qty;
  }
  return { summary };
}

// ----------------- Upload parsing -----------------

function parseUpload(file) {
  const ext = path.extname(file.originalname || "").toLowerCase();

  if (ext === ".csv") {
    const text = file.buffer.toString("utf8");
    return parseCsv(text, { columns: true, skip_empty_lines: true, trim: true });
  }

  if (ext === ".xlsx") {
    const workbook = XLSX.read(file.buffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    return XLSX.utils.sheet_to_json(sheet, { defval: "" });
  }

  throw new Error("Unsupported file type. Upload CSV or XLSX.");
}

// ----------------- ExcelJS report builder -----------------

function safeSheetName(name) {
  const s = String(name ?? "").replace(/[\[\]\*\/\\\?\:]/g, " ").trim() || "Sheet";
  return s.slice(0, 31);
}

function makeHandleSizeMapEmpty() {
  const m = new Map();
  for (const s of SIZES) m.set(s, 0);
  return m;
}

const imageCache = new Map(); // url -> { buffer, extension } or null

function guessImageExt(url) {
  const u = String(url || "").toLowerCase();
  if (u.includes(".png")) return "png";
  if (u.includes(".webp")) return "webp";
  return "jpeg";
}

async function fetchImageBuffer(url) {
  const key = String(url || "").trim();
  if (!key) return null;
  if (imageCache.has(key)) return imageCache.get(key);

  try {
    const res = await fetch(key, { redirect: "follow" });
    if (!res.ok) {
      imageCache.set(key, null);
      return null;
    }
    const ab = await res.arrayBuffer();
    const buffer = Buffer.from(ab);
    const extension = guessImageExt(key);
    const out = { buffer, extension };
    imageCache.set(key, out);
    return out;
  } catch {
    imageCache.set(key, null);
    return null;
  }
}

function applyPrintSetup(ws) {
  // Letter portrait, fit to 1 page wide, gridlines on
  ws.pageSetup = {
    paperSize: 1, // Letter
    orientation: "portrait",
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    showGridLines: true
  };
  // Repeat rows 1-6 on each printed page
  ws.pageSetup.printTitlesRow = "1:6";
}

function styleSheet(ws) {
  ws.getColumn(1).width = 40; // title
  ws.getColumn(2).width = 28; // handle
  ws.getColumn(3).width = 12; // image
  for (let i = 0; i < SIZES.length; i++) ws.getColumn(4 + i).width = 6;
  ws.getColumn(4 + SIZES.length).width = 8; // total

  ws.views = [{ state: "frozen", ySplit: 6 }];

  const headerRow = ws.getRow(6);
  headerRow.font = { bold: true };
  headerRow.alignment = { vertical: "middle", horizontal: "left" };

  applyPrintSetup(ws);
}

function writeSheetTop(ws, sheetName, locationLabel, customer, notes) {
  ws.getRow(1).values = [sheetName];
  ws.getRow(1).font = { bold: true, size: 16 };

  ws.getRow(2).values = ["Location", locationLabel];
  ws.getRow(3).values = ["Customer", customer || ""];
  ws.getRow(4).values = ["Notes", notes || ""];
  ws.getRow(5).values = [];

  ws.getRow(2).font = { bold: true };
  ws.getRow(3).font = { bold: true };
  ws.getRow(4).font = { bold: true };
}

function writeTableHeader(ws) {
  ws.getRow(6).values = ["Product Title", "Handle", "Image", ...SIZES, "Total"];
}

async function addHandleRowsWithImages({ wb, ws, handleToSizeMap, productMetaByHandle }) {
  const handles = Array.from(handleToSizeMap.keys());
  handles.sort((a, b) => {
    const ta = (productMetaByHandle[a]?.title || "").toLowerCase();
    const tb = (productMetaByHandle[b]?.title || "").toLowerCase();
    if (ta < tb) return -1;
    if (ta > tb) return 1;
    return a.localeCompare(b);
  });

  let rowIndex = 7;
  for (const handle of handles) {
    const meta = productMetaByHandle[handle] || {};
    const title = meta.title || "";
    const imageUrl = meta.imageUrl || "";
    const sizeMap = handleToSizeMap.get(handle) || makeHandleSizeMapEmpty();

    const vals = [title, handle, ""];
    let total = 0;
    for (const s of SIZES) {
      const v = Number(sizeMap.get(s) || 0);
      vals.push(v);
      total += v;
    }
    vals.push(total);

    ws.getRow(rowIndex).values = vals;
    ws.getRow(rowIndex).height = 48;
    ws.getRow(rowIndex).alignment = { vertical: "middle" };

    // "In-cell" behavior (anchored exactly to the cell bounds, move/size with cell)
    if (imageUrl) {
      const img = await fetchImageBuffer(imageUrl);
      if (img?.buffer?.length) {
        const imageId = wb.addImage({ buffer: img.buffer, extension: img.extension });

        // Column C is index 3 (1-based) -> col=2 in 0-based
        // Anchor within the single cell C{rowIndex}
        ws.addImage(imageId, {
          tl: { col: 2, row: rowIndex - 1 },
          br: { col: 3, row: rowIndex },
          editAs: "oneCell"
        });
      } else {
        ws.getCell(rowIndex, 3).value = imageUrl;
        ws.getCell(rowIndex, 3).font = { color: { argb: "FF0000FF" }, underline: true };
      }
    }

    rowIndex += 1;
  }

  // blank row
  ws.getRow(rowIndex).values = [];

  // totals row
  const totalsRow = ws.getRow(rowIndex + 1);
  totalsRow.values = ["TOTAL", "", "", ...SIZES.map(() => 0), 0];
  totalsRow.font = { bold: true };

  for (let i = 0; i < handles.length; i++) {
    const r = 7 + i;
    for (let s = 0; s < SIZES.length; s++) {
      totalsRow.getCell(4 + s).value =
        Number(totalsRow.getCell(4 + s).value || 0) + Number(ws.getCell(r, 4 + s).value || 0);
    }
    totalsRow.getCell(4 + SIZES.length).value =
      Number(totalsRow.getCell(4 + SIZES.length).value || 0) +
      Number(ws.getCell(r, 4 + SIZES.length).value || 0);
  }
}

async function buildWorkbookExcelJS({
  locationIdToName,
  requestedSeen,
  availabilitySeen,
  productMetaByHandle,
  selectedLocationIds,
  customer,
  notes
}) {
  const requestedHandleMap = new Map();
  for (const entry of requestedSeen || []) {
    const { handle, size, requestedQty } = entry;
    if (!handle || !size) continue;
    if (!requestedHandleMap.has(handle)) requestedHandleMap.set(handle, makeHandleSizeMapEmpty());
    requestedHandleMap
      .get(handle)
      .set(size, (requestedHandleMap.get(handle).get(size) || 0) + Number(requestedQty || 0));
  }

  const locMap = new Map();
  for (const entry of availabilitySeen || []) {
    const handle = entry.handle;
    const size = entry.size;
    for (const a of entry.allocations || []) {
      const locId = a.locationId;
      const qty = Number(a.qty || 0);
      if (!qty) continue;

      if (!locMap.has(locId)) locMap.set(locId, new Map());
      const handleMap = locMap.get(locId);
      if (!handleMap.has(handle)) handleMap.set(handle, makeHandleSizeMapEmpty());

      const sizeMap = handleMap.get(handle);
      sizeMap.set(size, (sizeMap.get(size) || 0) + qty);
    }
  }

  const totalHandleMap = new Map();
  for (const handleMap of locMap.values()) {
    for (const [handle, sizeMap] of handleMap.entries()) {
      if (!totalHandleMap.has(handle)) totalHandleMap.set(handle, makeHandleSizeMapEmpty());
      const tgt = totalHandleMap.get(handle);
      for (const s of SIZES) tgt.set(s, (tgt.get(s) || 0) + Number(sizeMap.get(s) || 0));
    }
  }

  const totalWarehouseHandleMap = new Map();
  for (const [locId, handleMap] of locMap.entries()) {
    const locName = locationIdToName[locId] || "";
    if (locName !== "Bogota" && locName !== "Warehouse") continue;

    for (const [handle, sizeMap] of handleMap.entries()) {
      if (!totalWarehouseHandleMap.has(handle)) totalWarehouseHandleMap.set(handle, makeHandleSizeMapEmpty());
      const tgt = totalWarehouseHandleMap.get(handle);
      for (const s of SIZES) tgt.set(s, (tgt.get(s) || 0) + Number(sizeMap.get(s) || 0));
    }
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = "Wholesale Importer";
  wb.created = new Date();

  async function addSheet(sheetName, locationLabel, map) {
    const ws = wb.addWorksheet(safeSheetName(sheetName));
    writeSheetTop(ws, sheetName, locationLabel, customer, notes);
    writeTableHeader(ws);
    styleSheet(ws);

    if (!map || map.size === 0) {
      ws.getRow(7).values = ["(No units)", "", "", ...SIZES.map(() => 0), 0];
      return;
    }

    await addHandleRowsWithImages({ wb, ws, handleToSizeMap: map, productMetaByHandle });
  }

  await addSheet("Requested", "ALL REQUESTED", requestedHandleMap);
  await addSheet("Total", "ALL ORDERED", totalHandleMap);
  await addSheet("Total Warehouse", "Bogota + Warehouse", totalWarehouseHandleMap);

  const locIds =
    Array.isArray(selectedLocationIds) && selectedLocationIds.length
      ? selectedLocationIds
      : Array.from(locMap.keys());

  for (const locId of locIds) {
    const locName = locationIdToName[locId] || locId;
    const handleMap = locMap.get(locId) || new Map();
    await addSheet(locName, locName, handleMap);
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

function baseNameNoExt(filename) {
  const f = String(filename || "upload").trim();
  const base = f.replace(/^.*[\\/]/, ""); // strip directories
  const dot = base.lastIndexOf(".");
  const noExt = dot > 0 ? base.slice(0, dot) : base;
  return noExt || "upload";
}

function safeFilePart(s) {
  return String(s || "")
    .replace(/[^\w\- ]+/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .slice(0, 80) || "upload";
}

// ----------------- Shared allocator -----------------

async function runAllocationOnly(req) {
  const { locationIdsJson } = req.body;

  const locationIdsInOrder = JSON.parse(locationIdsJson || "[]");
  if (!Array.isArray(locationIdsInOrder) || locationIdsInOrder.length === 0) {
    throw new Error("Select at least one location.");
  }
  if (!req.file?.buffer) throw new Error("Missing CSV/XLSX file.");

  const uploadFileName = req.file?.originalname || "upload.xlsx";

  const customer = String(req.body.customer || "").trim();
  const notes = String(req.body.notes || "").trim();

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
  const allocationPlan = new Map();
  const draftLineItems = [];
  const productMetaByHandle = {};

  const report = {
    tagApplied: AUTO_TAGS,
    requestedUnits: 0,
    allocatedUnits: 0,
    droppedUnits: 0,
    missingHandles: [],
    availabilitySeen: [],
    requestedSeen: [],
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

    const imageUrl = product.featuredImage?.url || product.images?.nodes?.[0]?.url || "";

    productMetaByHandle[item.handle] = {
      title: product.title,
      imageUrl
    };

    for (const size of SIZES) {
      const qty = item.sizeQty[size];
      if (!qty || qty <= 0) continue;

      report.requestedUnits += qty;
      report.requestedSeen.push({ handle: item.handle, size, requestedQty: qty });

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

        const existing = draftLineItems.find(li => li.variantId === variant.id && li.unitPrice === priceStr);
        if (existing) existing.quantity += allocatedQty;
        else draftLineItems.push({ variantId: variant.id, quantity: allocatedQty, unitPrice: priceStr });

        const prev = allocationPlan.get(variant.id);
        const mergedAllocs = prev ? [...prev.allocations] : [];

        for (const a of allocations) {
          const m = mergedAllocs.find(x => x.locationId === a.locationId);
          if (m) m.qty += a.qty;
          else mergedAllocs.push({ locationId: a.locationId, qty: a.qty });
        }

        allocationPlan.set(variant.id, {
          inventoryItemId: variant.inventoryItem.id,
          allocations: mergedAllocs
        });

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

  return {
    report,
    allocationPlan,
    draftLineItems,
    locationIdToName,
    productMetaByHandle,
    locationIdsInOrder,
    customer,
    notes,
    uploadFileName
  };
}

// ----------------- Routes -----------------

app.get("/api/locations", async (_req, res) => {
  try {
    const locations = await getAllLocations();
    res.json({ locations });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.post("/api/preview", upload.single("file"), async (req, res) => {
  try {
    const result = await runAllocationOnly(req);

    const runId = saveRun({
      locationIdToName: result.locationIdToName,
      availabilitySeen: result.report.availabilitySeen,
      requestedSeen: result.report.requestedSeen,
      productMetaByHandle: result.productMetaByHandle,
      locationIdsInOrder: result.locationIdsInOrder,
      customer: result.customer,
      notes: result.notes,
      uploadFileName: result.uploadFileName
    });

    res.json({ ok: true, mode: "preview", runId, ...result });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.get("/api/report.xlsx", async (req, res) => {
  try {
    const runId = String(req.query.runId || "");
    const run = getRun(runId);
    if (!run) {
      return res.status(400).json({
        error: "Invalid or expired runId. Run Preview or Create Order again, then download."
      });
    }

    const xlsxBuffer = await buildWorkbookExcelJS({
      locationIdToName: run.locationIdToName,
      requestedSeen: run.requestedSeen || [],
      availabilitySeen: run.availabilitySeen || [],
      productMetaByHandle: run.productMetaByHandle || {},
      selectedLocationIds: run.locationIdsInOrder || [],
      customer: run.customer || "",
      notes: run.notes || ""
    });

    const base = safeFilePart(baseNameNoExt(run.uploadFileName || "upload"));
    const outName = `${base}-fulfillment.xlsx`;

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${outName}"`);
    res.send(xlsxBuffer);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.post("/api/import", upload.single("file"), async (req, res) => {
  try {
    const { reserveHours = "48", locationIdsJson } = req.body;

    const result = await runAllocationOnly(req);
    const {
      report,
      allocationPlan,
      draftLineItems,
      locationIdToName,
      productMetaByHandle,
      locationIdsInOrder,
      customer,
      notes,
      uploadFileName
    } = result;

    const runId = saveRun({
      locationIdToName,
      availabilitySeen: report.availabilitySeen,
      requestedSeen: report.requestedSeen,
      productMetaByHandle,
      locationIdsInOrder: JSON.parse(locationIdsJson || "[]"),
      customer,
      notes,
      uploadFileName
    });

    if (draftLineItems.length === 0) {
      return res.status(400).json({
        error: "Nothing fulfillable from selected locations. No order created.",
        runId,
        report
      });
    }

    const draft = await draftOrderCreate({
      lineItems: draftLineItems,
      reserveHours: Number(reserveHours)
    });

    const order = await draftOrderComplete(draft.id);

    await waitForFulfillmentOrders(order.id);
    await new Promise(r => setTimeout(r, 1000));

    const allowedLocationIds = locationIdsInOrder;

    const rebalance = await enforceFulfillmentLocationsRebalance({
      orderId: order.id,
      allocationPlan,
      allowedLocationIds,
      drainOrderLocationIds: allowedLocationIds
    });

    const finalFulfillment = await summarizeFulfillmentByLocation(order.id);

    res.json({
      ok: true,
      tags: AUTO_TAGS,
      runId,
      draftOrderId: draft.id,
      orderId: order.id,
      orderName: order.name,
      moveLog: rebalance.moveLog,
      blockedMoves: rebalance.blocked,
      report,
      finalFulfillment,
      locationIdToName,
      productMetaByHandle,
      customer,
      notes
    });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// ----------------- Packing List (PDF) -----------------

async function getOrderPackingData(orderId) {
  const q = `
    query Packing($id: ID!) {
      order(id: $id) {
        id
        name
        createdAt
        tags
        shippingAddress {
          name
          company
          address1
          address2
          city
          provinceCode
          zip
          country
          phone
        }
        lineItems(first: 250) {
          nodes {
            id
            title
            quantity
            sku
            originalUnitPriceSet { shopMoney { amount currencyCode } }
            image { url }
            variant { id title }
            product { id tags }
          }
        }
        fulfillmentOrders(first: 50) {
          nodes {
            id
            assignedLocation { location { id name } }
            lineItems(first: 250) {
              nodes {
                id
                lineItem { id }
                remainingQuantity
              }
            }
          }
        }
      }
      shop {
        name
        email
        primaryDomain { url }
        billingAddress { address1 city provinceCode zip }
      }
    }
  `;
  const data = await shopifyGraphQL(q, { id: orderId });
  return { order: data.order, shop: data.shop };
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatUSD(amountStr) {
  const n = Number(amountStr);
  if (!Number.isFinite(n)) return "";
  return `$${n.toFixed(2)}`;
}

function buildPackingSlipHtml({ order, shop }) {
  const lineItemLoc = new Map();

  for (const fo of order.fulfillmentOrders.nodes || []) {
    const loc = fo.assignedLocation?.location;
    const locId = loc?.id || "unassigned";
    const locName = loc?.name || "Unassigned";

    for (const n of fo.lineItems.nodes || []) {
      const liId = n.lineItem?.id;
      if (liId) lineItemLoc.set(liId, { id: locId, name: locName });
    }
  }

  const byLoc = new Map();
  for (const li of order.lineItems.nodes || []) {
    const loc = lineItemLoc.get(li.id) || { id: "unassigned", name: "Unassigned" };
    if (!byLoc.has(loc.id)) byLoc.set(loc.id, { name: loc.name, items: [] });
    byLoc.get(loc.id).items.push(li);
  }

  const pages = [];
  for (const [, locData] of byLoc.entries()) {
    pages.push(`
      <div class="slip-container">
        <div class="main-content">
          <div class="logo">
            <img src="https://cdn.shopify.com/s/files/1/0079/3998/1409/files/YB_Logo_Text.png?v=1720112556" alt="Yakira Bella Logo">
          </div>
          <p class="slogan">Playfully Sophisticated, Tastefully Bold</p>

          <div class="order-info">
            <p>
              <b>Order:</b> ${escapeHtml(order.name)}<br>
              <b>Date:</b> ${new Date(order.createdAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "2-digit" })}<br>
              <b>Location:</b> ${escapeHtml(locData.name)}<br>
              ${order.tags?.includes("Wholesale") ? `<strong style="font-size:16px;">WHOLESALE</strong><br>` : ""}
            </p>
          </div>

          <table class="products-tbl">
            ${(locData.items || []).map(li => {
              const img = li.image?.url ? (li.image.url.split("?")[0] + "?width=60") : "";
              const variantTitle =
                li.variant?.title && li.variant.title !== "Default Title"
                  ? `<br>${escapeHtml(li.variant.title)}`
                  : "";
              const isFinalSale = (li.product?.tags || []).includes("finalsale");
              const price = formatUSD(li.originalUnitPriceSet?.shopMoney?.amount || "");
              return `
                <tr>
                  <td class="img-td">${img ? `<img src="${escapeHtml(img)}" alt="${escapeHtml(li.title)}">` : ""}</td>
                  <td class="sku-td">${escapeHtml(li.sku || "")}</td>
                  <td class="desc-td">
                    ${escapeHtml(li.title)}${variantTitle}
                    ${isFinalSale ? `<br><span class="tag">Final Sale</span>` : ""}
                  </td>
                  <td class="qty-td">x ${escapeHtml(li.quantity || 0)}</td>
                  <td class="price-td">${escapeHtml(price)}</td>
                </tr>
              `;
            }).join("")}
          </table>
        </div>

        <div class="footer">
          <div class="footer-info-container">
            <div>
              <img src="https://cdn.shopify.com/s/files/1/0079/3998/1409/files/qrcode.png?v=1762454806" alt="QR Code">
            </div>
            <div class="footer-txt-container">
              <div class="footer-txt">
                For all returns and exchanges, please visit <strong>yakirabella.com/returns</strong> or scan the code on the left.<br>
                For any questions please email <strong>${escapeHtml(shop.email)}</strong>
              </div>
              <div class="footer-txt-2">
                Returns can be processed within 7 days of receiving this package. Products marked "FINAL SALE" can not be returned or exchanged.
              </div>
            </div>
          </div>
        </div>
      </div>
    `);
  }

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    @page { margin: 16px; }
    body { margin:0; padding:0; font-family: Arial, sans-serif; font-size: 18px; }
    .slip-container { display:flex; flex-direction:column; justify-content:space-between; min-height: 96vh; padding:16px; page-break-after: always; }
    .logo { text-align:center; margin-bottom: 4px; }
    .logo img { max-width: 360px; height:auto; }
    .slogan { font-size: 20px; text-align:center; margin: 4px 0 10px 0; font-weight: normal; }
    .order-info { margin: 10px 0 8px 0; }
    .order-info p { font-size: 18px; line-height: 1.4; margin: 0; }

    .products-tbl { width: 100%; border-collapse: collapse; margin-top: 6px; }
    .products-tbl tr:first-child td { border-top: 2px solid #000; }
    .products-tbl td { padding: 10px 6px; border-bottom: 1px solid #dbdbdb; font-size: 18px; vertical-align: middle; }
    .products-tbl .img-td { width: 70px; text-align: center; }
    .products-tbl .img-td img { max-width: 56px; height: auto; }
    .products-tbl .sku-td { width: 150px; font-size: 16px; }
    .products-tbl .desc-td { font-size: 18px; line-height: 1.3; }
    .products-tbl .qty-td { width: 70px; text-align: right; font-size: 18px; }
    .products-tbl .price-td { width: 110px; text-align: right; font-size: 18px; }

    .tag { color: red; font-weight: bold; font-size: 16px; }

    .footer { border-top: 2px solid #000; padding: 4px 0; width: 100%; page-break-inside: avoid; }
    .footer-info-container { display:flex; align-items:flex-start; gap: 10px; }
    .footer-info-container img { width: 56px; height: auto; }
    .footer-txt-container { flex:1; display:flex; gap: 16px; }
    .footer-txt, .footer-txt-2 { font-size: 11px; flex:1; line-height: 1.35; }
  </style>
</head>
<body>
  ${pages.join("\n")}
</body>
</html>
`;
}

app.get("/api/packing-list.pdf", async (req, res) => {
  try {
    const orderId = String(req.query.orderId || "").trim();
    if (!orderId) return res.status(400).json({ error: "Missing orderId query param." });

    const { order, shop } = await getOrderPackingData(orderId);
    const html = buildPackingSlipHtml({ order, shop });

    let puppeteerCore = null;
    let chromium = null;

    try {
      puppeteerCore = await import("puppeteer-core");
      chromium = await import("@sparticuz/chromium");
    } catch {
      puppeteerCore = null;
      chromium = null;
    }

    if (!puppeteerCore || !chromium) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.send(html);
    }

    try {
      const browser = await puppeteerCore.default.launch({
        args: chromium.default.args,
        executablePath: await chromium.default.executablePath(),
        headless: chromium.default.headless
      });

      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: "networkidle0" });

      const pdf = await page.pdf({
        format: "Letter",
        printBackground: true,
        margin: { top: "0.25in", right: "0.25in", bottom: "0.25in", left: "0.25in" }
      });

      await browser.close();

      const safeName = String(order.name || "order").replaceAll("#", "").replaceAll("/", "-");
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="packing-list-${safeName}.pdf"`);
      return res.send(Buffer.from(pdf));
    } catch {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.send(html);
    }
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// ----------------- Healthcheck -----------------
app.get("/api/debug/ping", (_req, res) => res.json({ ok: true, version: VERSION }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Wholesale importer running on http://localhost:${port}`));
