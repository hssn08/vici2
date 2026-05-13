"use client";

// AgentTile — a single agent's tile in the supervisor agent grid.
//
// Shows: state badge, display name, campaign, call duration, lead phone (last 4),
// monitor count badge.
//
// Clicking an IN_CALL tile invokes onMonitor(agent) to open the S02 MonitorModal.
//
// S01 PLAN §5.

import React, { useState, useEffect } from "react";
import type { AgentSnapshot, AgentState } from "@/lib/stores/dashboard.js";

export interface AgentTileProps {
  agent: AgentSnapshot;
  /** Called when the supervisor clicks the tile to open the monitor modal. */
  onMonitor: (agent: AgentSnapshot) => void;
}

const STATE_CONFIG: Record<
  AgentState,
  { label: string; bg: string; text: string; ring: string }
> = {
  IN_CALL: {
    label: "In Call",
    bg: "bg-[var(--color-state-active,#16a34a)]",
    text: "text-white",
    ring: "ring-green-400",
  },
  READY: {
    label: "Ready",
    bg: "bg-[var(--color-state-idle,#2563eb)]",
    text: "text-white",
    ring: "ring-blue-400",
  },
  WRAPUP: {
    label: "Wrap-up",
    bg: "bg-[var(--color-state-wrap,#d97706)]",
    text: "text-white",
    ring: "ring-amber-400",
  },
  PAUSED: {
    label: "Paused",
    bg: "bg-gray-400",
    text: "text-white",
    ring: "ring-gray-300",
  },
  LOGOUT: {
    label: "Logged Out",
    bg: "bg-gray-200 dark:bg-gray-700",
    text: "text-gray-500 dark:text-gray-400",
    ring: "ring-gray-200",
  },
};

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function AgentTile({ agent, onMonitor }: AgentTileProps): React.ReactElement {
  const cfg = STATE_CONFIG[agent.state];
  const clickable = agent.state === "IN_CALL";

  // Live call timer: tick every second for IN_CALL agents.
  const [elapsed, setElapsed] = useState(agent.callDurationSec ?? 0);
  useEffect(() => {
    if (agent.state !== "IN_CALL") {
      setElapsed(0);
      return;
    }
    setElapsed(agent.callDurationSec ?? 0);
    const id = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(id);
  }, [agent.state, agent.callDurationSec]);

  const handleClick = (): void => {
    if (clickable) onMonitor(agent);
  };

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (clickable && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      onMonitor(agent);
    }
  };

  return (
    <div
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      aria-label={
        clickable
          ? `Monitor ${agent.displayName} — click to open monitor options`
          : `${agent.displayName} — ${cfg.label}`
      }
      className={[
        "relative flex flex-col gap-2 rounded-xl border p-4 transition-all duration-150",
        "border-[var(--color-surface-border)] bg-[var(--color-surface)]",
        clickable
          ? "cursor-pointer hover:shadow-md hover:ring-2 hover:ring-offset-1 hover:ring-green-400 active:scale-[0.98]"
          : "cursor-default",
      ].join(" ")}
    >
      {/* Monitor count badge */}
      {agent.monitorCount > 0 && (
        <span
          className="absolute right-3 top-3 flex h-5 w-5 items-center justify-center rounded-full bg-blue-600 text-[10px] font-bold text-white"
          title={`${agent.monitorCount} supervisor${agent.monitorCount !== 1 ? "s" : ""} monitoring`}
        >
          {agent.monitorCount}
        </span>
      )}

      {/* State badge */}
      <span
        className={`self-start rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${cfg.bg} ${cfg.text}`}
      >
        {cfg.label}
      </span>

      {/* Name */}
      <p className="truncate text-sm font-semibold leading-tight">
        {agent.displayName}
      </p>

      {/* Campaign */}
      {agent.campaignName && (
        <p className="truncate text-xs text-[var(--color-fg-muted)]">
          {agent.campaignName}
        </p>
      )}

      {/* Call info */}
      {agent.state === "IN_CALL" && (
        <div className="flex items-center justify-between text-xs">
          <span className="font-mono tabular-nums text-[var(--color-fg-muted)]">
            {formatDuration(elapsed)}
          </span>
          {agent.leadPhone && (
            <span className="rounded bg-[var(--color-surface-muted)] px-1.5 py-0.5 font-mono text-[var(--color-fg-muted)]">
              ···{agent.leadPhone}
            </span>
          )}
        </div>
      )}

      {/* Hint for clickable tiles */}
      {clickable && (
        <p className="mt-1 text-[10px] text-[var(--color-fg-muted)] opacity-70">
          Click to monitor
        </p>
      )}
    </div>
  );
}
