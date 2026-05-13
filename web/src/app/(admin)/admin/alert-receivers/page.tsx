// O03 — Admin alert-receivers list page.
// URL: /admin/alert-receivers

"use client";

import { useEffect, useState } from "react";

interface AlertReceiver {
  id: string;
  name: string;
  kind: "slack" | "pagerduty" | "webhook";
  active: boolean;
  severityFilter: string;
  createdAt: string;
  updatedAt: string;
}

const KIND_LABELS: Record<string, string> = {
  slack: "Slack",
  pagerduty: "PagerDuty",
  webhook: "Webhook",
};

const KIND_BADGE_COLORS: Record<string, string> = {
  slack: "bg-purple-100 text-purple-800",
  pagerduty: "bg-green-100 text-green-800",
  webhook: "bg-blue-100 text-blue-800",
};

export default function AlertReceiversPage(): React.ReactElement {
  const [receivers, setReceivers] = useState<AlertReceiver[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admin/alert-receivers")
      .then((r) => r.json())
      .then((data: { data: AlertReceiver[] }) => {
        setReceivers(data.data ?? []);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  const handleTest = async (id: string): Promise<void> => {
    try {
      const res = await fetch(`/api/admin/alert-receivers/${id}/test`, {
        method: "POST",
      });
      if (res.ok) {
        alert("Test alert queued successfully.");
      } else {
        const body = await res.json().catch(() => ({}));
        alert(`Test failed: ${JSON.stringify(body)}`);
      }
    } catch (e) {
      alert(`Test failed: ${String(e)}`);
    }
  };

  return (
    <main>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--color-fg)]">Alert Receivers</h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            Configure where alerts are delivered: Slack, PagerDuty, or custom webhooks.
          </p>
        </div>
        <a
          href="/admin/alert-receivers/new"
          className="inline-flex items-center justify-center rounded-md bg-[var(--color-brand-600)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-brand-700)] transition-colors"
        >
          Add receiver
        </a>
      </div>

      {loading && (
        <div className="space-y-2" role="status" aria-label="Loading receivers">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="h-14 animate-pulse rounded-md bg-[var(--color-surface-muted)]"
              aria-hidden
            />
          ))}
        </div>
      )}

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          Failed to load receivers: {error}
        </div>
      )}

      {!loading && !error && receivers.length === 0 && (
        <div className="rounded-md border border-[var(--color-border)] p-8 text-center text-sm text-[var(--color-fg-muted)]">
          No alert receivers configured yet.
        </div>
      )}

      {!loading && !error && receivers.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-[var(--color-border)]">
          <table className="w-full text-sm">
            <thead className="bg-[var(--color-surface-muted)]">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-[var(--color-fg-muted)]">Name</th>
                <th className="px-4 py-3 text-left font-medium text-[var(--color-fg-muted)]">Kind</th>
                <th className="px-4 py-3 text-left font-medium text-[var(--color-fg-muted)]">Severity filter</th>
                <th className="px-4 py-3 text-left font-medium text-[var(--color-fg-muted)]">Status</th>
                <th className="px-4 py-3 text-right font-medium text-[var(--color-fg-muted)]">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {receivers.map((r) => (
                <tr key={r.id} className="hover:bg-[var(--color-surface-muted)] transition-colors">
                  <td className="px-4 py-3 font-medium text-[var(--color-fg)]">{r.name}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${KIND_BADGE_COLORS[r.kind] ?? "bg-gray-100 text-gray-800"}`}
                    >
                      {KIND_LABELS[r.kind] ?? r.kind}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-[var(--color-fg-muted)]">
                    <code className="rounded bg-[var(--color-surface-muted)] px-1.5 py-0.5 text-xs">
                      {r.severityFilter}
                    </code>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${r.active ? "bg-emerald-100 text-emerald-800" : "bg-gray-100 text-gray-500"}`}
                    >
                      {r.active ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="inline-flex gap-2">
                      <button
                        onClick={() => void handleTest(r.id)}
                        className="rounded px-2.5 py-1 text-xs font-medium text-[var(--color-brand-600)] hover:bg-[var(--color-surface-muted)] transition-colors"
                      >
                        Test
                      </button>
                      <a
                        href={`/admin/alert-receivers/${r.id}`}
                        className="rounded px-2.5 py-1 text-xs font-medium text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)] transition-colors"
                      >
                        Edit
                      </a>
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
