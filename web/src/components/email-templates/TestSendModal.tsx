"use client";

// N02 — Test-send modal component.
// Rate-limited: 5 test sends per user per hour.

import { useState } from "react";

interface VarField {
  path: string;
  description: string;
  example: string;
}

interface TestSendModalProps {
  templateId: string;
  category: string;
  onClose: () => void;
}

export function TestSendModal({
  templateId,
  category,
  onClose,
}: TestSendModalProps): React.ReactElement {
  const [to, setTo] = useState("");
  const [varFields, setVarFields] = useState<VarField[]>([]);
  const [varValues, setVarValues] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [loadingVars, setLoadingVars] = useState(true);

  // Load variable vocabulary for this category
  useState(() => {
    const load = async (): Promise<void> => {
      try {
        const res = await fetch(`/api/admin/email-templates/vars/${category}`);
        if (res.ok) {
          const data = await res.json() as { vars: VarField[] };
          setVarFields(data.vars);
          const defaults: Record<string, string> = {};
          for (const v of data.vars) {
            defaults[v.path] = v.example;
          }
          setVarValues(defaults);
        }
      } finally {
        setLoadingVars(false);
      }
    };
    void load();
  });

  const buildNestedVars = (flat: Record<string, string>): Record<string, unknown> => {
    const result: Record<string, unknown> = {};
    for (const [path, val] of Object.entries(flat)) {
      const parts = path.split(".");
      let cur: Record<string, unknown> = result;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!cur[parts[i]]) cur[parts[i]] = {};
        cur = cur[parts[i]] as Record<string, unknown>;
      }
      cur[parts[parts.length - 1]] = val;
    }
    return result;
  };

  const handleSend = async (): Promise<void> => {
    if (!to) return;
    setSending(true);
    setResult(null);
    try {
      const res = await fetch(`/api/admin/email-templates/${templateId}/test-send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to,
          sample_vars: buildNestedVars(varValues),
        }),
      });
      const data = await res.json() as { queued?: boolean; jobId?: string; error?: string; message?: string };
      if (res.ok && data.queued) {
        setResult({ ok: true, message: `Queued! Job ID: ${data.jobId ?? "unknown"}` });
      } else if (res.status === 429) {
        setResult({ ok: false, message: data.message ?? "Rate limit exceeded (5 sends/hour)" });
      } else {
        setResult({ ok: false, message: data.message ?? data.error ?? "Unknown error" });
      }
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : "Unknown error" });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-lg max-h-[90vh] overflow-auto rounded-lg bg-[var(--color-surface)] p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Test Send</h2>
          <button onClick={onClose} className="text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]">✕</button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Recipient email</label>
            <input
              type="email"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="test@example.com"
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
            />
          </div>

          {loadingVars ? (
            <div className="animate-pulse h-20 bg-[var(--color-surface-2)] rounded" />
          ) : (
            <div>
              <p className="text-sm font-medium mb-2">Sample variables</p>
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {varFields.filter((v) => v.path !== "unsubscribeUrl").map((v) => (
                  <div key={v.path}>
                    <label className="block text-xs font-mono text-[var(--color-fg-muted)] mb-0.5">
                      {v.path}
                    </label>
                    <input
                      type="text"
                      value={varValues[v.path] ?? ""}
                      onChange={(e) => setVarValues((prev) => ({ ...prev, [v.path]: e.target.value }))}
                      className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs"
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {result && (
            <div className={`rounded px-3 py-2 text-sm ${result.ok ? "bg-green-50 text-green-800" : "bg-red-50 text-red-800"}`}>
              {result.message}
            </div>
          )}

          <p className="text-xs text-[var(--color-fg-muted)]">
            Rate limited to 5 test sends per hour per user.
          </p>

          <div className="flex justify-end gap-3 pt-2">
            <button
              onClick={onClose}
              className="text-sm text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
            >
              Cancel
            </button>
            <button
              onClick={() => void handleSend()}
              disabled={sending || !to}
              className="rounded bg-[var(--color-brand-600)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-brand-700)] disabled:opacity-50"
            >
              {sending ? "Sending…" : "Send test"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
