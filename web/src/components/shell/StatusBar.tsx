"use client";

import * as React from "react";
import { useAgentStore } from "@/lib/stores/agent";
import { useWsStore } from "@/lib/stores/ws";
import { useCallStore } from "@/lib/stores/call";
import { useAuthStore } from "@/lib/stores/auth";
import { Badge } from "@/components/ui/badge";

const WS_TONE: Record<string, "neutral" | "success" | "warning" | "danger"> = {
  idle: "neutral",
  connecting: "warning",
  open: "success",
  reconnecting: "warning",
  closed: "danger",
};

export function StatusBar(): React.ReactElement {
  const agentStatus = useAgentStore((s) => s.status);
  const pauseCode = useAgentStore((s) => s.pauseCode);
  const phase = useCallStore((s) => s.phase);
  const ws = useWsStore((s) => s.connection);
  const user = useAuthStore((s) => s.user);

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
