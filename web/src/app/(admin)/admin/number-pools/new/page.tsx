"use client";

// X04 — Create number pool page.
// URL: /admin/number-pools/new

import * as React from "react";
import { useRouter } from "next/navigation";

const STRATEGIES = [
  { value: "health_weighted_lru", label: "Health-weighted LRU (recommended)" },
  { value: "round_robin", label: "Round-robin" },
  { value: "random", label: "Random" },
  { value: "least_recently_used", label: "Least recently used" },
] as const;

export default function NewPoolPage(): React.ReactElement {
  const router = useRouter();
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const [form, setForm] = React.useState({
    name: "",
    description: "",
    strategy: "health_weighted_lru",
    arFloor: 0.08,
    arMinSample: 200,
    crCeil: 0.05,
    crMinSample: 100,
    dailyCap: 200,
    minActiveSize: 3,
    maxConcurrent: 5,
  });

  const handleChange = (key: keyof typeof form, value: string | number): void => {
    setForm((f) => ({ ...f, [key]: value }));
  };

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/number-pools", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        const body = await res.json() as { message?: string };
        throw new Error(body.message ?? `HTTP ${res.status}`);
      }
      const pool = await res.json() as { id: string };
      router.push(`/admin/number-pools/${pool.id}`);
    } catch (err) {
      setError(String(err));
      setSaving(false);
    }
  };

  return (
    <main className="max-w-2xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-[var(--color-fg)]">New Number Pool</h1>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          Create a named pool of caller-ID numbers for outbound rotation.
        </p>
      </div>

      {error && (
        <div className="mb-4 rounded-md bg-red-50 px-4 py-3 text-sm text-red-700 border border-red-200">
          {error}
        </div>
      )}

      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-5">
        <div>
          <label className="block text-sm font-medium mb-1">Name *</label>
          <input
            type="text"
            required
            maxLength={128}
            value={form.name}
            onChange={(e) => handleChange("name", e.target.value)}
            className="w-full rounded-md border border-[var(--color-border)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-brand-600)]"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Description</label>
          <textarea
            value={form.description}
            onChange={(e) => handleChange("description", e.target.value)}
            rows={2}
            className="w-full rounded-md border border-[var(--color-border)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-brand-600)]"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Rotation strategy</label>
          <select
            value={form.strategy}
            onChange={(e) => handleChange("strategy", e.target.value)}
            className="w-full rounded-md border border-[var(--color-border)] px-3 py-2 text-sm"
          >
            {STRATEGIES.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </div>

        <fieldset className="rounded-lg border border-[var(--color-border)] p-4">
          <legend className="text-xs font-medium px-1 text-[var(--color-fg-muted)]">Quarantine thresholds</legend>
          <div className="grid grid-cols-2 gap-4 mt-2">
            {[
              { key: "arFloor", label: "AR floor (min answer rate)", step: "0.01" },
              { key: "arMinSample", label: "AR min sample (calls)", step: "1" },
              { key: "crCeil", label: "CR ceiling (max complaint proxy)", step: "0.01" },
              { key: "crMinSample", label: "CR min sample (calls)", step: "1" },
              { key: "dailyCap", label: "Daily cap (calls/DID)", step: "1" },
              { key: "minActiveSize", label: "Min active pool size", step: "1" },
              { key: "maxConcurrent", label: "Max concurrent calls/DID", step: "1" },
            ].map(({ key, label, step }) => (
              <div key={key}>
                <label className="block text-xs text-[var(--color-fg-muted)] mb-1">{label}</label>
                <input
                  type="number"
                  step={step}
                  value={form[key as keyof typeof form]}
                  onChange={(e) => handleChange(key as keyof typeof form, parseFloat(e.target.value))}
                  className="w-full rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm"
                />
              </div>
            ))}
          </div>
        </fieldset>

        <div className="flex items-center gap-3 pt-2">
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-[var(--color-brand-600)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-brand-700)] disabled:opacity-50"
          >
            {saving ? "Creating..." : "Create pool"}
          </button>
          <button
            type="button"
            onClick={() => router.back()}
            className="rounded-md border border-[var(--color-border)] px-4 py-2 text-sm font-medium hover:bg-[var(--color-surface-2)]"
          >
            Cancel
          </button>
        </div>
      </form>
    </main>
  );
}
