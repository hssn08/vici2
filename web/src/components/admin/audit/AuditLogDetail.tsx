"use client";

// M04 — Audit log single-row detail view.
//
// Displays all columns for one audit_log row, including pretty-printed JSON
// for before_json / after_json. Shows prev/next 5 chain context rows.
// Includes AuditVerifyBadge for on-demand chain verification.

import * as React from "react";
import { api, ApiError } from "@/lib/api";
import { AuditVerifyBadge, type VerifyStatus, type VerifierFailure } from "./AuditVerifyBadge";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AuditLogRow {
  id: string;
  tenant_id: string;
  actor_user_id: string | null;
  actor_kind: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  before_json: unknown;
  after_json: unknown;
  request_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  ts: string;
  prev_hash: string;
  row_hash: string;
  hash_at: string;
}

interface DetailResponse {
  row: AuditLogRow;
  chainContext: {
    prevRows: AuditLogRow[];
    nextRows: AuditLogRow[];
  };
}

interface VerifyResponse {
  ok: boolean;
  rowHashRecomputed: string;
  rowHashStored: string;
  prevRowHashMatches: boolean;
  nextRowPrevHashMatches: boolean;
  merkleAttestationDate: string | null;
  failures: VerifierFailure[];
  rowsChecked: number;
  daysChecked: number;
  attestationsChecked: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[160px_1fr] gap-x-3 py-2 border-b border-[var(--color-border)]">
      <dt className="text-sm font-medium text-[var(--color-fg-muted)] self-start">{label}</dt>
      <dd className="text-sm text-[var(--color-fg)] break-all">{value ?? "—"}</dd>
    </div>
  );
}

function JsonField({ label, value }: { label: string; value: unknown }) {
  if (value == null) return <Field label={label} value={null} />;
  return (
    <div className="grid grid-cols-[160px_1fr] gap-x-3 py-2 border-b border-[var(--color-border)]">
      <dt className="text-sm font-medium text-[var(--color-fg-muted)] self-start">{label}</dt>
      <dd>
        <pre className="rounded bg-[var(--color-surface-muted)] p-2 text-xs font-mono overflow-auto max-h-48 text-[var(--color-fg)]">
          {JSON.stringify(value, null, 2)}
        </pre>
      </dd>
    </div>
  );
}

function HashField({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[160px_1fr] gap-x-3 py-2 border-b border-[var(--color-border)]">
      <dt className="text-sm font-medium text-[var(--color-fg-muted)] self-start">{label}</dt>
      <dd>
        <code className="text-xs font-mono text-[var(--color-fg)] break-all">{value}</code>
      </dd>
    </div>
  );
}

