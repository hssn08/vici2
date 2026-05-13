"use client";
// N04 — HubSpot Integration settings page
// URL: /admin/integrations/hubspot

import { useState, useEffect, useCallback } from "react";
import { ConnectionCard } from "./components/ConnectionCard";
import { SyncConfigCard } from "./components/SyncConfigCard";
import { SyncHistoryCard } from "./components/SyncHistoryCard";
import { ListImportCard } from "./components/ListImportCard";
import { StatusMappingCard } from "./components/StatusMappingCard";

const API_BASE = "/api/admin/integrations/hubspot";

export interface IntegrationStatus {
  connected: boolean;
  status: "connected" | "error" | "disconnected";
  portalId?: string;
  hubDomain?: string;
  syncMode?: "ALL_CONTACTS" | "LIST_ONLY";
  syncIntervalMinutes?: number;
  lastSyncAt?: string;
  lastSyncCursor?: string;
  includeRecordingUrl?: boolean;
  syncOverwritesManual?: boolean;
  tokenExpiresAt?: string;
  rateLimitBackoffUntil?: string;
  recentJobs?: SyncJob[];
}

export interface SyncJob {
  id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  syncMode: string;
  contactsFetched: number;
  contactsUpserted: number;
  contactsFailed: number;
  startedAt: string;
  completedAt?: string;
}

export default function HubSpotIntegrationPage(): React.ReactElement {
  const [integration, setIntegration] = useState<IntegrationStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch(API_BASE);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as IntegrationStatus;
      setIntegration(data);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  // Check URL params for OAuth result
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const status = params.get("status");
    const reason = params.get("reason");
    if (status === "connected") {
      void fetchStatus();
    } else if (status === "error" && reason) {
      setError(`Connection failed: ${reason}`);
    }
  }, [fetchStatus]);

  const handleDisconnect = async () => {
    if (!confirm("Disconnect HubSpot integration? Sync jobs will be cancelled.")) return;
    const res = await fetch(API_BASE, { method: "DELETE" });
    if (res.ok) {
      await fetchStatus();
    }
  };

  const handleSaveSettings = async (settings: Partial<IntegrationStatus>) => {
    const res = await fetch(API_BASE, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });
    if (res.ok) {
      const updated = await res.json() as IntegrationStatus;
      setIntegration(updated);
    }
  };

  const handleTriggerSync = async (mode: "FULL" | "INCREMENTAL") => {
    if (mode === "FULL" && !confirm("Run a full contact resync? This may take several minutes.")) return;
    await fetch(`${API_BASE}/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    setTimeout(() => void fetchStatus(), 2000);
  };

  return (
    <main className="space-y-6">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-[var(--color-fg)]">HubSpot Integration</h1>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          Connect your HubSpot portal to sync contacts, enable click-to-dial, and write call outcomes back as engagements.
        </p>
      </div>

      {error && (
        <div className="rounded-md bg-red-50 border border-red-200 p-4 text-sm text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-40 rounded-lg bg-[var(--color-surface-2)] animate-pulse" />
          ))}
        </div>
      ) : (
        <>
          <ConnectionCard
            integration={integration}
            onDisconnect={handleDisconnect}
          />

          {integration?.connected && (
            <>
              <SyncConfigCard
                integration={integration}
                onSave={handleSaveSettings}
              />

              <StatusMappingCard
                dispositionMap={(integration as IntegrationStatus & { dispositionMap?: Record<string, string> }).dispositionMap ?? {}}
                onSave={(map) => handleSaveSettings({ dispositionMap: map } as Partial<IntegrationStatus>)}
              />

              {integration.syncMode === "LIST_ONLY" && (
                <ListImportCard apiBase={API_BASE} />
              )}

              <SyncHistoryCard
                jobs={integration.recentJobs ?? []}
                onSyncNow={() => handleTriggerSync("INCREMENTAL")}
                onFullResync={() => handleTriggerSync("FULL")}
                onRefresh={fetchStatus}
              />
            </>
          )}
        </>
      )}
    </main>
  );
}
