'use client';
// W02 — Drain DLQ stream confirmation dialog.
// Typed confirmation required: "drain dlq {queue}"

import { useState } from 'react';

interface Props {
  queue: string;
}

export function DlqDrainDialog({ queue }: Props): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ drained: boolean; entriesRemoved: number } | null>(null);

  const expectedConfirm = `drain dlq ${queue}`;
  const canConfirm = confirmText === expectedConfirm;

  async function handleDrain() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/jobs/dlq/${encodeURIComponent(queue)}`, {
        method: 'DELETE',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: expectedConfirm }),
      });
      if (!res.ok) {
        const d = (await res.json()) as { message?: string };
        throw new Error(d.message ?? 'Drain failed');
      }
      const data = (await res.json()) as { drained: boolean; entriesRemoved: number };
      setResult(data);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }

  if (result) {
    return (
      <p className="text-sm text-green-600 font-medium" role="status">
        DLQ drained: {result.entriesRemoved} entries removed.
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
        Drain All DLQ
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="dlq-drain-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
        >
          <div className="w-full max-w-md rounded-lg bg-[var(--color-surface)] p-6 shadow-xl">
            <h2 id="dlq-drain-title" className="text-lg font-semibold text-[var(--color-fg)]">
              Drain DLQ: {queue}
            </h2>
            <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
              This permanently removes all entries from the dead-letter queue stream.
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
            {error && <p className="mt-2 text-sm text-red-600" role="alert">{error}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setOpen(false)} className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)] transition-colors">
                Cancel
              </button>
              <button
                onClick={handleDrain}
                disabled={!canConfirm || loading}
                aria-busy={loading}
                className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50 transition-colors"
              >
                {loading ? 'Draining…' : 'Drain DLQ'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
