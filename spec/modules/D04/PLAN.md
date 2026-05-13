# D04 — Status & Disposition Definitions — PLAN

**Module:** D04 (Data, Phase 1)
**Author:** D04-PLAN sub-agent (Claude Sonnet 4.6, 1M ctx)
**Date:** 2026-05-13
**Status:** PROPOSED — awaiting orchestrator/human review.
**Companion:** [RESEARCH.md](./RESEARCH.md) — 15 citations; 35-status canonical seed; 6 categories.
**Depends on (FROZEN):** F02 (schema freeze + amendments A1/T04.1-T04.4), E01 PLAN §10/§12
(`campaign_status_overrides`), T04 PLAN §3 (4 new system statuses), D01 PLAN §14.4
(`lead.status_changed` event).
**Blocks:** A06 (agent disposition picker), E01 (recycle-delay JOIN), T04 (hangup-cause
resolution), E05 (3% drop-rate denominator), M07 (force-recycle admin), M08 (reporting),
D05 (DNC side-effect), D06 (callback subgraph).

Once approved the public surface — REST endpoint shapes, `EffectiveStatus` type,
`StatusService` Go/TS interface, `resolveFromHangup` function signature, seed JSON checksums,
Zod schema code-regex, and the 3-layer merge SQL — is FROZEN. Seed row values and migration
column order may be adjusted in IMPLEMENT without RFC; any change to the 35-row count,
recycle-delay semantics (-1/0/NULL/>0), or the hangup-cause-to-status map requires RFC.

---

## 0. TL;DR (10 bullets)

1. **D04 is a ~600 LOC service + seed layer, not a schema owner.** F02 already landed the
   `statuses` table and `campaign_status_overrides` table. D04's only schema work is
   **adding three columns** to `statuses` via a migration amendment: `recycle_delay_seconds INT
   NULL`, `category VARCHAR(20) NULL`, `system_owner VARCHAR(8) NULL`. All other D04 work is
   service code, seed JSON, and tests.

2. **35 canonical statuses, 6 categories, seeded to `(tenant_id=1, campaign_id='__SYS__')` on
   fresh install.** Counts: lifecycle (4), agent-outcome (13), system-amd (4), system-carrier
   (8), system-compliance (6). The `__SYS__` sentinel is the established F02 pattern (also used
   by `pause_codes` and `dnc.campaign_id='__GLOBAL__'`). System rows are immutable at the API
   surface.

3. **Three-layer override resolution, last-write wins per column.** Read precedence:
   (a) full per-campaign shadow row in `statuses(campaign_id=<X>)` wins all flag columns;
   (b) `campaign_status_overrides` wins `recycle_delay_seconds` and `max_calls` only;
   (c) `statuses(campaign_id='__SYS__')` provides the default. Hot path cached 60s in-process
   LRU, busted by Valkey pubsub `pubsub:t:{tid}:status_changed:{cid}`.

4. **`recycle_delay_seconds` has four semantic values.** `NULL` = fall back to
   `campaigns.recycle_delay_seconds`; `0` = immediate re-queue (carrier-fail pattern);
   `-1` = terminal (never re-dial); `>0` = seconds. 19 of the 35 statuses are terminal (`-1`);
   2 are immediate (`0`); 3 fall back to campaign default (`NULL`).

5. **`selectable` and `campaigns.dial_statuses` are distinct concepts.** `selectable` controls
   A06's agent disposition picker. `dial_statuses` (E01-owned JSON array on `campaigns`) controls
   which lead statuses the hopper filler re-dials. Example: `CALLBK` is `selectable=true` but
   its recycle is driven by `callbacks.callback_at`, not the recycle-delay floor.

6. **FreeSWITCH `hangup_cause → status` mapping is a pure function** with a 28-entry table
   (JSON seed) and a metric-emitting fallback default (`NA`). The mapper is hot-reloadable via
   `POST /api/admin/d04/reload` without code deploy. Unmapped causes emit
   `vici2_d04_hangup_unmapped_total{cause}`.

7. **DNC auto-insert is a non-blocking side-effect** of `dnc=true` on a status. After the
   disposition transaction commits, D04 fire-and-forgets to D05's `addInternal`. Failure is
   logged and reconciled by D05's eventual-consistency worker. Sale flag does NOT auto-DNC.

8. **State machine is flat with 4 primary transitions.** Happy path:
   `NEW → QUEUE → INCALL → <disposition>`. Callback subgraph:
   `CALLBK → CBHOLD → QUEUE → INCALL → <disposition>`. Seven illegal transitions are
   enforced at the service layer (cannot set `INCALL`/`QUEUE` via API, cannot agent-dispo
   `INVALID`, cannot transition out of terminal without manager force-recycle via M03).

9. **Reporting aggregation uses a single canonical denominator.** `humanAnswered=true` is the
   FCC 3% drop-rate denominator — exactly one column, exactly one query. CI grep in M08 forbids
   any alternative denominator expression. `category` column drives AMD rate and carrier-failure
   rate metrics without additional joins.

10. **RBAC is two-level.** `campaigns:read` for GET endpoints; `campaigns:edit` for POST/PATCH/
    DELETE. `PATCH` with `campaign_id='__SYS__'` returns `403 system_status_immutable`. Admin
    override of terminal-status recycle requires `admin:system` and generates an audit log row.

---

## 1. Goals and non-goals

### Goals

- Provide the canonical 35-status seed for every new tenant installation (idempotent UPSERT).
- Own the `dispositionService.submit()` codepath: write `dispositions` row + update `leads.status`
  + update `call_log.status` + emit `lead.status_changed` event + fire DNC/sale side-effects.
- Expose REST endpoints for admin management of per-campaign status overrides.
- Provide a typed `StatusService` for all internal consumers (E01, T04, E05, D06).
- Provide `resolveFromHangup(campaignId, hangupCause) → statusCode` as a pure function.
- Add three columns to `statuses` via a D04 migration amendment.
- Ship `db/seeds/system-statuses.json` (35 rows) and `db/seeds/hangup-cause-map.json` (28 rows).
- Enforce the `selectable vs dial_statuses` two-concept distinction in validation.
- Emit 9 Prometheus metrics covering disposition writes, hangup resolution, cache, and side-effects.

