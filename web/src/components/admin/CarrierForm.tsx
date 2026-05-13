"use client";

// M06 — Carrier create/edit form.
//
// Used for both create (mode="create") and edit (mode="edit") flows.
// Credential fields (username/password) visible only to super_admin.
// On save, redirects to /admin/carriers.

import * as React from "react";
import { apiFetch, ApiError } from "@/lib/api";
import { useAuthStore } from "@/lib/stores/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CarrierFormValues {
  name: string;
  kind: string;
  proxy: string;
  username?: string;
  password?: string;
  register: boolean;
  callerIdE164?: string;
  active: boolean;
  sendPai: boolean;
  isEmergency: boolean;
  maxConcurrent?: number;
  ipAllowlist: string;   // comma-separated string in the form
}

interface CarrierData {
  id: string;
  name: string;
  kind: string;
  proxy: string;
  credentialStatus: "set" | "unset";
  register: boolean;
  callerIdE164: string | null;
  active: boolean;
  sendPai: boolean;
  isEmergency: boolean;
  maxConcurrent: number | null;
  ipAllowlist: string[];
}

const CARRIER_KINDS = [
  "twilio",
  "telnyx-creds",
  "telnyx-ip",
  "signalwire",
  "ringcentral",
  "bandwidth",
  "flowroute",
  "byoc",
];

