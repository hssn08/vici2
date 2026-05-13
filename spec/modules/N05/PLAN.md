# N05 — Branded Calling Integration — PLAN

| Field | Value |
|---|---|
| **Module** | N05 — Branded Calling (First Orion / Hiya / TNS) |
| **Author** | N05-PLAN agent (Claude Sonnet 4.6) |
| **Date** | 2026-05-13 |
| **Status** | PLAN |
| **Migration stamp** | `20260513320000_n05_branded_calling` |
| **LOC estimate** | ~1,300 lines |
| **Phase** | 4 |
| **Effort** | 5–7 days |
| **Depends on (FROZEN)** | T02 (`did_numbers` table, `carriers` table, `did:edit` RBAC), X04 (`number_pool_dids.quarantined`, `pool.QuarantineDID()` service contract), F05 (JWT middleware, `requireAuth`, `requirePermission`), F02 schema (envelope encryption via `kek_version`/VARBINARY ciphertext pattern), C03 (`AuditWriter`) |
| **Blocks** | X04-IMPLEMENT (depends on `did_numbers.brand_reputation_score` column added here; X04 quarantine-hook must reference N05's `BrandedCallingReputationHook` interface) |

Once approved, the following are **FROZEN**: Prisma model names (`BrandedCallingProvider`, `BrandedDidRegistration`), table names (`branded_calling_providers`, `branded_did_registrations`), migration stamp `20260513320000`, REST endpoint paths under `/api/admin/branded-calling`, RBAC verbs (`branded_calling:configure`, `branded_calling:register_did`), `BrandedCallingReputationHook` interface signature, and the normalized 0–100 score scale. Internal HTTP client implementation, polling intervals, and Admin UI CSS may change without RFC.

---

## 0. TL;DR — 10-bullet decision summary

1. **Three providers behind one interface.** `IBrandedCallingProvider` is the common TypeScript interface; `FirstOrionClient`, `HiyaClient`, `TnsClient` are the three concrete implementations. A `ProviderRegistry` selects the right client given a provider enum value.
2. **Schema: two new tables.** `branded_calling_providers` stores per-tenant provider credentials (encrypted at rest). `branded_did_registrations` stores per-DID-per-provider registration status and normalized reputation score.
3. **One new column on `did_numbers`.** `brand_reputation_score TINYINT UNSIGNED NULL` (normalized 0–100) added by this migration; X04 quarantine reads it.
4. **Registration worker.** BullMQ job `branded-calling:register-did` enqueued on DID assignment to a provider brand; bulk-register up to 500 DIDs per API call. Periodic full-sync (30d) job catches drift.
5. **Reputation polling worker.** BullMQ job `branded-calling:poll-reputation` runs on a cadence (daily for healthy, every 4h for at-risk). Writes normalized score to DB; triggers `BrandedCallingReputationHook` if score crosses quarantine threshold.
6. **X04 integration hook.** `x04QuarantineHook` implements `BrandedCallingReputationHook`; calls `pool.QuarantineDID()` when normalized score < 30 (configurable via env `BRAND_QUARANTINE_THRESHOLD`).
7. **Admin UI.** Single page at `(admin)/integrations/branded-calling` with three tabs (one per provider). Each tab: configure credentials + brand profile, list registered DIDs with status badge and reputation score, register/deregister individual DIDs, submit dispute for flagged numbers.
8. **RBAC: two new verbs.** `branded_calling:configure` (admin+) manages provider credentials and brand profile. `branded_calling:register_did` (admin+) registers/deregisters individual DIDs. Both verbs are marked `sensitive: true`.
9. **Audit log.** Every credential update, brand profile change, DID registration, deregistration, and dispute submission writes to `audit_log` via `AuditWriter`.
10. **No per-call enrichment in Phase 1.** Static brand-on-number only. Per-call dynamic enrichment (SIP PAI header manipulation) is Phase 2.

---

## 1. Goals and Non-Goals

### 1.1 Phase 1 Goals

- Schema: `branded_calling_providers`, `branded_did_registrations`, `did_numbers.brand_reputation_score`.
- Provider clients for First Orion, Hiya, and TNS behind `IBrandedCallingProvider`.
- `ProviderRegistry` singleton that selects the correct client.
- Brand profile CRUD (create/update/read per tenant per provider).
- DID registration: enqueue per-DID registration job; bulk up to 500 DIDs to provider API.
- DID deregistration on demand and on DID deprovision cascade.
- Reputation polling worker with configurable cadence per score tier.
- X04 quarantine integration hook.
- Dispute submission endpoint (calls provider feedback API).
- Admin REST API under `/api/admin/branded-calling`.
- Admin UI at `(admin)/integrations/branded-calling`.
- RBAC verbs `branded_calling:configure` and `branded_calling:register_did`.
- Audit log for all write operations.
- Cost metric: `branded_did_count_by_provider` gauge in workers metrics.
- Unit tests for provider clients (mocked HTTP), score normalization, and admin routes.

### 1.2 Phase 2 (Deferred)

- Per-call dynamic call-reason override (requires SIP PAI header manipulation in FreeSWITCH dial plan).
- Apple Business Connect integration (separate Apple API).
- Logo hosting on vici2-managed S3/CloudFront.
- Multi-tenant provider credential pooling (one contract, many tenants).
- Carrier STIR/SHAKEN attestation auto-detection via SIP Identity header parsing.
- Per-carrier CNAM provisioning via T02 carrier APIs.

### 1.3 Non-Goals (Phase 1)

- STIR/SHAKEN JWT generation (carrier responsibility).
- FCC Robocall Mitigation Database automated lookup.
- Branded calling analytics dashboards (Phase 3 reporting module).
- Email/SMS notifications on reputation score drops (Phase 2 N01/N02 integration).

---

## 2. Schema

### 2.1 Migration File

`api/prisma/migrations/20260513320000_n05_branded_calling/migration.sql`

### 2.2 Table: `branded_calling_providers`

Stores one row per (tenant, provider) combination with encrypted credentials and brand profile data.

```sql
CREATE TABLE branded_calling_providers (
  id               BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
  tenant_id        BIGINT UNSIGNED   NOT NULL DEFAULT 1,

  -- Provider identifier
  provider         ENUM(
    'first_orion',
    'hiya',
    'tns'
  ) NOT NULL,

  -- Encrypted API credentials (F02 envelope-encryption pattern)
  -- For First Orion: JSON {"client_id": "...", "client_secret": "..."}
  -- For Hiya:        JSON {"api_key": "..."}
  -- For TNS:         JSON {"api_key": "...", "api_secret": "..."}
  credentials_enc  VARBINARY(512)    NOT NULL,
  kek_version      SMALLINT UNSIGNED NOT NULL DEFAULT 1,

  -- Brand profile (stored as plain JSON — no PII)
  brand_name       VARCHAR(30)       NOT NULL,
  logo_url         VARCHAR(512)      NULL,
  vertical         ENUM(
    'FINANCIAL_SERVICES', 'HEALTHCARE', 'INSURANCE', 'RETAIL',
    'UTILITIES', 'TELEMARKETING', 'NON_PROFIT', 'GOVERNMENT',
    'TECHNOLOGY', 'REAL_ESTATE', 'COLLECTIONS', 'OTHER'
  ) NOT NULL DEFAULT 'OTHER',
  call_reasons     JSON              NOT NULL DEFAULT (JSON_ARRAY()),
  -- call_reasons: array of canonical call reason strings, e.g. ["ACCOUNT_SERVICES"]

  -- Provider-assigned brand ID (returned on brand registration; null until registered)
  provider_brand_id VARCHAR(128)     NULL,

  -- Approval status at provider
  brand_status     ENUM(
    'pending',       -- submitted, awaiting provider approval
    'active',        -- approved; DID registrations will display brand
    'rejected',      -- provider rejected brand application
    'suspended',     -- provider suspended brand (compliance issue)
    'inactive'       -- admin-disabled
  ) NOT NULL DEFAULT 'pending',

  -- When the brand was last successfully synced with the provider
  brand_synced_at  DATETIME(6)       NULL,

  -- Tombstone / soft-delete
  active           BOOLEAN           NOT NULL DEFAULT TRUE,

  created_at       DATETIME(6)       NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at       DATETIME(6)       NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                     ON UPDATE CURRENT_TIMESTAMP(6),

  PRIMARY KEY (id),
  UNIQUE KEY uk_bcp_tenant_provider (tenant_id, provider),
  KEY idx_bcp_tenant_active (tenant_id, active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

**Prisma model name**: `BrandedCallingProvider` → `@@map("branded_calling_providers")`

### 2.3 Table: `branded_did_registrations`

One row per (DID, provider). A DID can be registered with up to three providers simultaneously.

```sql
CREATE TABLE branded_did_registrations (
  id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  tenant_id           BIGINT UNSIGNED  NOT NULL DEFAULT 1,

  -- FK to did_numbers.id (T02)
  did_id              BIGINT UNSIGNED  NOT NULL,

  -- FK to branded_calling_providers.id
  provider_id         BIGINT UNSIGNED  NOT NULL,

  -- Provider enum denormalized for query convenience (avoids JOIN on every poll)
  provider            ENUM(
    'first_orion', 'hiya', 'tns'
  ) NOT NULL,

  -- Provider-assigned registration/number ID
  provider_number_id  VARCHAR(128)     NULL,

  -- Call reason assigned to this DID (canonical vici2 enum)
  call_reason         VARCHAR(64)      NOT NULL DEFAULT 'GENERAL_NOTIFICATION',

  -- Registration lifecycle
  status              ENUM(
    'pending',        -- registration job enqueued but not yet submitted
    'submitted',      -- submitted to provider; awaiting confirmation
    'active',         -- provider confirmed; branded display live
    'rejected',       -- provider rejected this DID (number ownership issue, spam flag, etc.)
    'deregistering',  -- deregistration job enqueued
    'deregistered',   -- successfully removed from provider
    'error'           -- transient error; registration will retry
  ) NOT NULL DEFAULT 'pending',

  -- Attestation level confirmed by provider (null if provider did not report it)
  attestation_level   ENUM('A', 'B', 'C') NULL,

  -- Normalized reputation score 0–100 (higher = better; NULL = not yet polled)
  reputation_score    TINYINT UNSIGNED NULL,
  reputation_last_polled_at DATETIME(6) NULL,

  -- Raw score from provider (stored for debugging; not used for quarantine decisions)
  raw_score           DECIMAL(6,2)     NULL,
  raw_score_at        DATETIME(6)      NULL,

  -- Open dispute with provider (if admin submitted a dispute)
  dispute_open        BOOLEAN          NOT NULL DEFAULT FALSE,
  dispute_submitted_at DATETIME(6)     NULL,
  dispute_notes       TEXT             NULL,

  registered_at       DATETIME(6)      NULL,  -- when provider confirmed registration
  deregistered_at     DATETIME(6)      NULL,

  -- Retry tracking for transient errors
  retry_count         TINYINT UNSIGNED NOT NULL DEFAULT 0,
  last_error          TEXT             NULL,

  created_at          DATETIME(6)      NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at          DATETIME(6)      NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                       ON UPDATE CURRENT_TIMESTAMP(6),

  PRIMARY KEY (id),
  UNIQUE KEY uk_bdr_did_provider (did_id, provider),
  KEY idx_bdr_tenant_provider_status (tenant_id, provider, status),
  KEY idx_bdr_tenant_score (tenant_id, reputation_score),
  KEY idx_bdr_poll_due (tenant_id, status, reputation_last_polled_at),
  CONSTRAINT fk_bdr_provider FOREIGN KEY (provider_id)
    REFERENCES branded_calling_providers (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

**Prisma model name**: `BrandedDidRegistration` → `@@map("branded_did_registrations")`

### 2.4 Column Added to `did_numbers`

```sql
ALTER TABLE did_numbers
  ADD COLUMN brand_reputation_score TINYINT UNSIGNED NULL COMMENT '0-100 normalized score; NULL=unregistered or unpolled',
  ADD KEY idx_dn_brand_score (tenant_id, brand_reputation_score);
```

This column is the read target for X04's quarantine engine. N05's reputation poller updates it after every poll cycle using the worst (lowest) normalized score across all providers for that DID.

---

## 3. RBAC

### 3.1 New Verbs

Add to `shared/types/src/rbac.ts`:

```typescript
// branded calling (N05)
'branded_calling:configure',   // manage provider credentials + brand profile
'branded_calling:register_did', // register/deregister individual DIDs + submit disputes
```

Both verbs added to `SENSITIVE_VERBS` because `branded_calling:configure` exposes encrypted API credentials (decryption on read for admin) and `branded_calling:register_did` can affect outbound call reputation.

### 3.2 Role Matrix

| Role | `branded_calling:configure` | `branded_calling:register_did` |
|---|---|---|
| `super_admin` | `{ scope: 'tenant', sensitive: true }` | `{ scope: 'tenant', sensitive: true }` |
| `admin` | `{ scope: 'tenant', sensitive: true }` | `{ scope: 'tenant', sensitive: true }` |
| `supervisor` | — | — |
| `agent` | — | — |
| `viewer` | — | — |
| `integrator` | — | — |

Only super_admin and admin can configure providers or register DIDs. No read-only view verb is needed in Phase 1 (status is visible via `did:read` on the DID detail page); Phase 2 may add `branded_calling:read` for viewer role.

---

## 4. Provider Interface and Clients

### 4.1 Common Interface

```typescript
// api/src/integrations/branded-calling/types.ts

export type ProviderKind = 'first_orion' | 'hiya' | 'tns';

export interface BrandProfile {
  brandName: string;            // display name, ≤30 chars
  logoUrl: string | null;
  vertical: string;             // canonical vici2 enum
  callReasons: string[];        // array of canonical call reason strings
  website?: string;
  contactEmail?: string;
}

export interface DidRegistrationRequest {
  e164: string;
  callReason: string;           // canonical vici2 call reason
  effectiveDate: string;        // ISO date string
}

export interface DidRegistrationResult {
  e164: string;
  providerNumberId: string | null;
  status: 'active' | 'pending' | 'rejected';
  attestationLevel: 'A' | 'B' | 'C' | null;
  error: string | null;
}

export interface ReputationScore {
  e164: string;
  normalizedScore: number;      // 0–100; higher = better
  rawScore: number;
  isBlocked: boolean;
  spamLabel: string | null;
  polledAt: Date;
}

export interface IBrandedCallingProvider {
  kind: ProviderKind;

  // Brand lifecycle
  registerBrand(profile: BrandProfile): Promise<string>;          // returns provider_brand_id
  updateBrand(providerBrandId: string, profile: BrandProfile): Promise<void>;
  getBrandStatus(providerBrandId: string): Promise<{
    status: 'pending' | 'active' | 'rejected' | 'suspended';
    syncedAt: Date;
  }>;

  // DID registration
  registerNumbers(
    providerBrandId: string,
    requests: DidRegistrationRequest[],
  ): Promise<DidRegistrationResult[]>;
  deregisterNumber(providerBrandId: string, e164: string): Promise<void>;

  // Reputation
  getReputation(e164: string): Promise<ReputationScore>;

  // Dispute
  submitDispute(e164: string, notes: string): Promise<void>;
}
```

### 4.2 First Orion Client

```typescript
// api/src/integrations/branded-calling/first-orion.ts

export class FirstOrionClient implements IBrandedCallingProvider {
  readonly kind: ProviderKind = 'first_orion';
  private tokenCache: { token: string; expiresAt: Date } | null = null;

  constructor(private cfg: { clientId: string; clientSecret: string }) {}

  private async getToken(): Promise<string> {
    if (this.tokenCache && this.tokenCache.expiresAt > new Date()) {
      return this.tokenCache.token;
    }
    // POST https://auth.firstorion.com/oauth/token
    // grant_type=client_credentials
    const res = await fetch('https://auth.firstorion.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
      }),
    });
    if (!res.ok) throw new ProviderError('first_orion', 'TOKEN_FETCH_FAILED', res.status);
    const data = await res.json();
    this.tokenCache = {
      token: data.access_token,
      expiresAt: new Date(Date.now() + (data.expires_in - 60) * 1000),
    };
    return this.tokenCache.token;
  }

  private mapVertical(canonical: string): string {
    return canonical; // First Orion uses same vocabulary as vici2 canonical
  }

  private mapCallReason(canonical: string): string {
    return canonical; // First Orion uses same vocabulary as vici2 canonical
  }

  async registerBrand(profile: BrandProfile): Promise<string> {
    const token = await this.getToken();
    const res = await fetch('https://api.firstorion.com/engage/v2/brands', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        brand_name: profile.brandName,
        logo_url: profile.logoUrl,
        vertical: this.mapVertical(profile.vertical),
        call_reasons: profile.callReasons.map(cr => this.mapCallReason(cr)),
        primary_contact_email: profile.contactEmail,
        attestation_level: 'A',
      }),
    });
    if (!res.ok) throw new ProviderError('first_orion', 'BRAND_REG_FAILED', res.status, await res.text());
    const data = await res.json();
    return data.brand_id;
  }

  async registerNumbers(
    providerBrandId: string,
    requests: DidRegistrationRequest[],
  ): Promise<DidRegistrationResult[]> {
    const token = await this.getToken();
    const res = await fetch(
      `https://api.firstorion.com/engage/v2/brands/${providerBrandId}/numbers`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          numbers: requests.map(r => ({
            e164: r.e164,
            call_reason: this.mapCallReason(r.callReason),
            effective_date: r.effectiveDate,
          })),
        }),
      },
    );
    if (!res.ok) throw new ProviderError('first_orion', 'NUMBER_REG_FAILED', res.status, await res.text());
    const data = await res.json();
    return data.results.map((item: any) => ({
      e164: item.e164,
      providerNumberId: item.number_id ?? null,
      status: item.status === 'ACTIVE' ? 'active' : item.status === 'PENDING' ? 'pending' : 'rejected',
      attestationLevel: item.attestation_level ?? null,
      error: item.error_message ?? null,
    }));
  }

  async getReputation(e164: string): Promise<ReputationScore> {
    const token = await this.getToken();
    const res = await fetch(
      `https://api.firstorion.com/engage/v2/numbers/${encodeURIComponent(e164)}/reputation`,
      { headers: { 'Authorization': `Bearer ${token}` } },
    );
    if (!res.ok) throw new ProviderError('first_orion', 'REP_FETCH_FAILED', res.status);
    const data = await res.json();
    return {
      e164,
      normalizedScore: Math.round(data.reputation_score),          // 0–100 already
      rawScore: data.reputation_score,
      isBlocked: data.is_blocked ?? false,
      spamLabel: data.spam_label ?? null,
      polledAt: new Date(),
    };
  }

  // updateBrand, getBrandStatus, deregisterNumber, submitDispute — similar pattern
  // ...
}
```

### 4.3 Hiya Client

```typescript
// api/src/integrations/branded-calling/hiya.ts

