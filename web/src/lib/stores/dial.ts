"use client";

import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

// ── Types ─────────────────────────────────────────────────────────────────────

export type DialErrorCode =
  | "INVALID_PHONE"
  | "TCPA_BLOCKED"
  | "DNC_BLOCKED"
  | "CONSENT_BLOCKED"
  | "GATEWAY_LIMIT"
  | "CARRIER_FAIL"
  | "AGENT_DIAL_LOCK"
  | "AGENT_NOT_READY"
  | "PENDING_DISPO"
  | "CALL_FAILED"
  | "ALREADY_BRIDGED"
  | "NOT_YOUR_CALL"
  | "STALE_CLAIM"
  | "CAMPAIGN_PAUSED"
  | "COUNTRY_NOT_ALLOWED";

export type DialMode = "manual" | "next" | "preview";

export interface LeadPreview {
  id: number;
  firstName: string | null;
  lastName: string | null;
  vendorLeadCode: string | null;
  phoneE164: string;
  phoneType: string | null;
  city: string | null;
  state: string | null;
  stateAbbr: string | null;
  postalCode: string | null;
  tzOffsetMin: number | null;
  tzName: string | null;
  customData: Record<string, unknown> | null;
  calledCount: number;
  lastCalledAt: string | null;
  listId: number | null;
}

export interface BlockReason {
  code: DialErrorCode;
  message: string;
  retryAfter?: number;
  detail?: Record<string, unknown>;
}

export type TcpaHint = "allow" | "skip_until" | "block" | "unknown";
export type DncHint = "clear" | "hit" | "unknown";

export interface ClientGates {
  phoneValid: boolean;
  tcpaHint: TcpaHint;
  dncHint: DncHint;
  agentReady: boolean;
  noInFlight: boolean;
  campaignActive: boolean;
}

// 7-state discriminated union
export type DialPhaseState =
  | { state: "idle" }
  | { state: "modal_open" }
  | { state: "loading_lead" }
  | { state: "lead_selected"; lead: LeadPreview }
  | { state: "call_requested"; lead: LeadPreview }
  | { state: "calling"; lead: LeadPreview; attemptUuid: string; callUuid: string | null }
  | { state: "blocked"; lead: LeadPreview | null; reason: BlockReason };

// ── Store ─────────────────────────────────────────────────────────────────────

export interface DialState {
  dialPhase: DialPhaseState;
  dialMode: DialMode | null;
  hopperClaimToken: string | null;
  clientGates: ClientGates;
  consentAttested: boolean;

  // Actions
  openModal: () => void;
  closeModal: () => void;
  setLoadingLead: () => void;
  setLead: (lead: LeadPreview, mode?: DialMode) => void;
  startCallRequested: () => void;
  setAttemptUuid: (attemptUuid: string) => void;
  setCallUuid: (callUuid: string) => void;
  setBlock: (reason: BlockReason) => void;
  clearBlock: () => void;
  setHopperClaimToken: (token: string | null) => void;
  setDialMode: (mode: DialMode | null) => void;
  setClientGates: (gates: Partial<ClientGates>) => void;
  setConsentAttested: (v: boolean) => void;
  resetDial: () => void;
  restoreFromServer: (data: {
    attempt_uuid: string;
    phase: string;
    lead: LeadPreview;
    started_at: string;
  }) => void;
}

const DEFAULT_GATES: ClientGates = {
  phoneValid: false,
  tcpaHint: "unknown",
  dncHint: "unknown",
  agentReady: false,
  noInFlight: true,
  campaignActive: false,
};

export const useDialStore = create<DialState>()(
  subscribeWithSelector((set, get) => ({
    dialPhase: { state: "idle" },
    dialMode: null,
    hopperClaimToken: null,
    clientGates: DEFAULT_GATES,
    consentAttested: false,

    openModal: () =>
      set((s) =>
        s.dialPhase.state === "idle" ? { dialPhase: { state: "modal_open" } } : s,
      ),

    closeModal: () =>
      set((s) =>
        s.dialPhase.state === "modal_open" ? { dialPhase: { state: "idle" } } : s,
      ),

    setLoadingLead: () =>
      set({ dialPhase: { state: "loading_lead" } }),

    setLead: (lead, mode) =>
      set((s) => ({
        dialPhase: { state: "lead_selected", lead },
        dialMode: mode ?? s.dialMode,
        clientGates: { ...s.clientGates, noInFlight: true },
        consentAttested: false,
      })),

    startCallRequested: () =>
      set((s) => {
        if (s.dialPhase.state !== "lead_selected") return s;
        return {
          dialPhase: { state: "call_requested", lead: s.dialPhase.lead },
          clientGates: { ...s.clientGates, noInFlight: false },
        };
      }),

    setAttemptUuid: (attemptUuid) =>
      set((s) => {
        if (
          s.dialPhase.state !== "call_requested" &&
          s.dialPhase.state !== "calling"
        )
          return s;
        const lead =
          s.dialPhase.state === "call_requested"
            ? s.dialPhase.lead
            : s.dialPhase.lead;
        return {
          dialPhase: {
            state: "calling",
            lead,
            attemptUuid,
            callUuid: s.dialPhase.state === "calling" ? s.dialPhase.callUuid : null,
          },
        };
      }),

    setCallUuid: (callUuid) =>
      set((s) => {
        if (s.dialPhase.state !== "calling") return s;
        return {
          dialPhase: { ...s.dialPhase, callUuid },
        };
      }),

    setBlock: (reason) =>
      set((s) => {
        const lead =
          s.dialPhase.state === "lead_selected" ||
          s.dialPhase.state === "call_requested" ||
          s.dialPhase.state === "calling"
            ? s.dialPhase.lead
            : null;
        return {
          dialPhase: { state: "blocked", lead, reason },
          clientGates: { ...s.clientGates, noInFlight: true },
        };
      }),

    clearBlock: () =>
      set((s) => {
        if (s.dialPhase.state !== "blocked") return s;
        if (s.dialPhase.lead) {
          return {
            dialPhase: { state: "lead_selected", lead: s.dialPhase.lead },
            clientGates: { ...s.clientGates, noInFlight: true },
          };
        }
        return { dialPhase: { state: "idle" } };
      }),

    setHopperClaimToken: (token) => set({ hopperClaimToken: token }),

    setDialMode: (mode) => set({ dialMode: mode }),

    setClientGates: (gates) =>
      set((s) => ({ clientGates: { ...s.clientGates, ...gates } })),

    setConsentAttested: (v) => set({ consentAttested: v }),

    resetDial: () =>
      set({
        dialPhase: { state: "idle" },
        dialMode: null,
        hopperClaimToken: null,
        clientGates: DEFAULT_GATES,
        consentAttested: false,
      }),

    restoreFromServer: ({ attempt_uuid, phase, lead }) => {
      const ds = get();
      if (ds.dialPhase.state !== "idle") return; // already restored
      if (phase === "ringing" || phase === "active") {
        set({
          dialPhase: {
            state: "calling",
            lead,
            attemptUuid: attempt_uuid,
            callUuid: null,
          },
        });
      }
    },
  })),
);
