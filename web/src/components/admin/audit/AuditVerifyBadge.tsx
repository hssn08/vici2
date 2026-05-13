"use client";

// M04 — Audit verification badge component.
//
// Displays the result of calling /api/admin/audit-log/:id/verify or
// /api/admin/audit-attestations/:id/verify.
// Props:
//   • status: 'idle' | 'loading' | 'ok' | 'fail'
//   • failures: VerifierFailure[] (shown when status=fail)
//   • onVerify: () => void  (called when user clicks "Verify" button)

import * as React from "react";

export interface VerifierFailure {
  kind: string;
  table: string;
  id?: string;
  date?: string;
  expected?: string;
  actual?: string;
}

export type VerifyStatus = "idle" | "loading" | "ok" | "fail";

interface AuditVerifyBadgeProps {
  status: VerifyStatus;
  failures?: VerifierFailure[];
  rowsChecked?: number;
  daysChecked?: number;
  attestationsChecked?: number;
  onVerify: () => void;
}

export function AuditVerifyBadge({
  status,
  failures = [],
  rowsChecked,
  daysChecked,
  attestationsChecked,
  onVerify,
}: AuditVerifyBadgeProps): React.ReactElement {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onVerify}
          disabled={status === "loading"}
          aria-busy={status === "loading"}
          className="inline-flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm font-medium text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)] disabled:opacity-50 transition-colors"
        >
          {status === "loading" ? (
            <>
              <span
                className="h-3 w-3 animate-spin rounded-full border-2 border-[var(--color-brand-600)] border-t-transparent"
                aria-hidden
              />
              Verifying…
            </>
          ) : (
            "Verify chain"
          )}
        </button>

        {status === "ok" && (
          <span
            role="status"
            aria-label="Chain verified"
            className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-700"
          >
            <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 20 20" aria-hidden>
              <path
                fillRule="evenodd"
                d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                clipRule="evenodd"
              />
            </svg>
            Verified
          </span>
        )}

        {status === "fail" && (
          <span
            role="alert"
            aria-label="Chain verification failed"
            className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-medium text-red-700"
          >
            <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 20 20" aria-hidden>
              <path
                fillRule="evenodd"
                d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
                clipRule="evenodd"
              />
            </svg>
            Failed
          </span>
        )}
      </div>

      {(status === "ok" || status === "fail") && (
        <dl className="text-xs text-[var(--color-fg-muted)] space-y-0.5">
          {rowsChecked != null && (
            <div className="flex gap-2">
              <dt className="font-medium">Rows checked:</dt>
              <dd>{rowsChecked}</dd>
            </div>
          )}
          {daysChecked != null && (
            <div className="flex gap-2">
              <dt className="font-medium">Days checked:</dt>
              <dd>{daysChecked}</dd>
            </div>
          )}
          {attestationsChecked != null && (
            <div className="flex gap-2">
              <dt className="font-medium">Attestations checked:</dt>
              <dd>{attestationsChecked}</dd>
            </div>
          )}
        </dl>
      )}

      {status === "fail" && failures.length > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs font-medium text-red-600">
            {failures.length} failure{failures.length !== 1 ? "s" : ""}
          </summary>
          <ul className="mt-1 space-y-1 text-xs text-red-700">
            {failures.map((f, i) => (
              <li key={i} className="rounded bg-red-50 px-2 py-1">
                <span className="font-mono font-medium">{f.kind}</span>
                {f.date && <span> on {f.date}</span>}
                {f.id && <span> (id={f.id})</span>}
                {f.expected && (
                  <div className="mt-0.5 text-[10px]">
                    expected: <span className="font-mono">{f.expected.slice(0, 16)}…</span>
                  </div>
                )}
                {f.actual && (
                  <div className="text-[10px]">
                    actual: <span className="font-mono">{f.actual.slice(0, 16)}…</span>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