export class HiyaClient implements IBrandedCallingProvider {
  readonly kind: ProviderKind = 'hiya';

  constructor(private cfg: { apiKey: string }) {}

  private get headers() {
    return {
      'X-API-Key': this.cfg.apiKey,
      'Content-Type': 'application/json',
    };
  }

  private mapVertical(canonical: string): string {
    const MAP: Record<string, string> = {
      TELEMARKETING: 'MARKETING',
    };
    return MAP[canonical] ?? canonical;
  }

  private mapCallReason(canonical: string): string {
    const MAP: Record<string, string> = {
      DELIVERY_NOTIFICATION: 'DELIVERY',
      GENERAL_NOTIFICATION: 'NOTIFICATION',
    };
    return MAP[canonical] ?? canonical;
  }

  async registerBrand(profile: BrandProfile): Promise<string> {
    const res = await fetch('https://api.connect.hiya.com/v1/business/profile', {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        display_name: profile.brandName,
        logo_url: profile.logoUrl,
        industry: this.mapVertical(profile.vertical),
        primary_use_case: profile.callReasons[0] ? this.mapCallReason(profile.callReasons[0]) : 'GENERAL_NOTIFICATION',
        website: profile.website,
        description: '',
      }),
    });
    if (!res.ok) throw new ProviderError('hiya', 'BRAND_REG_FAILED', res.status, await res.text());
    const data = await res.json();
    return data.business_id;
  }

  async registerNumbers(
    providerBrandId: string,
    requests: DidRegistrationRequest[],
  ): Promise<DidRegistrationResult[]> {
    const res = await fetch('https://api.connect.hiya.com/v1/business/numbers', {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        business_id: providerBrandId,
        numbers: requests.map(r => ({ e164: r.e164 })),
      }),
    });
    if (!res.ok) throw new ProviderError('hiya', 'NUMBER_REG_FAILED', res.status, await res.text());
    const data = await res.json();
    return data.results.map((item: any) => ({
      e164: item.e164,
      providerNumberId: item.number_id ?? null,
      status: item.status === 'ACTIVE' ? 'active' : item.status === 'COOLING' ? 'pending' : 'pending',
      attestationLevel: null,                    // Hiya does not report attestation level
      error: item.error ?? null,
    }));
  }

  async getReputation(e164: string): Promise<ReputationScore> {
    const res = await fetch(
      `https://api.connect.hiya.com/v1/business/numbers/${encodeURIComponent(e164)}/score`,
      { headers: this.headers },
    );
    if (!res.ok) throw new ProviderError('hiya', 'REP_FETCH_FAILED', res.status);
    const data = await res.json();
    return {
      e164,
      normalizedScore: Math.round((data.score ?? 10) * 10),        // Hiya: 0–10 → 0–100
      rawScore: data.score ?? 10,
      isBlocked: data.is_blocked ?? false,
      spamLabel: data.spam_label ?? null,
      polledAt: new Date(),
    };
  }

  // updateBrand, getBrandStatus, deregisterNumber, submitDispute — similar pattern
  // ...
}
```

### 4.4 TNS Client

```typescript
// api/src/integrations/branded-calling/tns.ts
import { createHmac } from 'node:crypto';

