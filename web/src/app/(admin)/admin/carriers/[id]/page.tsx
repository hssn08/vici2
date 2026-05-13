"use client";

// M06 — Carrier detail page with tabs: Info / Gateways / DIDs.
// URL: /admin/carriers/[id]

import * as React from "react";
import { apiFetch, ApiError } from "@/lib/api";
import { CarrierForm } from "@/components/admin/CarrierForm";
import { GatewayTable } from "@/components/admin/GatewayTable";
import { GatewayForm } from "@/components/admin/GatewayForm";
import { DidTable } from "@/components/admin/DidTable";
import { Button } from "@/components/ui/button";
import { useParams } from "next/navigation";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

type Tab = "info" | "gateways" | "dids";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function CarrierDetailPage(): React.ReactElement {
  const params = useParams<{ id: string }>();
  const carrierId = params.id;

  const [carrier, setCarrier] = React.useState<CarrierData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [tab, setTab] = React.useState<Tab>("info");
  const [showGatewayForm, setShowGatewayForm] = React.useState(false);

  React.useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const data = await apiFetch<CarrierData>(`/api/admin/carriers/${carrierId}`);
        setCarrier(data);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Failed to load carrier");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [carrierId]);

  if (loading) {
    return (
      <main>
        <div className="h-8 w-64 animate-pulse rounded bg-[var(--color-surface-muted)] mb-4" />
        <div className="h-64 animate-pulse rounded bg-[var(--color-surface-muted)]" />
      </main>
    );
  }

  if (error || !carrier) {
    return (
      <main>
        <div role="alert" className="rounded-md bg-red-50 p-4 text-sm text-red-700">
          {error ?? "Carrier not found"}
        </div>
        <a href="/admin/carriers" className="mt-4 inline-block text-sm text-[var(--color-brand-600)] hover:underline">
          Back to carriers
        </a>
      </main>
    );
  }

  const TABS: { key: Tab; label: string }[] = [
    { key: "info", label: "Info" },
    { key: "gateways", label: "Gateways" },
    { key: "dids", label: "DIDs" },
  ];

  return (
    <main>
      <div className="mb-6">
        <nav aria-label="Breadcrumb">
          <ol className="flex items-center gap-2 text-sm text-[var(--color-fg-muted)]">
            <li><a href="/admin/carriers" className="hover:underline">Carriers</a></li>
            <li aria-hidden>›</li>
            <li aria-current="page" className="text-[var(--color-fg)]">{carrier.name}</li>
          </ol>
        </nav>
        <h1 className="mt-2 text-2xl font-semibold text-[var(--color-fg)]">{carrier.name}</h1>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          {carrier.kind} · {carrier.proxy}
          {carrier.isEmergency && <span className="ml-2 text-red-600 font-semibold">E911</span>}
        </p>
      </div>

      {/* Tabs */}
      <div className="mb-6 border-b border-[var(--color-border)]">
        <nav aria-label="Carrier tabs" className="flex gap-6">
          {TABS.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`py-3 text-sm font-medium border-b-2 transition-colors ${
                tab === key
                  ? "border-[var(--color-brand-600)] text-[var(--color-brand-600)]"
                  : "border-transparent text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
              }`}
              aria-current={tab === key ? "page" : undefined}
            >
              {label}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab content */}
      {tab === "info" && (
        <div className="max-w-2xl">
          <CarrierForm mode="edit" initialData={carrier} />
        </div>
      )}

      {tab === "gateways" && (
        <div>
          {showGatewayForm ? (
            <div className="max-w-2xl mb-6">
              <h2 className="text-base font-semibold text-[var(--color-fg)] mb-4">Add gateway</h2>
              <GatewayForm
                carrierId={carrierId}
                mode="create"
                onSaved={() => { setShowGatewayForm(false); }}
                onCancel={() => setShowGatewayForm(false)}
              />
            </div>
          ) : null}
          <GatewayTable
            carrierId={carrierId}
            onAddGateway={() => setShowGatewayForm(true)}
          />
        </div>
      )}

      {tab === "dids" && (
        <div>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-base font-semibold text-[var(--color-fg)]">DIDs on this carrier</h2>
            <a href={`/admin/dids/new?carrierId=${carrierId}`}>
              <Button size="sm">Add DID</Button>
            </a>
          </div>
          <DidTable filterCarrierId={carrierId} />
        </div>
      )}
    </main>
  );
}
