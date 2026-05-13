"use client";

// M07 — Collapsible version history panel for script editor.

import * as React from "react";
import { apiFetch, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ScriptVersionResponse {
  id: string;
  scriptId: string;
  version: number;
  name: string;
  bodyPreview: string;
  savedAt: string;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface VersionHistoryPanelProps {
  scriptId: string;
  currentVersion: number;
  onRestored: (newVersion: number, restoredHtml: string) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function VersionHistoryPanel({
  scriptId,
  currentVersion,
  onRestored,
}: VersionHistoryPanelProps): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const [versions, setVersions] = React.useState<ScriptVersionResponse[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [restoringVersion, setRestoringVersion] = React.useState<number | null>(null);

  async function loadVersions() {
    if (versions.length > 0) return; // already loaded
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<{ data: ScriptVersionResponse[] }>(
        `/api/admin/scripts/${scriptId}/versions`,
      );
      setVersions(res.data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load versions");
    } finally {
      setLoading(false);
    }
  }

  function handleToggle() {
    const next = !open;
    setOpen(next);
    if (next) void loadVersions();
  }

  async function handleRestore(version: number) {
    setRestoringVersion(version);
    setError(null);
    try {
      const restored = await apiFetch<{ id: string; version: number; body: string }>(
        `/api/admin/scripts/${scriptId}/restore/${version}`,
        { method: "POST" },
      );
      // Invalidate versions so next open reloads
      setVersions([]);
      onRestored(restored.version, restored.body ?? "");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to restore version");
    } finally {
      setRestoringVersion(null);
    }
  }

  return (
    <div className="border-t border-[var(--color-border)] pt-4 mt-4">
      <button
        type="button"
        onClick={handleToggle}
        className="flex items-center gap-2 text-sm font-medium text-[var(--color-fg)] hover:text-[var(--color-brand-600)] focus:outline-none focus:ring-2 focus:ring-[var(--color-brand-600)] rounded"
        aria-expanded={open}
        aria-controls="version-history-panel"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={open ? "rotate-90 transition-transform" : "transition-transform"}
          aria-hidden="true"
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
        Version History
        {versions.length > 0 && (
          <span className="ml-1 rounded-full bg-[var(--color-surface-muted)] px-2 py-0.5 text-xs text-[var(--color-fg-muted)]">
            {versions.length}
          </span>
        )}
      </button>

      {open && (
        <div id="version-history-panel" className="mt-3 space-y-2">
          {error && (
            <div role="alert" className="rounded-md bg-[var(--color-state-error-bg)] p-2 text-xs text-[var(--color-state-error)]">
              {error}
            </div>
          )}
          {loading && (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-12 animate-pulse rounded bg-[var(--color-surface-muted)]" />
              ))}
            </div>
          )}
          {!loading && versions.length === 0 && !error && (
            <p className="text-xs text-[var(--color-fg-muted)]">No version history yet.</p>
          )}
          {versions.map((v) => (
            <div
              key={v.id}
              className="flex items-start justify-between gap-3 rounded-md border border-[var(--color-border)] p-3"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-[var(--color-fg)]">v{v.version}</span>
                  {v.version === currentVersion && (
                    <span className="rounded bg-[var(--color-brand-100)] px-1.5 py-0.5 text-[10px] text-[var(--color-brand-700)]">
                      current
                    </span>
                  )}
                  <span className="text-xs text-[var(--color-fg-muted)]">
                    {new Date(v.savedAt).toLocaleString()}
                  </span>
                </div>
                <p className="mt-1 truncate text-xs text-[var(--color-fg-muted)]">
                  {v.bodyPreview || <em>Empty script</em>}
                </p>
              </div>
              {v.version !== currentVersion && (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void handleRestore(v.version)}
                  disabled={restoringVersion !== null}
                  className="shrink-0 text-xs h-7"
                >
                  {restoringVersion === v.version ? "Restoring..." : "Restore"}
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
