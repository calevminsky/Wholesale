// server.js
import express from "express";
import multer from "multer";
import { parse as parseCsv } from "csv-parse/sync";
import XLSX from "xlsx";
import path from "path";
import crypto from "crypto";

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

const runStore = new Map(); // runId -> { createdAt, locationIdToName, availabilitySeen, productMetaByHandle, locationIdsInOrder }
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

// ----------------- Shopify GraphQL helper (WITH request-id debugging) -----------------

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
                lineItem { variant { id inventoryItem { id } } }
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

// Wait for fulfillment orders after completion (helps race conditions)
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

// ----------------- Robust approach: NO order edits by default -----------------
// Why: Your CalculatedLineItem schema is missing fields needed for safe mapping,
// and Shopify orderEditCommit is opaque/racy. Instead:
// - We only create what we *think* is fulfillable (allocation based on Available)
// - We rebalance FO assignments to match drain order (delta-based)
// - We NEVER move inventory INTO a destination beyond its current Available cap.
// - If Shopify initially assigned units to disallowed locations, we preferentially
//   move them OUT (subject to destination caps).

function buildCurrentAllocationFromFOs(fos) {
  // variantId -> locationId -> [ { fulfillmentOrderId, fulfillmentOrderLineItemId, qty } ]
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
  allocationPlan,           // Map(variantId -> { inventoryItemId, allocations:[{locationId, qty}] })
  allowedLocationIds,       // allowed set
  drainOrderLocationIds     // ordering preference
}) {
  const moveLog = [];
  const blocked = [];

  const allowedSet = new Set(allowedLocationIds);
  const drainIndex = new Map(drainOrderLocationIds.map((id, idx) => [id, idx]));

  // Destination cap tracker (monotonic decreasing inside this run)
  const destRemain = new Map(); // inventoryItemId::locationId -> remaining cap to move INTO

  async function getDestRemainMonotonic(inventoryItemId, locationId) {
    const key = `${inventoryItemId}::${locationId}`;
    const live = Math.max(0, Number(await getAvailableAtLocation(inventoryItemId, locationId)) || 0);

    if (!destRemain.has(key)) {
      destRemain.set(key, live);
      return live;
    }

    // never increase within this run
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

    // Desired: only allowed locations, amounts from plan (drain order already applied by allocator)
    const desiredByLoc = new Map();
    for (const a of plan.allocations || []) {
      if (!allowedSet.has(a.locationId)) continue;
      desiredByLoc.set(a.locationId, (desiredByLoc.get(a.locationId) || 0) + Number(a.qty || 0));
    }

    // Current: whatever Shopify did (allowed + disallowed)
    const curLocLines = currentByVariant.get(variantId) || new Map();
    const currentByLoc = new Map();
    for (const [locId, lines] of curLocLines.entries()) {
      const total = lines.reduce((s, x) => s + x.qty, 0);
      currentByLoc.set(locId, total);
    }

    // Needs: allowed locations where desired > current
    const needs = [];
    for (const [locId, desiredQty] of desiredByLoc.entries()) {
      const currentQty = currentByLoc.get(locId) || 0;
      const delta = desiredQty - currentQty;
      if (delta > 0) needs.push({ locId, qty: delta });
    }

    // Excess: locations (including disallowed) where current > desired(0 if not desired)
    const excesses = [];
    for (const [locId, currentQty] of currentByLoc.entries()) {
      const desiredQty = desiredByLoc.get(locId) || 0;
      const delta = currentQty - desiredQty;
      if (delta > 0) excesses.push({ locId, qty: delta, disallowed: !allowedSet.has(locId) });
    }

    // Prefer satisfying needs in drain order
    needs.sort((a, b) => (drainIndex.get(a.locId) ?? 9999) - (drainIndex.get(b.locId) ?? 9999));
    // Prefer taking from disallowed sources first
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

        // Move limited by: what's on that FO line, what's excess at that location, need, and destination cap
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

          // Update local bookkeeping
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
          // avoid infinite loops
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
        inventoryItemId: li.lineItem?.variant?.inventoryItem?.id || null,
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

// ----------------- Report XLSX builder (1 sheet per selected location) -----------------

function safeSheetName(name) {
  return String(name).replace(/[\[\]\*\/\\\?\:]/g, " ").trim() || "Sheet";
}

function makeUniqueSheetName(wb, baseName) {
  let n = safeSheetName(baseName).slice(0, 31);
  if (!wb.SheetNames.includes(n)) return n;

  for (let i = 2; i < 100; i++) {
    const suffix = ` (${i})`;
    const trimmed = safeSheetName(baseName).slice(0, 31 - suffix.length) + suffix;
    if (!wb.SheetNames.includes(trimmed)) return trimmed;
  }
  return safeSheetName(baseName).slice(0, 31);
}

function buildLocationWorkbook({ locationIdToName, availabilitySeen, productMetaByHandle, selectedLocationIds }) {
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

  const locIds = Array.isArray(selectedLocationIds) && selectedLocationIds.length
    ? selectedLocationIds
    : Array.from(locMap.keys());

  for (const locId of locIds) {
    const locName = locationIdToName[locId] || locId;

    const header = ["Product Title", "Handle", ...sizes, "Total"];
    const rows = [header];

    const handleMap = locMap.get(locId) || new Map();
    const handles = Array.from(handleMap.keys());

    if (handles.length === 0) {
      rows.push([`(No fulfillable units allocated to ${locName})`, "", ...sizes.map(() => 0), 0]);
    } else {
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

      const totalsRow = ["TOTAL", "", ...sizes.map(() => 0), 0];
      for (let r = 1; r < rows.length; r++) {
        for (let c = 2; c < 2 + sizes.length; c++) totalsRow[c] += rows[r][c];
        totalsRow[2 + sizes.length] += rows[r][2 + sizes.length];
      }
      rows.push([]);
      rows.push(totalsRow);
    }

    const ws = XLSX.utils.aoa_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, makeUniqueSheetName(wb, locName));
  }

  if (wb.SheetNames.length === 0) {
    const ws = XLSX.utils.aoa_to_sheet([["No fulfillable units in selected locations."]]);
    XLSX.utils.book_append_sheet(wb, ws, "Report");
  }

  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

// ----------------- Shared allocator used by Preview / Import -----------------

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
  const allocationPlan = new Map(); // variantId -> { inventoryItemId, allocations:[{locationId, qty}] }
  const draftLineItems = [];
  const productMetaByHandle = {};

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

        const existing = draftLineItems.find(li => li.variantId === variant.id && li.unitPrice === priceStr);
        if (existing) existing.quantity += allocatedQty;
        else draftLineItems.push({ variantId: variant.id, quantity: allocatedQty, unitPrice: priceStr });

        // merge allocations into plan
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

  return { report, allocationPlan, draftLineItems, locationIdToName, productMetaByHandle, locationIdsInOrder };
}

// ----------------- DEBUG endpoints -----------------

// Introspect what fields exist on CalculatedLineItem in YOUR store schema
app.get("/api/debug/calculated-line-item-fields", async (_req, res) => {
  try {
    const q = `
      query {
        __type(name: "CalculatedLineItem") {
          name
          fields {
            name
            type { name kind ofType { name kind } }
          }
        }
      }
    `;
    const data = await shopifyGraphQL(q, {});
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// Quick healthcheck route
app.get("/api/debug/ping", (_req, res) => res.json({ ok: true, version: VERSION }));

// ----------------- Routes -----------------

app.get("/api/locations", async (_req, res) => {
  try {
    const locations = await getAllLocations();
    res.json({ locations });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// Preview only (no draft/order created). Saves run and returns runId for report download.
app.post("/api/preview", upload.single("file"), async (req, res) => {
  try {
    const result = await runAllocationOnly(req);

    const runId = saveRun({
      locationIdToName: result.locationIdToName,
      availabilitySeen: result.report.availabilitySeen,
      productMetaByHandle: result.productMetaByHandle,
      locationIdsInOrder: result.locationIdsInOrder
    });

    res.json({ ok: true, mode: "preview", runId, ...result });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// Report download by runId (no recompute, always matches preview/import)
app.get("/api/report.xlsx", async (req, res) => {
  try {
    const runId = String(req.query.runId || "");
    const run = getRun(runId);
    if (!run) {
      return res.status(400).json({
        error: "Invalid or expired runId. Run Preview or Create Order again, then download."
      });
    }

    const xlsxBuffer = buildLocationWorkbook({
      locationIdToName: run.locationIdToName,
      availabilitySeen: run.availabilitySeen,
      productMetaByHandle: run.productMetaByHandle,
      selectedLocationIds: run.locationIdsInOrder
    });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="fulfillment_report.xlsx"`);
    res.send(xlsxBuffer);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// Import (draft -> complete unpaid -> wait for FOs -> delta rebalance with caps)
app.post("/api/import", upload.single("file"), async (req, res) => {
  try {
    const { reserveHours = "48", locationIdsJson } = req.body;

    const result = await runAllocationOnly(req);
    const { report, allocationPlan, draftLineItems, locationIdToName, productMetaByHandle, locationIdsInOrder } = result;

    const runId = saveRun({
      locationIdToName,
      availabilitySeen: report.availabilitySeen,
      productMetaByHandle,
      locationIdsInOrder: JSON.parse(locationIdsJson || "[]")
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

    // Wait for FOs so moves can be applied reliably
    await waitForFulfillmentOrders(order.id);

    // Small settle delay reduces Shopify race weirdness
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
      notes: [
        "This recommended version DOES NOT use order edits (orderEditBegin/Commit).",
        "It will never move units INTO a destination beyond that location’s current Available cap.",
        "If Shopify initially assigns units to disallowed locations, the rebalancer tries to move them OUT first."
      ]
    });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Wholesale importer running on http://localhost:${port}`));
