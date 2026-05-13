"use client";

import { create } from "zustand";

export type WsConnectionState =
  | "idle"
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed";

export interface WsStoreState {
  connection: WsConnectionState;
  lastPongAt: number | null;
  lastSeq: number;
  pendingOutbound: number;

  setConnection: (s: WsConnectionState) => void;
  noteSeq: (n: number) => void;
  notePong: (ts: number) => void;
  noteOutboundSize: (n: number) => void;
}

export const useWsStore = create<WsStoreState>((set) => ({
  connection: "idle",
  lastPongAt: null,
  lastSeq: 0,
  pendingOutbound: 0,

  setConnection: (s) => set({ connection: s }),
  noteSeq: (n) => set((s) => (n > s.lastSeq ? { lastSeq: n } : s)),
  notePong: (ts) => set({ lastPongAt: ts }),
  noteOutboundSize: (n) => set({ pendingOutbound: n }),
}));
