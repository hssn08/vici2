"use client";

// M05 — Unified settings panel.
//
// Orchestrates all settings tabs. Loads data from GET /api/admin/settings,
// tracks per-tab state changes, and PATCHes on submit.
//
// A11y: WCAG 2.2 AA — SettingsTabs handles tab keyboard navigation.
//       SaveBar provides status announcements via role="alert" / role="status".

import * as React from "react";
import { api, ApiError } from "@/lib/api/index";
import { useAuthStore } from "@/lib/stores/auth";
import { SettingsTabs } from "./SettingsTabs";
import { GeneralTab, type GeneralState } from "./GeneralTab";
import { AuthTab } from "./AuthTab";
import { ComplianceTab, type ComplianceState } from "./ComplianceTab";
import { TelephonyTab } from "./TelephonyTab";
import { ObservabilityTab } from "./ObservabilityTab";
import { PacingTab, type PacingState } from "./PacingTab";
import { SaveBar } from "./shared";
import type { TenantSettingsData, AuthConfigData } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PendingChanges {
  general?: Partial<GeneralState>;
  auth?: Partial<AuthConfigData>;
  compliance?: Partial<ComplianceState>;
  pacing?: Partial<PacingState>;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SettingsPanel(): React.ReactElement {
  const user = useAuthStore((s) => s.user);
  // The API JWT role claim may include "super_admin"; the web auth store
  // union doesn't enumerate it (it strips to "admin" for Phase 1). Cast
  // to string to avoid a spurious TS overlap error.
  const isSuperAdmin = (user?.role as string) === "super_admin";

  const [data, setData] = React.useState<TenantSettingsData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const [pending, setPending] = React.useState<PendingChanges>({});
  const [saving, setSaving] = React.useState(false);
  const [successMsg, setSuccessMsg] = React.useState<string | null>(null);
  const [saveError, setSaveError] = React.useState<string | null>(null);

  // Load settings on mount
  React.useEffect(() => {
    let cancelled = false;
    api
      .get<TenantSettingsData>("/api/admin/settings")
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err) => {
        if (!cancelled) {
          setLoadError(
            err instanceof ApiError ? err.message : "Failed to load settings",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Build PATCH body from pending changes
  const buildPatchBody = (): Record<string, unknown> => {
    const body: Record<string, unknown> = {};
    const g = pending.general;
    if (g) {
      if (g.name !== undefined) body.name = g.name;
      body.settings = {
        ...(g.brandLabel !== undefined ? { brandLabel: g.brandLabel } : {}),
        ...(g.reportTimezone !== undefined ? { reportTimezone: g.reportTimezone } : {}),
        ...(g.supportEmail !== undefined
          ? { supportEmail: g.supportEmail || null }
          : {}),
      };
    }
    const c = pending.compliance;
    if (c) {
      if (c.consentMinimumMode !== undefined)
        body.consentMinimumMode = c.consentMinimumMode;
      if (c.internalDncRetentionYears !== undefined)
        body.internalDncRetentionYears = c.internalDncRetentionYears;
      if (c.defaultCallerState !== undefined)
        body.defaultCallerState = c.defaultCallerState || null;
      // Merge compliance flags into settings
      body.settings = {
        ...(body.settings as Record<string, unknown>),
        ...(c.unknownTzPolicyDefault !== undefined
          ? { unknownTzPolicyDefault: c.unknownTzPolicyDefault }
          : {}),
        ...(c.recordingConsentDefault !== undefined
          ? { recordingConsentDefault: c.recordingConsentDefault }
          : {}),
        ...(c.allowCallTimeOverrides !== undefined
          ? { allowCallTimeOverrides: c.allowCallTimeOverrides }
          : {}),
      };
    }
    const p = pending.pacing;
    if (p) {
      body.settings = {
        ...(body.settings as Record<string, unknown>),
        pacingDefaults: {
          ...(p.dialMethod !== undefined ? { dialMethod: p.dialMethod } : {}),
          ...(p.dropTargetMax !== undefined ? { dropTargetMax: p.dropTargetMax } : {}),
        },
      };
    }
    if (pending.auth && isSuperAdmin) {
      body.auth = pending.auth;
    }
    return body;
  };

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!data) return;
    const body = buildPatchBody();
    if (Object.keys(body).length === 0) {
      setSuccessMsg("No changes to save");
      return;
    }
    setSaving(true);
    setSaveError(null);
    setSuccessMsg(null);
    try {
      const updated = await api.patch<TenantSettingsData>("/api/admin/settings", body);
      setData(updated);
      setPending({});
      setSuccessMsg("Settings saved successfully");
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.code === "forbidden"
            ? "You do not have permission to change these settings"
            : err.message
          : "Failed to save settings";
      setSaveError(msg);
    } finally {
      setSaving(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Loading / error states
  // ---------------------------------------------------------------------------

  if (loading) {
    return (
      <div role="status" aria-label="Loading settings" className="space-y-4">
        {[1, 2, 3, 4, 5].map((i) => (
          <div
            key={i}
            className="h-10 animate-pulse rounded-md bg-[var(--color-surface-muted)]"
            aria-hidden
          />
        ))}
      </div>
    );
  }

  if (loadError) {
    return (
      <div role="alert" className="rounded-md bg-red-50 p-4 text-sm text-red-700">
        {loadError}
      </div>
    );
  }

  if (!data) return <></>;

  // ---------------------------------------------------------------------------
  // Tab definitions
  // ---------------------------------------------------------------------------

  const tabs = [
    {
      key: "general",
      label: "General",
      panel: (
        <GeneralTab
          data={data}
          onChange={(patch) =>
            setPending((p) => ({ ...p, general: { ...p.general, ...patch } }))
          }
        />
      ),
    },
    {
      key: "auth",
      label: "Auth",
      panel: (
        <AuthTab
          auth={data.auth}
          isSuperAdmin={isSuperAdmin}
          onChange={(patch) =>
            setPending((p) => ({ ...p, auth: { ...p.auth, ...patch } }))
          }
        />
      ),
    },
    {
      key: "compliance",
      label: "Compliance",
      panel: (
        <ComplianceTab
          data={data}
          onChange={(patch) =>
            setPending((p) => ({ ...p, compliance: { ...p.compliance, ...patch } }))
          }
        />
      ),
    },
    {
      key: "telephony",
      label: "Telephony",
      panel: <TelephonyTab />,
    },
    {
      key: "observability",
      label: "Observability",
      panel: <ObservabilityTab />,
    },
    {
      key: "pacing",
      label: "Pacing",
      panel: (
        <PacingTab
          data={data}
          onChange={(patch) =>
            setPending((p) => ({ ...p, pacing: { ...p.pacing, ...patch } }))
          }
        />
      ),
    },
  ];

  return (
    <form
      id="settings-form"
      onSubmit={(e) => void handleSubmit(e)}
      noValidate
      aria-label="Tenant settings"
    >
      <SettingsTabs tabs={tabs} defaultTab="general" />

      <SaveBar
        saving={saving}
        successMsg={successMsg}
        saveError={saveError}
        onSubmit={handleSubmit}
        updatedAt={data.updatedAt}
      />
    </form>
  );
}
