"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { useCallStore, type RecordingState } from "@/lib/stores/call";

interface RecordingBadgeProps {
  className?: string;
}

interface PopoverProps {
  recording: RecordingState;
  onClose: () => void;
}

function RecordingPopover({ recording, onClose }: PopoverProps): React.ReactElement {
  const label = {
    on: "Recording active",
    off: "Not recording",
    paused: "Recording paused (PCI mask)",
    pending: "Awaiting consent...",
  }[recording];

  return (
    <div
      role="tooltip"
      aria-label="Recording details"
      className="absolute right-0 top-8 z-50 w-64 rounded-md border border-[var(--color-surface-border)] bg-[var(--color-surface-elevated)] p-4 shadow-lg"
    >
      <div className="flex items-center justify-between">
        <span className="font-medium text-sm">{label}</span>
        <button
          onClick={onClose}
          aria-label="Close"
          className="text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
        >
          ×
        </button>
      </div>
      <p className="mt-2 text-xs text-[var(--color-fg-muted)]">
        File: Stored securely
      </p>
    </div>
  );
}

export function RecordingBadge({ className }: RecordingBadgeProps): React.ReactElement {
  const recording = useCallStore((s) => s.recording);
  const [open, setOpen] = React.useState(false);

  const { dot, label, dotClass, textClass } = React.useMemo(() => {
    switch (recording) {
      case "on":
        return {
          dot: "●",
          label: "REC",
          dotClass: "text-[var(--color-state-error)]",
          textClass: "text-[var(--color-state-error)]",
        };
      case "paused":
        return {
          dot: "⏸",
          label: "REC PAUSED",
          dotClass: "text-[var(--color-state-hold)]",
          textClass: "text-[var(--color-state-hold)]",
        };
      case "pending":
        return {
          dot: "●",
          label: "CONSENT",
          dotClass: "text-orange-500 animate-pulse",
          textClass: "text-orange-500",
        };
      default:
        return {
          dot: "○",
          label: "REC OFF",
          dotClass: "text-[var(--color-fg-muted)]",
          textClass: "text-[var(--color-fg-muted)]",
        };
    }
  }, [recording]);

  return (
    <div className={cn("relative flex items-center", className)}>
      <button
        aria-label={`Recording status: ${label}. Click for details.`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded px-2 py-1 text-xs hover:bg-[var(--color-surface-muted)]"
      >
        <span aria-hidden className={cn("text-sm", dotClass)}>{dot}</span>
        <span className={textClass}>{label}</span>
      </button>
      {open && <RecordingPopover recording={recording} onClose={() => setOpen(false)} />}
    </div>
  );
}
