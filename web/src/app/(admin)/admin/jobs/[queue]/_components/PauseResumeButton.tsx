'use client';
// W02 — Pause/Resume button for a BullMQ queue.

import { useState } from 'react';

interface Props {
  queue: string;
  initialPaused: boolean;
}

export function PauseResumeButton({ queue, initialPaused }: Props): React.ReactElement {
  const [isPaused, setIsPaused] = useState(initialPaused);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setLoading(true);
    setError(null);
    try {
      const action = isPaused ? 'resume' : 'pause';
      const res = await fetch(`/api/admin/jobs/queues/${encodeURIComponent(queue)}/${action}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!res.ok) {
        const data = (await res.json()) as { message?: string };
        throw new Error(data.message ?? 'Request failed');
      }
      setIsPaused(!isPaused);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <button
        onClick={handleClick}
        disabled={loading}
        aria-busy={loading}
        className="inline-flex items-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm font-medium text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)] disabled:opacity-50 transition-colors"
      >
        {loading ? 'Working…' : isPaused ? 'Resume Queue' : 'Pause Queue'}
      </button>
      {error && (
        <p className="mt-1 text-xs text-red-600" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
