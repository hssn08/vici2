// M07 — Animated skeleton table placeholder.

import * as React from "react";

interface TableSkeletonProps {
  rows?: number;
  cols?: number;
}

export function TableSkeleton({ rows = 5, cols = 5 }: TableSkeletonProps): React.ReactElement {
  return (
    <div role="status" aria-label="Loading" className="space-y-2">
      {/* Header */}
      <div className="flex gap-3">
        {Array.from({ length: cols }).map((_, i) => (
          <div
            key={i}
            className="h-8 flex-1 animate-pulse rounded bg-[var(--color-surface-muted)]"
            aria-hidden
          />
        ))}
      </div>
      {/* Rows */}
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex gap-3">
          {Array.from({ length: cols }).map((_, j) => (
            <div
              key={j}
              className="h-12 flex-1 animate-pulse rounded bg-[var(--color-surface-muted)]"
              aria-hidden
            />
          ))}
        </div>
      ))}
    </div>
  );
}
