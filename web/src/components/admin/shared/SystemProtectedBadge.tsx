// M07 — Lock icon badge for system-owned records that cannot be deleted.

import * as React from "react";

interface SystemProtectedBadgeProps {
  owner?: string | null;
}

export function SystemProtectedBadge({ owner }: SystemProtectedBadgeProps): React.ReactElement | null {
  if (!owner) return null;
  return (
    <span
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)] border border-[var(--color-border)]"
      title={`Protected by system module: ${owner}`}
      aria-label={`System protected by ${owner}`}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </svg>
      System
    </span>
  );
}
