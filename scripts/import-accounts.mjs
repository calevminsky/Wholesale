// One-time (idempotent) importer: load the wholesale-accounts spreadsheet into
// the customers table, creating one primary contact per account.
//
//   node --env-file-if-exists=.env scripts/import-accounts.mjs "<path to xlsx>" [--commit]
//
// Without --commit it does a dry run and prints what it WOULD do. Re-running with
// --commit is safe: accounts are matched by email, then by name, and updated in
// place rather than duplicated; the primary contact is upserted.
import xlsx from "xlsx";
import * as db from "../src/customers/db.js";
import { query, pgAvailable } from "../src/pg.js";

const DEFAULT_PATH = "/Users/calevminsky/Downloads/Wholesale Account Info.xlsx";
const args = process.argv.slice(2);
const COMMIT = args.includes("--commit");
const filePath = args.find((a) => !a.startsWith("--")) || DEFAULT_PATH;

if (!pgAvailable()) {
  console.error("REPORTING_DATABASE_URL not set — run with: node --env-file-if-exists=.env scripts/import-accounts.mjs");
  process.exit(1);
}

// ---------- helpers ----------
const norm = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");

function cleanPhone(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return String(Math.round(v));   // 6464043623.0 -> "6464043623"
  return String(v).replace(/\.0$/, "").trim() || null;
}

function cleanZip(v, country) {
  if (v == null || v === "") return null;
  let s = typeof v === "number" ? String(Math.round(v)) : String(v).replace(/\.0$/, "").trim();
  // Pad US 5-digit zips that lost a leading zero (07666 -> stored as 7666).
  const isUS = !country || /^(usa|us|united states)$/i.test(String(country).trim());
  if (isUS && /^\d{1,4}$/.test(s)) s = s.padStart(5, "0");
  return s || null;
}

function firstEmail(v) {
  if (!v) return { email: null, extras: [] };
  const parts = String(v).split(/[,;]/).map((x) => x.trim()).filter(Boolean);
  return { email: parts[0] || null, extras: parts.slice(1) };
}

