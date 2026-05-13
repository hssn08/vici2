"use client";

/**
 * web/src/components/recordings/RecordingsTable.tsx
 *
 * Recordings list table with filter bar, cursor pagination, and actions.
 * R03 PLAN §3.2.
 */

import * as React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RecordingsFilterBar } from "./RecordingsFilterBar";
import {
  type RecordingFilters,
  type RecordingListItem,
  formatDuration,
  formatBytes,
  lifecycleStateBadge,
} from "./types";
import { env } from "@/lib/env";

interface RecordingsTableProps {
  /** Base path for detail links, e.g. "/sup/recordings" or "/admin/recordings" */
  basePath: string;
}

interface FetchState {
  recordings: RecordingListItem[];
  nextCursor: string | null;
  totalHint: number | null;
  isLoading: boolean;
  isLoadingMore: boolean;
  error: string | null;
}

const DEFAULT_FILTERS: RecordingFilters = {};

export function RecordingsTable({ basePath }: RecordingsTableProps): React.ReactElement {
  const [filters, setFilters] = useState<RecordingFilters>(DEFAULT_FILTERS);
  const [state, setState] = useState<FetchState>({
    recordings: [],
    nextCursor: null,
    totalHint: null,
    isLoading: false,
    isLoadingMore: false,
    error: null,
  });

  // Track filter identity for cancellation
  const filterIdRef = useRef(0);

  const fetchRecordings = useCallback(async (
    currentFilters: RecordingFilters,
    afterId: string | null,
    append: boolean,
  ) => {
    const myId = ++filterIdRef.current;
    setState((prev) => ({
      ...prev,
      isLoading: !append,
      isLoadingMore: append,
      error: null,
    }));

    try {
      const params = new URLSearchParams();
      if (afterId) params.set("after_id", afterId);
      params.set("limit", "50");
      for (const [k, v] of Object.entries(currentFilters)) {
        if (v) params.set(k, v);
      }

      const res = await fetch(`${env.NEXT_PUBLIC_API_URL}/api/recordings?${params.toString()}`, {
        credentials: "include",
        headers: { "Accept": "application/json" },
      });

      if (myId !== filterIdRef.current) return; // stale

      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        setState((prev) => ({
          ...prev,
          isLoading: false,
          isLoadingMore: false,
          error: body.error ?? `HTTP ${res.status}`,
        }));
        return;
      }

      const data = (await res.json()) as { recordings: RecordingListItem[]; next_cursor: string | null; total_hint: number | null };
      setState((prev) => ({
        recordings: append ? [...prev.recordings, ...data.recordings] : data.recordings,
        nextCursor: data.next_cursor,
        totalHint: data.total_hint ?? prev.totalHint,
        isLoading: false,
        isLoadingMore: false,
        error: null,
      }));
    } catch (err) {
      if (myId !== filterIdRef.current) return;
      setState((prev) => ({
        ...prev,
        isLoading: false,
        isLoadingMore: false,
        error: err instanceof Error ? err.message : "Network error",
      }));
    }
  }, []);

  // Fetch on filter change
  useEffect(() => {
    void fetchRecordings(filters, null, false);
  }, [filters, fetchRecordings]);

  function handleLoadMore(): void {
    if (state.nextCursor) {
      void fetchRecordings(filters, state.nextCursor, true);
    }
  }

  function handleDownload(rec: RecordingListItem): void {
    // Fetch pre-signed URL with max TTL and trigger browser download
    const url = `${env.NEXT_PUBLIC_API_URL}/api/recordings/${rec.id}/url?ttl=3600`;
    fetch(url, { credentials: "include" })
      .then((res) => res.json() as Promise<{ url?: string }>)
      .then((data) => {
        if (data.url) {
          const a = document.createElement("a");
          a.href = data.url;
          a.download = `recording-${rec.call_uuid}.wav`;
          a.click();
        }
      })
      .catch(console.error);
  }

  const { recordings, isLoading, isLoadingMore, error, nextCursor, totalHint } = state;

  return (
    <div className="space-y-4">
      <RecordingsFilterBar
        filters={filters}
        onChange={(f) => setFilters(f)}
        onReset={() => setFilters(DEFAULT_FILTERS)}
        isLoading={isLoading}
      />

      {/* Summary row */}
      {totalHint !== null && (
        <p className="text-sm text-[var(--color-fg-muted)]">
          {totalHint.toLocaleString()} recording{totalHint !== 1 ? "s" : ""} found
          {recordings.length < totalHint && ` (showing ${recordings.length})`}
        </p>
      )}

      {/* Error */}
      {error && (
        <div className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-700 border border-red-200">
          {error}
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-[var(--color-surface-muted)] text-left">
            <tr>
              <th className="px-4 py-3 font-medium">Start time</th>
              <th className="px-4 py-3 font-medium">Duration</th>
              <th className="px-4 py-3 font-medium">Campaign</th>
              <th className="px-4 py-3 font-medium">Agent</th>
              <th className="px-4 py-3 font-medium">Phone</th>
              <th className="px-4 py-3 font-medium">Transcript</th>
              <th className="px-4 py-3 font-medium">State</th>
              <th className="px-4 py-3 font-medium">Size</th>
              <th className="px-4 py-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={i} className="animate-pulse">
                  {Array.from({ length: 9 }).map((__, j) => (
                    <td key={j} className="px-4 py-3">
                      <div className="h-4 w-full rounded bg-[var(--color-surface-muted)]" />
                    </td>
                  ))}
                </tr>
              ))
            ) : recordings.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-4 py-10 text-center text-[var(--color-fg-muted)]">
                  No recordings found.{" "}
                  {Object.values(filters).some(Boolean) && (
                    <button
                      className="underline"
                      onClick={() => setFilters(DEFAULT_FILTERS)}
                    >
                      Clear filters
                    </button>
                  )}
                </td>
              </tr>
            ) : (
              recordings.map((rec) => {
                const badge = lifecycleStateBadge(rec.lifecycle_state);
                return (
                  <tr key={rec.id} className="hover:bg-[var(--color-surface-muted)] transition-colors">
                    <td className="px-4 py-3 whitespace-nowrap font-mono text-xs">
                      {new Date(rec.start_time).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap tabular-nums">
                      {formatDuration(rec.duration_sec)}
                    </td>
                    <td className="px-4 py-3 max-w-[12rem] truncate">
                      {rec.campaign_name ?? rec.campaign_id ?? "—"}
                    </td>
                    <td className="px-4 py-3 max-w-[12rem] truncate">
                      {rec.agent_name ?? rec.agent_id ?? "—"}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">
                      {rec.lead_phone ?? "—"}
                    </td>
                    <td className="px-4 py-3">
                      {rec.has_transcript ? (
                        <Badge tone="success">Yes</Badge>
                      ) : (
                        <Badge tone="neutral">No</Badge>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={badge.tone}>
                        {badge.label}
                        {rec.has_legal_hold && " 🔒"}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 tabular-nums text-xs">
                      {formatBytes(rec.size_bytes)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Link
                          href={`${basePath}/${rec.id}`}
                          className="text-[var(--color-brand-600)] hover:underline text-xs font-medium"
                        >
                          Listen
                        </Link>
                        <button
                          className="text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] text-xs"
                          onClick={() => handleDownload(rec)}
                          title="Download WAV (1 h presigned URL)"
                        >
                          Download
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Load more */}
      {nextCursor && (
        <div className="flex justify-center pt-2">
          <Button
            variant="secondary"
            size="md"
            onClick={handleLoadMore}
            disabled={isLoadingMore}
          >
            {isLoadingMore ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
    </div>
  );
}
