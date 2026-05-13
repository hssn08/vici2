"use client";

/**
 * web/src/components/recordings/AudioPlayer.tsx
 *
 * Lazy HTML5 audio player for recording playback.
 * Pre-signed URL is fetched on demand (not in SSR HTML) to prevent
 * embedding sensitive URLs in server-rendered output or CDN caches.
 * TTL: 300 s (default). Shows countdown timer.
 * R03 PLAN §3.4.
 */

import * as React from "react";
import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { env } from "@/lib/env";

interface AudioPlayerProps {
  recordingId: string;
  lifecycleState: string;
  canListen: boolean;
}

type PlayerState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; url: string; expiresAt: number }
  | { status: "error"; message: string };

const TTL_SECONDS = 300;

function formatTtl(expiresAt: number): string {
  const remaining = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
  const m = Math.floor(remaining / 60);
  const s = remaining % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function AudioPlayer({ recordingId, lifecycleState, canListen }: AudioPlayerProps): React.ReactElement {
  const [player, setPlayer] = useState<PlayerState>({ status: "idle" });
  const [ttlDisplay, setTtlDisplay] = useState<string>("");
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Cleanup ticker on unmount
  useEffect(() => {
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, []);

  async function loadAudio(): Promise<void> {
    setPlayer({ status: "loading" });
    try {
      const res = await fetch(
        `${env.NEXT_PUBLIC_API_URL}/api/recordings/${recordingId}/url?ttl=${TTL_SECONDS}`,
        { credentials: "include" },
      );
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        setPlayer({ status: "error", message: body.error ?? `HTTP ${res.status}` });
        return;
      }
      const data = (await res.json()) as { url: string; expires_in: number };
      const expiresAt = Date.now() + data.expires_in * 1000;
      setPlayer({ status: "ready", url: data.url, expiresAt });
      setTtlDisplay(formatTtl(expiresAt));

      // Start countdown ticker
      if (tickRef.current) clearInterval(tickRef.current);
      tickRef.current = setInterval(() => {
        const remaining = expiresAt - Date.now();
        if (remaining <= 0) {
          clearInterval(tickRef.current!);
          setPlayer({ status: "idle" });
          setTtlDisplay("");
        } else {
          setTtlDisplay(formatTtl(expiresAt));
        }
      }, 1000);
    } catch (err) {
      setPlayer({ status: "error", message: err instanceof Error ? err.message : "Network error" });
    }
  }

  // Recording not available for playback
  if (!["available", "uploaded"].includes(lifecycleState)) {
    return (
      <div className="rounded-md bg-[var(--color-surface-muted)] px-4 py-3 text-sm text-[var(--color-fg-muted)]">
        Recording not available for playback ({lifecycleState}).
        Contact your administrator to retrieve archived or deleted recordings.
      </div>
    );
  }

  if (!canListen) {
    return (
      <div className="rounded-md bg-[var(--color-surface-muted)] px-4 py-3 text-sm text-[var(--color-fg-muted)]">
        You do not have permission to listen to this recording.
      </div>
    );
  }

  if (player.status === "idle") {
    return (
      <Button variant="primary" size="md" onClick={() => void loadAudio()}>
        Load audio
      </Button>
    );
  }

  if (player.status === "loading") {
    return (
      <div className="text-sm text-[var(--color-fg-muted)] animate-pulse">
        Generating secure playback URL…
      </div>
    );
  }

  if (player.status === "error") {
    return (
      <div className="space-y-2">
        <div className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-700 border border-red-200">
          {player.message}
        </div>
        <Button variant="secondary" size="sm" onClick={() => void loadAudio()}>
          Retry
        </Button>
      </div>
    );
  }

  // Ready
  return (
    <div className="space-y-3">
      {/* Native HTML5 audio element — browser handles codec/format */}
      {/* WAV PCM is natively supported in Chrome, Firefox, Safari, Edge (2026) */}
      <audio
        controls
        src={player.url}
        className="w-full h-10"
        preload="metadata"
      >
        Your browser does not support the audio element.
      </audio>

      <div className="flex items-center justify-between text-xs text-[var(--color-fg-muted)]">
        <span>Stereo WAV (left=customer, right=agent)</span>
        <span className="font-mono">
          URL expires in {ttlDisplay}
          {" "}
          <button
            className="underline ml-1"
            onClick={() => void loadAudio()}
          >
            Renew
          </button>
        </span>
      </div>
    </div>
  );
}