interface CarrierFormProps {
  mode: "create" | "edit";
  initialData?: CarrierData;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CarrierForm({ mode, initialData }: CarrierFormProps): React.ReactElement {
  const user = useAuthStore((s) => s.user);
  const isSuperAdmin = user?.role === "super_admin" || user?.role === "superadmin";

  const [values, setValues] = React.useState<CarrierFormValues>({
    name: initialData?.name ?? "",
    kind: initialData?.kind ?? "byoc",
    proxy: initialData?.proxy ?? "",
    username: "",
    password: "",
    register: initialData?.register ?? false,
    callerIdE164: initialData?.callerIdE164 ?? "",
    active: initialData?.active ?? true,
    sendPai: initialData?.sendPai ?? false,
    isEmergency: initialData?.isEmergency ?? false,
    maxConcurrent: initialData?.maxConcurrent ?? undefined,
    ipAllowlist: (initialData?.ipAllowlist ?? []).join(", "),
  });

  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function set<K extends keyof CarrierFormValues>(key: K, value: CarrierFormValues[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);

    const ipAllowlist = values.ipAllowlist
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const body: Record<string, unknown> = {
      name: values.name,
      kind: values.kind,
      proxy: values.proxy,
      register: values.register,
      active: values.active,
      sendPai: values.sendPai,
      isEmergency: values.isEmergency,
      ipAllowlist,
      ...(values.callerIdE164 && { callerIdE164: values.callerIdE164 }),
      ...(values.maxConcurrent && { maxConcurrent: values.maxConcurrent }),
    };

    if (isSuperAdmin && values.username) body.username = values.username;
    if (isSuperAdmin && values.password) body.password = values.password;

    try {
      if (mode === "create") {
        await apiFetch("/api/admin/carriers", { method: "POST", body });
      } else if (initialData) {
        await apiFetch(`/api/admin/carriers/${initialData.id}`, { method: "PATCH", body });
      }
      window.location.href = "/admin/carriers";
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6" noValidate>
      {error && (
        <div role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Basic info */}
      <fieldset className="space-y-4">
        <legend className="text-sm font-semibold text-[var(--color-fg)]">Basic information</legend>

        <div>
          <label htmlFor="carrier-name" className="block text-sm font-medium text-[var(--color-fg)] mb-1">
            Name <span aria-hidden>*</span>
          </label>
          <Input
            id="carrier-name"
            value={values.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="e.g. Twilio Production"
            required
            maxLength={64}
          />
        </div>

        <div>
          <label htmlFor="carrier-kind" className="block text-sm font-medium text-[var(--color-fg)] mb-1">
            Kind <span aria-hidden>*</span>
          </label>
          <select
            id="carrier-kind"
            value={values.kind}
            onChange={(e) => set("kind", e.target.value)}
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-brand-500)]"
          >
            {CARRIER_KINDS.map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="carrier-proxy" className="block text-sm font-medium text-[var(--color-fg)] mb-1">
            Proxy / SIP host <span aria-hidden>*</span>
          </label>
          <Input
            id="carrier-proxy"
            value={values.proxy}
            onChange={(e) => set("proxy", e.target.value)}
            placeholder="e.g. acme.pstn.twilio.com"
            required
            maxLength={255}
          />
        </div>

        <div>
          <label htmlFor="carrier-cid" className="block text-sm font-medium text-[var(--color-fg)] mb-1">
            Default caller ID (E.164)
          </label>
          <Input
            id="carrier-cid"
            value={values.callerIdE164 ?? ""}
            onChange={(e) => set("callerIdE164", e.target.value)}
            placeholder="+12065551234"
            maxLength={16}
          />
        </div>

        <div>
          <label htmlFor="carrier-maxcon" className="block text-sm font-medium text-[var(--color-fg)] mb-1">
            Max concurrent calls
          </label>
          <Input
            id="carrier-maxcon"
            type="number"
            value={values.maxConcurrent ?? ""}
            onChange={(e) => set("maxConcurrent", e.target.value ? Number(e.target.value) : undefined)}
            placeholder="Unlimited"
            min={1}
            max={100000}
          />
        </div>

        <div>
          <label htmlFor="carrier-ip-allowlist" className="block text-sm font-medium text-[var(--color-fg)] mb-1">
            IP allowlist (comma-separated CIDRs)
          </label>
          <Input
            id="carrier-ip-allowlist"
            value={values.ipAllowlist}
            onChange={(e) => set("ipAllowlist", e.target.value)}
            placeholder="54.172.60.0/30, 54.244.51.0/30"
          />
        </div>
      </fieldset>

      {/* Credentials (super_admin only) */}
      {isSuperAdmin && (
        <fieldset className="space-y-4 rounded-md border border-[var(--color-border)] p-4">
          <legend className="px-2 text-sm font-semibold text-[var(--color-fg)]">
            Credentials
            {mode === "edit" && initialData?.credentialStatus === "set" && (
              <span className="ml-2 text-xs text-green-600">(currently set — leave blank to keep)</span>
            )}
          </legend>

          <div>
            <label htmlFor="carrier-username" className="block text-sm font-medium text-[var(--color-fg)] mb-1">
              Username / SIP account
            </label>
            <Input
              id="carrier-username"
              type="text"
              autoComplete="off"
              value={values.username ?? ""}
              onChange={(e) => set("username", e.target.value)}
              placeholder={mode === "edit" && initialData?.credentialStatus === "set" ? "Leave blank to keep" : ""}
            />
          </div>

          <div>
            <label htmlFor="carrier-password" className="block text-sm font-medium text-[var(--color-fg)] mb-1">
              Password / SIP secret
            </label>
            <Input
              id="carrier-password"
              type="password"
              autoComplete="new-password"
              value={values.password ?? ""}
              onChange={(e) => set("password", e.target.value)}
              placeholder={mode === "edit" && initialData?.credentialStatus === "set" ? "Leave blank to keep" : ""}
            />
          </div>
        </fieldset>
      )}

      {/* Flags */}
      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold text-[var(--color-fg)]">Options</legend>

        {[
          { id: "carrier-register", key: "register" as const, label: "Register (digest auth outbound)" },
          { id: "carrier-send-pai", key: "sendPai" as const, label: "Send P-Asserted-Identity header" },
          { id: "carrier-emergency", key: "isEmergency" as const, label: "E911 emergency carrier" },
          { id: "carrier-active", key: "active" as const, label: "Active" },
        ].map(({ id, key, label }) => (
          <label key={id} htmlFor={id} className="flex items-center gap-3 cursor-pointer">
            <input
              id={id}
              type="checkbox"
              checked={values[key]}
              onChange={(e) => set(key, e.target.checked)}
              className="h-4 w-4 rounded border-[var(--color-border)]"
            />
            <span className="text-sm text-[var(--color-fg)]">{label}</span>
          </label>
        ))}
      </fieldset>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={saving}>
          {saving ? "Saving…" : mode === "create" ? "Create carrier" : "Save changes"}
        </Button>
        <a href="/admin/carriers">
          <Button type="button" variant="ghost">Cancel</Button>
        </a>
      </div>
    </form>
  );
}
