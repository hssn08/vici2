"use client";

// A08 — CallbackRow: single row in the callback list.

import * as React from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  formatCallbackTime,
  formatLeadLocalTime,
  maskPhone,
  isOutsideTcpaWindow,
} from "@/lib/types/callbacks";
import type { Callback } from "@/lib/types/callbacks";
import { SnoozeMenu } from "./SnoozeMenu";
import { useToast } from "@/components/ui/toast";

interface CallbackRowProps {
  callback: Callback;
  onSnooze: (id: string, callbackAt: string, comments?: string) => Promise<void>;
  onCancel: (id: string) => Promise<void>;
}

const STATUS_CLASSES: Record<string, string> = {
  PENDING:
    "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  LIVE: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  DONE: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  DEAD: "bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]",
};

export function CallbackRow({
  callback,
  onSnooze,
  onCancel,
}: CallbackRowProps): React.ReactElement {
  const router = useRouter();
  const { toast } = useToast();
  const [snoozeOpen, setSnoozeOpen] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);
  const [cancelling, setCancelling] = React.useState(false);

  const agentTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const tcpaWarn =
    callback.lead_tz_iana != null
      ? isOutsideTcpaWindow(callback.callback_at, callback.lead_tz_iana)
      : false;

  const handleDialNow = () => {
    const params = new URLSearchParams({
      lead_id: callback.lead_id,
      callback_id: callback.id,
    });
    if (callback.lead_phone) {
      params.set("phone", callback.lead_phone);
    }
    router.push(`/call?${params}`);
  };

  const handleSnooze = async (callbackAt: string, comments?: string) => {
    await onSnooze(callback.id, callbackAt, comments);
    const formatted = formatCallbackTime(callbackAt, agentTz);
    toast({ title: `Snoozed until ${formatted}`, tone: "success", duration: 3000 });
  };

  const handleCancel = async () => {
    setCancelling(true);
    try {
      await onCancel(callback.id);
      toast({ title: "Callback cancelled", tone: "neutral", duration: 3000 });
    } catch (err) {
      toast({
        title: err instanceof Error ? err.message : "Failed to cancel",
        tone: "danger",
        duration: 4000,
      });
      setConfirming(false);
    } finally {
      setCancelling(false);
    }
  };

  return (
    <tr className="border-b border-[var(--color-surface-border)] hover:bg-[var(--color-surface-muted)]">
      {/* Lead */}
      <td className="py-3 px-4">
        <p className="text-sm font-medium">
          {callback.lead_name ?? "Unknown"}
        </p>
        <p className="text-xs text-[var(--color-fg-muted)]">
          {maskPhone(callback.lead_phone)}
        </p>
      </td>

      {/* Scheduled time */}
      <td className="py-3 px-4">
        <p className="text-sm">{formatCallbackTime(callback.callback_at, agentTz)}</p>
        {callback.lead_tz_iana && (
          <p className="text-xs text-[var(--color-fg-muted)]">
            Lead: {formatLeadLocalTime(callback.callback_at, callback.lead_tz_iana)}
          </p>
        )}
      </td>

      {/* Status / TCPA badge */}
      <td className="py-3 px-4">
        <span
          className={cn(
            "inline-flex rounded-full px-2 py-0.5 text-xs font-semibold",
            STATUS_CLASSES[callback.status] ?? STATUS_CLASSES.DEAD,
          )}
        >
          {callback.status}
        </span>
        {tcpaWarn && (
          <span className="ml-1 inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
            TCPA
          </span>
        )}
      </td>

      {/* Actions */}
      <td className="py-3 px-4">
        <div className="relative flex flex-wrap items-center gap-2">
          {callback.status === "LIVE" && (
            <button
              type="button"
              onClick={handleDialNow}
              className="rounded bg-[var(--color-brand-600)] px-3 py-1 text-xs text-white hover:bg-[var(--color-brand-700)]"
            >
              Dial now
            </button>
          )}

          {/* Snooze */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setSnoozeOpen((v) => !v)}
              className="rounded border border-[var(--color-surface-border)] px-3 py-1 text-xs hover:bg-[var(--color-surface-muted)]"
              aria-haspopup="true"
              aria-expanded={snoozeOpen}
            >
              Snooze
            </button>
            <SnoozeMenu
              callbackId={callback.id}
              comments={callback.comments}
              onSnooze={handleSnooze}
              open={snoozeOpen}
              onOpenChange={setSnoozeOpen}
            />
          </div>

          {/* Cancel / confirm */}
          {!confirming ? (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="rounded px-3 py-1 text-xs text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)]"
            >
              Cancel
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => void handleCancel()}
                disabled={cancelling}
                className="rounded bg-red-600 px-3 py-1 text-xs text-white hover:bg-red-700 disabled:opacity-50"
              >
                {cancelling ? "Cancelling…" : "Confirm"}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="rounded px-3 py-1 text-xs text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)]"
              >
                No
              </button>
            </>
          )}
        </div>
      </td>
    </tr>
  );
}
