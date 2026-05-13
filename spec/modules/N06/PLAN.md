# Module N06 — FCC Reassigned Numbers DB Scrub — PLAN

| Field | Value |
|---|---|
| Module | N06 |
| Phase | 4 |
| Effort estimate | 4–5 days |
| LOC estimate | ~800 lines |
| Owner agent type | backend-node |
| Depends on | D05 (DNC table + service), E01 (hopper filter), D03 (phone normalization), C04 (retention) |
| Migration timestamp | 20260513290000 |

---

## 1. Overview and Goals

N06 integrates vici2 with the FCC Reassigned Numbers Database (reassigned.us) to provide TCPA §64.1200(f)(13) safe-harbor protection. The module:

1. Queries the RND (via REST API for ≤50K phones; SFTP file upload for larger batches) with E.164-normalized phone numbers and per-lead consent dates.
2. Stores all query results in `rnd_lookup_log` for 5-year audit retention.
3. Inserts `source='reassigned'` entries into the existing `dnc` table when the RND returns `Yes`.
4. Propagates to E01 hopper (via D05's existing DNC check — no code change needed in E01).
5. Provides REST endpoints for admins to trigger scrubs, check progress, review cost, and manage tenant-level RND credentials.
6. Emits structured audit events for every scrub and every number flagged.

### 1.1 What Is Not In Scope

- At-dial-time real-time RND check (T04 integration) — future phase
- RND data for international numbers — US NANP only
- State-level reassignment databases — US federal RND only
- Automatic lead deletion on `Yes` result — only DNC insertion; deletion is a separate admin action

---

## 2. Database Schema

### 2.1 New Tables

#### 2.1.1 `tenant_rnd_config` — Per-Tenant RND Credentials

Stores OAuth client credentials for each tenant's RND subscription. Credentials are stored encrypted using the KEK pattern established in F05.

```sql
CREATE TABLE tenant_rnd_config (
  tenant_id         BIGINT       NOT NULL,
  client_id         VARCHAR(255) NOT NULL,
  client_secret_enc VARBINARY(512) NOT NULL,    -- AES-256-GCM encrypted, KEK from F05
  client_secret_iv  VARBINARY(16)  NOT NULL,    -- GCM nonce
  tier              ENUM('xs','small','medium','large','xl','jumbo') NOT NULL DEFAULT 'xs',
  monthly_budget_cents INT         NULL,         -- NULL = uncapped
  auto_scrub_on_launch TINYINT(1)  NOT NULL DEFAULT 1,
  rescrub_interval_days TINYINT    NOT NULL DEFAULT 55,
  no_data_policy    ENUM('safe','block')         NOT NULL DEFAULT 'safe',
  use_reassigned_dnc TINYINT(1)   NOT NULL DEFAULT 1,
  is_active         TINYINT(1)   NOT NULL DEFAULT 0,  -- must explicitly activate after setup
  created_at        DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at        DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),

  PRIMARY KEY (tenant_id),
  CONSTRAINT fk_tenant_rnd_config_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants (id)
    ON DELETE RESTRICT ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

#### 2.1.2 `rnd_scrub_job` — Scrub Job Tracking

One row per scrub invocation. Tracks progress across BullMQ retries.

```sql
CREATE TABLE rnd_scrub_job (
  id                CHAR(26)     NOT NULL,        -- ULID
  tenant_id         BIGINT       NOT NULL,
  campaign_id       VARCHAR(32)  NOT NULL,
  triggered_by      BIGINT       NULL,            -- user_id; NULL = auto-triggered
  trigger_reason    ENUM('manual','auto_launch','scheduled_rescrub') NOT NULL,
  status            ENUM('queued','running','completed','failed','paused_budget') NOT NULL DEFAULT 'queued',
  total_phones      INT          NOT NULL DEFAULT 0,
  phones_queried    INT          NOT NULL DEFAULT 0,
  phones_yes        INT          NOT NULL DEFAULT 0,  -- reassigned
  phones_no         INT          NOT NULL DEFAULT 0,  -- safe
  phones_no_data    INT          NOT NULL DEFAULT 0,
  phones_error      INT          NOT NULL DEFAULT 0,
  estimated_cost_cents INT       NOT NULL DEFAULT 0,
  actual_cost_cents INT          NOT NULL DEFAULT 0,
  upload_id         VARCHAR(255) NULL,            -- RND SFTP upload ID (for file-upload mode)
  query_mode        ENUM('api','sftp') NOT NULL DEFAULT 'api',
  started_at        DATETIME(6)  NULL,
  completed_at      DATETIME(6)  NULL,
  error_message     TEXT         NULL,
  created_at        DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at        DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),

  PRIMARY KEY (id),
  INDEX idx_rnd_scrub_job_tenant_campaign (tenant_id, campaign_id),
  INDEX idx_rnd_scrub_job_status (status, created_at),
  CONSTRAINT fk_rnd_scrub_job_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants (id)
    ON DELETE RESTRICT ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

#### 2.1.3 `rnd_lookup_log` — Per-Number Query Results (Partitioned)

Every RND query result is stored here for 5-year audit compliance. Partitioned by month, matching C04's pattern.

```sql
CREATE TABLE rnd_lookup_log (
  id                BIGINT       NOT NULL AUTO_INCREMENT,
  tenant_id         BIGINT       NOT NULL,
  scrub_job_id      CHAR(26)     NOT NULL,
  phone_e164        VARCHAR(16)  NOT NULL,
  consent_date      DATE         NOT NULL,         -- the "as-of" date sent to RND
  consent_date_src  ENUM('pewc','ebr','inferred','fallback') NOT NULL DEFAULT 'inferred',
  result            ENUM('yes','no','no_data','error') NOT NULL,
  disconnect_date   DATE         NULL,             -- populated when result='yes'
  queried_at        DATETIME(6)  NOT NULL,         -- timestamp from RND response
  lookup_date       DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),  -- when we queried
  dnc_inserted      TINYINT(1)   NOT NULL DEFAULT 0,  -- 1 if row was added to dnc table
  created_at        DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

  PRIMARY KEY (id, lookup_date),
  INDEX idx_rnd_log_tenant_phone (tenant_id, phone_e164, lookup_date),
  INDEX idx_rnd_log_job (scrub_job_id),
  INDEX idx_rnd_log_result (result, lookup_date),
  CONSTRAINT fk_rnd_log_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants (id)
    ON DELETE RESTRICT ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
PARTITION BY RANGE (UNIX_TIMESTAMP(lookup_date)) (
  PARTITION p2026_05 VALUES LESS THAN (UNIX_TIMESTAMP('2026-06-01')),
  PARTITION p2026_06 VALUES LESS THAN (UNIX_TIMESTAMP('2026-07-01')),
  PARTITION p2026_07 VALUES LESS THAN (UNIX_TIMESTAMP('2026-08-01')),
  PARTITION p_future  VALUES LESS THAN MAXVALUE
);
```

#### 2.1.4 `rnd_usage_log` — Monthly Cost Tracking

```sql
CREATE TABLE rnd_usage_log (
  id                INT          NOT NULL AUTO_INCREMENT,
  tenant_id         BIGINT       NOT NULL,
  period_year       SMALLINT     NOT NULL,
  period_month      TINYINT      NOT NULL,
  queries_count     INT          NOT NULL DEFAULT 0,
  estimated_cost_cents INT       NOT NULL DEFAULT 0,
  scrub_job_count   INT          NOT NULL DEFAULT 0,
  last_updated_at   DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),

  PRIMARY KEY (id),
  UNIQUE KEY uk_rnd_usage_tenant_period (tenant_id, period_year, period_month),
  CONSTRAINT fk_rnd_usage_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants (id)
    ON DELETE RESTRICT ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

### 2.2 Modified Tables

#### 2.2.1 `campaigns` — New RND Columns

```sql
ALTER TABLE campaigns
  ADD COLUMN rnd_auto_scrub      TINYINT(1)  NOT NULL DEFAULT 1    AFTER use_reassigned_dnc,
  ADD COLUMN rnd_last_scrub_at   DATETIME(6) NULL                  AFTER rnd_auto_scrub,
  ADD COLUMN rnd_last_scrub_id   CHAR(26)    NULL                  AFTER rnd_last_scrub_at,
  ADD COLUMN rnd_scrub_status    ENUM('never','pending','running','completed','failed','paused_budget')
                                              NOT NULL DEFAULT 'never' AFTER rnd_last_scrub_id,
  ADD COLUMN use_reassigned_dnc  TINYINT(1)  NOT NULL DEFAULT 1    COMMENT 'N06: exclude reassigned=Yes numbers from hopper';
```

### 2.3 Migration File

**Path**: `api/prisma/migrations/20260513290000_n06_rnd_scrub/migration.sql`

The migration creates all four new tables (`tenant_rnd_config`, `rnd_scrub_job`, `rnd_lookup_log`, `rnd_usage_log`) and alters `campaigns` with the new columns. It is additive-only; no DROP or ALTER of existing columns.

Migration is idempotent: all CREATE TABLE statements use `IF NOT EXISTS`; all ALTER TABLE statements check for column existence via information_schema.

---

## 3. Prisma Schema Additions

```prisma
// =============================================================================
// N06  rnd_config, rnd_scrub_job, rnd_lookup_log, rnd_usage_log
// =============================================================================

enum RndTier {
  xs
  small
  medium
  large
  xl
  jumbo
}

enum RndTriggerReason {
  manual
  auto_launch
  scheduled_rescrub
}

enum RndScrubStatus {
  queued
  running
  completed
  failed
  paused_budget
}

enum RndQueryMode {
  api
  sftp
}

enum RndResult {
  yes
  no
  no_data
  error
}

enum RndConsentDateSrc {
  pewc
  ebr
  inferred
  fallback
}

enum RndNoDataPolicy {
  safe
  block
}

model TenantRndConfig {
  tenantId             BigInt          @id @map("tenant_id")
  clientId             String          @map("client_id") @db.VarChar(255)
  clientSecretEnc      Bytes           @map("client_secret_enc") @db.VarBinary(512)
  clientSecretIv       Bytes           @map("client_secret_iv") @db.VarBinary(16)
  tier                 RndTier         @default(xs)
  monthlyBudgetCents   Int?            @map("monthly_budget_cents")
  autoScrubOnLaunch    Boolean         @default(true) @map("auto_scrub_on_launch")
  rescrubIntervalDays  Int             @default(55) @map("rescrub_interval_days") @db.TinyInt
  noDataPolicy         RndNoDataPolicy @default(safe) @map("no_data_policy")
  useReassignedDnc     Boolean         @default(true) @map("use_reassigned_dnc")
  isActive             Boolean         @default(false) @map("is_active")
  createdAt            DateTime        @default(now()) @map("created_at") @db.DateTime(6)
  updatedAt            DateTime        @updatedAt @map("updated_at") @db.DateTime(6)

  tenant   Tenant       @relation(fields: [tenantId], references: [id])
  scrubJobs RndScrubJob[]
  usageLogs RndUsageLog[]

  @@map("tenant_rnd_config")
}

model RndScrubJob {
  id                String          @id @db.Char(26)
  tenantId          BigInt          @map("tenant_id")
  campaignId        String          @map("campaign_id") @db.VarChar(32)
  triggeredBy       BigInt?         @map("triggered_by")
  triggerReason     RndTriggerReason @map("trigger_reason")
  status            RndScrubStatus  @default(queued)
  totalPhones       Int             @default(0) @map("total_phones")
  phonesQueried     Int             @default(0) @map("phones_queried")
  phonesYes         Int             @default(0) @map("phones_yes")
  phonesNo          Int             @default(0) @map("phones_no")
  phonesNoData      Int             @default(0) @map("phones_no_data")
  phonesError       Int             @default(0) @map("phones_error")
  estimatedCostCents Int            @default(0) @map("estimated_cost_cents")
  actualCostCents   Int             @default(0) @map("actual_cost_cents")
  uploadId          String?         @map("upload_id") @db.VarChar(255)
  queryMode         RndQueryMode    @default(api) @map("query_mode")
  startedAt         DateTime?       @map("started_at") @db.DateTime(6)
  completedAt       DateTime?       @map("completed_at") @db.DateTime(6)
  errorMessage      String?         @map("error_message") @db.Text
  createdAt         DateTime        @default(now()) @map("created_at") @db.DateTime(6)
  updatedAt         DateTime        @updatedAt @map("updated_at") @db.DateTime(6)

  tenant    Tenant         @relation(fields: [tenantId], references: [id])
  lookups   RndLookupLog[]

  @@index([tenantId, campaignId])
  @@index([status, createdAt])
  @@map("rnd_scrub_job")
}

model RndLookupLog {
  id              BigInt           @id @default(autoincrement())
  tenantId        BigInt           @map("tenant_id")
  scrubJobId      String           @map("scrub_job_id") @db.Char(26)
  phoneE164       String           @map("phone_e164") @db.VarChar(16)
  consentDate     DateTime         @map("consent_date") @db.Date
  consentDateSrc  RndConsentDateSrc @default(inferred) @map("consent_date_src")
  result          RndResult
  disconnectDate  DateTime?        @map("disconnect_date") @db.Date
  queriedAt       DateTime         @map("queried_at") @db.DateTime(6)
  lookupDate      DateTime         @default(now()) @map("lookup_date") @db.DateTime(6)
  dncInserted     Boolean          @default(false) @map("dnc_inserted")
  createdAt       DateTime         @default(now()) @map("created_at") @db.DateTime(6)

  tenant    Tenant      @relation(fields: [tenantId], references: [id])
  scrubJob  RndScrubJob @relation(fields: [scrubJobId], references: [id])

  @@index([tenantId, phoneE164, lookupDate])
  @@index([scrubJobId])
  @@index([result, lookupDate])
  @@map("rnd_lookup_log")
}

model RndUsageLog {
  id                 Int      @id @default(autoincrement())
  tenantId           BigInt   @map("tenant_id")
  periodYear         Int      @map("period_year") @db.SmallInt
  periodMonth        Int      @map("period_month") @db.TinyInt
  queriesCount       Int      @default(0) @map("queries_count")
  estimatedCostCents Int      @default(0) @map("estimated_cost_cents")
  scrubJobCount      Int      @default(0) @map("scrub_job_count")
  lastUpdatedAt      DateTime @default(now()) @updatedAt @map("last_updated_at") @db.DateTime(6)

  tenant Tenant @relation(fields: [tenantId], references: [id])

  @@unique([tenantId, periodYear, periodMonth])
  @@map("rnd_usage_log")
}
```

---

## 4. RBAC

### 4.1 New Verbs

Two new verbs are added to `shared/types/src/rbac.ts`:

```typescript
// rnd / reassigned numbers scrub (N06)
'rnd:scrub',      // trigger a scrub job; view scrub status
'rnd:configure',  // read/write tenant RND credentials + settings
'rnd:override',   // remove a number from reassigned DNC (with justification)
```

### 4.2 Role Assignment Matrix

| Verb | super_admin | admin | supervisor | agent | viewer | integrator |
|---|---|---|---|---|---|---|
| `rnd:scrub` | Yes | Yes | No | No | No | No |
| `rnd:configure` | Yes | Yes | No | No | No | No |
| `rnd:override` | Yes | No | No | No | No | No |

`rnd:configure` and `rnd:override` are marked `sensitive: true` in the grant matrix.

### 4.3 RBAC Matrix Addition

In `shared/types/src/rbac.ts`, under the `VERBS` array (after `'vmdrop:edit'`):

```typescript
// rnd scrub (N06)
'rnd:scrub',
'rnd:configure',
'rnd:override',
```

In the grants section:
```typescript
'rnd:scrub':      { scope: 'tenant' },
'rnd:configure':  { scope: 'tenant', sensitive: true },
'rnd:override':   { scope: 'tenant', sensitive: true },
```

---

## 5. RND API Client

**File**: `api/src/integrations/rnd/client.ts`

### 5.1 Client Interface

```typescript
export interface RndQueryItem {
  tn: string;        // E.164
  date: string;      // YYYY-MM-DD (consent date)
}

export interface RndResultItem {
  tn: string;
  result: 'yes' | 'no' | 'no_data';
  disconnect_date: string | null;   // YYYY-MM-DD or null
  queried_at: string;               // ISO 8601
}

export interface RndBatchResponse {
  results: RndResultItem[];
  query_count: number;
  subscription_remaining: number;
}

export interface RndClient {
  query(items: RndQueryItem[]): Promise<RndBatchResponse>;
  getSubscriptionStatus(): Promise<RndSubscriptionStatus>;
}
```

### 5.2 Token Management

```typescript
class RndClientImpl implements RndClient {
  private readonly tokenKey: string;         // Valkey key: t:{tid}:rnd:token
  private readonly baseUrl = 'https://api.reassigned.us';

  async getToken(): Promise<string> {
    // 1. Try Valkey cache
    const cached = await redis.get(this.tokenKey);
    if (cached) return cached;

    // 2. OAuth token fetch
    const res = await fetch(`${this.baseUrl}/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.clientId,
        client_secret: this.decryptedSecret(),
        scope: 'rnd.query',
      }),
    });
    if (!res.ok) throw new RndAuthError(`Token fetch failed: ${res.status}`);
    const { access_token, expires_in } = await res.json();

    // 3. Cache with TTL = expires_in - 60s
    await redis.set(this.tokenKey, access_token, 'EX', expires_in - 60);
    return access_token;
  }

  async query(items: RndQueryItem[]): Promise<RndBatchResponse> {
    if (items.length > 1000) throw new Error('Max 1000 items per query');
    const token = await this.getToken();

    const res = await fetch(`${this.baseUrl}/v1/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ numbers: items }),
    });

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('Retry-After') ?? '60', 10);
      throw new RndRateLimitError(`Rate limited. Retry after ${retryAfter}s`, retryAfter);
    }
    if (res.status === 402) throw new RndQuotaError('RND subscription quota exceeded');
    if (res.status === 503) throw new RndOutageError('RND service unavailable');
    if (!res.ok) throw new RndApiError(`RND API error: ${res.status}`);

    return res.json() as Promise<RndBatchResponse>;
  }
}
```

### 5.3 Error Hierarchy

```typescript
export class RndError extends Error {}
export class RndAuthError extends RndError {}
export class RndRateLimitError extends RndError {
  constructor(msg: string, public retryAfterSeconds: number) { super(msg); }
}
export class RndQuotaError extends RndError {}
export class RndOutageError extends RndError {}
export class RndApiError extends RndError {}
```

### 5.4 Secret Decryption

`tenant_rnd_config.client_secret_enc` is AES-256-GCM encrypted using the tenant's KEK (from F05's key-encryption-key infrastructure). The client decrypts at runtime using the KEK manager — never stores the plaintext in memory beyond the scope of a single token fetch.

---

## 6. BullMQ Worker Job

**Directory**: `workers/src/jobs/rnd-scrub/`

### 6.1 Files

```
workers/src/jobs/rnd-scrub/
  index.ts          — queue registration + BullMQ Worker setup
  processor.ts      — main job processor (BullMQ sandboxed processor)
  batcher.ts        — splits phone list into 1K chunks, handles API vs SFTP selection
  result-writer.ts  — writes RndLookupLog rows + DNC insertions
  rescrub-scheduler.ts — nightly cron: find stale lookups, enqueue rescrub jobs
  __tests__/
    processor.test.ts
    batcher.test.ts
    result-writer.test.ts
