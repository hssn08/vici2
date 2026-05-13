"use client";

// wallboard store — persists TV wallboard configuration (boards order, rotate interval).
//
// Backed by localStorage so settings survive page refreshes.
// Phase 2 will sync to the wallboard_layouts API endpoint.
//
// S04 PLAN §3.2, §7.

import { create } from "zustand";
import { persist } from "zustand/middleware";

export type BoardId = "agents" | "campaigns" | "queue" | "performers";

export const ALL_BOARDS: BoardId[] = ["agents", "campaigns", "queue", "performers"];

export const BOARD_LABELS: Record<BoardId, string> = {
  agents: "Agents on Calls",
  campaigns: "Campaign Performance",
  queue: "Inbound Queue",
  performers: "Top Performers",
};

interface WallboardState {
  /** Ordered list of board IDs to rotate through. */
  boards: BoardId[];
  /** Rotation interval in milliseconds. */
  rotateMs: number;
  /** Visual theme. */
  theme: "dark" | "light";

  setBoards: (boards: BoardId[]) => void;
  setRotateMs: (ms: number) => void;
  setTheme: (theme: "dark" | "light") => void;
}

export const useWallboardStore = create<WallboardState>()(
  persist(
    (set) => ({
      boards: [...ALL_BOARDS],
      rotateMs: 30_000,
      theme: "dark",

      setBoards: (boards) => set({ boards }),
      setRotateMs: (rotateMs) => set({ rotateMs }),
      setTheme: (theme) => set({ theme }),
    }),
    {
      name: "vici2:wallboard",
      // Only persist config; transient data (agents, campaigns) comes from dashboardStore.
      partialize: (state) => ({
        boards: state.boards,
        rotateMs: state.rotateMs,
        theme: state.theme,
      }),
    },
  ),
);
