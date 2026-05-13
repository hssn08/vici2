# I04 — Inbound Callback Queue — PLAN

| Field | Value |
|---|---|
| **Module** | I04 — Inbound callback queue ("press 1 to receive a callback") |
| **Author** | I04-PLAN sub-agent (Claude Sonnet 4.6, 1M ctx) |
| **Date** | 2026-05-13 |
| **Status** | PROPOSED — awaiting orchestrator/human review |
| **Companion** | [RESEARCH.md](./RESEARCH.md) — 10 sections, 7 open questions |
| **Phase** | 3 (Inbound/Blended) |
| **Depends on (FROZEN)** | F02 schema (`callbacks` table, `CallbackStatus` enum); D06 PLAN (state machine, worker tick, scope model); I01 PLAN §11 (callback_offer overflow action, queue_position_at_offer, `/internal/queue/exit_callback`); I02 PLAN §4.5 + §15.3 (terminal_callback node, eslbridge HANGUP_COMPLETE handler, `/internal/ivr/callback_accept`); E04 PLAN (Originator interface for outbound call); C01 PLAN §2.1 (`Check()` interface, `callback_fire` enforcement point); F04 (Valkey lock contract `SET NX EX`) |
| **Blocks** | A04/A05/A06 (INBOUND_CALLBACK badge); Admin callbacks list (`source=INBOUND` filter); I01 dispatcher extension (callback-gap fill) |

Once approved the following are **FROZEN**: the `source` enum values (`AGENT/GLOBAL/INBOUND`), the three new `callbacks` columns (`source`, `original_ingroup_id`, `callback_number`, `original_wait_seconds`, `fired_at`), the Valkey lock key pattern for callback fire, the TCPA/consent-mode audit field (`INBOUND_CALLBACK_REQUESTED`), and the `GET /api/inbound-callbacks/queue/:ingroupId` endpoint path. Internal dispatcher heuristics, badge CSS, and log sampling may change without RFC.

---

## 0. TL;DR — 10-bullet decision summary

1. **I04 = schema amendments + two entry paths + dispatcher extension.** No new standalone service. I04 extends the D06 `callbacks` table (5 new columns), extends the I01 in-group dispatcher to fire inbound callbacks when no live calls are waiting, and adds `source=INBOUND` to distinguish inbound callbacks from D06 AGENT/GLOBAL callbacks. Total new LOC: ~400 LOC backend + ~300 LOC worker extension + ~200 LOC UI badge.

2. **Two entry paths produce identical rows.** Path A (I01 queue offer): after `callback_offer_after_seconds` the dispatcher plays a DTMF offer; if caller presses 1, `/internal/queue/exit_callback` is extended to write `source=INBOUND`. Path B (I02 IVR terminal_callback): eslbridge HANGUP_COMPLETE handler calls `/internal/ivr/callback_accept`; that endpoint is extended to also write `source=INBOUND`. Both produce the same row shape; the firing logic is identical.

3. **No new table. Five additive columns on `callbacks`.** `source ENUM`, `original_ingroup_id VARCHAR(32)`, `original_wait_seconds INT UNSIGNED`, `callback_number VARCHAR(20)`, `fired_at DATETIME(6)`. The D06 state machine (PENDING → LIVE → DONE/DEAD), worker tick cadence (30 s), and TCPA gate are inherited without modification.

4. **ASAP-only Phase 1. No customer-selected time.** `callbacks.callback_at = NOW()` for all inbound callbacks; grace-window makes them immediately eligible. Preserve-position sorting is by `queue_position_at_offer ASC` within the same `original_ingroup_id`. Scheduled-time callbacks (customer selects "call me tomorrow at 2 PM") are Phase 2.

5. **Firing by the I01 dispatcher, not E04.** When a READY agent is available for an in-group and the live queue is empty, the dispatcher checks for PENDING INBOUND callbacks for that in-group. This integrates naturally with the I01 per-in-group loop. The callback call itself is an outbound originate (same Originator interface as E04), bridged into the agent's T03 conference like any other call.

6. **TCPA at fire time is mandatory.** Express consent (customer pressed 1) covers the substance of the call but NOT the time window. C01.Check() with `enforcementPoint='callback_fire'` must return ALLOW. SKIP_UNTIL re-snoozes to `nextOpen`; there is no override. Consent mode `INBOUND_CALLBACK_REQUESTED` is recorded in `originate_audit`.

7. **Callback number is the number to dial, not the lead's stored phone.** `callbacks.callback_number` stores the ANI or DTMF-entered number. Originates use `callback_number`; TCPA TZ lookup uses `callback_number`'s area code (D03). Lead phone is only used as fallback if `callback_number IS NULL`.

8. **Internal DNC bypassed for this one call; National DNC not bypassed.** The customer's explicit press-1 request overrides the internal DNC list for this single call. The National DNC is never bypassed. Both decisions are logged in `originate_audit.details_json`.

9. **Agent UI shows INBOUND CALLBACK badge with context.** `source=INBOUND` callbacks render a distinct orange badge in A04/A05/A06 showing original wait time and queue position. This is a UI extension (no new component — augments the existing callback card). `direction='inbound_callback'` in `call_log` for correct in-group AHT attribution.

10. **Phase 2 deferred items:** customer-selected callback time; DTMF number override (`dtmf_optional` / `dtmf_required` modes — Phase 1 ships ANI-only); TCPA Reassigned Numbers Database (RND) scrub; international compliance gate; per-agent callback blending; WS pre-due notification for inbound callbacks (low value — ASAP callbacks fire quickly).

---

## 1. Goals and non-goals

### 1.1 Phase 1 goals (this PLAN)

| Goal | Detail |
|---|---|
| G1 | Accept callback opt-in from the I01 queue offer (Path A) and write `source=INBOUND` callback row |
| G2 | Accept callback opt-in from the I02 IVR `terminal_callback` node (Path B) and write `source=INBOUND` callback row |
| G3 | Extend I01 in-group dispatcher to check for pending INBOUND callbacks when live queue is empty |
| G4 | Fire INBOUND callbacks: originate outbound call to `callback_number` from in-group's outbound CLI; bridge into agent T03 conference |
| G5 | Gate all fire attempts through C01.Check() with `enforcementPoint='callback_fire'`; re-snooze on SKIP_UNTIL |
| G6 | Record `consent_mode=INBOUND_CALLBACK_REQUESTED` and DNC-bypass in `originate_audit` |
| G7 | Preserve-position ordering: INBOUND callbacks sorted by `queue_position_at_offer ASC` within same `original_ingroup_id` |
| G8 | Agent UI badge: orange "INBOUND CALLBACK" badge with original wait time and queue position |
| G9 | `GET /api/inbound-callbacks/queue/:ingroupId` — supervisor view of pending inbound callbacks for an in-group |
| G10 | New metric suite (`vici2_i04_*`) + Prometheus alert for INBOUND callbacks stale > 30 min |

