# N04 — HubSpot Integration — PLAN

| Field | Value |
|---|---|
| **Module** | N04 — HubSpot Integration |
| **Author** | N04-PLAN agent (Claude Sonnet 4.6) |
| **Date** | 2026-05-13 |
| **Status** | PLAN |
| **Depends on (FROZEN)** | N01 (`notify()`, `integration_error` category added here), N02 (F05 `encryptField`/`decryptField` envelope-encryption pattern), W01 (BullMQ topology — 3 new queue slots), F05 (JWT auth middleware, `requirePermission`), F02 schema (`leads`, `lists`, `audit_log`), C03 (`AuditWriter`), D07 (list-service layer for HubSpot list import) |
| **Blocks** | Nothing in Phase 4; N05 (if it adds integration categories) may reference these patterns |

Once approved, the following are **FROZEN**: Prisma model names (`HubspotIntegration`, `HubspotSyncJob`, `LeadExternalRef`), table names (`hubspot_integrations`, `hubspot_sync_jobs`, `lead_external_refs`), REST endpoint paths under `/api/admin/integrations/hubspot`, BullMQ queue names (`vici2:queue:hubspot-sync`, `vici2:queue:hubspot-push`, `vici2:queue:hubspot-webhook`), RBAC verbs (`integration:hs:configure`, `integration:hs:click_to_dial`), audit action slugs. Column types, index specifics, and UI CSS may change without RFC.

---

## 0. TL;DR — 14-bullet decision summary

1. **Public OAuth 2.0 app; one `hubspot_integrations` row per tenant.** Access token + refresh token stored as `VARBINARY(512)` ciphertext using F05 `encryptField()`. Proactive refresh 5 min before expiry via a BullMQ repeatable job.
2. **`hubspot_integrations` is the anchor table.** Holds OAuth tokens, portal ID, sync config, and connection status (`connected | error | disconnected`). Unique on `tenant_id`.
3. **`lead_external_refs` is the deduplication index.** Source-agnostic cross-reference table: `(tenant_id, source, external_id)` unique. `source = 'hubspot'`, `external_id = hs_object_id`. Allows future N05 (Zoho?), N06, etc. to reuse the same pattern.
4. **`hubspot_sync_jobs` tracks BullMQ job lifecycle.** Each sync run writes a row with `status`, `contacts_upserted`, `errors`, `started_at`, `completed_at`. Admin UI shows last 10 runs per integration.
5. **Three BullMQ queues.** `hubspot-sync` (contact pull, repeatable per-tenant), `hubspot-push` (engagement write-back on dispo), `hubspot-webhook` (process inbound HubSpot event batches).
6. **Incremental pull via `lastmodifieddate >= cursor`.** Cursor stored in `hubspot_integrations.last_sync_cursor`. Paging cursor stored in `hubspot_sync_jobs.paging_cursor` for crash-resume. Default cadence: 15 minutes.
7. **HubSpot lists → vici2 lead lists via D07 service layer.** Admin selects a HubSpot list; sync worker fetches members and upserts into `leads` + `lead_external_refs`. List metadata stored in `lists.meta JSON`.
8. **Calling widget: Next.js page at `(admin)/integrations/hubspot/widget`.** Served publicly (iframe from HubSpot). Authentication via short-lived JWT in query param. Loads `@hubspot/calling-extensions-sdk` npm package. Posts `outgoingCall`, `callEnded`, `callCompleted` events.
9. **Engagement write-back: `POST /crm/v3/objects/calls`.** Triggered by `call.ended` event (N01/N02 event bus or direct BullMQ enqueue from FreeSWITCH dispo handler). Includes duration, disposition, recording URL (if R02 deployed), contact association.
10. **SDK pre-creation flow: `createEngagement: true`.** Widget uses HubSpot's pre-create engagement pattern so the call appears in the contact timeline immediately. Post-call, vici2 updates the pre-created engagement via PATCH rather than creating a duplicate.
11. **RBAC: `integration:hs:configure` (admin+) and `integration:hs:click_to_dial` (agent+).** `configure` gates all OAuth and settings endpoints. `click_to_dial` gates widget token issuance.
12. **Inbound HubSpot webhooks at `POST /api/webhooks/hubspot`.** Public endpoint; validated by `SHA-256 HMAC(client_secret, raw_body)`. Enqueues to `hubspot-webhook` queue immediately; returns `200` within 5s.
13. **Rate limit guard.** Worker reads `X-HubSpot-RateLimit-Daily-Remaining` header; if `< 1000`, sets `hubspot_integrations.rate_limit_backoff_until` and suspends sync. Exponential backoff on 429/5xx with `Retry-After` header respect.
14. **Audit trail.** `hs_integration.connected`, `.disconnected`, `.sync_started`, `.sync_completed`, `.sync_failed`, `.engagement_pushed`, `.token_refreshed` written via C03 `AuditWriter`.

---

## 1. Goals and Non-Goals

### 1.1 Phase 1 Goals

- HubSpot OAuth 2.0 flow (connect/disconnect).
- Encrypted token storage and proactive refresh.
- Multi-portal support (one portal per tenant).
- Incremental contact sync to vici2 leads, cursor-based, paginated.
- HubSpot list import → vici2 lead list (admin-triggered, manual or scheduled).
- `lead_external_refs` deduplication table.
- Calling widget (iframe) at `/hubspot-calling` path, SDK-integrated.
- Widget token issuance endpoint.
- Click-to-call: `onDialNumber` event triggers vici2 dial via existing call API.
- Call engagement write-back (CALL engagement, v3 API) on dispo.
- Disposition and call-status mapping (configurable JSON).
- Inbound HubSpot webhook processing (contact property changes → re-sync).
- Rate limit tracking and backoff.
- Admin UI: connection page, sync status, last-run history.
- RBAC: `integration:hs:configure` + `integration:hs:click_to_dial`.
- Audit log for all integration lifecycle events.
- N01 `integration_error` notification on token expiry or repeated sync failure.

