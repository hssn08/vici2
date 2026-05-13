"use client";

/**
 * WaitingScreen — IDLE and PAUSED states for the auto-dial page.
 * Shows campaign name, agent status pill, pulsing indicator (IDLE),
 * or a "Return to Auto-Dial" button (PAUSED).
 */

import * as React from "react";
import { cn } from "@/lib/utils";
import { MissedReservationBanner } from "./MissedReservationBanner";

interface WaitingScreenProps {
  status: "idle" | "paused" | "missed";
  campaignName: string | null;
  agentStatus: string;
  missedCount: number;
  onReturnToAutoDial: () => void;
  onDismissMissed: () => void;
}

export function WaitingScreen({
  status,
  campaignName,
  agentStatus,
  missedCount,
  onReturnToAutoDial,
  onDismissMissed,
}: WaitingScreenProps): React.ReactElement {
  const isIdle = status === "idle";
  const isPaused = status === "paused";
  const isMissed = status === "missed";

  return (
    <div className="flex flex-col items-center justify-center gap-6 py-16">
      {/* Status indicator */}
      <div className="flex flex-col items-center gap-3">
        {isIdle && (
          <span className="relative flex h-4 w-4">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--color-state-success)] opacity-75" />
            <span className="relative inline-flex h-4 w-4 rounded-full bg-[var(--color-state-success)]" />
          </span>
        )}
        {isPaused && (
          <span className="inline-flex h-4 w-4 rounded-full bg-[var(--color-state-warning)]" />
        )}
        {isMissed && (
          <span className="inline-flex h-4 w-4 rounded-full bg-[var(--color-state-error)]" />
        )}

        <h1 className="text-xl font-semibold">
          {isIdle && "Waiting for call…"}
          {isPaused && "Paused"}
          {isMissed && "Missed — Paused"}
        </h1>

        {campaignName && (
          <p className="text-sm text-[var(--color-fg-muted)]">
            Campaign:{" "}
            <span className="font-medium text-[var(--color-fg)]">{campaignName}</span>
          </p>
        )}

        <span
          className={cn(
            "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
            isIdle
              ? "bg-[var(--color-state-success)]/15 text-[var(--color-state-success)]"
              : "bg-[var(--color-state-warning)]/15 text-[var(--color-state-warning)]",
          )}
        >
          {agentStatus}
        </span>
      </div>

      {/* Missed reservation banner */}
      {isMissed && (
        <MissedReservationBanner count={missedCount} onDismiss={onDismissMissed} />
      )}

      {/* Return to auto-dial button (PAUSED or MISSED→PAUSED) */}
      {(isPaused || isMissed) && (
        <button
          type="button"
          onClick={onReturnToAutoDial}
          className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
        >
          Return to Auto-Dial
        </button>
      )}
    </div>
  );
}