### 1.2 Phase 2 deferred

- Customer-selected callback time (DTMF "press 2 to select a time")
- DTMF callback number override modes (`dtmf_optional`, `dtmf_required`)
- TCPA Reassigned Numbers Database (RND) scrub before fire
- International compliance gate (non-US numbers)
- `callback_failover_seconds` for inbound callbacks (auto-DEAD if not fired within N hours)
- WS pre-due notification for INBOUND callbacks (ASAP callbacks fire quickly; low value)
- Callback SLA dashboard (P50/P95 time-to-fire per in-group)

### 1.3 Non-goals (never in I04)

- Customer-facing self-service "cancel my callback" (phone/web portal) — Product decision; not in scope
- Predictive callback dialing (I04 fires callbacks one at a time; predictive over-dial for callbacks is T04/E04 territory)
- Email or SMS confirmation to customer after callback acceptance (N01 webhook, Phase 4)
- Blended agent serving inbound + outbound simultaneously (architectural; Phase 4)

---

## 2. Schema amendments

### 2.1 New columns on `callbacks`

Five additive columns; no existing column renamed or removed. Migration: `api/prisma/migrations/20260513260000_i04_inbound_callback/migration.sql`.

```sql
ALTER TABLE callbacks
  ADD COLUMN source
    ENUM('AGENT','GLOBAL','INBOUND')
    NOT NULL DEFAULT 'AGENT'
    COMMENT 'AGENT = D06 agent-scoped; GLOBAL = D06 global; INBOUND = I04 inbound queue callback'
    AFTER status,

  ADD COLUMN original_ingroup_id
    VARCHAR(32) NULL
    COMMENT 'FK: ingroups.id for the in-group that offered the callback (INBOUND only)'
    AFTER source,

  ADD COLUMN original_wait_seconds
    INT UNSIGNED NULL
    COMMENT 'Seconds caller waited in queue before accepting callback offer (INBOUND only)'
    AFTER original_ingroup_id,

  ADD COLUMN callback_number
    VARCHAR(20) NULL
    COMMENT 'E.164 or 10-digit NANP number to call back (may differ from lead.phone; INBOUND only)'
    AFTER original_wait_seconds,

  ADD COLUMN fired_at
    DATETIME(6) NULL
    COMMENT 'Timestamp when callback was successfully originated (PENDING→LIVE transition)'
    AFTER callback_number;
```

New FK and index:

```sql
ALTER TABLE callbacks
  ADD CONSTRAINT fk_callbacks_ingroup
    FOREIGN KEY (tenant_id, original_ingroup_id)
    REFERENCES ingroups(tenant_id, id)
    ON DELETE SET NULL ON UPDATE NO ACTION;

CREATE INDEX idx_callbacks_t_ingroup_source_status
  ON callbacks (tenant_id, original_ingroup_id, source, status, callback_at);
```

The new index supports the I01 dispatcher query:
```sql
SELECT * FROM callbacks
WHERE tenant_id = ?
  AND original_ingroup_id = ?
  AND source = 'INBOUND'
  AND status = 'PENDING'
  AND callback_at <= NOW()
ORDER BY queue_position_at_offer ASC, created_at ASC
LIMIT 1;
```

### 2.2 New enum for Prisma schema

```prisma
enum CallbackSource {
  AGENT
  GLOBAL
  INBOUND
}
```

Add to the `Callback` Prisma model block:

```prisma
model Callback {
  // ... existing fields ...
  source           CallbackSource   @default(AGENT)
  originalIngroupId String?         @map("original_ingroup_id") @db.VarChar(32)
  originalWaitSeconds Int?          @map("original_wait_seconds") @db.UnsignedInt
  callbackNumber   String?          @map("callback_number") @db.VarChar(20)
  firedAt          DateTime?        @map("fired_at") @db.DateTime(6)

  originalIngroup  Ingroup?         @relation(fields: [tenantId, originalIngroupId], references: [tenantId, id], onDelete: SetNull, map: "fk_callbacks_ingroup")

  // Additional index added in migration:
  @@index([tenantId, originalIngroupId, source, status, callbackAt], map: "idx_callbacks_t_ingroup_source_status")
}
```

### 2.3 New `ingroups` columns (additive ALTER via I04 migration)

```sql
ALTER TABLE ingroups
  ADD COLUMN callback_offer_enabled
    BOOLEAN NOT NULL DEFAULT FALSE
    COMMENT 'I01 queue-offer callback: operator opt-in',
  ADD COLUMN callback_offer_after_seconds
    INT UNSIGNED NOT NULL DEFAULT 90
    COMMENT 'Seconds caller must wait before callback offer is triggered',
  ADD COLUMN callback_number_mode
    ENUM('ani','dtmf_optional','dtmf_required') NOT NULL DEFAULT 'ani'
    COMMENT 'Phase 1: ani only; dtmf modes deferred to Phase 2',
  ADD COLUMN outbound_cli
    VARCHAR(20) NULL
    COMMENT 'E.164 CLI to use as from-number when originating callback calls; falls back to tenant default CLI',
  ADD COLUMN callback_no_answer_policy_inbound
    ENUM('leave_callbk','reschedule_30m','reschedule_24h','terminate_NA')
    NOT NULL DEFAULT 'reschedule_30m'
    COMMENT 'What to do when inbound callback is not answered by customer',
  ADD COLUMN callback_expires_hours
    SMALLINT UNSIGNED NOT NULL DEFAULT 96
    COMMENT 'Hours until a PENDING INBOUND callback is auto-expired by O02',
  ADD COLUMN callback_position_expiry_minutes
    INT UNSIGNED NOT NULL DEFAULT 60
    COMMENT 'Minutes after which queue_position_at_offer priority degrades; callback fires on created_at order only';
```

Prisma additions to `Ingroup` model:

