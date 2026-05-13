"use client";

// X04 — Admin number pools list page.
// URL: /admin/number-pools

import * as React from "react";

interface Pool {
  id: string;
  name: string;
  strategy: string;
  activeDids: number;
  quarantinedDids: number;
  avgHealthScore?: number;
  active: boolean;
}

function healthColor(score: number): string {
  if (score > 75) return "text-green-600";
  if (score >= 40) return "text-yellow-600";
  return "text-red-600";
}

function strategyLabel(s: string): string {
  const map: Record<string, string> = {
    health_weighted_lru: "Health-weighted LRU",
    round_robin: "Round-robin",
    random: "Random",
    least_recently_used: "LRU",
  };
  return map[s] ?? s;
}

export default function NumberPoolsPage(): React.ReactElement {
  const [pools, setPools] = React.useState<Pool[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const fetchPools = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/number-pools?active=all");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { data: Pool[] };
      setPools(data.data ?? []);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { void fetchPools(); }, [fetchPools]);

  const handleDelete = async (id: string): Promise<void> => {
    if (!confirm("Deactivate this pool?")) return;
    const res = await fetch(`/api/admin/number-pools/${id}`, { method: "DELETE" });
    if (res.status === 409) {
      alert("Pool is referenced by one or more campaigns and cannot be deactivated.");
      return;
    }
    void fetchPools();
  };

  return (
    <main>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--color-fg)]">Number Pools</h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            Manage caller-ID rotation pools for outbound campaigns.
          </p>
        </div>
        <a
          href="/admin/number-pools/new"
          className="inline-flex items-center justify-center rounded-md bg-[var(--color-brand-600)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-brand-700)] transition-colors"
        >
          New pool
        </a>
      </div>

      {loading && <p className="text-sm text-[var(--color-fg-muted)]">Loading...</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}

      {!loading && !error && (
        <div className="overflow-x-auto rounded-lg border border-[var(--color-border)]">
          <table className="min-w-full text-sm">
            <thead className="bg-[var(--color-surface-2)] text-left">
              <tr>
                {["Name", "Strategy", "Active DIDs", "Quarantined", "Status", "Actions"].map((h) => (
                  <th key={h} className="px-4 py-3 font-medium text-[var(--color-fg-muted)]">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {pools.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-[var(--color-fg-muted)]">
                    No pools yet.
                  </td>
                </tr>
              )}
              {pools.map((p) => (
                <tr key={p.id} className="hover:bg-[var(--color-surface-2)]">
                  <td className="px-4 py-3 font-medium">
                    <a href={`/admin/number-pools/${p.id}`} className="text-[var(--color-brand-600)] hover:underline">
                      {p.name}
                    </a>
                  </td>
                  <td className="px-4 py-3 text-[var(--color-fg-muted)]">{strategyLabel(p.strategy)}</td>
                  <td className="px-4 py-3">
                    <span className={healthColor(p.avgHealthScore ?? 100)}>
                      {p.activeDids}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {p.quarantinedDids > 0 ? (
                      <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
                        {p.quarantinedDids}
                      </span>
                    ) : (
                      <span className="text-[var(--color-fg-muted)]">0</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {p.active ? (
                      <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">Active</span>
                    ) : (
                      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">Inactive</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <a href={`/admin/number-pools/${p.id}`} className="text-xs text-[var(--color-brand-600)] hover:underline">
                        View
                      </a>
                      <a href={`/admin/number-pools/${p.id}/edit`} className="text-xs text-[var(--color-brand-600)] hover:underline">
                        Edit
                      </a>
                      <button
                        onClick={() => void handleDelete(p.id)}
                        className="text-xs text-red-600 hover:underline"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
