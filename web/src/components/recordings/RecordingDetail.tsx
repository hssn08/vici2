"use client";

/**
 * web/src/components/recordings/RecordingDetail.tsx
 *
 * Client island for the recording detail page.
 * Receives pre-fetched detail data from server component, renders:
 *  - Call metadata strip
 *  - Audio player (lazy URL fetch)
 *  - Download button
 *  - Transcript panel
 *  - Integrity verify section (admin+)
 *  - Legal hold toggle (super_admin only)
 * R03 PLAN §3.4.
 */

import * as React from "react";
import { useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AudioPlayer } from "./AudioPlayer";
import { TranscriptPanel } from "./TranscriptPanel";
import { LegalHoldToggle } from "./LegalHoldToggle";
import {
  type RecordingDetail as RecordingDetailType,
  formatDuration,
  formatBytes,
  lifecycleStateBadge,
  consentLabel,
} from "./types";
import { env } from "@/lib/env";

interface RecordingDetailProps {
  recording: RecordingDetailType;
  backPath: string;
}

interface IntegrityResult {
  ok: boolean;
  local_sha256: string | null;
  remote_sha256: string | null;
  retain_until_date: string | null;
  legal_hold: boolean;
}

export function RecordingDetail({ recording: rec, backPath }: RecordingDetailProps): React.ReactElement {
  const [integrity, setIntegrity] = useState<IntegrityResult | null>(null);
  const [integrityLoading, setIntegrityLoading] = useState(false);
  const [integrityError, setIntegrityError] = useState<string | null>(null);

  async function verifyIntegrity(): Promise<void> {
    setIntegrityLoading(true);
    setIntegrityError(null);
    try {
      const res = await fetch(
        `${env.NEXT_PUBLIC_API_URL}/api/recordings/${rec.id}/integrity-check`,
        { credentials: "include" },
      );
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        setIntegrityError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      setIntegrity((await res.json()) as IntegrityResult);
    } catch (err) {
      setIntegrityError(err instanceof Error ? err.message : "Network error");
    } finally {
      setIntegrityLoading(false);
    }
  }

  async function handleDownload(): Promise<void> {
    try {
      const res = await fetch(
        `${env.NEXT_PUBLIC_API_URL}/api/recordings/${rec.id}/url?ttl=3600`,
        { credentials: "include" },
      );
      if (!res.ok) return;
      const data = (await res.json()) as { url: string };
      const a = document.createElement("a");
      a.href = data.url;
      a.download = `recording-${rec.call_uuid}.wav`;
      a.click();
    } catch {
      // ignore
    }
  }

  const stateBadge = lifecycleStateBadge(rec.lifecycle_state);

  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-[var(--color-fg-muted)]">
        <Link href={backPath} className="hover:underline text-[var(--color-brand-600)]">
          Recordings
        </Link>
        <span>/</span>
        <span className="font-mono text-xs">{rec.call_uuid.slice(0, 8)}…</span>
      </div>

      {/* Call metadata */}
      <Card>
        <CardHeader>
          <CardTitle>Call metadata</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-x-8 gap-y-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-[var(--color-fg-muted)]">Start time</dt>
              <dd className="font-mono text-xs mt-0.5">{new Date(rec.start_time).toLocaleString()}</dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--color-fg-muted)]">Duration</dt>
              <dd className="tabular-nums mt-0.5">{formatDuration(rec.duration_sec)}</dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--color-fg-muted)]">State</dt>
              <dd className="mt-0.5">
                <Badge tone={stateBadge.tone}>{stateBadge.label}</Badge>
                {rec.has_legal_hold && <Badge tone="warning" className="ml-1">Legal hold</Badge>}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--color-fg-muted)]">Campaign</dt>
              <dd className="mt-0.5">{rec.campaign_name ?? rec.campaign_id ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--color-fg-muted)]">Agent</dt>
              <dd className="mt-0.5">{rec.agent_name ?? rec.agent_id ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--color-fg-muted)]">Lead phone</dt>
              <dd className="font-mono text-xs mt-0.5">{rec.lead_phone ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--color-fg-muted)]">Disposition</dt>
              <dd className="mt-0.5">{rec.disposition ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--color-fg-muted)]">Consent</dt>
              <dd className="mt-0.5">{consentLabel(rec.consent_status)}</dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--color-fg-muted)]">Size</dt>
              <dd className="tabular-nums mt-0.5">{formatBytes(rec.size_bytes)}</dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--color-fg-muted)]">Call UUID</dt>
              <dd className="font-mono text-xs mt-0.5 break-all">{rec.call_uuid}</dd>
            </div>
            {rec.sha256 && (
              <div className="col-span-2">
                <dt className="text-xs text-[var(--color-fg-muted)]">SHA-256</dt>
                <dd className="font-mono text-xs mt-0.5 break-all">{rec.sha256}</dd>
              </div>
            )}
          </dl>
        </CardContent>
      </Card>

      {/* Audio player */}
      <Card>
        <CardHeader>
          <CardTitle>Audio playback</CardTitle>
        </CardHeader>
        <CardContent>
          <AudioPlayer
            recordingId={rec.id}
            lifecycleState={rec.lifecycle_state}
            canListen={rec.can_listen}
          />

          {rec.can_download && (
            <div className="mt-4">
              <Button variant="secondary" size="sm" onClick={() => void handleDownload()}>
                Download WAV (1 h URL)
              </Button>
              <p className="text-xs text-[var(--color-fg-muted)] mt-1">
                Generates a 1-hour pre-signed download URL. Access is logged to the audit trail.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Transcript */}
      {rec.transcript_status !== "skipped" && (
        <Card>
          <CardHeader>
            <CardTitle>Transcript</CardTitle>
          </CardHeader>
          <CardContent>
            <TranscriptPanel
              recordingId={rec.id}
              transcriptStatus={rec.transcript_status}
              transcriptWordCount={rec.transcript_word_count}
            />
          </CardContent>
        </Card>
      )}

      {/* Integrity verify */}
      {rec.can_integrity_verify && (
        <Card>
          <CardHeader>
            <CardTitle>Integrity verification</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-[var(--color-fg-muted)]">
              Compares local SHA-256 against S3 ETag + Object Lock state.
            </p>

            <Button
              variant="secondary"
              size="sm"
              onClick={() => void verifyIntegrity()}
              disabled={integrityLoading}
            >
              {integrityLoading ? "Verifying…" : "Verify integrity"}
            </Button>

            {integrityError && (
              <p className="text-sm text-red-600">{integrityError}</p>
            )}

            {integrity && (
              <dl className="text-sm space-y-2 mt-2">
                <div className="flex items-center gap-2">
                  <dt className="text-[var(--color-fg-muted)] w-32">Result</dt>
                  <dd>
                    <Badge tone={integrity.ok ? "success" : "danger"}>
                      {integrity.ok ? "OK" : "MISMATCH"}
                    </Badge>
                  </dd>
                </div>
                {integrity.local_sha256 && (
                  <div>
                    <dt className="text-xs text-[var(--color-fg-muted)]">Local SHA-256</dt>
                    <dd className="font-mono text-xs break-all">{integrity.local_sha256}</dd>
                  </div>
                )}
                {integrity.remote_sha256 && (
                  <div>
                    <dt className="text-xs text-[var(--color-fg-muted)]">Remote SHA-256</dt>
                    <dd className="font-mono text-xs break-all">{integrity.remote_sha256}</dd>
                  </div>
                )}
                {integrity.retain_until_date && (
                  <div>
                    <dt className="text-xs text-[var(--color-fg-muted)]">Object Lock retain-until</dt>
                    <dd>{new Date(integrity.retain_until_date).toLocaleDateString()}</dd>
                  </div>
                )}
              </dl>
            )}
          </CardContent>
        </Card>
      )}

      {/* Legal hold */}
      {rec.can_legal_hold && (
        <LegalHoldToggle
          recordingId={rec.id}
          initialHeld={rec.has_legal_hold}
          initialReason={rec.legal_hold_reason}
        />
      )}
    </div>
  );
}
