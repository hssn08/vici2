"use client";

// SystemHealthStrip — a compact top strip showing service liveness:
// FreeSWITCH, MySQL, Valkey, dialer pod count, and scrape staleness.
//
// S01 PLAN §5.

import React from "react";
import type { SystemHealth } from "@/lib/stores/dashboard.js";

export interface SystemHealthStripProps {
  health: SystemHealth | null;
}

export function SystemHealthStrip({ health }: SystemHealthStripProps): React.ReactElement {
  if (!health) {
    return (
      <div className="flex h-8 items-center gap-3 rounded-lg bg-[var(--color-surface-muted)] px-4 text-xs text-[var(--color-fg-muted)]">
        <span className="animate-pulse">Loading system health…</span>
      </div>
    );
  }

  const stale = health.scrapeStalenessMs > 10_000; // > 10s = warn
  const dialerOk = health.dialerPodsUp >= health.dialerPodsTotal;

  return (
    <div
      className="flex flex-wrap items-center gap-x-5 gap-y-1.5 rounded-lg bg-[var(--color-surface-muted)] px-4 py-2 text-xs"
      aria-label="System health"
    >
      <HealthPill label="FreeSWITCH" ok={health.freeswitchUp} />
      <HealthPill label="MySQL" ok={health.mysqlUp} />
      <HealthPill label="Valkey" ok={health.valkeyUp} />
      <HealthPill
        label={`Dialer (${health.dialerPodsUp}/${health.dialerPodsTotal})`}
        ok={dialerOk}
        warn={!dialerOk && health.dialerPodsUp > 0}
      />
      <span className={`ml-auto font-mono tabular-nums ${stale ? "text-amber-600" : "text-[var(--color-fg-muted)]"}`}>
        scrape {health.scrapeStalenessMs < 1000
          ? `${health.scrapeStalenessMs}ms`
          : `${(health.scrapeStalenessMs / 1000).toFixed(1)}s`} ago
      </span>
    </div>
  );
}

interface HealthPillProps {
  label: string;
  ok: boolean;
  warn?: boolean;
}

function HealthPill({ label, ok, warn = false }: HealthPillProps): React.ReactElement {
  const dotColor = ok
    ? "bg-green-500"
    : warn
    ? "bg-amber-500"
    : "bg-red-500";
  const textColor = ok
    ? "text-[var(--color-fg)]"
    : warn
    ? "text-amber-700 dark:text-amber-400"
    : "text-red-700 dark:text-red-400";

  return (
    <span className={`flex items-center gap-1.5 font-medium ${textColor}`}>
      <span className={`h-2 w-2 rounded-full ${dotColor}`} aria-hidden="true" />
      {label}
    </span>
  );
}
