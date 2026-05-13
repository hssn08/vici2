"use client";

// WallboardClient — top-level client island for the S04 TV wallboard.
//
// Responsibilities:
//  - Seed dashboardStore from SSR-provided initial data.
//  - Subscribe to WS events (agent.state, campaign.metrics) via lib/ws.ts.
//  - 10-second polling fallback when WS is disconnected.
//  - Rotate through configured boards on a fixed interval.
//  - Fullscreen API + Wake Lock API.
//  - Render the correct board component for the current rotation slot.
//
// S04 PLAN §3.

import React, { useEffect, useCallback, useRef } from "react";
import { useDashboardStore } from "@/lib/stores/dashboard.js";
import type { AgentSnapshot, CampaignMetrics, SystemHealth } from "@/lib/stores/dashboard.js";
import { useWallboardStore, ALL_BOARDS } from "@/lib/stores/wallboard.js";
import type { BoardId } from "@/lib/stores/wallboard.js";
import { useWsStore } from "@/lib/stores/ws.js";
import { useFullscreen } from "@/lib/hooks/useFullscreen.js";
import { useWakeLock } from "@/lib/hooks/useWakeLock.js";
import { useWallboardRotation } from "@/lib/hooks/useWallboardRotation.js";
import { WallboardHeader } from "./WallboardHeader.js";
import { RotationDots } from "./RotationDots.js";
import { BoardAgents } from "./BoardAgents.js";
import { BoardCampaigns } from "./BoardCampaigns.js";
import { BoardQueue } from "./BoardQueue.js";
import { BoardPerformers } from "./BoardPerformers.js";

const POLL_INTERVAL_MS = 10_000;

export interface WallboardClientProps {
  initialAgents: AgentSnapshot[];
  initialCampaigns: CampaignMetrics[];
  initialHealth: SystemHealth | null;
  /** Rotation interval in seconds (from URL param or config). */
  rotateSeconds: number;
  /** Comma-separated board IDs from URL param (overrides store). */
  boardsParam?: string;
  theme: "dark" | "light";
}

/** Render the correct board for the given board ID. */
function ActiveBoard({
  boardId,
  agents,
  campaigns,
}: {
  boardId: string;
  agents: AgentSnapshot[];
  campaigns: CampaignMetrics[];
}): React.ReactElement {
  switch (boardId as BoardId) {
    case "agents":
      return <BoardAgents agents={agents} />;
    case "campaigns":
      return <BoardCampaigns campaigns={campaigns} />;
    case "queue":
      return <BoardQueue campaigns={campaigns} />;
    case "performers":
      return <BoardPerformers agents={agents} />;
    default:
      return (
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#475569",
          }}
        >
          Unknown board: {boardId}
        </div>
      );
  }
}

