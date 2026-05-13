"use client";

// MonitorSessionPanel — displayed when a supervisor has an active monitor
// session. Shows the current mode badge, mode-switch buttons, session timer,
// and an "End session" button.
//
// S02 PLAN §9.1.

import React, { useState, useEffect } from "react";
import type { MonitorMode } from "@vici2/types";

export interface ActiveSessionInfo {
  status: "active";
  sessionId: string;
  targetUid: number;
  mode: MonitorMode;
  startedAt: Date;
  dialExtension: string;
}

interface MonitorSessionPanelProps {
  session: ActiveSessionInfo;
  onSwitchMode: (newMode: MonitorMode) => Promise<void>;
  onEnd: () => Promise<void>;
  error: string | null;
}

export function MonitorSessionPanel({
  session,
  onSwitchMode,
  onEnd,
  error,
}: MonitorSessionPanelProps): React.ReactElement {
  const [switching, setSwitching] = useState(false);
  const [ending, setEnding] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  // Session timer.
  useEffect(() => {
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - session.startedAt.getTime()) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [session.startedAt]);

  const handleSwitchMode = async (newMode: MonitorMode): Promise<void> => {
    if (newMode === session.mode || switching) return;
    setSwitching(true);
    await onSwitchMode(newMode);
    setSwitching(false);
  };

  const handleEnd = async (): Promise<void> => {
    setEnding(true);
    await onEnd();
    // onEnd closes the modal; no need to reset ending state.
  };

  const modeLabelMap: Record<MonitorMode, { label: string; color: string; desc: string }> = {
    listen: { label: "Listening", color: "bg-blue-100 text-blue-700", desc: "Silent observation" },
    whisper: { label: "Whispering", color: "bg-amber-100 text-amber-700", desc: "Coaching agent" },
    barge: { label: "Barged In", color: "bg-red-100 text-red-700", desc: "3-way conversation" },
  };

  const current = modeLabelMap[session.mode];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">Monitor Session</h2>
        <span className="font-mono text-sm text-[var(--color-fg-muted)]">
          {formatDuration(elapsed)}
        </span>
      </div>

      {/* Current mode badge */}
      <div className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-medium ${current.color}`}>
        <span className="h-2 w-2 rounded-full bg-current" />
        {current.label}
        <span className="text-xs font-normal opacity-70">— {current.desc}</span>
      </div>

      {/* Error */}
      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Mode-switch buttons */}
      <div>
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--color-fg-muted)]">
          Switch Mode
        </p>
        <div className="flex gap-2">
          {(["listen", "whisper", "barge"] as MonitorMode[]).map((m) => (
            <button
              key={m}
              onClick={() => void handleSwitchMode(m)}
              disabled={m === session.mode || switching || ending}
              className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors
                ${m === session.mode
                  ? "bg-[var(--color-bg-subtle)] text-[var(--color-fg)] ring-2 ring-inset ring-[var(--color-border-focus)]"
                  : "bg-[var(--color-bg-subtle)] text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-hover)]"}
                disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              {m.charAt(0).toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* End session */}
      <button
        onClick={() => void handleEnd()}
        disabled={ending}
        className="w-full rounded-md bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {ending ? "Ending…" : "End Session"}
      </button>
    </div>
  );
}

function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}
