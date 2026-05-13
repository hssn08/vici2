"use client";

// M07 — Status list table with filters and pagination.

import * as React from "react";
import { apiFetch, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { StatusBadge } from "./StatusBadge";
import { SystemProtectedBadge } from "../shared/SystemProtectedBadge";
import { ConfirmDeleteDialog } from "../shared/ConfirmDeleteDialog";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StatusResponse {
  tenantId: string;
  campaignId: string;
  status: string;
  description: string;
  selectable: boolean;
  humanAnswered: boolean;
  sale: boolean;
  dnc: boolean;
  callback: boolean;
  notInterested: boolean;
  hotkey: string | null;
  recycleDelaySeconds: number | null;
  category: string | null;
  systemOwner: string | null;
  createdAt: string;
  updatedAt: string;
}

interface StatusListResponse {
  data: StatusResponse[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
}

// ---------------------------------------------------------------------------
// Recycle delay display helper
// ---------------------------------------------------------------------------

function recycleLabel(secs: number | null): string {
  if (secs === null) return "Campaign default";
  if (secs === -1) return "Terminal";
  if (secs === 0) return "Immediate";
  return `${secs}s`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function StatusList(): React.ReactElement {
  const [items, setItems] = React.useState<StatusResponse[]>([]);
  const [totalCount, setTotalCount] = React.useState(0);
  const [totalPages, setTotalPages] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [search, setSearch] = React.useState("");
  const [scopeFilter, setScopeFilter] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  // Delete
  const [deleteTarget, setDeleteTarget] = React.useState<StatusResponse | null>(null);
  const [deleting, setDeleting] = React.useState(false);
  const [deleteError, setDeleteError] = React.useState<string | null>(null);

  const searchTimerRef = React.useRef<NodeJS.Timeout | null>(null);

  function handleSearchChange(value: string) {
    setSearch(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      setPage(1);
      void fetchItems(1, value);
    }, 300);
  }

  async function fetchItems(p = page, q = search) {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(p), pageSize: "50" });
      if (q) params.set("search", q);
      if (scopeFilter) params.set("campaignId", scopeFilter);
      const result = await apiFetch<StatusListResponse>(`/api/admin/statuses?${params}`);
      setItems(result.data);
      setTotalCount(result.totalCount);
      setTotalPages(result.totalPages);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load statuses");
    } finally {
      setLoading(false);
    }
  }

  React.useEffect(() => {
    void fetchItems();
  }, [page, scopeFilter]);

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await apiFetch(
        `/api/admin/statuses/${encodeURIComponent(deleteTarget.campaignId)}/${encodeURIComponent(deleteTarget.status)}`,
        { method: "DELETE" },
      );
      setItems((prev) => prev.filter(
        (i) => !(i.campaignId === deleteTarget.campaignId && i.status === deleteTarget.status),
      ));
      setTotalCount((c) => c - 1);
      setDeleteTarget(null);
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : "Failed to delete");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <Input
          value={search}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleSearchChange(e.target.value)}
          placeholder="Search code or description..."
          className="max-w-xs"
          aria-label="Search statuses"
        />
        <select
          value={scopeFilter}
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
            setScopeFilter(e.target.value);
            setPage(1);
          }}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-brand-600)]"
          aria-label="Filter by scope"
        >
          <option value="">All scopes</option>
          <option value="__SYS__">Global (__SYS__)</option>
        </select>
        <div className="ml-auto">
          <a
            href="/admin/statuses/new"
            className="inline-flex items-center justify-center rounded-md bg-[var(--color-brand-600)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-brand-700)] transition-colors"
          >
            New status
          </a>
        </div>
      </div>

      {error && (
        <div role="alert" className="rounded-md bg-[var(--color-state-error-bg)] p-3 text-sm text-[var(--color-state-error)]">
          {error}
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto rounded-md border border-[var(--color-border)]">
        <table className="w-full text-sm">
          <thead className="bg-[var(--color-surface-muted)]">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-[var(--color-fg-muted)]">Code</th>
              <th className="px-4 py-3 text-left font-medium text-[var(--color-fg-muted)]">Description</th>
              <th className="px-4 py-3 text-left font-medium text-[var(--color-fg-muted)]">Scope</th>
              <th className="px-4 py-3 text-left font-medium text-[var(--color-fg-muted)]">Flags</th>
              <th className="px-4 py-3 text-left font-medium text-[var(--color-fg-muted)]">Hotkey</th>
              <th className="px-4 py-3 text-left font-medium text-[var(--color-fg-muted)]">Recycle</th>
              <th className="px-4 py-3 text-left font-medium text-[var(--color-fg-muted)]">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-[var(--color-fg-muted)]">
                  <span className="animate-pulse">Loading...</span>
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-[var(--color-fg-muted)]">
                  No statuses found.
                </td>
              </tr>
            ) : (
              items.map((item) => (
                <tr
                  key={`${item.campaignId}:${item.status}`}
                  className="border-t border-[var(--color-border)] hover:bg-[var(--color-surface-muted)]"
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <code className="rounded bg-[var(--color-surface-muted)] px-1.5 py-0.5 text-xs font-mono text-[var(--color-brand-600)]">
                        {item.status}
                      </code>
                      <SystemProtectedBadge owner={item.systemOwner} />
                    </div>
                  </td>
                  <td className="px-4 py-3 text-[var(--color-fg)] max-w-[200px] truncate">
                    {item.description || <span className="text-[var(--color-fg-muted)]">—</span>}
                  </td>
                  <td className="px-4 py-3">
                    {item.campaignId === "__SYS__" ? (
                      <Badge tone="brand">Global</Badge>
                    ) : (
                      <Badge tone="neutral">{item.campaignId}</Badge>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge
                      sale={item.sale}
                      dnc={item.dnc}
                      callback={item.callback}
                      notInterested={item.notInterested}
                      humanAnswered={item.humanAnswered}
                    />
                  </td>
                  <td className="px-4 py-3">
                    {item.hotkey ? (
                      <kbd className="rounded border border-[var(--color-border)] px-1.5 py-0.5 text-xs font-mono">
                        {item.hotkey}
                      </kbd>
                    ) : (
                      <span className="text-[var(--color-fg-muted)]">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-[var(--color-fg-muted)]">
                    {recycleLabel(item.recycleDelaySeconds)}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <a
                        href={`/admin/statuses/edit?campaign=${encodeURIComponent(item.campaignId)}&code=${encodeURIComponent(item.status)}`}
                        className={cn(
                          "text-xs text-[var(--color-brand-600)] hover:underline",
                          "focus:outline-none focus:ring-2 focus:ring-[var(--color-brand-600)] rounded",
                        )}
                      >
                        Edit
                      </a>
                      {!item.systemOwner && (
                        <button
                          type="button"
                          onClick={() => setDeleteTarget(item)}
                          className={cn(
                            "text-xs text-[var(--color-state-error)] hover:underline",
                            "focus:outline-none focus:ring-2 focus:ring-[var(--color-state-error)] rounded",
                          )}
                        >
                          Delete
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
          <span>{totalCount} total</span>
          <div className="flex items-center gap-2">
            <Button type="button" variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              Previous
            </Button>
            <span>Page {page} of {totalPages}</span>
            <Button type="button" variant="secondary" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
              Next
            </Button>
          </div>
        </div>
      )}

      {/* Delete Confirmation */}
      <ConfirmDeleteDialog
        open={!!deleteTarget}
        title={`Delete status "${deleteTarget?.status ?? ""}"`}
        description={`Delete this status from ${deleteTarget?.campaignId === "__SYS__" ? "global" : `campaign ${deleteTarget?.campaignId ?? ""}`}?`}
        warningMessage="Leads currently with this status will retain it until manually changed."
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
        loading={deleting}
      />
      {deleteError && (
        <div role="alert" className="rounded-md bg-[var(--color-state-error-bg)] p-3 text-sm text-[var(--color-state-error)]">
          {deleteError}
        </div>
      )}
    </div>
  );
}
