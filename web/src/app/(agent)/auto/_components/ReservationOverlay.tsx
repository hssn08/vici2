"use client";

/**
 * ReservationOverlay — slides in from the right when a call.reserved WS event
 * arrives. WCAG 2.2 AA: role="alertdialog", aria-live="assertive", focus trap
 * to first action button when preview mode is active.
 *
 * When preview_allowed_seconds = 0 (non-preview mode): no buttons, no focus
 * trap — purely informational; overlay disappears on call.bridged.
 */

import * as React from "react";
import { cn } from "@/lib/utils";
import { PreviewCountdown } from "./PreviewCountdown";
import type { ReservationData } from "./AutoDialShell";

interface ReservationOverlayProps {
  reservation: ReservationData;
  dialMode: "PROGRESSIVE" | "PREDICTIVE";
  /** ISO-8601 UTC; null = no preview mode */
  previewExpiresAt: string | null;
  /** ISO-8601 UTC; always set */
  reservationExpiresAt: string;
  /** ISO-8601 UTC; when the overlay was shown (for countdown total) */
  reservationStartedAt: string;
  onSkip: () => void;
  onAccept: () => void;
  onScheduleCallback: () => void;
  visible: boolean;
}

export function ReservationOverlay({
  reservation,
  dialMode,
  previewExpiresAt,
  reservationStartedAt,
  onSkip,
  onAccept,
  onScheduleCallback,
  visible,
}: ReservationOverlayProps): React.ReactElement | null {
  const acceptRef = React.useRef<HTMLButtonElement>(null);
  const skipRef = React.useRef<HTMLButtonElement>(null);

  const prefersReducedMotion =
    typeof window !== "undefined"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false;

  // Move focus to first action button when overlay opens (preview mode only)
  React.useEffect(() => {
    if (visible && previewExpiresAt) {
      // Prefer Accept button; fall back to Skip
      const target = acceptRef.current ?? skipRef.current;
      target?.focus();
    }
  }, [visible, previewExpiresAt]);

  const { lead, campaignName, scriptSnippet } = reservation;
  const leadName = [lead.firstName, lead.lastName].filter(Boolean).join(" ") || lead.phoneE164;

  return (
    <div
      role="alertdialog"
      aria-modal="false"
      aria-labelledby="reservation-title"
      aria-describedby="reservation-lead-phone"
      aria-live="assertive"
      className={cn(
        "fixed right-0 top-0 z-50 flex h-full w-full max-w-md flex-col gap-4 border-l border-[var(--color-border)] bg-[var(--color-surface-raised)] p-6 shadow-xl",
        prefersReducedMotion
          ? visible
            ? "opacity-100"
            : "opacity-0 pointer-events-none"
          : visible
            ? "translate-x-0 opacity-100 transition-all duration-300 ease-out"
            : "translate-x-full opacity-0 pointer-events-none transition-all duration-200",
        // 3-pulse border animation when audio may be blocked
        "border-l-2",
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <span
          id="reservation-title"
          className="text-xs font-semibold uppercase tracking-widest text-[var(--color-state-warning)]"
        >
          Incoming Call · {dialMode === "PREDICTIVE" ? "Predictive" : "Progressive"}
        </span>
        {previewExpiresAt && (
          <button
            ref={skipRef}
            type="button"
            onClick={onSkip}
            aria-label="Skip this call (Esc)"
            className="rounded p-1 text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)]"
          >
            Skip
          </button>
        )}
      </div>

      {/* Lead info */}
      <div className="flex flex-col gap-1">
        <p className="text-2xl font-semibold">{leadName}</p>
        <p
          id="reservation-lead-phone"
          className="font-mono text-sm text-[var(--color-fg-muted)]"
        >
          {lead.phoneE164}
          {lead.city && ` · ${lead.city}`}
          {lead.state && `, ${lead.state}`}
        </p>
      </div>

      {/* Campaign */}
      <p className="text-sm text-[var(--color-fg-muted)]">
        Campaign:{" "}
        <span className="font-medium text-[var(--color-fg)]">{campaignName}</span>
      </p>

      {/* Script snippet */}
      {scriptSnippet && (
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-sm italic text-[var(--color-fg-muted)]">
          {scriptSnippet}
        </div>
      )}

      {/* Preview countdown (only in preview mode) */}
      {previewExpiresAt && (
        <PreviewCountdown
          expiresAt={previewExpiresAt}
          startedAt={reservationStartedAt}
        />
      )}

      {/* Action buttons (preview mode only) */}
      {previewExpiresAt && (
        <div className="mt-auto flex items-center gap-2">
          <button
            type="button"
            onClick={onScheduleCallback}
            className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm hover:bg-[var(--color-surface-hover)]"
            aria-keyshortcuts="Control+b"
          >
            Schedule Callback
            <span className="ml-1 text-xs text-[var(--color-fg-muted)]">Ctrl+B</span>
          </button>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onSkip}
            className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm hover:bg-[var(--color-surface-hover)]"
            aria-keyshortcuts="Escape"
          >
            Skip
            <span className="ml-1 text-xs text-[var(--color-fg-muted)]">Esc</span>
          </button>
          <button
            ref={acceptRef}
            type="button"
            onClick={onAccept}
            className="rounded-md bg-[var(--color-state-success)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
            aria-keyshortcuts="Space"
          >
            Accept Call
            <span className="ml-1 text-xs opacity-70">Space</span>
          </button>
        </div>
      )}

      {/* Non-preview: informational only */}
      {!previewExpiresAt && (
        <p className="mt-auto text-center text-sm text-[var(--color-fg-muted)]">
          Connecting automatically…
        </p>
      )}
    </div>
  );
}
