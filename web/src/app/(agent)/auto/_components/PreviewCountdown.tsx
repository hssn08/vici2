"use client";

/**
 * PreviewCountdown — animated countdown bar for the reservation preview window.
 *
 * Uses server-timestamp (expiresAt ISO-8601) not Date.now()+N to avoid clock drift.
 * Updates via requestAnimationFrame for smooth bar animation; text label updates
 * every second only (screen reader flood prevention).
 */

import * as React from "react";
import { cn } from "@/lib/utils";

interface PreviewCountdownProps {
  /** ISO-8601 UTC timestamp when preview window expires */
  expiresAt: string;
  /** ISO-8601 UTC timestamp when preview window started (for total duration) */
  startedAt: string;
}

export function PreviewCountdown({
  expiresAt,
  startedAt,
}: PreviewCountdownProps): React.ReactElement {
  const totalMs = React.useMemo(
    () => new Date(expiresAt).getTime() - new Date(startedAt).getTime(),
    [expiresAt, startedAt],
  );

  const [msRemaining, setMsRemaining] = React.useState(() =>
    Math.max(0, new Date(expiresAt).getTime() - Date.now()),
  );
  const [secondsLabel, setSecondsLabel] = React.useState(() =>
    Math.ceil(Math.max(0, new Date(expiresAt).getTime() - Date.now()) / 1000),
  );

  // rAF loop for smooth bar animation
  const rafRef = React.useRef<number | null>(null);
  const lastSecondRef = React.useRef<number>(-1);

  React.useEffect(() => {
    const expiresMs = new Date(expiresAt).getTime();

    function tick() {
      const remaining = Math.max(0, expiresMs - Date.now());
      setMsRemaining(remaining);

      const secs = Math.ceil(remaining / 1000);
      if (secs !== lastSecondRef.current) {
        lastSecondRef.current = secs;
        setSecondsLabel(secs);
      }

      if (remaining > 0) {
        rafRef.current = requestAnimationFrame(tick);
      }
    }

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [expiresAt]);

  const pctRemaining = totalMs > 0 ? msRemaining / totalMs : 0;

  const colorClass =
    pctRemaining > 0.5
      ? "accent-green-500"
      : pctRemaining > 0.25
        ? "accent-amber-500"
        : "accent-red-500 animate-pulse";

  return (
    <div className="flex flex-col gap-1">
      <progress
        value={msRemaining}
        max={totalMs}
        aria-valuenow={secondsLabel}
        aria-valuemin={0}
        aria-valuemax={Math.ceil(totalMs / 1000)}
        aria-label={`${secondsLabel} seconds remaining to preview this call`}
        className={cn("h-2 w-full rounded-full", colorClass)}
      />
      {/* Polite live region — updates every second, not every frame */}
      <span
        aria-live="polite"
        aria-atomic="true"
        className="text-right text-xs tabular-nums text-[var(--color-fg-muted)]"
      >
        {secondsLabel}s
      </span>
    </div>
  );
}