```

### 6.2 Job Payload

```typescript
interface RndScrubJobData {
  tenantId: number;
  campaignId: string;
  scrubJobId: string;       // pre-created rnd_scrub_job.id (ULID)
  triggerReason: 'manual' | 'auto_launch' | 'scheduled_rescrub';
  triggeredByUserId: number | null;
  queryMode: 'api' | 'sftp';
  // For api mode: phones are fetched from DB by the processor
  // For sftp mode: uploadId is set after file submission
}
```

### 6.3 Processor Logic (Pseudocode)

```typescript
export default async function processor(job: Job<RndScrubJobData>): Promise<void> {
  const { tenantId, campaignId, scrubJobId, queryMode } = job.data;

  // 1. Update job status → running
  await db.rndScrubJob.update({ where: { id: scrubJobId }, data: { status: 'running', startedAt: new Date() } });
  await auditLog(tenantId, 'rnd.scrub.started', { scrubJobId, campaignId });

  try {
    // 2. Fetch phones from leads table (not already in DNC-reassigned)
    const phones = await fetchActivePhonesForCampaign(tenantId, campaignId);
    await db.rndScrubJob.update({ where: { id: scrubJobId }, data: { totalPhones: phones.length } });

    if (queryMode === 'sftp' || phones.length > 50_000) {
      await processSftpMode(job, phones);
    } else {
      await processApiMode(job, phones);
    }

    // 3. Update job status → completed
    await db.rndScrubJob.update({
      where: { id: scrubJobId },
      data: { status: 'completed', completedAt: new Date() },
    });
    await db.campaign.update({
      where: { id: campaignId, tenantId },
      data: { rndScrubStatus: 'completed', rndLastScrubAt: new Date(), rndLastScrubId: scrubJobId },
    });
    await auditLog(tenantId, 'rnd.scrub.completed', {
      scrubJobId, campaignId,
      phonesYes: job.data.phonesYes,    // updated throughout
      phonesNo: job.data.phonesNo,
    });

  } catch (err) {
    if (err instanceof RndOutageError) {
      await db.rndScrubJob.update({ where: { id: scrubJobId }, data: { status: 'failed', errorMessage: 'RND outage' } });
      await auditLog(tenantId, 'rnd.api.outage', { scrubJobId, error: String(err) });
      // Do not rethrow — campaign can still launch; retry will be scheduled separately
      return;
    }
    if (err instanceof RndQuotaError) {
      await db.rndScrubJob.update({ where: { id: scrubJobId }, data: { status: 'paused_budget' } });
      await auditLog(tenantId, 'rnd.scrub.budget_exceeded', { scrubJobId });
      return;
    }
    throw err;  // BullMQ retries on unexpected errors
  }
}

