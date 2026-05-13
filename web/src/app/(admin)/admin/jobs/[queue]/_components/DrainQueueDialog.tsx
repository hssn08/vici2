'use client';
// W02 — Drain queue confirmation dialog.
// Typed confirmation required: "drain {displayName}"

import { useState } from 'react';

interface Props {
  queue: string;       // short name for API
  displayName: string; // for confirmation string
}

export function DrainQueueDialog({ queue, displayName }: Props): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [delayed, setDelayed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const expectedConfirm = `drain ${displayName}`;
  const canConfirm = confirmText === expectedConfirm;

  async function handleDrain() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/jobs/queues/${encodeURIComponent(queue)}/drain?delayed=${delayed}`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirm: expectedConfirm }),
        },
      );
      if (!res.ok) {
        const data = (await res.json()) as { message?: string };
        throw new Error(data.message ?? 'Drain failed');
      }
      setSuccess(true);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }

  if (success) {
    return (
      <p className="text-sm text-green-600 font-medium" role="status">
        Queue drained successfully.
      </p>
    );
  }

  return (
    <>
      <button
        onClick={() => { setOpen(true); setConfirmText(''); setError(null); }}
        className="inline-flex items-center rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 transition-colors"
        aria-haspopup="dialog"
      >
        Drain Queue
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="drain-dialog-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
        >
          <div className="w-full max-w-md rounded-lg bg-[var(--color-surface)] p-6 shadow-xl">
            <h2 id="drain-dialog-title" className="text-lg font-semibold text-[var(--color-fg)]">
              Drain queue: {displayName}
            </h2>
            <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
              This removes all waiting (and optionally delayed) jobs. Active and failed jobs are not affected.
            </p>
            <p className="mt-3 text-sm font-medium text-[var(--color-fg)]">
              Type <strong>{expectedConfirm}</strong> to confirm:
            </p>
            <input
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={expectedConfirm}
              className="mt-2 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-red-500"
              aria-label="Confirmation text"
              autoFocus
            />
            <div className="mt-3 flex items-center gap-2">
              <input
                id="include-delayed"
                type="checkbox"
                checked={delayed}
                onChange={(e) => setDelayed(e.target.checked)}
                className="h-4 w-4"
              />
              <label htmlFor="include-delayed" className="text-sm text-[var(--color-fg)]">
                Also drain delayed jobs
              </label>
            </div>
            {error && (
              <p className="mt-2 text-sm text-red-600" role="alert">{error}</p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setOpen(false)}
                className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)] transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleDrain}
                disabled={!canConfirm || loading}
                aria-busy={loading}
                className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50 transition-colors"
              >
                {loading ? 'Draining…' : 'Drain'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
