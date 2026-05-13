# D06 — Callback Scheduling — PLAN

| Field | Value |
|---|---|
| **Module** | D06 — scheduling, listing, firing, and dispositioning customer callbacks |
| **Author** | D06-PLAN sub-agent (Claude Sonnet 4.6) |
| **Date** | 2026-05-13 |
| **Status** | PROPOSED — awaiting orchestrator/human review |
| **Companion** | [RESEARCH.md](./RESEARCH.md) — 13 citations; full state machine + scope semantics |
| **Depends on (FROZEN)** | F02 schema (`callbacks` table, `CallbackStatus` enum); D01 PLAN §14.4 (lead service + `lead.status_changed`); D04 PLAN §8 (CBHOLD/CALLBK statuses, `recycle_delay_seconds=NULL` for both); C01 PLAN §2.1 (`Check()` discriminated union, `ALLOW/SKIP_UNTIL/BLOCK_INVALID`); F04 (Valkey lock contract `SET NX EX`); A03 (WS control plane) |
| **Blocks** | A04 (CB queue in manual dial panel), A05 (schedule-callback button), E01 Phase-2 hopper source C, E04 Phase-2 AGENT-scoped routing, S01 Phase-3 supervisor wallboard |

Once approved the following are **FROZEN**: REST endpoint paths and request/response shapes, state machine (4 states, 7 legal transitions, 5 illegal transitions), scope discriminator (`user_id IS NULL` = GLOBAL), TZ contract (UTC stored, lead-local displayed, fire-time TCPA gate), worker tick cadence (30 s), the three F02 campaign column names, Prometheus metric names, and the `api/src/callbacks/` + `workers/src/jobs/callback-fire/` package boundaries. Internal reducer logic, CSS, and log sampling may change without RFC.

---

## 0. TL;DR — 10-bullet decision summary

1. **D06 = a thin Node REST service + a Node worker.** The `callbacks` table already exists in F02; D06's work is the firing pipeline, scope semantics, TZ handling, grace-window policy, and three F02 campaign column amendments. Total surface: ~500 LOC service, ~300 LOC worker, ~400 LOC tests.
2. **Both GLOBAL and AGENT scopes ship Phase 1.** `user_id IS NULL` = GLOBAL (any campaign agent can claim); `user_id IS NOT NULL` = AGENT (assigned agent only). The F02 schema already supports this with no schema change. Phase-2-only: `callback_failover_seconds` (AGENT → GLOBAL after N hours if agent is offline).
3. **State machine: 4 states (`PENDING/LIVE/DONE/DEAD`), 7 legal transitions.** `PENDING→LIVE` (worker fires); `PENDING→DEAD` (cancel); `PENDING→PENDING` (snooze, callback_at rewritten); `LIVE→DONE` (dispo recorded); `LIVE→DEAD` (admin cancel, rare); `LIVE→PENDING` (no-answer + `reschedule_24h` policy); `PENDING→LIVE` is the only worker-originated transition. `DONE` and `DEAD` are terminal — re-scheduling requires a new row.
4. **TZ rule: store UTC, display in lead-local TZ, gate by TCPA in lead-local TZ at fire time.** Agent UI presents a picker defaulted to the lead's `tz_iana` (from D03). TCPA is warned at schedule time but enforced only at fire time (C01.Check() with `enforcementPoint='callback_fire'`). TCPA `SKIP_UNTIL` outcome re-snoozes the callback to `NextOpen`; `BLOCK_INVALID` promotes with a warning event.
5. **Worker tick: 30 s, `LIMIT 500`, Redis advisory lock per tenant.** Valkey `SET NX EX 60` on `t:{tid}:cron:lock:callback_fire`. CAS on `status='PENDING'` in the promote transaction makes it idempotent across pod crashes. Batch cap prevents 9-AM-Monday storms from starving the DB.
6. **Three F02 `campaigns` column amendments required.** `callback_no_answer_policy ENUM('leave_callbk','reschedule_24h','terminate_NA') DEFAULT 'leave_callbk'`; `callback_grace_window_seconds INT DEFAULT 30`; `callback_stale_threshold_seconds INT DEFAULT 14400`. No new tables; existing indexes cover all hot paths.
7. **Recycle-on-no-answer is campaign-configurable (policy column above).** Default `leave_callbk` (lead stays CALLBK, agent manually re-dials). `reschedule_24h` transitions the callback back to PENDING with `callback_at += 24h`. `terminate_NA` closes the callback DONE and lets D04's recycle-delay timer take over.
8. **Late callbacks are flagged stale, never auto-cancelled Phase 1.** Stale = `(NOW()-callback_at) > callback_stale_threshold_seconds` while LIVE. A 5-min cron tick emits `vici2.callback.stale` event + Prometheus counter (deduped via Valkey SET 1h TTL); supervisor toast is Phase-3 S01. Auto-DEAD policy is Phase-2 opt-in only.
9. **Reassignment is two flows + one bulk.** Agent self-claim (`POST /api/agent/callbacks/:id/claim`, CAS `updateMany`); supervisor single-reassign (`POST /api/admin/callbacks/:id/reassign`); bulk-reassign for offboarding (`POST /api/admin/callbacks/bulk-reassign`, one UPDATE + one audit row). All audit-logged.
10. **Phase 1 has no E01 hopper.** LIVE callbacks surface in the agent's "My Callbacks" UI panel (A04/A05) and admin global queue (M03 admin UI). The Phase-2 hopper hook is purely additive: E01 "Source C" picks `leads.status='CALLBK'` with `priority=10` bump; E04 routes AGENT-scoped calls to `leads.owner_user_id`.

