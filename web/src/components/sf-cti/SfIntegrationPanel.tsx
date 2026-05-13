'use client';

// N03 — Main SF integration admin panel.
// Lives at /admin/settings/sf-integration

import { useState } from 'react';
import { useSfIntegrationConfig, useDisconnectSf, usePatchSfIntegration } from './useSfIntegration.js';
import { SfOAuthConnect } from './SfOAuthConnect.js';
import { SfFieldMappings } from './SfFieldMappings.js';
import { SfInstallGuide } from './SfInstallGuide.js';

type Tab = 'status' | 'mappings' | 'install';

export function SfIntegrationPanel(): React.ReactElement {
  const [tab, setTab] = useState<Tab>('status');
  const { data: config, isLoading, error } = useSfIntegrationConfig();
  const disconnect = useDisconnectSf();
  const patch = usePatchSfIntegration();

  if (isLoading) {
    return <div className="text-slate-400 text-sm p-4">Loading...</div>;
  }
  if (error) {
    return <div className="text-red-400 text-sm p-4">Failed to load SF integration config.</div>;
  }

  const isConnected = config?.hasTokens ?? false;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-white">Salesforce Open CTI</h2>
          <p className="text-sm text-slate-400 mt-0.5">
            Connect Salesforce to enable click-to-dial and screen pops.
          </p>
        </div>
        {isConnected && (
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1.5 text-sm text-emerald-400">
              <span className="w-2 h-2 rounded-full bg-emerald-400 inline-block" />
              Connected
            </span>
            {config?.enabled ? (
              <button
                onClick={() => void patch.mutateAsync({ enabled: false })}
                disabled={patch.isPending}
                className="px-3 py-1 text-xs bg-gray-700 hover:bg-gray-600 text-white rounded transition-colors"
              >
                Disable
              </button>
            ) : (
              <button
                onClick={() => void patch.mutateAsync({ enabled: true })}
                disabled={patch.isPending}
                className="px-3 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors"
              >
                Enable
              </button>
            )}
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-700 flex gap-4">
        {(['status', 'mappings', 'install'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`pb-2 text-sm font-medium capitalize border-b-2 transition-colors ${
              tab === t
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-slate-400 hover:text-slate-300'
            }`}
          >
            {t === 'install' ? 'Installation' : t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="pt-2">
        {tab === 'status' && (
          <div className="space-y-4">
            {isConnected ? (
              <ConnectedStatus config={config!} onDisconnect={() => void disconnect.mutateAsync()} disconnecting={disconnect.isPending} />
            ) : (
              <SfOAuthConnect />
            )}
          </div>
        )}
        {tab === 'mappings' && (
          <SfFieldMappings initialMappings={config?.fieldMappings as Record<string, string> | undefined} />
        )}
        {tab === 'install' && (
          <SfInstallGuide tenantSlug={typeof window !== 'undefined' ? (sessionStorage.getItem('sf:tenantSlug') ?? undefined) : undefined} />
        )}
      </div>
    </div>
  );
}

interface ConnectedStatusProps {
  config: {
    instanceUrl: string | null;
    tokenExpiry: string | null;
    lastWritebackAt: string | null;
    lastError: string | null;
  };
  onDisconnect: () => void;
  disconnecting: boolean;
}

function ConnectedStatus({ config, onDisconnect, disconnecting }: ConnectedStatusProps): React.ReactElement {
  return (
    <div className="space-y-3">
      <div className="bg-gray-800 border border-gray-700 rounded p-4 space-y-2">
        {config.instanceUrl && (
          <div className="flex justify-between text-sm">
            <span className="text-slate-400">Instance URL</span>
            <span className="text-slate-200 font-mono">{config.instanceUrl}</span>
          </div>
        )}
        {config.tokenExpiry && (
          <div className="flex justify-between text-sm">
            <span className="text-slate-400">Token Expiry</span>
            <span className="text-slate-200">
              {new Date(config.tokenExpiry).toLocaleString()}
            </span>
          </div>
        )}
        {config.lastWritebackAt && (
          <div className="flex justify-between text-sm">
            <span className="text-slate-400">Last Write-back</span>
            <span className="text-slate-200">
              {new Date(config.lastWritebackAt).toLocaleString()}
            </span>
          </div>
        )}
        {config.lastError && (
          <div className="mt-2 p-2 bg-red-950 border border-red-800 rounded text-xs text-red-300">
            {config.lastError}
          </div>
        )}
      </div>

      <button
        onClick={onDisconnect}
        disabled={disconnecting}
        className="px-4 py-2 bg-red-900 hover:bg-red-800 disabled:opacity-50 text-white text-sm font-medium rounded transition-colors"
      >
        {disconnecting ? 'Disconnecting...' : 'Disconnect from Salesforce'}
      </button>
    </div>
  );
}
