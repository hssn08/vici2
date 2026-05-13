"use client";

// DropGauge — visual indicator for the 30-day rolling call-drop percentage.
//
// Color thresholds per E05 Safe Harbor / FCC 3% rule:
//   green  < 1.5%
//   amber  >= 1.5% and < 3%
//   red    >= 3%
//
// If dropGated=true, the dialer has been throttled and the gauge shows a lock icon.
//
// S01 PLAN §9.

import React from "react";

export interface DropGaugeProps {
  /** 30-day rolling drop rate as a percentage (0–100). */
  pct: number;
  /** True if the dialer has been throttled due to excessive drop rate. */
  gated: boolean;
}

function getGaugeColor(pct: number, gated: boolean): { bg: string; text: string; bar: string } {
  if (gated || pct >= 3) {
    return {
      bg: "bg-red-50 dark:bg-red-950/30",
      text: "text-red-700 dark:text-red-400",
      bar: "bg-red-500",
    };
  }
  if (pct >= 1.5) {
    return {
      bg: "bg-amber-50 dark:bg-amber-950/30",
      text: "text-amber-700 dark:text-amber-400",
      bar: "bg-amber-500",
    };
  }
  return {
    bg: "bg-green-50 dark:bg-green-950/30",
    text: "text-green-700 dark:text-green-400",
    bar: "bg-green-500",
  };
}

export function DropGauge({ pct, gated }: DropGaugeProps): React.ReactElement {
  const colors = getGaugeColor(pct, gated);
  // Cap the visual bar at 100% even if pct somehow exceeds it.
  const barPct = Math.min(pct / 3, 1) * 100; // scale: 3% = full bar

  return (
    <div
      className={`rounded-lg px-3 py-2 ${colors.bg}`}
      title={`Drop rate (30d): ${pct.toFixed(2)}%${gated ? " — GATED" : ""}`}
    >
      <div className={`flex items-center justify-between text-xs font-semibold ${colors.text}`}>
        <span>Drop%</span>
        <span className="font-mono">
          {pct.toFixed(2)}%{gated ? " GATED" : ""}
        </span>
      </div>
      {/* Progress bar (0–3% scale) */}
      <div className="mt-1 h-1.5 w-full rounded-full bg-gray-200 dark:bg-gray-700">
        <div
          className={`h-1.5 rounded-full transition-all duration-500 ${colors.bar}`}
          style={{ width: `${barPct}%` }}
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={3}
        />
      </div>
    </div>
  );
}
