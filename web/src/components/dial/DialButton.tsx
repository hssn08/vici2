"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import type { ClientGates } from "@/lib/stores/dial";

// ── Priority ordering (highest severity first) ────────────────────────────────

type DisabledCode =
  | "DNC_HIT"
  | "OUTSIDE_TCPA_WINDOW"
  | "INVALID_PHONE"
  | "AGENT_NOT_READY"
  | "CAMPAIGN_PAUSED"
  | "CALL_IN_FLIGHT";

const PRIORITY: DisabledCode[] = [
  "DNC_HIT",
  "OUTSIDE_TCPA_WINDOW",
  "INVALID_PHONE",
  "AGENT_NOT_READY",
  "CAMPAIGN_PAUSED",
  "CALL_IN_FLIGHT",
];

interface DisabledState {
  code: DisabledCode;
  tooltip: string;
  inlineMessage: string;
}

function computeDisabledState(gates: ClientGates): DisabledState | null {
  const candidates: DisabledState[] = [];

  if (gates.dncHint === "hit") {
    candidates.push({
      code: "DNC_HIT",
      tooltip: "On DNC list (federal). Cannot dial.",
      inlineMessage: "Federal DNC — cannot dial",
    });
  }
  if (gates.tcpaHint === "skip_until" || gates.tcpaHint === "block") {
    candidates.push({
      code: "OUTSIDE_TCPA_WINDOW",
      tooltip: "Outside calling window.",
      inlineMessage: "Outside calling window",
    });
  }
  if (!gates.phoneValid) {
    candidates.push({
      code: "INVALID_PHONE",
      tooltip: "Phone must be E.164 (example: +14155551234)",
      inlineMessage: "Invalid phone number format",
    });
  }
  if (!gates.agentReady) {
    candidates.push({
      code: "AGENT_NOT_READY",
      tooltip: "You are paused — un-pause to dial",
      inlineMessage: "Un-pause to enable dialing",
    });
  }
  if (!gates.campaignActive) {
    candidates.push({
      code: "CAMPAIGN_PAUSED",
      tooltip: "Campaign paused — calls disabled",
      inlineMessage: "Campaign is paused — switch campaigns or wait",
    });
  }
  if (!gates.noInFlight) {
    candidates.push({
      code: "CALL_IN_FLIGHT",
      tooltip: "A call is in flight. Cancel or complete it first.",
      inlineMessage: "",
    });
  }

  // Pick highest priority
  for (const code of PRIORITY) {
    const match = candidates.find((c) => c.code === code);
    if (match) return match;
  }
  return null;
}

// ── Props ─────────────────────────────────────────────────────────────────────

export interface DialButtonProps {
  gates: ClientGates;
  onCall: () => void;
  onAnnounce?: (message: string) => void;
  loading?: boolean;
  className?: string;
}

export function DialButton({
  gates,
  onCall,
  onAnnounce,
  loading,
  className,
}: DialButtonProps): React.ReactElement {
  const disabled = computeDisabledState(gates);
  const canDial = disabled === null && !loading;

  function handleClick(): void {
    if (loading) return;
    if (disabled) {
      onAnnounce?.(disabled.inlineMessage || disabled.tooltip);
      return;
    }
    onCall();
  }

  return (
    <div className={cn("space-y-1.5", className)}>
      {/* WCAG 4.1.2: aria-disabled instead of HTML disabled so button stays in tab order */}
      <button
        role="button"
        aria-disabled={!canDial ? "true" : undefined}
        aria-describedby={!canDial ? "dial-btn-reason" : undefined}
        aria-busy={loading ? "true" : undefined}
        title={disabled?.tooltip}
        onClick={handleClick}
        className={cn(
          "inline-flex h-11 w-full items-center justify-center gap-2 rounded-md px-6 text-sm font-semibold transition-colors",
          canDial
            ? "bg-[var(--color-brand-600)] text-white hover:bg-[var(--color-brand-700)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand-600)]"
            : "bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)] opacity-60 cursor-not-allowed",
        )}
      >
        {loading ? (
          <>
            <span
              className="h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent"
              aria-hidden
            />
            Calling…
          </>
        ) : (
          "Call"
        )}
      </button>

      {/* Inline error — visible and screen-reader accessible */}
      {disabled && disabled.inlineMessage && (
        <p
          id="dial-btn-reason"
          aria-live="polite"
          className="text-xs text-amber-700"
        >
          {disabled.inlineMessage}
        </p>
      )}
    </div>
  );
}
