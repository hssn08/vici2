"use client";

// BoardCampaigns — "Campaign Performance" wallboard board.
//
// Shows top-N campaigns with: drop rate (color-coded gauge), dial level,
// in-flight calls, agents ready, queue depth.
//
// Drop rate thresholds per E05: green < 1.5%, amber >= 1.5% < 3%, red >= 3%.
//
// S04 PLAN §2 (board: campaigns).

import React from "react";
import type { CampaignMetrics } from "@/lib/stores/dashboard.js";

export interface BoardCampaignsProps {
  campaigns: CampaignMetrics[];
  /** Maximum campaigns to display; defaults to 8. */
  topN?: number;
}

function dropColor(pct: number, gated: boolean): { bar: string; text: string; bg: string } {
  if (gated || pct >= 3)
    return { bar: "#ef4444", text: "#fca5a5", bg: "rgba(239,68,68,0.1)" };
  if (pct >= 1.5)
    return { bar: "#f59e0b", text: "#fcd34d", bg: "rgba(245,158,11,0.1)" };
  return { bar: "#22c55e", text: "#86efac", bg: "rgba(34,197,94,0.1)" };
}

function DropBar({ pct, gated }: { pct: number; gated: boolean }): React.ReactElement {
  const c = dropColor(pct, gated);
  const barPct = Math.min((pct / 3) * 100, 100);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.2em" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: "0.65em",
          color: c.text,
          fontWeight: 600,
        }}
      >
        <span>Drop%</span>
        <span style={{ fontFamily: "monospace" }}>
          {pct.toFixed(2)}%{gated ? " GATED" : ""}
        </span>
      </div>
      <div
        style={{
          height: "0.3em",
          background: "rgba(255,255,255,0.1)",
          borderRadius: "9999px",
          overflow: "hidden",
        }}
      >
        <div
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={3}
          style={{
            height: "100%",
            width: `${barPct}%`,
            background: c.bar,
            borderRadius: "9999px",
            transition: "width 0.5s ease",
          }}
        />
      </div>
    </div>
  );
}

function CampaignRow({ m }: { m: CampaignMetrics }): React.ReactElement {
  return (
    <div
      style={{
        background: "rgba(255,255,255,0.04)",
        borderRadius: "0.5em",
        padding: "0.7em 1em",
        display: "grid",
        gridTemplateColumns: "1fr 1fr 1fr 1fr 1.5fr",
        gap: "0.5em",
        alignItems: "center",
        border: m.dropGated ? "1px solid rgba(239,68,68,0.4)" : "1px solid rgba(255,255,255,0.06)",
      }}
    >
      {/* Name */}
      <span
        style={{
          fontWeight: 700,
          fontSize: "0.85em",
          color: "#e2e8f0",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {m.campaignName}
      </span>

      {/* Dial level */}
      <Kpi label="Dial" value={m.dialLevel.toFixed(1)} />
      {/* In-flight */}
      <Kpi label="In-flight" value={String(m.inFlight)} />
      {/* Agents ready */}
      <Kpi label="Ready" value={String(m.agentsReady)} />

      {/* Drop gauge */}
      <DropBar pct={m.dropPct30d} gated={m.dropGated} />
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.1em" }}>
      <span style={{ fontSize: "0.5em", color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em" }}>
        {label}
      </span>
      <span style={{ fontFamily: "monospace", fontSize: "1em", fontWeight: 700, color: "#f1f5f9", fontVariantNumeric: "tabular-nums" }}>
        {value}
      </span>
    </div>
  );
}

export function BoardCampaigns({ campaigns, topN = 8 }: BoardCampaignsProps): React.ReactElement {
  // Sort by drop rate descending (highest risk first) then by in-flight descending.
  const sorted = [...campaigns]
    .sort((a, b) => b.dropPct30d - a.dropPct30d || b.inFlight - a.inFlight)
    .slice(0, topN);

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
        No active campaigns
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
        gap: "0.5em",
        overflow: "auto",
      }}
    >
      {/* Column headers */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr 1fr 1.5fr",
          gap: "0.5em",
          padding: "0 1em",
          fontSize: "0.5em",
          color: "#475569",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
        }}
      >
        <span>Campaign</span>
        <span>Dial level</span>
        <span>In-flight</span>
        <span>Ready</span>
        <span>Drop rate (30d)</span>
      </div>

      {/* Campaign rows */}
      {sorted.map((m) => (
        <CampaignRow key={m.campaignId} m={m} />
      ))}
    </div>
  );
}
