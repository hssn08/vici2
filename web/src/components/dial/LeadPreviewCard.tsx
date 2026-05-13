"use client";

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { LeadPreview } from "@/lib/stores/dial";
import type { CallHistory, ComplianceWindow, DncResult } from "./types";

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatPhone(e164: string): string {
  // +1AAABBBCCCC → +1 (AAA) BBB-CCCC
  if (/^\+1\d{10}$/.test(e164)) {
    return `+1 (${e164.slice(2, 5)}) ${e164.slice(5, 8)}-${e164.slice(8)}`;
  }
  return e164;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function redactPii(value: string): string {
  if (value.length <= 4) return "••••";
  return `••••${value.slice(-4)}`;
}

/**
 * Returns the lead's local time string, e.g. "4:42 PM PST",
 * using tzOffsetMin (minutes from UTC) if tzName is unavailable.
 */
function leadLocalTime(lead: LeadPreview): string {
  if (lead.tzName) {
    try {
      return new Date().toLocaleTimeString("en-US", {
        timeZone: lead.tzName,
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
        timeZoneName: "short",
      });
    } catch {
      /* fall through */
    }
  }
  if (lead.tzOffsetMin !== null) {
    const localMs = Date.now() + lead.tzOffsetMin * 60_000;
    const d = new Date(localMs - new Date().getTimezoneOffset() * 60_000);
    const h = d.getUTCHours();
    const m = d.getUTCMinutes();
    const ampm = h >= 12 ? "PM" : "AM";
    const h12 = h % 12 || 12;
    const tzLabel = `UTC${lead.tzOffsetMin >= 0 ? "+" : ""}${lead.tzOffsetMin / 60}`;
    return `${h12}:${String(m).padStart(2, "0")} ${ampm} ${tzLabel}`;
  }
  return "unknown";
}

function formatRelative(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const days = Math.floor(diff / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days}d ago`;
  return new Date(isoDate).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="border-t pt-3 mt-3 first:border-t-0 first:pt-0 first:mt-0">
      <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-fg-muted)] mb-2">
        {label}
      </p>
      {children}
    </div>
  );
}

function ComplianceBadges({
  compliance,
  dnc,
}: {
  compliance: ComplianceWindow | null;
  dnc: DncResult | null;
}): React.ReactElement {
  return (
    <div className="flex flex-wrap gap-2" role="list" aria-label="Compliance status">
      {dnc === null ? (
        <Skeleton className="h-5 w-16" />
      ) : dnc.hit ? (
        <Badge
          tone="danger"
          role="listitem"
          aria-label="Federal DNC — cannot dial"
        >
          DNC
        </Badge>
      ) : (
        <Badge tone="success" role="listitem" aria-label="Not on DNC list">
          DNC clear
        </Badge>
      )}

      {compliance === null ? (
        <Skeleton className="h-5 w-20" />
      ) : compliance.allowed ? (
        <Badge tone="success" role="listitem" aria-label="Within TCPA calling window">
          TCPA ✓
        </Badge>
      ) : (
        <Badge
          tone="warning"
          role="listitem"
          aria-label={`Outside TCPA window${compliance.nextOpenAt ? ` — re-opens ${new Date(compliance.nextOpenAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short" })}` : ""}`}
        >
          Outside window
        </Badge>
      )}
    </div>
  );
}

function HistoryRow({ row }: { row: CallHistory }): React.ReactElement {
  return (
    <tr className="text-xs">
      <td className="py-1 pr-3 text-[var(--color-fg-muted)]">
        {formatRelative(row.date)}
      </td>
      <td className="py-1 pr-3">{formatDuration(row.duration)}</td>
      <td className="py-1 pr-3">
        <Badge
          tone={
            row.status === "ANSWERED"
              ? "success"
              : row.status === "NO_ANSWER"
                ? "warning"
                : "neutral"
          }
        >
          {row.status}
        </Badge>
      </td>
      <td className="py-1 text-[var(--color-fg-muted)]">
        {row.agentName ?? "—"}
      </td>
    </tr>
  );
}

// ── LeadPreviewCard ───────────────────────────────────────────────────────────

export interface LeadPreviewCardProps {
  lead: LeadPreview;
  compliance: ComplianceWindow | null;
  dnc: DncResult | null;
  history: CallHistory[] | null;
  scriptSnippet: string | null;
  /** Keys to show from customData (allowlist from campaign config) */
  agentVisibleKeys: string[];
  /** Keys that should be PII-redacted in the preview */
  redactedKeys: string[];
  loading?: boolean;
  className?: string;
}

export function LeadPreviewCard({
  lead,
  compliance,
  dnc,
  history,
  scriptSnippet,
  agentVisibleKeys,
  redactedKeys,
  loading,
  className,
}: LeadPreviewCardProps): React.ReactElement {
  const displayName =
    [lead.firstName, lead.lastName].filter(Boolean).join(" ") ||
    lead.vendorLeadCode ||
    "Unknown lead";

  const localTime = leadLocalTime(lead);

  const complianceDetail = React.useMemo(() => {
    if (!compliance) return null;
    if (compliance.allowed) {
      return (
        <p className="text-xs text-emerald-700">
          Within calling window{compliance.windowStart && compliance.windowEnd
            ? ` (${compliance.windowStart}–${compliance.windowEnd})`
            : ""}
        </p>
      );
    }
    return (
      <p className="text-xs text-amber-700">
        Outside window
        {compliance.nextOpenAt
          ? ` — re-opens ${new Date(compliance.nextOpenAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short" })}`
          : ""}
      </p>
    );
  }, [compliance]);

  const customEntries = React.useMemo(() => {
    if (!lead.customData) return [];
    return agentVisibleKeys
      .filter((k) => lead.customData && k in lead.customData)
      .map((k) => {
        const rawVal = String(lead.customData![k] ?? "");
        const val = redactedKeys.includes(k) ? redactPii(rawVal) : rawVal;
        return { key: k, value: val.slice(0, 80) };
      });
  }, [lead.customData, agentVisibleKeys, redactedKeys]);

  if (loading) {
    return (
      <div
        className={cn(
          "rounded-[var(--radius-card)] border bg-[var(--color-surface-elevated)] p-5 space-y-3",
          className,
        )}
        role="status"
        aria-label="Loading lead preview"
      >
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-4 w-56" />
      </div>
    );
  }

  return (
    <article
      className={cn(
        "rounded-[var(--radius-card)] border bg-[var(--color-surface-elevated)] p-5",
        className,
      )}
      aria-label={`Lead preview: ${displayName}`}
    >
      {/* ── Header ── */}
      <Section label="">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">{displayName}</h2>
            <p className="text-sm text-[var(--color-fg-muted)] font-mono mt-0.5">
              {formatPhone(lead.phoneE164)}
              {lead.phoneType && (
                <span className="ml-2 font-sans text-xs">({lead.phoneType})</span>
              )}
            </p>
          </div>
          <Badge tone="neutral" className="shrink-0">
            Called {lead.calledCount}×
          </Badge>
        </div>
      </Section>

      {/* ── Location + time ── */}
      <Section label="Location">
        <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-0.5 text-sm">
          {lead.city && (
            <>
              <dt className="text-[var(--color-fg-muted)]">City</dt>
              <dd>{lead.city}</dd>
            </>
          )}
          {lead.stateAbbr && (
            <>
              <dt className="text-[var(--color-fg-muted)]">State</dt>
              <dd>{lead.stateAbbr}</dd>
            </>
          )}
          {lead.postalCode && (
            <>
              <dt className="text-[var(--color-fg-muted)]">Zip</dt>
              <dd>{lead.postalCode}</dd>
            </>
          )}
          <dt className="text-[var(--color-fg-muted)]">Local time</dt>
          <dd>
            <span className="font-medium">{localTime}</span>
            {complianceDetail && (
              <span className="ml-2">{complianceDetail}</span>
            )}
          </dd>
        </dl>
      </Section>

      {/* ── Compliance badges ── */}
      <Section label="Compliance">
        <ComplianceBadges compliance={compliance} dnc={dnc} />
      </Section>

      {/* ── Call history ── */}
      <Section label="Call history">
        {history === null ? (
          <Skeleton className="h-10 w-full" />
        ) : history.length === 0 ? (
          <p className="text-xs text-[var(--color-fg-muted)]">No prior calls</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left" aria-label="Call history">
              <thead>
                <tr className="text-xs text-[var(--color-fg-muted)]">
                  <th className="pb-1 pr-3 font-normal">Date</th>
                  <th className="pb-1 pr-3 font-normal">Duration</th>
                  <th className="pb-1 pr-3 font-normal">Result</th>
                  <th className="pb-1 font-normal">Agent</th>
                </tr>
              </thead>
              <tbody>
                {history.map((row, i) => (
                  <HistoryRow key={i} row={row} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* ── Script snippet ── */}
      {scriptSnippet !== null && (
        <Section label="Script">
          <p className="text-sm italic text-[var(--color-fg-muted)] line-clamp-3">
            {scriptSnippet}
          </p>
        </Section>
      )}

      {/* ── Custom fields ── */}
      {customEntries.length > 0 && (
        <Section label="Custom fields">
          <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-0.5 text-sm">
            {customEntries.map(({ key, value }) => (
              <React.Fragment key={key}>
                <dt className="text-[var(--color-fg-muted)] capitalize">
                  {key.replaceAll("_", " ")}
                </dt>
                <dd className="truncate" title={value}>
                  {value}
                </dd>
              </React.Fragment>
            ))}
          </dl>
        </Section>
      )}
    </article>
  );
}
