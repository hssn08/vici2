"use client";

// MonitorModal — opens when a supervisor clicks an IN_CALL agent tile on
// the wallboard. Shows agent info and three mode-select buttons.
//
// S02 PLAN §9.1.

import React, { useState } from "react";
import type { MonitorMode } from "@vici2/types";
import { useMonitorSession } from "./useMonitorSession.js";
import { MonitorSessionPanel } from "./MonitorSessionPanel.js";

export interface MonitorModalProps {
  agent: {
    uid: number;
    displayName: string;
    campaignName?: string;
    callDurationSec?: number;
  };
  /** Number of supervisors already monitoring this agent. */
  existingMonitorCount?: number;
  onClose: () => void;
}

export function MonitorModal({ agent, existingMonitorCount = 0, onClose }: MonitorModalProps): React.ReactElement {
  const { session, start, switchMode, end, error } = useMonitorSession();
  const [starting, setStarting] = useState(false);

  const handleModeSelect = async (mode: MonitorMode): Promise<void> => {
    setStarting(true);
    await start(agent.uid, mode);
    setStarting(false);
  };

  const handleEnd = async (): Promise<void> => {
    await end();
    onClose();
  };

  // Once a session is active, show the session panel.
  if (session.status === "active") {
    return (
      <ModalShell onClose={handleEnd}>
        <MonitorSessionPanel
          session={session}
          onSwitchMode={switchMode}
          onEnd={handleEnd}
          error={error}
        />
      </ModalShell>
    );
  }

  if (session.status === "ended") {
    return (
      <ModalShell onClose={onClose}>
        <p className="text-sm text-[var(--color-fg-muted)]">Session ended.</p>
        <button
          onClick={onClose}
          className="mt-4 w-full rounded-md bg-[var(--color-bg-subtle)] px-4 py-2 text-sm font-medium"
        >
          Close
        </button>
      </ModalShell>
    );
  }

  const callDuration = agent.callDurationSec != null
    ? formatDuration(agent.callDurationSec)
    : null;

  return (
    <ModalShell onClose={onClose}>
      {/* Agent info */}
      <div className="mb-4">
        <h2 className="text-lg font-semibold">{agent.displayName}</h2>
        {agent.campaignName && (
          <p className="text-sm text-[var(--color-fg-muted)]">{agent.campaignName}</p>
        )}
        {callDuration && (
          <p className="text-sm text-[var(--color-fg-muted)]">Call duration: {callDuration}</p>
        )}
        {existingMonitorCount > 0 && (
          <p className="mt-1 text-xs text-amber-600">
            This agent is already being monitored by {existingMonitorCount} supervisor
            {existingMonitorCount !== 1 ? "s" : ""}. You may still join.
          </p>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="mb-3 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Mode buttons */}
      <div className="grid grid-cols-3 gap-2">
        <ModeButton
          label="Listen"
          description="Listen silently"
          mode="listen"
          disabled={starting || session.status === "starting"}
          onClick={handleModeSelect}
        />
        <ModeButton
          label="Whisper"
          description="Coach the agent"
          mode="whisper"
          disabled={starting || session.status === "starting"}
          onClick={handleModeSelect}
        />
        <ModeButton
          label="Barge"
          description="Join conversation"
          mode="barge"
          disabled={starting || session.status === "starting"}
          onClick={handleModeSelect}
        />
      </div>

      {(starting || session.status === "starting") && (
        <p className="mt-3 text-center text-sm text-[var(--color-fg-muted)]">
          Connecting…
        </p>
      )}
    </ModalShell>
  );
}

interface ModeButtonProps {
  label: string;
  description: string;
  mode: MonitorMode;
  disabled: boolean;
  onClick: (mode: MonitorMode) => void;
}

function ModeButton({ label, description, mode, disabled, onClick }: ModeButtonProps): React.ReactElement {
  const colorMap: Record<MonitorMode, string> = {
    listen: "bg-blue-600 hover:bg-blue-700",
    whisper: "bg-amber-500 hover:bg-amber-600",
    barge: "bg-red-600 hover:bg-red-700",
  };

  return (
    <button
      onClick={() => onClick(mode)}
      disabled={disabled}
      className={`flex flex-col items-center rounded-lg px-3 py-4 text-white transition-colors ${colorMap[mode]} disabled:opacity-50 disabled:cursor-not-allowed`}
    >
      <span className="font-semibold">{label}</span>
      <span className="mt-1 text-xs opacity-80">{description}</span>
    </button>
  );
}

function ModalShell({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}): React.ReactElement {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="relative w-full max-w-sm rounded-xl bg-[var(--color-bg)] p-6 shadow-xl">
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute right-4 top-4 text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
        >
          ✕
        </button>
        {children}
      </div>
    </div>
  );
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
