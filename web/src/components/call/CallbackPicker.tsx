"use client";

// A08 — CallbackPicker: modal for scheduling a callback from the dispo screen.

import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCallbackPicker } from "@/lib/hooks/useCallbackPicker";
import { formatLeadLocalTime, localDateTimeToIso } from "@/lib/types/callbacks";
import type { Callback } from "@/lib/types/callbacks";
import { useToast } from "@/components/ui/toast";

export interface CallbackPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leadId: string;
  leadName: string;
  phoneE164: string;
  campaignId: string;
  leadTzIana: string | null;
  onSuccess?: (callback: Callback) => void;
}

export function CallbackPicker({
  open,
  onOpenChange,
  leadId,
  leadName,
  phoneE164,
  campaignId,
  leadTzIana,
  onSuccess,
}: CallbackPickerProps): React.ReactElement {
  const { toast } = useToast();
  const dtInputRef = React.useRef<HTMLInputElement>(null);

  const handleSuccess = React.useCallback(
    (cb: Callback) => {
      toast({ title: "Callback scheduled", tone: "success", duration: 3000 });
      onSuccess?.(cb);
      onOpenChange(false);
    },
    [toast, onSuccess, onOpenChange],
  );

  const {
    dateTime,
    setDateTime,
    scope,
    setScope,
    comments,
    setComments,
    tcpaWarning,
    tcpaResponse,
    loading,
    error,
    submit,
    reset,
  } = useCallbackPicker({
    leadId,
    campaignId,
    leadTzIana,
    leadName,
    onSuccess: handleSuccess,
  });

  // Focus datetime input when dialog opens
  React.useEffect(() => {
    if (open) {
      const t = setTimeout(() => dtInputRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
    // Reset form when dialog closes
    if (!open) reset();
  }, [open, reset]);

  const agentTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  // Compute lead local time preview
  const leadLocalTime = React.useMemo(() => {
    if (!dateTime || !leadTzIana) return null;
    try {
      return formatLeadLocalTime(localDateTimeToIso(dateTime), leadTzIana);
    } catch {
      return null;
    }
  }, [dateTime, leadTzIana]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await submit();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Schedule Callback</DialogTitle>
        </DialogHeader>

        {/* Lead context */}
        <div className="mb-4 rounded-md bg-[var(--color-surface-muted)] px-4 py-2 text-sm">
          <span className="font-medium">{leadName || "Unknown"}</span>
          {phoneE164 && (
            <span className="ml-2 text-[var(--color-fg-muted)]">{phoneE164}</span>
          )}
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          {/* Date & time */}
          <div>
            <label
              htmlFor="cb-picker-datetime"
              className="mb-1 block text-sm font-medium"
            >
              Date &amp; Time{" "}
              <span className="text-xs font-normal text-[var(--color-fg-muted)]">
                (your timezone: {agentTz})
              </span>
            </label>
            <input
              ref={dtInputRef}
              id="cb-picker-datetime"
              type="datetime-local"
              value={dateTime}
              onChange={(e) => setDateTime(e.target.value)}
              required
              className="w-full rounded border border-[var(--color-surface-border)] bg-[var(--color-surface)] px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[var(--color-brand-600)]"
            />
            {/* Lead's local time preview */}
            {leadLocalTime && (
              <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
                Lead&apos;s local time: {leadLocalTime}
              </p>
            )}
          </div>

          {/* TCPA warning banner (advisory) */}
          {tcpaWarning && (
            <div
              role="status"
              className="flex items-start gap-2 rounded-md border border-amber-400 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-600 dark:bg-amber-900/20 dark:text-amber-300"
            >
              <span>⚠</span>
              <span>
                Outside TCPA calling window (8am–9pm lead time). You may still
                schedule, but calling at this time may violate TCPA regulations.
              </span>
            </div>
          )}

          {/* Post-submit TCPA response */}
          {tcpaResponse && !tcpaResponse.allowed && (
            <div
              role="status"
              className="flex items-start gap-2 rounded-md border border-amber-400 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-600 dark:bg-amber-900/20 dark:text-amber-300"
            >
              <span>⚠</span>
              <span>
                Server flagged this time as outside the TCPA calling window.
              </span>
            </div>
          )}

          {/* Scope */}
          <fieldset>
            <legend className="mb-1 text-sm font-medium">Assign to</legend>
            <div className="flex gap-4">
              <label className="flex cursor-pointer items-center gap-1.5 text-sm">
                <input
                  type="radio"
                  name="cb-scope"
                  value="me"
                  checked={scope === "me"}
                  onChange={() => setScope("me")}
                />
                Me only
              </label>
              <label className="flex cursor-pointer items-center gap-1.5 text-sm">
                <input
                  type="radio"
                  name="cb-scope"
                  value="anyone"
                  checked={scope === "anyone"}
                  onChange={() => setScope("anyone")}
                />
                Anyone
              </label>
            </div>
          </fieldset>

          {/* Comments */}
          <div>
            <label
              htmlFor="cb-picker-comments"
              className="mb-1 block text-sm font-medium"
            >
              Comments{" "}
              <span className="text-xs font-normal text-[var(--color-fg-muted)]">
                (optional)
              </span>
            </label>
            <textarea
              id="cb-picker-comments"
              rows={3}
              maxLength={255}
              value={comments}
              onChange={(e) => setComments(e.target.value)}
              className="w-full resize-none rounded border border-[var(--color-surface-border)] bg-[var(--color-surface)] px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[var(--color-brand-600)]"
            />
            <p className="mt-0.5 text-right text-xs text-[var(--color-fg-muted)]">
              {comments.length}/255
            </p>
          </div>

          {/* Error */}
          {error && (
            <p role="alert" className="text-xs text-[var(--color-state-error)]">
              {error}
            </p>
          )}

          {/* Footer */}
          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="rounded px-4 py-2 text-sm hover:bg-[var(--color-surface-muted)]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              aria-disabled={loading}
              className="rounded bg-[var(--color-brand-600)] px-4 py-2 text-sm text-white hover:bg-[var(--color-brand-700)] disabled:opacity-50"
            >
              {loading ? "Scheduling…" : "Schedule"}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