### 1.2 Phase 2 (Deferred)

- Inbound calling support (`supportsInboundCalling: true` in SDK registration).
- Write-back to HubSpot contact properties (`vici2_last_dispo`, `vici2_last_call_at` custom properties).
- HubSpot Owner → vici2 agent mapping (round-robin assignment by owner).
- Deal association on call engagements.
- Note engagement fallback when CALL engagement creation fails.
- GDPR erasure: propagate HubSpot contact deletion to vici2 lead anonymization.
- Automatic field conflict resolution policy UI (currently hardcoded `sync_overwrites_manual_edits = false`).

### 1.3 Non-Goals (Phase 1)

- HubSpot Marketing Hub integration (email campaigns, workflows).
- Bidirectional contact edit sync (HubSpot ← vici2 lead edits).
- HubSpot mobile app / iOS calling widget.
- HubSpot Sandbox environment support (admins can connect a sandbox manually; no special code path).
- Salesforce + HubSpot simultaneous dual-CRM sync on a single tenant (unsupported; admin picks one CRM per tenant in Phase 1).

---

## 2. Schema

### 2.1 Migration Filename

```
api/prisma/migrations/20260513310000_n04_hubspot/migration.sql
```

### 2.2 `hubspot_integrations` Table

```prisma
enum HubspotIntegrationStatus {
  connected
  error
  disconnected
}

enum HubspotSyncMode {
  ALL_CONTACTS
  LIST_ONLY
}

model HubspotIntegration {
  id                     BigInt                    @id @default(autoincrement())
  tenantId               BigInt                    @unique @map("tenant_id")
  portalId               BigInt                    @map("portal_id")          // HubSpot hub_id
  hubDomain              String?                   @map("hub_domain") @db.VarChar(128)

  // Envelope-encrypted OAuth tokens (F05 pattern)
  accessTokenEnc         Bytes                     @map("access_token_enc") @db.VarBinary(512)
  refreshTokenEnc        Bytes                     @map("refresh_token_enc") @db.VarBinary(512)
  kekVersion             Int                       @default(1) @map("kek_version") @db.SmallInt
  tokenExpiresAt         DateTime                  @map("token_expires_at") @db.DateTime(6)

  // Sync configuration
  status                 HubspotIntegrationStatus  @default(connected)
  syncMode               HubspotSyncMode           @default(ALL_CONTACTS) @map("sync_mode")
  syncIntervalMinutes    Int                        @default(15) @map("sync_interval_minutes") @db.SmallInt
  lastSyncCursor         DateTime?                 @map("last_sync_cursor") @db.DateTime(6)
  lastSyncAt             DateTime?                 @map("last_sync_at") @db.DateTime(6)
  rateLimitBackoffUntil  DateTime?                 @map("rate_limit_backoff_until") @db.DateTime(6)

  // Configurable mappings (JSON blobs)
  statusMap              Json                      @default("{}") @map("status_map")
  // { "SALE": "COMPLETED", "NA": "NO_ANSWER", ... }
  dispositionMap         Json                      @default("{}") @map("disposition_map")

  // Features
  includeRecordingUrl    Boolean                   @default(true) @map("include_recording_url")
  syncOverwritesManual   Boolean                   @default(false) @map("sync_overwrites_manual_edits")

  // Soft delete
  deletedAt              DateTime?                 @map("deleted_at") @db.DateTime(6)
  createdAt              DateTime                  @default(now()) @map("created_at") @db.DateTime(6)
  updatedAt              DateTime                  @updatedAt @map("updated_at") @db.DateTime(6)

  tenant    Tenant              @relation(fields: [tenantId], references: [id], onDelete: Restrict, onUpdate: NoAction, map: "fk_hs_integration_tenant")
  syncJobs  HubspotSyncJob[]

  @@index([portalId], map: "idx_hs_integration_portal_id")  // for webhook dispatch
  @@map("hubspot_integrations")
}
```

Design notes:
- `UNIQUE` on `tenantId` enforces one-portal-per-tenant.
- Separate index on `portalId` for inbound webhook fan-out (`WHERE portal_id = ?`).
- `deletedAt` enables soft-delete so audit log references remain valid after disconnect.
- `statusMap` and `dispositionMap` are JSON; default `{}` means fall through to the hardcoded default mapping table in `push-activity.ts`.
- `syncIntervalMinutes` minimum is enforced at the API layer (`>= 5`), not DB constraint.

### 2.3 `hubspot_sync_jobs` Table