async function processApiMode(job: Job, phones: PhoneWithConsent[]): Promise<void> {
  const client = await buildRndClient(job.data.tenantId);
  const chunks = chunk(phones, 1000);

  for (let i = 0; i < chunks.length; i++) {
    const batch = chunks[i];
    const items: RndQueryItem[] = batch.map(p => ({
      tn: p.phoneE164,
      date: formatDate(resolveConsentDate(p)),
    }));

    let response: RndBatchResponse;
    try {
      response = await client.query(items);
    } catch (err) {
      if (err instanceof RndRateLimitError) {
        await delay(err.retryAfterSeconds * 1000);
        response = await client.query(items);  // one retry after back-off
      } else throw err;
    }

    await resultWriter.write(job, response.results, batch);
    await job.updateProgress(Math.round(((i + 1) / chunks.length) * 100));
    await updateCostTracking(job.data.tenantId, response.query_count, job.data.scrubJobId);
  }
}
```

### 6.4 Result Writer Logic

```typescript
async function write(job: Job, results: RndResultItem[], originals: PhoneWithConsent[]): Promise<void> {
  const lookupRows: RndLookupLogCreateInput[] = [];
  const dncInserts: DncCreateInput[] = [];

  for (const r of results) {
    const original = originals.find(p => p.phoneE164 === r.tn);
    const isDncInserted = r.result === 'yes';

    lookupRows.push({
      tenantId: job.data.tenantId,
      scrubJobId: job.data.scrubJobId,
      phoneE164: r.tn,
      consentDate: original?.consentDate ?? new Date(),
      consentDateSrc: original?.consentDateSrc ?? 'fallback',
      result: r.result,
      disconnectDate: r.disconnect_date ? new Date(r.disconnect_date) : null,
      queriedAt: new Date(r.queried_at),
      dncInserted: isDncInserted,
    });

    if (isDncInserted) {
      dncInserts.push({
        tenantId: job.data.tenantId,
        phoneE164: r.tn,
        source: 'reassigned',
        state: '__',
        campaignId: '__GLOBAL__',
        notes: `RND:Yes:disconnect=${r.disconnect_date ?? 'unknown'}:as_of=${formatDate(original?.consentDate)}`,
        addedAt: new Date(),
        addedBy: null,
        expiresAt: null,
      });
      await auditLog(job.data.tenantId, 'rnd.number.flagged_reassigned', {
        phoneE164: r.tn,
        disconnectDate: r.disconnect_date,
        scrubJobId: job.data.scrubJobId,
      });
    }
  }

  // Batch DB writes
  await db.rndLookupLog.createMany({ data: lookupRows, skipDuplicates: true });
  if (dncInserts.length > 0) {
    await db.$executeRaw`INSERT IGNORE INTO dnc ${buildDncInsertValues(dncInserts)}`;
    // Update Valkey Bloom filter for reassigned source
    await redis.bf.mAdd(`t:${job.data.tenantId}:dnc:reassigned:bloom`, dncInserts.map(d => d.phoneE164));
  }

  // Update scrub job counters
  const yesCount = results.filter(r => r.result === 'yes').length;
  const noCount = results.filter(r => r.result === 'no').length;
  const noDataCount = results.filter(r => r.result === 'no_data').length;
  await db.rndScrubJob.update({
    where: { id: job.data.scrubJobId },
    data: {
      phonesQueried: { increment: results.length },
      phonesYes: { increment: yesCount },
      phonesNo: { increment: noCount },
      phonesNoData: { increment: noDataCount },
    },
  });
}
```

### 6.5 Rescrub Scheduler

**File**: `workers/src/jobs/rnd-scrub/rescrub-scheduler.ts`

Nightly cron (02:30 UTC) finds phones that need re-scrubbing:

```typescript
export async function scheduleRescrubs(): Promise<void> {
  const staleThreshold = subDays(new Date(), 55);

  // Find active campaigns with RND configured
  const campaigns = await db.campaign.findMany({
    where: { status: 'RUNNING', rndAutoScrub: true },
    select: { id: true, tenantId: true },
  });

  for (const campaign of campaigns) {
    const stalePhones = await db.rndLookupLog.findMany({
      where: {
        tenantId: campaign.tenantId,
        lookupDate: { lt: staleThreshold },
        result: 'no',   // 'yes' already in DNC; 'no_data' doesn't need re-scrub urgently
        // Only phones still active in this campaign
        phoneE164: { in: await getActivePhonesForCampaign(campaign.tenantId, campaign.id) },
      },
      select: { phoneE164: true },
    });

    if (stalePhones.length === 0) continue;

    const scrubJobId = ulid();
    await db.rndScrubJob.create({
      data: {
        id: scrubJobId,
        tenantId: campaign.tenantId,
        campaignId: campaign.id,
        triggerReason: 'scheduled_rescrub',
        status: 'queued',
        totalPhones: stalePhones.length,
        queryMode: stalePhones.length > 50_000 ? 'sftp' : 'api',
      },
    });

    await rndScrubQueue.add('rnd-scrub', {
      tenantId: campaign.tenantId,
      campaignId: campaign.id,
      scrubJobId,
      triggerReason: 'scheduled_rescrub',
      triggeredByUserId: null,
      queryMode: stalePhones.length > 50_000 ? 'sftp' : 'api',
    }, {
      jobId: `rnd-rescrub:${campaign.id}:${format(new Date(), 'yyyy-MM-dd')}`,
      removeOnComplete: { count: 100 },
    });
  }
}
```

### 6.6 BullMQ Queue Configuration

```typescript
// workers/src/jobs/rnd-scrub/index.ts
export const rndScrubQueue = new Queue('rnd-scrub', {
  connection: redis,
  defaultJobOptions: {
    attempts: 10,
    backoff: {
      type: 'exponential',
      delay: 5_000,   // 5s, 10s, 20s, ... up to ~42 min
    },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 500 },
  },
});

