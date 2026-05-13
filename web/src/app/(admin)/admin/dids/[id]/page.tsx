"use client";

// M06 — DID edit page.
// URL: /admin/dids/[id]

import * as React from "react";
import { apiFetch, ApiError } from "@/lib/api";
import { DidForm } from "@/components/admin/DidForm";
import { useParams } from "next/navigation";

interface DidData {
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

export default function DidDetailPage(): React.ReactElement {
  const params = useParams<{ id: string }>();
  const didId = params.id;

  const [did, setDid] = React.useState<DidData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const data = await apiFetch<DidData>(`/api/admin/dids/${didId}`);
        setDid(data);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Failed to load DID");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [didId]);

  if (loading) {
    return (
      <main>
        <div className="h-8 w-48 animate-pulse rounded bg-[var(--color-surface-muted)] mb-4" />
        <div className="h-64 animate-pulse rounded bg-[var(--color-surface-muted)]" />
      </main>
    );
  }

  if (error || !did) {
    return (
      <main>
        <div role="alert" className="rounded-md bg-red-50 p-4 text-sm text-red-700">
          {error ?? "DID not found"}
        </div>
        <a href="/admin/dids" className="mt-4 inline-block text-sm text-[var(--color-brand-600)] hover:underline">
          Back to DIDs
        </a>
      </main>
    );
  }

  return (
    <main>
      <div className="mb-6">
        <nav aria-label="Breadcrumb">
          <ol className="flex items-center gap-2 text-sm text-[var(--color-fg-muted)]">
            <li><a href="/admin/dids" className="hover:underline">DIDs</a></li>
            <li aria-hidden>›</li>
            <li aria-current="page" className="text-[var(--color-fg)]">{did.e164}</li>
          </ol>
        </nav>
        <h1 className="mt-2 text-2xl font-semibold text-[var(--color-fg)] font-mono">{did.e164}</h1>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          {did.routeKind} → {did.routeTarget}
        </p>
      </div>

      <div className="max-w-2xl">
        <DidForm mode="edit" initialData={did} />
      </div>
    </main>
  );
}
