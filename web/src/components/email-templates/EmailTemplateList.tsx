"use client";

// N02 — Email template list component.
// Fetches all templates and displays them in a filterable table.

import { useState, useEffect, useCallback } from "react";

interface EmailTemplateDto {
  id: string;
  tenantId: string;
  category: string;
  lang: string;
  subject: string;
  active: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

const CATEGORIES = [
  "callback_due",
  "callback_upcoming",
  "import_complete",
  "import_failed",
  "recording_failed",
  "agent_disconnected",
  "drop_gate_engaged",
];

export function EmailTemplateList(): React.ReactElement {
  const [templates, setTemplates] = useState<EmailTemplateDto[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterCategory, setFilterCategory] = useState("");
  const [filterLang, setFilterLang] = useState("");
  const [filterActive, setFilterActive] = useState("true");
  const [testSendModalId, setTestSendModalId] = useState<string | null>(null);

  const fetchTemplates = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filterCategory) params.set("category", filterCategory);
      if (filterLang) params.set("lang", filterLang);
      params.set("active", filterActive);
      const res = await fetch(`/api/admin/email-templates?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { items: EmailTemplateDto[]; total: number };
      setTemplates(data.items);
      setTotal(data.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load templates");
    } finally {
      setLoading(false);
    }
  }, [filterCategory, filterLang, filterActive]);

  useEffect(() => {
    void fetchTemplates();
  }, [fetchTemplates]);

  const handleDelete = async (id: string): Promise<void> => {
    if (!confirm("Soft-delete this template? It will be marked inactive.")) return;
    try {
      const res = await fetch(`/api/admin/email-templates/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await fetchTemplates();
    } catch (err) {
      alert(`Delete failed: ${err instanceof Error ? err.message : "Unknown error"}`);
    }
  };

  return (
    <div>
      {/* Filters */}
      <div className="mb-4 flex flex-wrap gap-3">
        <select
          value={filterCategory}
          onChange={(e) => setFilterCategory(e.target.value)}
          className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm"
        >
          <option value="">All categories</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>{c.replace(/_/g, " ")}</option>
          ))}
        </select>
        <input
          type="text"
          placeholder="Language (e.g. en)"
          value={filterLang}
          onChange={(e) => setFilterLang(e.target.value)}
          className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm w-32"
        />
        <select
          value={filterActive}
          onChange={(e) => setFilterActive(e.target.value)}
          className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm"
        >
          <option value="true">Active</option>
          <option value="false">Inactive</option>
          <option value="all">All</option>
        </select>
      </div>

      {error && (
        <div className="mb-4 rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-12 rounded bg-[var(--color-surface-2)] animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="overflow-x-auto rounded border border-[var(--color-border)]">
          <table className="w-full text-sm">
            <thead className="bg-[var(--color-surface-2)]">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Category</th>
                <th className="px-4 py-2 text-left font-medium">Lang</th>
                <th className="px-4 py-2 text-left font-medium">Subject</th>
                <th className="px-4 py-2 text-left font-medium">Active</th>
                <th className="px-4 py-2 text-left font-medium">Version</th>
                <th className="px-4 py-2 text-left font-medium">Updated</th>
                <th className="px-4 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {templates.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-[var(--color-fg-muted)]">
                    No templates found.
                  </td>
                </tr>
              ) : (
                templates.map((tpl) => (
                  <tr key={tpl.id} className="hover:bg-[var(--color-surface-2)]">
                    <td className="px-4 py-2 font-mono text-xs">{tpl.category}</td>
                    <td className="px-4 py-2">{tpl.lang}</td>
                    <td className="px-4 py-2 max-w-xs truncate text-[var(--color-fg-muted)]"
                        title={tpl.subject}>{tpl.subject}</td>
                    <td className="px-4 py-2">
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${tpl.active ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-600"}`}>
                        {tpl.active ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-center">{tpl.version}</td>
                    <td className="px-4 py-2 text-[var(--color-fg-muted)]">
                      {new Date(tpl.updatedAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <a
                          href={`/admin/email-templates/${tpl.id}`}
                          className="text-[var(--color-brand-600)] hover:underline text-xs"
                        >
                          Edit
                        </a>
                        <button
                          onClick={() => setTestSendModalId(tpl.id)}
                          className="text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] text-xs"
                        >
                          Test send
                        </button>
                        <button
                          onClick={() => void handleDelete(tpl.id)}
                          className="text-red-500 hover:text-red-700 text-xs"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-2 text-xs text-[var(--color-fg-muted)]">{total} template{total !== 1 ? "s" : ""}</p>

      {testSendModalId && (
        <TestSendInlineModal
          templateId={testSendModalId}
          onClose={() => setTestSendModalId(null)}
        />
      )}
    </div>
  );
}

function TestSendInlineModal({
  templateId,
  onClose,
}: {
  templateId: string;
  onClose: () => void;
}): React.ReactElement {
  const [to, setTo] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const handleSend = async (): Promise<void> => {
    if (!to) return;
    setSending(true);
    try {
      const res = await fetch(`/api/admin/email-templates/${templateId}/test-send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to, sample_vars: {} }),
      });
      const data = await res.json() as { queued?: boolean; jobId?: string; error?: string; message?: string };
      if (res.ok && data.queued) {
        setResult(`Queued! Job ID: ${data.jobId ?? "unknown"}`);
      } else if (res.status === 429) {
        setResult(`Rate limited: ${data.message ?? "Too many test sends"}`);
      } else {
        setResult(`Error: ${data.error ?? "Unknown error"}`);
      }
    } catch (err) {
      setResult(`Error: ${err instanceof Error ? err.message : "Unknown"}`);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-md rounded-lg bg-[var(--color-surface)] p-6 shadow-xl">
        <h2 className="mb-4 text-lg font-semibold">Test Send</h2>
        <label className="block text-sm font-medium mb-1">Recipient email</label>
        <input
          type="email"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="test@example.com"
          className="w-full rounded border border-[var(--color-border)] px-3 py-2 text-sm mb-4"
        />
        {result && (
          <div className={`mb-4 rounded px-3 py-2 text-sm ${result.startsWith("Queued") ? "bg-green-50 text-green-800" : "bg-red-50 text-red-800"}`}>
            {result}
          </div>
        )}
        <div className="flex justify-end gap-3">
          <button onClick={onClose} className="text-sm text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]">
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
  );
}
