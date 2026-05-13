"use client";

// M06 — DID create/edit form.

import * as React from "react";
import { apiFetch, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DidFormValues {
  e164: string;
  carrierId: string;
  routeKind: string;
  routeTarget: string;
  callerIdName: string;
  active: boolean;
  defaultLang: string;
  ivrTimeoutSec: number;
}

export interface DidData {
  id: string;
  e164: string;
  carrierId: string;
  routeKind: string;
  routeTarget: string;
  callerIdName: string | null;
  active: boolean;
  defaultLang: string;
  ivrTimeoutSec: number;
}

interface DidFormProps {
  mode: "create" | "edit";
  initialData?: DidData;
}

const ROUTE_KINDS = ["ingroup", "ivr", "agent", "ext", "voicemail"];
const LANGS = ["en", "es", "fr", "de", "pt", "zh", "ja"];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DidForm({ mode, initialData }: DidFormProps): React.ReactElement {
  const [values, setValues] = React.useState<DidFormValues>({
    e164: initialData?.e164 ?? "",
    carrierId: initialData?.carrierId ?? "",
    routeKind: initialData?.routeKind ?? "ingroup",
    routeTarget: initialData?.routeTarget ?? "",
    callerIdName: initialData?.callerIdName ?? "",
    active: initialData?.active ?? true,
    defaultLang: initialData?.defaultLang ?? "en",
    ivrTimeoutSec: initialData?.ivrTimeoutSec ?? 300,
  });

  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function set<K extends keyof DidFormValues>(key: K, value: DidFormValues[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);

    const body: Record<string, unknown> = {
      e164: values.e164,
      carrierId: values.carrierId,
      routeKind: values.routeKind,
      routeTarget: values.routeTarget,
      active: values.active,
      defaultLang: values.defaultLang,
      ivrTimeoutSec: values.ivrTimeoutSec,
      ...(values.callerIdName && { callerIdName: values.callerIdName }),
    };

    try {
      if (mode === "create") {
        await apiFetch("/api/admin/dids", { method: "POST", body });
      } else if (initialData) {
        await apiFetch(`/api/admin/dids/${initialData.id}`, { method: "PATCH", body });
      }
      window.location.href = "/admin/dids";
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6" noValidate>
      {error && (
        <div role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>
      )}

      <div className="grid grid-cols-2 gap-4">
        <div className="col-span-2 sm:col-span-1">
          <label htmlFor="did-e164" className="block text-sm font-medium mb-1">
            E.164 number <span aria-hidden>*</span>
          </label>
          <Input
            id="did-e164"
            value={values.e164}
            onChange={(e) => set("e164", e.target.value)}
            placeholder="+12065551234"
            required
            maxLength={16}
            readOnly={mode === "edit"}
            className={mode === "edit" ? "opacity-60 cursor-not-allowed" : ""}
          />
        </div>

        <div className="col-span-2 sm:col-span-1">
          <label htmlFor="did-carrier" className="block text-sm font-medium mb-1">
            Carrier ID <span aria-hidden>*</span>
          </label>
          <Input
            id="did-carrier"
            value={values.carrierId}
            onChange={(e) => set("carrierId", e.target.value)}
            placeholder="Carrier numeric ID"
            required
          />
        </div>

        <div>
          <label htmlFor="did-route-kind" className="block text-sm font-medium mb-1">
            Route kind <span aria-hidden>*</span>
          </label>
          <select
            id="did-route-kind"
            value={values.routeKind}
            onChange={(e) => set("routeKind", e.target.value)}
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-brand-500)]"
          >
            {ROUTE_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </div>

        <div>
          <label htmlFor="did-route-target" className="block text-sm font-medium mb-1">
            Route target <span aria-hidden>*</span>
          </label>
          <Input
            id="did-route-target"
            value={values.routeTarget}
            onChange={(e) => set("routeTarget", e.target.value)}
            placeholder="ingroup_id / ivr_id / agent_id"
            required
            maxLength={64}
          />
        </div>

        <div>
          <label htmlFor="did-cid-name" className="block text-sm font-medium mb-1">Caller ID name (CNAM)</label>
          <Input id="did-cid-name" value={values.callerIdName} onChange={(e) => set("callerIdName", e.target.value)} maxLength={64} />
        </div>

        <div>
          <label htmlFor="did-lang" className="block text-sm font-medium mb-1">Default language</label>
          <select
            id="did-lang"
            value={values.defaultLang}
            onChange={(e) => set("defaultLang", e.target.value)}
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-brand-500)]"
          >
            {LANGS.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </div>

        <div>
          <label htmlFor="did-timeout" className="block text-sm font-medium mb-1">IVR timeout (sec)</label>
          <Input
            id="did-timeout"
            type="number"
            value={values.ivrTimeoutSec}
            onChange={(e) => set("ivrTimeoutSec", Number(e.target.value))}
            min={30}
            max={7200}
          />
        </div>
      </div>

      <label htmlFor="did-active" className="flex items-center gap-3 cursor-pointer">
        <input
          id="did-active"
          type="checkbox"
          checked={values.active}
          onChange={(e) => set("active", e.target.checked)}
          className="h-4 w-4 rounded border-[var(--color-border)]"
        />
        <span className="text-sm text-[var(--color-fg)]">Active</span>
      </label>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={saving}>
          {saving ? "Saving…" : mode === "create" ? "Create DID" : "Save changes"}
        </Button>
        <a href="/admin/dids">
          <Button type="button" variant="ghost">Cancel</Button>
        </a>
      </div>
    </form>
  );
}
