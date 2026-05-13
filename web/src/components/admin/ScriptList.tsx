"use client";

// S03 — Admin script list component.
//
// Fetches scripts from GET /api/admin/scripts (offset pagination),
// renders a table with sort/filter controls, and links to edit/preview actions.

import * as React from "react";
import { apiFetch, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ScriptResponse {
  id: string;
  name: string;
  campaignId: string | null;
  active: boolean;
  version: number;
  variables: Array<{ name: string }>;
  createdAt: string;
  updatedAt: string;
}

interface ScriptListResponse {
  data: ScriptResponse[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ScriptList(): React.ReactElement {
  const [scripts, setScripts] = React.useState<ScriptResponse[]>([]);
  const [totalCount, setTotalCount] = React.useState(0);
  const [totalPages, setTotalPages] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [pageSize] = React.useState(50);
  const [search, setSearch] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [deletingId, setDeletingId] = React.useState<string | null>(null);

  const [debouncedSearch, setDebouncedSearch] = React.useState("");
  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
    });
    if (debouncedSearch) params.set("search", debouncedSearch);

    apiFetch<ScriptListResponse>(`/api/admin/scripts?${params}`)
      .then((data) => {
        if (cancelled) return;
        setScripts(data.data);
        setTotalCount(data.totalCount);
        setTotalPages(data.totalPages);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : "Failed to load scripts");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [page, pageSize, debouncedSearch]);

  async function handleDelete(id: string, name: string) {
    if (!confirm(`Deactivate script "${name}"? It will no longer be available to agents.`)) return;
    setDeletingId(id);
    try {
      await apiFetch(`/api/admin/scripts/${id}`, { method: "DELETE" });
      setScripts((prev: ScriptResponse[]) => prev.map((s: ScriptResponse) => s.id === id ? { ...s, active: false } : s));
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Failed to delete script");
    } finally {
      setDeletingId(null);
    }
  }

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString("en-US", {
      year: "numeric", month: "short", day: "numeric",
    });
  }

  return (
    <div className="space-y-4">
      {/* Search */}
      <div className="flex items-center gap-2">
        <Input
          placeholder="Search scripts..."
          value={search}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => { setSearch(e.target.value); setPage(1); }}
          className="max-w-xs"
          aria-label="Search scripts"
        />
        <span className="text-sm text-[var(--color-fg-muted)]">
          {totalCount} script{totalCount !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Error */}
      {error && (
        <div role="alert" className="rounded-md bg-[var(--color-state-error-bg)] p-3 text-sm text-[var(--color-state-error)]">
          {error}
        </div>
      )}

      {/* Table */}
      <div className="rounded-md border border-[var(--color-border)]">
        <table className="w-full text-sm" role="grid" aria-label="Scripts table">
          <thead>
            <tr className="border-b border-[var(--color-border)] bg-[var(--color-surface-muted)]">
              <th className="px-4 py-3 text-left font-medium text-[var(--color-fg-muted)]">Name</th>
              <th className="px-4 py-3 text-left font-medium text-[var(--color-fg-muted)]">Campaign</th>
              <th className="px-4 py-3 text-left font-medium text-[var(--color-fg-muted)]">Status</th>
              <th className="px-4 py-3 text-left font-medium text-[var(--color-fg-muted)]">Version</th>
              <th className="px-4 py-3 text-left font-medium text-[var(--color-fg-muted)]">Variables</th>
              <th className="px-4 py-3 text-left font-medium text-[var(--color-fg-muted)]">Updated</th>
              <th className="px-4 py-3 text-right font-medium text-[var(--color-fg-muted)]">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={i} className="border-b border-[var(--color-border)]">
                  {Array.from({ length: 7 }).map((__, j) => (
                    <td key={j} className="px-4 py-3">
                      <div className="h-4 animate-pulse rounded bg-[var(--color-surface-muted)]" />
                    </td>
                  ))}
                </tr>
              ))
            ) : scripts.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-[var(--color-fg-muted)]">
                  No scripts found.{" "}
                  <a href="/admin/scripts/new" className="text-[var(--color-brand-600)] hover:underline">
                    Create one
                  </a>
                </td>
              </tr>
            ) : (
              scripts.map((script: ScriptResponse) => (
                <tr
                  key={script.id}
                  className={cn(
                    "border-b border-[var(--color-border)] hover:bg-[var(--color-surface-muted)] transition-colors",
                    !script.active && "opacity-60",
                  )}
                >
                  <td className="px-4 py-3 font-medium text-[var(--color-fg)]">
                    <a
                      href={`/admin/scripts/${script.id}`}
                      className="hover:text-[var(--color-brand-600)] hover:underline"
                    >
                      {script.name}
                    </a>
                  </td>
                  <td className="px-4 py-3 text-[var(--color-fg-muted)]">
                    {script.campaignId ?? <span className="italic">All campaigns</span>}
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={script.active ? "success" : "neutral"}>
                      {script.active ? "Active" : "Inactive"}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-[var(--color-fg-muted)]">
                    v{script.version}
                  </td>
                  <td className="px-4 py-3 text-[var(--color-fg-muted)]">
                    {script.variables.length}
                  </td>
                  <td className="px-4 py-3 text-[var(--color-fg-muted)]">
                    {formatDate(script.updatedAt)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <a
                        href={`/admin/scripts/${script.id}/preview`}
                        className="text-xs text-[var(--color-brand-600)] hover:underline"
                      >
                        Preview
                      </a>
                      <a
                        href={`/admin/scripts/${script.id}`}
                        className="text-xs text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] hover:underline"
                      >
                        Edit
                      </a>
                      {script.active && (
                        <button
                          onClick={() => void handleDelete(script.id, script.name)}
                          disabled={deletingId === script.id}
                          className="text-xs text-[var(--color-state-error)] hover:underline disabled:opacity-50"
                          aria-label={`Deactivate script ${script.name}`}
                        >
                          {deletingId === script.id ? "..." : "Deactivate"}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-[var(--color-fg-muted)]">
          <span>
            Page {page} of {totalPages} ({totalCount} total)
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p: number) => Math.max(1, p - 1))}
              disabled={page <= 1}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p: number) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
