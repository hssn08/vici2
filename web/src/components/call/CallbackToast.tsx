"use client";

// A08 — CallbackToast: hook that shows persistent due-callback toasts with
// "Dial now" / "Snooze 30m" / "Dismiss" action buttons.

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/toast";
import { formatCallbackTime } from "@/lib/types/callbacks";
import type { DueCallbackData } from "@/lib/types/callbacks";
import { useCallbacks } from "@/lib/hooks/useCallbacks";

export function useCallbackToast() {
  const { toast, dismiss } = useToast();
  const router = useRouter();
  const { snooze } = useCallbacks();
  const agentTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const showDueToast = useCallback(
    (cb: DueCallbackData): string => {
      const formattedTime = formatCallbackTime(cb.callback_at, agentTz);

      // We need the id before we can reference it in the action closures,
      // so we use a ref trick: store id in a mutable box.
      let resolvedId = "";

      const id = toast({
        title: `Callback Due: ${cb.lead_name}`,
        description: `${cb.phone} — ${formattedTime}`,
        tone: "warning",
        duration: 0, // persistent
        actions: [
          {
            label: "Dial now",
            variant: "primary",
            onClick: () => {
              dismiss(resolvedId);
              const params = new URLSearchParams({
                lead_id: cb.lead_id,
                callback_id: cb.callback_id,
                phone: cb.phone,
              });
              router.push(`/call?${params}`);
            },
          },
          {
            label: "Snooze 30m",
            variant: "secondary",
            onClick: () => {
              dismiss(resolvedId);
              void snooze(
                cb.callback_id,
                new Date(Date.now() + 30 * 60_000).toISOString(),
              );
            },
          },
          {
            label: "Dismiss",
            variant: "secondary",
            onClick: () => {
              dismiss(resolvedId);
            },
          },
        ],
      });

      resolvedId = id;
      return id;
    },
    [toast, dismiss, router, snooze, agentTz],
  );

  return { showDueToast };
}
