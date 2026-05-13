'use client';
// W02 — DLQ entry table with expandable rows and retry buttons.

import { useState } from 'react';
import { DlqRetryButton } from './DlqRetryButton';

interface DlqEntry {
  entryId: string;
  ts: number;
  worker: string;
  sourceQueue: string;
  sourceId: string;
  payload: Record<string, unknown>;
  error: string;
  errorStack: string;
  attempt: number;
  workerId: string;
  tenantId: string;
  _masked: boolean;
}

interface Props {
  queue: string;
  initialEntries: DlqEntry[];
  total: number;
  nextCursor: string | null;
  streamName: string;
}

export function DlqEntryTable({ queue, initialEntries, total, nextCursor: initialCursor, streamName }: Props): React.ReactElement {
  const [entries, setEntries] = useState<DlqEntry[]>(initialEntries);
  const [nextCursor, setNextCursor] = useState(initialCursor);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function handleRetried(entryId: string) {
    setEntries((prev) => prev.filter((e) => e.entryId !== entryId));
  }

  async function loadMore() {
    if (!nextCursor) return;
    setLoading(true);
    try {
      const res = await fetch(
        `/api/admin/jobs/dlq/${encodeURIComponent(queue)}?cursor=${encodeURIComponent(nextCursor)}&order=desc`,
        { credentials: 'include' },
      );
      if (res.ok) {
        const data = (await res.json()) as { entries: DlqEntry[]; nextCursor: string | null };
        setEntries((prev) => [...prev, ...data.entries]);
        setNextCursor(data.nextCursor);
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <div className="mb-2 text-xs text-[var(--color-fg-muted)]">
        Stream: <code className="font-mono">{streamName}</code> · {total} total entries
      </div>

      <div className="overflow-x-auto rounded-lg border border-[var(--color-border)]">
        <table className="w-full text-sm">
          <thead className="bg-[var(--color-surface-muted)]">
            <tr>
              {['Entry ID', 'Timestamp', 'Worker', 'Source ID', 'Error', 'Attempts', 'Actions'].map((h) => (
                <th key={h} scope="col" className="px-3 py-2 text-left text-xs font-semibold text-[var(--color-fg-muted)]">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            {entries.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-[var(--color-fg-muted)]">
                  No DLQ entries.
                </td>
              </tr>
            ) : (
              entries.map((entry) => (
                <>
                  <tr
                    key={entry.entryId}
                    className="hover:bg-[var(--color-surface-muted)] cursor-pointer"
                    onClick={() => toggleExpand(entry.entryId)}
                    aria-expanded={expanded.has(entry.entryId)}
                  >
                    <td className="px-3 py-2 font-mono text-xs">{entry.entryId.slice(0, 14)}…</td>
                    <td className="px-3 py-2 text-xs">{new Date(entry.ts).toLocaleString()}</td>
                    <td className="px-3 py-2 text-xs">{entry.worker}</td>
                    <td className="px-3 py-2 font-mono text-xs">{entry.sourceId.slice(0, 10)}…</td>
                    <td className="px-3 py-2 text-xs text-red-600 max-w-xs truncate" title={entry.error}>
                      {entry.error.slice(0, 60)}
                    </td>
                    <td className="px-3 py-2 text-center text-xs">{entry.attempt}</td>
                    <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                      <DlqRetryButton queue={queue} entryId={entry.entryId} onRetried={handleRetried} />
                    </td>
                  </tr>
                  {expanded.has(entry.entryId) && (
                    <tr key={`${entry.entryId}-detail`}>
                      <td colSpan={7} className="px-4 py-3 bg-[var(--color-surface-muted)]">
                        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                          <div>
                            <p className="text-xs font-semibold text-[var(--color-fg-muted)] mb-1">Payload {entry._masked && '(masked)'}</p>
                            <pre className="overflow-x-auto rounded bg-[var(--color-surface)] p-2 text-xs font-mono">
                              {JSON.stringify(entry.payload, null, 2)}
                            </pre>
                          </div>
                          <div>
                            <p className="text-xs font-semibold text-[var(--color-fg-muted)] mb-1">Error Stack</p>
                            <pre className="overflow-x-auto rounded bg-[var(--color-surface)] p-2 text-xs font-mono text-red-600">
                              {entry.errorStack || entry.error}
                            </pre>
                          </div>
                        </div>
                        <p className="mt-2 text-xs text-[var(--color-fg-muted)]">
                          Worker ID: {entry.workerId} · Tenant: {entry.tenantId} · Source Queue: {entry.sourceQueue}
                        </p>
                      </td>
                    </tr>
                  )}
                </>
              ))
            )}
          </tbody>
        </table>
      </div>

      {nextCursor && (
        <div className="mt-4 text-center">
          <button
            onClick={loadMore}
            disabled={loading}
            className="rounded-md border border-[var(--color-border)] px-4 py-2 text-sm text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)] disabled:opacity-50 transition-colors"
          >
            {loading ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  );
}
