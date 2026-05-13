'use client';
// W02 — Retry a single DLQ entry.

import { useState } from 'react';

interface Props {
  queue: string;
  entryId: string;
  onRetried?: (entryId: string) => void;
}

export function DlqRetryButton({ queue, entryId, onRetried }: Props): React.ReactElement {
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRetry() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/jobs/dlq/${encodeURIComponent(queue)}/${encodeURIComponent(entryId)}/retry`,
        { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      );
      if (!res.ok) {
        const d = (await res.json()) as { message?: string };
        throw new Error(d.message ?? 'Retry failed');
      }
      setDone(true);
      onRetried?.(entryId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }

  if (done) return <span className="text-xs text-green-600">Retried</span>;

  return (
    <div>
      <button
        onClick={handleRetry}
        disabled={loading}
        aria-busy={loading}
        className="inline-flex items-center rounded bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
      >
        {loading ? '…' : 'Retry'}
      </button>
      {error && <p className="mt-1 text-xs text-red-600" role="alert">{error}</p>}
    </div>
  );
}