export const rndScrubWorker = new Worker('rnd-scrub', './processor.cjs', {
  connection: redis,
  concurrency: 2,       // max 2 concurrent scrubs per worker pod (rate-limit friendly)
  limiter: {
    max: 100,           // max 100 jobs per minute (one job = up to 1000 phones)
    duration: 60_000,
  },
});
```

---

## 7. REST API Routes

**Directory**: `api/src/routes/admin/rnd/`

### 7.1 Route Files

```
api/src/routes/admin/rnd/
  index.ts              — route registration (registerAdminRndRoutes)
  scrub.ts              — POST /api/admin/rnd/scrub
  status.ts             — GET /api/admin/rnd/status/:campaign_id
  config.ts             — GET/PUT /api/admin/rnd/config
  usage.ts              — GET /api/admin/rnd/usage
  override.ts           — DELETE /api/admin/rnd/override/:phone
```

### 7.2 Endpoint Definitions

#### `POST /api/admin/rnd/scrub`

Trigger a campaign scrub. Creates an `rnd_scrub_job` row and enqueues a BullMQ job.

**Permission**: `rnd:scrub`

**Request body**:
```json
{
  "campaign_id": "CAMP-001",
  "force": false       // if true, re-scrubs numbers that have fresh results
}
```

**Response `202 Accepted`**:
```json
{
  "scrub_job_id": "01HZ...",
  "campaign_id": "CAMP-001",
  "status": "queued",
  "total_phones": 48291,
  "query_mode": "api",
  "estimated_cost_cents": 2185,
  "estimated_duration_seconds": 290
}
```

**Validation**:
- Campaign must exist and belong to tenant
- Tenant must have active `tenant_rnd_config` with `is_active = true`
- If a scrub job for this campaign is already `queued` or `running`: return `409 Conflict`
- If `estimated_cost_cents > monthly_budget_remaining`: return `402 Payment Required` with budget details

#### `GET /api/admin/rnd/status/:campaign_id`

Poll scrub progress.

**Permission**: `rnd:scrub`

**Response `200 OK`**:
```json
{
  "campaign_id": "CAMP-001",
  "scrub_job_id": "01HZ...",
  "status": "running",
  "total_phones": 48291,
  "phones_queried": 21000,
  "phones_yes": 47,
  "phones_no": 20850,
  "phones_no_data": 103,
  "progress_pct": 43,
  "estimated_cost_cents": 2185,
  "actual_cost_cents": 946,
  "started_at": "2026-05-13T20:00:00Z",
  "completed_at": null,
  "rnd_scrub_status": "running",
  "last_scrub_at": null
}
```

#### `GET /api/admin/rnd/config`

Retrieve current tenant RND configuration (secret masked).

**Permission**: `rnd:configure`

**Response**:
```json
{
  "client_id": "rnd-client-abc123",
  "client_secret": "****",
  "tier": "medium",
  "monthly_budget_cents": 50000,
  "auto_scrub_on_launch": true,
  "rescrub_interval_days": 55,
  "no_data_policy": "safe",
  "use_reassigned_dnc": true,
  "is_active": true
}
```

#### `PUT /api/admin/rnd/config`

Update RND configuration. If `client_id`/`client_secret` are present, validates them against the RND API before saving.

**Permission**: `rnd:configure` (sensitive)

**Request body**:
```json
{
  "client_id": "...",
  "client_secret": "...",   // optional; omit to keep existing
  "tier": "large",
  "monthly_budget_cents": 75000,
  "auto_scrub_on_launch": true,
  "rescrub_interval_days": 55,
  "no_data_policy": "safe"
}
```

Validation steps:
1. Validate field types and ranges
2. If `client_id` or `client_secret` changed: attempt token fetch; if it fails, return `422` with `"credential_invalid"` error
3. Encrypt `client_secret` with tenant KEK; store `client_secret_enc` + `client_secret_iv`
4. Set `is_active = true` if credentials validated successfully
5. Emit `audit_log`: `rnd.config.updated` (sensitive = true)

#### `GET /api/admin/rnd/usage`

Monthly cost breakdown.

**Permission**: `rnd:scrub`

**Query params**: `?year=2026&month=5`

**Response**:
```json
{
  "period": "2026-05",
  "queries_count": 142000,
  "estimated_cost_cents": 1750,
  "scrub_job_count": 8,
  "budget_cents": 50000,
  "budget_remaining_cents": 48250,
  "tier": "medium",
  "tier_monthly_cap": 1000000,
  "tier_remaining": 858000
}
```

#### `DELETE /api/admin/rnd/override/:phone`

Remove a number from `reassigned` DNC (override). Requires justification.

**Permission**: `rnd:override` (sensitive, super_admin only)

**Request body**:
```json
{
  "justification": "FCC data error confirmed by carrier ticket #12345"
}
```

**Actions**:
1. Remove from `dnc` table WHERE `phone_e164 = ? AND source = 'reassigned'`
2. Remove from Valkey Bloom (`BF` doesn't support deletion — remove from MySQL and let the filter expire naturally; set a short-circuit key `t:{tid}:rnd:override:{phone_hash} = 1` TTL 55d)
3. Emit `audit_log`: `rnd.override.applied` (includes phone, justification, user_id)
4. Return `200 OK` with updated DNC status

### 7.3 Route Registration

```typescript
// api/src/routes/admin/rnd/index.ts
export async function registerAdminRndRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/admin/rnd/scrub',
    { preHandler: [app.requireAuth, app.requirePermission('rnd:scrub')] },
    handleTriggerScrub,
  );
  app.get('/api/admin/rnd/status/:campaign_id',
    { preHandler: [app.requireAuth, app.requirePermission('rnd:scrub')] },
    handleGetStatus,
  );
  app.get('/api/admin/rnd/config',
    { preHandler: [app.requireAuth, app.requirePermission('rnd:configure')] },
    handleGetConfig,
  );
  app.put('/api/admin/rnd/config',
    { preHandler: [app.requireAuth, app.requirePermission('rnd:configure')] },
    handleUpdateConfig,
  );
  app.get('/api/admin/rnd/usage',
    { preHandler: [app.requireAuth, app.requirePermission('rnd:scrub')] },
    handleGetUsage,
  );
  app.delete('/api/admin/rnd/override/:phone',
    { preHandler: [app.requireAuth, app.requirePermission('rnd:override')] },
    handleOverride,
  );
}
```

---

## 8. Configuration

### 8.1 Tenant-Level Settings (stored in `tenant_rnd_config`)

| Setting | Type | Default | Description |
|---|---|---|---|
| `client_id` | string | — | RND OAuth client ID |
| `client_secret` | encrypted | — | RND OAuth client secret (AES-256-GCM) |
| `tier` | enum | `xs` | Subscription tier (for cost estimation) |
| `monthly_budget_cents` | int | null | Monthly spend cap; null = uncapped |
| `auto_scrub_on_launch` | bool | true | Auto-trigger scrub when campaign goes RUNNING |
| `rescrub_interval_days` | int | 55 | Days before a `No` result is re-scrubbed |
| `no_data_policy` | enum | `safe` | How to treat `No Data` results (`safe` = allow; `block` = DNC) |
| `use_reassigned_dnc` | bool | true | Whether reassigned numbers are excluded from hopper |
| `is_active` | bool | false | Whether RND is enabled for this tenant |

### 8.2 Campaign-Level Settings (stored in `campaigns`)

| Column | Type | Default | Description |
|---|---|---|---|
| `rnd_auto_scrub` | bool | true | Whether to auto-scrub this campaign specifically |
| `rnd_scrub_status` | enum | `never` | Current scrub status |
| `rnd_last_scrub_at` | datetime | null | When last scrub completed |
| `rnd_last_scrub_id` | char(26) | null | ULID of last scrub job |
| `use_reassigned_dnc` | bool | true | Inherit from tenant; can be overridden per-campaign |

### 8.3 System-Level Environment Variables

```bash
# RND API base URL (override for dev/test)
RND_API_BASE_URL=https://api.reassigned.us