---

## 1. Goals and non-goals

### 1.1 Phase 1 goals (this PLAN)

- Schedule callbacks (AGENT-scoped and GLOBAL) from A05 mid-call, A06 wrap-up dispo, and A04 preview mode.
- Fire due callbacks via a 30-second worker tick with TCPA gate + Redis idempotency lock.
- Surface fired callbacks in the agent "My Callbacks" panel and admin global queue.
- In-app WS notifications: 5-min pre-due heads-up and at-fire-time toast.
- Late-callback stale detection + Prometheus metrics.
- Reassignment and bulk-reassign (supervisor workflow).
- Three F02 `campaigns` column amendments for callback policy knobs.
- Lead status lifecycle: CBHOLD (PENDING) → CALLBK (LIVE) → disposition (DONE/DEAD).
- Full audit trail on every state transition.

### 1.2 Phase 2 (explicitly deferred)

- E01 hopper "Source C" integration (auto-dial instead of manual-surface).
- E04 AGENT-scoped routing (`leads.owner_user_id` picker).
- `callback_failover_seconds` (AGENT → GLOBAL after N hours if agent offline).
- Per-campaign `callback_stale_auto_dead_seconds` (auto-cancel stale callbacks).
- Partial-index `idx_callbacks_t_user_null_status` for GLOBAL admin-queue query plan (add if slow).
- WS pre-due notification for agents currently offline.

### 1.3 Non-goals (never in D06)

