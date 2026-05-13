// N03 — SF OAuth token encryption/decryption via F05 AES-256-GCM envelope.
//
// Reuses the F05 encryption.ts pattern (table/column/rowId/tenantId AAD).
// Table: sf_integrations, columns: client_secret, access_token, refresh_token

import { encrypt, decrypt } from '../../../auth/encryption.js';
import { getPrisma } from '../../../lib/prisma.js';

const SF_TABLE = 'sf_integrations';

export function encryptSfToken(params: {
  column: string;
  rowId: bigint;
  tenantId: bigint;
  plaintext: string;
}): Uint8Array {
  const result = encrypt({
    table: SF_TABLE,
    column: params.column,
    rowId: params.rowId,
    tenantId: params.tenantId,
    plaintext: params.plaintext,
  });
  return result.ciphertextBlob;
}

export function decryptSfToken(params: {
  column: string;
  rowId: bigint;
  tenantId: bigint;
  ciphertextBlob: Uint8Array;
}): string {
  return decrypt({
    table: SF_TABLE,
    column: params.column,
    rowId: params.rowId,
    tenantId: params.tenantId,
    ciphertextBlob: params.ciphertextBlob,
  }).toString('utf-8');
}

// ---------------------------------------------------------------------------
// HTTP client interface (stubbed for test injection)
// ---------------------------------------------------------------------------

export interface SfHttpClient {
  tokenRequest(instanceUrl: string, body: URLSearchParams): Promise<SfTokenResponse>;
  revokeToken(instanceUrl: string, token: string): Promise<void>;
}

export interface SfTokenResponse {
  access_token?: string;
  refresh_token?: string;
  instance_url?: string;
  expires_in?: number;
  token_type?: string;
  error?: string;
  error_description?: string;
}

/** Production HTTP client that calls real SF OAuth endpoints. */
export const defaultSfHttpClient: SfHttpClient = {
  async tokenRequest(instanceUrl, body) {
    const res = await fetch(`${instanceUrl}/services/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    return res.json() as Promise<SfTokenResponse>;
  },

  async revokeToken(instanceUrl, token) {
    await fetch(`${instanceUrl}/services/oauth2/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
    });
  },
};

// ---------------------------------------------------------------------------
// getAccessToken — auto-refreshes if expiry < 5 min away
// ---------------------------------------------------------------------------

export async function getAccessToken(
  tenantId: bigint,
  httpClient: SfHttpClient = defaultSfHttpClient,
): Promise<{ token: string; instanceUrl: string }> {
  const db = getPrisma();
  const row = await db.sfIntegration.findUnique({ where: { tenantId } });
  if (!row || !row.accessToken || !row.refreshToken) {
    throw new Error('SF integration not configured or not authorized');
  }

  const now = new Date();
  const expiry = row.tokenExpiry;
  const fiveMinMs = 5 * 60 * 1000;

  if (!expiry || expiry.getTime() - now.getTime() < fiveMinMs) {
    return refreshAccessToken(tenantId, row, httpClient);
  }

  const token = decryptSfToken({
    column: 'access_token',
    rowId: row.id,
    tenantId,
    ciphertextBlob: row.accessToken,
  });

  return { token, instanceUrl: row.instanceUrl! };
}

type SfIntegrationRow = {
  id: bigint;
  tenantId: bigint;
  instanceUrl: string | null;
  clientId: string | null;
  clientSecret: Uint8Array | null;
  refreshToken: Uint8Array | null;
};

async function refreshAccessToken(
  tenantId: bigint,
  row: SfIntegrationRow,
  httpClient: SfHttpClient,
): Promise<{ token: string; instanceUrl: string }> {
  const db = getPrisma();

  const refreshToken = decryptSfToken({
    column: 'refresh_token',
    rowId: row.id,
    tenantId,
    ciphertextBlob: row.refreshToken!,
  });
  const clientSecret = decryptSfToken({
    column: 'client_secret',
    rowId: row.id,
    tenantId,
    ciphertextBlob: row.clientSecret!,
  });

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: row.clientId!,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });

  const data = await httpClient.tokenRequest(row.instanceUrl!, body);
  if (!data.access_token) {
    throw new Error(`SF token refresh failed: ${data.error ?? 'unknown'}`);
  }

  const newExpiry = new Date(Date.now() + (data.expires_in ?? 7200) * 1000);
  const encryptedToken = Buffer.from(encryptSfToken({
    column: 'access_token',
    rowId: row.id,
    tenantId,
    plaintext: data.access_token,
  }));

  await db.sfIntegration.update({
    where: { tenantId },
    data: { accessToken: encryptedToken, tokenExpiry: newExpiry },
  });

  return { token: data.access_token, instanceUrl: row.instanceUrl! };
}
