"use client";

import * as React from "react";
import { CallStatePill } from "@/components/call/CallStatePill";
import { CallTimer } from "@/components/call/CallTimer";
import { RecordingBadge } from "@/components/call/RecordingBadge";
import { useCallStore } from "@/lib/stores/call";
import { useAgentStore } from "@/lib/stores/agent";
import { useSoftphone } from "@/lib/sip";
import { cn } from "@/lib/utils";
import { NotificationBell } from "@/components/notifications/NotificationBell";

interface TopBarProps {
  className?: string;
}

function SoftphoneStatusBadge(): React.ReactElement | null {
  const { status } = useSoftphone();

  if (status === "registered" || status === "on-call") return null;

  const map: Record<string, { label: string; cls: string }> = {
    connecting: { label: "Connecting audio...", cls: "text-[var(--color-state-hold)]" },
    reconnecting: { label: "Reconnecting audio...", cls: "text-yellow-500" },
    error: { label: "Audio disconnected", cls: "text-[var(--color-state-error)]" },
    idle: { label: "Audio not connected", cls: "text-[var(--color-fg-muted)]" },
  };

  const config = map[status] ?? map.idle;

  return (
    <span aria-live="polite" className={cn("text-xs font-medium", config.cls)}>
      {config.label}
    </span>
  );
}

export function TopBar({ className }: TopBarProps): React.ReactElement {
  const phase = useCallStore((s) => s.phase);
  const campaign = useCallStore((s) => s.campaign);
  const agentStatus = useAgentStore((s) => s.status);

  return (
    <header
      role="banner"
      className={cn(
        "call-top-bar flex items-center justify-between gap-4 border-b border-[var(--color-surface-border)] bg-[var(--color-surface-elevated)] px-4",
        className,
      )}
      style={{ gridColumn: "1 / -1", gridRow: 1, height: 56 }}
    >
      {/* Left: campaign + agent status */}
      <div className="flex items-center gap-3 min-w-0">
        {campaign && (
          <span className="truncate text-sm font-semibold">{campaign.name}</span>
        )}
        <span className="rounded-full bg-[var(--color-surface-muted)] px-2 py-0.5 text-xs text-[var(--color-fg-muted)] uppercase">
          {agentStatus}
        </span>
      </div>

      {/* Center: call state + timer */}
      <div className="flex items-center gap-3">
        <CallStatePill phase={phase} />
        {(phase === "active" || phase === "hold" || phase === "transferring" || phase === "wrapup") && (
          <CallTimer className="font-mono text-sm tabular-nums" />
        )}
        <SoftphoneStatusBadge />
      </div>

      {/* Right: notification bell + recording badge */}
      <div className="flex items-center gap-2">
        <NotificationBell />
        <RecordingBadge />
      </div>
    </header>
  );
}
