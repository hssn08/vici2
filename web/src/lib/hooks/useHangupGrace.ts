"use client";

import * as React from "react";
import { useCallStore } from "@/lib/stores/call";
import { useUiStore } from "@/lib/stores/ui";
import { apiFetch } from "@/lib/api";

const DEFAULT_GRACE_MS = 5000;

export interface UseHangupGraceReturn {
  graceActive: boolean;
  triggerHangup: () => void;
  cancelHangup: () => void;
}

export function useHangupGrace(): UseHangupGraceReturn {
  const callUuid = useCallStore((s) => s.callUuid);
  const phase = useCallStore((s) => s.phase);
  const campaign = useCallStore((s) => s.campaign);
  const hangupGraceActive = useCallStore((s) => s.hangupGraceActive);
  const hangupGraceTimer = useCallStore((s) => s.hangupGraceTimer);
  const setPhase = useCallStore((s) => s.setPhase);
  const setHangupGrace = useCallStore((s) => s.setHangupGrace);
  const disableHangupGrace = useUiStore((s) => s.disableHangupGrace);

  const graceMsRef = React.useRef<number>(
    (campaign?.hangup_grace_seconds ?? 5) * 1000,
  );
  React.useEffect(() => {
    graceMsRef.current = (campaign?.hangup_grace_seconds ?? 5) * 1000;
  }, [campaign?.hangup_grace_seconds]);

  const commitHangup = React.useCallback(async () => {
    if (!callUuid) return;
    setHangupGrace(false, null);
    try {
      await apiFetch(`/api/agent/call/${callUuid}/hangup`, { method: "POST", body: {} });
    } catch {
      // best-effort; FS will clean up via endconf-grace-time
    }
  }, [callUuid, setHangupGrace]);

  const triggerHangup = React.useCallback(() => {
    if (!callUuid || phase === "wrapup" || phase === "idle") return;
    // Move to wrapup immediately (optimistic)
    setPhase("wrapup");

    if (disableHangupGrace) {
      // Skip grace — fire immediately
      void commitHangup();
      return;
    }

    // Start grace timer
    const graceMs = graceMsRef.current || DEFAULT_GRACE_MS;
    const timer = setTimeout(() => {
      void commitHangup();
    }, graceMs);

    setHangupGrace(true, timer);
  }, [callUuid, phase, disableHangupGrace, setPhase, commitHangup, setHangupGrace]);

  const cancelHangup = React.useCallback(() => {
    if (!hangupGraceActive) return;
    if (hangupGraceTimer) {
      clearTimeout(hangupGraceTimer);
    }
    setHangupGrace(false, null);
    setPhase("active");
  }, [hangupGraceActive, hangupGraceTimer, setHangupGrace, setPhase]);

  return { graceActive: hangupGraceActive, triggerHangup, cancelHangup };
}
