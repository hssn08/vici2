"use client";

import * as React from "react";
import { useCallStore } from "@/lib/stores/call";
import { apiFetch } from "@/lib/api";

const DEFAULT_WRAPUP_SECONDS = 60;

export interface UseWrapupTimerReturn {
  secondsLeft: number;
  resetTimer: () => void;
}

export function useWrapupTimer(onExpire?: () => void): UseWrapupTimerReturn {
  const phase = useCallStore((s) => s.phase);
  const wrapupStartAt = useCallStore((s) => s.wrapupStartAt);
  const campaign = useCallStore((s) => s.campaign);
  const callUuid = useCallStore((s) => s.callUuid);
  const notes = useCallStore((s) => s.notes);
  const clearCall = useCallStore((s) => s.clearCall);

  const totalSeconds = campaign?.wrapup_seconds ?? DEFAULT_WRAPUP_SECONDS;
  const [resetEpoch, setResetEpoch] = React.useState<number>(0);
  const resetBaseRef = React.useRef<number | null>(null);

  const getSecondsLeft = React.useCallback(() => {
    if (phase !== "wrapup" || !wrapupStartAt) return totalSeconds;
    const base = resetBaseRef.current ?? wrapupStartAt;
    const elapsed = Math.floor((Date.now() - base) / 1000);
    return Math.max(0, totalSeconds - elapsed);
  // resetEpoch is intentionally included to force recompute when resetTimer() is called
  }, [phase, wrapupStartAt, totalSeconds, resetEpoch]);

  const [secondsLeft, setSecondsLeft] = React.useState<number>(totalSeconds);
  const expiredRef = React.useRef(false);

  const resetTimer = React.useCallback(() => {
    resetBaseRef.current = Date.now();
    setResetEpoch((e) => e + 1);
    expiredRef.current = false;
  }, []);

  React.useEffect(() => {
    if (phase !== "wrapup") {
      expiredRef.current = false;
      resetBaseRef.current = null;
      setSecondsLeft(totalSeconds);
      return;
    }

    const tick = () => {
      const left = getSecondsLeft();
      setSecondsLeft(left);
      if (left <= 0 && !expiredRef.current) {
        expiredRef.current = true;
        // Auto-submit NA
        if (callUuid) {
          void apiFetch("/api/agent/dispo", {
            method: "POST",
            body: {
              call_uuid: callUuid,
              status: "NA",
              comments: `${notes ? notes + "\n" : ""}[auto-dispo wrapup expired]`,
            },
          })
            .then(() => {
              clearCall();
            })
            .catch(() => {
              clearCall();
            });
        }
        if (onExpire) onExpire();
      }
    };

    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [phase, wrapupStartAt, totalSeconds, callUuid, getSecondsLeft, notes, clearCall, onExpire]);

  return { secondsLeft, resetTimer };
}