export class TnsClient implements IBrandedCallingProvider {
  readonly kind: ProviderKind = 'tns';

  constructor(private cfg: { apiKey: string; apiSecret: string }) {}

  private sign(method: string, path: string, timestamp: string, bodyHash: string): string {
    const message = `${method}\n${path}\n${timestamp}\n${bodyHash}`;
    return createHmac('sha256', this.cfg.apiSecret).update(message).digest('hex');
  }

  private async request(
    method: string,
    path: string,
    body?: object,
  ): Promise<Response> {
    const timestamp = new Date().toISOString();
    const bodyStr = body ? JSON.stringify(body) : '';
    const bodyHash = createHmac('sha256', this.cfg.apiSecret).update(bodyStr).digest('hex');
    const sig = this.sign(method.toUpperCase(), path, timestamp, bodyHash);
    return fetch(`https://ecid-api.tnsi.com/v3${path}`, {
      method,
      headers: {
        'X-TNS-Key': this.cfg.apiKey,
        'X-TNS-Timestamp': timestamp,
        'X-TNS-Signature': sig,
        'Content-Type': 'application/json',
      },
      body: bodyStr || undefined,
    });
  }

  private mapCallReason(canonical: string): string {
    const MAP: Record<string, string> = {
      COLLECTIONS: 'DEBT_COLLECTION',
      FRAUD_ALERT: 'SECURITY_ALERT',
      GENERAL_NOTIFICATION: 'GENERAL',
    };
    return MAP[canonical] ?? canonical;
  }