# SFTP connection for file-upload mode
RND_SFTP_HOST=sftp.reassigned.us
RND_SFTP_PORT=22
RND_SFTP_USERNAME=<global or per-tenant from config>

# Feature flag: disable auto-scrub globally (emergency override)
RND_GLOBAL_DISABLE=false

# Rate limiter: max concurrent RND API requests per worker
RND_MAX_CONCURRENT_REQUESTS=3
```

---

## 9. Audit Events

All events are written to `audit_log` using the existing D05/M04 audit infrastructure.

| Event Name | Trigger | Data Fields |
|---|---|---|
| `rnd.scrub.started` | Scrub job begins processing | `scrub_job_id`, `campaign_id`, `total_phones`, `query_mode`, `trigger_reason` |
| `rnd.scrub.completed` | Scrub job finishes successfully | `scrub_job_id`, `campaign_id`, `phones_yes`, `phones_no`, `phones_no_data`, `actual_cost_cents`, `duration_ms` |
| `rnd.scrub.failed` | Scrub job terminates with error | `scrub_job_id`, `campaign_id`, `error_message`, `phones_queried` |
| `rnd.number.flagged_reassigned` | Single number gets `Yes` result | `phone_e164` (PII — masked in display), `disconnect_date`, `scrub_job_id`, `consent_date` |
| `rnd.api.outage` | HTTP 503 or timeout from RND | `scrub_job_id`, `error`, `retry_count` |
| `rnd.scrub.budget_exceeded` | Scrub paused due to budget cap | `scrub_job_id`, `campaign_id`, `budget_cents`, `used_cents` |
| `rnd.config.updated` | Tenant RND settings updated | `changed_fields` (excludes secret), `user_id` |
| `rnd.override.applied` | Number removed from reassigned DNC | `phone_e164` (masked), `justification`, `user_id` |
| `rnd.rescrub.scheduled` | Nightly scheduler enqueues jobs | `campaign_count`, `total_stale_phones` |
| `rnd.consent_date.unknown` | Fallback consent date used | `phone_e164` (masked), `fallback_date`, `scrub_job_id` |

**PII handling**: `phone_e164` values in audit events are stored masked — last 4 digits visible: `+1202555****`. Full E.164 is in `rnd_lookup_log.phone_e164` (access-controlled separately).

---

## 10. Metrics

Prometheus metrics emitted by the worker and API:

```
# Counter: total RND queries issued
vici2_rnd_queries_total{tenant_id, result}

