"use client";

// CampaignCard — a single campaign's KPI tile in the campaign metrics row.
//
// Shows: drop gauge, dial level, in-flight, agents ready/waiting,
// queue depth, leads callable.
//
// S01 PLAN §5.

import React from "react";
import type { CampaignMetrics } from "@/lib/stores/dashboard.js";
import { DropGauge } from "./DropGauge.js";

export interface CampaignCardProps {
  metrics: CampaignMetrics;
}

export function CampaignCard({ metrics }: CampaignCardProps): React.ReactElement {
  return (
    <div className="rounded-xl border border-[var(--color-surface-border)] bg-[var(--color-surface)] p-4 shadow-sm min-w-[260px]">
      {/* Campaign name */}
      <div className="mb-3 flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold leading-tight">{metrics.campaignName}</h3>
        {metrics.dropGated && (
          <span className="shrink-0 rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-bold uppercase text-red-700">
            GATED
          </span>
        )}
      </div>

      {/* Drop gauge */}
      <DropGauge pct={metrics.dropPct30d} gated={metrics.dropGated} />

      {/* KPI grid */}
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
        <KpiRow label="Dial level" value={metrics.dialLevel.toFixed(1)} />
        <KpiRow label="In-flight" value={String(metrics.inFlight)} />
        <KpiRow label="Agents ready" value={String(metrics.agentsReady)} />
        <KpiRow label="Agents waiting" value={String(metrics.agentsWaiting)} />
        <KpiRow label="Queue depth" value={String(metrics.queueDepth)} />
        <KpiRow label="Leads callable" value={metrics.leadsCallable.toLocaleString()} />
      </dl>
    </div>
  );
}

function KpiRow({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <>
      <dt className="text-[var(--color-fg-muted)]">{label}</dt>
      <dd className="font-mono font-medium tabular-nums">{value}</dd>
    </>
  );
}
