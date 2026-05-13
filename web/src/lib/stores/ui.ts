"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export type Theme = "system" | "light" | "dark";
export type Density = "comfortable" | "compact";
export type DtmfMode = "rfc2833" | "sip-info";

export interface UiState {
  sidebarCollapsed: boolean;
  theme: Theme;
  density: Density;
  volume: number;
  lastUsedDispoCode: string | null;

  // A02 softphone preferences (persisted)
  dtmfMode: DtmfMode;
  forceTurn: boolean;
  preferredMicId: string | null;
  preferredSpeakerId: string | null;
  statsIntervalMs: number;

  // A05 in-call panel preferences (persisted)
  confirmHotkeyDispo: boolean;
  disableHangupGrace: boolean;
  hotkeyMap: Record<string, string>;

  // A06 auto-dial chime preferences (persisted)
  autoDialChimeVolume: number;
  autoDialChimeMuted: boolean;

  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setTheme: (theme: Theme) => void;
  setDensity: (density: Density) => void;
  setVolume: (v: number) => void;
  setLastUsedDispoCode: (code: string | null) => void;
  setDtmfMode: (mode: DtmfMode) => void;
  setForceTurn: (force: boolean) => void;
  setPreferredMicId: (deviceId: string | null) => void;
  setPreferredSpeakerId: (deviceId: string | null) => void;
  setStatsIntervalMs: (ms: number) => void;
  setConfirmHotkeyDispo: (v: boolean) => void;
  setDisableHangupGrace: (v: boolean) => void;
  setHotkeyMap: (map: Record<string, string>) => void;
  setAutoDialChimeVolume: (v: number) => void;
  setAutoDialChimeMuted: (v: boolean) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      theme: "system",
      density: "comfortable",
      volume: 0.8,
      lastUsedDispoCode: null,

      // A02 defaults
      dtmfMode: "rfc2833",
      forceTurn: false,
      preferredMicId: null,
      preferredSpeakerId: null,
      statsIntervalMs: 5000,

      // A05 defaults
      confirmHotkeyDispo: false,
      disableHangupGrace: false,
      hotkeyMap: {},

      // A06 defaults
      autoDialChimeVolume: 0.7,
      autoDialChimeMuted: false,

      toggleSidebar: () =>
        set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
      setTheme: (theme) => set({ theme }),
      setDensity: (density) => set({ density }),
      setVolume: (v) => set({ volume: Math.max(0, Math.min(1, v)) }),
      setLastUsedDispoCode: (code) => set({ lastUsedDispoCode: code }),
      setDtmfMode: (mode) => set({ dtmfMode: mode }),
      setForceTurn: (force) => set({ forceTurn: force }),
      setPreferredMicId: (deviceId) => set({ preferredMicId: deviceId }),
      setPreferredSpeakerId: (deviceId) => set({ preferredSpeakerId: deviceId }),
      setStatsIntervalMs: (ms) =>
        set({ statsIntervalMs: Math.max(1000, Math.min(30000, ms)) }),
      setConfirmHotkeyDispo: (v) => set({ confirmHotkeyDispo: v }),
      setDisableHangupGrace: (v) => set({ disableHangupGrace: v }),
      setHotkeyMap: (map) => set({ hotkeyMap: map }),
      setAutoDialChimeVolume: (v) => set({ autoDialChimeVolume: Math.max(0, Math.min(1, v)) }),
      setAutoDialChimeMuted: (v) => set({ autoDialChimeMuted: v }),
    }),
    {
      name: "vici2.ui",
      version: 4, // bumped for A06 auto-dial chime prefs
      storage: createJSONStorage(() =>
        typeof window !== "undefined" ? window.localStorage : noopStorage(),
      ),
      migrate: (persisted, version) => {
        const state = persisted as Partial<UiState>;
        if (version < 2) {
          // A02 new fields — apply defaults
          state.dtmfMode = "rfc2833";
          state.forceTurn = false;
          state.preferredMicId = null;
          state.preferredSpeakerId = null;
          state.statsIntervalMs = 5000;
        }
        if (version < 3) {
          // A05 new fields — apply defaults
          state.confirmHotkeyDispo = false;
          state.disableHangupGrace = false;
          state.hotkeyMap = {};
        }
        if (version < 4) {
          // A06 new fields — apply defaults
          state.autoDialChimeVolume = 0.7;
          state.autoDialChimeMuted = false;
        }
        return state as UiState;
      },
    },
  ),
);

function noopStorage(): Storage {
  return {
    length: 0,
    clear: () => undefined,
    getItem: () => null,
    key: () => null,
    removeItem: () => undefined,
    setItem: () => undefined,
  };
}
