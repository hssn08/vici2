// JWT claim types — used by API signer/verifier and downstream consumers.

import type { Permission, Role } from './rbac.js';

export type Audience = 'api' | 'ws';

export interface AccessTokenClaims {
  iss: string;
  aud: Audience;
  sub: string;
  uid: number;
  tenant_id: number;
  role: Role;
  perms?: Permission[];
  iat: number;
  exp: number;
  jti: string;
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
