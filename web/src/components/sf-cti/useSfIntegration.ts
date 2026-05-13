'use client';

// N03 — React Query hooks for SF integration admin API.

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

const QK = 'sf-integration';

export interface SfIntegrationConfig {
  id: string;
  tenantId: string;
  enabled: boolean;
  instanceUrl: string | null;
  clientId: string | null;
  hasSecret: boolean;
  hasTokens: boolean;
  tokenExpiry: string | null;
  fieldMappings: Record<string, unknown>;
  lastWritebackAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

async function fetchConfig(): Promise<SfIntegrationConfig> {
  const res = await fetch('/api/admin/sf-integration', { credentials: 'include' });
  if (!res.ok) throw new Error(`Failed to load SF config: ${res.status}`);
  return res.json() as Promise<SfIntegrationConfig>;
}

export function useSfIntegrationConfig() {
  return useQuery<SfIntegrationConfig>({
    queryKey: [QK],
    queryFn: fetchConfig,
    staleTime: 30_000,
  });
}

export function usePatchSfIntegration() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: { enabled?: boolean; fieldMappings?: Record<string, unknown> }) => {
      const res = await fetch('/api/admin/sf-integration', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error(`Patch failed: ${res.status}`);
      return res.json();
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: [QK] }),
  });
}

export function useConnectSf() {
  return useMutation({
    mutationFn: async (data: {
      instanceUrl: string;
      clientId: string;
      clientSecret: string;
    }): Promise<{ authUrl: string }> => {
      const res = await fetch('/api/admin/sf-integration/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error(`Connect failed: ${res.status}`);
      return res.json() as Promise<{ authUrl: string }>;
    },
  });
}

export function useDisconnectSf() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/admin/sf-integration/disconnect', {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`Disconnect failed: ${res.status}`);
      return res.json();
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: [QK] }),
  });
}
