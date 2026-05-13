"use client";

// A08 — CallbackList: agent's own callback list with snooze/cancel support.

import * as React from "react";
import { useCallbacks } from "@/lib/hooks/useCallbacks";
import { CallbackRow } from "./CallbackRow";

function SkeletonRow(): React.ReactElement {
  return (
    <tr className="border-b border-[var(--color-surface-border)]">
      {[...Array(4)].map((_, i) => (
        <td key={i} className="py-3 px-4">
          <div className="h-4 animate-pulse rounded bg-[var(--color-surface-muted)]" />
        </td>
      ))}
    </tr>
  );
}

export function CallbackListClient(): React.ReactElement {
  const { callbacks, loading, hasMore, error, loadMore, refresh, snooze, cancel } =
    useCallbacks();

  const pending = callbacks.filter((c) => c.status === "PENDING").length;
  const live = callbacks.filter((c) => c.status === "LIVE").length;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">My Callbacks</h1>
          {callbacks.length > 0 && (
            <p className="mt-0.5 text-sm text-[var(--color-fg-muted)]">
              {pending} pending
              {live > 0 && `, ${live} due soon`}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="rounded border border-[var(--color-surface-border)] px-3 py-1.5 text-sm hover:bg-[var(--color-surface-muted)] disabled:opacity-50"
        >
          Refresh
        </button>
      </div>

      {/* Error */}
      {error && (
        <div
          role="alert"
          className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-700 dark:bg-red-900/20 dark:text-red-400"
        >
          {error}
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto rounded-md border border-[var(--color-surface-border)]">
        <table className="w-full text-left text-sm">
          <thead className="bg-[var(--color-surface-muted)] text-xs font-semibold uppercase tracking-wide text-[var(--color-fg-muted)]">
            <tr>
              <th className="py-2 px-4">Lead</th>
              <th className="py-2 px-4">Scheduled</th>
              <th className="py-2 px-4">Status</th>
              <th className="py-2 px-4">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && callbacks.length === 0 ? (
              <>
                <SkeletonRow />
                <SkeletonRow />
                <SkeletonRow />
              </>
            ) : callbacks.length === 0 ? (
              <tr>
                <td
                  colSpan={4}
                  className="py-10 text-center text-sm text-[var(--color-fg-muted)]"
                >
                  No callbacks scheduled.
                </td>
              </tr>
            ) : (
              callbacks.map((cb) => (
                <CallbackRow
                  key={cb.id}
                  callback={cb}
                  onSnooze={snooze}
                  onCancel={cancel}
                />
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Load more */}
      {hasMore && (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={loadMore}
            disabled={loading}
            className="rounded border border-[var(--color-surface-border)] px-4 py-2 text-sm hover:bg-[var(--color-surface-muted)] disabled:opacity-50"
          >
            {loading ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}
