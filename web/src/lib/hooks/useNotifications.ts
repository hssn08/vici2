"use client";

// N01 — useNotifications hook.
// Manages in-app notification state: fetch, WS subscription, read/dismiss actions.

import { useState, useEffect, useCallback, useRef } from "react";
import { apiFetch } from "@/lib/api";
import { useWsStore } from "@/lib/stores/ws";

export interface NotificationItem {
  id: string;
  channel: "in_app" | "email";
  category: string;
  subject: string;
  body: string;
  severity: "info" | "warning" | "error";
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

interface NotificationsPage {
  items: NotificationItem[];
  nextCursor: string | null;
  unreadCount: number;
}

export function useNotifications() {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const wsConnection = useWsStore((s) => s.connection);
  const wsRef = useRef<WebSocket | null>(null);

  const fetchNotifications = useCallback(async (cursor?: string) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "20" });
      if (cursor) params.set("cursor", cursor);

      const data = await apiFetch<NotificationsPage>(`/api/notifications?${params}`);
      setItems((prev) => cursor ? [...prev, ...data.items] : data.items);
      setNextCursor(data.nextCursor);
      setUnreadCount(data.unreadCount);
    } catch (err) {
      console.error("[notifications] fetch failed", err);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch
  useEffect(() => {
    void fetchNotifications();
  }, [fetchNotifications]);

  // WS subscription for real-time notifications
  useEffect(() => {
    // Only subscribe when WS is open — reuse existing WS connection via message event
    const handler = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data as string) as { type: string; notification?: NotificationItem };
        if (msg.type === "notifications.new" && msg.notification) {
          const notif = msg.notification;
          if (notif.channel === "in_app") {
            setItems((prev) => [notif, ...prev]);
            setUnreadCount((n) => n + 1);
          }
        }
      } catch {
        // ignore non-JSON messages
      }
    };

    // Attach to existing page-level WS if available
    const ws = wsRef.current;
    if (ws) {
      ws.addEventListener("message", handler);
      return () => ws.removeEventListener("message", handler);
    }
  }, [wsConnection]);

  const markRead = useCallback(async (id: string) => {
    try {
      await apiFetch(`/api/notifications/${id}/read`, { method: "PATCH" });
      setItems((prev) =>
        prev.map((n) => n.id === id ? { ...n, readAt: new Date().toISOString() } : n),
      );
      setUnreadCount((n) => Math.max(0, n - 1));
    } catch (err) {
      console.error("[notifications] markRead failed", err);
    }
  }, []);

  const markAllRead = useCallback(async () => {
    try {
      const result = await apiFetch<{ marked: number }>("/api/notifications/read-all", { method: "POST" });
      const now = new Date().toISOString();
      setItems((prev) =>
        prev.map((n) => n.readAt ? n : { ...n, readAt: now }),
      );
      setUnreadCount(0);
      return result.marked;
    } catch (err) {
      console.error("[notifications] markAllRead failed", err);
      return 0;
    }
  }, []);

  const dismiss = useCallback(async (id: string) => {
    try {
      await apiFetch(`/api/notifications/${id}`, { method: "DELETE" });
      setItems((prev) => {
        const removed = prev.find((n) => n.id === id);
        if (removed && !removed.readAt) {
          setUnreadCount((n) => Math.max(0, n - 1));
        }
        return prev.filter((n) => n.id !== id);
      });
    } catch (err) {
      console.error("[notifications] dismiss failed", err);
    }
  }, []);

  const loadMore = useCallback(() => {
    if (nextCursor && !loading) {
      void fetchNotifications(nextCursor);
    }
  }, [nextCursor, loading, fetchNotifications]);

  return {
    items,
    unreadCount,
    loading,
    hasMore: nextCursor !== null,
    markRead,
    markAllRead,
    dismiss,
    loadMore,
    refresh: () => void fetchNotifications(),
  };
}
