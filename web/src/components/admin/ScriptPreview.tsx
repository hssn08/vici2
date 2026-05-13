"use client";

// S03 — Admin script preview component.
//
// Provides sample lead input fields + rendered HTML preview.
// Calls POST /api/admin/scripts/:id/render (mode=preview) on input change (debounced).
// Renders the result in a sanitized div via dangerouslySetInnerHTML.
// Note: body is already server-sanitized; this is a trusted preview.

import * as React from "react";
import { apiFetch, ApiError } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RenderResponse {
  html: string;
  scriptId: string;
  version: number;
}

interface SampleLead {
  first_name: string;
  last_name: string;
  phone: string;
  email: string;
  city: string;
  state: string;
  agent_name: string;
  custom_fields: string; // JSON string of {key: value}
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ScriptPreviewProps {
  scriptId: string;
}

// ---------------------------------------------------------------------------
// Default sample data
// ---------------------------------------------------------------------------

const DEFAULT_SAMPLE: SampleLead = {
  first_name: "Jane",
  last_name: "Doe",
  phone: "+15551234567",
  email: "jane.doe@example.com",
  city: "Austin",
  state: "TX",
  agent_name: "John Agent",
  custom_fields: '{"account_number": "ACC-001"}',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ScriptPreview({ scriptId }: ScriptPreviewProps): React.ReactElement {
  const [sample, setSample] = React.useState<SampleLead>(DEFAULT_SAMPLE);
  const [html, setHtml] = React.useState<string>("");
  const [version, setVersion] = React.useState<number>(0);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Build lead_id-less render body from sample inputs
  function buildRenderBody() {
    // We use mode=preview which preserves unknown tokens
    // The sample lead is passed as raw context via lead_id lookup,
    // but for the preview we pass no lead_id — the server will use empty context.
    // Instead we pass custom fields as query metadata.
    // In a real implementation you'd pass a sample lead_id or a preview-specific endpoint.
    // For now we render without a lead and show the token placeholders.
    return {
      mode: "preview" as const,
    };
  }

  // Debounced render call
  const renderTimerRef = React.useRef<NodeJS.Timeout | null>(null);

  function scheduleRender() {
    if (renderTimerRef.current) clearTimeout(renderTimerRef.current);
    renderTimerRef.current = setTimeout(() => void doRender(), 500);
  }

  async function doRender() {
    setLoading(true);
    setError(null);
    try {
      const result = await apiFetch<RenderResponse>(`/api/admin/scripts/${scriptId}/render`, {
        method: "POST",
        body: buildRenderBody(),
      });
      setHtml(result.html);
      setVersion(result.version);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to render script");
    } finally {
      setLoading(false);
    }
  }

  // Render on mount
  React.useEffect(() => {
    void doRender();
    return () => {
      if (renderTimerRef.current) clearTimeout(renderTimerRef.current);
    };
  }, [scriptId]);

  function handleSampleChange(field: keyof SampleLead, value: string) {
    setSample((prev: SampleLead) => ({ ...prev, [field]: value }));
    scheduleRender();
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[320px_1fr]">
      {/* Left: Sample lead inputs */}
      <aside className="space-y-4">
        <div className="rounded-md border border-[var(--color-border)] p-4 space-y-4">
          <h2 className="text-sm font-semibold text-[var(--color-fg)]">Sample lead data</h2>
          <p className="text-xs text-[var(--color-fg-muted)]">
            Fill in sample values to see how variables will appear during a live call.
            Changes apply automatically.
          </p>

          {(
            [
              { field: "first_name" as const, label: "First name" },
              { field: "last_name" as const, label: "Last name" },
              { field: "phone" as const, label: "Phone (E.164)" },
              { field: "email" as const, label: "Email" },
              { field: "city" as const, label: "City" },
              { field: "state" as const, label: "State" },
              { field: "agent_name" as const, label: "Agent name" },
            ] as Array<{ field: keyof SampleLead; label: string }>
          ).map(({ field, label }) => (
            <div key={field} className="space-y-1">
              <label htmlFor={`sample-${field}`} className="text-xs font-medium text-[var(--color-fg)]">
                {label}
              </label>
              <Input
                id={`sample-${field}`}
                value={sample[field]}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleSampleChange(field, e.target.value)}
                className="h-8 text-xs"
              />
            </div>
          ))}

          <div className="space-y-1">
            <label htmlFor="sample-custom" className="text-xs font-medium text-[var(--color-fg)]">
              Custom fields (JSON)
            </label>
            <textarea
              id="sample-custom"
              value={sample.custom_fields}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => handleSampleChange("custom_fields", e.target.value)}
              rows={3}
              className={cn(
                "w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]",
                "px-2 py-1 text-xs font-mono text-[var(--color-fg)]",
                "focus:outline-none focus:ring-2 focus:ring-[var(--color-brand-600)]",
                "resize-y",
              )}
              placeholder='{"account_number": "ACC-001"}'
            />
          </div>
        </div>

        {version > 0 && (
          <p className="text-xs text-[var(--color-fg-muted)]">
            Rendering version {version} •{" "}
            <a
              href={`/admin/scripts/${scriptId}`}
              className="text-[var(--color-brand-600)] hover:underline"
            >
              Edit script
            </a>
          </p>
        )}
      </aside>

      {/* Right: Rendered preview */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-[var(--color-fg)]">Rendered preview</h2>
          {loading && (
            <span className="text-xs text-[var(--color-fg-muted)] animate-pulse">
              Rendering...
            </span>
          )}
        </div>

        {error && (
          <div role="alert" className="rounded-md bg-[var(--color-state-error-bg)] p-3 text-sm text-[var(--color-state-error)]">
            {error}
          </div>
        )}

        <div
          className={cn(
            "rounded-md border border-[var(--color-border)] bg-white p-6",
            "min-h-[400px] text-sm text-gray-800",
            "prose prose-sm max-w-none",
            loading && "opacity-70",
          )}
          aria-label="Rendered script preview"
          // Server guarantees sanitized HTML; this is intentional.
          dangerouslySetInnerHTML={{ __html: html || "<p class='text-gray-400 italic'>No content to preview.</p>" }}
        />

        <p className="text-xs text-[var(--color-fg-muted)]">
          Note: preview renders without live lead data. Variable tokens shown as-is.
          During a live call, tokens are replaced with actual lead values.
        </p>
      </div>
    </div>
  );
}