```prisma
callbackOfferEnabled          Boolean   @default(false) @map("callback_offer_enabled")
callbackOfferAfterSeconds     Int       @default(90)    @map("callback_offer_after_seconds") @db.UnsignedInt
callbackNumberMode            CallbackNumberMode @default(ani) @map("callback_number_mode")
outboundCli                   String?             @map("outbound_cli") @db.VarChar(20)
callbackNoAnswerPolicyInbound CallbackNoAnswerPolicyInbound @default(reschedule_30m) @map("callback_no_answer_policy_inbound")
callbackExpiresHours          Int       @default(96)  @map("callback_expires_hours") @db.UnsignedSmallInt
callbackPositionExpiryMinutes Int       @default(60)  @map("callback_position_expiry_minutes") @db.UnsignedInt
```

New enums:

```prisma
enum CallbackNumberMode {
  ani
  dtmf_optional
  dtmf_required
}

enum CallbackNoAnswerPolicyInbound {
  leave_callbk
  reschedule_30m
  reschedule_24h
  terminate_NA
}
```

---

## 3. Entry Path A: I01 queue offer

### 3.1 Extension to `/internal/queue/exit_callback`

Existing I01 endpoint `POST /internal/queue/exit_callback` (from I01 PLAN §11.3) is extended:

New behavior when `source=INBOUND` (signaled by the dispatcher adding `?source=inbound` query param):

```typescript
// api/src/routes/internal/queue-hooks.ts  (extended)
async function handleExitCallback(req, reply) {
  const { call_uuid, number, ingroup_id, source } = req.body;

  // 1. Look up lead by ANI (D01.lookupLeadByPhone); create stub if not found
  let lead = await d01.lookupLeadByPhone(number);
  if (!lead) {
    lead = await createStubLead({ phone: number, source: 'INBOUND_CB', tenantId });
  }

  // 2. Read queue_call metadata from Redis (position, wait_seconds)
  const queueCallMeta = await valkey.hgetall(`t:${tenantId}:queue_call:${call_uuid}`);
  const originalWaitSeconds = Math.floor((Date.now() - Number(queueCallMeta.enter_ts_ms)) / 1000);
  const queuePosition = Number(queueCallMeta.queue_position_at_offer);

  // 3. Create callback row
  const cb = await prisma.callback.create({
    data: {
      tenantId,
      leadId: lead.id,
      campaignId: ingroup.defaultCampaignId ?? tenantDefaultCampaignId,
      source: 'INBOUND',
      originalIngroupId: ingroup_id,
      originalWaitSeconds,
      callbackNumber: normalizePhone(number),  // §3 normalizer
      callbackAt: new Date(),                   // ASAP: NOW()
      status: 'PENDING',
      comments: `Inbound callback request. Original wait: ${originalWaitSeconds}s, position: ${queuePosition}`,
      // queue_position_at_offer set via separate column (I01 PLAN §11.4):
    },
  });

  // 4. Set queue_position_at_offer on the new callback (using existing I01 column)
  await prisma.$executeRaw`
    UPDATE callbacks SET queue_position_at_offer = ${queuePosition}
    WHERE id = ${cb.id}
  `;

  // 5. ZREM call from ingroup queue (existing I01 behavior)
  await valkey.zrem(`t:${tenantId}:ingroup:${ingroup_id}:queue`, call_uuid);

  // 6. UPDATE queue_calls.exit_reason=callback
  await prisma.queueCall.update({ where: { id: queueCallId }, data: { exitReason: 'callback' }});

  // 7. Publish vici2.callback.inbound_accepted event
  await publishEvent('vici2.callback.inbound_accepted', { tenantId, callbackId: cb.id, ingroupId: ingroup_id });

  return { callback_id: cb.id };
}
```

### 3.2 I01 dispatcher DTMF offer flow (no change to dialplan XML)

The dialplan XML for the in-group queue already uses `uuid_broadcast play_and_get_digits` (I01 PLAN §11.2). The dispatcher reads the DTMF result via ESL event and calls `/internal/queue/exit_callback` with `source=inbound`. No XML change required. The existing `VICI2_CB_DIGIT` channel variable is used.

---

## 4. Entry Path B: I02 IVR terminal_callback

### 4.1 Extension to `/internal/ivr/callback_accept`

I02 PLAN §15.3 already specifies the eslbridge handler pattern. The existing endpoint is extended to write `source=INBOUND`:

```typescript
// api/src/routes/internal/ivr-hooks.ts (extended)
async function handleCallbackAccept(req, reply) {
  const { uuid } = req.params;

  // Read channel vars from ESL (via T01)
  const channelVars = await esl.getChannelVars(uuid);
  const callerANI = channelVars['Caller-ANI'];
  const ingroupId = channelVars['variable_vici2_callback_ingroup'];
  const cbRequested = channelVars['variable_vici2_callback_requested'];

  if (cbRequested !== '1') return reply.code(204).send();  // Caller declined

  // Normalize and validate number
  const callbackNumber = normalizePhone(callerANI);
  if (!callbackNumber) {
    log.warn({ uuid, ani: callerANI }, 'i04: invalid ANI; cannot schedule callback');
    metrics.i04AniMissingTotal.inc({ ingroup_id: ingroupId });
    return reply.code(204).send();
  }

  // Look up or create stub lead
  let lead = await d01.lookupLeadByPhone(callbackNumber);
  if (!lead) {
    lead = await createStubLead({ phone: callbackNumber, source: 'INBOUND_CB', tenantId });
  }

  // Create INBOUND callback row
  const cb = await prisma.callback.create({
    data: {
      tenantId,
      leadId: lead.id,
      campaignId: tenantDefaultCampaignId,
      source: 'INBOUND',
      originalIngroupId: ingroupId,
      originalWaitSeconds: null,   // IVR path: no queue wait; customer bypassed queue
      callbackNumber,
      callbackAt: new Date(),      // ASAP
      status: 'PENDING',
      comments: `IVR inbound callback request. IVR node: ${channelVars['variable_vici2_ivr_node_id']}`,
    },
  });

  await publishEvent('vici2.callback.inbound_accepted', { tenantId, callbackId: cb.id, ingroupId });
  return reply.code(201).send({ callback_id: cb.id });
}
```

### 4.2 I02 dialplan (no change required)

The `terminal_callback` dialplan extension already sets `vici2_callback_requested` and `vici2_callback_ingroup` channel vars then hangs up. The eslbridge HANGUP_COMPLETE handler already calls `/internal/ivr/callback_accept`. I02's implementation is complete; I04 merely extends the endpoint handler.

---

## 5. Firing pipeline — I01 dispatcher extension

### 5.1 Dispatcher callback-gap fill

Add to the I01 Go dispatcher loop (in `dialer/internal/queue/dispatcher.go`):