function str(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

// ---------- read sheet ----------
const wb = xlsx.readFile(filePath);
const ws = wb.Sheets[wb.SheetNames[0]];
const rows = xlsx.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
const header = rows[0];
console.log(`Sheet "${wb.SheetNames[0]}" — ${rows.length - 1} data rows. Columns:`, header.slice(0, 13));

// Column indexes (fixed layout of this sheet).
const C = {
  account: 0, contact: 1, printLabel: 2, shipName: 3, addr1: 4, addr2: 5,
  city: 6, state: 7, zip: 8, country: 9, email: 10, phone: 11, tier: 12
};

// ---------- load existing customers for dedupe ----------
const { rows: existing } = await query(
  `SELECT id, name, email FROM customers WHERE archived_at IS NULL`
);
const byEmail = new Map();
for (const c of existing) if (c.email) byEmail.set(norm(c.email), c);

// `sheetNames` = the set of (disambiguated) account names in this import. Containment
// matching must never merge one sheet account into another (e.g. "Brendas" into
// "Brendas West") — it may only reconcile a sheet account with a legacy leftover row.
function matchExisting(account, email, sheetNames) {
  if (email && byEmail.has(norm(email))) return byEmail.get(norm(email));
  const na = norm(account);
  // Exact normalized name wins.
  const exact = existing.find((c) => norm(c.name) === na);
  if (exact) return exact;
  // Otherwise one name contained in the other (>=4 chars), e.g. "Keshet" ~ "Keshet Baltimore".
  // Only accept a single, unambiguous legacy (non-sheet) candidate.
  if (na.length >= 4) {
    const hits = existing.filter((c) => {
      const nc = norm(c.name);
      if (sheetNames.has(nc)) return false;          // don't merge into another sheet account
      return nc.includes(na) || na.includes(nc);
    });
    if (hits.length === 1) return hits[0];
  }
  return null;
}

// Disambiguate accounts whose names collide case-insensitively (the customers
// unique index is on LOWER(name)) — e.g. three different "Blew boutique" stores.
function disambiguateNames(dataRows) {
  const counts = new Map();
  for (const row of dataRows) {
    const a = str(row[C.account]);
    if (a) counts.set(norm(a), (counts.get(norm(a)) || 0) + 1);
  }
  const used = new Set();
  return dataRows.map((row, idx) => {
    const account = str(row[C.account]);
    if (!account) return null;
    let name = account;
    if (counts.get(norm(account)) > 1) {
      const suffix = str(row[C.city]) || str(row[C.country]) || `#${idx + 1}`;
      name = `${account} (${suffix})`;
      while (used.has(norm(name))) name = `${account} (${suffix} #${idx + 1})`;
    }
    used.add(norm(name));
    return name;
  });
}

async function upsertPrimaryContact(customerId, { name, email, phone }) {
  if (!name) return null;
  const contacts = await db.listContacts(customerId);
  const primary = contacts.find((c) => c.is_primary) || contacts[0];
  if (primary) {
    return db.updateContact(primary.id, { name, email, phone, is_primary: true });
  }
  return db.createContact(customerId, { name, email, phone, is_primary: true });
}

// ---------- process ----------
const dataRows = rows.slice(1);
const names = disambiguateNames(dataRows);
const sheetNames = new Set(names.filter(Boolean).map(norm));
let created = 0, updated = 0, contactsUpserted = 0, skipped = 0;

for (let idx = 0; idx < dataRows.length; idx++) {
  const row = dataRows[idx];
  const account = names[idx];
  if (!account) { skipped++; continue; }

  const { email, extras } = firstEmail(row[C.email]);
  const country = str(row[C.country]);
  const tierRaw = str(row[C.tier]);
  const price_tier = tierRaw && /full|off/i.test(tierRaw) ? tierRaw : null;
  const printLabelRaw = str(row[C.printLabel]);
  const yb_print_label = printLabelRaw == null ? null : /^y/i.test(printLabelRaw);

  const shipping_address = {
    name: str(row[C.shipName]),
    address1: str(row[C.addr1]),
    address2: str(row[C.addr2]),
    city: str(row[C.city]),
    state: str(row[C.state]),
    zip: cleanZip(row[C.zip], country),
    country
  };
  // drop empty keys so JSONB stays tidy
  for (const k of Object.keys(shipping_address)) if (shipping_address[k] == null) delete shipping_address[k];

  const phone = cleanPhone(row[C.phone]);
  const contactName = str(row[C.contact]);
  const notesBits = [];
  if (extras.length) notesBits.push(`Other emails: ${extras.join(", ")}`);
  const notes = notesBits.length ? notesBits.join("\n") : null;

  const payload = {
    name: account, email, phone, shipping_address,
    price_tier, yb_print_label, notes
  };

  const match = matchExisting(account, email, sheetNames);
  const verb = match ? "UPDATE" : "CREATE";
  console.log(`${verb}  ${account}${email ? "  <" + email + ">" : ""}${price_tier ? "  [" + price_tier + "]" : ""}${contactName ? "  contact: " + contactName : ""}`);

  if (!COMMIT) { match ? updated++ : created++; if (contactName) contactsUpserted++; continue; }

  let customer;
  if (match) {
    // Don't clobber an existing non-empty notes with null.
    const upd = { ...payload };
    if (upd.notes == null) delete upd.notes;
    customer = await db.updateCustomer(match.id, upd);
    if (!customer) customer = await db.getCustomer(match.id);
    updated++;
  } else {
    customer = await db.createCustomer(payload);
    created++;
  }

  if (contactName && customer) {
    await upsertPrimaryContact(customer.id, { name: contactName, email, phone });
    contactsUpserted++;
  }
}

console.log("\n" + (COMMIT ? "DONE" : "DRY RUN — re-run with --commit to write"));
console.log(`  created: ${created}  updated: ${updated}  primary contacts: ${contactsUpserted}  skipped: ${skipped}`);
process.exit(0);
