"use client";

// BoardQueue — "Inbound Queue" wallboard board.
//
// Phase 1: shows per-campaign queue data from the dashboardStore
// (queueDepth, agentsReady, agentsWaiting).
// Phase 2: wired to I01's per-in-group queue stats endpoint.
//
// S04 PLAN §2 (board: queue), §3.5.

import React from "react";
import type { CampaignMetrics } from "@/lib/stores/dashboard.js";

export interface BoardQueueProps {
  campaigns: CampaignMetrics[];
}

function QueueRow({ m }: { m: CampaignMetrics }): React.ReactElement {
  const waitingColor =
    m.queueDepth > 10
      ? "#ef4444"
      : m.queueDepth > 5
        ? "#f59e0b"
        : "#22c55e";

  return (
    <div
      style={{
        background: "rgba(255,255,255,0.04)",
        borderRadius: "0.5em",
        padding: "0.8em 1em",
        display: "grid",
        gridTemplateColumns: "2fr 1fr 1fr 1fr",
        gap: "0.5em",
        alignItems: "center",
        border: "1px solid rgba(255,255,255,0.06)",
      }}
    >
      {/* Campaign name */}
      <span
        style={{
          fontWeight: 700,
          fontSize: "0.9em",
          color: "#e2e8f0",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {m.campaignName}
      </span>

      {/* Callers waiting */}
      <Stat
        label="Waiting"
        value={String(m.queueDepth)}
        valueColor={waitingColor}
      />

      {/* Agents ready */}
      <Stat label="Agents Ready" value={String(m.agentsReady)} />

      {/* Agents waiting (blended / inbound holding) */}
      <Stat label="Agents Busy" value={String(m.agentsWaiting)} />
    </div>
  );
}

function Stat({
  label,
  value,
  valueColor = "#f1f5f9",
}: {
  label: string;
  value: string;
  valueColor?: string;
}): React.ReactElement {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.15em" }}>
      <span
        style={{
          fontSize: "0.5em",
          color: "#64748b",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontFamily: "monospace",
          fontSize: "1.2em",
          fontWeight: 700,
          color: valueColor,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </span>
    </div>
  );
}

export function BoardQueue({ campaigns }: BoardQueueProps): React.ReactElement {
  // Show campaigns with any queue depth first, then the rest.
  const sorted = [...campaigns].sort(
    (a, b) => b.queueDepth - a.queueDepth || b.agentsWaiting - a.agentsWaiting,
  );

  if (sorted.length === 0) {
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
        No campaigns
      </div>
    );
  }

  const totalWaiting = campaigns.reduce((s, c) => s + c.queueDepth, 0);

  return (
    <div
      style={{
        flex: 1,
        padding: "1em",
        display: "flex",
        flexDirection: "column",
        gap: "0.5em",
        overflow: "auto",
      }}
    >
      {/* Summary */}
      <div
        style={{
          fontSize: "0.7em",
          color: "#94a3b8",
          letterSpacing: "0.03em",
          textTransform: "uppercase",
          marginBottom: "0.3em",
        }}
      >
        Total callers waiting:{" "}
        <strong
          style={{
            color: totalWaiting > 10 ? "#ef4444" : "#f1f5f9",
            fontSize: "1.1em",
          }}
        >
          {totalWaiting}
        </strong>
        <span
          style={{
            fontSize: "0.8em",
            color: "#475569",
            marginLeft: "1em",
            fontStyle: "italic",
            textTransform: "none",
          }}
        >
          (Phase 1: campaign queue depth — per-in-group stats available in Phase 2)
        </span>
      </div>

      {/* Column headers */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "2fr 1fr 1fr 1fr",
          gap: "0.5em",
          padding: "0 1em",
          fontSize: "0.5em",
          color: "#475569",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
        }}
      >
        <span>Campaign</span>
        <span>Waiting</span>
        <span>Agents Ready</span>
        <span>Agents Busy</span>
      </div>

      {sorted.map((m) => (
        <QueueRow key={m.campaignId} m={m} />
      ))}
    </div>
  );
}
