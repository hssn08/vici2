"use client";

// M05 — Auth / session settings tab.
// Surfaces auth_config row (password policy, lockout, TTLs, TOTP grace).
// Only super_admin may save changes to this tab; the API enforces this;
// the UI shows a read-only notice for admin role.

import * as React from "react";
import { NumberField, SectionHeading } from "./shared";
import type { AuthConfigData } from "./types";

interface AuthTabProps {
  auth: AuthConfigData;
  isSuperAdmin: boolean;
  onChange: (patch: Partial<AuthConfigData>) => void;
}

export function AuthTab({ auth, isSuperAdmin, onChange }: AuthTabProps): React.ReactElement {
  const [state, setState] = React.useState<AuthConfigData>({ ...auth });

  const update = <K extends keyof AuthConfigData>(k: K, v: number): void => {
    const next = { ...state, [k]: v };
    setState(next);
    onChange(next);
  };

  const ro = !isSuperAdmin;

  return (
    <fieldset className="space-y-5 border-0 p-0 m-0" disabled={ro}>
      <legend className="sr-only">Authentication and session settings</legend>

      {ro && (
        <div
          role="note"
          className="rounded-md bg-yellow-50 px-4 py-3 text-sm text-yellow-800"
        >
          Authentication policy can only be changed by a{" "}
          <strong>super_admin</strong>. These values are shown read-only.
        </div>
      )}

      <SectionHeading>Password policy</SectionHeading>

      <NumberField
        id="pwd-min-length"
        label="Minimum password length"
        min={8}
        max={128}
        value={state.passwordMinLength}
        onChange={(e) =>
          update("passwordMinLength", Math.max(8, Math.min(128, Number(e.target.value))))
        }
        hint="Characters required. OWASP minimum is 8; recommended 12."
        readOnly={ro}
        className="max-w-[8rem]"
      />

      <SectionHeading>Lockout policy</SectionHeading>

      <NumberField
        id="lockout-failures"
        label="Failed attempts before lockout"
        min={3}
        max={20}
        value={state.lockoutAfterFailures}
        onChange={(e) =>
          update("lockoutAfterFailures", Math.max(3, Math.min(20, Number(e.target.value))))
        }
        hint="Range 3–20. OWASP recommends 5."
        readOnly={ro}
        className="max-w-[8rem]"
      />

      <NumberField
        id="lockout-window"
        label="Lockout window (seconds)"
        min={60}
        max={86400}
        value={state.lockoutWindowSeconds}
        onChange={(e) =>
          update(
            "lockoutWindowSeconds",
            Math.max(60, Math.min(86400, Number(e.target.value))),
          )
        }
        hint="How long the lockout lasts. Must be less than the access token TTL. Default: 900 (15 min)."
        readOnly={ro}
        className="max-w-[10rem]"
      />

      <SectionHeading>Session TTLs</SectionHeading>

      <NumberField
        id="access-ttl"
        label="Access token TTL (seconds)"
        min={60}
        max={3600}
        value={state.accessTokenTtlSeconds}
        onChange={(e) =>
          update(
            "accessTokenTtlSeconds",
            Math.max(60, Math.min(3600, Number(e.target.value))),
          )
        }
        hint="Short-lived JWT TTL. Default: 900 (15 min). Max 1 hour."
        readOnly={ro}
        className="max-w-[10rem]"
      />

      <NumberField
        id="refresh-ttl"
        label="Refresh token TTL (seconds)"
        min={3600}
        max={7776000}
        value={state.refreshTokenTtlSeconds}
        onChange={(e) =>
          update(
            "refreshTokenTtlSeconds",
            Math.max(3600, Math.min(7776000, Number(e.target.value))),
          )
        }
        hint="Long-lived session TTL. Default: 2592000 (30 days). Max 90 days."
        readOnly={ro}
        className="max-w-[10rem]"
      />

      <SectionHeading>TOTP (two-factor)</SectionHeading>

      <NumberField
        id="totp-grace"
        label="TOTP grace period (days)"
        min={0}
        max={30}
        value={state.totpGracePeriodDays}
        onChange={(e) =>
          update("totpGracePeriodDays", Math.max(0, Math.min(30, Number(e.target.value))))
        }
        hint="Days after which TOTP enrollment is required if totp_required=true. Set to 0 for immediate enforcement."
        readOnly={ro}
        className="max-w-[8rem]"
      />
    </fieldset>
  );
}
