"use client";

// M06 — DID CSV bulk-add modal.
//
// Accepts a CSV file or pasted text with columns:
//   e164,carrier_id,route_kind,route_target[,active][,default_lang]
// Submits to POST /api/admin/dids/bulk and shows per-row errors.

import * as React from "react";
import { apiFetch, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BulkImportResult {
  inserted: number;
  updated: number;
  errors: Array<{ row: number; message: string }>;
}

interface DidBulkModalProps {
  onClose: () => void;
  onImported: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DidBulkModal({ onClose, onImported }: DidBulkModalProps): React.ReactElement {
  const [csvText, setCsvText] = React.useState("");
  const [uploading, setUploading] = React.useState(false);
  const [result, setResult] = React.useState<BulkImportResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setCsvText(text);
  }

  async function handleUpload() {
    if (!csvText.trim()) {
      setError("Please paste CSV content or select a file");
      return;
    }
    setUploading(true);
    setError(null);
    setResult(null);
    try {
      const res = await apiFetch<BulkImportResult>("/api/admin/dids/bulk", {
        method: "POST",
        body: { csv: csvText },
      });
      setResult(res);
      if (res.errors.length === 0) {
        onImported();
        onClose();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Bulk import DIDs"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
    >
      <div className="w-full max-w-2xl rounded-xl bg-[var(--color-surface)] p-6 shadow-xl space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-[var(--color-fg)]">Bulk import DIDs</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] transition-colors"
          >
            ✕
          </button>
        </div>

        <p className="text-sm text-[var(--color-fg-muted)]">
          CSV format: <code className="bg-[var(--color-surface-muted)] px-1 rounded text-xs">e164,carrier_id,route_kind,route_target,active,default_lang</code>
          <br />Header row required. Max 10,000 rows. Existing DIDs are updated; new ones are created.
        </p>

        <div className="space-y-2">
          <label htmlFor="bulk-file" className="block text-sm font-medium text-[var(--color-fg)]">
            Select CSV file
          </label>
          <input
            id="bulk-file"
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            onChange={handleFileChange}
            className="block w-full text-sm text-[var(--color-fg-muted)] file:mr-4 file:rounded-md file:border-0 file:bg-[var(--color-brand-600)] file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-white hover:file:bg-[var(--color-brand-700)]"
          />
        </div>

        <div className="space-y-2">
          <label htmlFor="bulk-csv" className="block text-sm font-medium text-[var(--color-fg)]">
            Or paste CSV
          </label>
          <textarea
            id="bulk-csv"
            value={csvText}
            onChange={(e) => setCsvText(e.target.value)}
            rows={8}
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 font-mono text-xs text-[var(--color-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-brand-500)]"
            placeholder={`e164,carrier_id,route_kind,route_target,active,default_lang
+12065551234,1,ingroup,SALES,true,en
+12065555678,1,ivr,main_menu,true,en`}
          />
        </div>

        {error && (
          <div role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>
        )}

        {result && (
          <div className="rounded-md bg-green-50 p-3 text-sm space-y-1">
            <p className="font-medium text-green-800">
              Import complete: {result.inserted} inserted, {result.updated} updated
              {result.errors.length > 0 && `, ${result.errors.length} errors`}
            </p>
            {result.errors.length > 0 && (
              <ul className="mt-2 space-y-1 text-red-700 text-xs max-h-40 overflow-y-auto">
                {result.errors.map((e, i) => (
                  <li key={i}>Row {e.row}: {e.message}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="flex items-center justify-end gap-3">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={handleUpload} disabled={uploading || !csvText.trim()}>
            {uploading ? "Uploading…" : "Import DIDs"}
          </Button>
        </div>
      </div>
    </div>
  );
}
