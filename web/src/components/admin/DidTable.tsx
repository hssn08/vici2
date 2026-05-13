"use client";

// M06 — DID number table component.
//
// Displays DIDs with E.164, carrier, route kind/target, and active status.
// Supports carrier filter and search.

import * as React from "react";
import { apiFetch, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DidResponse {
  id: string;
  e164: string;
  carrierId: string;
  routeKind: string;
  routeTarget: string;
  callerIdName: string | null;
  active: boolean;
  defaultLang: string;
  ivrTimeoutSec: number;
}

interface DidListResponse {
  data: DidResponse[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
}

// ---------------------------------------------------------------------------
// Route kind colours
// ---------------------------------------------------------------------------

const ROUTE_BADGE: Record<string, string> = {
  ingroup: "bg-green-100 text-green-700",
  ivr: "bg-blue-100 text-blue-700",
  agent: "bg-purple-100 text-purple-700",
  ext: "bg-orange-100 text-orange-700",
  voicemail: "bg-gray-100 text-gray-700",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface DidTableProps {
  filterCarrierId?: string;
}

export function DidTable({ filterCarrierId }: DidTableProps): React.ReactElement {
  const [dids, setDids] = React.useState<DidResponse[]>([]);
  const [totalCount, setTotalCount] = React.useState(0);
  const [totalPages, setTotalPages] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [search, setSearch] = React.useState("");
  const [debouncedSearch, setDebouncedSearch] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [deletingId, setDeletingId] = React.useState<string | null>(null);

  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const fetchDids = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: "50" });
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (filterCarrierId) params.set("carrierId", filterCarrierId);
      const data = await apiFetch<DidListResponse>(`/api/admin/dids?${params}`);
      setDids(data.data);
      setTotalCount(data.totalCount);
      setTotalPages(data.totalPages);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load DIDs");
    } finally {
      setLoading(false);
    }
  }, [page, debouncedSearch, filterCarrierId]);

  React.useEffect(() => { fetchDids(); }, [fetchDids]);

  async function handleDelete(did: DidResponse) {
    if (!confirm(`Delete DID ${did.e164}?`)) return;
    setDeletingId(did.id);
    try {
      await apiFetch(`/api/admin/dids/${did.id}`, { method: "DELETE" });
      await fetchDids();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Delete failed");
    } finally {
      setDeletingId(null);
    }
  }

  if (loading && dids.length === 0) {
    return (
      <div role="status" aria-label="Loading DIDs" className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-10 animate-pulse rounded bg-[var(--color-surface-muted)]" aria-hidden />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700">
        {error}
        <Button variant="ghost" size="sm" onClick={fetchDids} className="ml-3">Retry</Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Input
          type="search"
          placeholder="Search by E.164..."
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          className="max-w-xs"
          aria-label="Search DIDs"
        />
        <span className="text-sm text-[var(--color-fg-muted)]">{totalCount} DID{totalCount !== 1 ? "s" : ""}</span>
      </div>

      <div className="overflow-x-auto rounded-lg border border-[var(--color-border)]">
        <table className="w-full text-sm" aria-label="DIDs">
          <thead className="bg-[var(--color-surface-muted)]">
            <tr>
              <th className="px-4 py-3 text-left font-semibold">E.164 Number</th>
              <th className="px-4 py-3 text-left font-semibold">Carrier</th>
              <th className="px-4 py-3 text-left font-semibold">Route</th>
              <th className="px-4 py-3 text-left font-semibold">Target</th>
              <th className="px-4 py-3 text-left font-semibold">Lang</th>
              <th className="px-4 py-3 text-left font-semibold">Status</th>
              <th className="px-4 py-3 text-right font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            {dids.length === 0 && (
              <tr>
                <td colSpan={7} className="py-12 text-center text-[var(--color-fg-muted)]">
                  No DIDs yet.{" "}
                  <a href="/admin/dids/new" className="text-[var(--color-brand-600)] hover:underline">Add one</a>
                </td>
              </tr>
            )}
            {dids.map((did) => (
              <tr key={did.id} className="hover:bg-[var(--color-surface-muted)] transition-colors">
                <td className="px-4 py-3 font-mono font-medium text-[var(--color-fg)]">
                  {did.e164}
                  {did.callerIdName && (
                    <span className="ml-2 text-xs text-[var(--color-fg-muted)]">({did.callerIdName})</span>
                  )}
                </td>
                <td className="px-4 py-3 text-[var(--color-fg-muted)] text-xs font-mono">{did.carrierId}</td>
                <td className="px-4 py-3">
                  <Badge className={cn("text-xs", ROUTE_BADGE[did.routeKind] ?? "bg-gray-100 text-gray-700")}>
                    {did.routeKind}
                  </Badge>
                </td>
                <td className="px-4 py-3 text-[var(--color-fg-muted)] font-mono text-xs">{did.routeTarget}</td>
                <td className="px-4 py-3 text-[var(--color-fg-muted)]">{did.defaultLang}</td>
                <td className="px-4 py-3">
                  <Badge className={did.active ? "bg-green-100 text-green-700 text-xs" : "bg-gray-100 text-gray-500 text-xs"}>
                    {did.active ? "active" : "inactive"}
                  </Badge>
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <a href={`/admin/dids/${did.id}`}>
                      <Button variant="ghost" size="sm" aria-label={`Edit DID ${did.e164}`}>Edit</Button>
                    </a>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDelete(did)}
                      disabled={deletingId === did.id}
                      className="text-red-600 hover:bg-red-50"
                      aria-label={`Delete DID ${did.e164}`}
                    >
                      {deletingId === did.id ? "Deleting…" : "Delete"}
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
          <span className="text-[var(--color-fg-muted)]">Page {page} of {totalPages}</span>
          <Button variant="ghost" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
        </div>
      )}
    </div>
  );
}
