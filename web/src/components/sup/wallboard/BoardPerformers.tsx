"use client";

// BoardPerformers — "Top Performers" wallboard board.
//
// Phase 1: top 5 agents by call duration (proxy for productivity).
// Phase 2: real sales count from disposition data (A-track).
//
// S04 PLAN §2 (board: performers), §3.6.

import React, { useState, useEffect } from "react";
import type { AgentSnapshot } from "@/lib/stores/dashboard.js";

export interface BoardPerformersProps {
  agents: AgentSnapshot[];
  /** How many top performers to show; defaults to 5. */
  topN?: number;
}

function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) {
    return `${h}h ${m}m`;
  }
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

const MEDAL: Record<number, string> = { 0: "gold", 1: "silver", 2: "#cd7f32" };
const MEDAL_LABEL: Record<number, string> = { 0: "1st", 1: "2nd", 2: "3rd" };

function LiveDuration({ initialSec, active }: { initialSec: number; active: boolean }): React.ReactElement {
  const [sec, setSec] = useState(initialSec);

  useEffect(() => {
    setSec(initialSec);
    if (!active) return;
    const id = setInterval(() => setSec((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [initialSec, active]);

  return <span>{formatDuration(sec)}</span>;
}

export function BoardPerformers({ agents, topN = 5 }: BoardPerformersProps): React.ReactElement {
  // Top performers = agents with longest total call time (IN_CALL or WRAPUP with callDurationSec).
  const eligible = agents
    .filter((a) => a.state === "IN_CALL" || (a.state === "WRAPUP" && a.callDurationSec != null))
    .sort((a, b) => (b.callDurationSec ?? 0) - (a.callDurationSec ?? 0))
    .slice(0, topN);

  if (eligible.length === 0) {
    return (
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "0.5em",
          color: "#475569",
        }}
      >
        <span style={{ fontSize: "1em" }}>No active calls</span>
        <span style={{ fontSize: "0.6em", color: "#334155" }}>
          Top performers appear here once agents are on calls.
        </span>
      </div>
    );
  }

  return (
    <div
      style={{
        flex: 1,
        padding: "1em 2em",
        display: "flex",
        flexDirection: "column",
        gap: "0.6em",
        justifyContent: "center",
        overflow: "auto",
      }}
    >
      {/* Stub label */}
      <div
        style={{
          fontSize: "0.55em",
          color: "#475569",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          marginBottom: "0.4em",
          fontStyle: "italic",
        }}
      >
        Ranked by call time today (Phase 1 proxy — sales leaderboard in Phase 2)
      </div>

      {eligible.map((agent, i) => {
        const medalColor = MEDAL[i] ?? "#94a3b8";
        const medalLabel = MEDAL_LABEL[i] ?? `${i + 1}th`;

        return (
          <div
            key={agent.uid}
            role="listitem"
            style={{
              display: "flex",
              alignItems: "center",
              gap: "1em",
              background: i === 0 ? "rgba(234,179,8,0.08)" : "rgba(255,255,255,0.03)",
              borderRadius: "0.5em",
              padding: "0.6em 0.9em",
              border: `1px solid ${i === 0 ? "rgba(234,179,8,0.3)" : "rgba(255,255,255,0.06)"}`,
            }}
          >
            {/* Rank */}
            <span
              aria-label={`Rank ${i + 1}`}
              style={{
                fontSize: "1.2em",
                fontWeight: 900,
                color: medalColor,
                minWidth: "1.8em",
                textAlign: "center",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {medalLabel}
            </span>

            {/* Agent info */}
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "0.15em" }}>
              <span style={{ fontSize: "1em", fontWeight: 700, color: "#f1f5f9" }}>
                {agent.displayName}
              </span>
              {agent.campaignName && (
                <span style={{ fontSize: "0.55em", color: "#64748b" }}>
                  {agent.campaignName}
                </span>
              )}
            </div>

            {/* Call duration */}
            <span
              style={{
                fontFamily: "monospace",
                fontSize: "1.1em",
                fontWeight: 700,
                color: medalColor,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              <LiveDuration
                initialSec={agent.callDurationSec ?? 0}
                active={agent.state === "IN_CALL"}
              />
            </span>

            {/* State chip */}
            <span
              style={{
                fontSize: "0.5em",
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                color: agent.state === "IN_CALL" ? "#4ade80" : "#fbbf24",
                background:
                  agent.state === "IN_CALL"
                    ? "rgba(74,222,128,0.12)"
                    : "rgba(251,191,36,0.12)",
                borderRadius: "0.3em",
                padding: "0.2em 0.5em",
              }}
            >
              {agent.state === "IN_CALL" ? "Live" : "Wrap-up"}
            </span>
          </div>
        );
      })}
    </div>
  );
}
