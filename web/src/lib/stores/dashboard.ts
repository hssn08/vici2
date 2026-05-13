"use client";

// useDashboardStore — Zustand store for the S01 supervisor dashboard.
// Holds agent snapshots, campaign metrics, and system health.
// Updated by WebSocket events and periodic polling.
//
// S01 PLAN §6.

import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

export type AgentState = "READY" | "IN_CALL" | "WRAPUP" | "PAUSED" | "LOGOUT";

export interface AgentSnapshot {
  uid: number;
  displayName: string;
  state: AgentState;
  campaignId: number | null;
  campaignName: string | null;
  callDurationSec: number | null;
  leadPhone: string | null;
  monitorCount: number;
  teamId: number | null;
}

export interface CampaignMetrics {
  campaignId: number;
  campaignName: string;
  dialLevel: number;
  inFlight: number;
  agentsReady: number;
  agentsWaiting: number;
  queueDepth: number;
  leadsCallable: number;
  dropPct30d: number;
  dropGated: boolean;
}

export interface SystemHealth {
  freeswitchUp: boolean;
  mysqlUp: boolean;
  valkeyUp: boolean;
  dialerPodsUp: number;
  dialerPodsTotal: number;
  scrapeStalenessMs: number;
  scrapeAt: string;
}

export type AgentSortKey = "state" | "name" | "duration";

export interface DashboardFilter {
  state?: AgentState;
  campaignId?: number;
}

interface DashboardState {
  agents: AgentSnapshot[];
  campaigns: CampaignMetrics[];
  health: SystemHealth | null;
  filter: DashboardFilter;
  sort: AgentSortKey;
  lastFetchAt: number | null;

  setAgents: (agents: AgentSnapshot[]) => void;
  setCampaigns: (campaigns: CampaignMetrics[]) => void;
  setHealth: (health: SystemHealth) => void;
  setFilter: (filter: Partial<DashboardFilter>) => void;
  setSort: (sort: AgentSortKey) => void;

  /** Merge a partial update into a single agent by uid. */
  patchAgent: (uid: number, partial: Partial<AgentSnapshot>) => void;
  /** Merge a partial update into a single campaign by id. */
  patchCampaign: (campaignId: number, partial: Partial<CampaignMetrics>) => void;
}

export const useDashboardStore = create<DashboardState>()(
  subscribeWithSelector((set) => ({
    agents: [],
    campaigns: [],
    health: null,
    filter: {},
    sort: "state",
    lastFetchAt: null,

    setAgents: (agents) => set({ agents, lastFetchAt: Date.now() }),
    setCampaigns: (campaigns) => set({ campaigns }),
    setHealth: (health) => set({ health }),

    setFilter: (partial) =>
      set((s) => ({ filter: { ...s.filter, ...partial } })),

    setSort: (sort) => set({ sort }),

    patchAgent: (uid, partial) =>
      set((s) => ({
        agents: s.agents.map((a) => (a.uid === uid ? { ...a, ...partial } : a)),
      })),

    patchCampaign: (campaignId, partial) =>
      set((s) => ({
        campaigns: s.campaigns.map((c) =>
          c.campaignId === campaignId ? { ...c, ...partial } : c,
        ),
      })),
  })),
);

/** Sorted + filtered view derived from store state. */
export function selectFilteredAgents(state: DashboardState): AgentSnapshot[] {
  let agents = state.agents;

  if (state.filter.state) {
    agents = agents.filter((a) => a.state === state.filter.state);
  }
  if (state.filter.campaignId != null) {
    agents = agents.filter((a) => a.campaignId === state.filter.campaignId);
  }

  return [...agents].sort((a, b) => {
    switch (state.sort) {
      case "name":
        return a.displayName.localeCompare(b.displayName);
      case "duration": {
        const ad = a.callDurationSec ?? -1;
        const bd = b.callDurationSec ?? -1;
        return bd - ad; // descending — longest call first
      }
      case "state":
      default: {
        const order: Record<AgentState, number> = {
          IN_CALL: 0,
          WRAPUP: 1,
          READY: 2,
          PAUSED: 3,
          LOGOUT: 4,
        };
        return (order[a.state] ?? 9) - (order[b.state] ?? 9);
      }
    }
  });
}