```prisma
enum HubspotSyncJobStatus {
  running
  completed
  failed
  cancelled
}

model HubspotSyncJob {
  id                  BigInt                  @id @default(autoincrement())
  tenantId            BigInt                  @map("tenant_id")
  integrationId       BigInt                  @map("integration_id")
  bullmqJobId         String?                 @map("bullmq_job_id") @db.VarChar(64)
  status              HubspotSyncJobStatus    @default(running)
  syncMode            HubspotSyncMode         @map("sync_mode")
  pagingCursor        String?                 @map("paging_cursor") @db.VarChar(256)
  // Progress
  contactsFetched     Int                     @default(0) @map("contacts_fetched")
  contactsUpserted    Int                     @default(0) @map("contacts_upserted")
  contactsSkipped     Int                     @default(0) @map("contacts_skipped")
  contactsFailed      Int                     @default(0) @map("contacts_failed")
  errorSummary        Json?                   @map("error_summary")
  // Timing
  startedAt           DateTime                @default(now()) @map("started_at") @db.DateTime(6)
  completedAt         DateTime?               @map("completed_at") @db.DateTime(6)
  createdAt           DateTime                @default(now()) @map("created_at") @db.DateTime(6)
  updatedAt           DateTime                @updatedAt @map("updated_at") @db.DateTime(6)

  integration HubspotIntegration @relation(fields: [integrationId], references: [id], onDelete: Cascade, map: "fk_hs_sync_job_integration")

  @@index([tenantId, startedAt(sort: Desc)], map: "idx_hs_sync_job_tenant_started")
  @@index([integrationId, status], map: "idx_hs_sync_job_integration_status")
  @@map("hubspot_sync_jobs")
}
```

Design notes:
- `pagingCursor` persists the HubSpot `after` paging token between pages/retries, enabling crash-resume without re-fetching already-processed pages.
- `errorSummary` stores up to 50 sample error records (phone parse failures, API errors) as `[{ hs_object_id, error }]`.
- Rows are pruned by a nightly cleanup job: keep last 100 rows per `integration_id` (same pattern as N01 notification retention).

### 2.4 `lead_external_refs` Table

```prisma
model LeadExternalRef {
  id           BigInt    @id @default(autoincrement())
  tenantId     BigInt    @map("tenant_id")
  leadId       BigInt    @map("lead_id")
  source       String    @db.VarChar(32)      // 'hubspot', 'salesforce', 'csv', etc.
  externalId   String    @map("external_id") @db.VarChar(128)
  syncWarnings Json?     @map("sync_warnings")  // [{ field, message }]
  lastSyncedAt DateTime? @map("last_synced_at") @db.DateTime(6)
  createdAt    DateTime  @default(now()) @map("created_at") @db.DateTime(6)
  updatedAt    DateTime  @updatedAt @map("updated_at") @db.DateTime(6)

  lead   Lead   @relation(fields: [leadId], references: [id], onDelete: Cascade, map: "fk_ler_lead")
  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Restrict, map: "fk_ler_tenant")

  @@unique([tenantId, source, externalId], map: "uk_ler_tenant_source_ext")
  @@index([tenantId, leadId], map: "idx_ler_tenant_lead")
  @@map("lead_external_refs")
}
```

Design notes:
- `source` is a `VARCHAR(32)` (not an enum) for extensibility — future integrations add no migration.
- Unique on `(tenant_id, source, external_id)` — the deduplication key used by the sync upsert.
- `syncWarnings` holds non-fatal issues (e.g., phone normalization fallback) without blocking the sync.
- The `Lead` model gains a `externalRefs LeadExternalRef[]` relation (additive amendment to schema.prisma).
- The `Tenant` model gains a `leadExternalRefs LeadExternalRef[]` relation.

### 2.5 Schema Amendments to Existing Models

The migration adds FK relations to existing models. No existing columns are dropped or modified.

**`Lead` model additions:**
```prisma
externalRefs LeadExternalRef[]
```

**`Tenant` model additions:**
```prisma
hubspotIntegration HubspotIntegration?
leadExternalRefs   LeadExternalRef[]
```

**`List` model additions:**
No column additions. HubSpot list metadata stored in existing `lists.meta JSON` column (if present) or added as `meta JSON?` column. Check existing schema first; if `meta` column doesn't exist, migration adds it.

---

## 3. API Endpoints

All endpoints are under `/api/admin/integrations/hubspot` unless noted. All require `requirePermission('integration:hs:configure')` except the widget token and the public webhook endpoint.

### 3.1 OAuth Flow

#### `GET /api/admin/integrations/hubspot/oauth/start`

Initiates the OAuth authorization code flow.

**Auth:** `requirePermission('integration:hs:configure')`

**Query:** none required (tenant determined from JWT).

**Response:** `302 Redirect` to HubSpot authorization URL.

**Logic:**
1. Generate `state` = HMAC-signed JWT: `{ tenant_id, nonce: crypto.randomBytes(16).hex(), exp: now+10min }`.
2. Store `state` in Valkey: `SET hs:oauth:state:{nonce} {state} EX 600`.
3. Build HubSpot auth URL with required + optional scopes.
4. Redirect.

**Scopes in URL:**
```
scope=crm.objects.contacts.read crm.lists.read timeline oauth calling
optional_scope=crm.objects.companies.read crm.objects.deals.read crm.objects.owners.read
```

#### `GET /api/admin/integrations/hubspot/oauth/callback`

Handles HubSpot redirect after user authorization.

**Auth:** None (public redirect target). CSRF protected by `state` verification.

**Query:** `?code={AUTH_CODE}&state={STATE}`

**Logic:**
1. Decode `state` JWT; verify signature and `exp`.
2. Fetch Valkey key `hs:oauth:state:{nonce}`; compare; delete on match.
3. POST to `https://api.hubapi.com/oauth/v1/token` with `code`.
4. GET `https://api.hubapi.com/oauth/v1/access-tokens/{access_token}` to resolve `hub_id` and `hub_domain`.
5. Check `portal_id` uniqueness across all tenants (OQ-6 guard).
6. Upsert `hubspot_integrations` row with encrypted tokens.
7. Enqueue initial full sync: `vici2:queue:hubspot-sync` with `{ tenant_id, mode: 'FULL' }`.
8. Audit: `hs_integration.connected`.
9. Redirect to admin UI: `/admin/integrations/hubspot?status=connected`.

