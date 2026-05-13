"use client";
// I02 — IVR list page.
// Route: /admin/ivrs

import { useEffect, useState } from "react";
import Link from "next/link";

interface IvrSummary {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  phase: string;
  maxDepthValidated: number;
  _count?: { nodes: number };
}

async function fetchIvrs(): Promise<IvrSummary[]> {
  const res = await fetch("/api/admin/ivrs", { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load IVRs");
  return res.json() as Promise<IvrSummary[]>;
}

async function deleteIvr(id: string): Promise<void> {
  const res = await fetch(`/api/admin/ivrs/${id}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok && res.status !== 204) throw new Error("Delete failed");
}

export default function IvrsListPage(): React.ReactElement {
  const [ivrs, setIvrs] = useState<IvrSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = (): void => {
    setLoading(true);
    fetchIvrs()
      .then(setIvrs)
      .catch((e: unknown) => setError(String((e as Error).message)))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const handleDelete = (id: string, name: string): void => {
    if (!confirm(`Deactivate IVR "${name}"? Active calls are not affected.`)) return;
    deleteIvr(id)
      .then(load)
      .catch((e: unknown) => alert((e as Error).message));
  };

  return (
    <main>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold text-[var(--color-fg)]">IVR Trees</h1>
        <Link
          href="/admin/ivrs/new"
          className="px-4 py-2 rounded bg-[var(--color-accent)] text-white text-sm font-medium hover:opacity-90"
        >
          + New IVR
        </Link>
      </div>

      {error && (
        <p className="mb-4 text-sm text-red-500">{error}</p>
      )}

      {loading ? (
        <p className="text-sm text-[var(--color-fg-muted)]">Loading…</p>
      ) : ivrs.length === 0 ? (
        <div className="rounded border border-dashed border-[var(--color-border)] p-12 text-center">
          <p className="text-[var(--color-fg-muted)] text-sm">No IVRs yet.</p>
          <Link href="/admin/ivrs/new" className="mt-3 inline-block text-sm text-[var(--color-accent)] underline">
            Create your first IVR
          </Link>
        </div>
      ) : (
        <div className="overflow-x-auto rounded border border-[var(--color-border)]">
          <table className="min-w-full divide-y divide-[var(--color-border)]">
            <thead className="bg-[var(--color-surface-raised)]">
              <tr>
                {["Name", "Nodes", "Depth", "Phase", "Status", ""].map((h) => (
                  <th
                    key={h}
                    className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-[var(--color-fg-muted)]"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {ivrs.map((ivr) => (
                <tr key={ivr.id} className="hover:bg-[var(--color-surface-hover)]">
                  <td className="px-4 py-3 font-medium text-sm text-[var(--color-fg)]">
                    <Link href={`/admin/ivrs/${ivr.id}`} className="hover:underline">
                      {ivr.name}
                    </Link>
                    {ivr.description && (
                      <p className="text-xs text-[var(--color-fg-muted)] truncate max-w-xs">{ivr.description}</p>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-[var(--color-fg-muted)]">
                    {ivr._count?.nodes ?? 0}
                  </td>
                  <td className="px-4 py-3 text-sm text-[var(--color-fg-muted)]">
                    {ivr.maxDepthValidated}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    <span className="px-2 py-1 rounded-full bg-[var(--color-surface-raised)] text-[var(--color-fg-muted)]">
                      {ivr.phase}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs">
                    <span className={`px-2 py-1 rounded-full font-medium ${ivr.active ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>
                      {ivr.active ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right text-sm">
                    <Link
                      href={`/admin/ivrs/${ivr.id}`}
                      className="mr-3 text-[var(--color-accent)] hover:underline"
                    >
                      Edit
                    </Link>
                    <button
                      onClick={() => handleDelete(ivr.id, ivr.name)}
                      className="text-red-500 hover:underline"
                    >
                      Delete
                    </button>
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
