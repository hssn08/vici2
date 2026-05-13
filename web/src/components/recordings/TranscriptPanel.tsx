"use client";

/**
 * web/src/components/recordings/TranscriptPanel.tsx
 *
 * Transcript viewer. Fetches GET /api/recordings/:id/transcript.
 * Displays a word-list grouped by speaker (left=customer, right=agent).
 * Real-time sync with audio playback is Phase 4.
 * R03 PLAN §3.4.
 */

import * as React from "react";
import { useState, useEffect } from "react";
import { env } from "@/lib/env";

interface TranscriptWord {
  word: string;
  start: number;
  end: number;
  confidence?: number;
  channel?: number; // 0=customer (left), 1=agent (right)
}

interface TranscriptSegment {
  speaker: number;
  start: number;
  end: number;
  text: string;
  words?: TranscriptWord[];
}

interface TranscriptJson {
  text?: string;
  segments?: TranscriptSegment[];
  words?: TranscriptWord[];
  language?: string;
  duration?: number;
}

interface TranscriptPanelProps {
  recordingId: string;
  transcriptStatus: string;
  transcriptWordCount: number | null;
}

type LoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; data: TranscriptJson }
  | { status: "url"; url: string }
  | { status: "error"; message: string };

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

const SPEAKER_LABELS: Record<number, string> = {
  0: "Customer",
  1: "Agent",
};

export function TranscriptPanel({ recordingId, transcriptStatus, transcriptWordCount }: TranscriptPanelProps): React.ReactElement | null {
  const [load, setLoad] = useState<LoadState>({ status: "idle" });

  // Auto-load if word count is reasonable (< 5000)
  const shouldAutoLoad = transcriptStatus === "completed" && (transcriptWordCount ?? 0) < 5000;

  useEffect(() => {
    if (shouldAutoLoad) {
      void fetchTranscript();
    }
    // fetchTranscript is stable (defined inside component, closes over recordingId)
     
  }, [recordingId, shouldAutoLoad]);

  async function fetchTranscript(): Promise<void> {
    setLoad({ status: "loading" });
    try {
      const res = await fetch(
        `${env.NEXT_PUBLIC_API_URL}/api/recordings/${recordingId}/transcript`,
        { credentials: "include" },
      );
      if (!res.ok) {
        const body = (await res.json()) as { error?: string; transcript_url?: string };
        if (body.transcript_url) {
          setLoad({ status: "url", url: body.transcript_url });
          return;
        }
        setLoad({ status: "error", message: body.error ?? `HTTP ${res.status}` });
        return;
      }
      const contentType = res.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        const body = (await res.json()) as TranscriptJson | { transcript_status?: string; transcript_url?: string };
        if ("transcript_url" in body && body.transcript_url) {
          setLoad({ status: "url", url: body.transcript_url });
          return;
        }
        setLoad({ status: "loaded", data: body as TranscriptJson });
      } else {
        setLoad({ status: "error", message: "Unexpected response format" });
      }
    } catch (err) {
      setLoad({ status: "error", message: err instanceof Error ? err.message : "Network error" });
    }
  }

  if (transcriptStatus !== "completed") {
    return (
      <div className="rounded-md bg-[var(--color-surface-muted)] px-4 py-3 text-sm text-[var(--color-fg-muted)]">
        {transcriptStatus === "pending" || transcriptStatus === "queued" || transcriptStatus === "processing"
          ? "Transcription in progress…"
          : transcriptStatus === "failed"
          ? "Transcription failed. Use the retry button above to re-queue."
          : transcriptStatus === "consent_blocked"
          ? "Transcription not available (consent declined)."
          : transcriptStatus === "skipped"
          ? "Transcription skipped."
          : `No transcript (status: ${transcriptStatus}).`}
      </div>
    );
  }

  if (load.status === "idle") {
    return (
      <button
        className="text-sm text-[var(--color-brand-600)] hover:underline"
        onClick={() => void fetchTranscript()}
      >
        Load transcript ({(transcriptWordCount ?? 0).toLocaleString()} words)
      </button>
    );
  }

  if (load.status === "loading") {
    return (
      <div className="text-sm text-[var(--color-fg-muted)] animate-pulse">Loading transcript…</div>
    );
  }

  if (load.status === "url") {
    return (
      <div className="text-sm text-[var(--color-fg-muted)]">
        Transcript too large for inline view.{" "}
        <a
          href={load.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[var(--color-brand-600)] underline"
        >
          Download JSON transcript
        </a>
      </div>
    );
  }

  if (load.status === "error") {
    return (
      <div className="space-y-2">
        <div className="text-sm text-red-600">{load.message}</div>
        <button
          className="text-xs text-[var(--color-brand-600)] hover:underline"
          onClick={() => void fetchTranscript()}
        >
          Retry
        </button>
      </div>
    );
  }

  const { data } = load;

  return (
    <div className="space-y-3">
      {data.language && (
        <p className="text-xs text-[var(--color-fg-muted)]">
          Language: {data.language}
          {data.duration && ` · ${Math.round(data.duration)}s`}
        </p>
      )}

      <div className="max-h-96 overflow-y-auto rounded border bg-[var(--color-surface)] p-4 space-y-3 text-sm leading-relaxed">
        {data.segments && data.segments.length > 0 ? (
          data.segments.map((seg, i) => (
            <div key={i} className="flex gap-3">
              <span className="font-mono text-xs text-[var(--color-fg-muted)] w-20 shrink-0 pt-0.5">
                [{formatTime(seg.start)}]
              </span>
              <div className="flex-1">
                <span className={`text-xs font-semibold mr-2 ${seg.speaker === 0 ? "text-blue-600" : "text-emerald-600"}`}>
                  {SPEAKER_LABELS[seg.speaker] ?? `Speaker ${seg.speaker}`}:
                </span>
                <span>{seg.text}</span>
              </div>
            </div>
          ))
        ) : data.text ? (
          <p className="whitespace-pre-wrap">{data.text}</p>
        ) : (
          <p className="text-[var(--color-fg-muted)]">Empty transcript.</p>
        )}
      </div>

      <p className="text-xs text-[var(--color-fg-muted)]">
        Channel 0 (left) = Customer · Channel 1 (right) = Agent
      </p>
    </div>
  );
}
