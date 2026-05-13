"use client";

// N02 — Email template create/edit form.
// Features: variable sidebar, live preview iframe, missing-var warning, version history.

import { useState, useEffect, useCallback, useRef } from "react";
import { EmailTemplatePreview } from "./EmailTemplatePreview";
import { VersionHistoryPanel } from "./VersionHistoryPanel";
import { TestSendModal } from "./TestSendModal";

const CATEGORIES = [
  "callback_due",
  "callback_upcoming",
  "import_complete",
  "import_failed",
  "recording_failed",
  "agent_disconnected",
  "drop_gate_engaged",
];

interface VarDef {
  path: string;
  description: string;
  example: string;
}

interface TemplateDto {
  id: string;
  category: string;
  lang: string;
  subject: string;
  htmlBody: string;
  textBody: string;
  active: boolean;
  version: number;
}

interface EmailTemplateFormProps {
  mode: "create" | "edit";
  templateId?: string;
}

export function EmailTemplateForm({ mode, templateId }: EmailTemplateFormProps): React.ReactElement {
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [lang, setLang] = useState("en");
  const [subject, setSubject] = useState("");
  const [htmlBody, setHtmlBody] = useState("");
  const [textBody, setTextBody] = useState("");
  const [active, setActive] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(mode === "edit");
  const [varDefs, setVarDefs] = useState<VarDef[]>([]);
  const [previewHtml, setPreviewHtml] = useState("");
  const [missingVars, setMissingVars] = useState<string[]>([]);
  const [showTestSend, setShowTestSend] = useState(false);
  const [activeTab, setActiveTab] = useState<"html" | "text">("html");
  const htmlRef = useRef<HTMLTextAreaElement>(null);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load template in edit mode
  useEffect(() => {
    if (mode !== "edit" || !templateId) return;
    const load = async (): Promise<void> => {
      try {
        const res = await fetch(`/api/admin/email-templates/${templateId}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const tpl = await res.json() as TemplateDto;
        setCategory(tpl.category);
        setLang(tpl.lang);
        setSubject(tpl.subject);
        setHtmlBody(tpl.htmlBody);
        setTextBody(tpl.textBody);
        setActive(tpl.active);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load template");
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, [mode, templateId]);

  // Load variable definitions when category changes
  useEffect(() => {
    const load = async (): Promise<void> => {
      try {
        const res = await fetch(`/api/admin/email-templates/vars/${category}`);
        if (res.ok) {
          const data = await res.json() as { vars: VarDef[] };
          setVarDefs(data.vars);
        }
      } catch {
        // ignore
      }
    };
    void load();
  }, [category]);

  // Live preview with 500ms debounce
  const refreshPreview = useCallback(async () => {
    if (!templateId || mode !== "edit") return;
    try {
      const sampleVars: Record<string, unknown> = {};
      for (const v of varDefs) {
        const parts = v.path.split(".");
        let cur: Record<string, unknown> = sampleVars;
        for (let i = 0; i < parts.length - 1; i++) {
          if (!cur[parts[i]]) cur[parts[i]] = {};
          cur = cur[parts[i]] as Record<string, unknown>;
        }
        cur[parts[parts.length - 1]] = v.example;
      }
      const res = await fetch(`/api/admin/email-templates/${templateId}/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sample_vars: sampleVars }),
      });
      if (res.ok) {
        const data = await res.json() as { html: string; missingVars: string[] };
        setPreviewHtml(data.html);
        setMissingVars(data.missingVars ?? []);
      }
    } catch {
      // ignore preview errors
    }
  }, [templateId, mode, varDefs]);

  useEffect(() => {
    if (previewTimer.current) clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(() => void refreshPreview(), 500);
    return () => {
      if (previewTimer.current) clearTimeout(previewTimer.current);
    };
  }, [htmlBody, refreshPreview]);

  const insertVar = (path: string): void => {
    const textarea = htmlRef.current;
    if (!textarea) {
      setHtmlBody((prev) => prev + `{{${path}}}`);
      return;
    }
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const newVal = htmlBody.slice(0, start) + `{{${path}}}` + htmlBody.slice(end);
    setHtmlBody(newVal);
    setTimeout(() => {
      textarea.selectionStart = textarea.selectionEnd = start + path.length + 4;
      textarea.focus();
    }, 0);
  };

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSuccess(null);

    try {
      let res: Response;
      if (mode === "create") {
        res = await fetch("/api/admin/email-templates", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ category, lang, subject, htmlBody, textBody, active }),
        });
      } else {
        res = await fetch(`/api/admin/email-templates/${templateId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subject, htmlBody, textBody, active }),
        });
      }

      if (res.status === 201) {
        const created = await res.json() as TemplateDto;
        setSuccess("Template created!");
        window.location.href = `/admin/email-templates/${created.id}`;
        return;
      }
      if (res.ok) {
        setSuccess("Template saved!");
        return;
      }
      const data = await res.json() as { error?: string; message?: string };
      setError(data.message ?? data.error ?? `HTTP ${res.status}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="animate-pulse h-64 bg-[var(--color-surface-2)] rounded" />;
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)}>
      {error && (
        <div className="mb-4 rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}
      {success && (
        <div className="mb-4 rounded border border-green-300 bg-green-50 px-4 py-3 text-sm text-green-700">{success}</div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main form */}
        <div className="lg:col-span-2 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Category</label>
              {mode === "create" ? (
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
                  required
                >
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>{c.replace(/_/g, " ")}</option>
                  ))}
                </select>
              ) : (
                <p className="text-sm font-mono bg-[var(--color-surface-2)] rounded px-3 py-2">{category}</p>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Language</label>
              {mode === "create" ? (
                <input
                  type="text"
                  value={lang}
                  onChange={(e) => setLang(e.target.value)}
                  placeholder="en"
                  maxLength={10}
                  className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
                />
              ) : (
                <p className="text-sm font-mono bg-[var(--color-surface-2)] rounded px-3 py-2">{lang}</p>
              )}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Subject</label>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              maxLength={255}
              required
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm font-mono"
              placeholder="e.g. Action required: Callback due — {{callback.leadName}}"
            />
          </div>

          {/* Tab switcher */}
          <div>
            <div className="flex border-b border-[var(--color-border)] mb-2">
              <button
                type="button"
                onClick={() => setActiveTab("html")}
                className={`px-4 py-2 text-sm font-medium border-b-2 ${activeTab === "html" ? "border-[var(--color-brand-600)] text-[var(--color-brand-600)]" : "border-transparent text-[var(--color-fg-muted)]"}`}
              >
                HTML Body
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("text")}
                className={`px-4 py-2 text-sm font-medium border-b-2 ${activeTab === "text" ? "border-[var(--color-brand-600)] text-[var(--color-brand-600)]" : "border-transparent text-[var(--color-fg-muted)]"}`}
              >
                Text Body
              </button>
            </div>

            {activeTab === "html" ? (
              <textarea
                ref={htmlRef}
                value={htmlBody}
                onChange={(e) => setHtmlBody(e.target.value)}
                rows={16}
                className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs font-mono"
                placeholder="HTML email body with Handlebars variables..."
              />
            ) : (
              <div>
                <p className="text-xs text-[var(--color-fg-muted)] mb-1">
                  Auto-generated from HTML on save if left unchanged. You may override.
                </p>
                <textarea
                  value={textBody}
                  onChange={(e) => setTextBody(e.target.value)}
                  rows={12}
                  className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs font-mono"
                  placeholder="Plain-text email body..."
                />
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="active"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
              className="rounded"
            />
            <label htmlFor="active" className="text-sm">Active</label>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={saving}
              className="rounded bg-[var(--color-brand-600)] px-5 py-2 text-sm font-medium text-white hover:bg-[var(--color-brand-700)] disabled:opacity-50"
            >
              {saving ? "Saving…" : mode === "create" ? "Create template" : "Save changes"}
            </button>
            {mode === "edit" && templateId && (
              <button
                type="button"
                onClick={() => setShowTestSend(true)}
                className="rounded border border-[var(--color-border)] px-4 py-2 text-sm hover:bg-[var(--color-surface-2)]"
              >
                Test send
              </button>
            )}
          </div>
        </div>

        {/* Variable sidebar */}
        <div className="space-y-4">
          <div className="rounded border border-[var(--color-border)] p-4">
            <h3 className="text-sm font-semibold mb-3">Variable Reference</h3>
            <p className="text-xs text-[var(--color-fg-muted)] mb-3">
              Click a variable to insert at cursor.
            </p>
            {varDefs.length === 0 ? (
              <p className="text-xs text-[var(--color-fg-muted)]">Loading variables…</p>
            ) : (
              <div className="space-y-2">
                {varDefs.map((v) => (
                  <div key={v.path} className="text-xs">
                    <button
                      type="button"
                      onClick={() => insertVar(v.path)}
                      className="font-mono text-[var(--color-brand-600)] hover:underline text-left"
                    >
                      {`{{${v.path}}}`}
                    </button>
                    <p className="text-[var(--color-fg-muted)] ml-1">{v.description}</p>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Preview */}
          {mode === "edit" && (
            <div>
              <h3 className="text-sm font-semibold mb-2">Live Preview</h3>
              <EmailTemplatePreview html={previewHtml} missingVars={missingVars} />
            </div>
          )}
        </div>
      </div>

      {/* Version history */}
      {mode === "edit" && templateId && (
        <VersionHistoryPanel templateId={templateId} />
      )}

      {/* Test send modal */}
      {showTestSend && templateId && (
        <TestSendModal
          templateId={templateId}
          category={category}
          onClose={() => setShowTestSend(false)}
        />
      )}
    </form>
  );
}
