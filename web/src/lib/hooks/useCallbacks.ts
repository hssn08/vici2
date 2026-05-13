"use client";

// A08 — useCallbacks: list fetch, snooze, cancel with optimistic updates.

import { useState, useEffect, useCallback } from "react";
import { apiFetch, ApiError } from "@/lib/api";
import { mapApiError } from "@/lib/types/callbacks";
import type { Callback } from "@/lib/types/callbacks";

export type { Callback };

interface UseCallbacksReturn {
  callbacks: Callback[];
  loading: boolean;
  hasMore: boolean;
  nextCursor: string | null;
  error: string | null;
  loadMore: () => void;
  refresh: () => void;
  snooze: (id: string, callbackAt: string, comments?: string) => Promise<void>;
  cancel: (id: string) => Promise<void>;
}

export function useCallbacks(): UseCallbacksReturn {
  const [callbacks, setCallbacks] = useState<Callback[]>([]);
  const [loading, setLoading] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchPage = useCallback(async (cursor?: string) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: "50" });
      if (cursor) params.set("cursor", cursor);
      const data = await apiFetch<{
        callbacks: Callback[];
        next_cursor: string | null;
      }>(`/api/agent/callbacks/mine?${params}`);
      setCallbacks((prev) =>
        cursor ? [...prev, ...data.callbacks] : data.callbacks,
      );
      setNextCursor(data.next_cursor);
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? mapApiError(err.code)
          : err instanceof Error
            ? err.message
            : "Failed to load callbacks";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    void fetchPage();
  }, [fetchPage]);

  const refresh = useCallback(() => {
    void fetchPage();
  }, [fetchPage]);

  const loadMore = useCallback(() => {
    if (nextCursor && !loading) {
      void fetchPage(nextCursor);
    }
  }, [nextCursor, loading, fetchPage]);

  const snooze = useCallback(
    async (id: string, callbackAt: string, comments?: string) => {
      // Optimistic update
      setCallbacks((prev) =>
        prev.map((c) => (c.id === id ? { ...c, callback_at: callbackAt, status: "PENDING" } : c)),
      );
      try {
        await apiFetch(`/api/agent/callbacks/${id}/snooze`, {
          method: "POST",
          body: {
            callback_at: callbackAt,
            ...(comments !== undefined ? { comments } : {}),
          },
        });
      } catch (err) {
        // Revert on error
        void fetchPage();
        const msg =
          err instanceof ApiError
            ? mapApiError(err.code)
            : "Failed to snooze callback";
        throw new Error(msg);
      }
    },
    [fetchPage],
  );

  const cancel = useCallback(
    async (id: string) => {
      // Optimistic removal
      setCallbacks((prev) => prev.filter((c) => c.id !== id));
      try {
        await apiFetch(`/api/agent/callbacks/${id}/cancel`, { method: "POST" });
      } catch (err) {
        // Revert on error
        void fetchPage();
        const msg =
          err instanceof ApiError
            ? mapApiError(err.code)
            : "Failed to cancel callback";
        throw new Error(msg);
      }
    },
    [fetchPage],
  );

  return {
    callbacks,
    loading,
    hasMore: nextCursor !== null,
    nextCursor,
    error,
    loadMore,
    refresh,
    snooze,
    cancel,
  };
}
