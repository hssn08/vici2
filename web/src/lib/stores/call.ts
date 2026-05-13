"use client";

import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

export type CallPhase =
  | "idle"
  | "ringing"
  | "active"
  | "hold"
  | "wrapup"
  | "transferring"
  | "reconnecting"; // A02: SIP.js transport recovery in progress
export type CallDirection = "outbound" | "inbound" | null;
export type RecordingState = "on" | "off" | "paused" | "pending";
export type ConsentStatus =
  | "ALLOW"
  | "PROMPT_MESSAGE"
  | "PROMPT_BEEP"
  | "REQUIRE_ACTIVE"
  | "SKIP"
  | null;

export interface LeadSnapshot {
  id: string;
  firstName?: string;
  lastName?: string;
  title?: string;
  middleInitial?: string;
  phoneE164: string;
  phoneAlt?: string;
  phoneAlt2?: string;
  email?: string;
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  dateOfBirth?: string;
  vendorLeadCode?: string;
  status?: string;
  calledCount?: number;
  lastCalledAt?: string;
  tzOffsetMin?: number;
  listId?: number;
  listName?: string;
  customData?: Record<string, unknown>;
}

export interface CampaignConfig {
  id: number;
  name: string;
  recording_mode: "NEVER" | "ONDEMAND" | "ALL" | "ALLFORCE";
  wrapup_seconds: number;
  hangup_grace_seconds: number;
  hot_keys_active: boolean;
  webform_url: string | null;
}

export interface ConferenceParticipant {
  uuid: string;
  role: "customer" | "agent" | "third_party";
  displayName?: string;
  phoneE164?: string;
  muted: boolean;
  joinedAt: number;
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

  // A05 additions
  campaign: CampaignConfig | null;
  consent: ConsentStatus;
  notes: string;
  threeWayParticipants: ConferenceParticipant[];
  hangupGraceActive: boolean;
  hangupGraceTimer: ReturnType<typeof setTimeout> | null;
  wrapupStartAt: number | null;

  setActiveCall: (args: {
    callUuid: string;
    direction: CallDirection;
    lead?: LeadSnapshot | null;
    campaign?: CampaignConfig | null;
  }) => void;
  endCall: () => void;
  clearCall: () => void;
  setPhase: (phase: CallPhase) => void;
  toggleMute: () => void;
  setRecording: (state: RecordingState) => void;
  setConsent: (consent: ConsentStatus) => void;
  setNotes: (text: string) => void;
  addParticipant: (p: ConferenceParticipant) => void;
  removeParticipant: (uuid: string) => void;
  updateParticipant: (uuid: string, patch: Partial<ConferenceParticipant>) => void;
  setHangupGrace: (active: boolean, timer?: ReturnType<typeof setTimeout> | null) => void;
  patchFromEvent: (event: { seq: number; patch: Partial<CallState> }) => void;
}

const EMPTY_CALL = {
  callUuid: null as string | null,
  lead: null as LeadSnapshot | null,
  phase: "idle" as CallPhase,
  direction: null as CallDirection,
  startedAt: null as number | null,
  muted: false,
  recording: "off" as RecordingState,
  lastEventSeq: 0,
  campaign: null as CampaignConfig | null,
  consent: null as ConsentStatus,
  notes: "",
  threeWayParticipants: [] as ConferenceParticipant[],
  hangupGraceActive: false,
  hangupGraceTimer: null as ReturnType<typeof setTimeout> | null,
  wrapupStartAt: null as number | null,
};

export const useCallStore = create<CallState>()(
  subscribeWithSelector((set) => ({
    ...EMPTY_CALL,

    setActiveCall: ({ callUuid, direction, lead, campaign }) =>
      set({
        callUuid,
        direction,
        lead: lead ?? null,
        phase: "ringing",
        startedAt: Date.now(),
        muted: false,
        recording: "off",
        campaign: campaign ?? null,
        consent: null,
        notes: "",
        threeWayParticipants: [],
        hangupGraceActive: false,
        hangupGraceTimer: null,
        wrapupStartAt: null,
      }),

    endCall: () => set({ ...EMPTY_CALL }),
    clearCall: () => set({ ...EMPTY_CALL }),

    setPhase: (phase) =>
      set((s) => ({
        phase,
        wrapupStartAt:
          phase === "wrapup" && s.phase !== "wrapup"
            ? Date.now()
            : s.wrapupStartAt,
      })),

    toggleMute: () => set((s) => ({ muted: !s.muted })),

    setRecording: (recording) => set({ recording }),

    setConsent: (consent) => set({ consent }),

    setNotes: (notes) => set({ notes }),

    addParticipant: (p) =>
      set((s) => ({
        threeWayParticipants: [...s.threeWayParticipants, p],
      })),

    removeParticipant: (uuid) =>
      set((s) => ({
        threeWayParticipants: s.threeWayParticipants.filter(
          (p) => p.uuid !== uuid,
        ),
      })),

    updateParticipant: (uuid, patch) =>
      set((s) => ({
        threeWayParticipants: s.threeWayParticipants.map((p) =>
          p.uuid === uuid ? { ...p, ...patch } : p,
        ),
      })),

    setHangupGrace: (active, timer = null) =>
      set({ hangupGraceActive: active, hangupGraceTimer: timer }),

    patchFromEvent: ({ seq, patch }) =>
      set((s) => (seq > s.lastEventSeq ? { ...patch, lastEventSeq: seq } : s)),
  })),
);
