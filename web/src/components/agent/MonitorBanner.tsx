"use client";

// MonitorBanner — displayed on the agent's screen when one or more supervisors
// are monitoring their call.
//
// Design decisions (S02 PLAN §9.2):
//   - Counts + modes only; no individual supervisor identity disclosed.
//   - Agent CANNOT dismiss or hide this banner (Watkins compliance).
//   - Cleared when the last supervisor leaves.
//
// This component is driven by the A03 WebSocket gateway pushing
// monitor_active events. In Phase 1, the prop is passed directly from the
// parent that listens to the WS event.

import React from "react";
import type { MonitorBannerPayload } from "@vici2/types";

interface MonitorBannerProps {
  payload: MonitorBannerPayload | null;
}

export function MonitorBanner({ payload }: MonitorBannerProps): React.ReactElement | null {
  if (!payload || payload.total === 0) {
    return null;
  }

  const label = buildLabel(payload);

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-800"
    >
      {/* Pulsing indicator */}
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
      </span>
      {label}
    </div>
  );
}

function buildLabel(payload: MonitorBannerPayload): string {
  const { counts, total } = payload;
  const parts: string[] = [];

  if (counts.listen) {
    parts.push(`${counts.listen} listening`);
  }
  if (counts.whisper) {
    parts.push(`${counts.whisper} coaching`);
  }
  if (counts.barge) {
    parts.push(`${counts.barge} in conversation`);
  }

  if (parts.length === 0) {
    return `${total} supervisor${total !== 1 ? "s" : ""} monitoring`;
  }

  if (parts.length === 1 && total === 1) {
    // Simple singular form: "1 supervisor listening"
    return `1 supervisor ${parts[0].replace(/^\d+ /, "")}`;
  }

  if (parts.length === 1) {
    return `${total} supervisors ${parts[0].replace(/^\d+ /, "")}`;
  }

  // Multiple modes: "2 supervisors: 1 listening, 1 coaching"
  return `${total} supervisors: ${parts.join(", ")}`;
}
