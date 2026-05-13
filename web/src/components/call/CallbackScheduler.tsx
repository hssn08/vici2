"use client";

import * as React from "react";
import { useCallStore } from "@/lib/stores/call";
import { apiFetch } from "@/lib/api";

interface CallbackSchedulerProps {
  onClose: () => void;
  onSaved?: () => void;
}

function defaultCallbackTime(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  // Skip to Monday if weekend
  if (d.getDay() === 0) d.setDate(d.getDate() + 1);
  if (d.getDay() === 6) d.setDate(d.getDate() + 2);
  d.setHours(10, 0, 0, 0);
  // Format for datetime-local input
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function CallbackScheduler({ onClose, onSaved }: CallbackSchedulerProps): React.ReactElement {
  const lead = useCallStore((s) => s.lead);
  const notes = useCallStore((s) => s.notes);
  const [dateTime, setDateTime] = React.useState(defaultCallbackTime());
  const [mode, setMode] = React.useState<"me" | "anyone">("anyone");
  const [comments, setComments] = React.useState(notes.slice(0, 256));
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!lead?.id) return;
    setLoading(true);
    setError(null);
    try {
      await apiFetch(`/api/agent/lead/${lead.id}/callbacks`, {
        method: "POST",
        body: {
          callback_at: new Date(dateTime).toISOString(),
          ...(mode === "me" ? { user_id: "me" } : {}),
          comments,
        },
      });
      onSaved?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save callback");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-label="Schedule callback"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
    >
      <div className="w-96 rounded-lg border border-[var(--color-surface-border)] bg-[var(--color-surface-elevated)] p-6 shadow-xl">
        <h2 className="mb-4 text-lg font-semibold">Schedule Callback</h2>

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          <div>
            <label htmlFor="callback-datetime" className="mb-1 block text-sm font-medium">
              Date &amp; Time
            </label>
            <input
              id="callback-datetime"
              type="datetime-local"
              value={dateTime}
              onChange={(e) => setDateTime(e.target.value)}
              className="w-full rounded border border-[var(--color-surface-border)] bg-[var(--color-surface)] px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[var(--color-brand-600)]"
            />
          </div>

          <fieldset>
            <legend className="mb-1 text-sm font-medium">Assign to</legend>
            <div className="flex gap-4">
              <label className="flex items-center gap-1 text-sm cursor-pointer">
                <input
                  type="radio"
                  name="cb-mode"
                  value="me"
                  checked={mode === "me"}
                  onChange={() => setMode("me")}
                />
                Me only
              </label>
              <label className="flex items-center gap-1 text-sm cursor-pointer">
                <input
                  type="radio"
                  name="cb-mode"
                  value="anyone"
                  checked={mode === "anyone"}
                  onChange={() => setMode("anyone")}
                />
                Anyone
              </label>
            </div>
          </fieldset>

          <div>
            <label htmlFor="callback-comments" className="mb-1 block text-sm font-medium">
              Comments
            </label>
            <textarea
              id="callback-comments"
              rows={3}
              value={comments}
              onChange={(e) => setComments(e.target.value)}
              className="w-full resize-none rounded border border-[var(--color-surface-border)] bg-[var(--color-surface)] px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[var(--color-brand-600)]"
            />
          </div>

          {error && (
            <p role="alert" className="text-xs text-[var(--color-state-error)]">{error}</p>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
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
              {loading ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
