"use client";

import * as React from "react";
import { useAgentStore } from "@/lib/stores/agent";
import { useWsStore } from "@/lib/stores/ws";
import { useCallStore } from "@/lib/stores/call";
import { Badge } from "@/components/ui/badge";

const WS_TONE: Record<string, "neutral" | "success" | "warning" | "danger"> = {
  idle: "neutral",
  connecting: "warning",
  open: "success",
  reconnecting: "warning",
  closed: "danger",
};

export function StatusBar(): React.ReactElement {
  const agent = useAgentStore((s) => s.status);
  const phase = useCallStore((s) => s.phase);
  const ws = useWsStore((s) => s.connection);

  return (
    <footer
      role="contentinfo"
      className="flex h-9 items-center justify-between border-t bg-[var(--color-surface-elevated)] px-4 text-xs text-[var(--color-fg-muted)]"
    >
      <div className="flex items-center gap-3">
        <span>
          Agent: <strong className="text-[var(--color-fg)]">{agent}</strong>
        </span>
        <span>
          Call: <strong className="text-[var(--color-fg)]">{phase}</strong>
        </span>
      </div>
      <div className="flex items-center gap-3">
        <Badge tone={WS_TONE[ws] ?? "neutral"}>WS: {ws}</Badge>
      </div>
    </footer>
  );
}