# Counter: numbers flagged as reassigned
vici2_rnd_flagged_total{tenant_id}

# Histogram: RND API latency
vici2_rnd_api_duration_seconds{mode="api"|"sftp"}

# Gauge: current month estimated cost in cents
vici2_rnd_monthly_cost_cents{tenant_id}

# Counter: rate limit hits
vici2_rnd_rate_limit_total{tenant_id}

# Counter: API outages detected
vici2_rnd_outage_total

# Counter: scrub jobs by status
vici2_rnd_scrub_jobs_total{status, trigger_reason}

# Histogram: scrub job duration
vici2_rnd_scrub_duration_seconds{query_mode}
```

---

## 11. File Map (Implementation)

```
api/
  src/
    integrations/
      rnd/
        client.ts                  — RndClient OAuth + REST + SFTP
        sftp.ts                    — SFTP file upload / status polling
        errors.ts                  — RndError hierarchy
        index.ts                   — barrel export
    routes/
      admin/
        rnd/
          index.ts                 — registerAdminRndRoutes
          scrub.ts                 — POST /scrub handler
          status.ts                — GET /status/:campaign_id handler
          config.ts                — GET/PUT /config handler
          usage.ts                 — GET /usage handler
          override.ts              — DELETE /override/:phone handler
    services/
      rnd/
        rnd-service.ts             — business logic: resolve consent dates, budget checks
        cost-estimator.ts          — tier → cost per query calculations
  test/
    rnd/
      client.test.ts
      scrub.test.ts
      config.test.ts
      override.test.ts

