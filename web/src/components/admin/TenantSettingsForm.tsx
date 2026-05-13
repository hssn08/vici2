"use client";

// M01 — Tenant settings form component.
//
// Loads current tenant settings from GET /api/admin/settings and POSTes
// updates to PATCH /api/admin/settings.  Only super_admin users will have
// permission; the API enforces this — the UI shows a friendly error otherwise.
//
// A11y: All fields labeled, error messages associated via aria-describedby.

import * as React from "react";
import { api, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// ---------------------------------------------------------------------------
// Types (mirrors api/src/routes/admin/settings/schema.ts)
// ---------------------------------------------------------------------------

interface TenantSettings {
  id: string;
  name: string;
  slug: string;
  active: boolean;
  settings: {
    recordingConsentDefault?: boolean;
    allowCallTimeOverrides?: boolean;
    brandLabel?: string;
    reportTimezone?: string;
  };
  internalDncRetentionYears: number;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TenantSettingsForm(): React.ReactElement {
  const [data, setData] = React.useState<TenantSettings | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [successMsg, setSuccessMsg] = React.useState<string | null>(null);
  const [saveError, setSaveError] = React.useState<string | null>(null);

  // Local form state (initialised from API data)
  const [name, setName] = React.useState("");
  const [brandLabel, setBrandLabel] = React.useState("");
  const [reportTimezone, setReportTimezone] = React.useState("");
  const [recordingConsentDefault, setRecordingConsentDefault] = React.useState(false);
  const [allowCallTimeOverrides, setAllowCallTimeOverrides] = React.useState(false);
  const [dncRetention, setDncRetention] = React.useState(5);

  React.useEffect(() => {
    let cancelled = false;
    api
      .get<TenantSettings>("/api/admin/settings")
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setName(d.name);
        setBrandLabel(d.settings.brandLabel ?? "");
        setReportTimezone(d.settings.reportTimezone ?? "");
        setRecordingConsentDefault(d.settings.recordingConsentDefault ?? false);
        setAllowCallTimeOverrides(d.settings.allowCallTimeOverrides ?? false);
        setDncRetention(d.internalDncRetentionYears);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : "Failed to load settings");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setSaving(true);
    setSaveError(null);
    setSuccessMsg(null);
    try {
      const updated = await api.patch<TenantSettings>("/api/admin/settings", {
        name: name || undefined,
        internalDncRetentionYears: dncRetention,
        settings: {
          brandLabel: brandLabel || undefined,
          reportTimezone: reportTimezone || undefined,
          recordingConsentDefault,
          allowCallTimeOverrides,
        },
      });
      setData(updated);
      setSuccessMsg("Settings saved successfully");
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.code === "forbidden"
            ? "You need super_admin role to change tenant settings"
            : err.message
          : "Failed to save settings";
      setSaveError(msg);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div role="status" aria-label="Loading settings" className="space-y-3">
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="h-10 animate-pulse rounded-md bg-[var(--color-surface-muted)]"
            aria-hidden
          />
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

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      noValidate
      aria-label="Tenant settings"
    >
      {/* Tenant identity */}
      <fieldset className="space-y-4">
        <legend className="text-base font-semibold text-[var(--color-fg)]">
          Identity
        </legend>

        <div className="space-y-1">
          <label
            htmlFor="tenant-name"
            className="block text-sm font-medium text-[var(--color-fg)]"
          >
            Tenant name
          </label>
          <Input
            id="tenant-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My Company"
            aria-label="Tenant display name"
          />
        </div>

        <div className="space-y-1">
          <label
            htmlFor="brand-label"
            className="block text-sm font-medium text-[var(--color-fg)]"
          >
            Brand label
          </label>
          <Input
            id="brand-label"
            type="text"
            value={brandLabel}
            onChange={(e) => setBrandLabel(e.target.value)}
            placeholder="Shown in admin sidebar"
            aria-label="Brand label shown in admin UI"
          />
        </div>

        <div className="space-y-1">
          <label
            htmlFor="slug"
            className="block text-sm font-medium text-[var(--color-fg-muted)]"
          >
            Slug (read-only)
          </label>
          <Input
            id="slug"
            type="text"
            value={data.slug}
            readOnly
            disabled
            aria-readonly="true"
            className="opacity-60"
          />
        </div>
      </fieldset>

      {/* Compliance */}
      <fieldset className="mt-6 space-y-4">
        <legend className="text-base font-semibold text-[var(--color-fg)]">
          Compliance &amp; policy
        </legend>

        <div className="space-y-3">
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={recordingConsentDefault}
              onChange={(e) => setRecordingConsentDefault(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border"
              aria-label="Require recording consent on new campaigns by default"
            />
            <span className="text-sm text-[var(--color-fg)]">
              <span className="font-medium">Recording consent required by default</span>
              <br />
              <span className="text-[var(--color-fg-muted)]">
                New campaigns will default to requiring prior express written consent.
              </span>
            </span>
          </label>

          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={allowCallTimeOverrides}
              onChange={(e) => setAllowCallTimeOverrides(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border"
              aria-label="Allow call time overrides per campaign"
            />
            <span className="text-sm text-[var(--color-fg)]">
              <span className="font-medium">Allow per-campaign call time overrides</span>
              <br />
              <span className="text-[var(--color-fg-muted)]">
                Admins can set state-specific calling windows on individual campaigns.
              </span>
            </span>
          </label>
        </div>

        <div className="space-y-1">
          <label
            htmlFor="dnc-retention"
            className="block text-sm font-medium text-[var(--color-fg)]"
          >
            Internal DNC retention (years)
          </label>
          <Input
            id="dnc-retention"
            type="number"
            min={5}
            max={99}
            value={dncRetention}
            onChange={(e) => setDncRetention(Math.max(5, Math.min(99, Number(e.target.value))))}
            className="max-w-[7rem]"
            aria-label="Internal DNC retention period in years (FCC minimum 5 years)"
            aria-describedby="dnc-retention-hint"
          />
          <p id="dnc-retention-hint" className="text-xs text-[var(--color-fg-muted)]">
            FCC floor is 5 years (47 C.F.R. §64.1200(d)(6)). Set to 99 for indefinite.
          </p>
        </div>
      </fieldset>

      {/* Reports */}
      <fieldset className="mt-6 space-y-4">
        <legend className="text-base font-semibold text-[var(--color-fg)]">
          Reports
        </legend>

        <div className="space-y-1">
          <label
            htmlFor="report-tz"
            className="block text-sm font-medium text-[var(--color-fg)]"
          >
            Report timezone
          </label>
          <Input
            id="report-tz"
            type="text"
            value={reportTimezone}
            onChange={(e) => setReportTimezone(e.target.value)}
            placeholder="America/New_York"
            aria-label="IANA timezone used for scheduled reports"
            aria-describedby="report-tz-hint"
          />
          <p id="report-tz-hint" className="text-xs text-[var(--color-fg-muted)]">
            IANA timezone identifier, e.g. America/New_York.
          </p>
        </div>
      </fieldset>

      {saveError && (
        <div role="alert" className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700">
          {saveError}
        </div>
      )}

      {successMsg && (
        <div role="status" className="mt-4 rounded-md bg-green-50 p-3 text-sm text-green-700">
          {successMsg}
        </div>
      )}

      <div className="mt-6 flex items-center gap-3">
        <Button type="submit" loading={saving} aria-label="Save tenant settings">
          Save settings
        </Button>
        <p className="text-xs text-[var(--color-fg-muted)]">
          Last updated: {new Date(data.updatedAt).toLocaleString()}
        </p>
      </div>
    </form>
  );
}
