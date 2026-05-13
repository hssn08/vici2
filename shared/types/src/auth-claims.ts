// JWT claim types — used by API signer/verifier and downstream consumers.
// M02 extends the access token with ug, cmps_kind, cmps claims (§6).

import type { Permission, Role } from './rbac.js';

export type Audience = 'api' | 'ws';

/** cmps_kind claim values (M02 PLAN §6) */
export type CampaignsKind = 'all' | 'list' | 'ref';

export interface AccessTokenClaims {
  iss: string;
  aud: Audience;
  sub: string;
  uid: number;
  tenant_id: number;
  role: Role;
  perms?: Permission[];
  // M02 additions — JWT claim shape extension (§6)
  /** user_group_id; null if the user has no group */
  ug?: number | null;
  /** How to interpret campaign scope: 'all'=unrestricted, 'list'=cmps[], 'ref'=read from Valkey */
  cmps_kind?: CampaignsKind;
  /** Campaign IDs (present when cmps_kind='list', max 50 entries) */
  cmps?: number[];
  // Standard claims
  iat: number;
  exp: number;
  jti: string;
  kid?: string;
  totp_verified: boolean;
}

export interface RefreshRecord {
  user_id: string;
  tenant_id: string;
  family_id: string;
  parent_token_hash: string;
  issued_at: string;
  expires_at: string;
  role: Role;
  last_ip?: string;
  last_ua?: string;
}