// Mini row for chain context table
function ChainRow({ row, direction }: { row: AuditLogRow; direction: "prev" | "next" }) {
  return (
    <a
      href={`/admin/audit/${row.id}`}
      className="flex items-center gap-3 rounded px-2 py-1.5 text-xs hover:bg-[var(--color-surface-muted)] transition-colors"
      aria-label={`${direction === "prev" ? "Previous" : "Next"} chain row ${row.id}: ${row.action}`}
    >
      <span className="w-16 text-right font-mono text-[var(--color-fg-muted)]">{row.id}</span>
      <span className="flex-1 font-mono text-[var(--color-fg)]">{row.action}</span>
      <span className="tabular-nums text-[var(--color-fg-muted)]">
        {new Date(row.ts).toLocaleString()}
      </span>
    </a>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface AuditLogDetailProps {
  id: string;
}

export function AuditLogDetail({ id }: AuditLogDetailProps): React.ReactElement {
  const [data, setData] = React.useState<DetailResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const [verifyStatus, setVerifyStatus] = React.useState<VerifyStatus>("idle");
  const [verifyResult, setVerifyResult] = React.useState<VerifyResponse | null>(null);

  // Fetch detail
  React.useEffect(() => {
    setLoading(true);
    setError(null);
    api
      .get<DetailResponse>(`/api/admin/audit-log/${id}`)
      .then((d) => setData(d))
      .catch((err) => {
        const msg = err instanceof ApiError ? err.message : "Failed to load audit row";
        setError(msg);
      })
      .finally(() => setLoading(false));
  }, [id]);

  const handleVerify = React.useCallback(async () => {
    setVerifyStatus("loading");
    setVerifyResult(null);
    try {
      const result = await api.get<VerifyResponse>(`/api/admin/audit-log/${id}/verify`);
      setVerifyResult(result);
      setVerifyStatus(result.ok ? "ok" : "fail");
    } catch {
      setVerifyStatus("fail");
    }
  }, [id]);

  if (loading) {
    return (
      <div
        role="status"
        aria-label="Loading audit row"
        className="space-y-3"
      >
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="h-10 animate-pulse rounded bg-[var(--color-surface-muted)]" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div role="alert" className="rounded-md bg-red-50 p-4 text-sm text-red-700">
        {error}
      </div>
    );
  }

  if (!data) return <></>;

  const { row, chainContext } = data;

  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
      <nav aria-label="Breadcrumb" className="text-sm text-[var(--color-fg-muted)]">
        <a href="/admin/audit" className="hover:underline">
          Audit log
        </a>
        {" / "}
        <span className="font-mono">{row.id}</span>
      </nav>

      {/* Chain verification */}
      <section aria-labelledby="verify-heading">
        <h2 id="verify-heading" className="mb-3 text-sm font-semibold text-[var(--color-fg-muted)] uppercase tracking-wide">
          Chain verification
        </h2>
        <AuditVerifyBadge
          status={verifyStatus}
          failures={verifyResult?.failures}
          rowsChecked={verifyResult?.rowsChecked}
          daysChecked={verifyResult?.daysChecked}
          attestationsChecked={verifyResult?.attestationsChecked}
          onVerify={() => void handleVerify()}
        />
        {verifyResult && (
          <dl className="mt-3 space-y-1 text-xs">
            <div className="flex gap-2">
              <dt className="font-medium text-[var(--color-fg-muted)]">Row hash (stored):</dt>
              <dd className="font-mono text-[var(--color-fg)] break-all">{verifyResult.rowHashStored}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="font-medium text-[var(--color-fg-muted)]">Row hash (recomputed):</dt>
              <dd
                className={`font-mono break-all ${
                  verifyResult.rowHashRecomputed === verifyResult.rowHashStored
                    ? "text-green-700"
                    : "text-red-700"
                }`}
              >
                {verifyResult.rowHashRecomputed}
              </dd>
            </div>
            {verifyResult.merkleAttestationDate && (
              <div className="flex gap-2">
                <dt className="font-medium text-[var(--color-fg-muted)]">Attestation date:</dt>
                <dd className="text-[var(--color-fg)]">{verifyResult.merkleAttestationDate}</dd>
              </div>
            )}
          </dl>
        )}
      </section>

      {/* Row fields */}
      <section aria-labelledby="row-heading">
        <h2 id="row-heading" className="mb-3 text-sm font-semibold text-[var(--color-fg-muted)] uppercase tracking-wide">
          Row data
        </h2>
        <dl>
          <Field label="ID" value={<span className="font-mono">{row.id}</span>} />
          <Field label="Timestamp" value={new Date(row.ts).toISOString()} />
          <Field label="Action" value={<span className="font-mono">{row.action}</span>} />
          <Field label="Actor kind" value={row.actor_kind} />
          <Field label="Actor user ID" value={row.actor_user_id} />
          <Field label="Entity type" value={row.entity_type} />
          <Field label="Entity ID" value={row.entity_id} />
          <Field label="Request ID" value={row.request_id} />
          <Field label="IP address" value={row.ip_address} />
          <Field label="User agent" value={row.user_agent} />
          <JsonField label="Before JSON" value={row.before_json} />
          <JsonField label="After JSON" value={row.after_json} />
          <HashField label="prev_hash" value={row.prev_hash} />
          <HashField label="row_hash" value={row.row_hash} />
          <Field label="hash_at" value={row.hash_at} />
        </dl>
      </section>

      {/* Chain context */}
      <section aria-labelledby="chain-heading">
        <h2 id="chain-heading" className="mb-3 text-sm font-semibold text-[var(--color-fg-muted)] uppercase tracking-wide">
          Chain context
        </h2>
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] divide-y divide-[var(--color-border)]">
          {chainContext.prevRows.length === 0 && chainContext.nextRows.length === 0 ? (
            <p className="px-3 py-4 text-sm text-[var(--color-fg-muted)]">No adjacent rows.</p>
          ) : (
            <>
              {chainContext.prevRows.map((r) => (
                <ChainRow key={r.id} row={r} direction="prev" />
              ))}
              <div className="flex items-center gap-3 px-2 py-1.5 bg-[var(--color-brand-50)]">
                <span className="w-16 text-right font-mono text-[var(--color-brand-700)] font-semibold text-xs">
                  {row.id}
                </span>
                <span className="flex-1 font-mono text-xs font-semibold text-[var(--color-brand-700)]">
                  {row.action}
                </span>
                <span className="text-xs tabular-nums text-[var(--color-brand-600)]">
                  {new Date(row.ts).toLocaleString()}
                </span>
              </div>
              {chainContext.nextRows.map((r) => (
                <ChainRow key={r.id} row={r} direction="next" />
              ))}
            </>
          )}
        </div>
      </section>
    </div>
  );
}
