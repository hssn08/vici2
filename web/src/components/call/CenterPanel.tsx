"use client";

import * as React from "react";
import { useCallStore } from "@/lib/stores/call";
import { DispositionPicker } from "@/components/call/DispositionPicker";
import { WebformIframe } from "@/components/call/WebformIframe";
import { NotesPanel } from "@/components/call/NotesPanel";
import { cn } from "@/lib/utils";

type TabId = "script" | "webform" | "comments";

function ScriptTab(): React.ReactElement {
  const campaign = useCallStore((s) => s.campaign);
  const lead = useCallStore((s) => s.lead);
  const [html, setHtml] = React.useState<string>("");
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (!campaign?.id) return;
    setLoading(true);
    const qs = lead?.id ? `?lead_id=${lead.id}` : "";
    fetch(`/api/agent/script/${campaign.id}${qs}`)
      .then((r) => r.json() as Promise<{ html: string }>)
      .then((d) => setHtml(d.html ?? ""))
      .catch(() => setHtml(""))
      .finally(() => setLoading(false));
  }, [campaign?.id, lead?.id]);

  if (loading) {
    return (
      <div className="p-6 space-y-3">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-4 w-full rounded bg-[var(--color-surface-muted)] animate-pulse" />
        ))}
      </div>
    );
  }

  if (!html) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--color-fg-muted)]">
        No script configured.
      </div>
    );
  }

  return (
    <div
      className="prose prose-sm max-w-none p-6"
      // Script HTML is sanitized server-side
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

const TABS: { id: TabId; label: string }[] = [
  { id: "script", label: "Script" },
  { id: "webform", label: "Webform" },
  { id: "comments", label: "Comments" },
];

export function CenterPanel({ className }: { className?: string }): React.ReactElement {
  const [activeTab, setActiveTab] = React.useState<TabId>("script");
  const phase = useCallStore((s) => s.phase);

  return (
    <main
      aria-label="Call workspace"
      className={cn(
        "call-center-panel relative flex flex-col overflow-hidden bg-[var(--color-surface)]",
        className,
      )}
      style={{ gridColumn: 2, gridRow: 2 }}
    >
      {/* Tabs */}
      <div
        role="tablist"
        aria-label="Workspace tabs"
        className="flex border-b border-[var(--color-surface-border)] bg-[var(--color-surface-elevated)] px-4"
      >
        {TABS.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls={`tabpanel-${tab.id}`}
            id={`tab-${tab.id}`}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              "px-4 py-3 text-sm font-medium transition-colors border-b-2 -mb-px",
              activeTab === tab.id
                ? "border-[var(--color-brand-600)] text-[var(--color-brand-600)]"
                : "border-transparent text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]",
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab panels */}
      <div className="relative flex-1 overflow-auto">
        <div
          id="tabpanel-script"
          role="tabpanel"
          aria-labelledby="tab-script"
          hidden={activeTab !== "script"}
          className="h-full"
        >
          <ScriptTab />
        </div>
        <div
          id="tabpanel-webform"
          role="tabpanel"
          aria-labelledby="tab-webform"
          hidden={activeTab !== "webform"}
          className="h-full"
        >
          <WebformIframe />
        </div>
        <div
          id="tabpanel-comments"
          role="tabpanel"
          aria-labelledby="tab-comments"
          hidden={activeTab !== "comments"}
          className="h-full"
        >
          <NotesPanel className="py-4" />
        </div>

        {/* Disposition overlay — absolute fill during wrapup */}
        {phase === "wrapup" && <DispositionPicker />}
      </div>
    </main>
  );
}
