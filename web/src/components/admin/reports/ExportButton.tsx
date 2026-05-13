"use client";

// M03 — Export button component.
// Builds the CSV download URL from the base endpoint + current search params,
// appends ?format=csv, and opens the link in a new tab.

interface ExportButtonProps {
  baseUrl: string;
  params: Record<string, string | undefined>;
  label?: string;
}

export function ExportButton({ baseUrl, params, label = "Export CSV" }: ExportButtonProps): React.ReactElement {
  function buildUrl(): string {
    const searchParams = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v) searchParams.set(k, v);
    }
    searchParams.set("format", "csv");
    return `${baseUrl}?${searchParams.toString()}`;
  }

  function handleClick(): void {
    const url = buildUrl();
    const a = document.createElement("a");
    a.href = url;
    a.rel = "noopener noreferrer";
    a.click();
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-elevated)] px-3 py-1.5 text-sm font-medium text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)] transition-colors focus:outline-2 focus:outline-[var(--color-brand-600)]"
      aria-label={label}
    >
      <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
      {label}
    </button>
  );
}
