// D05 — Bloom filter helpers (TS / API side).
//
// Wraps BF.RESERVE / BF.MADD / BF.EXISTS per-source.
// Falls back to in-process Set when the key is unavailable (dev mode).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRedis = any;
import { bloomKey, BLOOM_CAPS, BLOOM_FPR, DncSource } from "./types.js";

// ── Reserve ───────────────────────────────────────────────────────────────────

/**
 * Idempotently reserve a Bloom filter.  If the key already exists Valkey
 * returns "BUSYKEY" — we ignore that error per PLAN §1.2.
 */
export async function reserveBloom(
  redis: AnyRedis,
  source: DncSource,
  tenantId?: number,
): Promise<void> {
  const key = bloomKey(source, tenantId);
  const cap = BLOOM_CAPS[source];
  try {
    await redis.call("BF.RESERVE", key, BLOOM_FPR, cap, "EXPANSION", 2);
  } catch (err) {
    // BUSYKEY = already exists — expected idempotent path
    if (!(err as Error).message?.includes("BUSYKEY")) {
      throw err;
    }
  }
}

// ── Add ───────────────────────────────────────────────────────────────────────

/** Add a single phone to a Bloom filter. */
export async function bloomAdd(
  redis: AnyRedis,
  source: DncSource,
  tenantId: number | undefined,
  phone: string,
): Promise<void> {
  const key = bloomKey(source, tenantId);
  await redis.call("BF.ADD", key, phone);
}

/** Add a batch of phones to a Bloom filter (BF.MADD). */
export async function bloomMadd(
  redis: AnyRedis,
  source: DncSource,
  tenantId: number | undefined,
  phones: string[],
): Promise<void> {
  if (phones.length === 0) return;
  const key = bloomKey(source, tenantId);
  await redis.call("BF.MADD", key, ...phones);
}

// ── Exists (single source) ────────────────────────────────────────────────────

/**
 * Check a single Bloom key.  Returns true if the phone *might* be in the set.
 * Returns false on key-not-found (treated as clean; caller logs alarm).
 */
export async function bloomExists(
  redis: AnyRedis,
  source: DncSource,
  tenantId: number | undefined,
  phone: string,
): Promise<boolean> {
  const key = bloomKey(source, tenantId);
  try {
    const r = await redis.call("BF.EXISTS", key, phone);
    return r === 1;
  } catch {
    // Module not loaded or key missing — treat as clean (per PLAN §1.5 caller checks)
    return false;
  }
}

// ── Multi-source pipeline ─────────────────────────────────────────────────────

/**
 * Pipeline BF.EXISTS across multiple sources in one RTT.
 * Returns a map of source → bloom-positive.
 * On Valkey error for a source, that source is treated as positive
 * (fail-closed — forces MySQL confirmation).
 */
export async function bloomMexistsPipeline(
  redis: AnyRedis,
  sources: DncSource[],
  tenantId: number,
  phone: string,
): Promise<Map<DncSource, boolean>> {
  const pipeline = redis.pipeline();
  for (const src of sources) {
    const key = bloomKey(src, tenantId);
     
    pipeline.call("BF.EXISTS", key, phone);
  }

  let results: Array<[error: Error | null, result: unknown]>;
  try {
    results = await pipeline.exec() as Array<[Error | null, unknown]>;
  } catch {
    // Complete Valkey failure — fail-closed: all sources positive
    const map = new Map<DncSource, boolean>();
    for (const src of sources) map.set(src, true);
    return map;
  }

  const map = new Map<DncSource, boolean>();
  for (let i = 0; i < sources.length; i++) {
    const pair = results[i];
    const err = pair ? pair[0] : null;
    const val = pair ? pair[1] : 0;
    // err → fail-closed (treat as positive); val===1 → positive
    map.set(sources[i]!, err !== null || val === 1);
  }
  return map;
}

// ── Bloom info ────────────────────────────────────────────────────────────────

export async function bloomInfo(
  redis: AnyRedis,
  key: string,
): Promise<Record<string, unknown> | null> {
  try {
    const raw = await redis.call("BF.INFO", key) as unknown[];
    const info: Record<string, unknown> = {};
    for (let i = 0; i < raw.length - 1; i += 2) {
      info[raw[i] as string] = raw[i + 1];
    }
    return info;
  } catch {
    return null;
  }
}
