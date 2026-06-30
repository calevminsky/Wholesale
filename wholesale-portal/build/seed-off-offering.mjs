// seed-off-offering.mjs — load the F26 off-price selection into the in-season
// Off Price offering config (settings DB key "offering:off").
//
// Source: data/off-seed.json (extracted from f26-offprice-pricing.html) — the
// 103 hand-picked F26 styles priced by type (Tops $5 / Skirts $10 / Dresses $15).
//
// Picks are by handle, resolved against the in-season master (full-offering.json).
// Styles not in that master (F26 pre-season, not published to the online store)
// are listed under `dropped` and skipped — they can't appear until they're in the
// in-season catalog (publish them online, or force-add via the FP "adds" path).
//
// Usage:  REPORTING_DATABASE_URL=... node build/seed-off-offering.mjs
//   --dry   print what would be written without saving
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setOffConfig, getOffConfig } from "./off-offering-store.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRY = process.argv.includes("--dry");

// Minimal .env loader so this runs the same way build-full-offering does.
if (!process.env.REPORTING_DATABASE_URL) {
  for (const p of [path.resolve(__dirname, "..", "..", ".env"), path.resolve(__dirname, "..", ".env")]) {
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
    }
  }
}

async function main() {
  const seed = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "data", "off-seed.json"), "utf8"));
  const resolved = (seed.items || []).filter((i) => i.in_master && i.handle);
  const picks = resolved.map((i) => i.handle);
  const overrides = {};
  for (const i of resolved) overrides[i.gid] = i.price;

  console.log(`Seed: ${seed.total_selected} selected · ${resolved.length} resolved to in-season handles · ${(seed.dropped || []).length} dropped (not in in-season catalog).`);
  const t = {};
  for (const i of resolved) t[i.type] = (t[i.type] || 0) + 1;
  console.log("By type:", JSON.stringify(t), "— prices:", JSON.stringify(seed.rule));

  if (DRY) {
    console.log("\n--dry: not writing. First 5 picks:", picks.slice(0, 5));
    return;
  }
  // A fixed $5 fallback rule; every pick also carries an explicit override so
  // type pricing (Top/Skirt/Dress) is exact regardless of the fallback.
  const saved = await setOffConfig({ picks, pricing: { default: { mode: "fixed", value: seed.rule.Top } }, overrides });
  console.log(`\nWrote offering:off — ${saved.picks.length} picks, ${Object.keys(saved.pricing.overrides).length} price overrides.`);
  const back = await getOffConfig();
  console.log("Verify: picks now", back.picks.length, "overrides", Object.keys(back.pricing.overrides).length);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