### Non-goals

- D04 does **not** own the `statuses` table DDL (F02 owns); D04 adds columns via amendment only.
- D04 does **not** own `campaigns.dial_statuses` (E01-owned campaign config).
- D04 does **not** implement min_call_seconds / max_call_seconds per-status (deferred to Phase 3).
- D04 does **not** own the DNC data store (D05 owns); D04 only triggers the side-effect.
- D04 does **not** own callback scheduling (D06 owns); D04 sets `callback=true` flag only.
- D04 does **not** own the M07 list-reset admin workflow; M07 UI calls D04's `POST /api/admin/
  leads/bulk-reset` (D04 owns the service endpoint, M07 owns the frontend button).
- D04 does **not** own the QC codes QCFAIL/QCPASS (deferred to Phase 4 / S05).
- D04 does **not** backfill the `recycle_delay_seconds` column on existing rows other than the
  seeded 35; per-tenant rows migrated from a legacy Vicidial import carry NULL (falls back to
  campaign default).

---

## 2. Status taxonomy table

### 2.1 Category definitions

| Category | Semantic | Who sets |
|---|---|---|
| `lifecycle` | Transient lead states managed by system modules | E01, T01, D06 |
| `agent-outcome` | Agent-selected dispositions from A06 picker | `__AGT__` (agent via A06) |
| `system-amd` | AMD/fax detection outcomes set by T04/T01 | T04, T01 |
| `system-carrier` | Carrier-side failure hangup causes | T04 |
| `system-compliance` | Regulatory / session-control outcomes | E05, T01, T04, E01 |

### 2.2 Full 35-row canonical seed

All rows belong to `(tenant_id=1, campaign_id='__SYS__')` on a fresh install. `hotkey` column
uses digits 1-9 for the most-frequent agent-selectable statuses per industry convention. Values
for `recycleDelaySeconds`: `NULL` = campaign default; `0` = immediate; `-1` = terminal; `>0`
= seconds. The `A` column header key: **sel** = `selectable`, **hA** = `humanAnswered`,
**sa** = `sale`, **dn** = `dnc`, **cb** = `callback`, **nI** = `notInterested`.

| Code | Description | sel | hA | sa | dn | cb | nI | hk | recycleDelay | category | systemOwner |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `NEW` | Uncalled lead | F | F | F | F | F | F | — | NULL | lifecycle | E01 |
| `QUEUE` | In hopper / about to dial | F | F | F | F | F | F | — | -1 | lifecycle | E01 |
| `INCALL` | Talking to agent | F | T | F | F | F | F | — | -1 | lifecycle | T01 |
| `CBHOLD` | Callback waiting for trigger | F | F | F | F | F | F | — | -1 | lifecycle | D06 |
| `SALE` | Sale completed | T | T | T | F | F | F | 1 | -1 | agent-outcome | __AGT__ |
| `NI` | Not interested | T | T | F | F | F | T | 2 | -1 | agent-outcome | __AGT__ |
| `NP` | No pitch — qualified out | T | T | F | F | F | T | 3 | -1 | agent-outcome | __AGT__ |
| `CALLBK` | Scheduled callback | T | T | F | F | T | F | 4 | NULL | agent-outcome | __AGT__ |
| `DNC` | Do not call | T | T | F | T | F | F | 5 | -1 | agent-outcome | __AGT__ |
| `XFER` | Transferred to closer/in-group | T | T | F | F | F | F | 6 | -1 | agent-outcome | __AGT__ |
| `DEC` | Declined sale | T | T | F | F | F | T | 7 | -1 | agent-outcome | __AGT__ |
| `B` | Busy (agent-defined) | T | F | F | F | F | F | 8 | 120 | agent-outcome | __AGT__ |
| `N` | No answer (agent-defined) | T | F | F | F | F | F | 9 | 600 | agent-outcome | __AGT__ |
| `DC` | Disconnected number (agent-heard) | T | F | F | F | F | F | — | -1 | agent-outcome | __AGT__ |
| `WRONG` | Wrong number / wrong party | T | T | F | F | F | F | — | -1 | agent-outcome | __AGT__ |
| `DEAD` | Lead deceased / refused contact | T | T | F | F | F | F | — | -1 | agent-outcome | __AGT__ |
| `LM` | Left voicemail | T | F | F | F | F | F | — | 86400 | agent-outcome | __AGT__ |
| `A` | Answering machine (agent-detected) | T | F | F | F | F | F | — | 14400 | system-amd | __AGT__ |
| `AA` | Answering machine (carrier/AMD-detected) | F | F | F | F | F | F | — | 14400 | system-amd | T04 |
| `AVMA` | AMD beep heard / voicemail tone | F | F | F | F | F | F | — | 14400 | system-amd | T01 |
| `AFAX` | Fax tone detected | F | F | F | F | F | F | — | -1 | system-amd | T04 |
| `B-CAR` | Busy (carrier: USER_BUSY) | F | F | F | F | F | F | — | 180 | system-carrier | T04 |
| `NA-CAR` | No answer (carrier: NO_ANSWER) | F | F | F | F | F | F | — | 600 | system-carrier | T04 |
| `ADC` | Carrier disconnect | F | F | F | F | F | F | — | -1 | system-carrier | T04 |
| `INVALID` | Invalid/unallocated number | F | F | F | F | F | F | — | -1 | system-carrier | T04 |
| `TIMEOT` | Ring timeout (no SIP response) | F | F | F | F | F | F | — | 900 | system-carrier | T04 |
| `MEDIA_TO` | Media path failed mid-call | F | F | F | F | F | F | — | 300 | system-carrier | T01 |
| `CARRIER_FAIL` | Carrier-side fault (GW down, 5xx) | F | F | F | F | F | F | — | 0 | system-carrier | T04 |
| `GATEWAY_LIMIT_TRY_LATER` | Concurrent cap hit on gateway | F | F | F | F | F | F | — | 0 | system-carrier | T04 |
| `DROP` | Customer answered, no agent in 2s | F | T | F | F | F | F | — | 300 | system-compliance | E05 |
| `PDROP` | Pre-route drop at answer signal | F | T | F | F | F | F | — | -1 | system-compliance | T01 |
| `TCPA` | TCPA call-window blackout | F | F | F | F | F | F | — | NULL | system-compliance | T04 |
| `CONSENT_NOT_OBTAINED` | State consent gate failed | F | F | F | F | F | F | — | -1 | system-compliance | T04 |
| `ERI` | Agent error (browser closed pre-dispo) | F | T | F | F | F | F | — | 600 | system-compliance | T01 |
| `EXCEEDED_CALL_CAP` | Lead hit `campaigns.max_calls_per_lead` | F | F | F | F | F | F | — | -1 | system-compliance | E01 |

**Summary counts:**
- `selectable=true`: 13 (agent-outcome only, plus `A`)
- `humanAnswered=true`: 11 (all real-conversation statuses plus DROP/PDROP/INCALL/ERI)
- `recycleDelaySeconds=-1` (terminal): 19
- `recycleDelaySeconds=0` (immediate): 2 (`CARRIER_FAIL`, `GATEWAY_LIMIT_TRY_LATER`)
- `recycleDelaySeconds=NULL` (use campaign default): 3 (`NEW`, `CALLBK`, `TCPA`)

### 2.3 Recycle-delay rationale (abbreviated)

| Status | Default | Source / Rationale |
|---|---|---|
| `B` | 120s | Industry modal; Vicidial default 300s is too slow per operator feedback |
| `B-CAR` | 180s | Carrier busy clears faster than agent-heard busy |
| `N` / `NA-CAR` | 600s | 10-minute floor before disturbing a non-answering lead again |
| `A` / `AA` / `AVMA` | 14400s | 4h voicemail floor — FTC TSR guidance against repeated voicemail attempts |
| `LM` | 86400s | 24h floor between voicemails; FTC TSR |
| `TIMEOT` | 900s | 15-minute floor after ring timeout |
| `CARRIER_FAIL` | 0 | Carrier-side failure, not lead problem — immediate re-queue on sibling gateway |
| `TCPA` | NULL | E01 uses C01's `tcpa.NextOpen()` as authoritative re-queue time |
| `CONSENT_NOT_OBTAINED` | -1 | Terminal — requires explicit admin re-consent before re-dial |
| `DROP` | 300s | Safe-harbor message was played; re-try after 5 minutes |

---

## 3. Three-layer override resolution algorithm

### 3.1 Precedence rule

For any `(tenant_id, campaign_id, status)` triple the effective row is:

```
effective[col] = COALESCE(
  statuses[tenant_id, campaign_id=X, status][col],          -- (a) full shadow row
  campaign_status_overrides[tenant_id, campaign_id=X, code], -- (b) delay-only override
  statuses[tenant_id, campaign_id='__SYS__', status][col]   -- (c) system default
)
```

Layer (b) only contributes `recycle_delay_seconds` and `max_calls`; all boolean flag columns
skip layer (b) and resolve directly from (a) → (c).

### 3.2 Canonical merge SQL

```sql
SELECT
    s.status,
    COALESCE(c.description,     sys.description)     AS description,
    COALESCE(c.selectable,      sys.selectable)      AS selectable,
    COALESCE(c.human_answered,  sys.human_answered)  AS human_answered,
    COALESCE(c.sale,            sys.sale)            AS sale,
    COALESCE(c.dnc,             sys.dnc)             AS dnc,
    COALESCE(c.callback,        sys.callback)        AS callback,
    COALESCE(c.not_interested,  sys.not_interested)  AS not_interested,
    COALESCE(c.hotkey,          sys.hotkey)          AS hotkey,
    COALESCE(c.recycle_delay_seconds,
             o.recycle_delay_seconds,
             sys.recycle_delay_seconds)              AS recycle_delay_seconds,
    COALESCE(o.max_calls,       sys.max_calls)       AS max_calls,
    COALESCE(c.category,        sys.category)        AS category,
    COALESCE(c.system_owner,    sys.system_owner)    AS system_owner
