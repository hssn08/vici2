'use client';
// W02 — Job actions: retry, remove, unmask toggle.

import { useState } from 'react';

interface Props {
  queue: string;
  jobId: string;
  state: string;
  isSuperAdmin: boolean;
  onUnmask?: () => void;
}

export function JobActionsCard({ queue, jobId, state, isSuperAdmin, onUnmask }: Props): React.ReactElement {
  const [retrying, setRetrying] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [retried, setRetried] = useState(false);
  const [removed, setRemoved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRetry() {
    setRetrying(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/jobs/queues/${encodeURIComponent(queue)}/jobs/${encodeURIComponent(jobId)}/retry`,
        { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      );
      if (!res.ok) {
        const d = (await res.json()) as { message?: string };
        throw new Error(d.message ?? 'Retry failed');
      }
      setRetried(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setRetrying(false);
    }
  }

  async function handleRemove() {
    if (!confirm(`Remove job ${jobId}? This cannot be undone.`)) return;
    setRemoving(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/jobs/queues/${encodeURIComponent(queue)}/jobs/${encodeURIComponent(jobId)}`,
        { method: 'DELETE', credentials: 'include' },
      );
      if (!res.ok && res.status !== 204) {
        const d = (await res.json()) as { message?: string };
        throw new Error(d.message ?? 'Remove failed');
      }
      setRemoved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setRemoving(false);
    }
  }

  if (removed) return <p className="text-sm text-green-600" role="status">Job removed.</p>;

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <h2 className="text-sm font-semibold text-[var(--color-fg)] mb-3">Actions</h2>
      <div className="flex flex-col gap-2">
        {state === 'failed' && !retried && (
          <button
            onClick={handleRetry}
            disabled={retrying}
            aria-busy={retrying}
            className="inline-flex justify-center items-center rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {retrying ? 'Retrying…' : 'Retry Job'}
          </button>
        )}
        {retried && (
          <p className="text-sm text-green-600" role="status">Retry queued. Job moved to waiting.</p>
        )}

        <button
          onClick={handleRemove}
          disabled={removing}
          aria-busy={removing}
          className="inline-flex justify-center items-center rounded-md border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50 transition-colors"
        >
          {removing ? 'Removing…' : 'Remove Job'}
        </button>

        {isSuperAdmin && onUnmask && (
          <button
            onClick={onUnmask}
            className="inline-flex justify-center items-center rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)] transition-colors"
            title="View unmasked job data (audited)"
          >
            Unmask Data
          </button>
        )}
      </div>
      {error && <p className="mt-2 text-sm text-red-600" role="alert">{error}</p>}
    </div>
  );
}
