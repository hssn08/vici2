"use client";

import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

export type AgentStatus =
  | "logged-out"
  | "ready"
  | "paused"
  | "busy"
  | "wrapup";

export interface AgentState {
  status: AgentStatus;
  pauseCode: string | null;
  pausedSince: number | null;
  currentCampaignId: number | null;
  inboundGroupIds: number[];

  setStatus: (status: AgentStatus) => void;
  setPause: (code: string) => void;
  clearPause: () => void;
  joinCampaign: (id: number | null) => void;
  patchFromEvent: (patch: Partial<AgentState>) => void;
}

export const useAgentStore = create<AgentState>()(
  subscribeWithSelector((set) => ({
    status: "logged-out",
    pauseCode: null,
    pausedSince: null,
    currentCampaignId: null,
    inboundGroupIds: [],

    setStatus: (status) => set({ status }),

    setPause: (code) =>
      set({ status: "paused", pauseCode: code, pausedSince: Date.now() }),

    clearPause: () =>
      set({ status: "ready", pauseCode: null, pausedSince: null }),

    joinCampaign: (id) => set({ currentCampaignId: id }),

    patchFromEvent: (patch) => set((s) => ({ ...s, ...patch })),
  })),
);