FROM (
    SELECT DISTINCT status
      FROM statuses
     WHERE tenant_id = :tid
       AND campaign_id IN (:cid, '__SYS__')
) s
LEFT JOIN statuses c
       ON c.tenant_id = :tid AND c.campaign_id = :cid AND c.status = s.status
LEFT JOIN statuses sys
       ON sys.tenant_id = :tid AND sys.campaign_id = '__SYS__' AND sys.status = s.status
LEFT JOIN campaign_status_overrides o
       ON o.tenant_id = :tid AND o.campaign_id = :cid AND o.status_code = s.status
ORDER BY (system_owner = '__AGT__') DESC, hotkey, status;
```

This query is cached for 60s in an in-process LRU keyed on `(tenant_id, campaign_id)`.
Any write to `statuses` or `campaign_status_overrides` publishes
`pubsub:t:{tid}:status_changed:{cid}` on Valkey; all API workers subscribe and flush their LRU
entry. Target cache invalidation latency: <250ms.

### 3.3 UPSERT semantics

- `PATCH /api/admin/campaigns/:cid/statuses/:code` where `:cid='__SYS__'` → `403
  system_status_immutable`.
- If only `recycle_delay_seconds` or `max_calls` changes → INSERT/UPDATE
  `campaign_status_overrides` (lighter, one audit row).
- If any other column changes → INSERT/UPDATE `statuses` shadow row with
  `campaign_id=:cid`.
- `POST` creates a per-campaign-only status; rejected if the code already exists in `__SYS__`
  for this tenant.

---

## 4. Schema additions to `statuses` table

### 4.1 Three new columns

D04 adds these columns via a migration amendment (`api/prisma/migrations/<date>_d04_status_extension/`):

```prisma
model Status {
  // ... existing F02 columns unchanged ...
  recycleDelaySeconds  Int?    @map("recycle_delay_seconds")
  category             String? @db.VarChar(20)
  systemOwner          String? @map("system_owner") @db.VarChar(8)

  @@id([tenantId, campaignId, status])
  @@map("statuses")
}
```

```sql
-- migration.sql (additive only)
ALTER TABLE statuses
  ADD COLUMN recycle_delay_seconds INT NULL
      COMMENT 'NULL=campaign default, 0=immediate, -1=terminal, >0=seconds',
  ADD COLUMN category VARCHAR(20) NULL
      COMMENT 'agent-outcome|system-amd|system-carrier|system-compliance|lifecycle',
  ADD COLUMN system_owner VARCHAR(8) NULL
      COMMENT 'Which module emits: T04|T01|E01|E05|D06|__AGT__';
