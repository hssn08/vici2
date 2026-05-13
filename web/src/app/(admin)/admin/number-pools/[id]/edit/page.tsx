"use client";

// X04 — Edit number pool settings page.
// URL: /admin/number-pools/[id]/edit

import * as React from "react";
import { useParams, useRouter } from "next/navigation";

const STRATEGIES = [
  { value: "health_weighted_lru", label: "Health-weighted LRU (recommended)" },
  { value: "round_robin", label: "Round-robin" },
  { value: "random", label: "Random" },
  { value: "least_recently_used", label: "Least recently used" },
] as const;

type FormState = {
  name: string;
  description: string;
  strategy: string;
  arFloor: number;
  arMinSample: number;
  crCeil: number;
  crMinSample: number;
  dailyCap: number;
  minActiveSize: number;
  maxConcurrent: number;
};

export default function EditPoolPage(): React.ReactElement {
  const params = useParams() as { id: string };
  const router = useRouter();
  const poolId = params.id;

  const [form, setForm] = React.useState<FormState | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    fetch(`/api/admin/number-pools/${poolId}`)
      .then((r) => r.json())
      .then((data: FormState) => setForm(data))
      .catch((e) => setError(String(e)));
  }, [poolId]);

  const handleChange = (key: keyof FormState, value: string | number): void => {
    setForm((f) => f ? { ...f, [key]: value } : f);
  };

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!form) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/number-pools/${poolId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        const body = await res.json() as { message?: string };
        throw new Error(body.message ?? `HTTP ${res.status}`);
      }
      router.push(`/admin/number-pools/${poolId}`);
    } catch (err) {
      setError(String(err));
      setSaving(false);
    }
  };

  if (!form) return <main><p className="text-sm text-[var(--color-fg-muted)]">Loading...</p></main>;

  return (
    <main className="max-w-2xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-[var(--color-fg)]">Edit Pool: {form.name}</h1>
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
            className="w-full rounded-md border border-[var(--color-border)] px-3 py-2 text-sm"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Description</label>
          <textarea
            value={form.description ?? ""}
            onChange={(e) => handleChange("description", e.target.value)}
            rows={2}
            className="w-full rounded-md border border-[var(--color-border)] px-3 py-2 text-sm"
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
            {([
              ["arFloor", "AR floor"],
              ["arMinSample", "AR min sample"],
              ["crCeil", "CR ceiling"],
              ["crMinSample", "CR min sample"],
              ["dailyCap", "Daily cap"],
              ["minActiveSize", "Min active size"],
              ["maxConcurrent", "Max concurrent"],
            ] as [keyof FormState, string][]).map(([key, label]) => (
              <div key={key}>
                <label className="block text-xs text-[var(--color-fg-muted)] mb-1">{label}</label>
                <input
                  type="number"
                  step={["arFloor", "crCeil"].includes(key) ? "0.01" : "1"}
                  value={form[key] as number}
                  onChange={(e) => handleChange(key, parseFloat(e.target.value))}
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
            {saving ? "Saving..." : "Save changes"}
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
