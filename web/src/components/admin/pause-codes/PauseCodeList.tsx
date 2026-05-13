"use client";

// M07 — Pause code list table with search, scope filter, and pagination.

import * as React from "react";
import { apiFetch, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { ConfirmDeleteDialog } from "../shared/ConfirmDeleteDialog";
import { PauseCodeDialog } from "./PauseCodeDialog";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PauseCodeResponse {
  id: string;
  tenantId: string;
  campaignId: string | null;
  code: string;
  name: string;
  billable: boolean;
  createdAt: string;
  updatedAt: string;
}

interface PauseCodeListResponse {
  data: PauseCodeResponse[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PauseCodeList(): React.ReactElement {
  const [items, setItems] = React.useState<PauseCodeResponse[]>([]);
  const [totalCount, setTotalCount] = React.useState(0);
  const [totalPages, setTotalPages] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [search, setSearch] = React.useState("");
  const [scopeFilter, setScopeFilter] = React.useState<"" | "__GLOBAL__" | "campaign">("");
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  // Dialog state
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editTarget, setEditTarget] = React.useState<PauseCodeResponse | null>(null);

  // Delete state
  const [deleteTarget, setDeleteTarget] = React.useState<PauseCodeResponse | null>(null);
  const [deleting, setDeleting] = React.useState(false);
  const [deleteError, setDeleteError] = React.useState<string | null>(null);

  // Debounced search
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
      if (scopeFilter === "__GLOBAL__") params.set("campaignId", "__GLOBAL__");
      const result = await apiFetch<PauseCodeListResponse>(`/api/admin/pause-codes?${params}`);
      setItems(result.data);
      setTotalCount(result.totalCount);
      setTotalPages(result.totalPages);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load pause codes");
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
      await apiFetch(`/api/admin/pause-codes/${deleteTarget.id}`, { method: "DELETE" });
      setItems((prev) => prev.filter((i) => i.id !== deleteTarget.id));
      setTotalCount((c) => c - 1);
      setDeleteTarget(null);
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : "Failed to delete");
    } finally {
      setDeleting(false);
    }
  }

  function openCreate() {
    setEditTarget(null);
    setDialogOpen(true);
  }

  function openEdit(item: PauseCodeResponse) {
    setEditTarget(item);
    setDialogOpen(true);
  }

  function handleSaved(saved: PauseCodeResponse) {
    if (editTarget) {
      setItems((prev) => prev.map((i) => (i.id === saved.id ? saved : i)));
    } else {
      setItems((prev) => [saved, ...prev]);
      setTotalCount((c) => c + 1);
    }
    setDialogOpen(false);
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <Input
          value={search}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleSearchChange(e.target.value)}
          placeholder="Search code or name..."
          className="max-w-xs"
          aria-label="Search pause codes"
        />
        <select
          value={scopeFilter}
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
            setScopeFilter(e.target.value as "" | "__GLOBAL__" | "campaign");
            setPage(1);
          }}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-brand-600)]"
          aria-label="Filter by scope"
        >
          <option value="">All scopes</option>
          <option value="__GLOBAL__">Global only</option>
        </select>
        <div className="ml-auto">
          <Button type="button" onClick={openCreate}>
            New pause code
          </Button>
        </div>
      </div>

      {/* Error */}
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
              <th className="px-4 py-3 text-left font-medium text-[var(--color-fg-muted)]">Name</th>
              <th className="px-4 py-3 text-left font-medium text-[var(--color-fg-muted)]">Scope</th>
              <th className="px-4 py-3 text-left font-medium text-[var(--color-fg-muted)]">Billable</th>
              <th className="px-4 py-3 text-left font-medium text-[var(--color-fg-muted)]">Updated</th>
              <th className="px-4 py-3 text-left font-medium text-[var(--color-fg-muted)]">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-[var(--color-fg-muted)]">
                  <span className="animate-pulse">Loading...</span>
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-[var(--color-fg-muted)]">
                  No pause codes found.
                </td>
              </tr>
            ) : (
              items.map((item) => (
                <tr
                  key={item.id}
                  className="border-t border-[var(--color-border)] hover:bg-[var(--color-surface-muted)]"
                >
                  <td className="px-4 py-3">
                    <code className="rounded bg-[var(--color-surface-muted)] px-1.5 py-0.5 text-xs font-mono text-[var(--color-brand-600)]">
                      {item.code}
                    </code>
                  </td>
                  <td className="px-4 py-3 text-[var(--color-fg)]">{item.name}</td>
                  <td className="px-4 py-3">
                    {item.campaignId ? (
                      <Badge tone="neutral">{item.campaignId}</Badge>
                    ) : (
                      <Badge tone="brand">Global</Badge>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {item.billable ? (
                      <Badge tone="success">Yes</Badge>
                    ) : (
                      <span className="text-[var(--color-fg-muted)]">No</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-[var(--color-fg-muted)]">
                    {new Date(item.updatedAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => openEdit(item)}
                        className={cn(
                          "text-xs text-[var(--color-brand-600)] hover:underline",
                          "focus:outline-none focus:ring-2 focus:ring-[var(--color-brand-600)] rounded",
                        )}
                      >
                        Edit
                      </button>
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
            <Button
              type="button"
              variant="secondary"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              Previous
            </Button>
            <span>Page {page} of {totalPages}</span>
            <Button
              type="button"
              variant="secondary"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}

      {/* Create / Edit Dialog */}
      <PauseCodeDialog
        open={dialogOpen}
        editItem={editTarget}
        onClose={() => setDialogOpen(false)}
        onSaved={handleSaved}
      />

      {/* Delete Confirmation */}
      <ConfirmDeleteDialog
        open={!!deleteTarget}
        title={`Delete pause code "${deleteTarget?.code ?? ""}"`}
        description={`This will permanently delete the "${deleteTarget?.name ?? ""}" pause code.`}
        warningMessage="Agents currently using this code will complete their pause normally."
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
