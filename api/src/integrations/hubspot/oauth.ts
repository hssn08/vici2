// N04 — HubSpot OAuth 2.0 helpers: token exchange, refresh, token-info fetch.

import { env } from '../../lib/env.js';

const TOKEN_ENDPOINT = 'https://api.hubapi.com/oauth/v1/token';
const TOKEN_INFO_ENDPOINT = 'https://api.hubapi.com/oauth/v1/access-tokens';

export interface HubspotTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;   // seconds
  token_type: string;
}

export interface HubspotTokenInfo {
  hub_id: number;
  hub_domain: string;
  user_id: number;
  user: string;
  scopes: string[];
}

/**
 * Exchange an authorization code for tokens.
 */
export async function exchangeCode(code: string): Promise<HubspotTokenResponse> {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: env.hubspotClientId,
    client_secret: env.hubspotClientSecret,
    redirect_uri: env.hubspotRedirectUri,
    code,
  });

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HubSpot token exchange failed (${res.status}): ${text}`);
  }

  return res.json() as Promise<HubspotTokenResponse>;
}

/**
 * Refresh an existing access token using the refresh token.
 */
export async function refreshAccessToken(refreshToken: string): Promise<HubspotTokenResponse> {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: env.hubspotClientId,
    client_secret: env.hubspotClientSecret,
    redirect_uri: env.hubspotRedirectUri,
    refresh_token: refreshToken,
  });

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HubSpot token refresh failed (${res.status}): ${text}`);
  }

  return res.json() as Promise<HubspotTokenResponse>;
}

/**
 * Fetch portal info (hub_id, hub_domain) from the access token metadata endpoint.
 */
export async function fetchTokenInfo(accessToken: string): Promise<HubspotTokenInfo> {
  const res = await fetch(`${TOKEN_INFO_ENDPOINT}/${accessToken}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HubSpot token info fetch failed (${res.status}): ${text}`);
  }

  return res.json() as Promise<HubspotTokenInfo>;
}

/**
 * Build the HubSpot OAuth authorization URL.
 */
export function buildAuthUrl(state: string): string {
  const scopes = [
    'crm.objects.contacts.read',
    'crm.lists.read',
    'timeline',
    'oauth',
    'calling',
  ].join(' ');

  const optionalScopes = [
    'crm.objects.companies.read',
    'crm.objects.deals.read',
    'crm.objects.owners.read',
  ].join(' ');

  const params = new URLSearchParams({
    client_id: env.hubspotClientId,
    redirect_uri: env.hubspotRedirectUri,
    scope: scopes,
    optional_scope: optionalScopes,
    state,
  });

  return `https://app.hubspot.com/oauth/authorize?${params.toString()}`;
}