  async registerBrand(profile: BrandProfile): Promise<string> {
    const res = await this.request('POST', '/brands', {
      company_name: profile.brandName,
      display_name: profile.brandName,
      vertical: profile.vertical,
      logo_url: profile.logoUrl,
      call_reasons: profile.callReasons.map(cr => this.mapCallReason(cr)),
      website: profile.website,
      contact_email: profile.contactEmail,
      attestation: 'A',
    });
    if (!res.ok) throw new ProviderError('tns', 'BRAND_REG_FAILED', res.status, await res.text());
    const data = await res.json();
    return data.brand_id;
  }

  async registerNumbers(
    providerBrandId: string,
    requests: DidRegistrationRequest[],
  ): Promise<DidRegistrationResult[]> {
    const res = await this.request('POST', `/brands/${providerBrandId}/numbers`, {
      numbers: requests.map(r => ({
        e164: r.e164,
        call_reason: this.mapCallReason(r.callReason),
        effective_date: r.effectiveDate,
      })),
    });
    if (!res.ok) throw new ProviderError('tns', 'NUMBER_REG_FAILED', res.status, await res.text());
    const data = await res.json();
    return data.results.map((item: any) => ({
      e164: item.e164,
      providerNumberId: item.number_id ?? null,
      status: item.status === 'APPROVED' ? 'active' : item.status === 'PENDING' ? 'pending' : 'rejected',
      attestationLevel: item.attestation_confirmed ?? null,
      error: item.error_message ?? null,
    }));
  }

