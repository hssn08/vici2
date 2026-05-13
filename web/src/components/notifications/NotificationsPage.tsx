"use client";

/**
 * A07 — NotificationsPage
 * Full-page notifications view at /agent/notifications.
 * Filters: category, severity, read/unread, date range.
 * Cursor-paginated with infinite scroll.
 */

import * as React from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useNotificationsPage, type ReadFilter } from "@/lib/hooks/useNotificationsPage";
import type { NotificationItem } from "@/lib/hooks/useNotifications";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SEVERITY_COLORS: Record<string, string> = {
  info: "bg-[var(--color-state-idle)]",
  warning: "bg-[var(--color-state-hold)]",
  error: "bg-[var(--color-state-error)]",
};

const SEVERITY_BADGE: Record<string, string> = {
  info: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  warning: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
  error: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
};

function timeAgo(dateStr: string): string {
  const diff = (Date.now() - new Date(dateStr).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// ---------------------------------------------------------------------------
// NotificationRow
// ---------------------------------------------------------------------------

interface NotificationRowProps {
  item: NotificationItem;
  onMarkRead: (id: string) => void;
  onDismiss: (id: string) => void;
}

function NotificationRow({ item, onMarkRead, onDismiss }: NotificationRowProps) {
  return (
    <article
      className={cn(
        "group flex items-start gap-4 border-b border-[var(--color-surface-border)] px-6 py-4",
        "hover:bg-[var(--color-surface-muted)] transition-colors",
        !item.readAt && "bg-[var(--color-surface-selected)]",
      )}
      aria-label={item.subject}
    >
      {/* Severity dot */}
      <span
        className={cn(
          "mt-1.5 h-2.5 w-2.5 flex-shrink-0 rounded-full",
          SEVERITY_COLORS[item.severity] ?? SEVERITY_COLORS.info,
        )}
        aria-hidden="true"
      />

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p className={cn(
            "text-sm font-medium",
            !item.readAt ? "text-[var(--color-fg-default)]" : "text-[var(--color-fg-muted)]",
          )}>
            {item.subject}
          </p>
          <span className={cn(
            "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
            SEVERITY_BADGE[item.severity] ?? SEVERITY_BADGE.info,
          )}>
            {item.severity}
          </span>
          {item.category && (
            <span className="inline-flex items-center rounded-full bg-[var(--color-surface-muted)] px-2 py-0.5 text-xs text-[var(--color-fg-muted)]">
              {item.category}
            </span>
          )}
        </div>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">{item.body}</p>
        <div className="mt-1.5 flex items-center gap-3">
          <time
            dateTime={item.createdAt}
            className="text-xs text-[var(--color-fg-subtle)]"
          >
            {timeAgo(item.createdAt)}
          </time>
          {item.link && (
            <Link
              href={item.link}
              className="text-xs text-[var(--color-accent)] hover:underline"
              onClick={() => { if (!item.readAt) onMarkRead(item.id); }}
            >
              View details
            </Link>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex flex-shrink-0 items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
        {!item.readAt && (
          <button
            type="button"
            onClick={() => onMarkRead(item.id)}
            aria-label="Mark as read"
            className={cn(
              "rounded px-2 py-1 text-xs text-[var(--color-fg-muted)]",
              "hover:bg-[var(--color-surface-border)] hover:text-[var(--color-fg-default)] transition-colors",
            )}
          >
            Mark read
          </button>
        )}
        <button
          type="button"
          onClick={() => onDismiss(item.id)}
          aria-label="Dismiss notification"
          className={cn(
            "flex h-7 w-7 items-center justify-center rounded",
            "text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-border)]",
            "hover:text-[var(--color-fg-default)] transition-colors",
          )}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
            <path d="M2.22 2.22a.75.75 0 0 1 1.06 0L6 4.94l2.72-2.72a.75.75 0 1 1 1.06 1.06L7.06 6l2.72 2.72a.75.75 0 1 1-1.06 1.06L6 7.06 3.28 9.78a.75.75 0 0 1-1.06-1.06L4.94 6 2.22 3.28a.75.75 0 0 1 0-1.06Z" />
          </svg>
        </button>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// FilterBar
// ---------------------------------------------------------------------------

interface FilterBarProps {
  filters: ReturnType<typeof useNotificationsPage>["filters"];
  setFilters: ReturnType<typeof useNotificationsPage>["setFilters"];
  clearFilters: () => void;
  categories: string[];
}

function FilterBar({ filters, setFilters, clearFilters, categories }: FilterBarProps) {
  const hasActive =
    filters.category ||
    filters.severity ||
    filters.readFilter !== "all" ||
    filters.dateFrom ||
    filters.dateTo;

  return (
    <div
      className="flex flex-wrap items-end gap-3 border-b border-[var(--color-surface-border)] px-6 py-4"
      role="search"
      aria-label="Filter notifications"
    >
      {/* Category */}
      <div className="flex flex-col gap-1">
        <label
          htmlFor="notif-category"
          className="text-xs font-medium text-[var(--color-fg-muted)]"
        >
          Category
        </label>
        <select
          id="notif-category"
          value={filters.category ?? ""}
          onChange={(e) => setFilters({ category: e.target.value || null })}
          className={cn(
            "h-9 rounded-md border bg-[var(--color-surface)] px-2 text-sm",
            "text-[var(--color-fg-default)] transition-colors",
          )}
        >
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </div>

      {/* Severity */}
      <fieldset className="flex flex-col gap-1">
        <legend className="text-xs font-medium text-[var(--color-fg-muted)]">Severity</legend>
        <div className="flex gap-1.5">
          {(["all", "info", "warning", "error"] as const).map((sev) => (
            <button
              key={sev}
              type="button"
              aria-pressed={sev === "all" ? !filters.severity : filters.severity === sev}
              onClick={() => setFilters({ severity: sev === "all" ? null : sev })}
              className={cn(
                "rounded-full px-3 py-1 text-xs font-medium capitalize transition-colors",
                (sev === "all" ? !filters.severity : filters.severity === sev)
                  ? "bg-[var(--color-accent)] text-white"
                  : "bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg-default)]",
              )}
            >
              {sev === "all" ? "All" : sev}
            </button>
          ))}
        </div>
      </fieldset>

      {/* Read/Unread */}
      <fieldset className="flex flex-col gap-1">
        <legend className="text-xs font-medium text-[var(--color-fg-muted)]">Status</legend>
        <div className="flex gap-1.5">
          {(["all", "unread", "read"] as ReadFilter[]).map((rf) => (
            <button
              key={rf}
              type="button"
              aria-pressed={filters.readFilter === rf}
              onClick={() => setFilters({ readFilter: rf })}
              className={cn(
                "rounded-full px-3 py-1 text-xs font-medium capitalize transition-colors",
                filters.readFilter === rf
                  ? "bg-[var(--color-accent)] text-white"
                  : "bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg-default)]",
              )}
            >
              {rf === "all" ? "All" : rf}
            </button>
          ))}
        </div>
      </fieldset>

      {/* Date range */}
      <div className="flex items-end gap-2">
        <div className="flex flex-col gap-1">
          <label htmlFor="notif-date-from" className="text-xs font-medium text-[var(--color-fg-muted)]">
            From
          </label>
          <Input
            id="notif-date-from"
            type="date"
            value={filters.dateFrom ?? ""}
            onChange={(e) => setFilters({ dateFrom: e.target.value || null })}
            className="h-9 w-36 text-sm"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="notif-date-to" className="text-xs font-medium text-[var(--color-fg-muted)]">
            To
          </label>
          <Input
            id="notif-date-to"
            type="date"
            value={filters.dateTo ?? ""}
            onChange={(e) => setFilters({ dateTo: e.target.value || null })}
            className="h-9 w-36 text-sm"
          />
        </div>
      </div>

      {/* Clear */}
      {hasActive && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={clearFilters}
          className="self-end text-[var(--color-fg-muted)]"
        >
          Clear filters
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// NotificationsPage
// ---------------------------------------------------------------------------

export function NotificationsPage(): React.ReactElement {
  const {
    items,
    unreadCount,
    loading,
    hasMore,
    filters,
    setFilters,
    clearFilters,
    loadMore,
    markRead,
    markAllRead,
    dismiss,
  } = useNotificationsPage();

  // Derive unique categories from current items
  const categories = React.useMemo(() => {
    const cats = new Set<string>();
    for (const item of items) {
      if (item.category) cats.add(item.category);
    }
    return Array.from(cats).sort();
  }, [items]);

  // Infinite scroll via IntersectionObserver
  const sentinelRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasMore && !loading) {
          loadMore();
        }
      },
      { threshold: 0.1 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loading, loadMore]);

  return (
    <div className="mx-auto max-w-3xl">
      {/* Page header */}
      <div className="flex items-center justify-between pb-6">
        <div>
          <h1 className="text-xl font-semibold text-[var(--color-fg-default)]">
            Notifications
          </h1>
          {unreadCount > 0 && (
            <p className="mt-0.5 text-sm text-[var(--color-fg-muted)]">
              {unreadCount} unread
            </p>
          )}
        </div>
        <div className="flex items-center gap-3">
          {unreadCount > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void markAllRead()}
            >
              Mark all read
            </Button>
          )}
          <Link
            href="/agent/settings?tab=notifications"
            className="text-sm text-[var(--color-fg-muted)] hover:text-[var(--color-fg-default)] transition-colors"
          >
            Preferences
          </Link>
        </div>
      </div>

      {/* Card */}
      <div className="rounded-[var(--radius-card)] border border-[var(--color-surface-border)] bg-[var(--color-surface-elevated)] shadow-sm">
        {/* Filters */}
        <FilterBar
          filters={filters}
          setFilters={setFilters}
          clearFilters={clearFilters}
          categories={categories}
        />

        {/* List */}
        <div role="feed" aria-label="Notifications" aria-busy={loading}>
          {items.length === 0 && !loading && (
            <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
              <svg
                width="48"
                height="48"
                viewBox="0 0 48 48"
                fill="none"
                aria-hidden="true"
                className="text-[var(--color-fg-muted)] opacity-40"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <path d="M24 6a13 13 0 0 0-13 13c0 6-2 9.5-3.5 12h33C39 28.5 37 25 37 19a13 13 0 0 0-13-13Z" />
                <path d="M19 31a5 5 0 0 0 10 0" />
              </svg>
              <p className="text-sm text-[var(--color-fg-muted)]">
                No notifications match your current filters.
              </p>
            </div>
          )}

          {items.map((item) => (
            <NotificationRow
              key={item.id}
              item={item}
              onMarkRead={markRead}
              onDismiss={dismiss}
            />
          ))}

          {/* Infinite scroll sentinel */}
          <div ref={sentinelRef} aria-hidden="true" />

          {loading && (
            <div
              className="px-6 py-4 text-center text-sm text-[var(--color-fg-muted)]"
              aria-live="polite"
            >
              Loading…
            </div>
          )}

          {!hasMore && items.length > 0 && !loading && (
            <div className="px-6 py-4 text-center text-xs text-[var(--color-fg-subtle)]">
              All notifications loaded
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
