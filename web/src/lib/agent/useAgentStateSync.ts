"use client";

import * as React from "react";
import { createReconnectingWs } from "@/lib/ws";
import { useAgentStore } from "@/lib/stores/agent";
import { useAuthStore } from "@/lib/stores/auth";
import type { AgentStatus } from "@/lib/stores/agent";

interface AgentStatePayload {
  status: AgentStatus;
  pauseCode?: string | null;
  pausedSince?: number | null;
  currentCampaignId?: number | null;
  inboundGroupIds?: number[];
}

/**
 * Subscribe to `agent.state` WebSocket events and patch `useAgentStore`.
 * Should be called once inside AgentShell (or a provider that lives inside
 * the authenticated shell).
 */
export function useAgentStateSync(): void {
  const patchFromEvent = useAgentStore((s) => s.patchFromEvent);
  const wsToken = useAuthStore((s) => s.wsToken);

  React.useEffect(() => {
    if (!wsToken) return;

    const ws = createReconnectingWs({
      url: () => {
        if (typeof window === "undefined") return "ws://localhost/ws";
        return (
          process.env.NEXT_PUBLIC_WS_URL ??
          window.location.href.replace(/^http/, "ws").replace(/\/?$/, "/ws")
        );
      },
      token: () => useAuthStore.getState().wsToken,
    });

    const offState = ws.subscribe(
      "agent.state",
      (event) => {
        const p = event.data as AgentStatePayload;
        patchFromEvent({
          status: p.status,
          pauseCode: p.pauseCode ?? null,
          pausedSince: p.pausedSince ?? null,
          currentCampaignId: p.currentCampaignId ?? null,
          inboundGroupIds: p.inboundGroupIds ?? [],
        });
      },
    );

    ws.start();

    return () => {
      offState();
      ws.stop();
    };
  }, [wsToken, patchFromEvent]);
}