  async getReputation(e164: string): Promise<ReputationScore> {
    const res = await this.request('GET', `/numbers/${encodeURIComponent(e164)}/analytics`);
    if (!res.ok) throw new ProviderError('tns', 'REP_FETCH_FAILED', res.status);
    const data = await res.json();
    // TNS: overall_risk_score 0–100 where 0 = lowest risk; invert for normalized scale
    const normalized = Math.round(100 - (data.overall_risk_score ?? 0));
    return {
      e164,
      normalizedScore: Math.max(0, Math.min(100, normalized)),
      rawScore: data.overall_risk_score ?? 0,
      isBlocked: (data.user_block_rate_30d ?? 0) > 0.15,          // >15% block rate = effectively blocked
      spamLabel: data.spam_label ?? null,
      polledAt: new Date(),
    };
  }

  // updateBrand, getBrandStatus, deregisterNumber, submitDispute — similar pattern
  // ...
}
```

### 4.5 Provider Registry

```typescript
// api/src/integrations/branded-calling/registry.ts
import { decrypt } from '../../services/crypto'; // F05 envelope decryption

export class ProviderRegistry {
  private static clients = new Map<string, IBrandedCallingProvider>();

  static async getClient(provider: BrandedCallingProvider): Promise<IBrandedCallingProvider> {
    const cacheKey = `${provider.tenantId}:${provider.provider}`;
    if (this.clients.has(cacheKey)) return this.clients.get(cacheKey)!;

    const creds = JSON.parse(
      await decrypt(provider.credentialsEnc, provider.kekVersion),
    );

    let client: IBrandedCallingProvider;
    switch (provider.provider) {
      case 'first_orion':
        client = new FirstOrionClient(creds);
        break;
      case 'hiya':
        client = new HiyaClient(creds);
        break;
      case 'tns':
        client = new TnsClient(creds);
        break;
      default:
        throw new Error(`Unknown provider: ${provider.provider}`);
    }

    // Cache for 15 minutes (credentials may rotate)
    this.clients.set(cacheKey, client);
    setTimeout(() => this.clients.delete(cacheKey), 15 * 60 * 1000);
    return client;
  }

  static invalidate(tenantId: bigint, provider: ProviderKind): void {
    this.clients.delete(`${tenantId}:${provider}`);
  }
}
```

### 4.6 Error Type

```typescript
// api/src/integrations/branded-calling/errors.ts
export class ProviderError extends Error {
  constructor(
    public readonly provider: ProviderKind,
    public readonly code: string,
    public readonly httpStatus: number,
    public readonly body?: string,
  ) {
    super(`[${provider}] ${code} (HTTP ${httpStatus})`);
    this.name = 'ProviderError';
  }
}
```

---

## 5. BullMQ Workers

### 5.1 Job: `branded-calling:register-did`

**Queue:** `vici2:queue:branded-calling`
**Worker file:** `workers/src/jobs/branded-calling/register-did.ts`

**Payload:**
```typescript
interface RegisterDidJobPayload {
  tenantId: string;             // string because BullMQ serializes BigInt as string
  didId: string;
  providerId: string;           // branded_calling_providers.id
  e164: string;
  callReason: string;
  effectiveDate: string;
}
```

**Processing logic:**
```typescript
async function processRegisterDid(job: Job<RegisterDidJobPayload>): Promise<void> {
  const { tenantId, didId, providerId, e164, callReason, effectiveDate } = job.data;

  const providerRow = await prisma.brandedCallingProvider.findUniqueOrThrow({
    where: { id: BigInt(providerId) },
  });
  const client = await ProviderRegistry.getClient(providerRow);

  const [result] = await client.registerNumbers(providerRow.providerBrandId!, [
    { e164, callReason, effectiveDate },
  ]);

  if (result.status === 'rejected') {
    await prisma.brandedDidRegistration.update({
      where: { didId_provider: { didId: BigInt(didId), provider: providerRow.provider } },
      data: {
        status: 'rejected',
        lastError: result.error,
        retryCount: { increment: 1 },
      },
    });
    return; // do not retry; rejection is final until admin intervenes
  }

  await prisma.brandedDidRegistration.update({
    where: { didId_provider: { didId: BigInt(didId), provider: providerRow.provider } },
    data: {
      status: result.status === 'active' ? 'active' : 'submitted',
      providerNumberId: result.providerNumberId,
      attestationLevel: result.attestationLevel,
      registeredAt: result.status === 'active' ? new Date() : null,
    },
  });

  await audit({
    tenantId: BigInt(tenantId),
    action: 'branded_did_registration.submitted',
    entityType: 'branded_did_registration',
    entityId: didId,
    meta: { provider: providerRow.provider, status: result.status },
  });
}
```

**Retry strategy:** `attempts: 3`, exponential backoff starting at 30s. On final failure, set `status = 'error'` and `lastError = job.failedReason`.

**Bulk registration optimization:** The admin API's `POST /api/admin/branded-calling/:provider/dids/bulk-register` endpoint enqueues a single `branded-calling:bulk-register` job (see §5.3) rather than N individual jobs, to take advantage of provider bulk APIs (up to 500 DIDs per request).

### 5.2 Job: `branded-calling:poll-reputation`

**Queue:** `vici2:queue:branded-calling`
**Worker file:** `workers/src/jobs/branded-calling/poll-reputation.ts`
**Schedule:** Bull-board cron; the scheduler enqueues this job per tenant per provider on two schedules:
- Healthy DIDs (reputation_score >= 60 or NULL): every 24 hours (cron `0 3 * * *`).
- At-risk DIDs (reputation_score 30–59): every 4 hours.
- Critical DIDs (reputation_score < 30): every 1 hour (until quarantined).

**Payload:**
```typescript
interface PollReputationJobPayload {
  tenantId: string;
  providerId: string;
  didIds: string[];              // batch of up to 100 DID IDs to poll
}
```

**Processing logic:**
```typescript
async function processPollReputation(job: Job<PollReputationJobPayload>): Promise<void> {
  const { tenantId, providerId, didIds } = job.data;
  const providerRow = await prisma.brandedCallingProvider.findUniqueOrThrow({ where: { id: BigInt(providerId) } });
  const client = await ProviderRegistry.getClient(providerRow);

  const registrations = await prisma.brandedDidRegistration.findMany({
    where: { providerId: BigInt(providerId), status: 'active', id: { in: didIds.map(BigInt) } },
    include: { did: { select: { e164: true } } },
  });

  for (const reg of registrations) {
    let score: ReputationScore;
    try {
      score = await client.getReputation(reg.did.e164);
    } catch (err) {
      logger.warn({ err, e164: reg.did.e164, provider: providerRow.provider }, 'rep poll failed');
      continue;
    }

    await prisma.brandedDidRegistration.update({
      where: { id: reg.id },
      data: {
        reputationScore: score.normalizedScore,
        reputationLastPolledAt: score.polledAt,
        rawScore: score.rawScore,
        rawScoreAt: score.polledAt,
      },
    });

    // Update did_numbers.brand_reputation_score with worst score across all providers
    await updateDidWorstScore(reg.didId, BigInt(tenantId));

    // Trigger X04 quarantine hook if below threshold
    const threshold = Number(process.env.BRAND_QUARANTINE_THRESHOLD ?? '30');
    if (score.normalizedScore < threshold) {
      await x04QuarantineHook.onRepScoreUpdated(reg.didId, BigInt(tenantId), score.normalizedScore);
    }

    // Emit metric
    brandRepScoreGauge.labels({
      provider: providerRow.provider,
      tenant_id: tenantId,
    }).set(score.normalizedScore);
  }
}

