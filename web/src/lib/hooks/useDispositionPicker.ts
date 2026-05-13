"use client";

import * as React from "react";
import { useCallStore } from "@/lib/stores/call";
import { apiFetch } from "@/lib/api";

export interface StatusDef {
  code: string;
  label: string;
  hotkey: string | null;
  selectable: boolean;
  color?: string;
}

export interface UseDispositionPickerReturn {
  statuses: StatusDef[];
  selectedCode: string | null;
  select: (code: string) => void;
  submit: (opts?: { comments?: string; callbackAt?: string; callbackUserId?: number }) => Promise<void>;
  loading: boolean;
  error: string | null;
}

export function useDispositionPicker(): UseDispositionPickerReturn {
  const callUuid = useCallStore((s) => s.callUuid);
  const campaign = useCallStore((s) => s.campaign);
  const notes = useCallStore((s) => s.notes);
  const clearCall = useCallStore((s) => s.clearCall);

  const [statuses, setStatuses] = React.useState<StatusDef[]>([]);
  const [selectedCode, setSelectedCode] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Load statuses from campaign
  React.useEffect(() => {
    if (!campaign?.id) return;
    void apiFetch<StatusDef[]>(`/api/agent/campaign/${campaign.id}/statuses`)
      .then((data) => setStatuses(data.filter((s) => s.selectable)))
      .catch(() => {
        // Use default statuses if API unavailable
        setStatuses([
          { code: "SALE", label: "Sale", hotkey: "1", selectable: true },
          { code: "NI", label: "Not Interested", hotkey: "2", selectable: true },
          { code: "CALLBK", label: "Callback", hotkey: "3", selectable: true },
          { code: "DNC", label: "Do Not Call", hotkey: "4", selectable: true },
          { code: "NA", label: "No Answer", hotkey: "5", selectable: true },
        ]);
      });
  }, [campaign?.id]);

  const select = React.useCallback(
    (code: string) => {
      setSelectedCode(code);
      // If confirmHotkeyDispo is false, hotkey selection auto-submits (handled by caller)
    },
    [],
  );

  const submit = React.useCallback(
    async (opts?: { comments?: string; callbackAt?: string; callbackUserId?: number }) => {
      if (!callUuid || !selectedCode) return;
      setLoading(true);
      setError(null);
      try {
        await apiFetch("/api/agent/dispo", {
          method: "POST",
          body: {
            call_uuid: callUuid,
            status: selectedCode,
            comments: opts?.comments ?? notes,
            ...(opts?.callbackAt ? { callback_at: opts.callbackAt } : {}),
            ...(opts?.callbackUserId !== undefined
              ? { callback_user_id: opts.callbackUserId }
              : {}),
          },
        });
        clearCall();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Submission failed");
      } finally {
        setLoading(false);
      }
    },
    [callUuid, selectedCode, notes, clearCall],
  );

  return { statuses, selectedCode, select, submit, loading, error };
}
