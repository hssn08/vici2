// Two-tier RBAC scope-inputs cache (M02 PLAN §7).
//
// L1: per-process LRU (lru-cache, 1024 entries, 30 s TTL) — ~1 µs
// L2: Valkey HASH t:{tid}:rbac:effective:{uid}    (300 s TTL) — ~200 µs
// L3: MySQL via caller-supplied loader             (~2-5 ms)
//
// The cache stores scope INPUTS only (role, userGroupId, allowedCampaigns).
// The permission set itself is ROLE_VERBS[role] — a precomputed constant.

import { LRUCache } from 'lru-cache';
import type { AuthContext } from './can.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScopeInputs {
  role:             AuthContext['role'];
  userGroupId:      bigint | null;
  allowedCampaigns: bigint[] | '*';
  active:           boolean;
  cacheVersion?:    string;
}

export interface CacheClient {
  /** Valkey HGETALL */
  hgetall(key: string): Promise<Record<string, string> | null>;
  /** Valkey HMSET + EXPIRE */
  hset(key: string, fields: Record<string, string>): Promise<void>;
  expire(key: string, seconds: number): Promise<void>;
  /** Valkey DEL */
  del(key: string): Promise<void>;
  /** Valkey SUBSCRIBE */
  subscribe?(channel: string, handler: (msg: string) => void): Promise<void>;
}

export interface ScopeLoader {
  /** Load fresh scope inputs from MySQL for a given uid in a tenant. */
  load(tenantId: bigint, uid: bigint): Promise<ScopeInputs | null>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const L1_MAX = 1024;
const L1_TTL_MS = 30_000;  // 30 s
const L2_TTL_SEC = 300;    // 5 min
const PUBSUB_CHANNEL = 'rbac.user.invalidated';

// Bumped whenever rbac.ts changes — prevents stale Valkey cache after deploy.
// In production this is replaced by the build-time SHA256 prefix of rbac.ts.
export const MATRIX_VERSION = process.env['RBAC_MATRIX_VERSION'] ?? 'dev';

// ---------------------------------------------------------------------------
// L1 in-process LRU
// ---------------------------------------------------------------------------

const l1 = new LRUCache<string, ScopeInputs>({
  max: L1_MAX,
  ttl: L1_TTL_MS,
});

function l1Key(tenantId: bigint, uid: bigint): string {
  return `${tenantId}:${uid}`;
}

// ---------------------------------------------------------------------------
// Valkey helpers
// ---------------------------------------------------------------------------

function l2Key(tenantId: bigint, uid: bigint): string {
  return `t:${tenantId}:rbac:effective:${uid}`;
}

function serialize(inputs: ScopeInputs): Record<string, string> {
  return {
    role:             inputs.role,
    userGroupId:      inputs.userGroupId?.toString() ?? '',
    allowedCampaigns: inputs.allowedCampaigns === '*'
      ? '*'
      : inputs.allowedCampaigns.map(String).join(','),
    active:           inputs.active ? '1' : '0',
    cacheVersion:     MATRIX_VERSION,
  };
}

function deserialize(raw: Record<string, string>): ScopeInputs | null {
  if (!raw['role']) return null;
  return {
    role:             raw['role'] as ScopeInputs['role'],
    userGroupId:      raw['userGroupId'] ? BigInt(raw['userGroupId']) : null,
    allowedCampaigns: raw['allowedCampaigns'] === '*'
      ? '*'
      : (raw['allowedCampaigns']
          ? raw['allowedCampaigns'].split(',').filter(Boolean).map(BigInt)
          : []),
    active:           raw['active'] === '1',
    cacheVersion:     raw['cacheVersion'],
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load effective scope inputs for a user.
 * Hits L1 → L2 → L3 in order; populates upper layers on miss.
 * Returns null if all tiers fail (caller should deny with 'system_error').
 */
export async function loadEffective(
  tenantId:    bigint,
  uid:         bigint,
  valkey:      CacheClient,
  loader:      ScopeLoader,
): Promise<ScopeInputs | null> {
  // L1
  const key1 = l1Key(tenantId, uid);
  const hit1 = l1.get(key1);
  if (hit1) return hit1;

  // L2
  const key2 = l2Key(tenantId, uid);
  try {
    const raw = await valkey.hgetall(key2);
    if (raw && raw['role']) {
      const inputs = deserialize(raw);
      if (inputs) {
        // Version check — stale matrix triggers L3 reload
        if (inputs.cacheVersion && inputs.cacheVersion !== MATRIX_VERSION) {
          // fall through to L3; the Valkey entry will be overwritten
        } else {
          l1.set(key1, inputs);
          return inputs;
        }
      }
    }
  } catch {
    // Valkey down — fall through to L3
  }

  // L3 — MySQL
  try {
    const fresh = await loader.load(tenantId, uid);
    if (!fresh) return null;
    // Populate L2 + L1
    try {
      await valkey.hset(key2, serialize(fresh));
      await valkey.expire(key2, L2_TTL_SEC);
    } catch {
      // Valkey write failure is non-fatal — L1 still works
    }
    l1.set(key1, fresh);
    return fresh;
  } catch {
    return null;
  }
}

/**
 * Invalidate both L1 and L2 for a specific user.
 * Called on role change, user-group change, deactivation.
 */
export async function invalidateUser(
  tenantId: bigint,
  uid:      bigint,
  valkey:   CacheClient,
): Promise<void> {
  l1.delete(l1Key(tenantId, uid));
  try {
    await valkey.del(l2Key(tenantId, uid));
  } catch {
    // non-fatal — L1 cleared; L2 will expire naturally
  }
}

/**
 * Subscribe to pubsub invalidation messages from Valkey.
 * Each message is a JSON string: { uid: string, tenantId: string }
 */
export async function subscribePubSub(valkey: CacheClient): Promise<void> {
  if (!valkey.subscribe) return;
  await valkey.subscribe(PUBSUB_CHANNEL, (msg: string) => {
    try {
      const { uid, tenantId } = JSON.parse(msg) as { uid: string; tenantId: string };
      if (uid && tenantId) {
        l1.delete(l1Key(BigInt(tenantId), BigInt(uid)));
      }
    } catch {
      // malformed message — ignore
    }
  });
}

/**
 * Publish a pubsub invalidation message for a user.
 * Call after updating user role / group / deactivating.
 */
export async function publishInvalidation(
  tenantId: bigint,
  uid:      bigint,
  valkey:   CacheClient & { publish?(channel: string, msg: string): Promise<void> },
): Promise<void> {
  try {
    await valkey.publish?.(PUBSUB_CHANNEL, JSON.stringify({ uid: uid.toString(), tenantId: tenantId.toString() }));
  } catch {
    // non-fatal — bounded by TTLs
  }
}