```go
// After processing waiting calls for this tick:
func (d *Dispatcher) tryFireInboundCallback(ctx context.Context, ig *Ingroup, agent *Agent) error {
    // Only fire callbacks when live queue is empty
    queueSize, err := d.valkey.ZCard(ctx, ingroup_queue_key(ig.TenantID, ig.ID))
    if err != nil || queueSize > 0 {
        return err  // live calls take priority
    }

    // Fetch next pending INBOUND callback for this ingroup
    cb, err := d.fetchNextInboundCallback(ctx, ig.TenantID, ig.ID)
    if err != nil || cb == nil {
        return err
    }

    // Acquire per-callback fire lock (idempotency)
    locked, err := d.valkey.SetNX(ctx,
        fmt.Sprintf("t:%d:i04:cb_fire_lock:%d", ig.TenantID, cb.ID),
        d.instanceID,
        120*time.Second,
    )
    if err != nil || !locked {
        return err  // another pod is already firing this callback
    }

    return d.fireInboundCallback(ctx, ig, agent, cb)
}
```

### 5.2 `fetchNextInboundCallback`

```go
func (d *Dispatcher) fetchNextInboundCallback(ctx context.Context, tenantID int64, ingroupID string) (*Callback, error) {
    now := time.Now()
    positionExpiryThreshold := now.Add(-time.Duration(d.ingroupConfig.CallbackPositionExpiryMinutes) * time.Minute)

    // Priority 1: position-based (where position is still within expiry window)
    cb, err := d.db.QueryRowCallback(ctx, `
        SELECT id, lead_id, callback_number, queue_position_at_offer, original_wait_seconds
        FROM callbacks
        WHERE tenant_id = ? AND original_ingroup_id = ? AND source = 'INBOUND'
          AND status = 'PENDING'
          AND callback_at <= ?
          AND queue_position_at_offer IS NOT NULL
          AND created_at >= ?
        ORDER BY queue_position_at_offer ASC, created_at ASC
        LIMIT 1
    `, tenantID, ingroupID, now, positionExpiryThreshold)
    if cb != nil {
        return cb, nil
    }

    // Priority 2: any PENDING INBOUND (position expired or IVR path with no position)
    return d.db.QueryRowCallback(ctx, `
        SELECT id, lead_id, callback_number, queue_position_at_offer, original_wait_seconds
        FROM callbacks
        WHERE tenant_id = ? AND original_ingroup_id = ? AND source = 'INBOUND'
          AND status = 'PENDING' AND callback_at <= ?
        ORDER BY created_at ASC
        LIMIT 1
    `, tenantID, ingroupID, now)
}
```

### 5.3 `fireInboundCallback` — TCPA gate + originate

```go
func (d *Dispatcher) fireInboundCallback(ctx context.Context, ig *Ingroup, agent *Agent, cb *Callback) error {
    // 1. Resolve callback number for TCPA check
    dialNumber := cb.CallbackNumber
    if dialNumber == "" {
        dialNumber = cb.Lead.Phone
    }

    // 2. TCPA gate
    tcpaReq := tcpa.CheckRequest{
        LeadID:           cb.LeadID,
        PhoneE164:        dialNumber,
        KnownTimezone:    cb.Lead.KnownTimezone,
        Zip:              cb.Lead.PostalCode,
        State:            cb.Lead.State,
        EnforcementPoint: tcpa.PointCallbackFire,
        When:             time.Now(),
    }
    tcpaResult := d.tcpa.Check(ctx, tcpaReq)

    switch tcpaResult.Outcome {
    case tcpa.OutcomeSkipUntil:
        // Re-snooze to nextOpen
        return d.deferCallback(ctx, cb.ID, *tcpaResult.NextOpen)
    case tcpa.OutcomeBlockInvalid:
        // Log warning; proceed (C01 contract for BLOCK_INVALID is warn+proceed)
        d.logger.Warn("i04: BLOCK_INVALID at fire time; proceeding with warning",
            "callback_id", cb.ID, "reason", tcpaResult.Reason)
        fallthrough
    case tcpa.OutcomeAllow:
        // 3. Determine caller ID (in-group outbound CLI)
        fromCLI := ig.OutboundCli
        if fromCLI == "" {
            fromCLI = d.tenantConfig.DefaultCLI
        }

        // 4. Originate outbound call to customer
        origReq := originator.OriginateRequest{
            ToNumber:   dialNumber,
            FromNumber: fromCLI,
            AgentUserID: agent.UserID,
            TenantID:   ig.TenantID,
            CallbackID: cb.ID,
            ConsentMode: "INBOUND_CALLBACK_REQUESTED",
            SkipInternalDNC: true,     // express consent; see RESEARCH §10 OQ-3
            SkipNationalDNC: false,    // never bypass National DNC
            Direction:  "inbound_callback",
            Metadata: map[string]string{
                "original_ingroup_id":    ig.ID,
                "original_wait_seconds":  strconv.Itoa(int(cb.OriginalWaitSeconds.Int32)),
                "queue_position_at_offer": strconv.Itoa(int(cb.QueuePositionAtOffer.Int32)),
            },
        }

        if err := d.originator.Originate(ctx, origReq); err != nil {
            return d.handleOriginateError(ctx, cb, err)
        }

        // 5. Atomic PENDING → LIVE transition
        return d.promoteInboundCallback(ctx, cb, agent)
    }
    return nil
}
```

### 5.4 `promoteInboundCallback` — atomic PENDING → LIVE

Single Prisma `$transaction` (mirrors D06 `promoteCallback`):

1. `UPDATE callbacks SET status='LIVE', fired_at=NOW() WHERE id=? AND status='PENDING'` (CAS — P2025 on miss = idempotent skip)
2. `UPDATE leads SET status='CALLBK', owner_user_id=agent.userId, modify_at=NOW()`
3. `INSERT audit_events (action='callback.inbound_fired', actor='I04_dispatcher', details_json={ingroup_id, wait_seconds, position, consent_mode, dnc_bypass})`

After-commit (non-transactional):
4. Release Valkey fire lock (`DEL t:{tid}:i04:cb_fire_lock:{callback_id}`)
5. Publish `vici2.callback.inbound_fired` to Valkey stream
6. Push WS event to agent: `{type:'inbound_callback_offer', ...}` (§6 agent UI)

### 5.5 No-answer handling

After the outbound call to the customer is placed and the customer does not answer, T04 dispositions the call as `NA-CAR`. The I01 dispatcher's `onNoAnswer` hook checks `callbacks.source=INBOUND` and applies `ingroups.callback_no_answer_policy_inbound`:

| Policy | `callbacks.status` after | `leads.status` after | Notes |
|---|---|---|---|
| `leave_callbk` | LIVE (unchanged) | CALLBK | Agent re-dials manually |
| `reschedule_30m` **(default)** | PENDING (callback_at += 1800s, capped to TCPA nextOpen) | CBHOLD | Re-fires within 30 min |
| `reschedule_24h` | PENDING (callback_at += 86400s, capped to TCPA nextOpen) | CBHOLD | Next-day re-fire |
| `terminate_NA` | DONE | NA | Close callback; standard D04 recycle |

---

## 6. TCPA / consent record

### 6.1 Consent mode in originate_audit

Every INBOUND callback originate writes to `originate_audit`:

```json
{
  "consent_mode": "INBOUND_CALLBACK_REQUESTED",
  "callback_id": 12345,
  "original_ingroup_id": "SUPPORT",
  "original_wait_seconds": 127,
  "queue_position_at_offer": 4,
  "skip_internal_dnc": true,
  "skip_national_dnc": false,
  "tcpa_outcome": "ALLOW",
  "tcpa_rule_applied": "fed_8_21",
  "party_local_time": "2026-05-13T14:23:00-05:00"
}
```

This is the evidential record: the customer explicitly pressed 1 to request this callback. Retained per C03 audit-immutability rules.

### 6.2 Internal DNC bypass record

The `skip_internal_dnc=true` field is audited. If a compliance audit queries "why was this number called when it was on the DNC list?", the `originate_audit` row shows the override reason (`INBOUND_CALLBACK_REQUESTED`). Operators can configure `ingroups.callback_override_internal_dnc=false` to disable the bypass and require DNC clearance even for inbound callbacks (default: bypass enabled).

### 6.3 National DNC

`skip_national_dnc=false` is always recorded. The D05 National DNC check MUST pass at fire time. If it fails, the callback transitions to DEAD with `dead_reason='national_dnc_blocked'`.

### 6.4 C01 enforcement point

C01 PLAN §2.1 `EnforcementPoint` enum must include `PointCallbackFire` (already added by D06 PLAN §16.4 as `callback_fire`). I04 uses the same enforcement point. No C01 amendment needed beyond what D06 already filed.

---

## 7. API endpoints

### 7.1 New I04-specific endpoint

`GET /api/inbound-callbacks/queue/:ingroupId`

Supervisor view of pending INBOUND callbacks for a specific in-group.

```typescript
// Response shape
{
  "ingroup_id": "SUPPORT",
  "pending_count": 12,
  "callbacks": [
    {
      "id": 99001,
      "callback_number": "+15551234567",    // masked: "+15551234***"
      "original_wait_seconds": 127,
      "queue_position_at_offer": 3,
      "callback_at": "2026-05-13T19:23:00.000Z",
      "created_at": "2026-05-13T19:20:53.000Z",
      "lead": {
        "id": 5550,
        "first_name": "Jane",
        "last_name": "D.",
        "status": "CBHOLD"
      },
      "position_priority_active": true,     // false if position_expiry_minutes elapsed
      "tcpa_window_open": true
    }
  ],
  "stale_count": 0,                        // callbacks pending > 30 min
  "next_tcpa_window_open": null            // null if window is currently open
}
```

RBAC: supervisor + admin only (`callback:view_inbound_queue` permission).

### 7.2 Inherited D06 endpoints (no changes, but `source=INBOUND` filter added)

The existing D06 admin endpoint already supports filters. I04 adds `INBOUND` to the `source` ENUM so:

```
GET /api/admin/callbacks?source=INBOUND&ingroupId=SUPPORT&status=PENDING
```

...works automatically once the `source` column and enum exist. No endpoint code change needed in D06.

### 7.3 In-group admin config endpoints (new fields)

`GET /api/admin/ingroups/:id` and `PUT /api/admin/ingroups/:id` must include the new I04 ingroup fields in their schemas:

```typescript
// Addition to InGroup update schema (api/src/routes/admin/ingroups.ts)
callbackOfferEnabled:              z.boolean().optional(),
callbackOfferAfterSeconds:         z.number().int().min(10).max(600).optional(),
outboundCli:                       z.string().regex(e164OrNanpRegex).nullable().optional(),
callbackNoAnswerPolicyInbound:     z.enum(['leave_callbk','reschedule_30m','reschedule_24h','terminate_NA']).optional(),
callbackExpiresHours:              z.number().int().min(1).max(720).optional(),
callbackPositionExpiryMinutes:     z.number().int().min(0).max(1440).optional(),
```

---

## 8. Agent UI integration

### 8.1 WS event: `inbound_callback_offer`

Published by `promoteInboundCallback` after-commit, to the assigned agent's WS channel (`t:{tid}:ws:user:{uid}`):

```json
{
  "type": "inbound_callback_offer",
  "call_uuid": "<originate_uuid>",
  "callback_id": 99001,
  "ingroup_id": "SUPPORT",
  "ingroup_name": "Customer Support",
  "callback_number": "+15551234567",
  "original_wait_seconds": 127,
  "queue_position_at_offer": 3,
  "direction": "inbound_callback",
  "lead": {
    "id": 5550,
    "first_name": "Jane",
    "last_name": "D.",
    "status": "CBHOLD"
  }
}
```

The agent's A05 call panel handles this event identically to `inbound_call_offer` but with a distinct badge.

### 8.2 A04/A06 badge rendering

In the callback card component (`CallbackCard.tsx`), add source-conditional rendering:

```tsx
// Pseudo-code for CallbackCard.tsx extension
{callback.source === 'INBOUND' && (
  <Badge variant="orange" className="inbound-callback-badge">
    INBOUND CALLBACK
  </Badge>
  <div className="callback-meta">
    {callback.originalWaitSeconds != null && (
      <span>Original wait: {formatDuration(callback.originalWaitSeconds)}</span>
    )}
    {callback.queuePositionAtOffer != null && (
      <span>Queue position: #{callback.queuePositionAtOffer}</span>
    )}
    {callback.originalIngroupId && (
      <span>In-group: {callback.originalIngroupId}</span>
    )}
  </div>
)}
```

### 8.3 A05 call panel during inbound callback

When `direction='inbound_callback'`:
- Header: `CALLBACK` (orange, not blue for outbound)
- Subheader: `Calling back: {formatted_number}`
- Info bar: `Was waiting {formatted_wait} in {ingroup_name}`
- No "next lead" button (push-driven; agent waits for next callback/call)

### 8.4 `call_log.direction` new value