```

MySQL CHECK constraint (8.0.16+):
```sql
ALTER TABLE statuses
  ADD CONSTRAINT chk_recycle_delay
      CHECK (recycle_delay_seconds IS NULL
          OR recycle_delay_seconds = -1
          OR recycle_delay_seconds >= 0);
```

Rollback:
```sql
ALTER TABLE statuses
  DROP CONSTRAINT chk_recycle_delay,
  DROP COLUMN recycle_delay_seconds,
  DROP COLUMN category,
  DROP COLUMN system_owner;
```

### 4.2 No changes to `campaign_status_overrides`

The `campaign_status_overrides` table already landed via F02 amendment E01.16 with columns
`(tenant_id, campaign_id, status_code, recycle_delay_seconds, max_calls)` and FK to
`campaigns(tenant_id, id) ON DELETE CASCADE`. D04 requires no further changes to this table.

---

## 5. Seed data

### 5.1 Files

| File | Rows | Format | Owner |
|---|---|---|---|
| `db/seeds/system-statuses.json` | 35 | JSON array | D04 |
| `db/seeds/hangup-cause-map.json` | 28 | JSON object `{ cause: statusCode }` | D04 |

### 5.2 Seed lifecycle

- `npm run seed` in `api/` UPSERTs each row via Prisma `upsert({ where: { tenantId, campaignId, status }, ... })`.
- Idempotent: running twice yields identical state (CI asserts this in `check-status-seed.sh`).
- New tenant creation (Phase 4 multi-tenant): a tenant-create worker copies all `(tenant_id=1, campaign_id='__SYS__')` rows into the new tenant's `(tenant_id=N, campaign_id='__SYS__')` family.

### 5.3 CI lint: `scripts/ci/check-status-seed.sh`

Asserts:
1. `db/seeds/system-statuses.json` contains exactly 35 rows.
2. Every row has a non-null `systemOwner`.
3. `category='system-compliance'` rows have `systemOwner IN ('T04','T01','E05','E01')`.
4. `category='agent-outcome'` rows have `systemOwner = '__AGT__'`.
5. All `status` codes match regex `^[A-Z][A-Z0-9_-]{0,7}$`.
6. `hotkey` values are unique per-campaign across all rows with non-null hotkey.

---

## 6. API surface

### 6.1 REST endpoints

| Method | Path | RBAC | Notes |
|---|---|---|---|
| `GET` | `/api/admin/system-statuses` | `campaigns:read` | List all 35 `__SYS__` rows; cached 5 min |
| `GET` | `/api/admin/campaigns/:cid/statuses` | `campaigns:read` | 3-layer merge for campaign; used by A06 picker init |
| `POST` | `/api/admin/campaigns/:cid/statuses` | `campaigns:edit` | Create per-campaign custom status; rejects if code exists in `__SYS__` |
| `PATCH` | `/api/admin/campaigns/:cid/statuses/:code` | `campaigns:edit` | Update per-campaign; `__SYS__` cid → 403 |
| `DELETE` | `/api/admin/campaigns/:cid/statuses/:code` | `campaigns:edit` | Soft-delete shadow row only; never deletes `__SYS__` rows |
| `GET` | `/api/admin/hangup-cause-map` | `admin:read` | Returns hangup-cause JSON for admin UI |
| `POST` | `/api/admin/d04/reload` | `admin:system` | Hot-reload seed + hangup map without deploy |
| `POST` | `/api/admin/leads/bulk-reset` | `admin:system` | M07 "list reset" — D04 service, M07 UI; writes synthetic RESET disposition row |

**Not owned by D04:** `GET /api/admin/campaigns/:cid/dial-statuses` — that's a campaign config
field owned by E01/M02.

### 6.2 TypeScript service interface (`api/src/statuses/service.ts`)

```typescript
class StatusService {
  list(tenantId: bigint, campaignId: string): Promise<EffectiveStatus[]>
  resolve(tenantId: bigint, campaignId: string, code: string): Promise<EffectiveStatus | null>
  upsert(tenantId: bigint, campaignId: string, def: StatusDef): Promise<EffectiveStatus>
  delete(tenantId: bigint, campaignId: string, code: string): Promise<void>
  resolveFromHangup(tenantId: bigint, campaignId: string, hangupCause: string): Promise<string>
  isSelectable(tenantId: bigint, campaignId: string, code: string): Promise<boolean>
  hotkeyMap(tenantId: bigint, campaignId: string): Promise<Record<string, string>>
  validateTransition(tenantId: bigint, from: string, to: string): Promise<TransitionResult>
}

type EffectiveStatus = {
  code: string;
  description: string;
  selectable: boolean;
  humanAnswered: boolean;
  sale: boolean;
  dnc: boolean;
  callback: boolean;
  notInterested: boolean;
  hotkey: string | null;
  recycleDelaySeconds: number | null;   // -1=terminal, 0=immediate, NULL=campaign default, >0=seconds
  maxCalls: number | null;
  category: string | null;
  systemOwner: string | null;
  source: 'shadow' | 'override' | 'system';  // which merge layer this row came from
};
```

### 6.3 Zod validators (`shared/types/src/status.ts`, re-exported via `@vici2/types`)

```typescript
const StatusCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_-]{0,7}$/, 'invalid_status_code');
const HotkeySchema = z.string().regex(/^[0-9]$/).nullable();
const RecycleDelaySchema = z.union([z.literal(-1), z.literal(0), z.number().int().min(1)]).nullable();
const CategorySchema = z.enum(['agent-outcome','system-amd','system-carrier','system-compliance','lifecycle']).nullable();
```

Hotkey uniqueness: `PATCH` that would assign hotkey `'1'` to a second status in the same
campaign returns `409 hotkey_conflict`.

---

## 7. State transitions

### 7.1 Lead lifecycle — happy path

```
NEW ──(E01 filler claims)──► QUEUE ──(T01 CHANNEL_CREATE)──► <originating>
                                                                    │
                              ┌─────────────────────────────────────┼────────────────────────┐
                              │                                     │                        │
                      (CHANNEL_BRIDGE)                 (CHANNEL_HANGUP pre-bridge)    (T04 gate blocks)
                              │                                     │                        │
                              ▼                                     ▼                        ▼
                           INCALL                      T04.resolveFromHangup    {TCPA|CONSENT_NOT_OBTAINED|
                              │                                     │             CARRIER_FAIL|GATEWAY_LIMIT_TRY_LATER}
                   (agent submits A06 dispo)           {B-CAR|NA-CAR|ADC|INVALID|
                              │                         TIMEOT|CARRIER_FAIL|MEDIA_TO|
                              ▼                         A|AA|AVMA|AFAX|DROP|PDROP|ERI}
              {SALE|NI|NP|DEC|B|N|DC|WRONG|DEAD|XFER|LM|DNC|CALLBK|A}
                              │
                     ┌────────┴──────────┐
                     │                  │
             (recycleDelay>0)    (recycleDelay=-1)
                     │                  │
                     ▼                  ▼
            (E01 re-queues lead)    TERMINAL
