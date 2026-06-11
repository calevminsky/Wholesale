import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ETA_OVERRIDES_PATH = path.resolve(__dirname, "eta-overrides.json");

export function loadEtaOverrides() {
  if (!fs.existsSync(ETA_OVERRIDES_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(ETA_OVERRIDES_PATH, "utf8")); }
  catch { return {}; }
}

export function saveEtaOverrides(overrides) {
  fs.writeFileSync(ETA_OVERRIDES_PATH, JSON.stringify(overrides, null, 2));
}
