"use client";

import * as React from "react";
import { useAgentStore } from "@/lib/stores/agent";
import { useWsStore } from "@/lib/stores/ws";
import { useCallStore } from "@/lib/stores/call";
import { useAuthStore } from "@/lib/stores/auth";
import { Badge } from "@/components/ui/badge";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WS_TONE: Record<string, "neutral" | "success" | "warning" | "danger"> = {
  idle: "neutral",
  connecting: "warning",
  open: "success",
  reconnecting: "warning",
  closed: "danger",
};

/** Format seconds as m:ss or h:mm:ss */
function formatDuration(totalSec: number): string {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// StatusBar
// ---------------------------------------------------------------------------

export function StatusBar(): React.ReactElement {
  const agentStatus = useAgentStore((s) => s.status);
  const pauseCode = useAgentStore((s) => s.pauseCode);
  const pausedSince = useAgentStore((s) => s.pausedSince);
  const phase = useCallStore((s) => s.phase);
  const ws = useWsStore((s) => s.connection);
  const user = useAuthStore((s) => s.user);

  // A09: live pause duration counter
  const [pauseSeconds, setPauseSeconds] = React.useState(0);

  React.useEffect(() => {
    if (!pausedSince) {
      setPauseSeconds(0);
      return;
    }
    const tick = () =>
      setPauseSeconds(Math.floor((Date.now() - pausedSince) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [pausedSince]);

  return (
    <footer
      role="contentinfo"
      className="flex h-9 items-center justify-between border-t bg-[var(--color-surface-elevated)] px-4 text-xs text-[var(--color-fg-muted)]"
    >
      {/* Left: agent + call state */}
      <div className="flex items-center gap-3">
        <span>
          Agent:{" "}
          <strong className="text-[var(--color-fg)]">{agentStatus}</strong>
          {agentStatus === "paused" && pauseCode ? (
            <span className="ml-1 text-[var(--color-fg-muted)]">
              ({pauseCode})
            </span>
          ) : null}
          {agentStatus === "paused" && pausedSince ? (
            <span aria-live="off" className="ml-1 text-[var(--color-fg-muted)]">
              — {formatDuration(pauseSeconds)}
            </span>
          ) : null}
        </span>
        <span>
          Call: <strong className="text-[var(--color-fg)]">{phase}</strong>
        </span>
      </div>

      {/* Right: tenant + WS state */}
      <div className="flex items-center gap-3">
        {user ? (
          <span className="hidden sm:inline">
            Tenant {user.tenantId}
          </span>
        ) : null}
        <Badge tone={WS_TONE[ws] ?? "neutral"}>WS: {ws}</Badge>
      </div>
    </footer>
  );
}
