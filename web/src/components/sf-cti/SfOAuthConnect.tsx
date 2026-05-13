'use client';

// N03 — SF OAuth connection form component.

import { useState } from 'react';
import { useConnectSf } from './useSfIntegration.js';

export function SfOAuthConnect(): React.ReactElement {
  const [instanceUrl, setInstanceUrl] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const connect = useConnectSf();

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    try {
      const { authUrl } = await connect.mutateAsync({ instanceUrl, clientId, clientSecret });
      window.location.href = authUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed');
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-slate-300 mb-1">
          Salesforce Instance URL
        </label>
        <input
          type="url"
          placeholder="https://myorg.salesforce.com"
          value={instanceUrl}
          onChange={(e) => setInstanceUrl(e.target.value)}
          required
          className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-slate-300 mb-1">
          Connected App Consumer Key
        </label>
        <input
          type="text"
          placeholder="Client ID"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          required
          className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-slate-300 mb-1">
          Connected App Consumer Secret
        </label>
        <input
          type="password"
          placeholder="Client Secret"
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          required
          className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>
      {error && (
        <div className="text-red-400 text-sm">{error}</div>
      )}
      <button
        type="submit"
        disabled={connect.isPending}
        className="w-full px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium rounded transition-colors"
      >
        {connect.isPending ? 'Redirecting...' : 'Connect to Salesforce'}
      </button>
    </form>
  );
}
