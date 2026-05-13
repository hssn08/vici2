"use client";

/**
 * useAutoDialRouter — post-dispo routing hook.
 *
 * Imported by A05's DispositionPicker (or wrapup component) and called after
 * a successful POST /api/agent/dispo. Decides whether to navigate to /auto
 * (IDLE or PAUSED) or /dial (manual mode) based on campaign + pending state.
 *
 * This is the primary A05↔A06 coupling point.
 */

import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useCallStore } from "@/lib/stores/call";

export interface AutoDialRouterResult {
  handleDispoComplete: () => Promise<void>;
  isAutoDialMode: boolean;
}

export function useAutoDialRouter(): AutoDialRouterResult {
  const router = useRouter();
  const campaign = useCallStore((s) => s.campaign);
  const dialMode = useCallStore((s) => s.dialMode);
  const pendingPause = useCallStore((s) => s.pendingPauseAfterCall);
  const pendingPauseCode = useCallStore((s) => s.pendingPauseCode);
  const setPendingPause = useCallStore((s) => s.setPendingPause);

  const isAutoDialMode = dialMode !== null && dialMode !== "manual";

  async function handleDispoComplete(): Promise<void> {
    // Manual mode — back to A04
    if (!isAutoDialMode) {
      router.replace("/dial");
      return;
    }

    if (pendingPause) {
      try {
        await api.post("/api/agent/state", {
          status: "paused",
          pauseCode: pendingPauseCode ?? undefined,
        });
      } catch {
        // State transition failed — navigate anyway; server will reconcile
      } finally {
        setPendingPause(false);
      }
      router.replace("/auto"); // /auto will show PAUSED state
      return;
    }

    if (campaign?.auto_ready_after_wrapup) {
      try {
        await api.post("/api/agent/state", { status: "ready" });
      } catch {
        // Best-effort — navigate regardless
      }
      router.replace("/auto"); // IDLE — ready for next call
      return;
    }

    // auto_ready_after_wrapup = false: agent must click "Return to Auto-Dial"
    router.replace("/auto"); // PAUSED display; agent clicks to re-ready
  }

  return { handleDispoComplete, isAutoDialMode };
}