workers/
  src/
    jobs/
      rnd-scrub/
        index.ts                   — queue + worker registration
        processor.ts               — BullMQ sandboxed processor
        batcher.ts                 — chunk phones, mode selection
        result-writer.ts           — write rnd_lookup_log + DNC inserts
        rescrub-scheduler.ts       — nightly cron scheduler
        __tests__/
          processor.test.ts
          batcher.test.ts
          result-writer.test.ts
          rescrub-scheduler.test.ts

api/
  prisma/
    migrations/
      20260513290000_n06_rnd_scrub/
        migration.sql              — all schema changes (additive only)

shared/
  types/
    src/
      rbac.ts                      — add rnd:scrub, rnd:configure, rnd:override verbs
```

---

## 12. LOC Estimate

| Component | Estimated LOC |
|---|---|
| `client.ts` + `sftp.ts` + `errors.ts` | ~150 |
| `rnd-service.ts` + `cost-estimator.ts` | ~80 |
| Route handlers (5 files) | ~200 |
| Worker processor + batcher + result-writer | ~180 |
| Rescrub scheduler | ~60 |
| Migration SQL | ~60 |
| RBAC additions (3 verbs + grants) | ~10 |
| Prisma schema additions | ~70 |
| **Total** | **~810** |

---

## 13. Acceptance Criteria

### 13.1 Functional

- [ ] **AC-N06-01**: `POST /api/admin/rnd/scrub` triggers a BullMQ job; job processes all campaign phones in batches of 1,000; job status reflects progress; completes with `status = 'completed'`.
- [ ] **AC-N06-02**: All numbers returning `Yes` from RND are inserted into `dnc` table with `source = 'reassigned'` and appear in `isDnc()` results within the next hopper fill cycle (≤ 30s).
- [ ] **AC-N06-03**: All numbers returning `No` or `No Data` are logged in `rnd_lookup_log` but NOT inserted into DNC.
- [ ] **AC-N06-04**: `GET /api/admin/rnd/status/:campaign_id` returns accurate counts for `phones_yes`, `phones_no`, `phones_no_data` after a completed scrub.
- [ ] **AC-N06-05**: `GET /api/admin/rnd/usage` returns correct monthly query count and estimated cost, matching actual scrub job totals.
- [ ] **AC-N06-06**: Tenant RND credentials (`client_id` + `client_secret`) are stored AES-256-GCM encrypted; the plaintext secret is never returned by the config endpoint.
- [ ] **AC-N06-07**: Nightly rescrub scheduler finds phones with `lookup_date < now - 55 days` in active campaigns and enqueues re-scrub jobs correctly.
- [ ] **AC-N06-08**: When monthly budget cap is hit, the scrub job transitions to `paused_budget` and emits `rnd.scrub.budget_exceeded` audit event.
- [ ] **AC-N06-09**: `DELETE /api/admin/rnd/override/:phone` requires `rnd:override` verb (super_admin only), removes the DNC entry, and emits `rnd.override.applied` audit event with justification.
- [ ] **AC-N06-10**: `auto_scrub_on_launch = true` automatically enqueues a scrub job when a campaign transitions to `RUNNING` status.

### 13.2 Compliance

- [ ] **AC-N06-11**: `rnd_lookup_log` contains one row per queried phone per scrub, including `consent_date`, `consent_date_src`, `result`, `disconnect_date`, and `lookup_date`. These records are retained for ≥5 years (C04 partition policy applied).
- [ ] **AC-N06-12**: `consent_date_src` field accurately reflects the source of the consent date (not always `fallback`); `fallback` is used only when all other sources are null.
- [ ] **AC-N06-13**: Scrub records produced under RND outage conditions include `status = 'failed'` and `error_message` documenting the outage — no silent failures.
- [ ] **AC-N06-14**: The `rnd.number.flagged_reassigned` audit event is emitted once per number per scrub job when `result = 'yes'`.
- [ ] **AC-N06-15**: `No Data` results are stored in `rnd_lookup_log` with `result = 'no_data'`; they do NOT insert into DNC when `no_data_policy = 'safe'`; they DO insert when `no_data_policy = 'block'`.

### 13.3 Performance

- [ ] **AC-N06-16**: A scrub of 10K phones completes in ≤ 120 seconds (respecting 100 req/60s RND rate limit → ~10 API calls → ~6–10s minimum; buffer for DB writes and retry).
- [ ] **AC-N06-17**: A scrub of 1M phones via SFTP file upload enqueues the file in ≤ 60 seconds; result polling completes within 45 minutes.
- [ ] **AC-N06-18**: The `DncService.isDnc()` hot path performance is not degraded by the addition of the `reassigned` source — Valkey Bloom filter is populated for `reassigned` DNC entries.

### 13.4 Security

- [ ] **AC-N06-19**: `rnd:scrub` is restricted to `admin` and `super_admin` roles only.
- [ ] **AC-N06-20**: `rnd:configure` is a sensitive verb — all writes to `tenant_rnd_config` emit an audit_log entry.
- [ ] **AC-N06-21**: `rnd:override` is restricted to `super_admin` only and requires a non-empty justification text.
- [ ] **AC-N06-22**: Phone E.164 values in audit log events are masked (last 4 digits shown); full values are only in `rnd_lookup_log` (protected by RBAC and accessed via separate `rnd:scrub` authenticated endpoints).

---

## 14. Testing Plan

### 14.1 Unit Tests

| File | Coverage |
|---|---|
| `client.test.ts` | Token caching, OAuth refresh, query batching, error hierarchy (401/402/429/503) |
| `batcher.test.ts` | Chunk sizing at 1K boundary, mode selection at 50K threshold, empty input |
| `result-writer.test.ts` | DNC insertion for `yes`, skip for `no`/`no_data`, Bloom filter update, audit emit |
| `rescrub-scheduler.test.ts` | Stale detection logic, deduplication (skip if job already queued for campaign+date) |
| `cost-estimator.test.ts` | Cost calculation per tier, overage calculation, budget cap enforcement |

### 14.2 Integration Tests

| Test | Setup | Assert |
|---|---|---|
| Full scrub pipeline | Seed 100 leads in campaign; mock RND API returning 5 `yes`, 90 `no`, 5 `no_data` | 5 rows in `dnc` with `source='reassigned'`; 100 rows in `rnd_lookup_log`; scrub_job `status='completed'` |
| Budget cap enforcement | Set `monthly_budget_cents = 1`; trigger scrub | Job transitions to `paused_budget`; audit event emitted |
| Credential validation | PUT config with invalid credentials | Returns `422 credential_invalid`; no credential stored |
| Override flow | Insert reassigned DNC; call DELETE override | DNC row removed; audit event includes justification |
| Auto-scrub on launch | Set `auto_scrub_on_launch = true`; activate campaign | `rnd_scrub_job` row created; BullMQ job enqueued |

### 14.3 Run Commands

```bash
# Unit tests
cd /root/vici2 && npm test --workspace=api -- --testPathPattern='rnd'
cd /root/vici2 && npm test --workspace=workers -- --testPathPattern='rnd-scrub'

