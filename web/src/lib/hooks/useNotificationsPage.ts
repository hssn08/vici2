"use client";

/**
 * A07 — useNotificationsPage
 * Extended notifications hook for the full /agent/notifications page.
 * Supports category, severity, read/unread, date-range filters with cursor pagination.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { apiFetch } from "@/lib/api";
import type { NotificationItem } from "./useNotifications";

export type ReadFilter = "all" | "unread" | "read";

export interface NotificationsPageFilters {
  category: string | null;
  severity: "info" | "warning" | "error" | null;
  readFilter: ReadFilter;
  dateFrom: string | null;
  dateTo: string | null;
}

export const DEFAULT_FILTERS: NotificationsPageFilters = {
  category: null,
  severity: null,
  readFilter: "all",
  dateFrom: null,
  dateTo: null,
};

const STORAGE_KEY = "a07:notif-filters";

function loadFilters(): NotificationsPageFilters {
  if (typeof sessionStorage === "undefined") return DEFAULT_FILTERS;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_FILTERS;
    return { ...DEFAULT_FILTERS, ...(JSON.parse(raw) as Partial<NotificationsPageFilters>) };
  } catch {
    return DEFAULT_FILTERS;
  }
}

function saveFilters(filters: NotificationsPageFilters): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(filters));
  } catch {
    // ignore quota errors
  }
}

interface NotificationsPage {
  items: NotificationItem[];
  nextCursor: string | null;
  unreadCount: number;
}

export function useNotificationsPage() {
  const [filters, setFiltersState] = useState<NotificationsPageFilters>(loadFilters);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  const setFilters = useCallback((updated: Partial<NotificationsPageFilters>) => {
    setFiltersState((prev) => {
      const next = { ...prev, ...updated };
      saveFilters(next);
      return next;
    });
  }, []);

  const clearFilters = useCallback(() => {
    saveFilters(DEFAULT_FILTERS);
    setFiltersState(DEFAULT_FILTERS);
  }, []);

  const buildParams = useCallback(
    (cursor?: string): string => {
      const f = filtersRef.current;
      const p = new URLSearchParams({ limit: "40" });
      if (cursor) p.set("cursor", cursor);
      if (f.category) p.set("category", f.category);
      if (f.severity) p.set("severity", f.severity);
      if (f.readFilter !== "all") p.set("read", f.readFilter === "read" ? "true" : "false");
      if (f.dateFrom) p.set("dateFrom", f.dateFrom);
      if (f.dateTo) p.set("dateTo", f.dateTo);
      return p.toString();
    },
    [],
  );

  const fetchPage = useCallback(async (cursor?: string) => {
    setLoading(true);
    try {
      const qs = buildParams(cursor);
      const data = await apiFetch<NotificationsPage>(`/api/notifications?${qs}`);
      setItems((prev) => (cursor ? [...prev, ...data.items] : data.items));
      setNextCursor(data.nextCursor);
      setUnreadCount(data.unreadCount);
    } catch (err) {
      console.error("[notif-page] fetch failed", err);
    } finally {
      setLoading(false);
    }
  }, [buildParams]);

  // Re-fetch from top when filters change.
  // `fetchPage` is stable (memoised), so it is safe to include in deps.
  useEffect(() => {
    setItems([]);
    setNextCursor(null);
    void fetchPage();
  }, [filters, fetchPage]);

  const loadMore = useCallback(() => {
    if (nextCursor && !loading) void fetchPage(nextCursor);
  }, [nextCursor, loading, fetchPage]);

  const markRead = useCallback(async (id: string) => {
    try {
      await apiFetch(`/api/notifications/${id}/read`, { method: "PATCH" });
      setItems((prev) =>
        prev.map((n) => (n.id === id ? { ...n, readAt: new Date().toISOString() } : n)),
      );
      setUnreadCount((n) => Math.max(0, n - 1));
    } catch (err) {
      console.error("[notif-page] markRead failed", err);
    }
  }, []);

  const markAllRead = useCallback(async () => {
    try {
      await apiFetch<{ marked: number }>("/api/notifications/read-all", { method: "POST" });
      const now = new Date().toISOString();
      setItems((prev) => prev.map((n) => (n.readAt ? n : { ...n, readAt: now })));
      setUnreadCount(0);
    } catch (err) {
      console.error("[notif-page] markAllRead failed", err);
    }
  }, []);

  const dismiss = useCallback(async (id: string) => {
    try {
      await apiFetch(`/api/notifications/${id}`, { method: "DELETE" });
      setItems((prev) => {
        const removed = prev.find((n) => n.id === id);
        if (removed && !removed.readAt) setUnreadCount((n) => Math.max(0, n - 1));
        return prev.filter((n) => n.id !== id);
      });
    } catch (err) {
      console.error("[notif-page] dismiss failed", err);
    }
  }, []);

  return {
    items,
    unreadCount,
    loading,
    hasMore: nextCursor !== null,
    filters,
    setFilters,
    clearFilters,
    loadMore,
    markRead,
    markAllRead,
    dismiss,
    refresh: () => {
      setItems([]);
      setNextCursor(null);
      void fetchPage();
    },
  };
}