```

### 7.2 Callback subgraph

```
<any> ──(agent dispositions CALLBK)──► CALLBK
                                           │
                              (D06 worker: callback_at <= NOW())
                                           │
                                           ▼
                                        CBHOLD ──(D06 triggers)──► QUEUE ──► INCALL ──► ...
```

### 7.3 Illegal transitions (service-layer enforcement)

| From | To | Why illegal | Enforcement |
|---|---|---|---|
| Any | `INCALL` | T01 CHANNEL_BRIDGE only | API excludes `INCALL` from PATCH |
| Any | `QUEUE` | E01 filler only | API excludes `QUEUE` from PATCH |
| Any | `NEW` | Cannot un-call a lead | `dispositionService.submit()` rejects `code=='NEW'` |
| `SALE` | Any non-`SALE` | Sales are sacred | M07 super-admin path with audit required |
| Any terminal (`recycleDelay=-1`) | Any | Terminal is sticky | M03 force-recycle button → `POST /api/leads/:id/recycle` (D06 owns) |
| Any | `INVALID` | Only T04 hangup map may set | API surface excludes `INVALID` from PATCH |
| `DNC` | Non-`DNC` | FTC TSR — sticky by law | M06 DNC admin path (not D04) |

### 7.4 Race-condition guards

- E01 increments `called_count` and sets `last_called_at` in the same UPDATE as the
  disposition write.
- D04 disposition writes are last-write-wins (per D01 PLAN §3.4 status-update exception).
- `lead.status_changed` event is emitted only when `UPDATE` returns `affected_rows >= 1`.

---

## 8. Reporting aggregation

### 8.1 Canonical metric formulas

| Metric | Formula | Status flags used |
|---|---|---|
| **Connect rate** | `SUM(human_answered) / COUNT(*)` | `humanAnswered` |
| **Sales rate** | `SUM(sale) / NULLIF(SUM(human_answered),0)` | `sale`, `humanAnswered` |
| **Drop rate (FCC TCPA)** | `SUM(is_drop) / NULLIF(SUM(human_answered),0)` rolling 30d | hard-coded `{DROP,PDROP}` + `humanAnswered` |
| **Conversion rate** | `SUM(sale) / COUNT(*)` | `sale` |
| **Callback rate** | `SUM(callback) / COUNT(*)` | `callback` |
| **Refusal rate** | `SUM(not_interested) / NULLIF(SUM(human_answered),0)` | `notInterested`, `humanAnswered` |
| **Carrier failure rate** | `SUM(category='system-carrier' AND NOT human_answered) / COUNT(*)` | `category`, `humanAnswered` |
| **AMD rate** | `SUM(category='system-amd') / COUNT(*)` | `category` |

### 8.2 Canonical denominator SQL (used by M08)

```sql
SELECT
    SUM(s.sale)                               AS sales,
    SUM(s.human_answered)                     AS human_answered,
    SUM(s.human_answered AND cl.is_drop = 1)  AS drops,
    COUNT(*)                                  AS total_calls,
    c.campaign_id
FROM call_log cl
JOIN statuses s
  ON s.tenant_id = cl.tenant_id
 AND s.campaign_id = '__SYS__'         -- resolve against system statuses for reporting
 AND s.status = cl.status
WHERE cl.tenant_id = :tid
  AND cl.campaign_id = :cid
  AND cl.call_started >= NOW() - INTERVAL :days DAY
