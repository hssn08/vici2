"use client";
// N04 — HubSpot list import card (visible when syncMode = LIST_ONLY)

import { useState, useEffect } from "react";

interface HubspotList {
  listId: string;
  name: string;
  size: number;
  processingType: string;
}

interface Props {
  apiBase: string;
}

export function ListImportCard({ apiBase }: Props): React.ReactElement {
  const [lists, setLists] = useState<HubspotList[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedListId, setSelectedListId] = useState("");
  const [vici2ListName, setVici2ListName] = useState("");
  const [syncOngoing, setSyncOngoing] = useState(true);
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      try {
        const res = await fetch(`${apiBase}/lists`);
        if (res.ok) {
          const data = await res.json() as { lists: HubspotList[] };
          setLists(data.lists);
        }
      } catch {
        // Ignore fetch errors
      } finally {
        setLoading(false);
      }
    })();
  }, [apiBase]);

  const handleImport = async () => {
    if (!selectedListId || !vici2ListName) return;
    setImporting(true);
    try {
      const res = await fetch(`${apiBase}/lists/${selectedListId}/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vici2ListName, syncOngoing }),
      });
      if (res.ok) {
        setMessage({ type: "success", text: "Import started successfully" });
        setVici2ListName("");
      } else {
        setMessage({ type: "error", text: "Import failed" });
      }
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
      <h2 className="text-base font-semibold text-[var(--color-fg)] mb-4">Import HubSpot List</h2>

      {loading ? (
        <p className="text-sm text-[var(--color-fg-muted)]">Loading lists…</p>
      ) : (
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-[var(--color-fg)] mb-1">HubSpot List</label>
            <select
              value={selectedListId}
              onChange={(e) => {
                setSelectedListId(e.target.value);
                const found = lists.find((l) => l.listId === e.target.value);
                if (found) setVici2ListName(`${found.name} (HubSpot)`);
              }}
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm text-[var(--color-fg)]"
            >
              <option value="">Select a list…</option>
              {lists.map((l) => (
                <option key={l.listId} value={l.listId}>
                  {l.name} ({l.size} contacts, {l.processingType})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-[var(--color-fg)] mb-1">vici2 List Name</label>
            <input
              type="text"
              value={vici2ListName}
              onChange={(e) => setVici2ListName(e.target.value)}
              placeholder="My HubSpot List"
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm text-[var(--color-fg)]"
            />
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="syncOngoing"
              checked={syncOngoing}
              onChange={(e) => setSyncOngoing(e.target.checked)}
              className="rounded"
            />
            <label htmlFor="syncOngoing" className="text-sm text-[var(--color-fg)]">
              Keep in sync (re-sync on every contact sync cycle)
            </label>
          </div>

          {message && (
            <p className={`text-sm ${message.type === "success" ? "text-green-600" : "text-red-600"}`}>
              {message.text}
            </p>
          )}

          <button
            onClick={handleImport}
            disabled={!selectedListId || !vici2ListName || importing}
            className="inline-flex items-center justify-center rounded-md bg-[var(--color-brand-600)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-brand-700)] disabled:opacity-50 transition-colors"
          >
            {importing ? "Importing…" : "Import List"}
          </button>
        </div>
      )}
    </div>
  );
}
