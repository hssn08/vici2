"use client";

// N01 — NotificationPanel: dropdown panel shown when the bell is clicked.
// Lists in-app notifications with read/dismiss actions and a "Mark all read" header.

import * as React from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import type { NotificationItem } from "@/lib/hooks/useNotifications";

interface NotificationPanelProps {
  items: NotificationItem[];
  hasMore: boolean;
  loading: boolean;
  onMarkAllRead: () => void;
  onMarkRead: (id: string) => void;
  onDismiss: (id: string) => void;
  onLoadMore: () => void;
  onClose: () => void;
}

const SEVERITY_COLORS: Record<string, string> = {
  info: "bg-[var(--color-state-idle)]",
  warning: "bg-[var(--color-state-hold)]",
  error: "bg-[var(--color-state-error)]",
};

function timeAgo(dateStr: string): string {
  const diff = (Date.now() - new Date(dateStr).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function NotificationPanel({
  items,
  hasMore,
  loading,
  onMarkAllRead,
  onMarkRead,
  onDismiss,
  onLoadMore,
  onClose,
}: NotificationPanelProps): React.ReactElement {
  const router = useRouter();

  const handleItemClick = (item: NotificationItem) => {
    if (!item.readAt) {
      onMarkRead(item.id);
    }
    if (item.link) {
      router.push(item.link);
    }
    onClose();
  };

  return (
    <div
      role="dialog"
      aria-label="Notifications"
      className={cn(
        "absolute right-0 top-full z-50 mt-1 w-96 rounded-lg border border-[var(--color-surface-border)]",
        "bg-[var(--color-surface-elevated)] shadow-lg",
        "flex flex-col max-h-[480px]",
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--color-surface-border)] px-4 py-3">
        <span className="text-sm font-semibold">Notifications</span>
        <button
          type="button"
          onClick={onMarkAllRead}
          className="text-xs text-[var(--color-fg-muted)] hover:text-[var(--color-fg-default)] transition-colors"
        >
          Mark all read
        </button>
      </div>

      {/* Items */}
      <div className="flex-1 overflow-y-auto">
        {items.length === 0 && !loading && (
          <div className="px-4 py-8 text-center text-sm text-[var(--color-fg-muted)]">
            No notifications
          </div>
        )}

        {items.map((item) => (
          <div
            key={item.id}
            className={cn(
              "group relative flex items-start gap-3 px-4 py-3 border-b border-[var(--color-surface-border)]",
              "cursor-pointer hover:bg-[var(--color-surface-muted)] transition-colors",
              !item.readAt && "bg-[var(--color-surface-selected)]",
            )}
            onClick={() => handleItemClick(item)}
            onKeyDown={(e) => { if (e.key === "Enter") handleItemClick(item); }}
            tabIndex={0}
            role="button"
            aria-label={item.subject}
          >
            {/* Severity dot */}
            <span
              className={cn(
                "mt-1.5 h-2 w-2 flex-shrink-0 rounded-full",
                SEVERITY_COLORS[item.severity] ?? SEVERITY_COLORS.info,
              )}
              aria-hidden="true"
            />

            {/* Content */}
            <div className="flex-1 min-w-0">
              <p className={cn("text-sm font-medium truncate", !item.readAt && "text-[var(--color-fg-default)]", item.readAt && "text-[var(--color-fg-muted)]")}>
                {item.subject}
              </p>
              <p className="mt-0.5 text-xs text-[var(--color-fg-muted)] line-clamp-2">
                {item.body}
              </p>
              <p className="mt-1 text-[10px] text-[var(--color-fg-subtle)]">
                {timeAgo(item.createdAt)}
              </p>
            </div>

            {/* Dismiss button */}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onDismiss(item.id); }}
              aria-label="Dismiss notification"
              className={cn(
                "ml-1 flex-shrink-0 rounded p-0.5 text-[var(--color-fg-muted)]",
                "opacity-0 group-hover:opacity-100 hover:bg-[var(--color-surface-muted)] transition",
              )}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" fill="currentColor">
                <path d="M2.22 2.22a.75.75 0 0 1 1.06 0L6 4.94l2.72-2.72a.75.75 0 1 1 1.06 1.06L7.06 6l2.72 2.72a.75.75 0 1 1-1.06 1.06L6 7.06 3.28 9.78a.75.75 0 0 1-1.06-1.06L4.94 6 2.22 3.28a.75.75 0 0 1 0-1.06Z" />
              </svg>
            </button>
          </div>
        ))}

        {loading && (
          <div className="px-4 py-3 text-center text-xs text-[var(--color-fg-muted)]">
            Loading...
          </div>
        )}

        {hasMore && !loading && (
          <button
            type="button"
            onClick={onLoadMore}
            className="w-full px-4 py-3 text-xs text-center text-[var(--color-fg-muted)] hover:text-[var(--color-fg-default)] hover:bg-[var(--color-surface-muted)] transition-colors"
          >
            Load more
          </button>
        )}
      </div>
    </div>
  );
}
