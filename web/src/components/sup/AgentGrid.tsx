"use client";

// AgentGrid — grid of AgentTile components with filter/sort controls.
//
// Handles monitor modal open state: clicking an IN_CALL tile opens
// the S02 MonitorModal for that agent.
//
// S01 PLAN §5.

import React, { useState } from "react";
import type { AgentSnapshot, CampaignMetrics, DashboardFilter, AgentSortKey } from "@/lib/stores/dashboard.js";
import { AgentTile } from "./AgentTile.js";
import { AgentFilterBar } from "./AgentFilterBar.js";
import { MonitorModal } from "@/app/(sup)/monitor/MonitorModal.js";

export interface AgentGridProps {
  agents: AgentSnapshot[];
  campaigns: CampaignMetrics[];
  filter: DashboardFilter;
  sort: AgentSortKey;
  onFilterChange: (patch: Partial<DashboardFilter>) => void;
  onSortChange: (sort: AgentSortKey) => void;
}

export function AgentGrid({
  agents,
  campaigns,
  filter,
  sort,
  onFilterChange,
  onSortChange,
}: AgentGridProps): React.ReactElement {
  const [monitorTarget, setMonitorTarget] = useState<AgentSnapshot | null>(null);

  const handleMonitor = (agent: AgentSnapshot): void => {
    setMonitorTarget(agent);
  };

  const handleCloseModal = (): void => {
    setMonitorTarget(null);
  };

  return (
    <section aria-label="Agent grid">
      <div className="mb-4 flex items-center justify-between gap-4">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-[var(--color-fg-muted)]">
          Agents ({agents.length})
        </h2>
        <AgentFilterBar
          filter={filter}
          sort={sort}
          campaigns={campaigns}
          onFilterChange={onFilterChange}
          onSortChange={onSortChange}
        />
      </div>

      {agents.length === 0 ? (
        <p className="py-8 text-center text-sm text-[var(--color-fg-muted)]">
          No agents match the current filter.
        </p>
      ) : (
        <div
          className="grid gap-3"
          style={{
            gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
          }}
        >
          {agents.map((agent) => (
            <AgentTile key={agent.uid} agent={agent} onMonitor={handleMonitor} />
          ))}
        </div>
      )}

      {/* S02 MonitorModal — opened when an IN_CALL tile is clicked */}
      {monitorTarget && (
        <MonitorModal
          agent={{
            uid: monitorTarget.uid,
            displayName: monitorTarget.displayName,
            campaignName: monitorTarget.campaignName ?? undefined,
            callDurationSec: monitorTarget.callDurationSec ?? undefined,
          }}
          existingMonitorCount={monitorTarget.monitorCount}
          onClose={handleCloseModal}
        />
      )}
    </section>
  );
}