# Integration tests (requires test DB + mock RND server)
cd /root/vici2 && npm run test:integration --workspace=api -- --grep='rnd'
```

---

## 15. Dependencies and Sequencing

### 15.1 Hard Dependencies (must be complete before N06 IMPLEMENT)

- **F02 base schema** — `dnc` table, `DncSource` enum (already includes `reassigned`), tenant FK
- **D05 IMPLEMENT** — `DncService.isDnc()` must support `source='reassigned'`; Bloom filter infrastructure for `reassigned` source
- **F05 (KEK)** — AES-256-GCM key-encryption-key infrastructure for credential encryption
- **D03 IMPLEMENT** — `normalizeE164()` function for phone normalization before RND query
- **M02 RBAC** — `requirePermission()` middleware for route guards

### 15.2 Soft Dependencies (N06 works without, but degrades gracefully)

- **E01** — Reassigned numbers automatically excluded from hopper via D05; E01 need not be deployed first
- **C04** — `rnd_lookup_log` partition management is a Day-1 concern but the table functions without the auto-archival worker
- **M05** — Settings panel UI for RND configuration is a separate frontend task; backend API (config endpoints) are self-contained

### 15.3 Blocked By N06

- No modules explicitly blocked, but N06's safe-harbor records are consumed by legal/compliance review processes outside the system.

---

## 16. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| RND API outage during campaign launch | Low-Medium | Medium | Fail-open: do not block launch; retry queue; admin alert |
| Cost overrun (unexpected query volume) | Low | Medium | Budget cap + pre-flight cost estimate before scrub |
| False positives (RND says `Yes` incorrectly) | Low (~0.1%) | Medium | Override mechanism with justification; re-query before DNC |
| SFTP file upload processing delay (>45 min) | Low | Low | Polling with admin visibility; campaign can launch with partial scrub |
| KEK rotation breaks stored secrets | Very Low | High | Follow F05 KEK rotation procedure (re-encrypt on rotation) |
| RND pricing changes by FCC | Medium | Low | `tier` enum allows plan changes; cost estimator parameterized |
| Rate limit contention across tenants | Low | Low | BullMQ concurrency limit + per-credential rate tracking |
