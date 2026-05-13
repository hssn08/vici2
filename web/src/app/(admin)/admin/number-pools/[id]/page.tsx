"use client";

// X04 — Number pool detail page (members + quarantine management).
// URL: /admin/number-pools/[id]

import * as React from "react";
import { useParams } from "next/navigation";

interface PoolDetail {
  id: string;
  name: string;
  strategy: string;
  activeDids: number;
  quarantinedDids: number;
  active: boolean;
  arFloor: number;
  crCeil: number;
  dailyCap: number;
  minActiveSize: number;
  maxConcurrent: number;
}

interface DidMember {
  id: string;
  didId: string;
  e164: string;
  areaCode: string;
  quarantined: boolean;
  healthScore: number;
  answerRate7d: number;
  callCount7d: number;
  dailyCallCount: number;
  concurrentCalls: number;
  lastUsedAt: string | null;
  attestLevel: string;
  quarantineReason: string | null;
}

function healthColor(score: number): string {
  if (score > 75) return "text-green-600";
  if (score >= 40) return "text-yellow-600";
  return "text-red-600";
}

export default function PoolDetailPage(): React.ReactElement {
  const params = useParams() as { id: string };
  const poolId = params.id;

  const [pool, setPool] = React.useState<PoolDetail | null>(null);
  const [dids, setDids] = React.useState<DidMember[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [addDidInput, setAddDidInput] = React.useState("");
  const [addAttestLevel, setAddAttestLevel] = React.useState("unknown");
  const [adding, setAdding] = React.useState(false);

  const fetchData = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [poolRes, didsRes] = await Promise.all([
        fetch(`/api/admin/number-pools/${poolId}`),
        fetch(`/api/admin/number-pools/${poolId}/dids?pageSize=200`),
      ]);
      if (!poolRes.ok) throw new Error(`Pool fetch: HTTP ${poolRes.status}`);
      setPool(await poolRes.json() as PoolDetail);
      if (didsRes.ok) {
        const d = await didsRes.json() as { data: DidMember[] };
        setDids(d.data ?? []);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [poolId]);

  React.useEffect(() => { void fetchData(); }, [fetchData]);

  const handleAddDid = async (): Promise<void> => {
    if (!addDidInput.trim()) return;
    setAdding(true);
    try {
      const res = await fetch(`/api/admin/number-pools/${poolId}/dids`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ didId: addDidInput.trim(), attestLevel: addAttestLevel }),
      });
      if (!res.ok) {
        const body = await res.json() as { message?: string };
        alert(body.message ?? `HTTP ${res.status}`);
        return;
      }
      setAddDidInput("");
      void fetchData();
    } finally {
      setAdding(false);
    }
  };

  const handleQuarantine = async (didId: string): Promise<void> => {
    if (!confirm("Quarantine this DID?")) return;
    await fetch(`/api/admin/number-pools/${poolId}/dids/${didId}/quarantine`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "manual" }),
    });
    void fetchData();
  };

  const handleUnquarantine = async (didId: string): Promise<void> => {
    await fetch(`/api/admin/number-pools/${poolId}/dids/${didId}/unquarantine`, { method: "POST" });
    void fetchData();
  };

  const handleRemove = async (didId: string): Promise<void> => {
    if (!confirm("Remove this DID from the pool?")) return;
    await fetch(`/api/admin/number-pools/${poolId}/dids/${didId}`, { method: "DELETE" });
    void fetchData();
  };

  if (loading) return <main><p className="text-sm text-[var(--color-fg-muted)]">Loading...</p></main>;
  if (error) return <main><p className="text-sm text-red-600">{error}</p></main>;
  if (!pool) return <main><p className="text-sm text-red-600">Pool not found.</p></main>;

  return (
    <main>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--color-fg)]">{pool.name}</h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            {pool.activeDids} active &bull; {pool.quarantinedDids} quarantined &bull; {pool.strategy}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a
            href={`/admin/number-pools/${poolId}/edit`}
            className="rounded-md border border-[var(--color-border)] px-4 py-2 text-sm font-medium hover:bg-[var(--color-surface-2)]"
          >
            Edit settings
          </a>
          <a
            href="/admin/number-pools"
            className="text-sm text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
          >
            All pools
          </a>
        </div>
      </div>

      {/* Add DID */}
      <div className="mb-6 flex items-end gap-3">
        <div className="flex-1">
          <label className="block text-sm font-medium mb-1">Add DID by ID</label>
          <input
            type="text"
            placeholder="DID ID"
            value={addDidInput}
            onChange={(e) => setAddDidInput(e.target.value)}
            className="w-full rounded-md border border-[var(--color-border)] px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Attest level</label>
          <select
            value={addAttestLevel}
            onChange={(e) => setAddAttestLevel(e.target.value)}
            className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm"
          >
            {["unknown", "A", "B", "C"].map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
        <button
          onClick={() => void handleAddDid()}
          disabled={adding || !addDidInput.trim()}
          className="rounded-md bg-[var(--color-brand-600)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-brand-700)] disabled:opacity-50"
        >
          Add DID
        </button>
      </div>

      {/* Members table */}
      <div className="overflow-x-auto rounded-lg border border-[var(--color-border)]">
        <table className="min-w-full text-sm">
          <thead className="bg-[var(--color-surface-2)] text-left">
            <tr>
              {["E.164", "AC", "Health", "AR 7d", "Daily", "Conc.", "Attest", "Status", "Actions"].map((h) => (
                <th key={h} className="px-3 py-3 font-medium text-[var(--color-fg-muted)]">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            {dids.length === 0 && (
              <tr>
                <td colSpan={9} className="px-3 py-8 text-center text-[var(--color-fg-muted)]">
                  No DIDs in this pool.
                </td>
              </tr>
            )}
            {dids.map((m) => (
              <tr key={m.id} className={`hover:bg-[var(--color-surface-2)] ${m.quarantined ? "opacity-60" : ""}`}>
                <td className="px-3 py-2 font-mono">{m.e164}</td>
                <td className="px-3 py-2 text-[var(--color-fg-muted)]">{m.areaCode || "—"}</td>
                <td className={`px-3 py-2 font-medium ${healthColor(m.healthScore)}`}>{m.healthScore}</td>
                <td className="px-3 py-2">{m.callCount7d > 0 ? `${(m.answerRate7d * 100).toFixed(1)}%` : "—"}</td>
                <td className="px-3 py-2">{m.dailyCallCount}</td>
                <td className="px-3 py-2">{m.concurrentCalls}</td>
                <td className="px-3 py-2 text-[var(--color-fg-muted)]">{m.attestLevel}</td>
                <td className="px-3 py-2">
                  {m.quarantined ? (
                    <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
                      Quarantined{m.quarantineReason ? ` (${m.quarantineReason})` : ""}
                    </span>
                  ) : (
                    <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">Active</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    {m.quarantined ? (
                      <button onClick={() => void handleUnquarantine(m.didId)} className="text-xs text-green-600 hover:underline">
                        Unquarantine
                      </button>
                    ) : (
                      <button onClick={() => void handleQuarantine(m.didId)} className="text-xs text-yellow-600 hover:underline">
                        Quarantine
                      </button>
                    )}
                    <button onClick={() => void handleRemove(m.didId)} className="text-xs text-red-600 hover:underline">
                      Remove
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
