"use client";

// N02 — Version history panel (Phase 1: read-only list of versions).

import { useState, useEffect } from "react";

interface VersionDto {
  id: string;
  version: number;
  subject: string;
  htmlBody: string;
  textBody: string;
  savedAt: string;
}

interface VersionHistoryPanelProps {
  templateId: string;
}

export function VersionHistoryPanel({
  templateId,
}: VersionHistoryPanelProps): React.ReactElement {
  const [versions, setVersions] = useState<VersionDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState<VersionDto | null>(null);

  const loadVersions = async (): Promise<void> => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/email-templates/${templateId}/versions`);
      if (res.ok) {
        const data = await res.json() as { versions: VersionDto[] };
        setVersions(data.versions);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleToggle = (): void => {
    if (!expanded) void loadVersions();
    setExpanded((v) => !v);
  };

  return (
    <div className="mt-8 border-t border-[var(--color-border)] pt-4">
      <button
        onClick={handleToggle}
        className="flex w-full items-center justify-between text-sm font-medium text-[var(--color-fg)]"
      >
        <span>Version History</span>
        <span>{expanded ? "▲" : "▼"}</span>
      </button>

      {expanded && (
        <div className="mt-4">
          {loading ? (
            <div className="animate-pulse h-20 bg-[var(--color-surface-2)] rounded" />
          ) : versions.length === 0 ? (
            <p className="text-sm text-[var(--color-fg-muted)]">No previous versions.</p>
          ) : (
            <div className="space-y-2">
              {versions.map((v) => (
                <div
                  key={v.id}
                  className="flex items-center justify-between rounded border border-[var(--color-border)] px-3 py-2 text-sm"
                >
                  <div>
                    <span className="font-medium">v{v.version}</span>
                    <span className="ml-3 text-[var(--color-fg-muted)]">
                      {new Date(v.savedAt).toLocaleString()}
                    </span>
                    <span className="ml-3 truncate max-w-xs text-[var(--color-fg-muted)]">{v.subject}</span>
                  </div>
                  <button
                    onClick={() => setSelectedVersion(v)}
                    className="text-xs text-[var(--color-brand-600)] hover:underline"
                  >
                    View
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {selectedVersion && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-2xl max-h-[80vh] overflow-auto rounded-lg bg-[var(--color-surface)] p-6 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold">Version {selectedVersion.version}</h2>
              <button
                onClick={() => setSelectedVersion(null)}
                className="text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
              >
                ✕
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <p className="text-xs font-medium text-[var(--color-fg-muted)] uppercase mb-1">Subject</p>
                <p className="text-sm font-mono bg-[var(--color-surface-2)] rounded px-3 py-2">{selectedVersion.subject}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-[var(--color-fg-muted)] uppercase mb-1">HTML Body</p>
                <pre className="text-xs font-mono bg-[var(--color-surface-2)] rounded px-3 py-2 overflow-auto max-h-48 whitespace-pre-wrap">{selectedVersion.htmlBody}</pre>
              </div>
              <div>
                <p className="text-xs font-medium text-[var(--color-fg-muted)] uppercase mb-1">Text Body</p>
                <pre className="text-xs font-mono bg-[var(--color-surface-2)] rounded px-3 py-2 overflow-auto max-h-48 whitespace-pre-wrap">{selectedVersion.textBody}</pre>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