GROUP BY c.campaign_id;
```

**Critical invariant:** M08 PLAN is required to use exactly `SUM(s.human_answered)` as
the FCC 3% denominator. CI grep (`scripts/ci/check-drop-rate-denominator.sh`) fails any
M08 query using `COUNT(*)` or `SUM(is_drop)` alone as a denominator.

---

## 9. FreeSWITCH `hangup_cause → status` mapping

### 9.1 Design

The mapper is a pure function `resolveFromHangup(hangupCause: string): string` backed by a
`Map<string, string>` loaded from `db/seeds/hangup-cause-map.json` at boot. The map is
hot-reloadable via `POST /api/admin/d04/reload` without restart.

Unknown causes default to `NA` and emit `vici2_d04_hangup_unmapped_total{cause=<raw_cause>}`
so operators can extend the map without code review.

### 9.2 Full 28-row mapping table

| FS `hangup_cause` | Q.850 | → Status | Rationale |
|---|---|---|---|
| `NORMAL_CLEARING` | 16 | existing agent status (or `A` if pre-bridge) | Normal; agent already set dispo |
| `USER_BUSY` | 17 | `B-CAR` | Carrier busy signal |
| `NO_ANSWER` | 19 | `NA-CAR` | Ring no-answer |
| `NO_USER_RESPONSE` | 18 | `NA-CAR` | No SIP 200 OK |
| `CALL_REJECTED` | 21 | `B-CAR` | Equipment rejection (busy-equivalent) |
| `ORIGINATOR_CANCEL` | 487 | `ERI` | Agent/pacing cancelled mid-ring → QA review |
| `MEDIA_TIMEOUT` | 604 | `MEDIA_TO` | Mid-call media loss |
| `UNALLOCATED_NUMBER` | 1 | `INVALID` | Number not assigned |
| `INVALID_NUMBER_FORMAT` | 28 | `INVALID` | Malformed number |
| `RECOVERY_ON_TIMER_EXPIRE` | 102 | `TIMEOT` | T1/T2/T3 timer expired |
| `NORMAL_TEMPORARY_FAILURE` | 41 | `CARRIER_FAIL` | Short-duration network fault |
| `NETWORK_OUT_OF_ORDER` | 38 | `CARRIER_FAIL` | Persistent network fault |
| `USER_NOT_REGISTERED` | 606 | `CARRIER_FAIL` | SIP user not registered |
| `GATEWAY_DOWN` | 609 | `CARRIER_FAIL` | Gateway not responding |
| `EXCHANGE_ROUTING_ERROR` | 25 | `CARRIER_FAIL` | Carrier routing problem |
| `DESTINATION_OUT_OF_ORDER` | 27 | `CARRIER_FAIL` | Destination unreachable |
| `RESPONSE_TO_STATUS_ENQUIRY` | 30 | `CARRIER_FAIL` | Carrier SIP status enquiry |
| `NETWORK_CONGESTION` | 42 | `CARRIER_FAIL` | Network busy |
| `ACCESS_INFO_DISCARDED` | 43 | `CARRIER_FAIL` | Carrier protocol error |
| `REQUESTED_CHAN_UNAVAIL` | 44 | `CARRIER_FAIL` | No carrier channel |
| `INCOMING_CALL_BARRED` | 54 | `INVALID` | Carrier refusing termination (likely carrier-DNC) |
| `BEARERCAPABILITY_NOTAUTH` | 57 | `CARRIER_FAIL` | Carrier capability mismatch |
| `BEARERCAPABILITY_NOTAVAIL` | 58 | `CARRIER_FAIL` | Carrier codec mismatch |
| `SERVICE_UNAVAILABLE` | 63 | `CARRIER_FAIL` | Carrier 5xx |
| `INTERWORKING` | 127 | `CARRIER_FAIL` | Carrier-to-carrier protocol error |
| `MANAGER_REQUEST` | 502 | `ERI` | Operator-initiated kill (S03 force-pause path) |
| `NORMAL_UNSPECIFIED` | 31 | `NA-CAR` | Defensive default — prefer no-answer over carrier-fail (no-answer recycles; carrier-fail does not penalise the lead) |
| `(unknown)` | * | `NA` | Fallback; emits `vici2_d04_hangup_unmapped_total{cause}` |

### 9.3 Integration with T04

T04's `OriginateError.D04Status()` typed-error hint translator maps the 5 typed errors to D04
status codes:

| OriginateError | D04 status |
|---|---|
| `ErrTCPABlocked` | `TCPA` |
| `ErrConsentBlocked` | `CONSENT_NOT_OBTAINED` |
| `ErrGatewayLimit` | `GATEWAY_LIMIT_TRY_LATER` |
| `ErrCarrierFail` | `CARRIER_FAIL` |
| `ErrRateLimited` (drop-cap) | (no lead status change — re-queue immediately) |

T04 calls `resolveFromHangup` only for hangup causes that arrive via `CHANNEL_HANGUP` events
when no agent disposition has been recorded.

---

## 10. DNC, sale, and callback side-effects

### 10.1 `dispositionService.submit()` pseudocode

```typescript
async function submitDisposition(req: DispositionInput): Promise<Disposition> {
  const status = await statusService.resolve(req.tenantId, req.campaignId, req.statusCode);
  if (!status) throw new ApiError(404, 'status_not_found');
  if (!status.selectable) throw new ApiError(403, 'status_not_agent_selectable');

  await prisma.$transaction(async (tx) => {
    await tx.disposition.create({ data: { ...req, disposedAt: new Date() } });
    await tx.lead.update({
      where: { id: req.leadId, tenantId: req.tenantId },
      data: { status: req.statusCode, modifyAt: new Date(), calledCount: { increment: 1 } },
    });
    await tx.callLog.update({
      where: { uuid: req.callUuid, tenantId: req.tenantId },
      data: { status: req.statusCode },
    });
    await tx.auditEvent.create({ ...buildAuditRow('lead.status_changed', req) });
  });

  // Non-blocking side-effects (after transaction commits):
  if (status.dnc) {
    dncService.addInternal({ tenantId: req.tenantId, phoneE164: req.phoneE164,
      source: 'internal', campaignId: '__GLOBAL__', addedBy: req.userId })
      .catch(err => logger.error('dnc_add_failed', { err }));
  }
  if (status.sale && campaign.crmWebhookUrl) {
    n01Webhook.fire(campaign.crmWebhookUrl, req).catch(err => logger.error('crm_webhook_failed', { err }));
  }

  await events.publish('lead.status_changed', {
    tenantId: req.tenantId, leadId: req.leadId,
    oldStatus: req.previousStatus, newStatus: req.statusCode,
    timestamp: new Date(), userId: req.userId,
  });

  return dispo;
}
```

### 10.2 Side-effect failure modes

| Failure | Behavior |
|---|---|
| DNC service down | Dispo committed; D05 eventual-consistency worker reconciles by scanning `dispositions` where status has `dnc=true` and phone not in `dnc` table |
| CRM webhook down | Dispo committed; N01 has a dead-letter queue |
| Event bus down | Dispo committed; consumers cold-start sweep reads `dispositions` table |
| `lead.update` returns 0 rows | Lead deleted between agent screen-pop and dispo submit → `404 lead_gone`; UI returns agent to ready state |

---

## 11. RBAC

| Action | Required permission | Notes |
|---|---|---|
| `GET /system-statuses`, `GET /campaigns/:cid/statuses` | `campaigns:read` | Any authenticated role |
| `POST /campaigns/:cid/statuses` | `campaigns:edit` | Creates per-campaign custom status |
| `PATCH /campaigns/:cid/statuses/:code` | `campaigns:edit` | Rejects `__SYS__` cid with 403 |
| `DELETE /campaigns/:cid/statuses/:code` | `campaigns:edit` | Shadow rows only |
| `GET /hangup-cause-map` | `admin:read` | Supervisor + above |
| `POST /d04/reload` | `admin:system` | Super-admin only |
| `POST /admin/leads/bulk-reset` | `admin:system` | M07 "list reset" — super-admin + audit required |

Hotkey conflict detection scope: per-campaign (`(tenant_id, campaign_id)`). System rows have
`hotkey=NULL` by design, so there is no cross-scope conflict.

Status code charset enforced at the API surface: regex `^[A-Z][A-Z0-9_-]{0,7}$`. The `__`
prefix is reserved for system extensions (e.g., future `__SYSV2` codes); the API rejects any
POST with a code starting `__` from non-`admin:system` callers.

---

## 12. Files to create

### 12.1 API (TypeScript, `api/`)

```
api/src/statuses/
  service.ts                      — StatusService class (resolve, list, upsert, delete,
                                    resolveFromHangup, hotkeyMap, validateTransition)
  disposition-service.ts          — submitDisposition; owns lead.status_changed event
  handlers/
    list-system.ts                — GET /api/admin/system-statuses
    list-campaign.ts              — GET /api/admin/campaigns/:cid/statuses
    create.ts                     — POST /api/admin/campaigns/:cid/statuses
    update.ts                     — PATCH /api/admin/campaigns/:cid/statuses/:code
    delete.ts                     — DELETE /api/admin/campaigns/:cid/statuses/:code
    hangup-map.ts                 — GET /api/admin/hangup-cause-map
    reload.ts                     — POST /api/admin/d04/reload
    bulk-reset.ts                 — POST /api/admin/leads/bulk-reset (M07 service hook)
  cache.ts                        — In-process LRU + Valkey pubsub cache invalidation
  hangup-map.ts                   — resolveFromHangup pure function + JSON loader
  validators.ts                   — Zod schemas (StatusCodeSchema, etc.)
  rbac.ts                         — Permission helpers
  metrics.ts                      — Prometheus counters/histograms
  events.ts                       — lead.status_changed event publisher
  index.ts                        — Fastify plugin: route registration

