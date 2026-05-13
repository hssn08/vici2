"use client";

// M04 — Attestation registry table.
//
// Cursor-paginated list of audit_attestation rows. Each row has a
// "Verify" button that calls /api/admin/audit-attestations/:id/verify
// and shows an inline AuditVerifyBadge.

import * as React from "react";
import { api, ApiError } from "@/lib/api";
import { AuditVerifyBadge, type VerifyStatus, type VerifierFailure } from "./AuditVerifyBadge";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AttestationRow {
  id: string;
  tenant_id: string;
  table_name: string;
  window_date: string;
  row_count: number;
  merkle_root: string;
  computed_at: string;
  key_id: string;
  s3_key: string | null;
}

interface AttestationListResponse {
  items: AttestationRow[];
  nextCursor: string | null;
}

interface VerifyAttestationResponse {
  ok: boolean;
  merkleRootMatches: boolean;
  signatureValid: boolean;
  rowsChecked: number;
  failures: VerifierFailure[];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AttestationTable(): React.ReactElement {
  const [rows, setRows] = React.useState<AttestationRow[]>([]);
  const [nextCursor, setNextCursor] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [hasLoaded, setHasLoaded] = React.useState(false);

  // Filters
  const [table, setTable] = React.useState("");
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");

  // Per-row verify state
  const [verifyState, setVerifyState] = React.useState<
    Record<string, { status: VerifyStatus; result: VerifyAttestationResponse | null }>
  >({});

  const buildParams = React.useCallback(
    (cursor?: string | null) => {
      const p = new URLSearchParams({ limit: "50" });
      if (table) p.set("table", table);
      if (from) p.set("from", from);
      if (to) p.set("to", to);
      if (cursor) p.set("cursor", cursor);
      return p.toString();
    },
    [table, from, to],
  );

  const fetchPage = React.useCallback(
    async (cursor?: string | null, replace = false) => {
      setLoading(true);
      setError(null);
      try {
        const result = await api.get<AttestationListResponse>(
          `/api/admin/audit-attestations?${buildParams(cursor)}`,
        );
        setRows((prev) => (replace ? result.items : [...prev, ...result.items]));
        setNextCursor(result.nextCursor);
        setHasLoaded(true);
      } catch (err) {
        const msg = err instanceof ApiError ? err.message : "Failed to load attestations";
        setError(msg);
      } finally {
        setLoading(false);
      }
    },
    [buildParams],
  );

  React.useEffect(() => {
    void fetchPage(null, true);
  }, [fetchPage]);

  const handleVerify = React.useCallback(async (id: string) => {
    setVerifyState((prev) => ({ ...prev, [id]: { status: "loading", result: null } }));
    try {
      const result = await api.get<VerifyAttestationResponse>(
        `/api/admin/audit-attestations/${id}/verify`,
      );
      setVerifyState((prev) => ({
        ...prev,
        [id]: { status: result.ok ? "ok" : "fail", result },
      }));
    } catch {
      setVerifyState((prev) => ({
        ...prev,
        [id]: { status: "fail", result: null },
      }));
    }
  }, []);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    void fetchPage(null, true);
  };

