"use client";

// BoardAgents — "Agents on Calls" wallboard board.
//
// Large-format agent grid sized for TV/1080p display. Emphasizes:
//   - State with high-contrast color coding
//   - Call duration in large, easy-to-read monospace
//   - Agent name and campaign
//
// Font sizing is all em-relative so the parent's font-size drives the scale.
//
// S04 PLAN §2 (board: agents).

import React, { useState, useEffect } from "react";
import type { AgentSnapshot, AgentState } from "@/lib/stores/dashboard.js";

export interface BoardAgentsProps {
  agents: AgentSnapshot[];
}

// High-contrast state config for TV display (dark background assumed).
const STATE_CFG: Record<AgentState, { label: string; bg: string; accent: string }> = {
  IN_CALL: { label: "In Call", bg: "#14532d", accent: "#4ade80" },
  READY: { label: "Ready", bg: "#1e3a8a", accent: "#60a5fa" },
  WRAPUP: { label: "Wrap-up", bg: "#78350f", accent: "#fbbf24" },
  PAUSED: { label: "Paused", bg: "#374151", accent: "#9ca3af" },
  LOGOUT: { label: "Logged Out", bg: "#1f2937", accent: "#4b5563" },
};

function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

function AgentCard({ agent }: { agent: AgentSnapshot }): React.ReactElement {
  const cfg = STATE_CFG[agent.state];

  // Live timer for IN_CALL agents.
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

  return (
    <div
      role="article"
      aria-label={`${agent.displayName} — ${cfg.label}`}
      style={{
        background: cfg.bg,
        borderRadius: "0.5em",
        padding: "0.6em 0.8em",
        display: "flex",
        flexDirection: "column",
        gap: "0.3em",
        border: `2px solid ${cfg.accent}33`,
        position: "relative",
        minWidth: "10em",
      }}
    >
      {/* State badge */}
      <span
        style={{
          fontSize: "0.55em",
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.07em",
          color: cfg.accent,
          lineHeight: 1,
        }}
      >
        {cfg.label}
      </span>

      {/* Agent name */}
      <span
        style={{
          fontSize: "0.9em",
          fontWeight: 700,
          color: "#f1f5f9",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {agent.displayName}
      </span>

      {/* Campaign */}
      {agent.campaignName && (
        <span
          style={{
            fontSize: "0.55em",
            color: "#94a3b8",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {agent.campaignName}
        </span>
      )}

      {/* Call duration */}
      {agent.state === "IN_CALL" && (
        <span
          style={{
            fontFamily: "monospace",
            fontSize: "1.1em",
            fontWeight: 700,
            color: cfg.accent,
            fontVariantNumeric: "tabular-nums",
            marginTop: "0.2em",
          }}
        >
          {formatDuration(elapsed)}
        </span>
      )}

      {/* Monitor count badge */}
      {agent.monitorCount > 0 && (
        <span
          title={`${agent.monitorCount} supervisor(s) monitoring`}
          style={{
            position: "absolute",
            top: "0.4em",
            right: "0.4em",
            background: "#2563eb",
            color: "#fff",
            borderRadius: "50%",
            width: "1.3em",
            height: "1.3em",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "0.5em",
            fontWeight: 700,
          }}
        >
          {agent.monitorCount}
        </span>
      )}
    </div>
  );
}

export function BoardAgents({ agents }: BoardAgentsProps): React.ReactElement {
  const active = agents.filter((a) => a.state !== "LOGOUT");
  const loggedOut = agents.filter((a) => a.state === "LOGOUT");

  // Sort: IN_CALL first, then WRAPUP, READY, PAUSED, LOGOUT
  const stateOrder: Record<AgentState, number> = {
    IN_CALL: 0,
    WRAPUP: 1,
    READY: 2,
    PAUSED: 3,
    LOGOUT: 4,
  };
  const sorted = [...active].sort(
    (a, b) => (stateOrder[a.state] ?? 9) - (stateOrder[b.state] ?? 9),
  );

  if (agents.length === 0) {
    return (
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#475569",
          fontSize: "1em",
        }}
      >
        No agents logged in
      </div>
    );
  }

  return (
    <div
      style={{
        flex: 1,
        padding: "1em",
        display: "flex",
        flexDirection: "column",
        gap: "0.8em",
        overflow: "auto",
      }}
    >
      {/* Summary strip */}
      <div
        style={{
          display: "flex",
          gap: "2em",
          fontSize: "0.7em",
          color: "#94a3b8",
          letterSpacing: "0.04em",
          textTransform: "uppercase",
        }}
      >
        <span>
          <strong style={{ color: "#4ade80" }}>
            {agents.filter((a) => a.state === "IN_CALL").length}
          </strong>{" "}
          on call
        </span>
        <span>
          <strong style={{ color: "#60a5fa" }}>
            {agents.filter((a) => a.state === "READY").length}
          </strong>{" "}
          ready
        </span>
        <span>
          <strong style={{ color: "#fbbf24" }}>
            {agents.filter((a) => a.state === "WRAPUP").length}
          </strong>{" "}
          wrap-up
        </span>
        <span>
          <strong style={{ color: "#9ca3af" }}>
            {agents.filter((a) => a.state === "PAUSED").length}
          </strong>{" "}
          paused
        </span>
        {loggedOut.length > 0 && (
          <span>
            <strong style={{ color: "#4b5563" }}>{loggedOut.length}</strong>{" "}
            logged out
          </span>
        )}
      </div>

      {/* Agent grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(11em, 1fr))",
          gap: "0.6em",
          alignContent: "start",
        }}
      >
        {sorted.map((agent) => (
          <AgentCard key={agent.uid} agent={agent} />
        ))}
        {loggedOut.map((agent) => (
          <AgentCard key={agent.uid} agent={agent} />
        ))}
      </div>
    </div>
  );
}
