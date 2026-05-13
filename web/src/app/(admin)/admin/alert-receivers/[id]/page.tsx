// O03 — Admin: edit alert receiver + test button.
// URL: /admin/alert-receivers/[id]

"use client";

import { useEffect, useState } from "react";
import { useRouter, useParams } from "next/navigation";

interface AlertReceiver {
  id: string;
  name: string;
  kind: "slack" | "pagerduty" | "webhook";
  config: Record<string, unknown>;
  active: boolean;
  severityFilter: string;
}

export default function EditAlertReceiverPage(): React.ReactElement {
  const router = useRouter();
  const params = useParams();
  const id = params["id"] as string;

  const [receiver, setReceiver] = useState<AlertReceiver | null>(null);
  const [name, setName] = useState("");
  const [severityFilter, setSeverityFilter] = useState("");
  const [active, setActive] = useState(true);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/admin/alert-receivers/${id}`)
      .then((r) => r.json())
      .then((data: AlertReceiver) => {
        setReceiver(data);
        setName(data.name);
        setSeverityFilter(data.severityFilter);
        setActive(data.active);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [id]);

  const handleSave = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setSuccessMsg(null);

    try {
      const res = await fetch(`/api/admin/alert-receivers/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, severityFilter, active }),
      });
      if (res.ok) {
        setSuccessMsg("Receiver updated.");
      } else {
        const body = await res.json().catch(() => ({}));
        setError((body as { message?: string }).message ?? "Update failed.");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const handleTest = async (): Promise<void> => {
    setTesting(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const res = await fetch(`/api/admin/alert-receivers/${id}/test`, { method: "POST" });
      if (res.ok) {
        setSuccessMsg("Test alert queued. Check the receiver endpoint.");
      } else {
        const body = await res.json().catch(() => ({}));
        setError((body as { message?: string }).message ?? "Test failed.");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setTesting(false);
    }
  };

  const handleDelete = async (): Promise<void> => {
    if (!confirm("Deactivate this receiver?")) return;
    try {
      const res = await fetch(`/api/admin/alert-receivers/${id}`, { method: "DELETE" });
      if (res.ok || res.status === 204) {
        router.push("/admin/alert-receivers");
      } else {
        setError("Delete failed.");
      }
    } catch (e) {
      setError(String(e));
    }
  };

  if (loading) {
    return (
      <main className="max-w-lg">
        <div className="space-y-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-10 animate-pulse rounded-md bg-[var(--color-surface-muted)]" />
          ))}
        </div>
      </main>
    );
  }

  if (!receiver) {
    return (
      <main className="max-w-lg">
        <p className="text-sm text-red-600">Receiver not found.</p>
        <a href="/admin/alert-receivers" className="mt-2 text-sm underline text-[var(--color-brand-600)]">
          Back to receivers
        </a>
      </main>
    );
  }

  return (
    <main className="max-w-lg">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--color-fg)]">
            Edit receiver
          </h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            {receiver.kind} · {receiver.id}
          </p>
        </div>
        <button
          onClick={() => void handleTest()}
          disabled={testing}
          className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)] disabled:opacity-50 transition-colors"
        >
          {testing ? "Sending..." : "Send test alert"}
        </button>
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {successMsg && (
        <div className="mb-4 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">
          {successMsg}
        </div>
      )}

      <form onSubmit={(e) => void handleSave(e)} className="space-y-5">
        <div>
          <label className="block text-sm font-medium text-[var(--color-fg)] mb-1" htmlFor="name">
            Name
          </label>
          <input
            id="name"
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-brand-500)]"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-[var(--color-fg)] mb-1" htmlFor="severity">
            Severity filter
          </label>
          <input
            id="severity"
            type="text"
            value={severityFilter}
            onChange={(e) => setSeverityFilter(e.target.value)}
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-brand-500)]"
          />
        </div>

        <div className="flex items-center gap-2">
          <input
            id="active"
            type="checkbox"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
            className="h-4 w-4 rounded border-[var(--color-border)] text-[var(--color-brand-600)]"
          />
          <label className="text-sm text-[var(--color-fg)]" htmlFor="active">
            Active
          </label>
        </div>

        <div className="flex gap-3 pt-2">
          <button
            type="submit"
            disabled={submitting}
            className="rounded-md bg-[var(--color-brand-600)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-brand-700)] disabled:opacity-50 transition-colors"
          >
            {submitting ? "Saving..." : "Save changes"}
          </button>
          <a
            href="/admin/alert-receivers"
            className="rounded-md border border-[var(--color-border)] px-4 py-2 text-sm font-medium text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)] transition-colors"
          >
            Cancel
          </a>
          <button
            type="button"
            onClick={() => void handleDelete()}
            className="ml-auto rounded-md border border-red-200 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 transition-colors"
          >
            Deactivate
          </button>
        </div>
      </form>
    </main>
  );
}