api/test/statuses/
  service.test.ts                 — unit tests for resolve, merge, validateTransition
  disposition-service.test.ts     — unit tests for submitDisposition side-effects
  hangup-map.test.ts              — all 28 entries + unknown-fallback + unmapped metric
  cache.test.ts                   — LRU TTL + pubsub invalidation
  handlers/
    list-system.test.ts
    list-campaign.test.ts
    create.test.ts
    update.test.ts
    delete.test.ts
    reload.test.ts
    bulk-reset.test.ts
  integration/
    three-layer-merge.test.ts     — fixture matrix for each merge precedence case
    dnc-side-effect.test.ts       — dnc=true status → D05 addInternal called
    tenant-isolation.test.ts      — cross-tenant status access → 404
    seed-idempotency.test.ts      — run seed twice → identical DB state

shared/types/src/
  status.ts                       — EffectiveStatus type + Zod schemas (re-exported via @vici2/types)

shared/events/
  status-events.json              — JSON Schema for lead.status_changed payload
```

### 12.2 Seed files

```
db/seeds/
  system-statuses.json            — 35-row canonical seed array
  hangup-cause-map.json           — 28-entry { "CAUSE": "STATUS" } object
```

### 12.3 Migration

```
api/prisma/migrations/<date>_d04_status_extension/
  migration.sql                   — ADD COLUMN recycle_delay_seconds, category, system_owner + CHECK constraint
  down.sql                        — DROP COLUMN (dev/test rollback only)
```

### 12.4 CI

```
scripts/ci/
  check-status-seed.sh            — 6 assertions on system-statuses.json (§5.3)
  check-drop-rate-denominator.sh  — grep M08 queries for correct denominator usage
