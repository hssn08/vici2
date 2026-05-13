/**
 * D03 TypeScript resolver — 6-tier cascade timezone resolution.
 * Mirrors Go dialer/internal/tz/resolver.go exactly.
 */
import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import type { CacheEntry, Confidence, ResolveRequest, ResolveResult } from './types.js';
import { singleTzStateMap, splitStates } from './states.js';
import { parseE164, isValidUSZip, zipKey, getTimezonesForNumber } from './parse.js';

// ── In-process caches ──────────────────────────────────────────────────────
// phoneCodesCache: key = "${NPA}${NXX}" (6 chars)
let phoneCodesCache = new Map<string, CacheEntry>();
// overrideCache: same key format
let overrideCache = new Map<string, CacheEntry>();
// npaOnlyCache: key = NPA (3 chars)
let npaOnlyCache = new Map<string, CacheEntry>();
// zipCodesCache: key = 5-digit zip string
let zipCodesCache = new Map<string, CacheEntry>();
// campaignCache: key = campaignId
const campaignCache = new Map<string, { iana: string; expiresAt: number }>();

let phoneCodesLoadedAt = 0;

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * resolveTimezone implements the 6-tier cascade resolver.
 * All tiers exhausted → confidence = 'NONE'.
 */
export async function resolveTimezone(req: ResolveRequest): Promise<ResolveResult> {
  return doResolve(req);
}

/** resolveBatch resolves multiple requests. Used by D02 CSV import pipeline. */
export async function resolveBatch(reqs: ResolveRequest[]): Promise<ResolveResult[]> {
  // TS is single-threaded; Promise.all with async resolve is fine for I/O but
  // since all work is in-process/sync, just map synchronously.
  return reqs.map(doResolve);
}

/** preload loads phone_codes, overrides, and zip_codes from MySQL at boot. */
export async function preload(prisma: PrismaClient, _valkey?: Redis): Promise<void> {
  await loadPhoneCodes(prisma);
  await loadOverrides(prisma);
  await loadZipCodes(prisma);
  phoneCodesLoadedAt = Date.now();
}

/**
 * subscribe starts a Valkey pubsub listener for cache invalidation events.
 * Call after preload() during server boot.
 */
export function subscribe(valkey: Redis, prisma: PrismaClient): void {
  const sub = valkey.duplicate();
  void sub.subscribe('vici2.phone_codes.invalidate');
  sub.on('message', (_channel: string, payload: string) => {
    if (payload === 'FULL') {
      void preload(prisma, valkey);
    } else if (payload.length === 6) {
      const npa = payload.slice(0, 3);
      const nxx = payload.slice(3, 6);
      void reloadNXX(prisma, npa, nxx);
    }
  });
}

// ── Core cascade logic ─────────────────────────────────────────────────────

function doResolve(req: ResolveRequest): ResolveResult {
  // Tier 1: lead.known_timezone
  if (req.knownTimezone) {
    // Validate the IANA string by trying to create an Intl.DateTimeFormat
    if (isValidIANA(req.knownTimezone)) {
      return {
        iana: req.knownTimezone,
        confidence: 'KNOWN',
        source: 'lead.known_timezone',
      };
    }
    // Bad IANA — fall through
  }

  const parsed = req.phoneE164 ? parseE164(req.phoneE164) : null;

  // Tier 2: ZIP → zip_codes
  if (isValidUSZip(req.zip)) {
    const zk = zipKey(req.zip);
    const entry = zipCodesCache.get(zk);
    if (entry) {
      return {
        iana: entry.iana,
        confidence: 'ZIP',
        source: `zip:${req.zip}`,
        npa: parsed?.npa,
        nxx: parsed?.nxx,
        numberType: parsed?.numberType,
      };
    }
  }

  if (parsed) {
    // Tier 3: NPA+NXX override → phone_codes
    const pk = parsed.mapKey;
    const override = overrideCache.get(pk);
    if (override) {
      return {
        iana: override.iana,
        confidence: 'NXX',
        source: `nxx:override:${parsed.npa}-${parsed.nxx}`,
        npa: parsed.npa,
        nxx: parsed.nxx,
        numberType: parsed.numberType,
      };
    }
    const pcEntry = phoneCodesCache.get(pk);
    if (pcEntry) {
      return {
        iana: pcEntry.iana,
        confidence: 'NXX',
        source: `nxx:${parsed.npa}-${parsed.nxx}`,
        npa: parsed.npa,
        nxx: parsed.nxx,
        numberType: parsed.numberType,
      };
    }

    // Tier 4: NPA-only collapse → libphonenumber fallback
    const npaEntry = npaOnlyCache.get(parsed.npa);
    if (npaEntry) {
      return {
        iana: npaEntry.iana,
        confidence: 'NPA',
        source: `npa:${parsed.npa}`,
        npa: parsed.npa,
        nxx: parsed.nxx,
        numberType: parsed.numberType,
      };
    }
    // libphonenumber NPA fallback
    const zones = getTimezonesForNumber(parsed);
    if (zones.length > 0 && isValidIANA(zones[0])) {
      return {
        iana: zones[0],
        confidence: 'NPA',
        source: `npa:libphonenumber:${parsed.npa}`,
        npa: parsed.npa,
        nxx: parsed.nxx,
        numberType: parsed.numberType,
      };
    }
  }

  // Tier 5: single-tz state default (skip for 8 split states)
  if (req.state && !splitStates.has(req.state)) {
    const stateIana = singleTzStateMap[req.state];
    if (stateIana) {
      return {
        iana: stateIana,
        confidence: 'STATE_DEFAULT',
        source: `state:${req.state}`,
        npa: parsed?.npa,
        nxx: parsed?.nxx,
        numberType: parsed?.numberType,
      };
    }
  }

  // Tier 6: campaign default
  if (req.campaignId) {
    const cc = campaignCache.get(req.campaignId);
    if (cc && cc.expiresAt > Date.now()) {
      return {
        iana: cc.iana,
        confidence: 'CAMPAIGN_DEFAULT',
        source: `campaign:${req.campaignId}`,
        npa: parsed?.npa,
        nxx: parsed?.nxx,
        numberType: parsed?.numberType,
      };
    }
  }

  return { iana: '', confidence: 'NONE', source: 'none' };
}

