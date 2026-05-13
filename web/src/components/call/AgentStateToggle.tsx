"use client";

import * as React from "react";
import { useAgentStore } from "@/lib/stores/agent";
import { Button } from "@/components/ui/button";

export function AgentStateToggle(): React.ReactElement {
  const status = useAgentStore((s) => s.status);
  const setStatus = useAgentStore((s) => s.setStatus);
  const setPause = useAgentStore((s) => s.setPause);
  const clearPause = useAgentStore((s) => s.clearPause);

  const onToggle = () => {
    if (status === "ready") {
      setPause("MANUAL");
    } else if (status === "paused") {
      clearPause();
    } else {
      setStatus("ready");
    }
  };

  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        variant={status === "ready" ? "primary" : "secondary"}
        size="sm"
        aria-pressed={status === "ready"}
        onClick={onToggle}
      >
        {status === "ready" ? "Pause" : "Ready"}
      </Button>
      <span className="text-xs text-[var(--color-fg-muted)]">
        Current: {status}
      </span>
    </div>
  );
}
