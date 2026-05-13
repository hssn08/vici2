"use client";

// N01 — NotificationBell: bell icon with unread badge for TopBar.
// Click toggles the NotificationPanel dropdown.

import * as React from "react";
import { useNotifications } from "@/lib/hooks/useNotifications";
import { NotificationPanel } from "./NotificationPanel";
import { cn } from "@/lib/utils";

export function NotificationBell(): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const buttonRef = React.useRef<HTMLButtonElement>(null);

  const {
    items,
    unreadCount,
    loading,
    hasMore,
    markRead,
    markAllRead,
    dismiss,
    loadMore,
  } = useNotifications();

  // Close on outside click
  React.useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (
        panelRef.current &&
        !panelRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // Close on Escape
  React.useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const handleMarkAllRead = async () => {
    await markAllRead();
  };

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={`Notifications${unreadCount > 0 ? ` — ${unreadCount} unread` : ""}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={cn(
          "relative flex h-9 w-9 items-center justify-center rounded-md",
          "text-[var(--color-fg-muted)] hover:text-[var(--color-fg-default)]",
          "hover:bg-[var(--color-surface-muted)] transition-colors",
          open && "bg-[var(--color-surface-muted)] text-[var(--color-fg-default)]",
        )}
      >
        {/* Bell icon */}
        <svg
          width="18"
          height="18"
          viewBox="0 0 18 18"
          fill="none"
          aria-hidden="true"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M9 2a5.25 5.25 0 0 0-5.25 5.25c0 2.5-.75 4-1.5 5.25h13.5c-.75-1.25-1.5-2.75-1.5-5.25A5.25 5.25 0 0 0 9 2Z" />
          <path d="M6.75 12.75A2.25 2.25 0 0 0 11.25 12.75" />
        </svg>

        {/* Unread badge */}
        {unreadCount > 0 && (
          <span
            aria-hidden="true"
            className={cn(
              "absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1",
              "bg-[var(--color-state-error)] text-[10px] font-bold text-white leading-none",
            )}
          >
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div ref={panelRef}>
          <NotificationPanel
            items={items}
            hasMore={hasMore}
            loading={loading}
            onMarkAllRead={() => void handleMarkAllRead()}
            onMarkRead={markRead}
            onDismiss={dismiss}
            onLoadMore={loadMore}
            onClose={() => setOpen(false)}
          />
        </div>
      )}
    </div>
  );
}