**Error path:** redirect to `/admin/integrations/hubspot?status=error&reason={CODE}`.

#### `DELETE /api/admin/integrations/hubspot`

Disconnects the integration.

**Auth:** `requirePermission('integration:hs:configure')`

**Logic:**
1. Soft-delete `hubspot_integrations` (set `deleted_at`, zero out encrypted token bytes, set `status = 'disconnected'`).
2. Cancel repeatable BullMQ sync job: `queue.removeRepeatableByKey(key)`.
3. Audit: `hs_integration.disconnected`.

**Response:** `204 No Content`.

### 3.2 Integration Status

#### `GET /api/admin/integrations/hubspot`

Returns the current integration status.

**Auth:** `requirePermission('integration:hs:configure')`

**Response:**
```json
{
  "connected": true,
  "portalId": 98765,
  "hubDomain": "mycompany.hubspot.com",
  "status": "connected",
  "syncMode": "ALL_CONTACTS",
  "syncIntervalMinutes": 15,
  "lastSyncAt": "2026-05-13T20:55:00Z",
  "lastSyncCursor": "2026-05-13T20:55:00Z",
  "includeRecordingUrl": true,
  "syncOverwritesManual": false,
  "tokenExpiresAt": "2026-05-13T21:25:00Z",
  "recentJobs": [ /* last 5 HubspotSyncJob rows */ ]
}
```

Tokens are NOT returned. `tokenExpiresAt` is informational only.

#### `PATCH /api/admin/integrations/hubspot`

Updates sync configuration (not tokens).

**Auth:** `requirePermission('integration:hs:configure')`

**Body:**
```json
{
  "syncIntervalMinutes": 30,
  "syncMode": "ALL_CONTACTS",
  "includeRecordingUrl": false,
  "syncOverwritesManual": false,
  "statusMap": { "SALE": "COMPLETED", "NA": "NO_ANSWER" },
  "dispositionMap": { "SALE": "COMPLETED" }
}
```

**Validation:** `syncIntervalMinutes` must be `>= 5 && <= 1440`.

**Response:** Updated integration object (same shape as GET, minus tokens).

### 3.3 Sync Management

#### `POST /api/admin/integrations/hubspot/sync`

Triggers a manual full sync immediately (skips cursor, fetches all contacts).

**Auth:** `requirePermission('integration:hs:configure')`

**Body:** `{ "mode": "FULL" | "INCREMENTAL" }`

**Response:** `202 Accepted` with `{ "jobId": "bullmq-job-id", "syncJobId": 123 }`.

#### `GET /api/admin/integrations/hubspot/sync/jobs`

Returns sync job history.

**Auth:** `requirePermission('integration:hs:configure')`

**Query:** `?limit=20&offset=0`

**Response:** Array of `HubspotSyncJob` rows (no sensitive data).

#### `GET /api/admin/integrations/hubspot/sync/jobs/:id`

Returns details for a specific sync job including `errorSummary`.

### 3.4 HubSpot List Import

#### `GET /api/admin/integrations/hubspot/lists`

Fetches available HubSpot contact lists from the connected portal (live API call, not cached).

**Auth:** `requirePermission('integration:hs:configure')`

**Response:**
```json
{
  "lists": [
    { "listId": "1234", "name": "Q2 Prospects", "size": 450, "type": "DYNAMIC" },
    ...
  ]
}
```

#### `POST /api/admin/integrations/hubspot/lists/:listId/import`

Imports a HubSpot list as a vici2 lead list.

**Auth:** `requirePermission('integration:hs:configure')`

**Body:**
```json
{
  "vici2ListName": "Q2 Prospects (HubSpot)",
  "campaignId": 42,
  "syncOngoing": true
}
```

`syncOngoing: true` means the list is re-synced on every contact sync cycle (for DYNAMIC lists). `syncOngoing: false` imports once.

**Response:** `202 Accepted` with `{ "listId": 99, "bullmqJobId": "..." }`.

### 3.5 Widget Token

#### `POST /api/admin/integrations/hubspot/widget-token`

Issues a short-lived iframe session token.

**Auth:** `requirePermission('integration:hs:click_to_dial')`

**Response:**
```json
{
  "token": "eyJ...",
  "url": "https://api.example.com/hubspot-calling?tid=1&token=eyJ...",
  "expiresIn": 3600
}
```

Token payload: `{ tenant_id, user_id, iat, exp: iat+3600, aud: 'hs-widget' }`. Signed with `JWT_SECRET`.

### 3.6 Public Inbound Webhook

#### `POST /api/webhooks/hubspot`

Receives HubSpot event batches.

**Auth:** None. HMAC signature validation replaces auth.

**Headers:**
- `X-HubSpot-Signature`: `SHA256(client_secret + raw_body)`
- `X-HubSpot-Signature-Version`: `v1`

**Logic:**
1. Read raw body bytes (before JSON parse — body-parser must be bypassed on this route; use raw body middleware).
2. Compute HMAC; compare with header. Return `403` on mismatch.
3. Dispatch on `portalId` → find `hubspot_integrations` row (index on `portal_id`).
4. Enqueue to `vici2:queue:hubspot-webhook` with `{ tenant_id, events: [...] }`.
5. Return `200 {}`.

---

## 4. BullMQ Workers

### 4.1 Queue Topology Addition to W01

Three new queues added to the W01 BullMQ topology declaration:

