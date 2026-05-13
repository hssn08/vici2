"use client";

import * as React from "react";
import { useCallStore, type ConsentStatus } from "@/lib/stores/call";

function formatPhone(e164: string): string {
  // Basic US number formatting: +1XXXXXXXXXX -> +1 (XXX) XXX-XXXX
  const match = e164.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  if (match) return `+1 (${match[1]}) ${match[2]}-${match[3]}`;
  return e164;
}

function computeAge(dob: string): number | null {
  try {
    const birth = new Date(dob);
    const now = new Date();
    let age = now.getFullYear() - birth.getFullYear();
    const m = now.getMonth() - birth.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) age--;
    return age;
  } catch {
    return null;
  }
}

function localTime(tzOffsetMin: number | undefined): string | null {
  if (tzOffsetMin === undefined || tzOffsetMin === null) return null;
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  const local = new Date(utcMs + tzOffsetMin * 60000);
  return local.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

interface ConsentLineProps {
  consent: ConsentStatus;
  recording: string;
  recordingMode: string;
}

function ConsentLine({ consent, recording, recordingMode }: ConsentLineProps): React.ReactElement | null {
  if (recordingMode === "NEVER") {
    return <span className="text-xs text-[var(--color-fg-muted)]">Recording: OFF — campaign config</span>;
  }
  if (recording === "pending") {
    return <span className="text-xs text-orange-500">Pending consent...</span>;
  }
  if (recording === "paused") {
    return <span className="text-xs text-yellow-500">Recording: PAUSED</span>;
  }

  const map: Record<string, string> = {
    ALLOW: "Recording: ON (1-party state)",
    PROMPT_MESSAGE: "Recording: ON — verbal disclosure played",
    PROMPT_BEEP: "Recording: ON — beep cadence",
    REQUIRE_ACTIVE: recording === "on" ? "Recording: ON — customer consented (DTMF 1)" : "Recording: OFF — customer declined",
    SKIP: "Recording: OFF — consent denied",
  };

  const text = consent ? (map[consent] ?? "Recording: unknown") : "Recording: OFF";

  return <span className="text-xs text-[var(--color-fg-muted)]">{text}</span>;
}

interface EditableFieldProps {
  label: string;
  value: string | undefined;
  leadId: string;
  field: "phone_alt" | "phone_alt2" | "email";
}

function EditableField({ label, value, leadId, field }: EditableFieldProps): React.ReactElement {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(value ?? "");

  const save = async () => {
    setEditing(false);
    if (draft === value) return;
    try {
      await fetch(`/api/agent/lead/${leadId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [field]: draft }),
      });
    } catch {
      // best-effort
    }
  };

  if (editing) {
    return (
      <div className="flex items-center gap-1">
        <dt className="text-xs text-[var(--color-fg-muted)] w-20">{label}:</dt>
        <dd>
          <input
            aria-label={label}
            className="rounded border border-[var(--color-surface-border)] bg-[var(--color-surface)] px-1 py-0.5 text-xs"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void save()}
            onKeyDown={(e) => { if (e.key === "Enter") void save(); if (e.key === "Escape") setEditing(false); }}
            autoFocus
          />
        </dd>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1 group">
      <dt className="text-xs text-[var(--color-fg-muted)] w-20">{label}:</dt>
      <dd className="text-xs">
        {value ?? <span className="text-[var(--color-fg-muted)]">—</span>}
        <button
          aria-label={`Edit ${label}`}
          onClick={() => { setDraft(value ?? ""); setEditing(true); }}
          className="ml-1 opacity-0 group-hover:opacity-100 text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] text-xs"
        >
          ✏
        </button>
      </dd>
    </div>
  );
}

export function LeadInfoCard(): React.ReactElement {
  const lead = useCallStore((s) => s.lead);
  const consent = useCallStore((s) => s.consent);
  const recording = useCallStore((s) => s.recording);
  const campaign = useCallStore((s) => s.campaign);
  const [, forceUpdate] = React.useReducer((x: number) => x + 1, 0);

  // Update local time every minute
  React.useEffect(() => {
    const id = setInterval(forceUpdate, 60_000);
    return () => clearInterval(id);
  }, []);

  if (!lead) {
    return (
      <div className="p-4 text-sm text-[var(--color-fg-muted)]">No lead info available.</div>
    );
  }

  const fullName = [lead.title, lead.firstName, lead.middleInitial ? `${lead.middleInitial}.` : undefined, lead.lastName]
    .filter(Boolean)
    .join(" ");
  const address = [lead.address1, lead.address2].filter(Boolean).join(", ");
  const cityStateZip = [lead.city, lead.state, lead.postalCode].filter(Boolean).join(", ");
  const age = lead.dateOfBirth ? computeAge(lead.dateOfBirth) : null;
  const local = localTime(lead.tzOffsetMin);
  const customEntries = lead.customData ? Object.entries(lead.customData) : [];

  return (
    <div className="p-4">
      <dl className="space-y-1">
        {/* Identity */}
        {fullName && (
          <div>
            <dt className="sr-only">Name</dt>
            <dd className="font-semibold text-sm">{fullName}</dd>
          </div>
        )}
        <div className="flex items-center gap-1">
          <dt className="text-xs text-[var(--color-fg-muted)] w-20">Phone:</dt>
          <dd className="text-xs font-mono">{formatPhone(lead.phoneE164)}</dd>
        </div>
        {lead.phoneAlt && (
          <EditableField label="Alt" value={lead.phoneAlt} leadId={lead.id} field="phone_alt" />
        )}
        {lead.phoneAlt2 && (
          <EditableField label="Alt 2" value={lead.phoneAlt2} leadId={lead.id} field="phone_alt2" />
        )}

        {/* Email */}
        {lead.email !== undefined && (
          <EditableField label="Email" value={lead.email} leadId={lead.id} field="email" />
        )}

        {/* Address */}
        {address && (
          <div className="flex items-start gap-1">
            <dt className="text-xs text-[var(--color-fg-muted)] w-20 shrink-0">Address:</dt>
            <dd className="text-xs">{address}</dd>
          </div>
        )}
        {cityStateZip && (
          <div className="flex items-center gap-1">
            <dt className="sr-only">City State Zip</dt>
            <dd className="text-xs pl-[84px]">{cityStateZip}</dd>
          </div>
        )}

        {/* DOB */}
        {lead.dateOfBirth && (
          <div className="flex items-center gap-1">
            <dt className="text-xs text-[var(--color-fg-muted)] w-20">DOB:</dt>
            <dd className="text-xs">{lead.dateOfBirth}{age !== null ? ` (${age})` : ""}</dd>
          </div>
        )}

        {/* Vendor */}
        {lead.vendorLeadCode && (
          <div className="flex items-center gap-1">
            <dt className="text-xs text-[var(--color-fg-muted)] w-20">Vendor:</dt>
            <dd className="text-xs text-[var(--color-fg-muted)]">{lead.vendorLeadCode}</dd>
          </div>
        )}

        {/* Status + count */}
        {lead.status && (
          <div className="flex items-center gap-2">
            <dt className="text-xs text-[var(--color-fg-muted)] w-20">Status:</dt>
            <dd>
              <span className="rounded-full bg-[var(--color-surface-muted)] px-2 py-0.5 text-xs">
                {lead.status}
              </span>
            </dd>
            {lead.calledCount !== undefined && (
              <dd className="text-xs text-[var(--color-fg-muted)]">{lead.calledCount}×</dd>
            )}
          </div>
        )}

        {/* Local time */}
        {local && (
          <div className="flex items-center gap-1">
            <dt className="text-xs text-[var(--color-fg-muted)] w-20">Local:</dt>
            <dd className="text-xs font-mono">{local}</dd>
          </div>
        )}

        {/* List */}
        {lead.listName && (
          <div className="flex items-center gap-1">
            <dt className="text-xs text-[var(--color-fg-muted)] w-20">List:</dt>
            <dd className="text-xs">{lead.listName}</dd>
          </div>
        )}

        {/* Recording consent line */}
        <div className="pt-1">
          <ConsentLine
            consent={consent}
            recording={recording}
            recordingMode={campaign?.recording_mode ?? "NEVER"}
          />
        </div>
      </dl>

      {/* Custom fields */}
      {customEntries.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]">
            Custom fields ({customEntries.length})
          </summary>
          <dl className="mt-2 space-y-1">
            {customEntries.map(([key, val]) => (
              <div key={key} className="flex items-start gap-1">
                <dt className="text-xs text-[var(--color-fg-muted)] capitalize">
                  {key.replace(/_/g, " ")}:
                </dt>
                <dd className="text-xs break-all">
                  {typeof val === "object" ? (
                    <code className="font-mono text-[10px]">{JSON.stringify(val)}</code>
                  ) : (
                    String(val)
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </div>
  );
}
