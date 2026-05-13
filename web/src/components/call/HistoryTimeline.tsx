"use client";

import * as React from "react";
import { useCallStore } from "@/lib/stores/call";

interface HistoryEvent {
  id: string | number;
  type: "call" | "callback" | "creation";
  timestamp: string;
  agentName?: string;
  duration?: number; // seconds
  status?: string;
  comments?: string;
}

function formatRelative(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor(diff / 3600000);
  const mins = Math.floor(diff / 60000);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  return `${mins}m ago`;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function HistoryTimeline(): React.ReactElement {
  const lead = useCallStore((s) => s.lead);
  const [events, setEvents] = React.useState<HistoryEvent[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [expandedId, setExpandedId] = React.useState<string | number | null>(null);

  React.useEffect(() => {
    if (!lead?.id) return;
    setLoading(true);
    fetch(`/api/agent/lead/${lead.id}/history?limit=10`)
      .then((r) => r.json() as Promise<HistoryEvent[]>)
      .then((data) => setEvents(data))
      .catch(() => setEvents([]))
      .finally(() => setLoading(false));
  }, [lead?.id]);

  return (
    <div className="px-4 pb-4">
      <h3 className="text-xs font-semibold text-[var(--color-fg-muted)] uppercase tracking-wide mb-2">
        Recent contacts ({events.length})
      </h3>

      {loading && (
        <ul aria-label="Loading call history" className="space-y-2">
          {[0, 1, 2].map((i) => (
            <li key={i} className="h-10 rounded bg-[var(--color-surface-muted)] animate-pulse" />
          ))}
        </ul>
      )}

      {!loading && events.length === 0 && (
        <p className="text-xs italic text-[var(--color-fg-muted)]">No prior contact.</p>
      )}

      {!loading && events.length > 0 && (
        <ul aria-label="Call history" className="space-y-1">
          {events.map((ev) => (
            <li key={ev.id} className="text-xs">
              <div className="flex items-center gap-1 flex-wrap">
                <span className="text-[var(--color-fg-muted)]">{formatRelative(ev.timestamp)}</span>
                {ev.agentName && <span className="font-medium">{ev.agentName}</span>}
                {ev.duration !== undefined && (
                  <span className="text-[var(--color-fg-muted)]">{formatDuration(ev.duration)}</span>
                )}
                {ev.status && (
                  <span className="rounded-full bg-[var(--color-surface-muted)] px-1.5 py-0.5">
                    {ev.status}
                  </span>
                )}
              </div>
              {ev.comments && (
                <div
                  className="mt-0.5 pl-2 text-[var(--color-fg-muted)] cursor-pointer"
                  onClick={() => setExpandedId(expandedId === ev.id ? null : ev.id)}
                >
                  {expandedId === ev.id
                    ? ev.comments
                    : ev.comments.slice(0, 240) + (ev.comments.length > 240 ? "…" : "")}
                  {ev.comments.length > 240 && (
                    <button className="ml-1 text-[var(--color-brand-600)]">
                      {expandedId === ev.id ? "Show less" : "Show more"}
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
