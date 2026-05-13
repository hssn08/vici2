import client from 'prom-client';
import { getCacheStats } from './resolve.js';

const register = client.register;

// vici2_tz_resolve_total{confidence, source_tier}
export const tzResolveTotal = new client.Counter({
  name: 'vici2_tz_resolve_total',
  help: 'Total timezone resolutions by confidence level and source tier.',
  labelNames: ['confidence', 'source_tier'],
  registers: [register],
});

// vici2_tz_resolve_duration_seconds{source_tier}
export const tzResolveDuration = new client.Histogram({
  name: 'vici2_tz_resolve_duration_seconds',
  help: 'Latency of timezone resolution by source tier. SLO: p99 < 1ms.',
  labelNames: ['source_tier'],
  buckets: [1e-7, 1e-6, 1e-5, 1e-4, 1e-3, 1e-2],
  registers: [register],
});

// vici2_tz_split_state_collisions_total{state, npa}
export const tzSplitStateCollisions = new client.Counter({
  name: 'vici2_tz_split_state_collisions_total',
  help: 'NPA fallback on a known split state — indicates seed gap.',
  labelNames: ['state', 'npa'],
  registers: [register],
});

// vici2_tz_unknown_total{reason}
export const tzUnknownTotal = new client.Counter({
  name: 'vici2_tz_unknown_total',
  help: 'Total NONE outcomes by reason.',
  labelNames: ['reason'],
  registers: [register],
});

// vici2_tz_cache_size{cache} — populated by collector below
// vici2_tz_cache_hits_total{cache}
export const tzCacheHits = new client.Counter({
  name: 'vici2_tz_cache_hits_total',
  help: 'Cache hits by cache name.',
  labelNames: ['cache'],
  registers: [register],
});

// vici2_tz_cache_misses_total{cache}
export const tzCacheMisses = new client.Counter({
  name: 'vici2_tz_cache_misses_total',
  help: 'Cache misses by cache name.',
  labelNames: ['cache'],
  registers: [register],
});

// vici2_tz_invalidations_total{reason}
export const tzInvalidations = new client.Counter({
  name: 'vici2_tz_invalidations_total',
  help: 'Cache invalidation events by reason.',
  labelNames: ['reason'],
  registers: [register],
});

// vici2_tz_phone_codes_loaded — collected dynamically
new client.Gauge({
  name: 'vici2_tz_phone_codes_loaded',
  help: 'Number of NXX entries currently loaded in process map.',
  registers: [register],
  collect() {
    this.set(getCacheStats().phoneCodes);
  },
});

// vici2_tz_phone_codes_age_seconds — collected dynamically
new client.Gauge({
  name: 'vici2_tz_phone_codes_age_seconds',
  help: 'Seconds since last phone_codes map load. Alert > 86400.',
  registers: [register],
  collect() {
    this.set(getCacheStats().ageMs / 1000);
  },
});

// vici2_tz_cache_size{cache} — collected dynamically
new client.Gauge({
  name: 'vici2_tz_cache_size',
  help: 'Number of entries in each in-process cache.',
  labelNames: ['cache'],
  registers: [register],
  collect() {
    const s = getCacheStats();
    this.set({ cache: 'phone_codes' }, s.phoneCodes);
    this.set({ cache: 'overrides' }, s.overrides);
    this.set({ cache: 'npa_only' }, s.npaOnly);
    this.set({ cache: 'zip' }, s.zipCodes);
  },
});
