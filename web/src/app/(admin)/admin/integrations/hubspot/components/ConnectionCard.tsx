"use client";
// N04 — Connection status card for HubSpot integration

import type { IntegrationStatus } from "../page";

interface Props {
  integration: IntegrationStatus | null;
  onDisconnect: () => void;
}

export function ConnectionCard({ integration, onDisconnect }: Props): React.ReactElement {
  const isConnected = integration?.connected ?? false;
  const isError = integration?.status === "error";

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
      <h2 className="text-base font-semibold text-[var(--color-fg)] mb-4">Connection Status</h2>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {isConnected && !isError && (
            <>
              <span className="inline-flex h-2.5 w-2.5 rounded-full bg-green-500" />
              <div>
                <p className="text-sm font-medium text-[var(--color-fg)]">
                  Connected to {integration?.hubDomain ?? "HubSpot"}
                </p>
                <p className="text-xs text-[var(--color-fg-muted)]">
                  Portal ID: {integration?.portalId}
                </p>
              </div>
            </>
          )}
          {isError && (
            <>
              <span className="inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
              <div>
                <p className="text-sm font-medium text-red-600">Connection Error</p>
                <p className="text-xs text-[var(--color-fg-muted)]">
                  Token may have expired or been revoked
                </p>
              </div>
            </>
          )}
          {!isConnected && !isError && (
            <>
              <span className="inline-flex h-2.5 w-2.5 rounded-full bg-gray-400" />
              <p className="text-sm text-[var(--color-fg-muted)]">Not connected</p>
            </>
          )}
        </div>

        <div className="flex items-center gap-3">
          {(!isConnected || isError) && (
            <a
              href="/api/admin/integrations/hubspot/oauth/start"
              className="inline-flex items-center justify-center rounded-md bg-[#FF7A59] px-4 py-2 text-sm font-medium text-white hover:bg-[#e8693f] transition-colors"
            >
              {isError ? "Reconnect HubSpot" : "Connect HubSpot"}
            </a>
          )}
          {isConnected && !isError && (
            <button
              onClick={onDisconnect}
              className="inline-flex items-center justify-center rounded-md border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 transition-colors"
            >
              Disconnect
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
