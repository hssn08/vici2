// M07 — Shared page header with title, description, and optional action button.

import * as React from "react";

interface PageHeaderProps {
  title: string;
  description?: string;
  actionHref?: string;
  actionLabel?: string;
}

export function PageHeader({
  title,
  description,
  actionHref,
  actionLabel,
}: PageHeaderProps): React.ReactElement {
  return (
    <div className="mb-6 flex items-center justify-between">
      <div>
        <h1 className="text-2xl font-semibold text-[var(--color-fg)]">{title}</h1>
        {description && (
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">{description}</p>
        )}
      </div>
      {actionHref && actionLabel && (
        <a
          href={actionHref}
          className="inline-flex items-center justify-center rounded-md bg-[var(--color-brand-600)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-brand-700)] transition-colors"
        >
          {actionLabel}
        </a>
      )}
    </div>
  );
}
