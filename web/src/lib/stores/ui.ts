"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export type Theme = "system" | "light" | "dark";
export type Density = "comfortable" | "compact";

export interface UiState {
  sidebarCollapsed: boolean;
  theme: Theme;
  density: Density;
  volume: number;
  lastUsedDispoCode: string | null;

  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setTheme: (theme: Theme) => void;
  setDensity: (density: Density) => void;
  setVolume: (v: number) => void;
  setLastUsedDispoCode: (code: string | null) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      theme: "system",
      density: "comfortable",
      volume: 0.8,
      lastUsedDispoCode: null,

      toggleSidebar: () =>
        set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
      setTheme: (theme) => set({ theme }),
      setDensity: (density) => set({ density }),
      setVolume: (v) => set({ volume: Math.max(0, Math.min(1, v)) }),
      setLastUsedDispoCode: (code) => set({ lastUsedDispoCode: code }),
    }),
    {
      name: "vici2.ui",
      version: 1,
      storage: createJSONStorage(() =>
        typeof window !== "undefined" ? window.localStorage : noopStorage(),
      ),
      migrate: (persisted) => persisted as UiState,
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