async function updateDidWorstScore(didId: bigint, tenantId: bigint): Promise<void> {
  const allRegs = await prisma.brandedDidRegistration.findMany({
    where: { didId, status: 'active', reputationScore: { not: null } },
    select: { reputationScore: true },
  });
  if (allRegs.length === 0) return;
  const worst = Math.min(...allRegs.map(r => r.reputationScore!));
  await prisma.didNumber.update({
    where: { id: didId },
    data: { brandReputationScore: worst },
  });
}
```

### 5.3 Job: `branded-calling:bulk-register`

**Worker file:** `workers/src/jobs/branded-calling/bulk-register.ts`

Enqueued by admin UI "Register All DIDs in Pool" action. Takes up to 500 DID IDs, fetches their E.164 numbers, calls provider's `registerNumbers()` in chunks of 500, writes results back to `branded_did_registrations`.

### 5.4 Job: `branded-calling:deregister-did`

Enqueued by DID deprovision cascade (T02 DID-delete API hook) or by admin explicit deregister action. Calls `client.deregisterNumber()`, sets `status = 'deregistered'`, `deregisteredAt = now()`.

### 5.5 Metrics

Add to `workers/src/lib/metrics.ts`:
```typescript
export const brandRepScoreGauge = new client.Gauge({
  name: 'vici2_branded_did_reputation_score',
  help: 'Normalized brand reputation score (0–100) for active branded DIDs',
  labelNames: ['provider', 'tenant_id'],
});

export const brandedDidCountGauge = new client.Gauge({
  name: 'vici2_branded_did_count',
  help: 'Count of active branded DID registrations per provider',
  labelNames: ['provider', 'tenant_id', 'status'],
});
```

---

## 6. X04 Integration Hook

### 6.1 Interface

```typescript
// api/src/integrations/branded-calling/types.ts (appended)
export interface BrandedCallingReputationHook {
  onRepScoreUpdated(
    didId: bigint,
    tenantId: bigint,
    normalizedScore: number,
  ): Promise<void>;
}
```

### 6.2 Implementation (in X04 codebase)

```typescript
// api/src/services/number-pool/quarantine-hook.ts
import type { BrandedCallingReputationHook } from '../../integrations/branded-calling/types';
import { poolService } from './pool-service';
import { AuditWriter } from '../../services/audit';

export const x04QuarantineHook: BrandedCallingReputationHook = {
  async onRepScoreUpdated(didId, tenantId, normalizedScore) {
    const threshold = Number(process.env.BRAND_QUARANTINE_THRESHOLD ?? '30');
    if (normalizedScore >= threshold) return;

    await poolService.quarantineDidGlobally(didId, tenantId, {
      reason: 'BRAND_REPUTATION',
      score: normalizedScore,
    });

    await AuditWriter.write({
      tenantId,
      action: 'number_pool_did.auto_quarantined',
      entityType: 'did_number',
      entityId: String(didId),
      meta: { reason: 'BRAND_REPUTATION', normalizedScore },
    });
  },
};
```

`poolService.quarantineDidGlobally()` sets `number_pool_dids.quarantined = true` and `quarantine_reason = 'BRAND_REPUTATION'` for ALL pool memberships of this DID across all pools in the tenant. This is intentional: a DID with a critically low reputation score should not originate calls from any pool until remediated.

---

## 7. REST API

### 7.1 Route Structure

**Base path:** `/api/admin/branded-calling`

All routes require `requireAuth` + `requirePermission` middleware (from F05).

```
GET    /api/admin/branded-calling                               // list configured providers (branded_calling:configure)
POST   /api/admin/branded-calling/:provider                    // create/configure a provider (branded_calling:configure)
GET    /api/admin/branded-calling/:provider                    // get provider config + brand profile (branded_calling:configure)
PATCH  /api/admin/branded-calling/:provider                    // update brand profile (branded_calling:configure)
DELETE /api/admin/branded-calling/:provider                    // soft-delete provider config (branded_calling:configure)
POST   /api/admin/branded-calling/:provider/test-connection    // validate credentials (branded_calling:configure)

