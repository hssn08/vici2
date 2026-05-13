"use client";

// A08 — SnoozeMenu: preset snooze options dropdown with optional custom datetime.

import * as React from "react";
import { cn } from "@/lib/utils";
import { toDateTimeLocalValue, localDateTimeToIso } from "@/lib/types/callbacks";

interface SnoozeMenuProps {
  callbackId: string;
  comments: string | null;
  onSnooze: (callbackAt: string, comments?: string) => Promise<void>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function tomorrowAt9am(): Date {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d;
}

const PRESETS = [
  {
    label: "30 minutes",
    getAt: () => new Date(Date.now() + 30 * 60_000),
  },
  {
    label: "1 hour",
    getAt: () => new Date(Date.now() + 60 * 60_000),
  },
  {
    label: "3 hours",
    getAt: () => new Date(Date.now() + 3 * 3_600_000),
  },
  {
    label: "Tomorrow 9am",
    getAt: tomorrowAt9am,
  },
] as const;

export function SnoozeMenu({
  comments,
  onSnooze,
  open,
  onOpenChange,
}: SnoozeMenuProps): React.ReactElement | null {
  const [customOpen, setCustomOpen] = React.useState(false);
  const [customValue, setCustomValue] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement>(null);

  // Close on outside click
  React.useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onOpenChange(false);
        setCustomOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open, onOpenChange]);

  if (!open) return null;

  const handlePreset = async (getAt: () => Date) => {
    setBusy(true);
    try {
      await onSnooze(getAt().toISOString(), comments ?? undefined);
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  const handleCustomSubmit = async () => {
    if (!customValue) return;
    setBusy(true);
    try {
      await onSnooze(localDateTimeToIso(customValue), comments ?? undefined);
      onOpenChange(false);
      setCustomOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="Snooze options"
      className="absolute right-0 z-20 mt-1 w-52 rounded-md border border-[var(--color-surface-border)] bg-[var(--color-surface-elevated)] py-1 shadow-lg"
    >
      {PRESETS.map((preset) => (
        <button
          key={preset.label}
          role="menuitem"
          type="button"
          disabled={busy}
          onClick={() => void handlePreset(preset.getAt)}
          className={cn(
            "w-full px-4 py-2 text-left text-sm hover:bg-[var(--color-surface-muted)] disabled:opacity-50",
          )}
        >
          {preset.label}
        </button>
      ))}
      <button
        role="menuitem"
        type="button"
        onClick={() => setCustomOpen((v) => !v)}
        className="w-full px-4 py-2 text-left text-sm hover:bg-[var(--color-surface-muted)]"
      >
        Custom…
      </button>
      {customOpen && (
        <div className="border-t border-[var(--color-surface-border)] px-4 py-2">
          <input
            type="datetime-local"
            value={customValue}
            onChange={(e) => setCustomValue(e.target.value)}
            min={toDateTimeLocalValue(new Date(Date.now() + 5 * 60_000))}
            className="w-full rounded border border-[var(--color-surface-border)] bg-[var(--color-surface)] px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-[var(--color-brand-600)]"
            aria-label="Custom snooze date and time"
          />
          <button
            type="button"
            disabled={!customValue || busy}
            onClick={() => void handleCustomSubmit()}
            className="mt-2 w-full rounded bg-[var(--color-brand-600)] py-1 text-xs text-white hover:bg-[var(--color-brand-700)] disabled:opacity-50"
          >
            Set
          </button>
        </div>
      )}
    </div>
  );
}
