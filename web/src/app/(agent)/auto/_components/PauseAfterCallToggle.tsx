"use client";

/**
 * PauseAfterCallToggle — injected into A05's ActionBar.
 * Visible only when dialMode !== 'manual'.
 * Registers the 'P' hotkey in 'in-call' scope.
 *
 * State: off = "After: Ready" (grey); on = "After: Pause" (amber).
 */

import * as React from "react";
import { cn } from "@/lib/utils";
import { useCallStore } from "@/lib/stores/call";
import { useHotkeys } from "@/lib/hotkeys/useHotkeys";

export function PauseAfterCallToggle(): React.ReactElement | null {
  const dialMode = useCallStore((s) => s.dialMode);
  const pending = useCallStore((s) => s.pendingPauseAfterCall);
  const setPendingPause = useCallStore((s) => s.setPendingPause);

  const toggle = React.useCallback(() => {
    setPendingPause(!pending);
  }, [pending, setPendingPause]);

  useHotkeys(
    React.useMemo(
      () => [
        {
          scope: "in-call" as const,
          key: "p",
          ignoreInputFocus: false,
          priority: 0,
          handler: () => toggle(),
          description: 'Toggle "pause after this call"',
        },
      ],
      [toggle],
    ),
  );

  // Don't render in manual-dial mode
  if (dialMode === "manual" || dialMode === null) return null;

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={pending}
      aria-label={
        pending
          ? "Cancel: do not pause after this call (P)"
          : "Pause after this call (P)"
      }
      title={
        pending
          ? "Pause after this call — click to cancel (P to toggle)"
          : "Return to auto-dial after this call (P to toggle)"
      }
      className={cn(
        "flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm transition-colors",
        pending
          ? "border-[var(--color-state-warning)] bg-[var(--color-state-warning)]/10 text-[var(--color-state-warning)]"
          : "border-[var(--color-border)] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)]",
      )}
    >
      <span aria-hidden="true">{pending ? "⏸" : "▶"}</span>
      <span>{pending ? "After: Pause" : "After: Ready"}</span>
    </button>
  );
}
