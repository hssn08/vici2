"use client";

// S03 / A05 — Script tab for the in-call workspace.
//
// Fires once when call.bridged (phase becomes "active"); never polls.
// Calls GET /api/agent/script/:campaignId?lead_id=...&call_uuid=...&call_started_at=...
// Renders server-sanitized HTML via dangerouslySetInnerHTML.
//
// Edge cases:
//   - No campaign → shows "No script configured"
//   - No active script for campaign → shows placeholder
//   - Network error → shows error state with retry button

import * as React from "react";
import { useCallStore } from "@/lib/stores/call";
import { apiFetch, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ScriptRenderResponse {
  html: string;
  scriptId: string | null;
  version: number;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ScriptTab(): React.ReactElement {
  const phase = useCallStore((s) => s.phase);
  const campaign = useCallStore((s) => s.campaign);
  const lead = useCallStore((s) => s.lead);
  const callUuid = useCallStore((s) => s.callUuid);
  const startedAt = useCallStore((s) => s.startedAt);

  const [html, setHtml] = React.useState<string>("");
  const [scriptId, setScriptId] = React.useState<string | null>(null);
  const [loaded, setLoaded] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Fetch script when call becomes active — fire once
  const fetchedRef = React.useRef(false);

  async function fetchScript() {
    if (!campaign?.id) {
      setLoaded(true);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams();
      if (lead?.id) params.set("lead_id", String(lead.id));
      if (callUuid) params.set("call_uuid", callUuid);
      if (startedAt) {
        params.set("call_started_at", new Date(startedAt).toISOString());
      }

      const result = await apiFetch<ScriptRenderResponse>(
        `/api/agent/script/${campaign.id}?${params}`,
      );

      setHtml(result.html);
      setScriptId(result.scriptId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load script");
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }

  // Fire on phase transition to "active"
  React.useEffect(() => {
    if (phase === "active" && !fetchedRef.current) {
      fetchedRef.current = true;
      void fetchScript();
    }
    // Reset when call ends
    if (phase === "idle") {
      fetchedRef.current = false;
      setHtml("");
      setScriptId(null);
      setLoaded(false);
      setError(null);
    }
    // fetch is stable; phase is the only trigger we care about
  }, [phase]);

  // --- Render states ---

  // Not yet in an active call
  if (phase === "idle" || phase === "ringing") {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <p className="text-sm text-[var(--color-fg-muted)] italic">
          Script will appear when a call connects.
        </p>
      </div>
    );
  }

  // Loading skeleton
  if (loading) {
    return (
      <div className="p-6 space-y-3" role="status" aria-label="Loading script">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className={cn(
              "h-4 animate-pulse rounded bg-[var(--color-surface-muted)]",
              i === 0 && "w-3/4",
              i % 2 === 0 ? "w-full" : "w-5/6",
            )}
            aria-hidden
          />
        ))}
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-8 gap-4">
        <div
          role="alert"
          className="rounded-md bg-[var(--color-state-error-bg)] px-4 py-3 text-sm text-[var(--color-state-error)] max-w-sm text-center"
        >
          {error}
        </div>
        <button
          onClick={() => {
            fetchedRef.current = false;
            void fetchScript();
          }}
          className="text-sm text-[var(--color-brand-600)] hover:underline"
        >
          Retry
        </button>
      </div>
    );
  }

  // No script configured
  if (loaded && !html) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <p className="text-sm text-[var(--color-fg-muted)] italic">
          {campaign?.id
            ? "No active script configured for this campaign."
            : "No campaign associated with this call."}
        </p>
      </div>
    );
  }

  // Script content
  return (
    <div className="relative h-full overflow-y-auto">
      {scriptId && (
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2">
          <span className="text-xs text-[var(--color-fg-muted)]">
            Script loaded
          </span>
          <span className="text-xs text-[var(--color-fg-muted)]" aria-label="Script ID">
            ID: {scriptId}
          </span>
        </div>
      )}

      <div
        className="p-6 text-sm text-[var(--color-fg)] prose prose-sm max-w-none"
        aria-label="Call script content"
        // Body is server-sanitized via sanitize-html before this is served.
        // This is the intended render path for agent-facing call scripts.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