```

### 12.5 HANDOFF

```
spec/modules/D04/HANDOFF.md       — downstream consumer guide for A06, E01, T04, M07, M08, E05, D05, D06
```

---

## 13. Test plan

### 13.1 Unit tests (vitest)

- **Three-layer merge fixture matrix**: 9 cases covering every combination of (shadow row
  present/absent) × (override row present/absent) × (system row present/absent).
- **`resolveFromHangup`**: all 28 entries verified; unknown cause → `NA` + metric increment.
- **Zod validators**: code regex (valid, too-long, lowercase, starts-with-number, `__`-prefix);
  hotkey (digit/null/letter); recycle-delay (-1, 0, positive, negative-not-minus1, null).
- **Transition guard**: 7 illegal transitions each throw expected error with correct code.
- **Hotkey conflict**: assigning same digit to two statuses in same campaign → `409`.
- **DNC scope**: `dncScope=GLOBAL` → passes `campaign_id='__GLOBAL__'` to D05; scope stored
  as implicit GLOBAL in Phase 1.

### 13.2 Integration tests (vitest + testcontainers)

| Test | Fixture | Expected |
|---|---|---|
| Three-layer merge SQL | (shadow row + override row + system row all set) | shadow row values win on flags; override wins on recycle_delay |
| Override-only path | Only `campaign_status_overrides` row, no shadow | override recycle_delay overrides system default; flags from system |
| System-only path | No shadow, no override | system default on all columns |
| `PATCH __SYS__` | Admin PATCH with `campaign_id='__SYS__'` | 403 `system_status_immutable` |
| `POST` duplicate code | POST `SALE` as per-campaign status | 409 `code_exists_in_system` |
| Seed idempotency | Run seed twice | Row count = 35; no duplicates |
| DNC side-effect | Disposition `DNC` status | D05 `addInternal` called once |
| Cache invalidation | PATCH status → Valkey pubsub → second GET | Second GET returns updated value |
| Tenant isolation | Tenant A reads Tenant B's status | 404 NOT_FOUND |
| `resolveFromHangup` `USER_BUSY` | `USER_BUSY` hangup cause | Returns `B-CAR` |
| `resolveFromHangup` unknown | `UNKNOWN_CAUSE_XYZ` | Returns `NA`; metric `vici2_d04_hangup_unmapped_total{cause=UNKNOWN_CAUSE_XYZ}` incremented |
| Hotkey map | `GET /campaigns/:cid/statuses` | Response includes `{ "1": "SALE", "2": "NI", ... }` |
| Force-recycle (`SALE`) | `POST /api/admin/leads/bulk-reset` without `admin:system` | 403 |

### 13.3 Performance

- `StatusService.list()` for a campaign with 35 statuses, 0 shadow rows: p95 < 5ms (cache-cold);
  p95 < 1ms (cache-warm).
- `StatusService.resolve()` for a single status: p95 < 2ms (cache-cold); p95 < 0.5ms (warm).
- `dispositionService.submit()`: p95 < 80ms (1 tx + 2 async side-effects).

### 13.4 Run commands

```
make test-statuses              # unit + integration
cd api && pnpm exec vitest run test/statuses
bash scripts/ci/check-status-seed.sh
bash scripts/ci/check-drop-rate-denominator.sh
```

---

## 14. Acceptance criteria

- [ ] Schema amendment merged: `statuses` table has `recycle_delay_seconds INT NULL`,
      `category VARCHAR(20) NULL`, `system_owner VARCHAR(8) NULL`, and CHECK constraint on
      `recycle_delay_seconds`.
- [ ] `db/seeds/system-statuses.json` contains exactly 35 rows; `check-status-seed.sh` passes.
- [ ] `db/seeds/hangup-cause-map.json` contains exactly 28 entries; all 28 verified by unit test.
- [ ] `npm run seed` is idempotent (running twice yields identical state).
- [ ] `StatusService.resolve()` implements 3-layer merge with correct COALESCE precedence.
- [ ] `PATCH /api/admin/campaigns/__SYS__/statuses/:code` returns `403 system_status_immutable`.
- [ ] `resolveFromHangup('USER_BUSY')` returns `B-CAR`; unknown causes return `NA` and
      increment `vici2_d04_hangup_unmapped_total`.
- [ ] `dispositionService.submit()` writes disposition row + lead status + call_log status in
      a single transaction.
- [ ] `lead.status_changed` event emitted after commit with correct payload shape
      (per `shared/events/status-events.json`).
- [ ] DNC side-effect fires non-blocking after commit; failure does NOT roll back the dispo.
- [ ] All 7 illegal transitions rejected at service layer.
- [ ] `humanAnswered` flag is the sole drop-rate denominator (CI grep enforces in M08).
- [ ] Hotkey uniqueness: `409 hotkey_conflict` when digit is re-used within a campaign.
- [ ] RBAC: agent-role cannot POST/PATCH/DELETE statuses; `admin:system` required for reload
      and bulk-reset.
- [ ] Tenant isolation: cross-tenant status access returns 404, not 403.
- [ ] Cache invalidation: PATCH publishes to Valkey pubsub; subsequent GET in a separate process
      returns updated value within 250ms.
- [ ] `check-drop-rate-denominator.sh` passes (M08 uses `SUM(human_answered)` as denominator).
- [ ] Coverage ≥ 70% on `api/src/statuses/**`.
- [ ] HANDOFF.md ships with interface contracts for A06, E01, T04, M07, M08, E05, D05, D06.

---

## 15. Dependencies and risks

### 15.1 Hard dependencies

| Dependency | What D04 needs |
|---|---|
| F02 schema freeze | `statuses` table + `campaign_status_overrides` table — already landed |
| F02 amendment (D04 migration) | Three new `statuses` columns — D04 adds via its own migration |
| T04 PLAN (4 new system statuses) | `TCPA`, `CONSENT_NOT_OBTAINED`, `CARRIER_FAIL`, `GATEWAY_LIMIT_TRY_LATER` are seeded by D04 |
| E01 PLAN §12 (campaign_status_overrides semantics) | Layer (b) of the 3-layer merge; D04 reads this table, E01 may also write override rows via M02 campaign admin |
| D01 PLAN §14.4 (lead.status_changed event) | D04 owns the emission; D01 owns the schema and type contract |
| D05 (DNC service) | `dncService.addInternal()` interface must be stable before D04 IMPLEMENT |
| F04 Valkey (pubsub for cache invalidation) | Valkey pubsub channel naming convention from F04 |

### 15.2 Soft dependencies (can implement with stubs)

| Module | Dependency nature |
|---|---|
| A06 (agent picker) | Consumes `GET /campaigns/:cid/statuses`; can develop against mock |
| E05 (drop-rate gate) | Reads `human_answered` flag via `StatusService`; can stub |
| M08 (reports) | Reads flags via `GET /system-statuses`; can stub |
| D06 (callbacks) | Reads `callback=true` flag; owns CALLBK/CBHOLD transition |

### 15.3 Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Unmapped `hangup_cause` codes drift as carriers add new causes | High | Low (defaults to `NA`) | `vici2_d04_hangup_unmapped_total{cause}` metric triggers operator alert; map JSON hot-reloadable without deploy |
| 3-layer merge produces incorrect picker render (bug in COALESCE ordering) | Medium | High (agent-side UX bug) | Fixture matrix of 9 cases in integration tests; SQL pinned in §3.2 and linted against live DB via EXPLAIN |
| `humanAnswered` flag misconfigured → wrong FCC drop-% | Medium | High (TCPA compliance / litigation) | Single canonical SQL in §8.2; `check-drop-rate-denominator.sh` CI grep blocks any alternative denominator in M08 |
| System status accidentally deleted | Low | High (originate path breaks) | `DELETE` endpoint rejects `campaign_id='__SYS__'`; `check-status-seed.sh` CI asserts exactly 35 system rows |
| `recycle_delay_seconds=-1` foot-gun — operator marks `B` terminal | Medium | Medium (campaign throughput drop) | M07 admin UI surfaces warning "X leads will be permanently blocked"; `vici2_d04_terminal_recycle_writes_total` metric |
| D05 `addInternal` interface changes after D04 IMPLEMENT | Low | Medium | Interface documented in HANDOFF.md; D05 owns backwards compatibility for internal callers |
| `GATEWAY_LIMIT_TRY_LATER` status code is 24 chars — exceeds VARCHAR(8) | Low | High (seed fails) | Status code = `GATEWAY_LIMIT_TRY_LATER` is 24 chars. **ACTION REQUIRED**: the F02 schema has `status VARCHAR(8)`. D04 must either truncate to `GTLMT` or request a schema amendment to widen the column to VARCHAR(32). **Recommended**: widen to VARCHAR(32) via D04 migration amendment; file RFC to F02 orchestrator before IMPLEMENT. |

---

End of PLAN.md.
