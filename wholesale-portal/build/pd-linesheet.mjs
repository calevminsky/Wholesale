// pd-linesheet.mjs — S27 (Spring 2027) view-only line sheet feed, pulled
// straight from pd (the product-development schema in the same yb_reports
// Postgres the portal already connects to).
//
// What's on the sheet:
//   - every live S27 colorway (not archived, not discontinued/cancelled), plus
//   - carryover styles tagged in pd.colorway_wholesale with season 'S27'
//     (prior-season colorways being offered again — they render with a season
//     badge). Tag/untag there to control the carryover set.
//
// Images and fabric swatches come from pd.asset (kind 'image' / 'swatch');
// their source_url points at the public R2 bucket, so the browser loads them
// directly — nothing is downloaded or committed here.
//
// The server stores the fetched snapshot durably in Postgres
// (wholesale_portal_settings, key "pd-linesheet-s27") via the admin refresh
// button; data/pd-linesheet-s27.json is a committed fallback/seed only.
//
// Run directly to refresh the committed seed:  node build/pd-linesheet.mjs
//   REPORTING_DATABASE_URL (or PD_DATABASE_URL) required.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, ".."); // wholesale-portal/

export const LINESHEET_SEASON = process.env.PD_LINESHEET_SEASON || "S27";
export const LINESHEET_SETTING_KEY = "pd-linesheet-s27";
export const LINESHEET_FILE = path.resolve(ROOT, "data", "pd-linesheet-s27.json");

// pd names that differ from how the style actually sells (mirrors the
// override in the internal sheet builder).
const NAME_OVERRIDE = { 1184: "Denver Top" }; // sells as Denver Top; pd says Mel Top

function loadDotenvIfNeeded() {
  if (process.env.REPORTING_DATABASE_URL || process.env.PD_DATABASE_URL) return;
  for (const p of [path.resolve(ROOT, "..", ".env"), path.resolve(ROOT, ".env")]) {
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!(m[1] in process.env)) process.env[m[1]] = v;
    }
  }
}

function makePool() {
  const url = process.env.REPORTING_DATABASE_URL || process.env.PD_DATABASE_URL;
  if (!url) throw new Error("REPORTING_DATABASE_URL (or PD_DATABASE_URL) not set — needed to read the pd line sheet.");
  const ssl = url.includes("sslmode=disable") ? false : { rejectUnauthorized: false };
  return new pg.Pool({ connectionString: url, ssl, max: 4 });
}

// Only URLs the buyer's browser can load directly (R2 / Shopify CDN). pd rows
// that still hold bytes-only assets (no source_url) simply have no image.
const webUrl = (u) => (u && /^https?:\/\//i.test(u) ? u : null);

export async function fetchPdLinesheet(season = LINESHEET_SEASON) {
  loadDotenvIfNeeded();
  const pool = makePool();
  try {
    const [products, looks] = await Promise.all([
      pool.query(
        `WITH sheet AS (
           SELECT c.id FROM pd.colorway c
            WHERE (c.season = $1
                   OR c.id IN (SELECT colorway_id FROM pd.colorway_wholesale WHERE season = $1))
              AND c.archived_at IS NULL
              AND c.status NOT IN ('discontinued','cancelled')
         )
         SELECT c.id, s.name, c.color, s.type, c.season,
                (COALESCE(c.season,'') <> $1) AS carry,
                c.fabric_type, c.composition,
                -- Named line-sheet groupings (pd.collection, curated in yb-pd's
                -- Collections page) — NOT colorway.collections, which is the
                -- Shopify-tag label list.
                COALESCE((SELECT array_agg(g.name ORDER BY g.position, lower(g.name))
                            FROM pd.collection_colorway cc
                            JOIN pd.collection g ON g.id = cc.collection_id
                           WHERE cc.colorway_id = c.id), '{}') AS collections,
                (SELECT a.source_url FROM pd.asset a
                  WHERE a.colorway_id = c.id AND a.kind = 'image' AND a.source_url IS NOT NULL
                  ORDER BY (a.source_url LIKE '%r2.dev%') DESC, a.id DESC LIMIT 1) AS img,
                (SELECT a.source_url FROM pd.asset a
                  WHERE a.colorway_id = c.id AND a.kind = 'swatch' AND a.source_url IS NOT NULL
                  ORDER BY (a.source_url LIKE '%r2.dev%') DESC, a.id DESC LIMIT 1) AS swatch
           FROM pd.colorway c
           JOIN pd.style s ON s.id = c.style_id
          WHERE c.id IN (SELECT id FROM sheet)
          ORDER BY s.type, s.name, c.color`,
        [season]
      ),
      pool.query(
        `SELECT l.id, l.title, l.notes,
                l.source_url AS hero,
                COALESCE((SELECT array_agg(lc.colorway_id ORDER BY lc.position, lc.colorway_id)
                            FROM pd.look_colorway lc WHERE lc.look_id = l.id), '{}') AS members
           FROM pd.look l
          WHERE l.season = $1
             OR EXISTS (SELECT 1 FROM pd.look_colorway lc JOIN pd.colorway c ON c.id = lc.colorway_id
                         WHERE lc.look_id = l.id AND c.season = $1)
          ORDER BY l.position, l.id`,
        [season]
      )
    ]);
    return {
      pulled: new Date().toISOString(),
      season,
      source: "pd",
      count: products.rows.length,
      products: products.rows.map((r) => ({
        id: Number(r.id),
        name: NAME_OVERRIDE[r.id] || String(r.name || "").trim(),
        color: r.color ? String(r.color).trim() : "",
        type: r.type || "Other",
        season: r.season || null,
        carry: !!r.carry,
        img: webUrl(r.img),
        swatch: webUrl(r.swatch),
        fabric: r.fabric_type || null,
        composition: r.composition || null,
        collections: (r.collections || []).filter(Boolean)
      })),
      looks: looks.rows.map((r) => ({
        id: Number(r.id),
        title: r.title || "",
        notes: r.notes || "",
        hero: webUrl(r.hero),
        members: (r.members || []).map(Number)
      }))
    };
  } finally {
    await pool.end();
  }
}

// Committed fallback/seed — used when the DB copy doesn't exist yet (or the
// DB is unreachable at serve time).
export function loadLinesheetFile() {
  try {
    return JSON.parse(fs.readFileSync(LINESHEET_FILE, "utf8"));
  } catch {
    return null;
  }
}

// Run as a script (not when imported): refresh the committed seed file.
if (import.meta.url === `file://${process.argv[1]}`) {
  fetchPdLinesheet()
    .then((snap) => {
      fs.writeFileSync(LINESHEET_FILE, JSON.stringify(snap, null, 1));
      const carry = snap.products.filter((p) => p.carry).length;
      const swatches = snap.products.filter((p) => p.swatch).length;
      console.log(`Wrote ${path.relative(ROOT, LINESHEET_FILE)} — ${snap.count} products (${carry} carryover, ${swatches} with swatches), ${snap.looks.length} looks`);
    })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