// ── Cache loaders ──────────────────────────────────────────────────────────

async function loadPhoneCodes(prisma: PrismaClient): Promise<void> {
  const rows = await prisma.phoneCodes.findMany({
    select: { area_code: true, exchange_code: true, tz_iana: true },
  });
  const fresh = new Map<string, CacheEntry>();
  const npaFresh = new Map<string, CacheEntry>();

  for (const row of rows) {
    const key = `${row.area_code}${row.exchange_code}`;
    fresh.set(key, { iana: row.tz_iana });
    if (!npaFresh.has(row.area_code)) {
      npaFresh.set(row.area_code, { iana: row.tz_iana });
    }
  }

  phoneCodesCache = fresh;
  npaOnlyCache = npaFresh;
}

async function loadOverrides(prisma: PrismaClient): Promise<void> {
  const rows = await prisma.phoneCodesOverrides.findMany({
    select: { area_code: true, exchange_code: true, tz_iana: true },
  });
  const fresh = new Map<string, CacheEntry>();
  for (const row of rows) {
    fresh.set(`${row.area_code}${row.exchange_code}`, { iana: row.tz_iana });
  }
  overrideCache = fresh;
}

async function loadZipCodes(prisma: PrismaClient): Promise<void> {
  const rows = await prisma.zipCodes.findMany({
    select: { zip: true, tz_iana: true },
  });
  const fresh = new Map<string, CacheEntry>();
  for (const row of rows) {
    fresh.set(zipKey(row.zip), { iana: row.tz_iana });
  }
  zipCodesCache = fresh;
}

async function reloadNXX(prisma: PrismaClient, npa: string, nxx: string): Promise<void> {
  try {
    const row = await prisma.phoneCodesOverrides.findUnique({
      where: { area_code_exchange_code: { area_code: npa, exchange_code: nxx } },
      select: { tz_iana: true },
    });
    const key = `${npa}${nxx}`;
    if (row) {
      overrideCache.set(key, { iana: row.tz_iana });
    } else {
      overrideCache.delete(key);
    }
  } catch (err) {
    console.error('tz: reloadNXX failed', { npa, nxx, err });
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function isValidIANA(iana: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: iana });
    return true;
  } catch {
    return false;
  }
}

/** setCampaignDefault stores a campaign's default timezone (TTL: 5 min). */
export function setCampaignDefault(campaignId: string, iana: string): void {
  campaignCache.set(campaignId, {
    iana,
    expiresAt: Date.now() + 5 * 60 * 1000,
  });
}

/** getCacheStats returns cache sizes for Prometheus metrics. */
export function getCacheStats() {
  return {
    phoneCodes: phoneCodesCache.size,
    overrides: overrideCache.size,
    npaOnly: npaOnlyCache.size,
    zipCodes: zipCodesCache.size,
    campaigns: campaignCache.size,
    ageMs: phoneCodesLoadedAt ? Date.now() - phoneCodesLoadedAt : 0,
  };
}

// Re-export the cache-testing hooks for integration tests
export { overrideCache as _overrideCache, phoneCodesCache as _phoneCodesCache };

/** publishInvalidate publishes a cache invalidation event to Valkey. */
export async function publishInvalidate(valkey: Redis, npa: string, nxx: string): Promise<void> {
  const payload = `${npa}${nxx}`.length === 6 ? `${npa}${nxx}` : 'FULL';
  await valkey.publish('vici2.phone_codes.invalidate', payload);
}

export async function publishFullReload(valkey: Redis): Promise<void> {
  await valkey.publish('vici2.phone_codes.invalidate', 'FULL');
}
