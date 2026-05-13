// RBAC Prometheus metrics (M02 PLAN §9.4).
// Import this module once at process startup to register the metrics.
// The dialer registers its own equivalent in Go.

import { Counter, Histogram, Registry } from 'prom-client';

/** Surface labels for the check-duration histogram. */
export type Surface = 'fastify' | 'go' | 'ws' | 'bullmq' | 'server_action' | 'rsc';

let _registry: Registry | undefined;
let _denyTotal: Counter | undefined;
let _sensitiveAllowTotal: Counter | undefined;
let _checkDuration: Histogram | undefined;
let _systemErrorTotal: Counter | undefined;

/** Register metrics on the given Prometheus registry (call once at startup). */
export function registerRbacMetrics(registry: Registry): void {
  if (_registry) return; // idempotent
  _registry = registry;

  _denyTotal = new Counter({
    name: 'vici2_rbac_deny_total',
    help: 'Total RBAC denials',
    labelNames: ['reason', 'verb', 'role'],
    registers: [registry],
  });

  _sensitiveAllowTotal = new Counter({
    name: 'vici2_rbac_sensitive_allow_total',
    help: 'Total sensitive-allow RBAC decisions',
    labelNames: ['verb', 'role'],
    registers: [registry],
  });

  _checkDuration = new Histogram({
    name: 'vici2_rbac_check_duration_seconds',
    help: 'RBAC check duration in seconds per surface',
    labelNames: ['surface'],
    buckets: [0.00001, 0.00005, 0.0001, 0.0005, 0.001, 0.005, 0.01],
    registers: [registry],
  });

  _systemErrorTotal = new Counter({
    name: 'vici2_rbac_system_error_total',
    help: 'RBAC system errors (cache/matrix failures)',
    labelNames: ['surface'],
    registers: [registry],
  });
}

export function incDeny(reason: string, verb: string, role: string): void {
  _denyTotal?.inc({ reason, verb, role });
}

export function incSensitiveAllow(verb: string, role: string): void {
  _sensitiveAllowTotal?.inc({ verb, role });
}

export function incSystemError(surface: Surface): void {
  _systemErrorTotal?.inc({ surface });
}

export function observeCheckDuration(surface: Surface, durationSec: number): void {
  _checkDuration?.observe({ surface }, durationSec);
}
