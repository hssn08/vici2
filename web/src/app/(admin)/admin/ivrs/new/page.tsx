"use client";
// I02 — Create IVR page.
// Route: /admin/ivrs/new

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function NewIvrPage(): React.ReactElement {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/ivrs", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description: description || null }),
      });
      if (!res.ok) {
        const body = await res.json() as { message?: string };
        throw new Error(body.message ?? "Failed to create IVR");
      }
      const ivr = await res.json() as { id: string };
      router.push(`/admin/ivrs/${ivr.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="max-w-lg">
      <h1 className="text-2xl font-semibold text-[var(--color-fg)] mb-6">New IVR</h1>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-[var(--color-fg)] mb-1">
            Name <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={128}
            className="w-full rounded border border-[var(--color-border)] px-3 py-2 text-sm bg-[var(--color-surface)] text-[var(--color-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
            placeholder="Main Menu"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-[var(--color-fg)] mb-1">
            Description
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            maxLength={2000}
            className="w-full rounded border border-[var(--color-border)] px-3 py-2 text-sm bg-[var(--color-surface)] text-[var(--color-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
            placeholder="Optional description…"
          />
        </div>

        {error && <p className="text-sm text-red-500">{error}</p>}

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={saving || !name.trim()}
            className="px-4 py-2 rounded bg-[var(--color-accent)] text-white text-sm font-medium disabled:opacity-50 hover:opacity-90"
          >
            {saving ? "Creating…" : "Create IVR"}
          </button>
          <a
            href="/admin/ivrs"
            className="px-4 py-2 rounded border border-[var(--color-border)] text-sm text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)]"
          >
            Cancel
          </a>
        </div>
      </form>
    </main>
  );
}
