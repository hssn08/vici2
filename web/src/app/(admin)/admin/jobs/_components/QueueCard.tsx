'use client';
// W02 — Card for a single queue in the index grid.

import Link from 'next/link';
import { QueueKindBadge } from './QueueKindBadge';
import { QueueStatePill } from './QueueStatePill';
import { DlqDepthBadge } from './DlqDepthBadge';

interface QueueCounts {
  waiting: number | null;
  active: number | null;
  completed: number | null;
  failed: number | null;
  delayed: number | null;
  paused: number | null;
  depth: number | null;
  pending: number | null;
  lockHeld: boolean | null;
  lockHolder: string | null;
  lockTtlMs: number | null;
}

interface QueueSummary {
  name: string;
  displayName: string;
  kind: 'bullmq' | 'stream' | 'tick';
  owner: string;
  isPaused: boolean | null;
  counts: QueueCounts;
  dlqDepth: number;
  warning?: string;
}

interface Props {
  queue: QueueSummary;
}

export function QueueCard({ queue }: Props): React.ReactElement {
  const shortName = queue.name.split(':').pop() ?? queue.name;

  return (
    <article className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-sm hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <Link
            href={`/admin/jobs/${encodeURIComponent(shortName)}`}
            className="text-sm font-semibold text-[var(--color-fg)] hover:underline truncate block"
          >
            {queue.displayName}
          </Link>
          <p className="mt-0.5 text-xs text-[var(--color-fg-muted)] truncate">{queue.name}</p>
        </div>
        <div className="flex flex-shrink-0 items-center gap-1.5">
          <QueueKindBadge kind={queue.kind} />
          <span className="text-xs text-[var(--color-fg-muted)]">{queue.owner}</span>
        </div>
      </div>

      {/* State counts — BullMQ */}
      {queue.kind === 'bullmq' && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {queue.isPaused && (
            <span className="inline-flex items-center rounded bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-800">
              Paused
            </span>
          )}
          <QueueStatePill state="waiting" count={queue.counts.waiting} />
          <QueueStatePill state="active" count={queue.counts.active} />
          <QueueStatePill state="failed" count={queue.counts.failed} />
          <QueueStatePill state="delayed" count={queue.counts.delayed} />
        </div>
      )}

      {/* Stream queue stats */}
      {queue.kind === 'stream' && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          <span className="inline-flex items-center rounded bg-purple-50 px-2 py-0.5 text-xs text-purple-800">
            Depth: {queue.counts.depth ?? '—'}
          </span>
          <span className="inline-flex items-center rounded bg-purple-50 px-2 py-0.5 text-xs text-purple-800">
            Pending: {queue.counts.pending ?? '—'}
          </span>
        </div>
      )}

      {/* Tick queue stats */}
      {queue.kind === 'tick' && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          <span className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${queue.counts.lockHeld ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-700'}`}>
            {queue.counts.lockHeld ? `Running: ${queue.counts.lockHolder ?? '?'}` : 'Idle'}
          </span>
          {queue.counts.lockTtlMs != null && (
            <span className="text-xs text-[var(--color-fg-muted)]">
              TTL: {Math.round(queue.counts.lockTtlMs / 1000)}s
            </span>
          )}
        </div>
      )}

      {/* DLQ badge */}
      {queue.dlqDepth > 0 && (
        <div className="mt-3">
          <DlqDepthBadge
            depth={queue.dlqDepth}
            href={`/admin/jobs/dlq/${encodeURIComponent(shortName)}`}
          />
        </div>
      )}

      {/* Warning */}
      {queue.warning && (
        <p className="mt-2 text-xs text-amber-600" role="alert">
          Warning: {queue.warning}
        </p>
      )}
    </article>
  );
}
