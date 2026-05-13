// D04 — In-process LRU cache with Valkey pubsub invalidation.
//
// Cache key: `(tenantId, campaignId)` → EffectiveStatus[]
// TTL: 60 seconds
// Invalidation: Valkey pubsub channel `pubsub:t:{tid}:status_changed:{cid}`
//
// Design: simple Map-based LRU with timestamp expiry. For production scale,
// replace with lru-cache package; the interface is identical.

import type { EffectiveStatus } from "@vici2/types";
import { cacheOpsTotal } from "./metrics.js";

interface CacheEntry {
  data: EffectiveStatus[];
  expiresAt: number;
}

const CACHE_TTL_MS = 60_000;
const MAX_ENTRIES = 1000;

const _store = new Map<string, CacheEntry>();

function cacheKey(tenantId: bigint | number, campaignId: string): string {
  return `${tenantId}:${campaignId}`;
}

/** Evict oldest entries when over capacity. */
function evictOldest(): void {
  if (_store.size < MAX_ENTRIES) return;
  // Evict the first (oldest-inserted) entry
  const firstKey = _store.keys().next().value;
  if (firstKey !== undefined) _store.delete(firstKey);
}

export function cacheGet(tenantId: bigint | number, campaignId: string): EffectiveStatus[] | null {
  const key = cacheKey(tenantId, campaignId);
  const entry = _store.get(key);
  if (!entry) {
    cacheOpsTotal.inc({ op: "miss" });
    return null;
  }
  if (Date.now() > entry.expiresAt) {
    _store.delete(key);
    cacheOpsTotal.inc({ op: "miss" });
    return null;
  }
  cacheOpsTotal.inc({ op: "hit" });
  return entry.data;
}

export function cacheSet(tenantId: bigint | number, campaignId: string, data: EffectiveStatus[]): void {
  evictOldest();
  _store.set(cacheKey(tenantId, campaignId), {
    data,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

export function cacheInvalidate(tenantId: bigint | number, campaignId: string): void {
  const key = cacheKey(tenantId, campaignId);
  if (_store.delete(key)) {
    cacheOpsTotal.inc({ op: "invalidate" });
  }
}

export function cacheClear(): void {
  _store.clear();
}

// ── Valkey pubsub subscription ─────────────────────────────────────────────────
// Called once at startup with the Redis/Valkey client.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _sub: any = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function subscribeToInvalidation(redis: any): void {
  if (_sub) return; // already subscribed
  _sub = redis.duplicate();
  _sub.psubscribe("pubsub:t:*:status_changed:*", (err: Error | null) => {
    if (err) console.error("[d04:cache] psubscribe error", err);
  });
  _sub.on("pmessage", (_pattern: string, channel: string, _message: string) => {
    // channel = pubsub:t:{tid}:status_changed:{cid}
    const m = /^pubsub:t:(\d+):status_changed:(.+)$/.exec(channel);
    if (!m) return;
    const tid = m[1]!;
    const cid = m[2]!;
    cacheInvalidate(BigInt(tid), cid);
  });
}

/**
 * Publish cache-invalidation event so all API workers flush their LRU entry.
 * Called after any write to statuses or campaign_status_overrides.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function publishInvalidation(redis: any, tenantId: bigint | number, campaignId: string): Promise<void> {
  const channel = `pubsub:t:${tenantId}:status_changed:${campaignId}`;
  await redis.publish(channel, "1");
  // Also invalidate locally immediately
  cacheInvalidate(tenantId, campaignId);
}
