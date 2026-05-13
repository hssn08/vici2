"use client";

// S03 — Admin script create/edit form.
//
// Fields: name, campaignId (optional), active toggle, body (textarea + variable reference sidebar).
// On create: POST /api/admin/scripts → redirect to /admin/scripts/:id
// On update: PATCH /api/admin/scripts/:id → stay on page (version bumped notification)

import * as React from "react";
import { apiFetch, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ScriptVariable {
  name: string;
  description?: string;
}

interface ScriptResponse {
  id: string;
  name: string;
  body: string;
  campaignId: string | null;
  active: boolean;
  version: number;
  variables: ScriptVariable[];
  createdAt: string;
  updatedAt: string;
}

// Frozen variable vocabulary for the reference sidebar
const VARIABLE_VOCAB: Array<{ token: string; description: string }> = [
  { token: "{lead.first_name}", description: "Lead's first name" },
  { token: "{lead.last_name}", description: "Lead's last name" },
  { token: "{lead.phone_formatted}", description: "Formatted phone number (e.g. (555) 123-4567)" },
  { token: "{lead.email}", description: "Lead's email address" },
  { token: "{lead.city}", description: "Lead's city" },
  { token: "{lead.state}", description: "Lead's state (2-letter code)" },
  { token: "{lead.custom.FIELD}", description: "Custom data field — replace FIELD with key name" },
  { token: "{agent.name}", description: "Agent's full name" },
  { token: "{campaign.name}", description: "Campaign name" },
  { token: "{call.duration}", description: "Call duration as MM:SS" },
];

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ScriptFormProps {
  mode: "create" | "edit";
  scriptId?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ScriptForm({ mode, scriptId }: ScriptFormProps): React.ReactElement {
  const [name, setName] = React.useState("");
  const [body, setBody] = React.useState("");
  const [campaignId, setCampaignId] = React.useState("");
  const [active, setActive] = React.useState(true);
  const [version, setVersion] = React.useState(1);
  const [loading, setLoading] = React.useState(mode === "edit");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<string | null>(null);

  // Detected variables (auto-scanned from body)
  const detectedVars = React.useMemo(() => {
    const found = new Set<string>();
    for (const [, token] of body.matchAll(/\{([a-z][a-z0-9_.]*)\}/gi)) {
      found.add(token.toLowerCase());
    }
    return [...found].sort();
  }, [body]);

  // Load existing script in edit mode
  React.useEffect(() => {
    if (mode !== "edit" || !scriptId) return;

    apiFetch<ScriptResponse>(`/api/admin/scripts/${scriptId}`)
      .then((data) => {
        setName(data.name);
        setBody(data.body);
        setCampaignId(data.campaignId ?? "");
        setActive(data.active);
        setVersion(data.version);
      })
      .catch((err) => {
        setError(err instanceof ApiError ? err.message : "Failed to load script");
      })
      .finally(() => setLoading(false));
  }, [mode, scriptId]);

  // Insert token at cursor position in textarea
  function insertToken(token: string) {
    const ta = document.getElementById("script-body") as HTMLTextAreaElement | null;
    if (!ta) return;
    const start = ta.selectionStart ?? body.length;
    const end = ta.selectionEnd ?? body.length;
    const next = body.slice(0, start) + token + body.slice(end);
    setBody(next);
    // Restore cursor after inserted token
    requestAnimationFrame(() => {
      ta.selectionStart = start + token.length;
      ta.selectionEnd = start + token.length;
      ta.focus();
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSuccess(null);

    try {
      if (mode === "create") {
        const created = await apiFetch<ScriptResponse>("/api/admin/scripts", {
          method: "POST",
          body: { name, body, campaignId: campaignId || null, active },
        });
        // Redirect to edit page after creation
        window.location.href = `/admin/scripts/${created.id}`;
      } else {
        const updated = await apiFetch<ScriptResponse>(`/api/admin/scripts/${scriptId}`, {
          method: "PATCH",
          body: { name, body, campaignId: campaignId || null, active },
        });
        setVersion(updated.version);
        setSuccess(`Saved as version ${updated.version}`);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save script");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-10 animate-pulse rounded-md bg-[var(--color-surface-muted)]" />
        ))}
        <div className="h-64 animate-pulse rounded-md bg-[var(--color-surface-muted)]" />
      </div>
    );
  }

  return (
    <form onSubmit={(e: React.FormEvent<HTMLFormElement>) => void handleSubmit(e)} className="space-y-6">
      {/* Error / success banners */}
      {error && (
        <div role="alert" className="rounded-md bg-[var(--color-state-error-bg)] p-3 text-sm text-[var(--color-state-error)]">
          {error}
        </div>
      )}
      {success && (
        <div role="status" className="rounded-md bg-green-50 p-3 text-sm text-green-700">
          {success}
        </div>
      )}

      {/* Name */}
      <div className="space-y-1">
        <label htmlFor="script-name" className="text-sm font-medium text-[var(--color-fg)]">
          Name <span aria-hidden className="text-[var(--color-state-error)]">*</span>
        </label>
        <Input
          id="script-name"
          value={name}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
          maxLength={64}
          required
          placeholder="e.g. Outbound Sales Script"
        />
      </div>

      {/* Campaign ID */}
      <div className="space-y-1">
        <label htmlFor="script-campaign" className="text-sm font-medium text-[var(--color-fg)]">
          Campaign ID <span className="text-[var(--color-fg-muted)]">(optional — leave blank for all campaigns)</span>
        </label>
        <Input
          id="script-campaign"
          value={campaignId}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCampaignId(e.target.value)}
          maxLength={32}
          placeholder="e.g. OUTBOUND1"
        />
      </div>

      {/* Active */}
      <div className="flex items-center gap-3">
        <input
          id="script-active"
          type="checkbox"
          checked={active}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setActive(e.target.checked)}
          className="h-4 w-4 rounded border-[var(--color-border)] accent-[var(--color-brand-600)]"
        />
        <label htmlFor="script-active" className="text-sm font-medium text-[var(--color-fg)]">
          Active (visible to agents)
        </label>
      </div>

      {/* Body + Variable Reference */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_280px]">
        {/* Body textarea */}
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <label htmlFor="script-body" className="text-sm font-medium text-[var(--color-fg)]">
              Script body
            </label>
            {mode === "edit" && (
              <div className="flex items-center gap-3">
                <span className="text-xs text-[var(--color-fg-muted)]">v{version}</span>
                <a
                  href={scriptId ? `/admin/scripts/${scriptId}/preview` : "#"}
                  className="text-xs text-[var(--color-brand-600)] hover:underline"
                  target="_blank"
                  rel="noreferrer"
                >
                  Open preview
                </a>
              </div>
            )}
          </div>
          <textarea
            id="script-body"
            value={body}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setBody(e.target.value)}
            maxLength={65535}
            rows={20}
            className={cn(
              "w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]",
              "px-3 py-2 text-sm font-mono text-[var(--color-fg)] placeholder-[var(--color-fg-muted)]",
              "focus:outline-none focus:ring-2 focus:ring-[var(--color-brand-600)]",
              "resize-y min-h-[400px]",
            )}
            placeholder="<p>Hello {lead.first_name}, this is {agent.name} calling from {campaign.name}...</p>"
            aria-label="Script body — supports HTML and {variable} tokens"
          />
          <div className="flex items-center justify-between">
            <p className="text-xs text-[var(--color-fg-muted)]">
              HTML and <code>{"{variable}"}</code> tokens are supported.
            </p>
            <span className="text-xs text-[var(--color-fg-muted)]">
              {body.length.toLocaleString()} / 65,535 chars
            </span>
          </div>
        </div>

        {/* Variable reference sidebar */}
        <aside className="space-y-3">
          <h2 className="text-sm font-medium text-[var(--color-fg)]">Variable reference</h2>
          <p className="text-xs text-[var(--color-fg-muted)]">
            Click a token to insert it at your cursor position.
          </p>
          <div className="space-y-1">
            {VARIABLE_VOCAB.map(({ token, description }) => (
              <button
                key={token}
                type="button"
                onClick={() => insertToken(token)}
                className={cn(
                  "w-full rounded-md border border-[var(--color-border)] px-3 py-2",
                  "text-left text-xs transition-colors",
                  "hover:border-[var(--color-brand-600)] hover:bg-[var(--color-brand-50)]",
                  "focus:outline-none focus:ring-2 focus:ring-[var(--color-brand-600)]",
                )}
                title={description}
                aria-label={`Insert ${token}: ${description}`}
              >
                <span className="font-mono text-[var(--color-brand-600)]">{token}</span>
                <span className="ml-2 text-[var(--color-fg-muted)]">— {description}</span>
              </button>
            ))}
          </div>

          {/* Detected variables */}
          {detectedVars.length > 0 && (
            <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3">
              <p className="mb-2 text-xs font-medium text-[var(--color-fg)]">
                Detected in body ({detectedVars.length})
              </p>
              <div className="space-y-1">
                {detectedVars.map((v: string) => (
                  <div key={v} className="font-mono text-xs text-[var(--color-fg-muted)]">
                    {"{" + v + "}"}
                  </div>
                ))}
              </div>
            </div>
          )}
        </aside>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={saving || !name.trim()}>
          {saving ? "Saving..." : mode === "create" ? "Create script" : "Save changes"}
        </Button>
        <a href="/admin/scripts" className="text-sm text-[var(--color-fg-muted)] hover:underline">
          Cancel
        </a>
      </div>
    </form>
  );
}
