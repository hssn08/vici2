"use client";
// N04 — Sync history card

import type { SyncJob } from "../page";

interface Props {
  jobs: SyncJob[];
  onSyncNow: () => void;
  onFullResync: () => void;
  onRefresh: () => void;
}

const STATUS_COLORS: Record<string, string> = {
  running: "bg-blue-100 text-blue-700",
  completed: "bg-green-100 text-green-700",
  failed: "bg-red-100 text-red-700",
  cancelled: "bg-gray-100 text-gray-700",
};

function formatDuration(start: string, end?: string): string {
  if (!end) return "–";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60000)}m`;
}

export function SyncHistoryCard({ jobs, onSyncNow, onFullResync, onRefresh }: Props): React.ReactElement {
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-base font-semibold text-[var(--color-fg)]">Sync History</h2>
        <div className="flex items-center gap-2">
          <button
            onClick={onRefresh}
            className="rounded border border-[var(--color-border)] px-3 py-1 text-xs text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-2)] transition-colors"
          >
            Refresh
          </button>
          <button
            onClick={onSyncNow}
            className="rounded border border-[var(--color-brand-600)] px-3 py-1 text-xs font-medium text-[var(--color-brand-600)] hover:bg-[var(--color-brand-50)] transition-colors"
          >
            Sync Now
          </button>
          <button
            onClick={onFullResync}
            className="rounded border border-red-300 px-3 py-1 text-xs font-medium text-red-600 hover:bg-red-50 transition-colors"
          >
            Full Resync
          </button>
        </div>
      </div>

      {jobs.length === 0 ? (
        <p className="text-sm text-[var(--color-fg-muted)]">No sync jobs yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--color-border)]">
              <th className="py-2 pr-4 text-left font-medium text-[var(--color-fg-muted)]">Status</th>
              <th className="py-2 pr-4 text-left font-medium text-[var(--color-fg-muted)]">Mode</th>
              <th className="py-2 pr-4 text-right font-medium text-[var(--color-fg-muted)]">Fetched</th>
              <th className="py-2 pr-4 text-right font-medium text-[var(--color-fg-muted)]">Upserted</th>
              <th className="py-2 pr-4 text-right font-medium text-[var(--color-fg-muted)]">Failed</th>
              <th className="py-2 pr-4 text-left font-medium text-[var(--color-fg-muted)]">Duration</th>
              <th className="py-2 text-left font-medium text-[var(--color-fg-muted)]">Started</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={job.id} className="border-b border-[var(--color-border)] last:border-0">
                <td className="py-2 pr-4">
                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[job.status] ?? "bg-gray-100 text-gray-700"}`}>
                    {job.status}
                  </span>
                </td>
                <td className="py-2 pr-4 text-xs text-[var(--color-fg-muted)]">{job.syncMode}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{job.contactsFetched}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{job.contactsUpserted}</td>
                <td className="py-2 pr-4 text-right tabular-nums text-red-600">{job.contactsFailed}</td>
                <td className="py-2 pr-4 text-xs text-[var(--color-fg-muted)]">{formatDuration(job.startedAt, job.completedAt)}</td>
                <td className="py-2 text-xs text-[var(--color-fg-muted)]">
                  {new Date(job.startedAt).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