GET    /api/admin/branded-calling/:provider/dids               // list registered DIDs + status (branded_calling:register_did)
POST   /api/admin/branded-calling/:provider/dids               // register individual DID (branded_calling:register_did)
DELETE /api/admin/branded-calling/:provider/dids/:didId        // deregister DID (branded_calling:register_did)
POST   /api/admin/branded-calling/:provider/dids/bulk-register // register multiple DIDs (branded_calling:register_did)
POST   /api/admin/branded-calling/:provider/dids/:didId/dispute // submit dispute (branded_calling:register_did)
GET    /api/admin/branded-calling/:provider/dids/:didId/reputation // get latest reputation score (branded_calling:register_did)
```

### 7.2 Request/Response Shapes

**`POST /api/admin/branded-calling/:provider`** — configure provider:
```typescript
// Request body
{
  credentials: {
    // first_orion: { client_id, client_secret }
    // hiya:        { api_key }
    // tns:         { api_key, api_secret }
  },
  brandName: string,
  logoUrl: string | null,
  vertical: string,
  callReasons: string[],
  website?: string,
  contactEmail?: string,
}

// Response 201
{
  id: string,          // branded_calling_providers.id
  provider: string,
  brandStatus: 'pending',
  providerBrandId: string | null,
  createdAt: string,
}
```

Credentials are immediately encrypted with the tenant's KEK (F05 `encrypt()` service) before writing to DB. They are **never returned in GET responses** — the GET response replaces `credentials` with `{ configured: true }`.

**`POST /api/admin/branded-calling/:provider/dids`** — register DID:
```typescript
// Request body
{
  didId: string,
  callReason: string,
}

// Response 202 (accepted; registration is async via BullMQ)
{
  registrationId: string,   // branded_did_registrations.id
  status: 'pending',
  jobId: string,            // BullMQ job ID for status polling
}
```

**`GET /api/admin/branded-calling/:provider/dids`** — list DIDs:
```typescript
// Response 200
{
  items: Array<{
    registrationId: string,
    didId: string,
    e164: string,
    status: string,
    attestationLevel: string | null,
    reputationScore: number | null,
    reputationLastPolledAt: string | null,
    isBlocked: boolean,
    spamLabel: string | null,
    disputeOpen: boolean,
    registeredAt: string | null,
  }>,
  total: number,
  page: number,
  pageSize: number,
}
```

**`POST /api/admin/branded-calling/:provider/test-connection`** — validate credentials:
```typescript
// Response 200
{ ok: true, brandStatus: string, providerBrandId: string }
// Response 422 if credentials invalid
{ ok: false, error: string }
```

### 7.3 Route File Structure

```
api/src/routes/admin/branded-calling/
  index.ts                  # Express router; mounts sub-routers
  provider.ts               # CRUD for branded_calling_providers
  dids.ts                   # DID registration/deregistration
  reputation.ts             # reputation query + dispute
  schemas.ts                # Zod request validation schemas
```

---

## 8. Admin UI

### 8.1 Page Structure

**Route:** `(admin)/integrations/branded-calling/page.tsx`

```
Branded Calling
├── Provider tabs: [First Orion] [Hiya] [TNS]
│
└── Per-provider tab:
    ├── Brand Profile section
    │   ├── Status badge (Pending / Active / Rejected / Suspended / Not Configured)
    │   ├── Company Display Name (text input)
    │   ├── Logo URL (text input + preview thumbnail)
    │   ├── Vertical (select)
    │   ├── Call Reasons (multi-select)
    │   ├── API Credentials (masked input; "Update credentials" expander)
    │   └── [Save Brand Profile] [Test Connection] buttons
    │
    ├── DID Registrations table
    │   ├── Columns: DID (E.164), Status badge, Reputation, Attestation, Registered At, Actions
    │   ├── Status badge colors:
    │   │   active → green, pending/submitted → yellow, rejected/error → red, deregistered → gray
    │   ├── Reputation column: colored number (green ≥60, yellow 30–59, red <30)
    │   ├── Actions: [Register] / [Deregister] / [Submit Dispute] / [Force Poll]
    │   └── Pagination: 50 per page
    │
    └── Bulk actions toolbar:
        ├── [Register All Unregistered]
        ├── [Deregister All]
        └── [Export Status CSV]
```

### 8.2 Component Files

```
web/src/app/(admin)/integrations/branded-calling/
  page.tsx                   # main page; wraps ProviderTabGroup
  components/
    ProviderTabGroup.tsx      # tabs for first_orion / hiya / tns
    BrandProfileForm.tsx      # brand name, logo, vertical, call reasons, credentials
    DidRegistrationTable.tsx  # table with reputation scores + actions
    ReputationBadge.tsx       # colored score + label
    DisputeModal.tsx          # dispute submission form
    BulkRegisterModal.tsx     # confirm bulk registration count + cost estimate
  hooks/
    useBrandedCalling.ts      # API calls + query state (React Query)
  lib/
    constants.ts              # VERTICAL_LABELS, CALL_REASON_LABELS (display strings)
```

### 8.3 Cost Estimate Display

The Bulk Register Modal shows:
```
You are about to register 47 DIDs with First Orion.
Estimated monthly cost: ~$23–$71 (at $0.50–$1.50 per DID/month).
This is an estimate; actual billing is per your provider contract.
```

Cost constants are stored in `web/src/app/(admin)/integrations/branded-calling/lib/constants.ts`:
```typescript
export const PROVIDER_COST_RANGES = {
  first_orion: { min: 0.50, max: 1.50 },
  hiya:        { min: 0.30, max: 1.00 },
  tns:         { min: 0.75, max: 2.00 },
};
```

---

## 9. File Tree

```
api/prisma/migrations/20260513320000_n05_branded_calling/
  migration.sql

