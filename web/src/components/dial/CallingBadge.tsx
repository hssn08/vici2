"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import type { LeadPreview } from "@/lib/stores/dial";

export interface CallingBadgeProps {
  lead: LeadPreview;
  callUuid: string | null;
  onCancel: () => void;
  cancelLoading?: boolean;
}

export function CallingBadge({
  lead,
  callUuid,
  onCancel,
  cancelLoading,
}: CallingBadgeProps): React.ReactElement {
  const [elapsedMs, setElapsedMs] = React.useState(0);
  const startedAt = React.useRef(Date.now());

  React.useEffect(() => {
    const id = setInterval(() => {
      setElapsedMs(Date.now() - startedAt.current);
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const elapsedSec = Math.floor(elapsedMs / 1000);
  const isSlowRing = elapsedSec >= 30;

  const displayName =
    [lead.firstName, lead.lastName].filter(Boolean).join(" ") ||
    lead.vendorLeadCode ||
    lead.phoneE164;

  function formatElapsed(sec: number): string {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m > 0
      ? `${m}m ${String(s).padStart(2, "0")}s`
      : `${s}s`;
  }

  return (
    <div
      role="status"
      aria-label={callUuid ? `Ringing ${displayName}` : `Calling ${displayName}`}
      className="rounded-[var(--radius-card)] border bg-[var(--color-surface-elevated)] p-5 space-y-4"
    >
      <div className="flex items-center gap-3">
        {/* Animated ring indicator */}
        <span className="relative flex h-4 w-4 shrink-0">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[var(--color-brand-600)] opacity-50" />
          <span className="relative inline-flex h-4 w-4 rounded-full bg-[var(--color-brand-600)]" />
        </span>
        <div>
          <p className="font-semibold">
            {callUuid ? "Ringing…" : "Calling…"}
          </p>
          <p className="text-sm text-[var(--color-fg-muted)]">{displayName}</p>
        </div>
        <p className="ml-auto text-sm font-mono text-[var(--color-fg-muted)]">
          {formatElapsed(elapsedSec)}
        </p>
      </div>

      {/* Slow-ring warning after 30 s */}
      {isSlowRing && (
        <p
          role="status"
          aria-live="polite"
          className="text-xs text-amber-700"
        >
          Still ringing — you can cancel if needed.
        </p>
      )}

      {/* Cancel button */}
      <Button
        variant="destructive"
        className="w-full"
        onClick={onCancel}
        loading={cancelLoading}
        aria-label="Cancel this call attempt"
      >
        Cancel
      </Button>
    </div>
  );
}
