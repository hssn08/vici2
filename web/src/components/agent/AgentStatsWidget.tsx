"use client";

/**
 * A07 — AgentStatsWidget
 * Compact top-bar widget showing today's calls, contacts, sales, talk-time, drop%.
 * Auto-refreshes every 30s. Click opens a mini popover with full details.
 */

import * as React from "react";
import { useAgentTodayStats, type AgentTodayStats } from "@/lib/hooks/useAgentTodayStats";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatTalkTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function timeAgo(dateStr: string): string {
  const diff = (Date.now() - new Date(dateStr).getTime()) / 1000;
  if (diff < 10) return "just now";
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

// ---------------------------------------------------------------------------
// StatsPopover — detailed breakdown
// ---------------------------------------------------------------------------

interface StatsPopoverProps {
  stats: AgentTodayStats;
  loading: boolean;
  onClose: () => void;
}

function StatsPopover({ stats, loading, onClose }: StatsPopoverProps): React.ReactElement {
  return (
    <div
      role="dialog"
      aria-label="Today's call stats details"
      aria-modal="false"
      className={cn(
        "absolute right-0 top-full z-50 mt-1 w-64",
        "rounded-lg border border-[var(--color-surface-border)]",
        "bg-[var(--color-surface-elevated)] shadow-lg",
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--color-surface-border)] px-4 py-2.5">
        <span className="text-sm font-semibold text-[var(--color-fg-default)]">
          Today&apos;s Stats
        </span>
        {loading && (
          <span
            className="h-2 w-2 animate-spin rounded-full border border-[var(--color-fg-muted)] border-t-transparent"
            aria-label="Refreshing"
          />
        )}
      </div>

      {/* Stats rows */}
      <dl className="px-4 py-3 space-y-2">
        {(
          [
            ["Calls handled", stats.callsHandled.toString()],
            ["Contacts", stats.contacts.toString()],
            ["Sales", stats.sales.toString()],
            ["Talk time", formatTalkTime(stats.talkTimeSec)],
            ["Drop rate", `${stats.dropPct.toFixed(1)}%`],
          ] as [string, string][]
        ).map(([label, value]) => (
          <div key={label} className="flex items-center justify-between">
            <dt className="text-xs text-[var(--color-fg-muted)]">{label}</dt>
            <dd className="text-sm font-medium tabular-nums text-[var(--color-fg-default)]">
              {value}
            </dd>
          </div>
        ))}
      </dl>

      {/* Footer */}
      <div className="border-t border-[var(--color-surface-border)] px-4 py-2">
        <p className="text-[10px] text-[var(--color-fg-subtle)]">
          Updated {timeAgo(stats.asOf)}
        </p>
      </div>

      {/* Close button (for keyboard / touch) */}
      <button
        type="button"
        onClick={onClose}
        aria-label="Close stats details"
        className="sr-only"
      >
        Close
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AgentStatsWidget
// ---------------------------------------------------------------------------

export function AgentStatsWidget(): React.ReactElement | null {
  const { stats, loading } = useAgentTodayStats();
  const [open, setOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);

  // Close on outside click / Escape
  React.useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onMouseDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [open]);

  if (!stats && !loading) return null;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-label="Today's call stats"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex items-center gap-2 rounded-md px-2.5 py-1.5",
          "text-xs text-[var(--color-fg-muted)] tabular-nums",
          "hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg-default)]",
          "transition-colors focus-visible:outline-none focus-visible:ring-2",
          open && "bg-[var(--color-surface-muted)] text-[var(--color-fg-default)]",
        )}
      >
        {/* Loading spinner */}
        {loading && !stats && (
          <span
            className="h-2 w-2 animate-spin rounded-full border border-[var(--color-fg-muted)] border-t-transparent"
            aria-hidden="true"
          />
        )}

        {stats && (
          <>
            {/* Phone icon */}
            <svg
              width="13"
              height="13"
              viewBox="0 0 13 13"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M2.7 1C2.3 1 2 1.3 2 1.7c0 5.1 4.2 9.3 9.3 9.3.4 0 .7-.3.7-.7V8.2c0-.4-.3-.7-.7-.7l-2-.3c-.4-.1-.7.1-.9.4l-.6 1c-1.2-.6-2.3-1.7-3-3l1-.5c.3-.2.5-.6.4-.9l-.3-2C5.9 1.3 5.6 1 5.2 1H2.7Z" />
            </svg>

            <span>{stats.callsHandled}</span>
            <span className="text-[var(--color-fg-subtle)]">·</span>
            <span>{stats.contacts} ctc</span>
            <span className="text-[var(--color-fg-subtle)]">·</span>
            <span>{stats.sales} sales</span>
            <span className="text-[var(--color-fg-subtle)]">·</span>
            <span>{formatTalkTime(stats.talkTimeSec)}</span>
            {stats.dropPct > 0 && (
              <>
                <span className="text-[var(--color-fg-subtle)]">·</span>
                <span
                  className={cn(
                    stats.dropPct >= 5
                      ? "text-[var(--color-state-error)]"
                      : "text-[var(--color-fg-muted)]",
                  )}
                >
                  {stats.dropPct.toFixed(1)}% drop
                </span>
              </>
            )}

            {/* Refresh indicator */}
            {loading && (
              <span
                className="ml-0.5 h-1.5 w-1.5 animate-spin rounded-full border border-[var(--color-fg-muted)] border-t-transparent"
                aria-label="Refreshing"
              />
            )}
          </>
        )}
      </button>

      {open && stats && (
        <StatsPopover stats={stats} loading={loading} onClose={() => setOpen(false)} />
      )}
    </div>
  );
}
