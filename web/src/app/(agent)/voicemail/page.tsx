"use client";

// I03 — Agent voicemail page.
// Shows voicemails for mailboxes the agent is assigned to.
// Allows inline playback, status transitions, and soft-delete.

import React, { useCallback, useEffect, useRef, useState } from "react";
import type { Metadata } from "next";

// Note: metadata export only works in Server Components; keep as reference.
// export const metadata: Metadata = { title: "Voicemail" };

type VoicemailStatus = "NEW" | "READ" | "ARCHIVED" | "DELETED";

interface VoicemailItem {
  id: string;
  mailboxId: string;
  callUuid: string;
  callerNumber: string | null;
  durationSec: number;
  status: VoicemailStatus;
  transcribed: boolean;
  transcriptUri: string | null;
  createdAt: string;
  mailbox: { name: string };
}

const STATUS_LABELS: Record<VoicemailStatus, string> = {
  NEW: "New",
  READ: "Read",
  ARCHIVED: "Archived",
  DELETED: "Deleted",
};

const STATUS_COLORS: Record<VoicemailStatus, string> = {
  NEW: "text-blue-600 font-semibold",
  READ: "text-gray-500",
  ARCHIVED: "text-amber-600",
  DELETED: "text-red-400 line-through",
};

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

export default function AgentVoicemailPage(): React.ReactElement {
  const [items, setItems] = useState<VoicemailItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<VoicemailStatus | "">("");
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [playUrl, setPlayUrl] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  const fetchVoicemails = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = statusFilter ? `?status=${statusFilter}` : "";
      const res = await fetch(`/api/voicemails${qs}`, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { items: VoicemailItem[] };
      setItems(data.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load voicemails");
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    void fetchVoicemails();
  }, [fetchVoicemails]);

  async function handlePlay(id: string): Promise<void> {
    if (playingId === id) {
      setPlayingId(null);
      setPlayUrl(null);
      audioRef.current?.pause();
      return;
    }
    try {
      const res = await fetch(`/api/voicemails/${id}/play`, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { playUrl: string };
      setPlayUrl(data.playUrl);
      setPlayingId(id);
      // Mark as read
      await fetch(`/api/voicemails/${id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "READ" }),
      });
      setItems((prev) =>
        prev.map((vm) => (vm.id === id ? { ...vm, status: "READ" } : vm)),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Playback failed");
    }
  }

  async function handleStatusChange(id: string, newStatus: "READ" | "ARCHIVED" | "DELETED"): Promise<void> {
    try {
      const res = await fetch(`/api/voicemails/${id}`, {
        method: newStatus === "DELETED" ? "DELETE" : "PATCH",
        credentials: "include",
        headers: newStatus !== "DELETED" ? { "content-type": "application/json" } : undefined,
        body: newStatus !== "DELETED" ? JSON.stringify({ status: newStatus }) : undefined,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (newStatus === "DELETED") {
        setItems((prev) => prev.filter((vm) => vm.id !== id));
      } else {
        setItems((prev) =>
          prev.map((vm) => (vm.id === id ? { ...vm, status: newStatus } : vm)),
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    }
  }

  return (
    <section className="flex flex-col gap-6 p-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Voicemail</h1>
        <div className="flex items-center gap-3">
          <label className="text-sm text-gray-600" htmlFor="status-filter">
            Filter:
          </label>
          <select
            id="status-filter"
            className="rounded border px-2 py-1 text-sm"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as VoicemailStatus | "")}
          >
            <option value="">All</option>
            {(["NEW", "READ", "ARCHIVED"] as VoicemailStatus[]).map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </select>
          <button
            className="rounded bg-gray-100 px-3 py-1 text-sm hover:bg-gray-200"
            onClick={() => void fetchVoicemails()}
          >
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded bg-red-50 p-3 text-sm text-red-700">{error}</div>
      )}

      {loading ? (
        <div className="text-sm text-gray-500">Loading voicemails…</div>
      ) : items.length === 0 ? (
        <div className="rounded border border-dashed p-8 text-center text-gray-400">
          No voicemails found.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {items.map((vm) => (
            <div
              key={vm.id}
              className={`flex flex-col gap-2 rounded border p-4 ${
                vm.status === "NEW" ? "border-blue-200 bg-blue-50" : "bg-white"
              }`}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <span className={STATUS_COLORS[vm.status]}>
                      {STATUS_LABELS[vm.status]}
                    </span>
                    <span className="text-gray-400">·</span>
                    <span>{vm.mailbox.name}</span>
                  </div>
                  <div className="text-xs text-gray-500">
                    From: {vm.callerNumber ?? "Unknown"} · {formatDuration(vm.durationSec)} · {formatDate(vm.createdAt)}
                  </div>
                  {vm.transcribed && vm.transcriptUri && (
                    <div className="mt-1 text-xs text-gray-600">
                      <span className="font-medium">Transcript:</span>{" "}
                      <a
                        href={vm.transcriptUri}
                        target="_blank"
                        rel="noreferrer"
                        className="text-blue-600 underline"
                      >
                        View
                      </a>
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    className="rounded bg-blue-600 px-3 py-1 text-xs text-white hover:bg-blue-700"
                    onClick={() => void handlePlay(vm.id)}
                  >
                    {playingId === vm.id ? "Stop" : "Play"}
                  </button>
                  {vm.status !== "ARCHIVED" && (
                    <button
                      className="rounded bg-amber-100 px-3 py-1 text-xs text-amber-700 hover:bg-amber-200"
                      onClick={() => void handleStatusChange(vm.id, "ARCHIVED")}
                    >
                      Archive
                    </button>
                  )}
                  <button
                    className="rounded bg-red-100 px-3 py-1 text-xs text-red-700 hover:bg-red-200"
                    onClick={() => void handleStatusChange(vm.id, "DELETED")}
                  >
                    Delete
                  </button>
                </div>
              </div>

              {playingId === vm.id && playUrl && (
                <audio
                  ref={audioRef}
                  src={playUrl}
                  controls
                  autoPlay
                  className="mt-2 w-full"
                  onEnded={() => setPlayingId(null)}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
