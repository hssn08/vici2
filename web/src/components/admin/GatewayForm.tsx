"use client";

// M06 — Gateway create/edit form (modal or inline).

import * as React from "react";
import { apiFetch, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GatewayFormValues {
  name: string;
  proxy: string;
  realm: string;
  fromUser: string;
  fromDomain: string;
  extension: string;
  register: boolean;
  expireSeconds: number;
  retrySeconds: number;
  transport: "udp" | "tcp" | "tls";
  priority: number;
  weight: number;
  active: boolean;
  maxConcurrent: string;
  costPerMinCents: string;
}

export interface GatewayData {
  id: string;
  name: string;
  proxy: string;
  realm: string | null;
  fromUser: string | null;
  fromDomain: string | null;
  extension: string | null;
  register: boolean;
  expireSeconds: number;
  retrySeconds: number;
  transport: string;
  priority: number;
  weight: number;
  active: boolean;
  maxConcurrent: number | null;
  costPerMinCents: number | null;
}

interface GatewayFormProps {
  carrierId: string;
  mode: "create" | "edit";
  initialData?: GatewayData;
  onSaved?: () => void;
  onCancel?: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function GatewayForm({ carrierId, mode, initialData, onSaved, onCancel }: GatewayFormProps): React.ReactElement {
  const [values, setValues] = React.useState<GatewayFormValues>({
    name: initialData?.name ?? "",
    proxy: initialData?.proxy ?? "",
    realm: initialData?.realm ?? "",
    fromUser: initialData?.fromUser ?? "",
    fromDomain: initialData?.fromDomain ?? "",
    extension: initialData?.extension ?? "",
    register: initialData?.register ?? false,
    expireSeconds: initialData?.expireSeconds ?? 3600,
    retrySeconds: initialData?.retrySeconds ?? 30,
    transport: (initialData?.transport as "udp" | "tcp" | "tls") ?? "udp",
    priority: initialData?.priority ?? 100,
    weight: initialData?.weight ?? 100,
    active: initialData?.active ?? true,
    maxConcurrent: initialData?.maxConcurrent != null ? String(initialData.maxConcurrent) : "",
    costPerMinCents: initialData?.costPerMinCents != null ? String(initialData.costPerMinCents) : "",
  });

  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function set<K extends keyof GatewayFormValues>(key: K, value: GatewayFormValues[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);

    const body: Record<string, unknown> = {
      name: values.name,
      proxy: values.proxy,
      ...(values.realm && { realm: values.realm }),
      ...(values.fromUser && { fromUser: values.fromUser }),
      ...(values.fromDomain && { fromDomain: values.fromDomain }),
      ...(values.extension && { extension: values.extension }),
      register: values.register,
      expireSeconds: values.expireSeconds,
      retrySeconds: values.retrySeconds,
      transport: values.transport,
      priority: values.priority,
      weight: values.weight,
      active: values.active,
      ...(values.maxConcurrent && { maxConcurrent: Number(values.maxConcurrent) }),
      ...(values.costPerMinCents && { costPerMinCents: Number(values.costPerMinCents) }),
    };

    try {
      if (mode === "create") {
        await apiFetch(`/api/admin/carriers/${carrierId}/gateways`, { method: "POST", body });
      } else if (initialData) {
        await apiFetch(`/api/admin/carriers/${carrierId}/gateways/${initialData.id}`, { method: "PATCH", body });
      }
      onSaved?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      {error && (
        <div role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>
      )}

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="gw-name" className="block text-sm font-medium mb-1">Name *</label>
          <Input id="gw-name" value={values.name} onChange={(e) => set("name", e.target.value)} required maxLength={64} placeholder="gw-twilio-us-east" />
        </div>
        <div>
          <label htmlFor="gw-proxy" className="block text-sm font-medium mb-1">Proxy / host *</label>
          <Input id="gw-proxy" value={values.proxy} onChange={(e) => set("proxy", e.target.value)} required maxLength={255} placeholder="sip.example.com" />
        </div>
        <div>
          <label htmlFor="gw-transport" className="block text-sm font-medium mb-1">Transport</label>
          <select
            id="gw-transport"
            value={values.transport}
            onChange={(e) => set("transport", e.target.value as "udp" | "tcp" | "tls")}
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-brand-500)]"
          >
            <option value="udp">UDP</option>
            <option value="tcp">TCP</option>
            <option value="tls">TLS</option>
          </select>
        </div>
        <div>
          <label htmlFor="gw-realm" className="block text-sm font-medium mb-1">Realm</label>
          <Input id="gw-realm" value={values.realm} onChange={(e) => set("realm", e.target.value)} maxLength={255} />
        </div>
        <div>
          <label htmlFor="gw-priority" className="block text-sm font-medium mb-1">Priority</label>
          <Input id="gw-priority" type="number" value={values.priority} onChange={(e) => set("priority", Number(e.target.value))} min={1} max={9999} />
        </div>
        <div>
          <label htmlFor="gw-weight" className="block text-sm font-medium mb-1">Weight</label>
          <Input id="gw-weight" type="number" value={values.weight} onChange={(e) => set("weight", Number(e.target.value))} min={1} max={10000} />
        </div>
        <div>
          <label htmlFor="gw-expire" className="block text-sm font-medium mb-1">Expire seconds</label>
          <Input id="gw-expire" type="number" value={values.expireSeconds} onChange={(e) => set("expireSeconds", Number(e.target.value))} min={60} max={86400} />
        </div>
        <div>
          <label htmlFor="gw-retry" className="block text-sm font-medium mb-1">Retry seconds</label>
          <Input id="gw-retry" type="number" value={values.retrySeconds} onChange={(e) => set("retrySeconds", Number(e.target.value))} min={10} max={3600} />
        </div>
        <div>
          <label htmlFor="gw-maxcon" className="block text-sm font-medium mb-1">Max concurrent</label>
          <Input id="gw-maxcon" type="number" value={values.maxConcurrent} onChange={(e) => set("maxConcurrent", e.target.value)} placeholder="Unlimited" min={1} />
        </div>
        <div>
          <label htmlFor="gw-cost" className="block text-sm font-medium mb-1">Cost (cents/min)</label>
          <Input id="gw-cost" type="number" value={values.costPerMinCents} onChange={(e) => set("costPerMinCents", e.target.value)} placeholder="0" min={0} />
        </div>
      </div>

      <div className="flex gap-6">
        {[
          { id: "gw-register", key: "register" as const, label: "Register" },
          { id: "gw-active", key: "active" as const, label: "Active" },
        ].map(({ id, key, label }) => (
          <label key={id} htmlFor={id} className="flex items-center gap-2 cursor-pointer text-sm">
            <input id={id} type="checkbox" checked={values[key]} onChange={(e) => set(key, e.target.checked)} className="h-4 w-4 rounded border-[var(--color-border)]" />
            {label}
          </label>
        ))}
      </div>

      <div className="flex gap-3">
        <Button type="submit" disabled={saving}>
          {saving ? "Saving…" : mode === "create" ? "Add gateway" : "Save changes"}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
