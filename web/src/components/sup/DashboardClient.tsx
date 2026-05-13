"use client";

// DashboardClient — top-level client island for the S01 supervisor dashboard.
//
// Responsibilities:
//  - Fetch initial data from GET /api/sup/{agents,campaigns/metrics,health}.
//  - Subscribe to WebSocket events (agent.state, campaign.metrics) via lib/ws.ts.
//  - Polling fallback (5 s) when WebSocket is disconnected.
//  - Delegate rendering to AgentGrid, CampaignMetricsRow, SystemHealthStrip.
//
// S01 PLAN §4, §5.

import React, { useEffect, useCallback, useRef } from "react";
import { useDashboardStore, selectFilteredAgents } from "@/lib/stores/dashboard.js";
import type { AgentSnapshot, CampaignMetrics, SystemHealth } from "@/lib/stores/dashboard.js";
import { useWsStore } from "@/lib/stores/ws.js";
import { SystemHealthStrip } from "./SystemHealthStrip.js";
import { CampaignMetricsRow } from "./CampaignMetricsRow.js";
import { AgentGrid } from "./AgentGrid.js";

const POLL_INTERVAL_MS = 5_000;

export interface DashboardClientProps {
  /** Server-rendered initial agents (avoids CLS on first paint). */
  initialAgents: AgentSnapshot[];
  /** Server-rendered initial campaigns. */
  initialCampaigns: CampaignMetrics[];
  /** Server-rendered initial health. */
  initialHealth: SystemHealth | null;
}

export function DashboardClient({
  initialAgents,
  initialCampaigns,
  initialHealth,
}: DashboardClientProps): React.ReactElement {
  const setAgents = useDashboardStore((s) => s.setAgents);
  const setCampaigns = useDashboardStore((s) => s.setCampaigns);
  const setHealth = useDashboardStore((s) => s.setHealth);
  const patchAgent = useDashboardStore((s) => s.patchAgent);
  const filter = useDashboardStore((s) => s.filter);
  const sort = useDashboardStore((s) => s.sort);
  const setFilter = useDashboardStore((s) => s.setFilter);
  const setSort = useDashboardStore((s) => s.setSort);
  const campaigns = useDashboardStore((s) => s.campaigns);
  const health = useDashboardStore((s) => s.health);
  const agents = useDashboardStore(selectFilteredAgents);

  const wsStatus = useWsStore((s) => s.connection);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Seed store with server-provided initial data (run once on mount).
  const initRef = React.useRef(false);
  if (!initRef.current) {
    initRef.current = true;
    setAgents(initialAgents);
    setCampaigns(initialCampaigns);
    if (initialHealth) setHealth(initialHealth);
  }

  const fetchAll = useCallback(async (): Promise<void> => {
    try {
      const [agentsRes, campaignsRes, healthRes] = await Promise.all([
        fetch("/api/sup/agents"),
        fetch("/api/sup/campaigns/metrics"),
        fetch("/api/sup/health"),
      ]);

      if (agentsRes.ok) {
        const data = await agentsRes.json() as { agents: AgentSnapshot[] };
        setAgents(data.agents);
      }
      if (campaignsRes.ok) {
        const data = await campaignsRes.json() as { campaigns: CampaignMetrics[] };
        setCampaigns(data.campaigns);
      }
      if (healthRes.ok) {
        const data = await healthRes.json() as SystemHealth;
        setHealth(data);
      }
    } catch {
      // Swallow: next poll cycle will retry.
    }
  }, [setAgents, setCampaigns, setHealth]);

  // Start/stop polling based on WebSocket connection state.
  useEffect(() => {
    if (wsStatus === "open") {
      // WS connected — clear polling.
      if (pollTimer.current) {
        clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
    } else {
      // WS disconnected or reconnecting — poll as fallback.
      if (!pollTimer.current) {
        void fetchAll();
        pollTimer.current = setInterval(() => void fetchAll(), POLL_INTERVAL_MS);
      }
    }

    return () => {
      if (pollTimer.current) {
        clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
    };
  }, [wsStatus, fetchAll]);

  // WebSocket event subscriptions.
  // The ws singleton is accessed via useWsStore internals; for now we listen
  // to the global 'message' event broadcast by lib/ws.ts's internal dispatcher.
  // Phase 2: migrate to ws.subscribe<T>(topic, handler) once ws.ts exposes it
  // with typed topic routing.
  useEffect(() => {
    function handleWsMessage(e: Event): void {
      const msg = (e as CustomEvent<unknown>).detail;
      if (!msg || typeof msg !== "object") return;
      const { topic, payload } = msg as { topic?: string; payload?: unknown };

      if (topic === "events:vici2.agent.state") {
        const patch = payload as Partial<AgentSnapshot> & { uid: number };
        if (typeof patch.uid === "number") {
          patchAgent(patch.uid, patch);
        }
      }

      if (topic === "events:vici2.campaign.metrics") {
        // Full campaign refresh on each metrics event (simple, low-frequency).
        void fetchAll();
      }
    }

    window.addEventListener("vici2:ws:message", handleWsMessage as EventListener);
    return () => {
      window.removeEventListener("vici2:ws:message", handleWsMessage as EventListener);
    };
  }, [patchAgent, fetchAll]);

  const wsWarning = wsStatus !== "open" && wsStatus !== "connecting";

  return (
    <div className="flex flex-col gap-6">
      {/* System health strip */}
      <SystemHealthStrip health={health} />

      {/* WS disconnection warning */}
      {wsWarning && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
          WebSocket disconnected — showing last-known data, polling every 5 s.
        </div>
      )}

      {/* Campaign metrics */}
      <CampaignMetricsRow campaigns={campaigns} />

      {/* Agent grid */}
      <AgentGrid
        agents={agents}
        campaigns={campaigns}
        filter={filter}
        sort={sort}
        onFilterChange={setFilter}
        onSortChange={setSort}
      />
    </div>
  );
}