I04 introduces `direction='inbound_callback'` to the `call_log` table. This ensures:
- AHT for the in-group EWT formula (I01 §8) is attributed to inbound calls, not outbound
- Reporting distinguishes callback fulfillment from agent-initiated outbound

Schema amendment: add `inbound_callback` to the `call_log.direction` ENUM (if it is an ENUM; if VARCHAR, no schema change needed).

---

## 9. Files to create / modify

### 9.1 New files

```
api/prisma/migrations/20260513260000_i04_inbound_callback/
  migration.sql          — ALTER callbacks (5 columns + index); ALTER ingroups (7 columns); new enums

api/src/routes/internal/
  queue-hooks.ts         — EXTEND handleExitCallback for source=INBOUND (Path A)
  # ivr-hooks.ts         — EXTEND handleCallbackAccept for source=INBOUND (Path B); file already exists (I02)

api/src/routes/
  inbound-callbacks.ts   — GET /api/inbound-callbacks/queue/:ingroupId

api/src/inbound-callbacks/
  service.ts             — fetchQueueForIngroup, normalizePhone, createStubLead, deferCallback
  schemas.ts             — Zod: InboundCallbackQueueResponse, InboundCallbackRow
  consent.ts             — buildConsentAuditRecord(cb, tcpaResult) → originateAuditDetails

dialer/internal/queue/
  inbound_callback.go    — fetchNextInboundCallback, fireInboundCallback, promoteInboundCallback,
                           deferCallback, handleNoAnswer (I04 extension of dispatcher)
  inbound_callback_test.go — unit tests (§10.1)

shared/types/src/
  inbound-callback.ts    — InboundCallbackRow type; InboundCallbackQueueResponse type

spec/modules/I04/
  RESEARCH.md            — (this companion file)
  PLAN.md                — (this file)
```

### 9.2 Modified files

```
api/src/routes/admin/ingroups.ts
  — Add I04 ingroup fields to GET + PUT Zod schemas

web/src/components/callbacks/CallbackCard.tsx
  — Add INBOUND source badge + meta display (§8.2)

web/src/components/calls/CallPanel.tsx (A05)
  — Handle inbound_callback_offer WS event; orange header; meta bar (§8.3)

web/src/app/(admin)/ingroups/[id]/page.tsx
  — Add I04 config section: callback_offer_enabled toggle, callback_offer_after_seconds,
    outbound_cli, callback_no_answer_policy_inbound, callback_expires_hours

dialer/internal/queue/dispatcher.go (I01 dispatcher)
  — Add tryFireInboundCallback call in per-agent READY loop (§5.1)

workers/src/jobs/callback-fire/tick.ts (D06 worker)
  — Add source filter awareness: INBOUND callbacks are NOT fired by the D06 worker;
    they are fired exclusively by the I01 Go dispatcher. Filter: skip source=INBOUND in worker tick.

workers/src/jobs/callback-fire/metrics.ts
  — Add I04 metric labels (source dimension to existing metrics)
```

---

## 10. Test plan

### 10.1 Unit tests (vitest + Go test)

**Go: inbound_callback_test.go**

| Test | Description |
|---|---|
| `TestFetchNextInboundCallback_PositionOrder` | Three PENDING INBOUND callbacks for same ingroup; assert position 1 returned first |
| `TestFetchNextInboundCallback_PositionExpiry` | Position-based callback older than expiry threshold returned only in fallback query |
| `TestFetchNextInboundCallback_EmptyQueue` | No callbacks → nil returned without error |
| `TestFetchNextInboundCallback_LiveQueueSkip` | Live calls in queue → inbound callback not fetched |
| `TestFireInboundCallback_TCPA_Allow` | Mock tcpa.Check=ALLOW → originator.Originate called once |
| `TestFireInboundCallback_TCPA_SkipUntil` | Mock tcpa.Check=SKIP_UNTIL → deferCallback called; originate NOT called |
| `TestFireInboundCallback_LockContention` | Two concurrent goroutines fire same callback → only 1 originates |
| `TestPromoteInboundCallback_CAS` | Already-LIVE callback → P2025 → idempotent (no double transition) |
| `TestPromoteInboundCallback_AuditRow` | Assert audit_events row created with correct action + consent_mode field |
| `TestNoAnswer_Reschedule30m` | Policy=reschedule_30m → callback_at += 1800s; status=PENDING; capped to TCPA nextOpen |
| `TestNoAnswer_TerminateNA` | Policy=terminate_NA → status=DONE; lead.status=NA |