export function WallboardClient({
  initialAgents,
  initialCampaigns,
  initialHealth,
  rotateSeconds,
  boardsParam,
  theme,
}: WallboardClientProps): React.ReactElement {
  // Seed dashboard store from server-rendered initial data (once on mount).
  const setAgents = useDashboardStore((s) => s.setAgents);
  const setCampaigns = useDashboardStore((s) => s.setCampaigns);
  const setHealth = useDashboardStore((s) => s.setHealth);
  const patchAgent = useDashboardStore((s) => s.patchAgent);
  const agents = useDashboardStore((s) => s.agents);
  const campaigns = useDashboardStore((s) => s.campaigns);

  const wsStatus = useWsStore((s) => s.connection);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const initRef = useRef(false);
  if (!initRef.current) {
    initRef.current = true;
    setAgents(initialAgents);
    setCampaigns(initialCampaigns);
    if (initialHealth) setHealth(initialHealth);
  }

  // Determine board list: URL param overrides store.
  const storeBoards = useWallboardStore((s) => s.boards);
  const activeBoardIds: string[] = React.useMemo(() => {
    if (boardsParam) {
      const ids = boardsParam.split(",").filter((id) => (ALL_BOARDS as string[]).includes(id));
      return ids.length > 0 ? ids : [...ALL_BOARDS];
    }
    return storeBoards.length > 0 ? storeBoards : [...ALL_BOARDS];
  }, [boardsParam, storeBoards]);

  // Rotation.
  const rotation = useWallboardRotation(activeBoardIds, rotateSeconds * 1000);

  // Fullscreen.
  const fullscreen = useFullscreen();

  // Wake lock.
  useWakeLock();

  // Polling fallback.
  const fetchAll = useCallback(async (): Promise<void> => {
    try {
      const [agentsRes, campaignsRes] = await Promise.all([
        fetch("/api/sup/agents"),
        fetch("/api/sup/campaigns/metrics"),
      ]);
      if (agentsRes.ok) {
        const data = await agentsRes.json() as { agents: AgentSnapshot[] };
        setAgents(data.agents);
      }
      if (campaignsRes.ok) {
        const data = await campaignsRes.json() as { campaigns: CampaignMetrics[] };
        setCampaigns(data.campaigns);
      }
    } catch {
      // Swallow; next poll will retry.
    }
  }, [setAgents, setCampaigns]);

  useEffect(() => {
    if (wsStatus === "open") {
      if (pollTimer.current) {
        clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
    } else {
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

  // WS event subscriptions.
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
        void fetchAll();
      }
    }

    window.addEventListener("vici2:ws:message", handleWsMessage as EventListener);
    return () => {
      window.removeEventListener("vici2:ws:message", handleWsMessage as EventListener);
    };
  }, [patchAgent, fetchAll]);

  // Theme tokens.
  const bg = theme === "dark" ? "#0a0d14" : "#f8fafc";
  const fg = theme === "dark" ? "#f1f5f9" : "#0f172a";

  return (
    <div
      ref={fullscreen.ref as React.RefObject<HTMLDivElement>}
      data-testid="wallboard-root"
      onMouseEnter={() => rotation.setPaused(true)}
      onMouseLeave={() => rotation.setPaused(false)}
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        background: bg,
        color: fg,
        // 28px base font for TV / 1080p screens; scales with viewport.
        fontSize: "clamp(1rem, 1.8vw, 1.75rem)",
        fontFamily: "system-ui, -apple-system, sans-serif",
        lineHeight: 1.4,
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <WallboardHeader
        currentBoard={rotation.currentBoard}
        fullscreen={fullscreen.fullscreen}
        onToggleFullscreen={() => void fullscreen.toggle()}
      />

      {/* WS disconnection banner */}
      {wsStatus !== "open" && wsStatus !== "connecting" && (
        <div
          role="alert"
          style={{
            background: "rgba(245,158,11,0.15)",
            borderBottom: "1px solid rgba(245,158,11,0.3)",
            padding: "0.25em 1em",
            fontSize: "0.55em",
            color: "#fbbf24",
            textAlign: "center",
            flexShrink: 0,
          }}
        >
          WebSocket disconnected — polling every 10 s
        </div>
      )}

      {/* Active board */}
      <ActiveBoard
        boardId={rotation.currentBoard}
        agents={agents}
        campaigns={campaigns}
      />

      {/* Rotation dots */}
      {activeBoardIds.length > 1 && (
        <RotationDots
          boards={activeBoardIds}
          currentIndex={rotation.currentIndex}
          progress={rotation.progress}
          onGoTo={rotation.goTo}
        />
      )}

      {/* Print-only: show all boards stacked */}
      <style>{`
        @media print {
          [data-testid="wallboard-root"] {
            position: static !important;
            font-size: 12pt !important;
            background: #fff !important;
            color: #000 !important;
          }
          [data-wallboard-header], nav[aria-label="Wallboard board navigation"] {
            display: none !important;
          }
        }
      `}</style>
    </div>
  );
}
