/**
 * api/src/services/partition/metrics.ts
 *
 * C04 — Prometheus metrics for partition rotation.
 * Uses the existing prom-client singleton pattern from the api package.
 */

import {
  Counter,
  Histogram,
  register as defaultRegistry,
} from 'prom-client';

// Lazily-constructed singletons (safe for module-level init in test environments
// that may import this file multiple times via vitest isolation).

let _added: Counter | undefined;
let _dropped: Counter | undefined;
let _skipped: Counter | undefined;
let _alerts: Counter | undefined;
let _runs: Counter | undefined;
let _duration: Histogram | undefined;

function getAdded(): Counter {
  if (!_added) {
    _added = new Counter({
      name: 'vici2_partitions_added_total',
      help: 'Total partitions added by C04 rotator',
      labelNames: ['table'],
      registers: [defaultRegistry],
    });
  }
  return _added;
}

function getDropped(): Counter {
  if (!_dropped) {
    _dropped = new Counter({
      name: 'vici2_partitions_dropped_total',
      help: 'Total partitions dropped by C04 rotator',
      labelNames: ['table'],
      registers: [defaultRegistry],
    });
  }
  return _dropped;
}

function getSkipped(): Counter {
  if (!_skipped) {
    _skipped = new Counter({
      name: 'vici2_partitions_skipped_total',
      help: 'Total partition operations skipped by C04 rotator',
      labelNames: ['table', 'reason'],
      registers: [defaultRegistry],
    });
  }
  return _skipped;
}

function getAlerts(): Counter {
  if (!_alerts) {
    _alerts = new Counter({
      name: 'vici2_partition_alert_total',
      help: 'Total partition rotation alerts fired by C04',
      labelNames: ['type'],
      registers: [defaultRegistry],
    });
  }
  return _alerts;
}

function getRuns(): Counter {
  if (!_runs) {
    _runs = new Counter({
      name: 'vici2_partition_rotate_run_total',
      help: 'Total partition rotation job runs',
      labelNames: ['status'],
      registers: [defaultRegistry],
    });
  }
  return _runs;
}

function getDuration(): Histogram {
  if (!_duration) {
    _duration = new Histogram({
      name: 'vici2_partition_rotate_duration_seconds',
      help: 'Duration of per-table partition rotation in seconds',
      labelNames: ['table'],
      buckets: [0.1, 0.5, 1, 5, 10, 30, 60, 120, 300],
      registers: [defaultRegistry],
    });
  }
  return _duration;
}

export const partitionMetrics = {
  incAdded(table: string): void {
    getAdded().inc({ table });
  },
  incDropped(table: string): void {
    getDropped().inc({ table });
  },
  incSkipped(table: string, reason: string): void {
    getSkipped().inc({ table, reason });
  },
  incAlert(type: string): void {
    getAlerts().inc({ type });
  },
  incRun(status: 'ok' | 'error' | 'dry_run'): void {
    getRuns().inc({ status });
  },
  startTimer(table: string): () => void {
    return getDuration().startTimer({ table });
  },
  /** For test teardown — clears all metric singletons so they can be re-registered. */
  _resetForTests(): void {
    _added = undefined;
    _dropped = undefined;
    _skipped = undefined;
    _alerts = undefined;
    _runs = undefined;
    _duration = undefined;
  },
};