api/src/
  integrations/branded-calling/
    types.ts                    # IBrandedCallingProvider, BrandProfile, DidRegistrationRequest, etc.
    errors.ts                   # ProviderError
    registry.ts                 # ProviderRegistry
    first-orion.ts              # FirstOrionClient (OAuth2)
    hiya.ts                     # HiyaClient (API key)
    tns.ts                      # TnsClient (HMAC)
    vertical-map.ts             # canonical → provider vocabulary maps
    call-reason-map.ts          # canonical → provider vocabulary maps
  routes/admin/branded-calling/
    index.ts
    provider.ts
    dids.ts
    reputation.ts
    schemas.ts

workers/src/jobs/branded-calling/
  register-did.ts
  bulk-register.ts
  deregister-did.ts
  poll-reputation.ts
  scheduler.ts                  # enqueues poll-reputation jobs on cron schedule

web/src/app/(admin)/integrations/branded-calling/
  page.tsx
  components/
    ProviderTabGroup.tsx
    BrandProfileForm.tsx
    DidRegistrationTable.tsx
    ReputationBadge.tsx
    DisputeModal.tsx
    BulkRegisterModal.tsx
  hooks/
    useBrandedCalling.ts
  lib/
    constants.ts

shared/types/src/
  rbac.ts                       # add branded_calling:configure, branded_calling:register_did
```

---

## 10. LOC Estimate

| Component | Estimated LOC |
|---|---|
| Schema migration SQL | 80 |
| `types.ts` (interface + shared types) | 80 |
| `errors.ts` | 20 |
| `registry.ts` | 60 |
| `first-orion.ts` (full implementation) | 160 |
| `hiya.ts` (full implementation) | 140 |
| `tns.ts` (full implementation inc. HMAC signing) | 150 |
| `vertical-map.ts` + `call-reason-map.ts` | 60 |
| Admin routes (`index`, `provider`, `dids`, `reputation`, `schemas`) | 220 |
| Workers (`register-did`, `bulk-register`, `deregister-did`, `poll-reputation`, `scheduler`) | 200 |
| Admin UI (`page`, components, hooks, lib) | 180 |
| RBAC additions | 25 |
| Unit tests | 120 |
| **Total** | **~1,295** |

---

## 11. Testing

### 11.1 Unit Tests

**File:** `api/test/branded-calling/*.test.ts`

| Test | Assertion |
|---|---|
| Score normalization: First Orion | Score 75 → normalizedScore 75 |
| Score normalization: Hiya | Score 8.0 → normalizedScore 80 |
| Score normalization: TNS | overall_risk_score 20 → normalizedScore 80 |
| Score normalization: TNS worst case | overall_risk_score 100 → normalizedScore 0 |
| ProviderRegistry caches client for 15min | Second call returns same instance |
| ProviderRegistry invalidates on credential update | Cache cleared after PATCH |
| FirstOrionClient token refresh | Token fetched once; reused until expiry |
| TnsClient HMAC signature | Signature matches reference vector |
| updateDidWorstScore | min(scores from 3 providers) stored on did_numbers |
| x04QuarantineHook: score below threshold | poolService.quarantineDidGlobally called |
| x04QuarantineHook: score above threshold | poolService.quarantineDidGlobally NOT called |
| Admin route POST/provider validates Zod schema | 422 on invalid vertical |
| Admin route GET/provider masks credentials | Response has `{ configured: true }`, not raw creds |

### 11.2 Integration Tests (mocked provider HTTP)

Use `nock` or `msw` to mock provider endpoints at HTTP level.

| Test scenario |
|---|
| Register brand with First Orion → provider_brand_id stored |
| Register DID with Hiya → status transitions pending → submitted → active |
| Poll reputation from TNS → did_numbers.brand_reputation_score updated |
| DID deregistered on T02 DID-delete → provider API called, status = deregistered |
| Reputation below threshold → x04QuarantineHook fires → number_pool_dids.quarantined = true |
| Test-connection with invalid credentials → 422 returned |

---

## 12. Rollout and Migration

1. Run migration `20260513320000_n05_branded_calling` → creates two tables, adds `brand_reputation_score` column to `did_numbers`.
2. Deploy API with new routes (no existing routes changed).
3. Deploy workers with new job processors. Scheduler job starts on worker boot.
4. Admin configures provider credentials via UI.
5. Admin registers brand (enqueues brand-registration call to provider).
6. Admin registers DIDs via bulk-register action.
7. Reputation polling begins automatically on the cron schedule.
8. X04 quarantine hook is active from deploy; it only triggers when N05 polls and writes scores.

No backfill required. `brand_reputation_score` starts as NULL for all existing DIDs; X04 treats NULL as "unscored" and does not auto-quarantine based on NULL.

---

## 13. Security Considerations

- **Credentials at rest**: Provider API credentials encrypted with tenant KEK (VARBINARY(512) + kek_version per F02 envelope-encryption pattern). The F05 `encrypt()`/`decrypt()` functions handle AES-256-GCM wrapping.
- **Credentials in transit**: Never returned in API responses. GET responses return `{ configured: true }`. Credentials passed only once (on POST/PATCH) from browser to server over HTTPS.
- **Provider API calls**: All made server-side from workers or API server. Provider credentials never exposed to browser.
- **Logo URL validation**: `POST /api/admin/branded-calling/:provider` validates `logoUrl` with Zod's `z.string().url()` + custom refinement ensuring `https:` scheme and no `data:` prefix.
- **HMAC signing (TNS)**: Uses Node.js built-in `crypto.createHmac`; no third-party crypto library.
- **Rate limiting**: Provider clients should respect rate limits. Workers use BullMQ `limiter` option: `{ max: 80, duration: 1000 }` for registration jobs (staying under First Orion's 100 req/s limit).
- **Audit trail**: Every credential update, brand profile change, DID registration, deregistration, and dispute is written to `audit_log` via `AuditWriter`.
