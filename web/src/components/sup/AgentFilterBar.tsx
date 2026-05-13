"use client";

// AgentFilterBar — filter + sort controls for the agent grid.
//
// Allows supervisor to filter by agent state or campaign, and sort by
// state priority, name, or call duration.
//
// S01 PLAN §5.

import React from "react";
import type { AgentState, AgentSortKey, DashboardFilter, CampaignMetrics } from "@/lib/stores/dashboard.js";

export interface AgentFilterBarProps {
  filter: DashboardFilter;
  sort: AgentSortKey;
  campaigns: CampaignMetrics[];
  onFilterChange: (patch: Partial<DashboardFilter>) => void;
  onSortChange: (sort: AgentSortKey) => void;
}

const STATE_OPTIONS: { value: AgentState | ""; label: string }[] = [
  { value: "", label: "All states" },
  { value: "IN_CALL", label: "In Call" },
  { value: "READY", label: "Ready" },
  { value: "WRAPUP", label: "Wrap-up" },
  { value: "PAUSED", label: "Paused" },
  { value: "LOGOUT", label: "Logged Out" },
];

const SORT_OPTIONS: { value: AgentSortKey; label: string }[] = [
  { value: "state", label: "Sort: Status" },
  { value: "name", label: "Sort: Name" },
  { value: "duration", label: "Sort: Duration" },
];

export function AgentFilterBar({
  filter,
  sort,
  campaigns,
  onFilterChange,
  onSortChange,
}: AgentFilterBarProps): React.ReactElement {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* State filter */}
      <select
        value={filter.state ?? ""}
        onChange={(e) => {
          const v = e.target.value as AgentState | "";
          onFilterChange({ state: v === "" ? undefined : v });
        }}
        className="rounded-lg border border-[var(--color-surface-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-brand-500)]"
        aria-label="Filter by state"
      >
        {STATE_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>

      {/* Campaign filter */}
      <select
        value={filter.campaignId ?? ""}
        onChange={(e) => {
          const v = e.target.value;
          onFilterChange({ campaignId: v === "" ? undefined : Number(v) });
        }}
        className="rounded-lg border border-[var(--color-surface-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-brand-500)]"
        aria-label="Filter by campaign"
      >
        <option value="">All campaigns</option>
        {campaigns.map((c) => (
          <option key={c.campaignId} value={c.campaignId}>
            {c.campaignName}
          </option>
        ))}
      </select>

      {/* Sort */}
      <select
        value={sort}
        onChange={(e) => onSortChange(e.target.value as AgentSortKey)}
        className="rounded-lg border border-[var(--color-surface-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-brand-500)]"
        aria-label="Sort agents"
      >
        {SORT_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>

      {/* Clear filters button — only shown when filters are active */}
      {(filter.state != null || filter.campaignId != null) && (
        <button
          onClick={() => onFilterChange({ state: undefined, campaignId: undefined })}
          className="rounded-lg px-3 py-1.5 text-sm text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)]"
        >
          Clear filters
        </button>
      )}
    </div>
  );
}
