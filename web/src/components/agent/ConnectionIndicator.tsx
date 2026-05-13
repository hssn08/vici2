"use client";

import * as React from "react";
import { useWsStore, type WsConnectionState } from "@/lib/stores/ws";
import { useSoftphone } from "@/lib/sip";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DotStatus = "ok" | "warn" | "error" | "idle";

interface DotProps {
  label: string;
  status: DotStatus;
  detail?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wsToDot(ws: WsConnectionState): DotStatus {
  switch (ws) {
    case "open":
      return "ok";
    case "connecting":
    case "reconnecting":
      return "warn";
    case "closed":
      return "error";
    default:
      return "idle";
  }
}

function sipToDot(
  status: string,
  registered: boolean,
): DotStatus {
  if (status === "registered" || registered) return "ok";
  if (status === "connecting" || status === "reconnecting") return "warn";
  if (status === "error") return "error";
  if (status === "on-call" || status === "on-hold") return "ok";
  return "idle";
}

// ---------------------------------------------------------------------------
// Dot
// ---------------------------------------------------------------------------

function Dot({ label, status, detail }: DotProps): React.ReactElement {
  const colorClass = {
    ok: "bg-emerald-500",
    warn: "bg-amber-400 animate-pulse",
    error: "bg-red-500",
    idle: "bg-[var(--color-surface-border)]",
  }[status];

  const title = detail ? `${label}: ${status} — ${detail}` : `${label}: ${status}`;

  return (
    <span
      role="img"
      aria-label={title}
      title={title}
      className={cn("inline-block h-2 w-2 rounded-full transition-colors", colorClass)}
    />
  );
}

// ---------------------------------------------------------------------------
// ConnectionIndicator (must live inside <SipProvider>)
// ---------------------------------------------------------------------------

/**
 * Renders WS + SIP connection health dots.
 * Must be mounted inside <SipProvider> (i.e. inside AgentShell).
 */
export function ConnectionIndicator(): React.ReactElement {
  const ws = useWsStore((s) => s.connection);
  const { status: sipStatus, registered, error: sipError } = useSoftphone();

  return (
    <div
      className="flex items-center gap-1.5"
      aria-label="Connection status"
      role="status"
    >
      <Dot
        label="WS"
        status={wsToDot(ws)}
        detail={ws}
      />
      <Dot
        label="SIP"
        status={sipToDot(sipStatus, registered)}
        detail={sipError ? sipError.message : sipStatus}
      />
    </div>
  );
}
