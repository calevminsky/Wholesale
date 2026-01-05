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

// Option A: long-lived Admin token (custom app in store admin)
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

// Option B: client credentials (new dev dashboard style)
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
const AUTO_TAGS = ["Wholesale"]; // <-- requested autotag

// ----------------- Auth: access token -----------------

let cachedAccessToken = null;
let tokenExpiresAtMs = 0;

async function getAccessToken() {
  // If you provided a permanent Admin token, just use it.
  if (ADMIN_TOKEN) return ADMIN_TOKEN;

  // Otherwise mint a token via client credentials and cache it.
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

async function getAvailableAtLocation(inventoryItemId, locationId) {
  const q = `
    query Inv($inventoryItemId: ID!, $locationId: ID!) {
      inventoryLevel(inventoryItemId: $inventoryItemId, locationId: $locationId) {
        quantities(names: ["available"]) { name quantity }
      }
    }
  `;
  const data = await shopifyGraphQL(q, { inventoryItemId, locationId });
  const level = data.inventoryLevel;
  if (!level) return 0; // not stocked at this location
  const avail = level.quantities.find(x => x.name === "available")?.quantity ?? 0;
  return Number(avail) || 0;
}

function findVariantForSize(variants, size) {
  // Assumes there is an option named "Size" with values XXS..XXL
  return (
    variants.find(v =>
      v.selectedOptions.some(o => o.name.toLowerCase() === "size" && o.value === size)
    ) || null
  );
}

// Allocation: split across locations in given priority order
async function allocateVariantQty({ inventoryItemId, requestedQty, locationIdsInOrder }) {
  let remaining = requestedQty;
  const allocations = []; // [{locationId, qty}]
  for (const locId of locationIdsInOrder) {
    if (remaining <= 0) break;
    const avail = await getAvailableAtLocation(inventoryItemId, locId);
    if (avail <= 0) continue;
    const take = Math.min(avail, remaining);
    if (take > 0) allocations.push({ locationId: locId, qty: take });
    remaining -= take;
  }
  return { allocations, dropped: remaining };
}

async function draftOrderCreate({ lineItems, reserveHours }) {
  const reserveUntilIso =
    reserveHours && Number(reserveHours) > 0
      ? new Date(Date.now() + Number(reserveHours) * 3600_000).toISOString()
      : null;

  const mutation = `
    mutation CreateDraft($input: DraftOrderInput!) {
      draftOrderCreate(input: $input) {
        draftOrder { id invoiceUrl }
        userErrors { field message }
      }
    }
  `;

  const input = {
    tags: AUTO_TAGS, // <-- auto-tag "Wholesale" (carries to order) :contentReference[oaicite:1]{index=1}
    lineItems: lineItems.map(li => ({
      variantId: li.variantId,
      quantity: li.quantity,
      // Price override per unit (wholesale price)
      originalUnitPrice: li.unitPrice
    }))
  };

  if (reserveUntilIso) input.reserveInventoryUntil = reserveUntilIso;

  const data = await shopifyGraphQL(mutation, { input });
  const errs = data.draftOrderCreate.userErrors || [];
  if (errs.length) throw new Error(`draftOrderCreate errors: ${JSON.stringify(errs, null, 2)}`);
  return data.draftOrderCreate.draftOrder;
}

async function draftOrderComplete(draftOrderId) {
  const mutation = `
    mutation CompleteDraft($id: ID!) {
      draftOrderComplete(id: $id) {
        draftOrder { id order { id name } }
        userErrors { field message }
      }
    }
  `;
  const data = await shopifyGraphQL(mutation, { id: draftOrderId });
  const errs = data.draftOrderComplete.userErrors || [];
  if (errs.length) throw new Error(`draftOrderComplete errors: ${JSON.stringify(errs, null, 2)}`);
  return data.draftOrderComplete.draftOrder.order;
}

async function getFulfillmentOrdersForOrder(orderId) {
  const q = `
    query OrderFOs($id: ID!) {
      order(id: $id) {
        id
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
      fulfillmentOrderMove(id: $id, newLocationId: $newLocationId, fulfillmentOrderLineItems: $items) {
        movedFulfillmentOrder { id }
        originalFulfillmentOrder { id }
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

// Enforce allocation by moving FO line items
async function enforceFulfillmentLocations(orderId, allocationPlan) {
  // allocationPlan: Map<variantId, Array<{locationId, qty}>>
  const fos = await getFulfillmentOrdersForOrder(orderId);

  // variantId -> [{ fulfillmentOrderId, fulfillmentOrderLineItemId, remainingQuantity, assignedLocationId }]
  const variantToFOLines = new Map();
  for (const fo of fos) {
    for (const li of fo.lineItems.nodes) {
      const variantId = li.lineItem?.variant?.id;
      if (!variantId) continue;
      const arr = variantToFOLines.get(variantId) || [];
      arr.push({
        fulfillmentOrderId: fo.id,
        fulfillmentOrderLineItemId: li.id,
        remainingQuantity: li.remainingQuantity,
        assignedLocationId: fo.assignedLocation.location.id
      });
      variantToFOLines.set(variantId, arr);
    }
  }

  for (const [variantId, desiredAllocations] of allocationPlan.entries()) {
    const lines = variantToFOLines.get(variantId) || [];

    for (const want of desiredAllocations) {
      let need = want.qty;
      if (need <= 0) continue;

      for (const line of lines) {
        if (need <= 0) break;
        if (line.remainingQuantity <= 0) continue;

        // Already assigned to desired location → just consume capacity
        if (line.assignedLocationId === want.locationId) {
          const take = Math.min(line.remainingQuantity, need);
          line.remainingQuantity -= take;
          need -= take;
          continue;
        }

        // Move quantity to desired location
        const moveQty = Math.min(line.remainingQuantity, need);

        await fulfillmentOrderMove({
          fulfillmentOrderId: line.fulfillmentOrderId,
          newLocationId: want.locationId,
          moveLineItems: [{ id: line.fulfillmentOrderLineItemId, quantity: moveQty }]
        });

        line.remainingQuantity -= moveQty;
        need -= moveQty;
      }

      if (need > 0) {
        console.warn(
          `Warning: Could not fully assign variant ${variantId} to location ${want.locationId}. Need left: ${need}`
        );
      }
    }
  }
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

// ----------------- Routes -----------------

app.get("/api/locations", async (_req, res) => {
  try {
    const locations = await getAllLocations();
    res.json({ locations });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/import", upload.single("file"), async (req, res) => {
  try {
    const { reserveHours = "48", locationIdsJson } = req.body;

    const locationIdsInOrder = JSON.parse(locationIdsJson || "[]");
    if (!Array.isArray(locationIdsInOrder) || locationIdsInOrder.length === 0) {
      return res.status(400).json({ error: "Select at least one location." });
    }
    if (!req.file?.buffer) {
      return res.status(400).json({ error: "Missing CSV/XLSX file." });
    }

    const records = parseUpload(req.file);

    // Validate expected headers
    // Required: product_handle, unit_price, plus size columns
    const requested = [];
    for (const row of records) {
      const handle = (row.product_handle || "").toString().trim();
      if (!handle) continue;

      const unitPrice = Number((row.unit_price ?? "").toString().trim());
      if (!Number.isFinite(unitPrice)) {
        return res.status(400).json({ error: `Invalid unit_price for handle ${handle}` });
      }

      const sizeQty = {};
      for (const s of SIZES) {
        const raw = row[s];
        const n = Number((raw ?? "").toString().trim() || 0);
        sizeQty[s] = Number.isFinite(n) ? n : 0;
      }

      requested.push({
        handle,
        unitPrice,
        sizeQty,
        productTitle: (row.product_title || "").toString().trim()
      });
    }

    const allocationPlan = new Map(); // variantId -> [{locationId, qty}]
    const draftLineItems = []; // [{variantId, quantity, unitPrice}]

    const report = {
      tagApplied: AUTO_TAGS,
      requestedUnits: 0,
      allocatedUnits: 0,
      droppedUnits: 0,
      missingHandles: [],
      lines: [] // per handle+size breakdown
    };

    for (const item of requested) {
      const product = await getProductVariantsByHandle(item.handle);
      if (!product) {
        report.missingHandles.push(item.handle);
        continue;
      }

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

        const { allocations, dropped } = await allocateVariantQty({
          inventoryItemId: variant.inventoryItem.id,
          requestedQty: qty,
          locationIdsInOrder
        });

        const allocatedQty = allocations.reduce((sum, a) => sum + a.qty, 0);

        if (allocatedQty > 0) {
          // Combine quantities for same variant (if repeated in file)
          const existing = draftLineItems.find(li => li.variantId === variant.id && li.unitPrice === String(item.unitPrice));
          if (existing) existing.quantity += allocatedQty;
          else draftLineItems.push({ variantId: variant.id, quantity: allocatedQty, unitPrice: String(item.unitPrice) });

          // Merge allocation plan per variantId
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

    if (draftLineItems.length === 0) {
      return res.status(400).json({
        error: "Nothing fulfillable from selected locations. No order created.",
        report
      });
    }

    // 1) Create draft (tagged Wholesale)
    const draft = await draftOrderCreate({
      lineItems: draftLineItems,
      reserveHours: Number(reserveHours)
    });

    // 2) Complete draft => real order
    const order = await draftOrderComplete(draft.id);

    // 3) Enforce fulfillment location assignments to match allocation plan
    await enforceFulfillmentLocations(order.id, allocationPlan);

    res.json({
      ok: true,
      tags: AUTO_TAGS,
      draftOrderId: draft.id,
      orderId: order.id,
      orderName: order.name,
      report
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Wholesale importer running on http://localhost:${port}`));
