// X04 — Number pool reaper Prometheus metrics.

import client from 'prom-client';
import { registry } from '../../lib/metrics.js';

export const reaperQuarantined = new client.Counter({
  name: 'vici2_pool_reaper_quarantined_total',
  help: 'DIDs auto-quarantined by the pool reaper.',
  registers: [registry],
});

export const reaperRun = new client.Counter({
  name: 'vici2_pool_reaper_run_total',
  help: 'Pool reaper job executions.',
  registers: [registry],
});

export const reaperBelowMin = new client.Gauge({
  name: 'vici2_pool_below_min_size',
  help: 'Number of pools below their min_active_size threshold.',
  registers: [registry],
});