```typescript
// workers/src/queues.ts additions
export const HUBSPOT_SYNC_QUEUE    = 'vici2:queue:hubspot-sync';
export const HUBSPOT_PUSH_QUEUE    = 'vici2:queue:hubspot-push';
export const HUBSPOT_WEBHOOK_QUEUE = 'vici2:queue:hubspot-webhook';
```

### 4.2 `hubspot-sync` Worker

**File:** `workers/src/jobs/hubspot-sync/index.ts`

**Concurrency:** 2 (allows two tenants to sync simultaneously; bounded by HubSpot's rate limits per-token, not shared).

**Job data:**
```typescript
interface HubspotSyncJobData {
  tenantId: number;
  mode: 'FULL' | 'INCREMENTAL';
  syncJobId: number;       // DB row ID
  pagingCursor?: string;   // resume cursor on retry
}
```

**Algorithm:**

```
1. Fetch hubspot_integrations for tenant (decrypt tokens)
2. Check rate_limit_backoff_until; if future, skip and reschedule
3. Proactively refresh token if tokenExpiresAt < now + 5min
4. Determine filter:
   - FULL: no lastmodifieddate filter
   - INCREMENTAL: lastmodifieddate >= lastSyncCursor (or epoch if cursor is null)
5. Loop:
   a. POST /crm/v3/objects/contacts/search
      { filterGroups, sorts: [lastmodifieddate ASC], limit: 100, after: pagingCursor }
   b. For each contact in results.results:
      i.  Normalize phone via libphonenumber-js
      ii. Look up lead_external_refs (tenant_id, source='hubspot', external_id=hs_object_id)
      iii. If found: update leads row (respect syncOverwritesManual flag)
           If not found: check leads.phone for fuzzy match (if policy = 'fuzzy')
           If still not found: INSERT leads + lead_external_refs
      iv. Update lead_external_refs.last_synced_at
   c. Check paging.next.after; update hubspot_sync_jobs.paging_cursor
   d. Check X-HubSpot-RateLimit-Daily-Remaining header
   e. If results.results.length < 100: done
   f. Throttle: sleep max(0, 100ms - elapsed) to stay under 10req/10s burst
6. On completion:
   - Update hubspot_integrations.last_sync_cursor = max(lastmodifieddate seen)
   - Update hubspot_integrations.last_sync_at = now()
   - Update hubspot_sync_jobs: status='completed', counts, completedAt
   - Audit: hs_integration.sync_completed
7. On error:
   - Update hubspot_sync_jobs: status='failed', error_summary
   - If consecutive failures >= 3: notify() integration_error
   - Audit: hs_integration.sync_failed
```

**Repeatable job registration:**
```typescript
await hubspotSyncQueue.add(
  'hubspot-sync',
  { tenantId, mode: 'INCREMENTAL', syncJobId },
  {
    repeat: { every: integration.syncIntervalMinutes * 60 * 1000 },
    jobId: `hs-sync-${tenantId}`,   // stable key for removeRepeatableByKey
  }
);
```

### 4.3 `hubspot-push` Worker

**File:** `workers/src/jobs/hubspot-push/index.ts`

**Concurrency:** 10 (bounded per-tenant in job data; actual HubSpot calls are serial per call).

**Job data:**
```typescript
interface HubspotPushJobData {
  tenantId: number;
  callId: string;             // vici2 call UUID
  leadId: number;
  hsObjectId: string;         // from lead_external_refs
  disposition: string;        // vici2 dispo code
  durationMs: number;
  fromNumber: string;         // E.164
  toNumber: string;           // E.164
  recordingUrl?: string;      // from R02, if available
  startedAt: string;          // ISO 8601
  preCreatedEngagementId?: string;  // from SDK pre-create flow
}
```

**Algorithm:**

```
1. Fetch hubspot_integrations for tenant (decrypt access token)
2. Refresh token if needed
3. Resolve hs_call_status from disposition using dispositionMap + fallback table
4. If preCreatedEngagementId:
   PATCH /crm/v3/objects/calls/{preCreatedEngagementId}
   with { properties: { hs_call_status, hs_call_duration, hs_call_body, hs_call_recording_url } }
5. Else:
   POST /crm/v3/objects/calls
   with full engagement payload including associations to hsObjectId
6. On success: audit hs_integration.engagement_pushed
7. On failure (after 5 retries): audit hs_integration.engagement_failed; no N01 notification
   (engagement failures are low-severity; noise if alerted on every call)
```

**Trigger:** The call dispo handler (`api/src/routes/calls/dispo.ts` or equivalent) enqueues to `hubspot-push` immediately after saving the dispo to MySQL — conditional on `lead_external_refs` row existing with `source='hubspot'`.

### 4.4 `hubspot-webhook` Worker

**File:** `workers/src/jobs/hubspot-webhook/index.ts`

**Concurrency:** 5.

**Job data:**
```typescript
interface HubspotWebhookJobData {
  tenantId: number;
  events: HubspotWebhookEvent[];
}

interface HubspotWebhookEvent {
  eventId: number;
  subscriptionId: number;
  portalId: number;
  objectId: number;          // hs_object_id
  eventType: string;         // 'contact.propertyChange'
  propertyName?: string;
  propertyValue?: string;
  occurredAt: number;        // epoch ms
}
```

**Algorithm:**

```
1. Group events by objectId (contact)
2. For each unique contact:
   a. Find lead_external_refs row (tenant_id, source='hubspot', external_id=objectId)
   b. If found: enqueue targeted incremental sync for this contact:
      POST /crm/v3/objects/contacts/{objectId} with explicit property fetch
      Apply sync logic (same upsert as hubspot-sync worker)
   c. If not found: ignore (contact not imported into this tenant)
3. No audit entry (high-frequency event; logged at sync_completed level instead)
```

---

## 5. Calling Widget

### 5.1 Next.js Page

**File:** `web/app/(public)/hubspot-calling/page.tsx`

This page is outside the `(admin)` route group — it is publicly accessible (HubSpot loads it as an iframe). It must not redirect to login. Token authentication is via the `?token=` query parameter.

**Route:** `/hubspot-calling?tid={tenant_id}&token={JWT}`

**Page behavior:**
1. Read `tid` and `token` from `useSearchParams()`.
2. Call `/api/admin/integrations/hubspot/widget-token/validate` (or decode client-side — JWT is signed, not encrypted).
3. If valid: render the calling UI shell (softphone-lite).
4. If invalid: render error state ("Session expired. Please reconnect.").

### 5.2 Calling Extensions SDK Adapter

**File:** `web/lib/hubspot-calling-adapter.ts`

```typescript
import CallingExtensions from '@hubspot/calling-extensions-sdk';

export function createHubspotCallingAdapter(opts: {
  tenantId: number;
  userId: number;
  onDialNumber: (phoneNumber: string, objectId: string) => void;
  onEndCall: () => void;
}) {
  const extensions = new CallingExtensions({
    debugMode: process.env.NODE_ENV === 'development',
    eventHandlers: {
      onReady: () => extensions.initialized({ isLoggedIn: true }),
      onDialNumber: ({ phoneNumber, objectId }) =>
        opts.onDialNumber(phoneNumber, String(objectId)),
      onEndCall: opts.onEndCall,
      onCreateEngagementSucceeded: ({ engagementId }) => {
        // store engagementId in call state
      },
      onCreateEngagementFailed: () => {
        // will fall back to POST-call engagement creation
      },
      onVisibilityChanged: ({ isMinimized }) => {
        // adjust UI layout
      },
    },
  });
  return extensions;
}
```

### 5.3 Click-to-Call Flow (Detailed)

```
1. HubSpot: onDialNumber({ phoneNumber: '+15551234567', objectId: '1234' })
2. Adapter calls onDialNumber callback
3. Page calls POST /api/calls/external-dial:
   {
     "phone": "+15551234567",
     "hs_object_id": "1234",
     "source": "hubspot_widget",
     "tenant_id": X
   }
4. API handler:
   a. Validates Integration:hs:click_to_dial permission
   b. Looks up lead via lead_external_refs OR creates a provisional lead row
   c. Calls existing call:dial flow (FreeSWITCH originate)
   d. Returns { callId: 'uuid', leadId: 99 }
5. Widget receives callId; calls:
   extensions.outgoingCall({
     phoneNumber: '+15551234567',
     createEngagement: true,
     fromNumber: agentDid
   })
6. HubSpot fires onCreateEngagementSucceeded({ engagementId: 'hs-eng-123' })
7. Widget stores engagementId in WS call session via:
   POST /api/calls/{callId}/metadata { "hs_engagement_id": "hs-eng-123" }
8. Call concludes; agent sets dispo
9. Dispo handler enqueues hubspot-push job with preCreatedEngagementId
```

### 5.4 Widget Static JS File (Alternative Delivery)

If the HubSpot app registration requires a static URL (not a Next.js page), the adapter is also buildable as:

**File:** `api/src/routes/static/hubspot-calling.ts`

A Fastify route that serves a pre-built `hubspot-calling.min.js` bundle from `api/src/static/`. The bundle is a self-contained React+SDK application. This alternative is for environments where the Next.js frontend is not co-deployed with the API. Phase 1 uses the Next.js page (simpler); the static bundle is Phase 2.

---

## 6. Admin UI

### 6.1 Integration Settings Page

**File:** `web/app/(admin)/integrations/hubspot/page.tsx`

**Access:** `requirePermission('integration:hs:configure')`

**Sections:**

#### Connection Status Card
- If disconnected: "Connect HubSpot" button → `GET /api/admin/integrations/hubspot/oauth/start`.
- If connected: green badge "Connected to {hubDomain}" + "Disconnect" danger button.
- Error state: red badge "Connection Error" + "Reconnect" button.

#### Sync Configuration Card
- Sync mode: radio ("All Contacts" / "List Members Only").
- Sync interval: number input (5–1440 minutes).
- Overwrite manual edits: toggle (default off).
- Include recording URL: toggle (default on).
- Save button: `PATCH /api/admin/integrations/hubspot`.

#### Status Mapping Card
- Table of vici2 disposition codes → HubSpot call status.
- Editable dropdowns per row.
- Saves to `dispositionMap` JSON.

#### HubSpot List Import Card
- Visible only when `syncMode = 'LIST_ONLY'`.
- Dropdown: fetches available lists via `GET .../hubspot/lists`.
- Import button: `POST .../hubspot/lists/:listId/import`.
- Shows imported lists with member count and ongoing-sync badge.

#### Sync History Card
- Table: last 10 sync jobs with status badge, contact counts, duration, started at.
- "Sync Now" button: `POST .../hubspot/sync { mode: 'INCREMENTAL' }`.
- "Full Resync" button (with confirmation): `POST .../hubspot/sync { mode: 'FULL' }`.

### 6.2 Navigation Integration

The `integrations/hubspot` page is linked from `(admin)/integrations/page.tsx` (the integrations hub). A `HubSpotIcon` from `lucide-react` (or a branded SVG) appears on the integrations overview card.

### 6.3 Component Files

```
web/app/(admin)/integrations/hubspot/
  page.tsx                          — main settings page
  components/
    ConnectionCard.tsx
    SyncConfigCard.tsx
    StatusMappingCard.tsx
    ListImportCard.tsx
    SyncHistoryCard.tsx
    ConnectButton.tsx
```

---

## 7. RBAC

### 7.1 New Verbs (Additive)

Two new verbs are added to `shared/types/src/rbac.ts`:

```typescript
// HubSpot integration (N04)
'integration:hs:configure',    // connect/disconnect, sync settings, list import
'integration:hs:click_to_dial', // widget token issuance, click-to-call
```

Added to the `VERBS` constant and to the role matrix:

| Verb | super_admin | admin | supervisor | agent | viewer | integrator |
|---|---|---|---|---|---|---|
| `integration:hs:configure` | tenant | tenant | — | — | — | — |
| `integration:hs:click_to_dial` | tenant | tenant | tenant | tenant | — | — |

`integration:hs:configure` is admin-only (configuring OAuth credentials and sync settings is a privileged operation). `integration:hs:click_to_dial` is granted to agents and above so the calling widget token can be issued for any logged-in agent.

Neither verb is marked `sensitive` (no GDPR/PCI data in the permission check itself).

### 7.2 RBAC File Patch Location

Additions go in `shared/types/src/rbac.ts` under the comment `// HubSpot integration (N04)` in the `VERBS` array, and in each role's `RAW_MATRIX` entry.

---

## 8. Audit Actions

All audit entries use C03 `AuditWriter` with the schema `audit_log(tenant_id, user_id, action, entity_type, entity_id, detail JSON, ...)`.

| Audit Action | Entity Type | Detail Fields |
|---|---|---|
| `hs_integration.connected` | `hubspot_integration` | `portal_id`, `hub_domain` |
| `hs_integration.disconnected` | `hubspot_integration` | `portal_id` |
| `hs_integration.token_refreshed` | `hubspot_integration` | `portal_id`, `kek_version` |
| `hs_integration.settings_updated` | `hubspot_integration` | diff of changed fields |
| `hs_integration.sync_started` | `hubspot_sync_job` | `sync_job_id`, `mode` |
| `hs_integration.sync_completed` | `hubspot_sync_job` | `sync_job_id`, `contacts_upserted`, `duration_ms` |
| `hs_integration.sync_failed` | `hubspot_sync_job` | `sync_job_id`, `error_count`, `last_error` |
| `hs_integration.engagement_pushed` | `hubspot_integration` | `call_id`, `hs_engagement_id`, `disposition` |
| `hs_integration.engagement_failed` | `hubspot_integration` | `call_id`, `error_message` |
| `hs_integration.list_imported` | `list` | `hs_list_id`, `vici2_list_id`, `member_count` |

Token values are never included in audit detail. `portal_id` (a public identifier) is safe to audit.

---

## 9. Environment Variables

New env vars required for N04 deployment:

| Variable | Required | Description |
|---|---|---|
| `HUBSPOT_CLIENT_ID` | Yes | Public app client ID from HubSpot developer portal |
| `HUBSPOT_CLIENT_SECRET` | Yes | App client secret (never in DB or code) |
| `HUBSPOT_REDIRECT_URI` | Yes | OAuth callback URL (must match app registration exactly) |
| `HUBSPOT_APP_TOKEN` | Yes | Developer app token for webhook subscription management |

Added to `.env.example` with placeholder values. Validated at startup via `env.ts` (Zod schema); server refuses to start if any is missing.

---

## 10. File Layout

```
api/src/integrations/hubspot/
  oauth.ts                      # OAuth flow: start, callback, token exchange, refresh
  sync-contacts.ts              # Contact fetch, normalize, upsert logic (pure; no BullMQ)
  push-activity.ts              # Engagement creation/update via HubSpot v3 calls API
  webhook-verify.ts             # HMAC signature verification helper
  hubspot-client.ts             # Axios instance with retry, rate-limit tracking, token inject
  property-map.ts               # Disposition → hs_call_status mapping table + JSON override
  list-import.ts                # HubSpot list fetch and member import logic

api/src/routes/admin/integrations/hubspot/
  index.ts                      # Route registration (mountpoint)
  get-status.ts                 # GET /api/admin/integrations/hubspot
  patch-settings.ts             # PATCH /api/admin/integrations/hubspot
  oauth-start.ts                # GET /oauth/start
  oauth-callback.ts             # GET /oauth/callback
  delete-integration.ts         # DELETE /api/admin/integrations/hubspot
  post-sync.ts                  # POST /sync
  get-sync-jobs.ts              # GET /sync/jobs
  get-sync-job.ts               # GET /sync/jobs/:id
  get-lists.ts                  # GET /lists
  post-import-list.ts           # POST /lists/:listId/import
  widget-token.ts               # POST /widget-token

api/src/routes/webhooks/
  hubspot.ts                    # POST /api/webhooks/hubspot (public, HMAC verified)

workers/src/jobs/
  hubspot-sync/index.ts         # BullMQ worker: contact pull
  hubspot-push/index.ts         # BullMQ worker: engagement write-back
  hubspot-webhook/index.ts      # BullMQ worker: inbound webhook events

web/app/(admin)/integrations/hubspot/
  page.tsx
  components/
    ConnectionCard.tsx
    SyncConfigCard.tsx
    StatusMappingCard.tsx
    ListImportCard.tsx
    SyncHistoryCard.tsx
    ConnectButton.tsx

web/app/(public)/hubspot-calling/
  page.tsx                      # Widget iframe target (outside admin auth boundary)

web/lib/
  hubspot-calling-adapter.ts    # CallingExtensions SDK wrapper

api/prisma/migrations/
  20260513310000_n04_hubspot/migration.sql

shared/types/src/
  rbac.ts                       # (amended) +2 verbs, +role matrix rows
```

**Estimated LOC:**

| Area | LOC estimate |
|---|---|
| Prisma migration SQL | ~60 |
| OAuth + HubSpot client | ~200 |
| Sync-contacts worker | ~250 |
| Push-activity worker | ~150 |
| Webhook worker | ~100 |
| API routes (11 files) | ~200 |
| Public webhook endpoint | ~60 |
| Admin UI (6 components + page) | ~200 |
| Widget page + adapter | ~80 |
| RBAC amendment | ~20 |
| Tests (unit + integration) | ~200 |
| **Total** | **~1,520** |

Target LOC ~1,100 (excluding tests). Test coverage is mandatory but test files are excluded from the implementation LOC target per project convention.

---

## 11. Testing Plan

### 11.1 Unit Tests

**File:** `api/test/integrations/hubspot/`

- `oauth.test.ts` — state JWT generation and validation; token encryption round-trip; `portal_id` uniqueness guard.
- `sync-contacts.test.ts` — phone normalization (valid, invalid, national); deduplication (exact match, fuzzy match, no match); `syncOverwritesManual` behavior.
- `push-activity.test.ts` — disposition mapping (default + override); engagement payload construction; PATCH vs POST logic.
- `webhook-verify.test.ts` — HMAC valid, tampered body, wrong secret.
- `property-map.test.ts` — all dispo codes map to valid `hs_call_status` values.

### 11.2 Integration Tests

**File:** `api/test/integrations/hubspot/integration.test.ts`

Uses `nock` (HTTP interceptor) to mock HubSpot API responses:
- Full OAuth flow: start → HubSpot mock → callback → token stored.
- Incremental sync: 3 pages of contacts (300 contacts total) → 300 leads in DB.
- Engagement push: dispo SALE → PATCH mock → audit entry created.
- Rate limit: 429 response → retry with backoff → eventual success.
- Token refresh: expired token → auto-refresh → retry original call.

### 11.3 E2E Test (Manual in Dev Environment)

1. Spin up HubSpot developer sandbox.
2. Register test app with `http://localhost:3001` redirect URI.
3. Connect via OAuth flow in admin UI.
4. Trigger manual sync; verify leads appear in vici2.
5. Open HubSpot contact; click phone icon; verify widget loads.
6. Simulate a call; disposition; verify engagement in HubSpot timeline.

---

## 12. Error Handling Matrix

| Error Condition | Detection | Response |
|---|---|---|
| OAuth state mismatch | Valkey key missing or HMAC invalid | Redirect to `/integrations/hubspot?status=error&reason=csrf` |
| Token exchange failure | Non-200 from HubSpot token endpoint | Redirect with `reason=token_exchange_failed`; audit |
| Portal already connected to another tenant | `portal_id` found in another tenant's row | Redirect with `reason=portal_in_use`; no audit (security) |
| Token refresh failure (401) | POST returns 401 | Set `status='error'`; `notify()` `integration_error`; pause sync |
| Sync rate limit exhausted | `Daily-Remaining < 1000` | Set `rate_limit_backoff_until = now+1h`; skip cycle |
| Contact phone parse failure | `libphonenumber-js` throws | Store raw phone; add to `syncWarnings`; continue sync |
| Engagement push fails after 5 retries | BullMQ DLQ | Audit `engagement_failed`; no admin alert (low severity) |
| Webhook HMAC invalid | Computed hash !== header | Return `403`; no processing; no audit (anti-noise) |
| Widget token expired | JWT `exp` check | Return `401`; widget shows "Session expired" |
| HubSpot API 503 | HTTP response status | Retry with exponential backoff; up to 5 attempts |

---

## 13. Dependency Version Pinning

New npm dependencies added by N04:

| Package | Version | Purpose |
|---|---|---|
| `@hubspot/calling-extensions-sdk` | `^1.4.0` | Calling SDK for widget iframe |
| `axios` | already in monorepo | HTTP client for HubSpot API calls |
| `libphonenumber-js` | already in monorepo | Phone normalization |

No new backend dependencies beyond `axios` (already present) and the Calling SDK (frontend-only, in `web/package.json`).

---

## 14. Frozen Contracts

The following are FROZEN once the implementation agent begins work:

| Item | Value |
|---|---|
| Prisma model: integration | `HubspotIntegration` → `hubspot_integrations` |
| Prisma model: sync job | `HubspotSyncJob` → `hubspot_sync_jobs` |
| Prisma model: ext ref | `LeadExternalRef` → `lead_external_refs` |
| BullMQ queue: sync | `vici2:queue:hubspot-sync` |
| BullMQ queue: push | `vici2:queue:hubspot-push` |
| BullMQ queue: webhook | `vici2:queue:hubspot-webhook` |
| OAuth start route | `GET /api/admin/integrations/hubspot/oauth/start` |
| OAuth callback route | `GET /api/admin/integrations/hubspot/oauth/callback` |
| Public webhook route | `POST /api/webhooks/hubspot` |
| Widget path | `/hubspot-calling` |
| Widget token route | `POST /api/admin/integrations/hubspot/widget-token` |
| RBAC verb: configure | `integration:hs:configure` |
| RBAC verb: click_to_dial | `integration:hs:click_to_dial` |
| Audit action prefix | `hs_integration.*` |
| Migration timestamp | `20260513310000` |

---

*Plan complete. Implementation may begin after PLAN.md review.*
