"use client";

/**
 * MissedReservationBanner — dismissable toast shown in MISSED state.
 * Auto-dismisses after 5 seconds.
 */

import * as React from "react";

interface MissedReservationBannerProps {
  count: number;
  onDismiss: () => void;
}

export function MissedReservationBanner({
  count,
  onDismiss,
}: MissedReservationBannerProps): React.ReactElement {
  React.useEffect(() => {
    const t = setTimeout(onDismiss, 5000);
    return () => clearTimeout(t);
  }, [onDismiss]);

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="flex items-center gap-3 rounded-md border border-[var(--color-state-warning)] bg-[var(--color-state-warning)]/10 px-4 py-3 text-sm"
    >
      <span className="font-semibold text-[var(--color-state-warning)]">
        Missed reservation
      </span>
      <span className="text-[var(--color-fg-muted)]">
        ({count} total this session) — you are now paused.
      </span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="ml-auto rounded p-1 hover:bg-[var(--color-surface-hover)]"
      >
        ✕
      </button>
    </div>
  );
}
