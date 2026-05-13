"use client";

import * as React from "react";
import { useCallStore, type ConferenceParticipant } from "@/lib/stores/call";
import { apiFetch } from "@/lib/api";

export interface UseThreeWayReturn {
  participants: ConferenceParticipant[];
  originate: (phoneE164: string, cidOverride?: string) => Promise<void>;
  leave: () => Promise<void>;
  loading: boolean;
  error: string | null;
}

export function useThreeWay(): UseThreeWayReturn {
  const callUuid = useCallStore((s) => s.callUuid);
  const participants = useCallStore((s) => s.threeWayParticipants);
  const setPhase = useCallStore((s) => s.setPhase);

  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const originate = React.useCallback(
    async (phoneE164: string, cidOverride?: string) => {
      if (!callUuid) return;
      setLoading(true);
      setError(null);
      try {
        await apiFetch(`/api/agent/call/${callUuid}/originate-third`, {
          method: "POST",
          body: { phone_e164: phoneE164, ...(cidOverride ? { cid_override: cidOverride } : {}) },
        });
        setPhase("transferring");
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to originate");
      } finally {
        setLoading(false);
      }
    },
    [callUuid, setPhase],
  );

  const leave = React.useCallback(async () => {
    if (!callUuid) return;
    setLoading(true);
    setError(null);
    try {
      await apiFetch(`/api/agent/call/${callUuid}/leave-3way`, {
        method: "POST",
        body: {},
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to leave");
    } finally {
      setLoading(false);
    }
  }, [callUuid]);

  return { participants, originate, leave, loading, error };
}
