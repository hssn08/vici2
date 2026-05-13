"use client";

// M06 — Per-carrier gateway table + health dashboard.
//
// Displays gateways for one carrier, with:
//   - Transport / weight / priority / active status
//   - Reload button (super_admin)
//   - Health status from /carriers/:id/health

import * as React from "react";
import { apiFetch, ApiError } from "@/lib/api";
import { useAuthStore } from "@/lib/stores/auth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GatewayResponse {
  id: string;
  name: string;
  proxy: string;
  transport: string;
  register: boolean;
  priority: number;
  weight: number;
  active: boolean;
  maxConcurrent: number | null;
  costPerMinCents: number | null;
}

interface HealthEntry {
  gatewayId: string;
  state: string;
  status: string;
  pingMs: number | null;
  polledAt: string | null;
}

interface CarrierHealthResponse {
  carrierId: string;
  gateways: HealthEntry[];
}

// ---------------------------------------------------------------------------
// State colour
// ---------------------------------------------------------------------------

function stateBadgeClass(state: string): string {
  switch (state) {
    case "REGED": return "bg-green-100 text-green-700";
    case "NOREG": return "bg-blue-100 text-blue-700";
    case "UNREG": return "bg-yellow-100 text-yellow-700";
    case "FAILED":
    case "FAIL_WAIT": return "bg-red-100 text-red-700";
    case "EXPIRED": return "bg-orange-100 text-orange-700";
    default: return "bg-gray-100 text-gray-500";
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface GatewayTableProps {
  carrierId: string;
  onAddGateway?: () => void;
}

export function GatewayTable({ carrierId, onAddGateway }: GatewayTableProps): React.ReactElement {
  const user = useAuthStore((s) => s.user);
  const isSuperAdmin = user?.role === "super_admin" || user?.role === "superadmin";

  const [gateways, setGateways] = React.useState<GatewayResponse[]>([]);
  const [health, setHealth] = React.useState<Record<string, HealthEntry>>({});
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [reloadingId, setReloadingId] = React.useState<string | null>(null);
  const [deletingId, setDeletingId] = React.useState<string | null>(null);

  const fetchGateways = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [gwData, healthData] = await Promise.all([
        apiFetch<{ data: GatewayResponse[] }>(`/api/admin/carriers/${carrierId}/gateways`),
        apiFetch<CarrierHealthResponse>(`/api/admin/carriers/${carrierId}/health`).catch(() => ({ carrierId, gateways: [] })),
      ]);
      setGateways(gwData.data);

      const healthMap: Record<string, HealthEntry> = {};
      (healthData as CarrierHealthResponse).gateways.forEach((h) => { healthMap[h.gatewayId] = h; });
      setHealth(healthMap);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load gateways");
    } finally {
      setLoading(false);
    }
  }, [carrierId]);

  React.useEffect(() => { fetchGateways(); }, [fetchGateways]);

  async function handleReload(gwId: string) {
    setReloadingId(gwId);
    try {
      await apiFetch(`/api/admin/carriers/${carrierId}/gateways/${gwId}/reload`, { method: "POST" });
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Reload failed");
    } finally {
      setReloadingId(null);
    }
  }

  async function handleDelete(gw: GatewayResponse) {
    if (!confirm(`Delete gateway "${gw.name}"?`)) return;
    setDeletingId(gw.id);
    try {
      await apiFetch(`/api/admin/carriers/${carrierId}/gateways/${gw.id}`, { method: "DELETE" });
      await fetchGateways();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Delete failed");
    } finally {
      setDeletingId(null);
    }
  }

  if (loading) {
    return (
      <div role="status" aria-label="Loading gateways" className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-10 animate-pulse rounded bg-[var(--color-surface-muted)]" aria-hidden />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700">
        {error}
        <Button variant="ghost" size="sm" onClick={fetchGateways} className="ml-3">Retry</Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-[var(--color-fg)]">Gateways ({gateways.length})</h3>
        {isSuperAdmin && onAddGateway && (
          <Button size="sm" onClick={onAddGateway}>Add gateway</Button>
        )}
      </div>

      {gateways.length === 0 ? (
        <p className="text-sm text-[var(--color-fg-muted)] py-4">
          No gateways yet.{" "}
          {isSuperAdmin && onAddGateway && (
            <button type="button" onClick={onAddGateway} className="text-[var(--color-brand-600)] hover:underline">Add one</button>
          )}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-[var(--color-border)]">
          <table className="w-full text-sm" aria-label="Gateways">
            <thead className="bg-[var(--color-surface-muted)]">
              <tr>
                <th className="px-4 py-2 text-left font-semibold">Name</th>
                <th className="px-4 py-2 text-left font-semibold">Proxy</th>
                <th className="px-4 py-2 text-left font-semibold">Transport</th>
                <th className="px-4 py-2 text-left font-semibold">Pri / Wt</th>
                <th className="px-4 py-2 text-left font-semibold">State</th>
                <th className="px-4 py-2 text-left font-semibold">Ping</th>
                <th className="px-4 py-2 text-right font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {gateways.map((gw) => {
                const h = health[gw.id];
                return (
                  <tr key={gw.id} className="hover:bg-[var(--color-surface-muted)] transition-colors">
                    <td className="px-4 py-2 font-medium">
                      {gw.name}
                      {!gw.active && <span className="ml-2 text-xs text-gray-400">(inactive)</span>}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-[var(--color-fg-muted)] max-w-[180px] truncate">
                      {gw.proxy}
                    </td>
                    <td className="px-4 py-2">
                      <Badge className="bg-gray-100 text-gray-700 text-xs">{gw.transport}</Badge>
                      {gw.register && <Badge className="ml-1 bg-blue-100 text-blue-700 text-xs">register</Badge>}
                    </td>
                    <td className="px-4 py-2 text-[var(--color-fg-muted)]">
                      {gw.priority} / {gw.weight}
                    </td>
                    <td className="px-4 py-2">
                      {h ? (
                        <Badge className={cn("text-xs", stateBadgeClass(h.state))}>{h.state}</Badge>
                      ) : (
                        <span className="text-xs text-[var(--color-fg-muted)]">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-xs text-[var(--color-fg-muted)]">
                      {h?.pingMs != null ? `${h.pingMs} ms` : "—"}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <div className="flex items-center justify-end gap-2">
                        {isSuperAdmin && (
                          <>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleReload(gw.id)}
                              disabled={reloadingId === gw.id}
                              aria-label={`Reload gateway ${gw.name}`}
                            >
                              {reloadingId === gw.id ? "Reloading…" : "Reload"}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleDelete(gw)}
                              disabled={deletingId === gw.id}
                              className="text-red-600 hover:bg-red-50"
                              aria-label={`Delete gateway ${gw.name}`}
                            >
                              {deletingId === gw.id ? "Deleting…" : "Delete"}
                            </Button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