- DNC re-scrub at fire time (E01/T04's gate in Phase 2; agent manual-dial path calls D05 at dial time in Phase 1).
- Email or mobile-push agent notifications (Phase 4 / N01 webhook framework).
- Bulk-create endpoint (each callback is a per-interaction agreement; CSV import belongs to D02).
- `user_group`-scoped callbacks (Phase 3 / S03 supervisor module).
- The `ARCHIVE` pseudo-state mentioned in the original D06.md spec stub — the F02 `CallbackStatus` enum does not include it; soft-delete via `deleted_at` is a Phase-2 amendment if needed.

---

## 2. Schema review

### 2.1 `callbacks` table (F02, already exists)

```
id            BIGINT PK AUTO_INCREMENT
tenant_id     BIGINT FK → tenants
lead_id       BIGINT FK → leads
campaign_id   VARCHAR(32) FK → campaigns
user_id       BIGINT? FK → users   -- NULL = GLOBAL; NOT NULL = AGENT
callback_at   DATETIME(6)          -- stored UTC, no offset
comments      TEXT?
status        ENUM(LIVE,PENDING,DONE,DEAD) DEFAULT PENDING
created_by    BIGINT? FK → users
created_at    DATETIME(6)
updated_at    DATETIME(6)
```

Existing indexes are sufficient for Phase 1:
- `idx_callbacks_t_status_due (tenant_id, status, callback_at)` — worker tick.
- `idx_callbacks_t_user_due (tenant_id, user_id, callback_at)` — "my callbacks" list.
- `idx_callbacks_t_lead (tenant_id, lead_id)` — lead-join and cancel restoration.

No new columns on `callbacks` Phase 1. TCPA-warning context lives in `audit_events.details_json`, not a column.

### 2.2 F02 amendment: three new `campaigns` columns

**Amendment D06.A1 — `callback_no_answer_policy`**

```sql
ALTER TABLE campaigns
  ADD COLUMN callback_no_answer_policy
    ENUM('leave_callbk','reschedule_24h','terminate_NA')
    NOT NULL DEFAULT 'leave_callbk'
  AFTER recycle_delay_seconds;
```

Controls what happens when a CALLBK lead is dialed and the customer does not answer. Default `leave_callbk` = least surprise (leave lead in CALLBK, agent must re-schedule manually). `reschedule_24h` = auto-reschedule (LIVE→PENDING, `callback_at += 86400s`, capped to next TCPA-open window). `terminate_NA` = close the callback (LIVE→DONE) and expose the lead to D04's normal `NA` recycle-delay.

**Amendment D06.A2 — `callback_grace_window_seconds`**

```sql
ALTER TABLE campaigns
  ADD COLUMN callback_grace_window_seconds
    INT NOT NULL DEFAULT 30
  AFTER callback_no_answer_policy;
```

How many seconds before `callback_at` the worker is allowed to fire. Default 30 s. Semantic: fire callbacks due in `[now, now + grace_window]`. Compensates for worker-tick jitter; customer-facing impact is at most 30 s early (below the 2-minute perceptible-lateness threshold per Five9 UX research).

**Amendment D06.A3 — `callback_stale_threshold_seconds`**

```sql
ALTER TABLE campaigns
  ADD COLUMN callback_stale_threshold_seconds
    INT NOT NULL DEFAULT 14400
  AFTER callback_grace_window_seconds;
```

How old a LIVE callback must be (since `callback_at`) before it is flagged stale. Default 14400 s = 4 hours. Stale callbacks are not auto-cancelled Phase 1; they emit a metric and event only.

**Prisma additions** (in the `Campaign` model block, after `recycleDelaySeconds`):

```prisma
// D06 amendment D06.A1-A3 — callback policy knobs.
callbackNoAnswerPolicy      CallbackNoAnswerPolicy @default(leave_callbk) @map("callback_no_answer_policy")
callbackGraceWindowSeconds  Int                    @default(30)           @map("callback_grace_window_seconds")
callbackStaleThresholdSeconds Int                  @default(14400)        @map("callback_stale_threshold_seconds")
```

New enum (add to schema.prisma):

```prisma
enum CallbackNoAnswerPolicy {
  leave_callbk
  reschedule_24h
  terminate_NA
}
```

---

## 3. Scope model

### 3.1 Discriminator: `callbacks.user_id`

| `user_id` value | Scope | Semantics |
|---|---|---|
| `NULL` | **GLOBAL** | Any READY agent on the campaign may claim and dial. |
| `<user_id>` | **AGENT** | Only the assigned agent sees it in "My Callbacks"; worker fires it regardless of whether the agent is online. |

D06 does **not** persist a separate `scope` or `agent_only` boolean column. The API accepts an `agent_only: boolean` request field as a convenience sugar: `true` → `user_id = req.auth.uid`; `false` → `user_id = null`. Conflicting `agent_only: true` + `user_id: <other-user-id>` (non-self) is rejected with `400 invalid_scope`.

### 3.2 Scope-policy matrix

| Action | GLOBAL | AGENT |
|---|---|---|
| Visible in agent "My Callbacks" | No (global queue only) | Yes (assigned agent only) |
| Visible in admin queue | Yes | Yes (filterable by `user_id`) |
| Phase-1 dial path | Agent self-service from admin queue or claim | Agent sees in "My Callbacks" → manual dial |
| Phase-2 hopper | E01 picks; any READY agent | E04 routes to `leads.owner_user_id` |
| Self-claim | `POST /claim` CAS race | N/A (already pinned) |
| Re-scope | Supervisor only | Supervisor only |
| Cancel (agent self) | Supervisor only | Agent (their own) or supervisor |
| Failover to GLOBAL after timeout | N/A | **Phase 2** (`callback_failover_seconds`) |

### 3.3 Scope resolution at create time

```typescript
// api/src/callbacks/schemas.ts
const CreateCallbackBody = z.object({
  lead_id: z.coerce.bigint(),
  campaign_id: z.string().max(32),
  callback_at: z.string().datetime(),     // ISO-8601 with Z required
  agent_only: z.boolean().default(false),
  user_id: z.coerce.bigint().optional(),  // explicit override (supervisor only)
  comments: z.string().max(255).optional(),
});

// server-side resolution:
function resolveUserId(body, actor) {
  if (body.user_id != null) {
    requireRole(actor, 'supervisor');
    return body.user_id;
  }
  return body.agent_only ? actor.userId : null;
}
```

---

## 4. TZ handling

### 4.1 Storage

`callbacks.callback_at` is `DATETIME(6)` — stored as UTC with no offset. Application boundary enforces UTC: every write converts via `new Date(iso8601string).toISOString()` (Zod `z.string().datetime()` requires the `Z` suffix); every read serializes with `Z` suffix.

No `time_zone` column on `callbacks`. The lead's `tz_iana` (from `leads.known_timezone`, resolved by D03) is the authoritative customer-facing TZ and is joined at read time.

### 4.2 Write path (agent schedules)

1. Agent UI datetime picker defaults to the lead's `tz_iana`.
2. Browser constructs a `Date` with lead-local offset; serializes to `"YYYY-MM-DDTHH:mm:ss.sssZ"`.
3. API Zod schema validates strict ISO-8601 + `Z` suffix.
4. Stored as UTC `DATETIME(6)`.
5. API runs a TCPA dry-run check (`C01.Check()` with `enforcementPoint='callback_schedule'`); if outcome is `SKIP_UNTIL` or `BLOCK_INVALID`, response body includes `tcpa_warning: { outcome, next_open }`. The HTTP status is still 201 (schedule succeeds); the UI shows a yellow warning banner with "Schedule anyway" confirm.
6. Validation rejects: `callback_at < NOW() + 5 min` (minimum snooze), `callback_at > NOW() + 365 days` (Vicidial parity cap), `callback_at` in a DST-skip hour (picker rejects before submission).

### 4.3 Read path

API response for every callback includes:
```json
{
  "callback_at": "2026-05-19T23:00:00.000Z",
  "lead_tz_iana": "America/Los_Angeles",
  "tcpa_window_open": true
}
```
The UI renders `callback_at` in `lead_tz_iana` with an annotation "(your local: 4:00 PM EST)".

### 4.4 Fire path (worker tick)

Worker compares `callback_at` (UTC) ≤ `NOW() + grace_window_seconds` (UTC). No TZ arithmetic at fire-time comparison. TZ enters only in the C01 gate:

```
for each due callback:
  tcpa = C01.Check({ lead_tz_iana, state, when=NOW(), enforcementPoint='callback_fire' })
  if ALLOW      → promoteCallback()
  if SKIP_UNTIL → deferCallback(callback_id, tcpa.nextOpen)  // UPDATE callback_at = nextOpen
  if BLOCK_INVALID → promoteCallback() + emit 'vici2.callback.fired_with_warning'
```

### 4.5 DST transitions

Handled by D03 at browser-side TZ resolution. Spring-forward skip hours are rejected by the picker. Fall-back ambiguous hours resolve to the first occurrence. The worker operates in UTC throughout; no DST edge cases arise.

---

## 5. API endpoints

### 5.1 Agent endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/agent/callbacks` | Create a callback (schedule) |
| `GET` | `/api/agent/callbacks/mine` | List own PENDING + LIVE callbacks (cursor-paginated) |
| `POST` | `/api/agent/callbacks/:id/snooze` | Re-schedule (PENDING→PENDING, new `callback_at`) |
| `POST` | `/api/agent/callbacks/:id/cancel` | Cancel (PENDING→DEAD); restores lead.status if last PENDING |
| `POST` | `/api/agent/callbacks/:id/claim` | Claim a GLOBAL callback (CAS, 409 if race) |

### 5.2 Admin/supervisor endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/admin/callbacks` | List with filters: status, scope, user_id, campaign_id, due range, stale_only; cursor-paginated; default `[PENDING,LIVE]` |
| `GET` | `/api/admin/callbacks/aggregate` | Counts by scope/status/hour for wallboard |
| `POST` | `/api/admin/callbacks/:id/reassign` | Reassign to user or GLOBAL (`user_id: null`) |
| `POST` | `/api/admin/callbacks/bulk-reassign` | Offboarding: `{ from_user_id, to_user_id|null, scope: 'pending'|'all_non_terminal' }` |
| `POST` | `/api/admin/callbacks/bulk-cancel` | Cancel up to 500 by `{ ids }` |
| `GET` | `/api/admin/callbacks/export` | CSV export (admin only) |

### 5.3 RBAC matrix

| Endpoint | Agent (own) | Agent (other) | Supervisor | Admin |
|---|---|---|---|---|
| Create | ✓ (own user_id) | ✗ | ✓ (any user_id) | ✓ |
| `GET /mine` | ✓ | N/A | ✓ (own) | ✓ |
| Snooze | ✓ (user_id=self) | ✗ | ✓ | ✓ |
| Cancel | ✓ (user_id=self, PENDING only) | ✗ | ✓ | ✓ |
| Claim | ✓ (GLOBAL, CAS) | ✗ | ✓ | ✓ |
| Admin list | ✗ | ✗ | ✓ | ✓ |
| Reassign | ✗ | ✗ | ✓ | ✓ |
| Bulk-reassign | ✗ | ✗ | ✓ | ✓ |
| Export | ✗ | ✗ | ✗ | ✓ |

### 5.4 Request / response shapes

**`POST /api/agent/callbacks` — create**

```typescript
// Request body
{
  lead_id: bigint;
  campaign_id: string;        // defaults to lead's active campaign server-side if omitted
  callback_at: string;        // ISO-8601 + Z required
  agent_only: boolean;        // default false (GLOBAL)
  user_id?: bigint;           // explicit override (supervisor only)
  comments?: string;          // max 255 chars
}

// 201 Created response
{
  id: bigint;
  status: 'PENDING';
  callback_at: string;
  lead_tz_iana: string;
  scope: 'GLOBAL' | 'AGENT';
  tcpa_warning?: { outcome: 'SKIP_UNTIL' | 'BLOCK_INVALID'; next_open?: string; reason?: string };
}
```

**`GET /api/agent/callbacks/mine`** returns cursor page of `Callback` objects with joined `lead` (name, phone, tz_iana) and `tcpa_window_open` bool.

**`POST /api/admin/callbacks/bulk-reassign`**

```typescript
{
  from_user_id: bigint;
  to_user_id: bigint | null;    // null = push to GLOBAL
  scope: 'pending' | 'all_non_terminal';
}
// 200 { reassigned: number }
```

---

## 6. Firing pipeline

### 6.1 Worker location and runtime

`workers/src/jobs/callback-fire/index.ts`. Node 20 LTS + pino + Prisma. Long-running process, `setInterval(tick, 30_000)`, graceful SIGTERM shutdown.

### 6.2 Main tick (every 30 s per tenant)

```typescript
// Pseudocode — workers/src/jobs/callback-fire/tick.ts
async function callbackFireTick(tenantId: bigint): Promise<TickResult> {
  const locked = await valkey.set(
    `t:${tenantId}:cron:lock:callback_fire`,
    instanceId,
    { EX: 60, NX: true }
  );
  if (!locked) return { skipped: true, reason: 'lock_contention' };

  try {
    const { callbackGraceWindowSeconds } = await getCampaignSettings(tenantId);
    const due = await prisma.callback.findMany({
      where: {
        tenantId,
        status: 'PENDING',
        callbackAt: { lte: new Date(Date.now() + callbackGraceWindowSeconds * 1000) },
      },
      orderBy: { callbackAt: 'asc' },
      take: 500,
      include: { lead: true },
    });

    let fired = 0, deferred = 0, errors = 0;
    for (const cb of due) {
      const tcpa = await tcpaCheck({ lead: cb.lead, when: new Date(), enforcementPoint: 'callback_fire' });
      if (tcpa.outcome === 'ALLOW' || tcpa.outcome === 'BLOCK_INVALID') {
        await promoteCallback(cb, tcpa.outcome === 'BLOCK_INVALID' ? tcpa.reason : undefined);
        fired++;
      } else {  // SKIP_UNTIL
        await deferCallback(cb.id, tcpa.nextOpen);
        deferred++;
      }
    }
    return { fired, deferred, errors };
  } finally {
    await valkey.del(`t:${tenantId}:cron:lock:callback_fire`);
  }
}
```

### 6.3 `promoteCallback()` — atomic PENDING → LIVE

Single Prisma `$transaction`:
1. `UPDATE callbacks SET status='LIVE' WHERE id=? AND status='PENDING'` (CAS — P2025 on miss = idempotent skip).
2. `UPDATE leads SET status='CALLBK', modify_at=NOW() [, owner_user_id=? if AGENT-scoped]`.
3. `INSERT audit_events (action='callback.fired', actor='D06_worker', details_json={scope,warning?})`.

After-commit (non-transactional):
4. Publish `vici2.callback.fired.{agent|global}` to Valkey Stream.
5. If AGENT-scoped and agent is online: push `{type:'callback_due', ...}` on `t:{tid}:ws:user:{uid}`.

### 6.4 Pre-due heads-up tick (every 60 s)

```sql
SELECT id, lead_id, user_id, callback_at
FROM callbacks
WHERE tenant_id = ?
  AND status = 'PENDING'
  AND callback_at BETWEEN NOW() + INTERVAL 4 MINUTE AND NOW() + INTERVAL 5 MINUTE
```

For each AGENT-scoped row where the agent is online (Valkey `t:{tid}:agent:status:{uid}` ∈ {READY, PAUSED, INCALL, WRAPUP}): push `{type:'callback_upcoming', ...}`. Dedup via `t:{tid}:d06:upcoming_seen:{callback_id}` SET with 5-min TTL. Lock key: `t:{tid}:cron:lock:callback_upcoming`.

### 6.5 Phase 2 hopper hook (additive, no Phase 1 deletion)

When E01 ships: E01 "Source C" filler queries `leads WHERE status='CALLBK'`. For AGENT-scoped: `leads.owner_user_id IS NOT NULL`, E04 routes to that agent. Priority: `hopper_mirror.priority = 10` (vs 0 for standard leads). D06 code is unchanged; the integration is purely in E01/E04.

---

## 7. UI integration

### 7.1 A05 — mid-call schedule-callback button

A05 action bar button `Ctrl+B` opens `<CallbackSchedulerPopover>`. On submit: `POST /api/agent/callbacks` with `{ lead_id, callback_at (ISO+Z), agent_only, comments, campaign_id }`. Response updates `useCallStore` with callback metadata; dispo overlay pre-checks "Schedule callback."

### 7.2 A06 — disposition overlay (wrap-up)

If agent selects `CALLBK` disposition status: the overlay requires a `callback_at` and shows the scheduler inline. Submit of the dispo form also fires `POST /api/agent/callbacks` (server atomically creates the callback + updates the lead status). `callback_at` is required when dispo=CALLBK; `400 callback_at_required` if missing.

### 7.3 A04 — manual dial, preview mode

A04's Preview Dial panel shows a "Schedule Callback" action alongside Skip/DNC. Uses the same `POST /api/agent/callbacks` endpoint. A04's "My Callbacks" tab lists `GET /api/agent/callbacks/mine` with `status=LIVE` first, then `status=PENDING`.

### 7.4 Admin queue (M03)

Global callback queue: `GET /api/admin/callbacks?scope=GLOBAL&status[]=PENDING&status[]=LIVE`. Admin can dispatch (assign to agent via reassign endpoint) or bulk-reassign for offboarding.

---

## 8. Late callback detection

### 8.1 Stale definition

A callback is **stale** when:
- `status = 'LIVE'` AND `(NOW() - callback_at) > campaigns.callback_stale_threshold_seconds` (default 4 h), OR
- `status = 'PENDING'` AND `(NOW() - callback_at) > callback_stale_threshold_seconds` (worker has missed it — indicates a system problem).

### 8.2 Stale detection tick (every 5 min)

```sql
SELECT id, user_id, campaign_id,
       TIMESTAMPDIFF(SECOND, callback_at, NOW()) AS age_seconds
FROM callbacks
WHERE tenant_id = ?
  AND status IN ('LIVE', 'PENDING')
  AND callback_at < NOW() - INTERVAL <stale_threshold> SECOND
```

For each row:
1. Emit `vici2_d06_callback_stale_total{scope, age_bucket}` (age_bucket ∈ `4-8h | 8-24h | 1-3d | 3d+`).
2. Publish `vici2.callback.stale` event (deduped via `t:{tid}:d06:stale_seen:{callback_id}` SET 1h TTL).
3. Phase 1: log only. Phase 3: S01 supervisor toast.

### 8.3 No auto-cancel Phase 1

Auto-DEAD was Vicidial's default and operators consistently hated it (callbacks may still be worth placing even 8+ hours late). Phase 2 adds `campaigns.callback_auto_dead_seconds` (default NULL = never), which enables the stale-detection tick to also UPDATE `status='DEAD'` for rows exceeding the threshold.

---

## 9. Reassignment workflow

### 9.1 Self-claim (GLOBAL → AGENT pin)

`POST /api/agent/callbacks/:id/claim` — CAS via `updateMany WHERE user_id IS NULL AND status IN ('PENDING','LIVE')`. `affected=0` → lookup existing row → `409 already_claimed { claimed_by }` or `409 callback_terminal`. Writes `audit_events('callback.claimed')` and publishes `vici2.callback.claimed`.

### 9.2 Supervisor single-reassign

`POST /api/admin/callbacks/:id/reassign` body `{ user_id: bigint | null }`. Validates target user exists + belongs to tenant. Updates `user_id`. Writes audit. Requires `callback:reassign` permission (supervisor or admin per F05).

### 9.3 Bulk-reassign (offboarding)

`POST /api/admin/callbacks/bulk-reassign`:
1. `findMany` candidate IDs (filtered by `from_user_id` and `scope`).
2. Single `$transaction([updateMany(...), auditEvent.create(...)])` — one UPDATE + one bulk audit row (not per-callback).
3. Returns `{ reassigned: count }`.

This handles the #1 supervisor offboarding request: when an agent departs, push all their PENDING/LIVE callbacks to GLOBAL (`to_user_id=null`) or to a replacement agent.

---

## 10. Notification

### 10.1 In-app WS notifications (Phase 1 only)

| Event | Trigger | Recipient | Channel |
|---|---|---|---|
| `callback_upcoming` | 5-min pre-due cron tick | Assigned agent (AGENT-scoped only) | `t:{tid}:ws:user:{uid}` |
| `callback_due` | Worker `promoteCallback()` after-commit | Assigned agent (AGENT-scoped only) | `t:{tid}:ws:user:{uid}` |

UI behavior for `callback_due`:
- Sonner toast: "Callback due: {lead_name} — {lead_phone} — '{comments}'". Persists 30 s.
- Badge increment on "My Callbacks" panel.
- Optional audio cue (per-agent user preference, `useUiStore.callbackAudioCue`).

### 10.2 Supervisor aggregate

`GET /api/admin/callbacks/aggregate?campaignId=&horizonHours=24` returns:
```json
{
  "total_pending": 42,
  "total_live": 7,
  "by_scope": { "global": 12, "agent": 37 },
  "by_hour": [{ "hour_utc": "...", "count": 8 }],
  "stale_count": 3,
  "upcoming_5min": 2
}
```

### 10.3 No email/push Phase 1

WS-only. Email + mobile push deferred to Phase 4 (N01 webhook framework).

---

## 11. Recycle on no-answer

### 11.1 Trigger

Agent (or Phase-2 E04 hopper) dials a CALLBK lead; customer does not answer; T04 dispositions the call as `NA-CAR`. D04's `dispositionService.submit()` checks `leads.status === 'CALLBK'` and calls `D06.onNoAnswer(callbackId, campaignNoAnswerPolicy)`.

### 11.2 Policy dispatch

| Policy | `callbacks.status` after | `leads.status` after | Notes |
|---|---|---|---|
| `leave_callbk` (default) | `LIVE` (unchanged) | `CALLBK` (unchanged) | Agent manually re-dials or re-schedules. |
| `reschedule_24h` | `PENDING` (callback_at += 86400s, capped to next TCPA-open window) | `CBHOLD` | Worker re-fires at new time. Writes `audit_events('callback.rescheduled')`. |
| `terminate_NA` | `DONE` | `NA` | Callback closed; standard D04 recycle-delay (`recycle_delay_seconds`) governs re-dial. |

### 11.3 State machine impact

`LIVE→PENDING` (reschedule path) is the only non-terminal backward transition. It is owned by the disposition handler (A06→D04→D06 hook), not the worker. The worker CAS on `status='PENDING'` naturally handles a re-queued callback on the next tick.

---

## 12. Files to create

```
api/src/callbacks/
  schemas.ts              — Zod: CreateCallbackBody, SnoozeBody, ReassignBody, BulkReassignBody
  service.ts              — callbacks service: CRUD, claim, reassign, bulk-reassign, onNoAnswer
  state-machine.ts        — transition guard + side-effect orchestration (lead status, audit, event)
  notifications.ts        — WS notify helpers (dispatched to A03 ws plugin)
  audit.ts                — action catalog: callback.scheduled / snoozed / fired / cancelled / ...
  events.ts               — after-commit publishAfterCommit('vici2.callback.*')
  rbac.ts                 — own-vs-supervisor helpers
  handlers/
    agent/
      schedule.ts         — POST /api/agent/callbacks
      mine.ts             — GET /api/agent/callbacks/mine
      snooze.ts           — POST /api/agent/callbacks/:id/snooze
      cancel.ts           — POST /api/agent/callbacks/:id/cancel
      claim.ts            — POST /api/agent/callbacks/:id/claim
    admin/
      list.ts             — GET /api/admin/callbacks
      aggregate.ts        — GET /api/admin/callbacks/aggregate
      reassign.ts         — POST /api/admin/callbacks/:id/reassign
      bulk-reassign.ts    — POST /api/admin/callbacks/bulk-reassign
      bulk-cancel.ts      — POST /api/admin/callbacks/bulk-cancel
      export.ts           — GET /api/admin/callbacks/export
  index.ts                — Fastify plugin: route registration

workers/src/jobs/callback-fire/
  index.ts                — setInterval 30s loop + SIGTERM handler
  tick.ts                 — single-tick algorithm (Valkey lock + batch query)
  promote.ts              — PENDING→LIVE atomic helper ($transaction + after-commit)
  defer.ts                — TCPA SKIP_UNTIL re-snooze (UPDATE callback_at)
  upcoming.ts             — pre-due heads-up tick (60s, 4-5min window)
  stale.ts                — stale-detection tick (every 5min)
  metrics.ts              — Prom counters (see §14.5)

shared/types/src/
  callback.ts             — public Callback Zod schema + TypeScript types

shared/events/
  callback-events.json    — JSON Schema for vici2.callback.* stream payloads

api/prisma/migrations/<timestamp>_d06_campaign_callback_columns/
  migration.sql           — D06.A1/A2/A3 ALTER TABLE campaigns + enum

api/test/callbacks/
  state-machine.test.ts   — 14 transition cases (§13.1)
  schedule.test.ts        — create + validation edge cases
  worker.test.ts          — tick idempotency, multi-pod lock, TCPA gate
  reassign.test.ts        — claim race, bulk-reassign, lead-status restoration

workers/test/callback-fire/
  tick.test.ts            — integration tests against real MySQL 8 + Valkey
```

---

## 13. Test plan

### 13.1 Unit tests (vitest)

**State machine (14 cases):** 7 legal transitions × assert status flip + audit row + event emit + lead.status side effect. 5 illegal transitions → assert HTTP 409 with correct error code. 2 idempotent self-loops (snooze, claim already-mine).

**Validation:**
- `callback_at < NOW() + 5min` → reject `400 callback_too_soon`.
- `callback_at > NOW() + 365 days` → reject `400 callback_too_far`.
- `agent_only=true` + explicit `user_id=other` → reject `400 invalid_scope`.
- DST-skip hour → reject (picker-level; server validates ISO string is parseable).

**TZ conversion:** agent EDT picks "Tue 3:00 PM lead-PST" → assert stored UTC = `Tue 23:00:00Z`.

**Scope resolution:** `agent_only=true` → `user_id=req.auth.uid`; `agent_only=false` → `user_id=null`.

**CAS claim:** concurrent claim races (mock) → assert exactly 1 success + 1 `409 already_claimed`.

**Lead-status restoration on cancel:**
- Cancel last PENDING → lead.status restored to pre-CBHOLD value from audit chain.
- Cancel one of two PENDING → lead.status unchanged (still CBHOLD).

**Stale detection:** rows with age > threshold flagged; rows with age < threshold ignored.

**Worker promoteCallback:** PENDING→LIVE atomic; `leads.status=CALLBK`; audit row present; WS notify fires for AGENT-scoped only.

### 13.2 Integration tests (vitest + testcontainers — real MySQL 8 + Valkey)

- End-to-end: schedule → advance clock → worker tick → assert LIVE → simulate dispo → assert DONE.
- Worker idempotency: re-run tick same minute → no double-fire (CAS guard).
- Multi-pod lock: spawn 2 worker instances → assert only 1 fires per tick.
- TCPA-defer: fire-time outside window → assert `callback_at` re-snoozed to `NextOpen`; no promote.
- Bulk-reassign 1000 rows → assert 1 UPDATE + 1 audit row; completes < 1 s.
- Self-claim race: 10 concurrent claims → 1 success + 9 `409`.
- Lead-status restore: cancel last PENDING → lead.status = pre-callback status from audit.
- `reschedule_24h` policy: simulate no-answer → callback LIVE→PENDING, lead CALLBK→CBHOLD, callback_at += 86400s.

### 13.3 Performance targets (k6, O03 entrypoint)

| Endpoint / job | p95 target | Hard ceiling |
|---|---|---|
| `POST /api/agent/callbacks` | 80 ms | 200 ms |
| `GET /api/agent/callbacks/mine` | 50 ms | 150 ms |
| Snooze / cancel | 80 ms | 200 ms |
| Claim | 80 ms | 200 ms |
| `GET /api/admin/callbacks` (50 rows) | 200 ms | 500 ms |
| Bulk-reassign 1000 rows | 1.5 s | 5 s |
| Worker tick (500 due callbacks) | 5 s | 30 s |
| Pre-due tick | 1 s | 5 s |
| Stale-detection tick | 2 s | 10 s |

### 13.4 Compliance tests (CI-gated)

- Audit trail completeness: every state transition has a matching `audit_events` row (CI grep).
- TCPA at fire time: synthetic test forces fire-time blackout → assert `SKIP_UNTIL` re-schedule; assert `promoteCallback` is NOT called.
- No-secrets rule: pino log lines never contain customer phone in bulk arrays (CI grep).
- A1/A2/A3 migration columns present: CI db-smoke test asserts `SHOW COLUMNS FROM campaigns` includes all three.

### 13.5 Run commands

```bash
make test-callbacks                       # unit + integration
cd api && pnpm exec vitest run test/callbacks
cd workers && pnpm exec vitest run test/callback-fire
make perf-callbacks                       # k6 scenarios (O03 entrypoint)
```

---

## 14. Prometheus metrics

Emitted by D06 service and worker:

| Metric | Labels | Owner |
|---|---|---|
| `vici2_d06_callback_scheduled_total` | `scope` | service |
| `vici2_d06_callback_fired_total` | `scope, tcpa_outcome` | worker |
| `vici2_d06_callback_deferred_total` | `reason` | worker |
| `vici2_d06_callback_cancelled_total` | `actor` | service |
| `vici2_d06_callback_snoozed_total` | — | service |
| `vici2_d06_callback_completed_total` | `disposition` | service |
| `vici2_d06_callback_stale_total` | `scope, age_bucket` | worker (stale tick) |
| `vici2_d06_worker_tick_duration_seconds` | — (histogram) | worker |
| `vici2_d06_worker_tick_promoted` | `outcome={fired,deferred,error}` | worker |
| `vici2_d06_worker_tick_skipped_total` | `reason={lock_contention,empty}` | worker |
| `vici2_d06_bulk_reassign_total` | `outcome` | service |
| `vici2_d06_claim_race_total` | `outcome={won,lost}` | service |

---

## 15. Acceptance criteria

All of the following must pass before D06 IMPLEMENT is considered complete:

- [ ] `POST /api/agent/callbacks` creates a row with `status=PENDING` and sets `leads.status=CBHOLD` (if no prior PENDING exists for the lead). Response includes TCPA warning when applicable.
- [ ] AGENT-scoped callback appears in `GET /api/agent/callbacks/mine` for the assigned agent; does not appear for other agents.
- [ ] GLOBAL callback appears only in `GET /api/admin/callbacks` (not in any agent's `/mine`).
- [ ] Worker fires a PENDING callback within ≤ 60 s of `callback_at` (worst case: one 30-s tick overshoot).
- [ ] `promoteCallback` is atomic: crashing mid-transaction leaves no inconsistency; re-run tick skips the already-LIVE row.
- [ ] A TCPA-blocked fire time re-snoozes to `NextOpen`; no originate attempt is made.
- [ ] Cancel of the last PENDING callback for a lead restores `leads.status` to the pre-CBHOLD value.
- [ ] Cancel of one of multiple PENDING callbacks does not change `leads.status`.
- [ ] Self-claim CAS: exactly one winner when N agents race to claim the same GLOBAL callback; all others receive `409 already_claimed`.
- [ ] Bulk-reassign 1000 rows: single UPDATE statement + single audit row; completes < 5 s p95.
- [ ] `callback_no_answer_policy=reschedule_24h`: no-answer disposition on a CALLBK lead → callback LIVE→PENDING, lead CALLBK→CBHOLD, `callback_at` advanced 24 h.
- [ ] Stale callback (> 4 h after `callback_at`, still LIVE) emits `vici2_d06_callback_stale_total` metric and `vici2.callback.stale` event. Is NOT auto-cancelled.
- [ ] WS `callback_due` notification delivered to AGENT-scoped assigned agent within 30 s of fire; not delivered for GLOBAL callbacks.
- [ ] WS `callback_upcoming` delivered 4–5 min before `callback_at` for online AGENT-scoped agents; deduped (not repeated every 60 s).
- [ ] All 12 Prometheus metrics are registered and emit at least one sample in the integration test.
- [ ] Three F02 migration columns (`callback_no_answer_policy`, `callback_grace_window_seconds`, `callback_stale_threshold_seconds`) present in `campaigns` table after migration.
- [ ] All state transitions write an `audit_events` row with correct `action`, `actor_kind`, `target_kind`, `details_json`.
- [ ] axe-core zero AA violations on the "My Callbacks" panel (A04/A05 UI integration).
- [ ] `make test-callbacks` passes in CI with MySQL 8 + Valkey testcontainers.
- [ ] Worker tick p95 ≤ 30 s for 500 due callbacks (k6 gate).

---

## 16. Dependencies and risks

### 16.1 Hard dependencies (must be FROZEN before D06 IMPLEMENT)

| Dependency | Why needed |
|---|---|
| F02 schema (`callbacks` table, `CallbackStatus` enum, `Callback` Prisma model) | Table already exists; no schema work needed for the table itself. |
| D04 PLAN §8 (CBHOLD + CALLBK statuses, `recycle_delay_seconds=NULL`) | D06 transitions leads through these statuses; must not conflict. |
| C01 PLAN §2.1 (`Check()` interface + `enforcementPoint` enum) | D06 worker calls `C01.Check()` with `enforcementPoint='callback_fire'`. C01 must accept this enforcement point (small C01 amendment). |
| D01 PLAN §14.4 (lead service + `lead.status_changed` event) | D06 updates `leads.status` via D04's writer. |
| A03 (WS control plane) | D06 uses `wsNotify()` for at-fire and pre-due notifications. |
| F04 (Valkey lock contract) | Worker uses `t:{tid}:cron:lock:callback_fire` SET NX EX 60 pattern. |

### 16.2 Soft dependencies (D06 provides interface; other modules consume)

| Consumer | Interface provided |
|---|---|
| A05 (mid-call schedule button) | `POST /api/agent/callbacks` |
| A04 (preview mode + My Callbacks tab) | `POST /api/agent/callbacks`, `GET /api/agent/callbacks/mine` |
| A06 (dispo overlay, CALLBK status) | `POST /api/agent/callbacks` (called from dispo submit) |
| E01 Phase 2 (hopper Source C) | `leads.status='CALLBK'` + `leads.owner_user_id` |
| E04 Phase 2 (AGENT-scoped routing) | `leads.owner_user_id` from `promoteCallback` |
| S01 Phase 3 (supervisor wallboard) | `GET /api/admin/callbacks/aggregate` |

### 16.3 Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| TZ confusion: agent browser TZ ≠ lead-local TZ | High | High | UI picker defaults to lead's `tz_iana`; explicit "(your local: X)" annotation; worker uses lead TZ at TCPA gate. |
| Callback storm (1000+ callbacks due at 9 AM Monday) | Medium | Medium | Batch cap 500/tick; oldest-first; two ticks = 1000 callbacks/min. Worst-case lateness: 30 s. |
| Worker crash mid-promote (callback LIVE, lead.status unchanged) | Low | Medium | Single `$transaction` wraps both updates; CAS on `status='PENDING'` makes re-run idempotent. |
| Multi-pod double-fire (no lock) | Low | High | Valkey `SET NX EX 60` advisory lock per tenant per tick; explicit integration test. |
| AGENT-scoped callback rots (agent offline) | Medium | Medium | Phase 1: stale metric + supervisor visibility. Phase 2: opt-in `callback_failover_seconds`. |
| TCPA blackout at fire time → callback never fires | Medium | High | Worker SKIP_UNTIL auto-re-snoozes to `NextOpen`; emits `vici2.callback.tcpa_deferred`. |
| Cancel of one of N PENDING callbacks incorrectly restores lead.status | Medium | Low | Explicit `COUNT(*) WHERE lead_id=? AND status='PENDING' AND id != ?` check before restore; integration test. |
| F02 amendment (D06.A1-A3) delayed | Low | Medium | Phase 1 ships with `leave_callbk` hard-coded if columns are absent; admin toggle shows disabled. |
| Phase 1 CALLBK leads have no auto-dial path (no E01) | High | Low (Phase 1) | Admin and agent "My Callbacks" UI surfaces them explicitly; manual-dial flow (A04) is the dialer. |
| DNC change between schedule and fire time not caught Phase 1 | Medium | Low | Documented limitation; agent manual-dial path calls D05 at dial time; E01 hopper (Phase 2) scrubs DNC. |

### 16.4 C01 micro-amendment required

C01's `EnforcementPoint` enum (C01 PLAN §2.1) must include `'callback_fire'` and `'callback_schedule'`. This is a 2-line addition to C01's type definitions + CSV seed. D06 IMPLEMENT should file this as a C01 amendment request before starting the worker.

---

*End of D06 PLAN — spec/modules/D06/PLAN.md*
