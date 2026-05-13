"use client";
// I02 — Prompt upload + preview component.

import { useRef, useState } from "react";

interface PromptUploadProps {
  ivrId: string;
  nodeId: string;
  onUploaded: () => void;
}

export function PromptUpload({ ivrId, nodeId, onUploaded }: PromptUploadProps): React.ReactElement {
  const fileRef = useRef<HTMLInputElement>(null);
  const [lang, setLang] = useState("en");
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<{ durationMs: number; sizeBytes: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleUpload = async (): Promise<void> => {
    const file = fileRef.current?.files?.[0];
    if (!file) return;

    setUploading(true);
    setError(null);
    setResult(null);

    const form = new FormData();
    form.append("file", file);
    form.append("lang", lang);

    try {
      const res = await fetch(`/api/admin/ivrs/${ivrId}/nodes/${nodeId}/prompts`, {
        method: "POST",
        credentials: "include",
        body: form,
      });
      if (!res.ok) {
        const body = await res.json() as { message?: string };
        throw new Error(body.message ?? "Upload failed");
      }
      const data = await res.json() as { durationMs: number; sizeBytes: number };
      setResult(data);
      onUploaded();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="flex items-center gap-2 flex-wrap mt-1">
      <select
        value={lang}
        onChange={(e) => setLang(e.target.value)}
        className="rounded border border-[var(--color-border)] px-2 py-1 text-xs bg-[var(--color-surface)] text-[var(--color-fg)]"
      >
        <option value="en">English (en)</option>
        <option value="es">Spanish (es)</option>
        <option value="fr">French (fr)</option>
        <option value="de">German (de)</option>
        <option value="pt">Portuguese (pt)</option>
      </select>
      <input
        type="file"
        ref={fileRef}
        accept="audio/wav,audio/mpeg,audio/x-wav"
        className="text-xs text-[var(--color-fg-muted)] file:mr-2 file:py-1 file:px-2 file:rounded file:border-0 file:text-xs file:bg-[var(--color-surface-raised)] file:text-[var(--color-fg)]"
      />
      <button
        onClick={handleUpload}
        disabled={uploading}
        className="px-2 py-1 rounded bg-[var(--color-accent)] text-white text-xs disabled:opacity-50"
      >
        {uploading ? "Uploading…" : "Upload Prompt"}
      </button>
      {result && (
        <span className="text-xs text-green-600">
          OK ({(result.sizeBytes / 1024).toFixed(1)} KB, {(result.durationMs / 1000).toFixed(1)}s)
        </span>
      )}
      {error && <span className="text-xs text-red-500">{error}</span>}
    </div>
  );
}
