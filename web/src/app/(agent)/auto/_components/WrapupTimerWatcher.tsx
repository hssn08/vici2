"use client";

/**
 * WrapupTimerWatcher — non-rendering component that fires auto-dispo when
 * the wrapup timer expires during an auto-dial session.
 *
 * Mounted inside A05's wrapup overlay when dialMode !== 'manual'.
 * Retries once after 5 s on network failure; shows persistent error toast on
 * second failure.
 */

import * as React from "react";
import { api } from "@/lib/api";
import { useCallStore } from "@/lib/stores/call";

interface WrapupTimerWatcherProps {
  onDispoComplete: () => void;
}

export function WrapupTimerWatcher({
  onDispoComplete,
}: WrapupTimerWatcherProps): null {
  const callUuid = useCallStore((s) => s.callUuid);
  const wrapupStartAt = useCallStore((s) => s.wrapupStartAt);
  const campaign = useCallStore((s) => s.campaign);
  const dialMode = useCallStore((s) => s.dialMode);
  const attemptUuid = useCallStore((s) => s.attemptUuid);

  const firedRef = React.useRef(false);

  React.useEffect(() => {
    // Only activate in auto-dial mode
    if (dialMode === "manual" || dialMode === null) return;
    if (!callUuid || !wrapupStartAt || !campaign) return;

    const wrapupMs = (campaign.wrapup_seconds ?? 30) * 1000;
    const elapsed = Date.now() - wrapupStartAt;
    const remaining = Math.max(0, wrapupMs - elapsed);

    const timer = setTimeout(async () => {
      if (firedRef.current) return;
      firedRef.current = true;

      const body = {
        call_uuid: callUuid,
        attempt_uuid: attemptUuid ?? undefined,
        status: campaign.default_dispo ?? "NA",
        comments: "[auto-dispo: wrapup expired]",
      };

      try {
        await api.post("/api/agent/dispo", body);
        onDispoComplete();
      } catch {
        // Retry once after 5 s
        setTimeout(async () => {
          try {
            await api.post("/api/agent/dispo", body);
            onDispoComplete();
          } catch {
            // Persistent error — surface to user via console; UI toast is A05's job
            console.error(
              "[WrapupTimerWatcher] Auto-dispo failed after retry. Agent must submit manually.",
            );
          }
        }, 5000);
      }
    }, remaining);

    return () => {
      clearTimeout(timer);
      firedRef.current = false;
    };
  }, [callUuid, wrapupStartAt, campaign, dialMode, attemptUuid, onDispoComplete]);

  return null;
}
