"use client";

// M06 — Admin carrier table component.
//
// Displays carriers in a paginated, searchable table with:
//   - Kind badge, credential status, active toggle
//   - Gateway count link
//   - Test-connect button (super_admin)
//   - Edit / Delete actions (super_admin)

import * as React from "react";
import { apiFetch, ApiError } from "@/lib/api";
import { useAuthStore } from "@/lib/stores/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CarrierResponse {
  id: string;
  name: string;
  kind: string;
  proxy: string;
  credentialStatus: "set" | "unset";
  register: boolean;
  active: boolean;
  isEmergency: boolean;
  maxConcurrent: number | null;
  gatewayCount: number;
  createdAt: string;
}

interface CarrierListResponse {
  data: CarrierResponse[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
}

// ---------------------------------------------------------------------------
// Kind badge colours
// ---------------------------------------------------------------------------

const KIND_BADGE: Record<string, string> = {
  twilio: "bg-red-100 text-red-700",
  telnyx: "bg-blue-100 text-blue-700",
  "telnyx-creds": "bg-blue-100 text-blue-700",
  "telnyx-ip": "bg-sky-100 text-sky-700",
  signalwire: "bg-green-100 text-green-700",
  ringcentral: "bg-yellow-100 text-yellow-700",
  bandwidth: "bg-purple-100 text-purple-700",
  flowroute: "bg-orange-100 text-orange-700",
  byoc: "bg-gray-100 text-gray-700",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CarrierTable(): React.ReactElement {
  const user = useAuthStore((s) => s.user);
  const isSuperAdmin = user?.role === "super_admin" || user?.role === "superadmin";

  const [carriers, setCarriers] = React.useState<CarrierResponse[]>([]);
  const [totalCount, setTotalCount] = React.useState(0);
  const [totalPages, setTotalPages] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [search, setSearch] = React.useState("");
  const [debouncedSearch, setDebouncedSearch] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [testingId, setTestingId] = React.useState<string | null>(null);
  const [testResult, setTestResult] = React.useState<Record<string, string>>({});
  const [deletingId, setDeletingId] = React.useState<string | null>(null);

  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const fetchCarriers = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: "50" });
      if (debouncedSearch) params.set("search", debouncedSearch);
      const data = await apiFetch<CarrierListResponse>(`/api/admin/carriers?${params}`);
      setCarriers(data.data);
      setTotalCount(data.totalCount);
      setTotalPages(data.totalPages);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load carriers");
    } finally {
      setLoading(false);
    }
  }, [page, debouncedSearch]);

  React.useEffect(() => { fetchCarriers(); }, [fetchCarriers]);

  async function handleTestConnect(carrierId: string) {
    setTestingId(carrierId);
    try {
      const result = await apiFetch<{ state: string; status: string; simulated: boolean }>(
        `/api/admin/carriers/${carrierId}/test-connect`,
        { method: "POST" },
      );
      setTestResult((prev) => ({
        ...prev,
        [carrierId]: `${result.state} / ${result.status}${result.simulated ? " (sim)" : ""}`,
      }));
    } catch (err) {
      setTestResult((prev) => ({
        ...prev,
        [carrierId]: err instanceof ApiError ? err.message : "Error",
      }));
    } finally {
      setTestingId(null);
    }
  }

  async function handleDelete(carrier: CarrierResponse) {
    if (!confirm(`Delete carrier "${carrier.name}"? This also deletes all its gateways.`)) return;
    setDeletingId(carrier.id);
    try {
      await apiFetch(`/api/admin/carriers/${carrier.id}`, { method: "DELETE" });
      await fetchCarriers();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Delete failed");
    } finally {
      setDeletingId(null);
    }
  }

  if (loading && carriers.length === 0) {
    return (
      <div role="status" aria-label="Loading carriers" className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-12 animate-pulse rounded-md bg-[var(--color-surface-muted)]" aria-hidden />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div role="alert" className="rounded-md bg-red-50 p-4 text-sm text-red-700">
        {error}
        <Button variant="ghost" size="sm" onClick={fetchCarriers} className="ml-4">Retry</Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Input
          type="search"
          placeholder="Search by name..."
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          className="max-w-xs"
          aria-label="Search carriers"
        />
        <span className="text-sm text-[var(--color-fg-muted)]">{totalCount} carrier{totalCount !== 1 ? "s" : ""}</span>
      </div>

      <div className="overflow-x-auto rounded-lg border border-[var(--color-border)]">
        <table className="w-full text-sm" role="grid" aria-label="Carriers">
          <thead className="bg-[var(--color-surface-muted)]">
            <tr>
              <th className="px-4 py-3 text-left font-semibold text-[var(--color-fg)]">Name</th>
              <th className="px-4 py-3 text-left font-semibold text-[var(--color-fg)]">Kind</th>
              <th className="px-4 py-3 text-left font-semibold text-[var(--color-fg)]">Proxy</th>
              <th className="px-4 py-3 text-left font-semibold text-[var(--color-fg)]">Gateways</th>
              <th className="px-4 py-3 text-left font-semibold text-[var(--color-fg)]">Credentials</th>
              <th className="px-4 py-3 text-left font-semibold text-[var(--color-fg)]">Status</th>
              <th className="px-4 py-3 text-right font-semibold text-[var(--color-fg)]">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            {carriers.length === 0 && (
              <tr>
                <td colSpan={7} className="py-12 text-center text-[var(--color-fg-muted)]">
                  No carriers yet.{" "}
                  {isSuperAdmin && (
                    <a href="/admin/carriers/new" className="text-[var(--color-brand-600)] hover:underline">Add one</a>
                  )}
                </td>
              </tr>
            )}
            {carriers.map((carrier) => (
              <tr key={carrier.id} className="hover:bg-[var(--color-surface-muted)] transition-colors">
                <td className="px-4 py-3 font-medium text-[var(--color-fg)]">
                  <a href={`/admin/carriers/${carrier.id}`} className="hover:underline">
                    {carrier.name}
                    {carrier.isEmergency && (
                      <span className="ml-2 text-xs text-red-600 font-semibold">E911</span>
                    )}
                  </a>
                </td>
                <td className="px-4 py-3">
                  <Badge className={cn("text-xs", KIND_BADGE[carrier.kind] ?? "bg-gray-100 text-gray-700")}>
                    {carrier.kind}
                  </Badge>
                </td>
                <td className="px-4 py-3 text-[var(--color-fg-muted)] font-mono text-xs max-w-[200px] truncate">
                  {carrier.proxy}
                </td>
                <td className="px-4 py-3 text-center">
                  <a href={`/admin/carriers/${carrier.id}`} className="text-[var(--color-brand-600)] hover:underline">
                    {carrier.gatewayCount ?? 0}
                  </a>
                </td>
                <td className="px-4 py-3">
                  <Badge className={carrier.credentialStatus === "set"
                    ? "bg-green-100 text-green-700 text-xs"
                    : "bg-gray-100 text-gray-500 text-xs"
                  }>
                    {carrier.credentialStatus}
                  </Badge>
                </td>
                <td className="px-4 py-3">
                  <Badge className={carrier.active
                    ? "bg-green-100 text-green-700 text-xs"
                    : "bg-gray-100 text-gray-500 text-xs"
                  }>
                    {carrier.active ? "active" : "inactive"}
                  </Badge>
                  {testResult[carrier.id] && (
                    <span className="ml-2 text-xs text-[var(--color-fg-muted)]">{testResult[carrier.id]}</span>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleTestConnect(carrier.id)}
                      disabled={testingId === carrier.id}
                      aria-label={`Test connect ${carrier.name}`}
                    >
                      {testingId === carrier.id ? "Testing…" : "Test"}
                    </Button>
                    <a href={`/admin/carriers/${carrier.id}`}>
                      <Button variant="ghost" size="sm" aria-label={`Edit ${carrier.name}`}>Edit</Button>
                    </a>
                    {isSuperAdmin && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDelete(carrier)}
                        disabled={deletingId === carrier.id}
                        className="text-red-600 hover:bg-red-50"
                        aria-label={`Delete ${carrier.name}`}
                      >
                        {deletingId === carrier.id ? "Deleting…" : "Delete"}
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Previous
          </Button>
          <span className="text-[var(--color-fg-muted)]">Page {page} of {totalPages}</span>
          <Button variant="ghost" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
