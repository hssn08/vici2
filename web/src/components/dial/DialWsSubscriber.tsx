"use client";

/**
 * DialWsSubscriber — mounts alongside DialShell; subscribes to
 * 7 WebSocket events and drives useDialStore transitions.
 *
 * A04 is read-only on WS — it never publishes messages.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { createReconnectingWs } from "@/lib/ws";
import { useAuthStore } from "@/lib/stores/auth";
import { useAgentStore } from "@/lib/stores/agent";
import { useDialStore } from "@/lib/stores/dial";
import { getWsUrl } from "@/lib/env";

export function DialWsSubscriber(): React.ReactElement | null {
  const router = useRouter();
  const wsToken = useAuthStore((s) => s.wsToken);

  React.useEffect(() => {
    if (!wsToken) return;

    const ws = createReconnectingWs({
      url: () => getWsUrl(),
      token: () => useAuthStore.getState().wsToken,
    });

    const unsubs = [
      ws.subscribe("call.originated", (event) => {
        const data = event.data as { attempt_uuid: string };
        useDialStore.getState().setAttemptUuid(data.attempt_uuid);
      }),

      ws.subscribe("call.ringing", (event) => {
        const data = event.data as { call_uuid: string };
        useDialStore.getState().setCallUuid(data.call_uuid);
      }),

      ws.subscribe("call.bridged", () => {
        // A05 takes over
        router.push("/call");
      }),

      ws.subscribe("call.failed", (event) => {
        const data = event.data as { reason: string };
        useDialStore.getState().setBlock({
          code: "CALL_FAILED",
          message: data.reason ?? "Call failed",
        });
      }),

      ws.subscribe("call.cancelled", () => {
        useDialStore.getState().resetDial();
      }),

      ws.subscribe("agent.state_changed", (event) => {
        const data = event.data as { user_id: string; status: string };
        const myId = useAuthStore.getState().user?.id;
        if (data.user_id === myId) {
          // Cast to AgentStatus — server is authoritative
          useAgentStore.getState().setStatus(data.status as import("@/lib/stores/agent").AgentStatus);
        }
      }),

      ws.subscribe("compliance.window_changed", () => {
        // Re-evaluate TCPA gate: reset hint so DialShell re-fetches
        useDialStore.getState().setClientGates({ tcpaHint: "unknown" });
      }),
    ];

    ws.start();

    return () => {
      unsubs.forEach((fn) => fn());
      ws.stop();
    };
  }, [wsToken, router]);

  return null;
}
