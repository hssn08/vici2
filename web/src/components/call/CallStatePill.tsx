"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import type { CallPhase } from "@/lib/stores/call";

const PHASE_LABEL: Record<CallPhase, string> = {
  idle: "Idle",
  ringing: "Ringing",
  active: "Active",
  hold: "On Hold",
  wrapup: "Wrap-up",
  transferring: "Transferring",
};

const PHASE_BG: Record<CallPhase, string> = {
  idle: "bg-[var(--color-state-idle)]",
  ringing: "bg-[var(--color-state-ringing)] animate-ringing-pulse",
  active: "bg-[var(--color-state-active)]",
  hold: "bg-[var(--color-state-hold)]",
  wrapup: "bg-[var(--color-state-wrap)]",
  transferring: "bg-[var(--color-state-transfer)]",
};

export function CallStatePill({
  phase,
  className,
}: {
  phase: CallPhase;
  className?: string;
}): React.ReactElement {
  return (
    <span
      role="status"
      aria-label={`Call ${PHASE_LABEL[phase]}`}
      className={cn(
        "inline-flex items-center gap-2 rounded-[var(--radius-pill)] px-2.5 py-1 text-xs font-medium text-white",
        PHASE_BG[phase],
        className,
      )}
    >
      <span
        aria-hidden
        className="inline-block h-1.5 w-1.5 rounded-full bg-white/90"
      />
      {PHASE_LABEL[phase]}
    </span>
  );
}
