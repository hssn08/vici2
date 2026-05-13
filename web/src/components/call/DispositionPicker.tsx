"use client";

import * as React from "react";
import { useCallStore } from "@/lib/stores/call";
import { useUiStore } from "@/lib/stores/ui";
import { useDispositionPicker } from "@/lib/hooks/useDispositionPicker";
import { useWrapupTimer } from "@/lib/hooks/useWrapupTimer";
import { useHangupGrace } from "@/lib/hooks/useHangupGrace";
import { cn } from "@/lib/utils";

interface WrapupTimerDisplayProps {
  secondsLeft: number;
  total: number;
}

function WrapupTimerDisplay({ secondsLeft, total }: WrapupTimerDisplayProps): React.ReactElement {
  const pct = total > 0 ? (secondsLeft / total) * 100 : 0;
  const urgent = secondsLeft <= 10;

  return (
    <div
      aria-live="polite"
      aria-label={`Wrapup time remaining: ${secondsLeft} seconds`}
      className={cn(
        "flex items-center gap-2 text-sm font-mono",
        urgent ? "text-yellow-500 font-bold" : "text-[var(--color-fg-muted)]",
      )}
    >
      <span>
        {String(Math.floor(secondsLeft / 60)).padStart(2, "0")}:
        {String(secondsLeft % 60).padStart(2, "0")}
      </span>
      <div className="h-1.5 w-16 rounded-full bg-[var(--color-surface-muted)]">
        <div
          className={cn(
            "h-full rounded-full transition-all",
            urgent ? "bg-yellow-500" : "bg-[var(--color-brand-600)]",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export function DispositionPicker(): React.ReactElement | null {
  const phase = useCallStore((s) => s.phase);
  const notes = useCallStore((s) => s.notes);
  const campaign = useCallStore((s) => s.campaign);
  const { graceActive, cancelHangup } = useHangupGrace();
  const confirmHotkeyDispo = useUiStore((s) => s.confirmHotkeyDispo);

  const {
    statuses,
    selectedCode,
    select,
    submit,
    loading,
    error,
  } = useDispositionPicker();

  const [comments, setComments] = React.useState("");
  const [callbackChecked, setCallbackChecked] = React.useState(false);
  const [callbackAt, setCallbackAt] = React.useState("");

  const total = campaign?.wrapup_seconds ?? 60;
  const { secondsLeft, resetTimer } = useWrapupTimer();

  // Focus first tile on mount
  const firstTileRef = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    if (phase === "wrapup") {
      setTimeout(() => firstTileRef.current?.focus(), 50);
    }
  }, [phase]);

  // Pre-fill comments from notes
  React.useEffect(() => {
    if (phase === "wrapup") setComments(notes);
  // intentionally only runs on phase change to pre-fill from store on wrapup entry
  }, [phase]);

  if (phase !== "wrapup") return null;

  const handleHotkeySelect = async (code: string) => {
    select(code);
    if (!confirmHotkeyDispo) {
      await submit({ comments, callbackAt: callbackChecked ? callbackAt : undefined });
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCode) return;
    await submit({ comments, callbackAt: callbackChecked ? callbackAt : undefined });
  };

  const handleSkip = async () => {
    select("NA");
    await submit({ comments: `${comments}\n[skip]`.trim() });
  };

  const sortedStatuses = [...statuses].sort((a, b) => {
    if (a.hotkey && b.hotkey) return a.hotkey.localeCompare(b.hotkey);
    if (a.hotkey) return -1;
    if (b.hotkey) return 1;
    return 0;
  });

  return (
    <section
      aria-label="Disposition"
      className="absolute inset-0 z-30 overflow-auto bg-[var(--color-surface)] p-6"
    >
      <div className="mx-auto max-w-2xl">
        {/* Header */}
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold uppercase tracking-wide">Disposition</h2>
          <WrapupTimerDisplay secondsLeft={secondsLeft} total={total} />
        </div>

        {/* Status grid */}
        <div className="mb-6 grid grid-cols-4 gap-2 sm:grid-cols-5">
          {sortedStatuses.map((s, idx) => (
            <button
              key={s.code}
              ref={idx === 0 ? firstTileRef : undefined}
              aria-pressed={selectedCode === s.code}
              onClick={() => void handleHotkeySelect(s.code)}
              className={cn(
                "flex flex-col items-center gap-1 rounded-lg border p-3 text-sm transition-all",
                selectedCode === s.code
                  ? "border-[var(--color-brand-600)] bg-[var(--color-brand-600)] text-white"
                  : "border-[var(--color-surface-border)] bg-[var(--color-surface-muted)] hover:bg-[var(--color-surface-elevated)]",
              )}
            >
              {s.hotkey && (
                <span className={cn(
                  "rounded px-1.5 py-0.5 text-xs font-bold",
                  selectedCode === s.code ? "bg-white/20" : "bg-[var(--color-surface-border)]",
                )}>
                  {s.hotkey}
                </span>
              )}
              <span className="font-semibold text-xs">{s.code}</span>
              <span className="text-[10px] text-center leading-tight opacity-80">{s.label}</span>
            </button>
          ))}
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          {/* Comments */}
          <div>
            <label htmlFor="dispo-comments" className="mb-1 block text-sm font-medium">
              Notes
            </label>
            <textarea
              id="dispo-comments"
              rows={4}
              value={comments}
              onChange={(e) => { setComments(e.target.value); resetTimer(); }}
              className="w-full resize-none rounded border border-[var(--color-surface-border)] bg-[var(--color-surface)] px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[var(--color-brand-600)]"
            />
          </div>

          {/* Callback */}
          <div>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={callbackChecked}
                onChange={(e) => setCallbackChecked(e.target.checked)}
              />
              Schedule callback
            </label>
            {callbackChecked && (
              <div className="mt-2 flex items-center gap-3">
                <input
                  type="datetime-local"
                  value={callbackAt}
                  onChange={(e) => setCallbackAt(e.target.value)}
                  aria-label="Callback date and time"
                  className="rounded border border-[var(--color-surface-border)] bg-[var(--color-surface)] px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[var(--color-brand-600)]"
                />
              </div>
            )}
          </div>

          {error && (
            <p role="alert" className="text-xs text-[var(--color-state-error)]">{error}</p>
          )}

          {/* Footer actions */}
          <div className="flex items-center justify-end gap-3 pt-2">
            {graceActive && (
              <button
                type="button"
                onClick={cancelHangup}
                className="rounded border border-[var(--color-brand-600)] px-4 py-2 text-sm text-[var(--color-brand-600)] hover:bg-[var(--color-surface-muted)]"
              >
                Cancel &amp; resume
              </button>
            )}
            <button
              type="button"
              onClick={() => void handleSkip()}
              disabled={loading}
              className="rounded px-4 py-2 text-sm text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)]"
            >
              Skip
            </button>
            <button
              type="submit"
              disabled={loading || !selectedCode}
              aria-disabled={loading || !selectedCode}
              className="rounded bg-[var(--color-brand-600)] px-4 py-2 text-sm text-white hover:bg-[var(--color-brand-700)] disabled:opacity-50"
            >
              {loading ? "Submitting…" : "Submit ⏎"}
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
