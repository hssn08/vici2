// D04 — FreeSWITCH hangup_cause → status mapping.
//
// The mapper is a pure function backed by a Map loaded from
// db/seeds/hangup-cause-map.json at boot. Hot-reloadable via
// POST /api/admin/d04/reload without restart.
//
// Unknown causes default to "NA" and emit the vici2_d04_hangup_unmapped_total
// counter so operators can extend the map without code review.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hangupUnmappedTotal, hangupResolutionsTotal } from "./metrics.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Default to repo root → db/seeds path */
function defaultMapPath(): string {
  // __dirname = <worktree>/api/src/statuses
  // 3 levels up → <worktree>/
  return join(__dirname, "..", "..", "..", "db", "seeds", "hangup-cause-map.json");
}

let _map: Map<string, string> = new Map();
let _loaded = false;

/** Load (or reload) the hangup-cause map from disk. */
export function loadHangupMap(filePath?: string): void {
  const path = filePath ?? defaultMapPath();
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
  _map = new Map(Object.entries(raw));
  _loaded = true;
}

/** Ensure map is loaded (idempotent after first load). */
function ensureLoaded(): void {
  if (!_loaded) loadHangupMap();
}

/**
 * Pure function: FreeSWITCH hangup_cause → D04 status code.
 * Unknown causes return "NA" and emit a Prometheus counter.
 *
 * @param hangupCause  Raw FreeSWITCH CHANNEL_HANGUP cause string
 * @returns D04 status code (e.g. "B-CAR", "NA-CAR", "CARRIER_FAIL", "NA")
 */
export function resolveFromHangupCause(hangupCause: string): string {
  ensureLoaded();
  const mapped = _map.get(hangupCause);
  if (mapped) {
    hangupResolutionsTotal.inc({ cause: hangupCause, status: mapped });
    return mapped;
  }
  // Unknown cause — fallback to NA, emit metric
  hangupUnmappedTotal.inc({ cause: hangupCause });
  hangupResolutionsTotal.inc({ cause: hangupCause, status: "NA" });
  return "NA";
}

/** Return a copy of the raw map for admin inspection. */
export function getHangupMap(): Record<string, string> {
  ensureLoaded();
  return Object.fromEntries(_map.entries());
}
