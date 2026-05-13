"use client";

// A08 — useCallbacksDue: subscribes to callback_due WS events + 30s poll
// fallback. Shows a persistent toast via useCallbackToast when a callback
// becomes due. Uses BroadcastChannel for multi-tab dedup.

import { useEffect, useRef } from "react";
import { createReconnectingWs } from "@/lib/ws";
import { useAuthStore } from "@/lib/stores/auth";
import { useCallbackStore } from "@/lib/stores/callbacks";
import { useCallbackToast } from "@/components/call/CallbackToast";
import { apiFetch } from "@/lib/api";
import { getWsUrl } from "@/lib/env";
import type { DueCallbackData } from "@/lib/types/callbacks";
import type { Callback } from "@/lib/types/callbacks";

const BC_CHANNEL = "vici2-callbacks";
const POLL_INTERVAL_MS = 30_000;

export function useCallbacksDue(): void {
  const { showDueToast } = useCallbackToast();
  const bcRef = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    // Guard for SSR / environments without BroadcastChannel
    if (typeof BroadcastChannel !== "undefined") {
      bcRef.current = new BroadcastChannel(BC_CHANNEL);
    }

    const wsToken = useAuthStore.getState().wsToken;
    if (!wsToken) return;

    const ws = createReconnectingWs({
      url: () => getWsUrl(),
      token: () => useAuthStore.getState().wsToken,
    });

    const handleDueEvent = (cbData: DueCallbackData) => {
      const { dueShown, addDueShown } = useCallbackStore.getState();
      if (dueShown.has(cbData.callback_id)) return;

      addDueShown(cbData.callback_id);
      showDueToast(cbData);
      bcRef.current?.postMessage({
        event: "callback_due_shown",
        callback_id: cbData.callback_id,
      });
    };

    const unsub = ws.subscribe("callback_due", (event) => {
      handleDueEvent(event.data as DueCallbackData);
    });

    // BroadcastChannel message from another tab
    if (bcRef.current) {
      bcRef.current.onmessage = (msg: MessageEvent<{ event: string; callback_id: string }>) => {
        if (msg.data?.event === "callback_due_shown" && msg.data.callback_id) {
          useCallbackStore.getState().addDueShown(msg.data.callback_id);
        }
      };
    }

    ws.start();

    // 30s poll fallback for when WS is disconnected
    const pollInterval = setInterval(async () => {
      try {
        const data = await apiFetch<{ callbacks: Callback[]; next_cursor: string | null }>(
          "/api/agent/callbacks/mine?limit=50",
        );
        const now = Date.now();
        const { dueShown } = useCallbackStore.getState();

        for (const cb of data.callbacks) {
          if (cb.status !== "LIVE") continue;
          const cbTime = new Date(cb.callback_at).getTime();
          // Show toast if callback is due within the next 60s
          if (cbTime <= now + 60_000 && !dueShown.has(cb.id)) {
            const dueData: DueCallbackData = {
              callback_id: cb.id,
              lead_id: cb.lead_id,
              lead_name: cb.lead_name ?? "Unknown",
              phone: cb.lead_phone ?? "",
              callback_at: cb.callback_at,
              comments: cb.comments,
            };
            handleDueEvent(dueData);
          }
        }
      } catch {
        // Poll errors are silent — WS will recover
      }
    }, POLL_INTERVAL_MS);

    return () => {
      unsub();
      ws.stop();
      clearInterval(pollInterval);
      bcRef.current?.close();
    };
  }, [showDueToast]);
}

/**
 * Thin component that mounts useCallbacksDue once in the agent shell.
 * Rendered as a sibling to <HotkeyHelpOverlay />.
 */
export function CallbackDueWatcher(): null {
  useCallbacksDue();
  return null;
}
