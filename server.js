import express from "express";
import multer from "multer";
import { parse } from "csv-parse/sync";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.static("public"));

const SHOP = process.env.SHOPIFY_SHOP;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const VERSION = process.env.SHOPIFY_API_VERSION || "2025-01";

if (!SHOP || !TOKEN) {
  console.error("Missing SHOPIFY_SHOP or SHOPIFY_ADMIN_TOKEN env vars.");
  process.exit(1);
}

const SIZES = ["XXS", "XS", "S", "M", "L", "XL", "XXL"];

async function shopifyGraphQL(query, variables = {}) {
  const res = await fetch(`https://${SHOP}/admin/api/${VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": TOKEN
    },
    body: JSON.stringify({ query, variables })
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors, null, 2));
  return json.data;
}

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

function findVariantIdForSize(variants, size) {
  // Assumes there is an option named "Size"
  return variants.find(v =>
    v.selectedOptions.some(o => o.name.toLowerCase() === "size" && o.value === size)
  ) || null;
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

async function draftOrderCreate({ purchasingEntity, lineItems, reserveHours }) {
  const reserveUntilIso = reserveHours
    ? new Date(Date.now() + reserveHours * 3600_000).toISOString()
    : null;

  const mutation = `
    mutation CreateDraft($input: DraftOrderInput!) {
      draftOrderCreate(input: $input) {
        draftOrder { id invoiceUrl }
        userErrors { field message }
      }
    }
  `;

  // purchasingEntity: for B2B, include purchasingEntity or customer depending on your setup.
  // We'll accept either:
  // - purchasingEntity: { companyLocationId: "gid://shopify/CompanyLocation/..." }
  // - OR customerId: "gid://shopify/Customer/..."
  const input = {
    ...purchasingEntity,
    lineItems: lineItems.map(li => ({
      variantId: li.variantId,
      quantity: li.quantity,
      // Set wholesale price override
      originalUnitPrice: li.unitPrice
    }))
  };

  if (reserveUntilIso) {
    // Field is supported in DraftOrderInput per docs (reserve inventory on draft)
    input.reserveInventoryUntil = reserveUntilIso;
  }

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
                totalQuantity
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

// Core: enforce allocation by moving FO line items
async function enforceFulfillmentLocations(orderId, allocationPlan) {
  // allocationPlan: Map<variantId, Array<{locationId, qty}>>
  const fos = await getFulfillmentOrdersForOrder(orderId);

  // Build quick lookup: variantId -> [{foId, foLineItemId, remainingQty}]
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

  // For each variant, move quantities to target locations as needed
  for (const [variantId, desiredAllocations] of allocationPlan.entries()) {
    let lines = variantToFOLines.get(variantId) || [];
    // We will move from wherever Shopify initially assigned into the desired location buckets.

    for (const want of desiredAllocations) {
      let need = want.qty;
      if (need <= 0) continue;

      // Ensure we have enough remaining across FO lines
      // We'll satisfy need by moving chunks from existing lines to want.locationId.
      for (const line of lines) {
        if (need <= 0) break;
        if (line.remainingQuantity <= 0) continue;

        // If already in desired location, consume from it without moving
        if (line.assignedLocationId === want.locationId) {
          const take = Math.min(line.remainingQuantity, need);
          line.remainingQuantity -= take;
          need -= take;
          continue;
        }

        // Otherwise move a portion to desired location
        const moveQty = Math.min(line.remainingQuantity, need);

        await fulfillmentOrderMove({
          fulfillmentOrderId: line.fulfillmentOrderId,
          newLocationId: want.locationId,
          moveLineItems: [{ id: line.fulfillmentOrderLineItemId, quantity: moveQty }]
        });

        line.remainingQuantity -= moveQty;
        need -= moveQty;

        // After moving, Shopify creates/updates fulfillment orders; for simplicity in MVP,
        // we do not re-fetch FOs each time. In practice, you can re-fetch after all moves
        // to display final state.
      }

      if (need > 0) {
        // This shouldn't happen because we built draft quantities from availability,
        // but we keep a guard.
        console.warn(`Could not fully assign variant ${variantId} to location ${want.locationId}. Need left: ${need}`);
      }
    }
  }
}

// --- API endpoints ---

app.get("/api/locations", async (_req, res) => {
  try {
    const locations = await getAllLocations();
    // Filter to your known ones if you want; we return all for flexibility
    res.json({ locations });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/import", upload.single("file"), async (req, res) => {
  try {
    const {
      // One of these must be provided:
      companyLocationId, // gid://shopify/CompanyLocation/...
      customerId,        // gid://shopify/Customer/...
      reserveHours = "48",
      // ordered list of location IDs to pull from
      locationIdsJson
    } = req.body;

    const locationIdsInOrder = JSON.parse(locationIdsJson || "[]");
    if (!Array.isArray(locationIdsInOrder) || locationIdsInOrder.length === 0) {
      return res.status(400).json({ error: "Select at least one location." });
    }
    if (!req.file?.buffer) {
      return res.status(400).json({ error: "Missing CSV file." });
    }
    if (!companyLocationId && !customerId) {
      return res.status(400).json({ error: "Provide companyLocationId (B2B) or customerId." });
    }

    const csvText = req.file.buffer.toString("utf8");
    const records = parse(csvText, { columns: true, skip_empty_lines: true, trim: true });

    // Build requested items list: [{handle, unitPrice, size->qty}]
    const requested = [];
    for (const row of records) {
      const handle = row.product_handle;
      if (!handle) continue;
      const unitPrice = Number(row.unit_price);
      if (!Number.isFinite(unitPrice)) {
        return res.status(400).json({ error: `Invalid unit_price for handle ${handle}` });
      }
      const sizeQty = {};
      for (const s of SIZES) sizeQty[s] = Number(row[s] || 0) || 0;
      requested.push({ handle, unitPrice, sizeQty, productTitle: row.product_title || "" });
    }

    // Allocation results
    const allocationPlan = new Map(); // variantId -> [{locationId, qty}]
    const draftLineItems = [];        // [{variantId, quantity, unitPrice}]
    const report = {
      requestedUnits: 0,
      allocatedUnits: 0,
      droppedUnits: 0,
      droppedByHandle: [],
      missingHandles: []
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

        const variant = findVariantIdForSize(product.variants.nodes, size);
        if (!variant) {
          report.droppedUnits += qty;
          report.droppedByHandle.push({ handle: item.handle, size, requested: qty, allocated: 0, dropped: qty, reason: "No variant for size" });
          continue;
        }

        const { allocations, dropped } = await allocateVariantQty({
          inventoryItemId: variant.inventoryItem.id,
          requestedQty: qty,
          locationIdsInOrder
        });

        const allocatedQty = allocations.reduce((sum, a) => sum + a.qty, 0);
        if (allocatedQty > 0) {
          draftLineItems.push({ variantId: variant.id, quantity: allocatedQty, unitPrice: String(item.unitPrice) });
          allocationPlan.set(variant.id, allocations);
          report.allocatedUnits += allocatedQty;
        }
        if (dropped > 0) {
          report.droppedUnits += dropped;
        }

        report.droppedByHandle.push({
          handle: item.handle,
          size,
          requested: qty,
          allocated: allocatedQty,
          dropped: dropped,
          reason: dropped > 0 ? "Insufficient stock in selected locations" : ""
        });
      }
    }

    if (draftLineItems.length === 0) {
      return res.status(400).json({ error: "Nothing fulfillable from selected locations. No order created.", report });
    }

    // Purchasing entity payload
    const purchasingEntity = companyLocationId
      ? { purchasingEntity: { companyLocationId } }
      : { customerId };

    // 1) Create draft (optionally reserve inventory)
    const draft = await draftOrderCreate({
      purchasingEntity,
      lineItems: draftLineItems,
      reserveHours: Number(reserveHours)
    });

    // 2) Complete draft => real order
    const order = await draftOrderComplete(draft.id);

    // 3) Enforce fulfillment location assignments to match allocation plan
    await enforceFulfillmentLocations(order.id, allocationPlan);

    res.json({
      ok: true,
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