  return (
    <div className="space-y-4">
      {/* Filter form */}
      <form
        onSubmit={handleSearch}
        className="flex flex-wrap gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
        aria-label="Attestation filters"
      >
        <input
          type="text"
          placeholder="Table name…"
          value={table}
          onChange={(e) => setTable(e.target.value)}
          className="h-8 rounded border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-2 text-sm text-[var(--color-fg)] placeholder-[var(--color-fg-muted)] w-40"
          aria-label="Filter by table"
        />
        <input
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className="h-8 rounded border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-2 text-sm text-[var(--color-fg)] w-36"
          aria-label="From date"
        />
        <input
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="h-8 rounded border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-2 text-sm text-[var(--color-fg)] w-36"
          aria-label="To date"
        />
        <button
          type="submit"
          className="h-8 rounded bg-[var(--color-brand-600)] px-3 text-sm font-medium text-white hover:bg-[var(--color-brand-700)] transition-colors"
        >
          Filter
        </button>
      </form>

      {/* Error state */}
      {error && (
        <div role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto rounded-md border border-[var(--color-border)]">
        <table
          role="grid"
          className="w-full min-w-[900px] text-sm"
          aria-label="Attestation rows"
          aria-busy={loading}
        >
          <thead className="bg-[var(--color-surface-muted)]">
            <tr>
              {["ID", "Table", "Date", "Rows", "Merkle root", "Computed at", "S3 key", "Verify"].map((col) => (
                <th
                  key={col}
                  scope="col"
                  className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-[var(--color-fg-muted)]"
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            {rows.map((row) => {
              const vs = verifyState[row.id];
              return (
                <tr key={row.id} className="hover:bg-[var(--color-surface-muted)] transition-colors">
                  <td className="px-3 py-2 font-mono text-xs text-[var(--color-fg-muted)]">{row.id}</td>
                  <td className="px-3 py-2 font-mono text-xs text-[var(--color-fg)]">{row.table_name}</td>
                  <td className="px-3 py-2 text-xs tabular-nums text-[var(--color-fg)]">
                    {String(row.window_date).slice(0, 10)}
                  </td>
                  <td className="px-3 py-2 text-xs tabular-nums text-[var(--color-fg)]">
                    {row.row_count.toLocaleString()}
                  </td>
                  <td
                    className="px-3 py-2 font-mono text-xs text-[var(--color-fg-muted)]"
                    title={row.merkle_root}
                  >
                    {row.merkle_root.slice(0, 12)}…
                  </td>
                  <td className="px-3 py-2 text-xs tabular-nums text-[var(--color-fg-muted)]">
                    {new Date(row.computed_at).toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-xs text-[var(--color-fg-muted)]">
                    {row.s3_key ? (
                      <span className="font-mono" title={row.s3_key}>
                        {row.s3_key.slice(-20)}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-3 py-3">
                    <AuditVerifyBadge
                      status={vs?.status ?? "idle"}
                      failures={vs?.result?.failures}
                      rowsChecked={vs?.result?.rowsChecked}
                      onVerify={() => void handleVerify(row.id)}
                    />
                    {vs?.result && (
                      <dl className="mt-1 text-[10px] text-[var(--color-fg-muted)] space-y-0.5">
                        <div className="flex gap-1">
                          <dt>Merkle root:</dt>
                          <dd className={vs.result.merkleRootMatches ? "text-green-600" : "text-red-600"}>
                            {vs.result.merkleRootMatches ? "match" : "MISMATCH"}
                          </dd>
                        </div>
                        <div className="flex gap-1">
                          <dt>Signature:</dt>
                          <dd className={vs.result.signatureValid ? "text-green-600" : "text-[var(--color-fg-muted)]"}>
                            {vs.result.signatureValid ? "valid" : "not checked"}
                          </dd>
                        </div>
                      </dl>
                    )}
                  </td>
                </tr>
              );
            })}

            {hasLoaded && rows.length === 0 && !loading && (
              <tr>
                <td
                  colSpan={8}
                  className="px-3 py-8 text-center text-sm text-[var(--color-fg-muted)]"
                >
                  No attestations found.
                </td>
              </tr>
            )}

            {loading && (
              <tr aria-hidden>
                <td colSpan={8} className="px-3 py-4">
                  <div className="space-y-2">
                    {Array.from({ length: 3 }).map((_, i) => (
                      <div
                        key={i}
                        className="h-8 animate-pulse rounded bg-[var(--color-surface-muted)]"
                      />
                    ))}
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {nextCursor && !loading && (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={() => void fetchPage(nextCursor)}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2 text-sm font-medium text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)] transition-colors"
          >
            Load more
          </button>
        </div>
      )}
    </div>
  );
}
