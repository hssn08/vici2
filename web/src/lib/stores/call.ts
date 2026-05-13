"use client";

import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

export type CallPhase =
  | "idle"
  | "ringing"
  | "active"
  | "hold"
  | "wrapup"
  | "transferring";
export type CallDirection = "outbound" | "inbound" | null;
export type RecordingState = "on" | "off" | "paused";

export interface LeadSnapshot {
  id: string;
  firstName?: string;
  lastName?: string;
  phoneE164: string;
}

export interface CallState {
  callUuid: string | null;
  lead: LeadSnapshot | null;
  phase: CallPhase;
  direction: CallDirection;
  startedAt: number | null;
  muted: boolean;
  recording: RecordingState;
  lastEventSeq: number;

  setActiveCall: (args: {
    callUuid: string;
    direction: CallDirection;
    lead?: LeadSnapshot | null;
  }) => void;
  endCall: () => void;
  setPhase: (phase: CallPhase) => void;
  toggleMute: () => void;
  patchFromEvent: (event: { seq: number; patch: Partial<CallState> }) => void;
}

export const useCallStore = create<CallState>()(
  subscribeWithSelector((set) => ({
    callUuid: null,
    lead: null,
    phase: "idle",
    direction: null,
    startedAt: null,
    muted: false,
    recording: "off",
    lastEventSeq: 0,

    setActiveCall: ({ callUuid, direction, lead }) =>
      set({
        callUuid,
        direction,
        lead: lead ?? null,
        phase: "ringing",
        startedAt: Date.now(),
        muted: false,
        recording: "off",
      }),

    endCall: () =>
      set({
        callUuid: null,
        lead: null,
        phase: "idle",
        direction: null,
        startedAt: null,
        muted: false,
        recording: "off",
      }),

    setPhase: (phase) => set({ phase }),

    toggleMute: () => set((s) => ({ muted: !s.muted })),

    patchFromEvent: ({ seq, patch }) =>
      set((s) => (seq > s.lastEventSeq ? { ...patch, lastEventSeq: seq } : s)),
  })),
);