**TypeScript: api/test/inbound-callbacks/**

| Test | Description |
|---|---|
| `handleExitCallback_InboundSource` | POST /internal/queue/exit_callback?source=inbound → callback row created with source=INBOUND |
| `handleExitCallback_StubLeadCreated` | ANI not in leads → stub lead created with source=INBOUND_CB |
| `handleExitCallback_PositionStamped` | queue_call Redis HASH has queue_position_at_offer → stamped on callback row |
| `handleCallbackAccept_CbOptedIn` | vici2_callback_requested=1 → source=INBOUND callback created |
| `handleCallbackAccept_CbDeclined` | vici2_callback_requested=0 → no callback created; 204 |
| `handleCallbackAccept_BadANI` | ANI is empty → metric incremented; 204; no crash |
| `normalizePhone_NANP` | '+15551234567' → '15551234567' (10-digit stored) |
| `normalizePhone_International` | '+447700123456' → '+447700123456' (E.164 preserved) |
| `normalizePhone_Invalid` | '555' → null (too short) |
| `queueEndpoint_SupervisorOnly` | GET /api/inbound-callbacks/queue/SUPPORT as agent → 403 |
| `queueEndpoint_Returns` | As supervisor → 200 with pending_count and callbacks array |
| `queueEndpoint_MasksNumber` | callback_number masked: last 3 digits replaced with *** |

### 10.2 Integration tests (vitest + testcontainers — MySQL 8 + Valkey)

| Test | Description |
|---|---|
| `E2E_PathA_QueueOffer` | Simulate I01 dispatcher offer; POST exit_callback; assert callback row source=INBOUND |
| `E2E_PathB_IVR` | Simulate eslbridge HANGUP_COMPLETE; POST callback_accept; assert callback row |
| `E2E_Fire_ASAP` | Insert PENDING INBOUND callback; run dispatcher tick; assert LIVE + fired_at set |
| `E2E_TCPA_Defer` | Force fire-time outside TCPA window; assert callback_at re-snoozed; originate NOT called |
| `E2E_PositionOrder` | Three callbacks with positions 2,1,3; assert position 1 fired first |
| `E2E_NoAnswer_Reschedule` | Simulate no-answer; assert callback_at += 1800s; status=PENDING |
| `E2E_NationalDNC_Block` | Lead on National DNC; assert callback→DEAD; originate NOT called |
| `E2E_InternalDNC_Bypass` | Lead on internal DNC; assert originate IS called; audit row shows skip_internal_dnc=true |
| `E2E_StubLead` | Unknown ANI; assert stub lead created; callback references stub lead_id |
| `E2E_ConcurrentFire` | 5 concurrent dispatcher goroutines; same callback; assert exactly 1 originate |

### 10.3 Acceptance scenarios (SIPp + manual)

| Scenario | Steps | Expected |
|---|---|---|
| S1: Path A — offer and accept in queue | Wait 90s in SUPPORT queue; hear offer; press 1; hang up | Callback row created source=INBOUND; caller hears "We'll call you back." |
| S2: Path B — IVR terminal callback | Press digit for callback in IVR menu; press 1 to confirm; hang up | eslbridge creates source=INBOUND callback |
| S3: Agent fires callback | Agent becomes READY for SUPPORT; no live calls; callback fires | Agent receives inbound_callback_offer WS event; customer's phone rings |
| S4: TCPA defer | Callback created at 8:50 PM; fire attempt at 9:05 PM | callback_at re-snoozed to next-day 8:00 AM; agent sees nothing until morning |
| S5: Position ordering | Three callbacks at positions 1, 3, 5 | Agent receives callbacks in order 1, 3, 5 as agents become available |
| S6: No-answer reschedule | Customer doesn't answer callback; policy=reschedule_30m | callback_at += 30m; status=PENDING; tries again |
| S7: Agent badge | Agent receives inbound_callback_offer | Orange "INBOUND CALLBACK" badge visible; shows "Original wait: 2m 7s" |
| S8: Supervisor queue view | GET /api/inbound-callbacks/queue/SUPPORT | Returns list with pending_count, masked numbers, position info |

### 10.4 Performance targets

| Operation | p95 target | Hard ceiling |
|---|---|---|
| `POST /internal/queue/exit_callback` (I04 path) | 120 ms | 500 ms |
| `POST /internal/ivr/callback_accept` | 120 ms | 500 ms |
| `GET /api/inbound-callbacks/queue/:ingroupId` | 80 ms | 300 ms |
| `fetchNextInboundCallback` (Go DB query) | 5 ms | 20 ms |
| `fireInboundCallback` (TCPA + lock + originate) | 200 ms | 500 ms |
| `promoteInboundCallback` (DB transaction) | 30 ms | 100 ms |

---

## 11. Prometheus metrics

| Metric | Labels | Description |
|---|---|---|
| `vici2_i04_callback_accepted_total` | `path={queue_offer,ivr_terminal}` | Callback opt-ins received |
| `vici2_i04_ani_missing_total` | `ingroup_id` | ANI absent; fallback attempted |
| `vici2_i04_non_us_number_total` | `ingroup_id` | Non-NANP callback number |
| `vici2_i04_callback_fired_total` | `ingroup_id, tcpa_outcome` | Successful originates |
| `vici2_i04_callback_deferred_total` | `ingroup_id, reason={tcpa_skip_until}` | Callbacks re-snoozed |
| `vici2_i04_callback_dead_total` | `ingroup_id, reason={national_dnc,expired}` | Callbacks terminated |
| `vici2_i04_stub_lead_created_total` | `ingroup_id` | Anonymous callers (no lead match) |
| `vici2_i04_lock_contention_total` | `ingroup_id` | Fire lock contention (concurrent dispatch) |
| `vici2_i04_callback_stale_total` | `ingroup_id, age_bucket` | Pending INBOUND callbacks > 30 min |
| `vici2_i04_time_to_fire_seconds` | `ingroup_id` (histogram) | Seconds from created_at to fired_at |
| `vici2_i04_internal_dnc_bypass_total` | `ingroup_id` | Internal DNC bypassed (express consent) |
| `vici2_i04_no_answer_reschedule_total` | `ingroup_id, policy` | No-answer reschedule count |

**Alert rule (O01):** `vici2_i04_callback_stale_total > 0 AND age_bucket = '30m+'` → WARN severity. If `age_bucket = '2h+'` → PAGE. This alerts supervisors that customers who requested callbacks have been waiting too long.

---

## 12. Acceptance criteria

All of the following must pass before I04 IMPLEMENT is complete:

- [ ] AC1: Path A — pressing 1 during a queue callback offer writes a `callbacks` row with `source=INBOUND`, `original_ingroup_id`, `original_wait_seconds`, and `callback_number = ANI`. Caller hears confirmation and hangs up. Queue slot is freed.
- [ ] AC2: Path B — IVR `terminal_callback` node opt-in via eslbridge HANGUP_COMPLETE writes a `callbacks` row with `source=INBOUND`. `original_wait_seconds = NULL` (IVR path has no queue wait).
- [ ] AC3: I01 dispatcher fires an INBOUND callback when an agent becomes READY for the in-group and the live queue is empty. Live calls always take priority over callbacks.
- [ ] AC4: INBOUND callbacks with `queue_position_at_offer` are fired in ascending position order within the same `original_ingroup_id`, ahead of callbacks without position (IVR path).
- [ ] AC5: Fire attempt that fails C01.Check() with SKIP_UNTIL → `callbacks.callback_at` updated to `nextOpen`; no originate issued; `vici2_i04_callback_deferred_total` incremented.
- [ ] AC6: `originate_audit` row for every INBOUND callback fire includes `consent_mode=INBOUND_CALLBACK_REQUESTED`, `skip_internal_dnc=true`, `skip_national_dnc=false`, `tcpa_outcome`, and `party_local_time`.
- [ ] AC7: Number on National DNC → callback transitions to DEAD; originate NOT issued; `dead_reason='national_dnc_blocked'` in audit.
- [ ] AC8: Number on internal DNC only → originate IS issued; audit row shows `skip_internal_dnc=true` with reason.
- [ ] AC9: Concurrent fire lock: 5 goroutines attempt to fire same callback → exactly 1 originates; others log `lock_contention`; `vici2_i04_lock_contention_total` = 4.
- [ ] AC10: Agent receives `inbound_callback_offer` WS event with `direction='inbound_callback'` before the call is bridged.
- [ ] AC11: A04/A05/A06 display orange "INBOUND CALLBACK" badge with original wait and position when `callbacks.source = 'INBOUND'`.
- [ ] AC12: `GET /api/inbound-callbacks/queue/SUPPORT` returns supervisor list with masked callback_number and `pending_count`. Returns 403 for agent role.
- [ ] AC13: `GET /api/admin/callbacks?source=INBOUND` returns only INBOUND callbacks.
- [ ] AC14: Unknown ANI (no lead match) → stub lead created with `source=INBOUND_CB`; callback references stub `lead_id`. Agent can update lead details via D04 dispo.
- [ ] AC15: `callbacks.fired_at` is set at the moment of PENDING→LIVE transition (in the atomic DB transaction).
- [ ] AC16: `vici2_i04_callback_stale_total` metric emits when an INBOUND callback has been PENDING for > 30 min. Alert rule fires in O01.
- [ ] AC17: All 12 Prometheus metrics registered and emit at least one sample in integration test.
- [ ] AC18: D06 worker tick (`callback-fire/tick.ts`) skips `source=INBOUND` callbacks. INBOUND callbacks are fired exclusively by the I01 Go dispatcher.
- [ ] AC19: `make test-i04` passes in CI with MySQL 8 + Valkey testcontainers.
- [ ] AC20: No-answer with `callback_no_answer_policy_inbound=reschedule_30m` → `callback_at += 1800s`, capped to TCPA nextOpen; `status=PENDING`; agent sees nothing in "My Callbacks" (INBOUND not AGENT-scoped).

---

## 13. Dependencies and risks

### 13.1 Hard dependencies (must be FROZEN before I04 IMPLEMENT)

| Dependency | Why needed | Status |
|---|---|---|
| F02 schema (`callbacks` table, `CallbackStatus` enum, `queue_position_at_offer` column) | I04 adds columns to this table | DONE (F02 PLAN) |
| D06 PLAN (state machine, `promoteCallback` pattern, worker tick, TCPA-defer path) | I04 reuses the same patterns; D06 code is a model | PLAN-stable |
| I01 PLAN §11 (callback offer, `queue_position_at_offer`, `/internal/queue/exit_callback`) | Path A entry point | PLAN-stable |
| I02 PLAN §4.5 + §15.3 (`terminal_callback` node, eslbridge handler, `/internal/ivr/callback_accept`) | Path B entry point | PLAN-stable |
| C01 PLAN §2.1 (`Check()`, `PointCallbackFire`) | TCPA gate at fire time | PLAN-stable |
| E04 PLAN (`Originator` interface) | I04 dispatcher uses same Originator for outbound call | DONE (E04 HANDOFF) |
| T03 (conference-per-agent, `TransferCustomer`) | Customer leg must bridge into agent conference | FROZEN (T03 is Phase 1 DONE) |
| F04 (Valkey lock contract `SET NX EX`) | Per-callback fire lock | PLAN-stable |

### 13.2 Soft dependencies (I04 provides interface; consumers use)

| Consumer | Interface provided |
|---|---|
| A04/A05/A06 UI | `source`, `original_ingroup_id`, `original_wait_seconds` fields on Callback type |
| Admin callbacks list | `source=INBOUND` filter on existing D06 endpoint |
| O02 nightly cron | `callbacks.expires_at` expiry (using existing D06 expiry path; I04 uses `ingroups.callback_expires_hours`) |
| S01 supervisor wallboard (Phase 3+) | `GET /api/inbound-callbacks/queue/:ingroupId` |

### 13.3 Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| R1: ANI not delivered by carrier | Medium | Medium — cannot schedule callback without a number | Phase 1: `ani_missing` metric + `dtmf_required` fallback prompt; Phase 2: full `dtmf_optional` mode |
| R2: Customer's number reassigned since callback request | Low | High — call reaches wrong person with TCPA exposure | Phase 1: log risk in audit; Phase 2: TCPA RND scrub |
| R3: Long TCPA deferral means customer waits overnight for callback | Medium | Medium — UX breach of "we'll call you soon" promise | Admin UI shows `tcpa_window_open` flag; alert if > 5 callbacks waiting past midnight |
| R4: In-group deleted with pending INBOUND callbacks | Low | Medium — orphaned callbacks never fired | Admin UI blocks ingroup delete if PENDING INBOUND callbacks exist; warns and offers to auto-DEAD |
| R5: National DNC rejection for customer who requested callback | Low | Low — very rare; customer explicitly called in | Log metric; operator can appeal DNC status for this number; no auto-waiver |
| R6: I01 dispatcher Go code and D06 Node worker both attempt to fire same callback | Low | High — double originate | D06 worker MUST filter `source!=INBOUND` (AC18); I01 Go dispatcher holds Valkey lock; integration test confirms |
| R7: `callback_at = NOW()` (ASAP) creates storm if 500+ callbacks become eligible simultaneously | Medium | Medium — originates burst | `fetchNextInboundCallback` returns `LIMIT 1`; each agent fires at most 1 per READY event; natural pacing |
| R8: DTMF number collection (Phase 2) blocked by Phase 1 `ani`-only mode | Low | Low — expected Phase 2 gap | Phase 1 prompt says "We'll call you back at the number you called from." Document limitation in operator docs |
| R9: I02 `terminal_callback` fires before I01 queue offer (caller never entered queue) | Low | Low — `original_wait_seconds=NULL` in IVR path; position also NULL | `queue_position_at_offer=NULL` callbacks sort after position-carrying callbacks; correct behavior |

### 13.4 Micro-amendments required in other modules

| Module | Amendment |
|---|---|
| D06 worker (`callback-fire/tick.ts`) | Add `AND source != 'INBOUND'` (or `source IN ('AGENT','GLOBAL')`) filter to the main tick query. One-line change. D06 fires only AGENT and GLOBAL callbacks; I04 fires INBOUND. |
| I01 dispatcher (`dispatcher.go`) | Add `tryFireInboundCallback` call in per-agent READY loop (§5.1). ~50 LOC addition. |
| I02 `ivr-hooks.ts` | Extend `handleCallbackAccept` to write `source=INBOUND` (§4.1). ~15 LOC change. |
| I01 `queue-hooks.ts` | Extend `handleExitCallback` for `source=inbound` query param (§3.1). ~40 LOC addition. |
| D05 DNC service | Add `skipInternalDNC` flag to DNC check request shape. One parameter addition. |
| `call_log` | Add `inbound_callback` to `direction` ENUM if stored as ENUM; or accept it if VARCHAR. |

---

*End of I04 PLAN — spec/modules/I04/PLAN.md*
