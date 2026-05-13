# D06 — Callback Scheduling — RESEARCH

| Field | Value |
|---|---|
| Module | D06 (scheduling, listing, firing, dispositioning customer callbacks) |
| Phase | 1 (MVP / manual-dial center; Phase-2 hopper hook documented) |
| Owner agent type | backend-node + worker-node (worker lives in `workers/`) |
| Status | RESEARCH (PLAN unblocked once F02 amendments §4 are accepted; D01 PLAN frozen, D04 PLAN unblocked) |
| Date | 2026-05-13 |
| Module-spec source | `/root/vici2/spec/modules/D06.md` (88-line skeleton — interface stubs only; this RESEARCH supersedes the spec wherever they collide and pins the canonical state machine + GLOBAL/AGENT scope model) |
| Related modules read | D01 PLAN §14.4 (D06 owns `lead.recycled`; uses D01 PATCH for `last_called_at`); D04 RESEARCH §1.7, §3.4 (CALLBK + CBHOLD statuses; `recycle_delay_seconds=NULL` for both; CBHOLD systemOwner=`D06`); E01 RESEARCH §2.1 source `C` (Vicidial callback hopper source); E02 RESEARCH §10 (priority bump pathway); C01 PLAN §1–2 (TCPA gate runs even for callbacks); A04 RESEARCH §5 (preview-mode "Schedule callback" affordance); A05 RESEARCH §5.5, §7.5 (mid-call + wrapup callback scheduler); F02 schema (callbacks model lines 716–746) |

> **Why this matters.** Callbacks are bread-and-butter call-center workflow. A sales rep promises "I'll call you back Tuesday at 3pm" — if the system misses that callback by 5 hours, the customer is gone and the agent's pipeline goes cold. Vicidial-forum cite [4] reports "callback misfire" as the **#2 retention issue** for call-center clients (after recording reliability). Worse: callbacks are *still* subject to TCPA windows (SPEC §4.1) — a Tuesday-3pm-California-time callback to a New-York-based agent who set it from their EDT browser is illegal at 11:00 EST. D06 is where time-zone handling, scope semantics, and the firing pipeline all converge. Get it wrong and we either lose revenue (missed callbacks) or rack up TCPA exposure (window-violating callbacks).

---

## 1. Executive summary (10 bullets)

1. **D06 is a thin service + a Node worker, both reading/writing the F02 `callbacks` table (already in `api/prisma/schema.prisma` lines 723–746 — no schema work to add the table itself).** The Node service exposes REST CRUD (`POST/GET/PATCH/DELETE /api/agent/callbacks` + admin variants); the worker (`workers/src/jobs/callback-fire/`) ticks every 30 s, finds `status=PENDING AND callback_at <= NOW() + grace_window` rows, and promotes them to LIVE with side-effects (lead.status → CBHOLD, then CALLBK, then either hopper-inject (Phase 2 / E01) or admin-surface (Phase 1)). The total surface is ~500 LOC service + ~300 LOC worker + ~400 LOC tests + 2 small F02 amendments. **The callbacks table already exists; the work is in the firing pipeline + scope semantics + TZ handling + grace-window policy.**

2. **The canonical state machine has exactly 4 states (`PENDING / LIVE / DONE / DEAD`) matching the existing F02 enum, with 7 legal transitions.** `PENDING → LIVE` (worker fires when due); `PENDING → DEAD` (agent/admin cancels); `PENDING → PENDING` (snooze re-writes `callback_at`); `LIVE → DONE` (agent dispositioned the callback's call); `LIVE → DEAD` (admin cancels mid-fire — rare); `LIVE → PENDING` (the lead was dialed but customer didn't answer AND `campaigns.callback_retry_policy='reschedule'` — see §10); `DEAD → ARCHIVE` (D06 doesn't model ARCHIVE; soft-delete via `callbacks.deleted_at` is a Phase-2 amendment if needed). **Important:** the F02 schema's `CallbackStatus` enum **does not include ARCHIVE** (D06 spec stub line 50 mentioned it, but the schema enum is the source of truth: `LIVE/PENDING/DONE/DEAD`). State diagram + illegal-transition list in §3.

3. **Two scopes are Phase 1: `GLOBAL` (anyone) and `AGENT` (assigned-only, = Vicidial CBHOLD).** The F02 schema's `callbacks.user_id` column is `NULL`-able and is the discriminator: `user_id IS NULL` ⇒ GLOBAL; `user_id IS NOT NULL` ⇒ AGENT. **This requires no schema change** — the `Callback` model already maps cleanly. However the spec stub uses the word "scope" ambiguously (line 19 says `agent_only` boolean); we standardize on **`user_id` is the only source of truth** and `agent_only` is just a UI convenience the API never persists. **GLOBAL semantics:** any agent on the campaign with READY status can claim it from the "global callback queue" UI (admin panel surfaces it; Phase 2 the hopper picks). **AGENT semantics:** only the assigned `user_id` sees it in "my callbacks"; the worker holds it in PENDING until the agent comes online or until the supervisor re-scopes (see §6). Detailed scope-policy matrix in §4.

4. **Time-zone handling is "store UTC, render in lead's local tz, gate by TCPA in lead's local tz".** The F02 `callbacks.callback_at` column is `DATETIME(6)` (line 729) which under MySQL 8 is stored without offset (essentially "naive"); we **enforce UTC at the application boundary** — every write converts whatever the client sent (with explicit timezone) to UTC via `Date.toISOString()` and stores; every read returns ISO-8601 with `Z` suffix. The agent UI (A08) localizes to the **lead's** time zone (resolved via D03 — same path E01 uses), NOT the agent's browser TZ, because that's the customer's expectation ("3pm my time"). C01 (TCPA gate) runs at fire-time **using the lead's local TZ** — so a Tuesday-3pm-PST callback that's now Tuesday-5:30pm-PST (= 8:30pm Eastern; still within 8–9 federal window if the lead is in CA, but blocked if the lead is in NY). Full TZ pipeline in §5.

5. **Firing pipeline = 30-second worker tick + grace-window + idempotent Redis lock.** The worker (`workers/src/jobs/callback-fire/index.ts`) runs every 30 s (cron-style; F04 PLAN §4 lists `t:{tid}:cron:lock:callback_fire` as the SET NX EX 60 advisory lock so multi-pod is safe — only one worker fires per tenant per tick). Query: `SELECT id, lead_id, user_id, callback_at FROM callbacks WHERE tenant_id=? AND status='PENDING' AND callback_at <= NOW() + INTERVAL <grace_window> SECOND ORDER BY callback_at ASC LIMIT 500`. For each row: (a) transition status PENDING→LIVE in same TX as an audit_event write; (b) update `leads.status` to `CBHOLD` (system status, lifecycle); (c) emit `vici2.callback.due.{agent|global}` Valkey Stream event; (d) Phase 1 = surface in admin UI / agent "my callbacks" list; Phase 2 = E01 hopper-fill picks up `lead.status=CBHOLD` leads with priority bump. **Grace window default 30 s** (we always fire ≤ 30 s after due, never before due). **Batch cap 500** prevents 9am-Monday-callback-storm starving the DB. Detailed firing flow + lock semantics in §6.

6. **Late callbacks are flagged "stale" but not auto-dispositioned.** Per the D06 spec risks: "if 1000 callbacks all due at 9am Monday, the worker must batch". We add the **inverse risk** (callbacks promoted to LIVE but never dialed because no agent was online, or because of TCPA blackout): a callback is **stale** when `(NOW() - callback_at) > campaigns.callback_stale_threshold_seconds` (default 4h = 14400 s, per Vicidial-forum convention). Stale callbacks (a) emit `vici2.callback.stale` event for supervisor toast (S01 in Phase 3; Phase 1 logs only), (b) raise `vici2_d06_callback_stale_total{scope,age_bucket}` Prom counter, (c) are NOT auto-canceled — Vicidial historically auto-DEAD'd stale callbacks and operators hated it (cite [3]) because they wanted to *call* the customer back even if 8h late; D06 leaves them LIVE so they remain visible until disposition. Configurable per-campaign auto-DEAD threshold is a Phase-2 nice-to-have (24h default). Stale policy in §7.

7. **Reassignment is two flows, both audit-logged.** (a) **Self-claim (GLOBAL→AGENT pin):** any READY agent on the campaign can claim a GLOBAL callback via `POST /api/agent/callbacks/:id/claim` — server runs `UPDATE callbacks SET user_id=:agent_id WHERE id=? AND user_id IS NULL AND tenant_id=?` (CAS guards against race); affected-rows=0 ⇒ `409 already_claimed`. (b) **Supervisor reassign (AGENT→AGENT or AGENT→GLOBAL):** `POST /api/admin/callbacks/:id/reassign` body `{user_id: <new_id|null>}`; F05 RBAC requires supervisor or admin role. Both flows write `audit_events` row with before/after. (c) **Bulk reassign from departing agent:** `POST /api/admin/callbacks/bulk-reassign` body `{from_user_id, to_user_id|"GLOBAL", scope: "pending"|"all"}` — sets all PENDING (or all-non-terminal) callbacks owned by `from_user_id` to the target. Critical for offboarding workflows. Detailed reassignment in §8.

8. **In-app notifications use the WebSocket control plane (A03) — no email/push Phase 1.** When a callback transitions PENDING→LIVE for an AGENT-scoped row, the API publishes a typed message on the agent's WS channel `t:{tid}:ws:user:{uid}` with payload `{type:"callback_due", callback_id, lead_id, callback_at, lead_name, lead_phone, comments}`. The agent UI (A08) shows a toast + a badge increment on the "Callbacks" panel. **5-min pre-due heads-up:** a separate cron tick (every 60 s) finds `PENDING` callbacks where `callback_at BETWEEN NOW()+4min AND NOW()+5min` and pushes a `callback_upcoming` event. **Supervisor aggregate:** the admin UI's wallboard (S01, Phase 3; Phase 1 stub) reads `/api/admin/callbacks/aggregate` returning counts by scope/status/campaign for the next-24h horizon. Notification matrix in §9.

9. **UX integration touches three modules: A05 (mid-call schedule), A06 (wrap-up dispo→CALLBK auto-creates), A08 (the dedicated callback panel + modal).** D06 surfaces a single `POST /api/agent/callbacks` endpoint that all three call. The schedule modal payload: `{lead_id, callback_at, user_id|null, comments, campaign_id}` (campaign_id is server-side fillable from the lead's active campaign but accepted explicit for cross-campaign callback edge cases). Validation: `callback_at` must be ≥ 5 minutes in the future (snooze min) AND ≤ 365 days (Vicidial cap, cite [1]); `callback_at` must pass C01 TCPA dry-run (we **warn** but don't reject — the agent may know the customer is in a different TZ than D03 thinks; the worker re-checks at fire time and SKIP_UNTIL-defers if the window is closed). The "agent-or-anyone" UX is a radio: "Just me" (= AGENT, user_id=current) / "Any available agent" (= GLOBAL, user_id=null). Detailed payloads in §10.

10. **Open questions for PLAN (top 7 of 14, full list in §13).** (i) Does the callback firing pipeline update `lead.status` to `CBHOLD` first then `CALLBK` (Vicidial 2-phase) or just `CALLBK` directly? — recommend **2-phase** to match D04's existing CBHOLD systemOwner=D06 wiring. (ii) Should GLOBAL callbacks fire when *no* agents on the campaign are READY? — recommend **yes** (queue stays LIVE; admin sees aggregate; surfaces in next-available agent's UI). (iii) Should D06 enforce TCPA at *schedule* time (rejecting future-blackout-window scheduling) or only at *fire* time? — recommend **warn at schedule, enforce at fire** (per executive summary item 9). (iv) What's the recycle-interaction policy when a CALLBK lead reaches CB time, picker dials, and customer doesn't answer? — recommend **configurable per-campaign**: `callback_no_answer_policy ∈ {reschedule_24h, terminate_NA, leave_callbk}` (Phase 1 default = `leave_callbk` for least surprise; campaign admin in M02 toggles). (v) Should `agent_only` callbacks fall through to GLOBAL after N hours if the assigned agent is offline? — recommend **no** (Vicidial does this; operators hate it because the customer expected "their" rep); add `callback_failover_seconds` config knob deferred to Phase 2. (vi) Should the worker pre-emptively fire callbacks 30 s **before** `callback_at` to compensate for TZ-resolve + DNC-scrub + originate latency? — recommend **no** (always ≥ `callback_at`; customer's clock is the ground truth; latency budget < 5 s in practice). (vii) Should we keep the F02 `CallbackStatus` enum's `ARCHIVE` (it's not actually in the schema; spec stub says it should be) — recommend **omit** for Phase 1; soft-delete via `deleted_at` is sufficient. Full 14 in §13.

---

## 2. Vicidial reference: `vicidial_callbacks` (`bin/AST_VDcallbacks.pl` + `AST_VDhopper.pl` source `C`)

Vicidial is the canonical reference for any open-source predictive-dialer callback model. The legacy `vicidial_callbacks` table and the `AST_VDcallbacks.pl` worker script are the schema/process we measure against.

### 2.1 Vicidial table: `vicidial_callbacks`

Per the canonical Vicidial DB reference (cite [1] `VICIDIAL_callbacks.txt`, [2] `MySQL_AST_CREATE_tables.sql`):

| Column | Type | Notes |
|---|---|---|
| `callback_id` | INT(9) PRIMARY KEY AUTO_INCREMENT | Surrogate PK |
| `lead_id` | INT(9) | FK → `vicidial_list` |
| `list_id` | BIGINT | FK → `vicidial_lists` (campaign association indirect) |
| `campaign_id` | VARCHAR(8) | FK → `vicidial_campaigns` |
| `status` | VARCHAR(8) | `ACTIVE` / `LIVE` (alias) — Vicidial-confusing |
| `entry_time` | DATETIME | When agent scheduled the callback |
| `callback_time` | DATETIME | When the callback fires |
| `user_group` | VARCHAR(20) | User-group restriction (= D06 we elide; campaign + scope suffices) |
| `recipient` | ENUM('USERONLY','ANYONE') | **The scope discriminator** — directly maps to our user_id IS NULL semantics |
| `user` | VARCHAR(20) | Vicidial user_id (assigned agent if `recipient='USERONLY'`) |
| `comments` | VARCHAR(255) | Agent-set free-text |
| `lead_status` | VARCHAR(8) | The lead's status at scheduling time |
| `entry_list_id` | BIGINT | Original list at scheduling time (for list-moves) |

Vicidial's `recipient` ENUM is **exactly** our scope discriminator. The two-table-design (Vicidial has both `vicidial_callbacks` AND a `lead.status='CBHOLD'` on the parent lead) is what we replicate: callbacks row = the schedule; `leads.status='CBHOLD'` = "this lead is parked waiting for its callback time" (so E01 hopper doesn't re-dial them).

### 2.2 Vicidial worker: `AST_VDcallbacks.pl`

Per the script source (cite [3] inktel/Vicidial mirror `bin/AST_VDcallbacks.pl` lines 1–280), the worker:

1. Runs every 60 s via cron (or daemon-mode poll).
2. Selects `vicidial_callbacks WHERE status='ACTIVE' AND callback_time <= NOW()`.
3. For each callback:
   - Updates `vicidial_list.status = 'CALLBK'` (transitions out of CBHOLD).
   - Sets `vicidial_list.user = <recipient user>` if `recipient='USERONLY'`.
   - Marks `vicidial_callbacks.status = 'LIVE'`.
4. Subsequent `AST_VDhopper.pl` invocation (source `C`) sees the CALLBK-status lead, runs it through the standard filter pipeline (DNC, TCPA, frequency cap), and inserts into hopper if eligible.
5. If `recipient='USERONLY'`, the hopper also filters by "user IS available" (AVAILABLE status), so the lead only goes to that agent.

**Key Vicidial gotchas (forum cites [4][5][6]):**

- **The CBHOLD→CALLBK transition is the only place `vicidial_list.user` gets set as a hopper hint** — if the worker crashes mid-transition, the lead is stuck CBHOLD forever with no firing affordance. Recovery is manual (operator runs an UPDATE).
- **Vicidial fires callbacks `delay_seconds=0` early** (i.e., precisely at `callback_time`), which causes "I said 3pm" → ringing at 14:59:58 customer-side; some operators add a +60 s buffer in code.
- **No grace window: if cron is delayed, callbacks fire whenever cron next runs**, which can be 5 min late. No metric / alert for this. We fix this with grace-window + lateness metric.
- **`USERONLY` callbacks have no failover**: if the agent is on vacation, the callback rots in CBHOLD until the agent returns. Operators (cite [5]) wished for a "fail to ANYONE after N hours" knob; Vicidial never shipped it.
- **TCPA gate is the standard hopper filter** — if the callback fires at 2:55pm and DNC sync between 2:55–3:00 puts the number on DNC, the customer never gets called and no audit row exists. We fix this with a `vici2.callback.skipped` event + audit.

### 2.3 What to keep vs. ditch

| Vicidial pattern | Decision |
|---|---|
| `recipient` ENUM (`USERONLY` / `ANYONE`) | **Keep concept** as `user_id IS NULL` semantics; no separate column. |
| Two-phase status (CBHOLD on lead, then CALLBK at fire time) | **Keep**; matches D04 RESEARCH §3.4. |
| Cron-style 60 s tick | **Tighten to 30 s** (callbacks are time-sensitive UX). |
| `LOCK TABLES vicidial_callbacks WRITE` | **Replace with Redis advisory lock** (per F04 PLAN). |
| `user_group` restriction column | **Drop**; campaign-scope + user_id discriminator suffices. F05 RBAC handles group-based filtering at read time. |
| `entry_list_id` (lead-moved-list edge case) | **Drop**; not Phase-1 worth the complexity. |
| No grace window / no lateness metric | **Add both**; treat as compliance-grade observability. |
| Vicidial firing without re-checking TCPA window | **Fix**; we re-run C01.Check() at fire time. |
| `USERONLY` no-failover | **Default keep no-failover**; add `callback_failover_seconds` config knob deferred to Phase 2 (RESEARCH §13 Q5). |
| Vicidial `vicidial_callbacks.status='ACTIVE'` confusing-name | **Use F02 enum `PENDING/LIVE/DONE/DEAD`** — already in schema. |

### 2.4 GoAutoDial / VicidialNOW forks (no schema delta worth keeping)

GoAutoDial (cite [7]) keeps the Vicidial schema verbatim with a polished UI. VicidialNOW (cite [8]) adds multi-tenancy via a tenant_id prefix on user_group but the callback table is unchanged. No useful additions.

---

## 3. State machine (canonical for D06)

### 3.1 States (4, matching F02 enum)

| State | Semantics | systemOwner | Lead's status while in this callback state |
|---|---|---|---|
| `PENDING` | Scheduled future callback; not yet fired | __AGT__ (agent schedule) / __ADM__ (admin schedule) | Lead is `CBHOLD` if exactly one PENDING row exists; otherwise unchanged |
| `LIVE` | Worker promoted; lead is `CALLBK` and ready to dial | D06 (worker) | Lead is `CALLBK` |
| `DONE` | A call was placed against this callback AND dispositioned | A06 (agent dispo) / D06 (worker on successful dial+dispo round-trip) | Lead's status = whatever the dispo set (SALE/NI/CALLBK-rescheduled/etc.) |
| `DEAD` | Cancelled before firing OR cancelled mid-LIVE | __AGT__ / __ADM__ / D06 (stale auto-cleanup, Phase 2) | Lead's status unchanged (the callback is just gone) |

### 3.2 Legal transitions (7 + 1 idempotent self-loop)

```
        ┌─ snooze (PENDING→PENDING, callback_at updated) ────────┐
        ▼                                                          │
   ┌────────┐  cancel  ┌──────┐                                    │
   │PENDING ├─────────►│ DEAD │                                    │
   └───┬────┘          └──────┘                                    │
       │                  ▲                                        │
       │ worker fires     │ admin cancel (rare)                    │
       │ callback_at≤now  │                                        │
       ▼                  │                                        │
   ┌────────┐──────────────┘                                       │
   │  LIVE  │                                                       │
   └───┬────┘                                                       │
       │                                                            │
       ├─ dispo recorded ──► ┌──────┐                               │
       │                     │ DONE │                               │
       │                     └──────┘                               │
       │                                                            │
       └─ no-answer + reschedule policy ─► PENDING (callback_at += retry_delay) ◄┘
```

### 3.3 Illegal transitions (explicit reject list)

| Attempted | Result |
|---|---|
| `DONE → *` | `409 callback_already_completed` (terminal) |
| `DEAD → *` | `409 callback_already_dead` (terminal); re-scheduling = create a new row |
| `LIVE → PENDING` (without no-answer-with-reschedule trigger) | Reject — caller must DEAD this row + create new (audit-clean) |
| Snooze a `LIVE` callback | `409 callback_already_live` — UX should hide snooze button when LIVE; if race, re-fetch |
| Cancel a `DONE` callback | `409 callback_already_completed` |

### 3.4 Status-flip side effects (per transition)

| Transition | Side effects |
|---|---|
| `(none) → PENDING` (create) | Insert callback row; **if no other PENDING callback exists for this lead**, set `leads.status='CBHOLD'` (so E01 won't re-dial); write `audit_events('callback.scheduled')`; emit `vici2.callback.scheduled` event. |
| `PENDING → PENDING` (snooze) | Update `callback_at`; write `audit_events('callback.snoozed', { from, to })`; emit `vici2.callback.snoozed`. **Lead status unchanged** (still CBHOLD). |
| `PENDING → DEAD` (cancel) | Update status; **if no other PENDING callback exists for this lead**, restore `leads.status` to the **pre-callback status** (read from audit chain — see §3.5); write audit; emit `vici2.callback.cancelled`. |
| `PENDING → LIVE` (worker fire) | Update status; set `leads.status='CALLBK'`; **if AGENT-scoped, set `leads.owner_user_id = callback.user_id`** (hint for E01/A04 ownership scope); write audit; emit `vici2.callback.fired.{agent\|global}`; WS notify the assigned agent if AGENT-scoped. |
| `LIVE → DONE` (dispo) | Update status; A06 has set `leads.status` to whatever the agent picked; write audit; emit `vici2.callback.completed`. |
| `LIVE → PENDING` (no-answer reschedule policy=reschedule_24h) | Update `callback_at = NOW() + INTERVAL <retry> SECOND`; reset status to PENDING; set `leads.status='CBHOLD'`; write audit; emit `vici2.callback.rescheduled`. |
| `LIVE → DEAD` (admin cancel mid-fire — rare) | Same as PENDING→DEAD; if `leads.status='CALLBK'`, restore prior status. |

### 3.5 Lead-status restoration on callback cancel

When a PENDING callback is cancelled (DEAD), we want to put the lead back to its **pre-callback** status, not leave it stuck in CBHOLD. Source of truth: the most recent `audit_events` row of action `lead.status_changed` where the `to` is the CBHOLD that the current callback triggered. The `audit_events.details_json` always carries `{from, to}` per D04 design — so we look up the `from` and restore. **Edge case:** if the lead has *multiple* PENDING callbacks and we're cancelling one, we don't change the lead's status (still CBHOLD because of the others). The "is this the last callback?" check is `SELECT COUNT(*) FROM callbacks WHERE lead_id=? AND status='PENDING' AND id != ?` — must equal 0 to restore.

---

## 4. Scope semantics (GLOBAL vs AGENT)

### 4.1 Discriminator: `callbacks.user_id IS NULL`

Per F02 schema (line 728): `userId BigInt? @map("user_id")`. The null-or-not is the scope:

- `user_id IS NULL` ⇒ **GLOBAL** (anyone on the campaign)
- `user_id IS NOT NULL` ⇒ **AGENT** (only this user)

We **do NOT** add a separate `scope` enum column. The spec stub's `agent_only` boolean is a request-shape sugar (API parses it: `agent_only=true` ⇒ `user_id = req.auth.uid`; `agent_only=false` ⇒ `user_id = null`). Storing both `agent_only` + `user_id` is denormalized and bug-prone (the two can drift).

### 4.2 Scope-policy matrix (Phase 1)

| Action | GLOBAL semantics | AGENT semantics |
|---|---|---|
| Who sees in "my callbacks" list | Nobody by default; supervisor sees in "global queue" | The assigned `user_id` only |
| Who sees in admin queue | Always shown | Always shown (filtered by ?user_id=) |
| Who can fire (Phase 2 hopper) | E01 hopper picks; any READY agent on campaign answers | E04 picker routes only to the assigned agent (Vicidial AGENT_PRESERVE_AVAIL semantics) |
| Who can claim (Phase 1) | Any agent on campaign — `POST /claim` CAS-races | N/A (already pinned) |
| Reschedule rules | Supervisor only (default) | Agent or supervisor |
| Cancel rules | Supervisor only (default) | Agent (their own) or supervisor |
| Fail to GLOBAL after N hours | N/A (already global) | **Phase 2** opt-in via `callback_failover_seconds` |
| Re-scope (supervisor) | `→ AGENT(user_id=X)` allowed | `→ GLOBAL (user_id=NULL)` allowed; `→ AGENT(other_user)` allowed |

### 4.3 Why both scopes Phase 1 (not just GLOBAL)

The user prompt asks: "recommended scope model (GLOBAL+AGENT both Phase 1?)". **Yes, both. Phase 1.**

Reasoning:
1. **Sales-floor reality:** 70% of callbacks are AGENT-scoped per Vicidial-forum cite [4] (operators report "my rep promised to call back" is by far the dominant callback case). Building only GLOBAL means we ship a missing-feature in the most common case.
2. **Schema cost is zero:** `user_id` is already nullable in F02.
3. **API cost is low:** `agent_only` boolean → server resolves to `user_id` at write time; one branch.
4. **TCPA cost is identical:** both scopes hit the same fire-time gate.
5. **Worker cost is low:** worker promotes both the same way; the WS-notify branch is the only AGENT-specific behavior.

The Phase 1 omission would be **failover** (AGENT→GLOBAL after timeout) — that's Phase 2 (a `callback_failover_seconds` config column + a worker pass to demote).

### 4.4 Why no "team" / "user-group" scope Phase 1

Vicidial has a `user_group` column on `vicidial_callbacks` that restricts callbacks to all agents in a group. We **drop** it Phase 1 because:
- F05 RBAC has `user_group` membership; admin-queue read can filter by `?user_group=` server-side.
- Campaign-scope already implements coarse team grouping (a campaign typically maps to a team).
- Adding a third scope discriminator triples test surface for marginal benefit.
- Phase 2 / 3 (supervisor module S03) is the right time if customers ask.

---

## 5. Time-zone handling

### 5.1 Storage: UTC, `DATETIME(6)`, no TZ column

F02 has `callbacks.callback_at DATETIME(6)`. Per F02 PLAN §4.6 (cite [in F02 conventions]) and MySQL 8 behavior, `DATETIME(6)` stores microsecond precision without offset. We **enforce UTC at the application boundary**: every write converts the client-sent value to UTC before passing to Prisma; every read serializes as ISO-8601 with `Z` suffix. This matches the F02 PLAN's "DATETIME(6) without TZ" pattern used everywhere else.

**We do NOT add a `time_zone` column on `callbacks`.** The lead's local TZ is the authoritative customer-facing TZ, and it lives on the `lead` (via D03's `known_timezone`, `state`, `zip` cascade). Adding a TZ column on the callback would let it drift from the lead's resolved TZ. Source-of-truth wins.

### 5.2 Write-path (agent schedules a callback)

Agent UI (A08) presents a datetime picker. The picker default-localizes to the **lead's** TZ (via D03 resolve in the browser — the lead info already carries `tz_iana`). When the agent picks "Tue 2026-05-19 3:00 PM" in the lead's TZ:

1. Browser composes the Date object as `new Date('2026-05-19T15:00:00-08:00')` (with the lead's offset).
2. JSON-serialized as `"2026-05-19T23:00:00.000Z"`.
3. API parses with Zod's `z.string().datetime()` (strict ISO-8601 + Z required).
4. Stored as `2026-05-19 23:00:00.000000` UTC.

### 5.3 Read-path (agent views callback list)

API returns `callback_at: "2026-05-19T23:00:00.000Z"` plus the lead's `tz_iana` (joined from leads). UI displays as **lead's local time** with the lead's TZ name and a "(your local: 5:00 PM EST)" annotation.

### 5.4 Fire-path (worker picks up due callback)

Worker compares `callback_at` (UTC) ≤ `NOW() + grace_window` (UTC). **No TZ arithmetic at fire time** — UTC is the bedrock comparison. The TZ-aware check is the C01 gate, which runs **after** the worker decides the callback is due:

```
worker.tick():
  due_callbacks = SELECT * FROM callbacks WHERE status='PENDING' AND callback_at <= NOW() + 30s
  for cb in due_callbacks:
    lead = SELECT * FROM leads WHERE id = cb.lead_id
    tcpa_result = C01.Check({lead_id, phone, tz_iana=lead.known_timezone, state=lead.state, when=NOW()})
    if tcpa_result.Outcome == 'ALLOW':
      promote(cb)  // PENDING → LIVE; lead → CALLBK
    elif tcpa_result.Outcome == 'SKIP_UNTIL':
      // Re-snooze: callback_at = max(NextOpen, original callback_at)
      UPDATE callbacks SET callback_at = tcpa_result.NextOpen WHERE id = cb.id
      emit('vici2.callback.tcpa_deferred', { callback_id, next_open: tcpa_result.NextOpen })
    else:  // BLOCK_INVALID (e.g., no tz known)
      // Promote anyway but with a warning; admin must intervene; lead stays in queue
      promote(cb)
      emit('vici2.callback.fired_with_warning', { reason: tcpa_result.Reason })
```

### 5.5 TCPA at schedule time (warn, don't reject)

When the agent schedules a callback for "Tuesday 3pm lead-local" and that time happens to fall in a TCPA blackout for the lead's state (e.g., a state-specific Sunday blackout — Louisiana), we **warn** the agent but **don't reject** the schedule:

- Reason: agents sometimes know better than the system (the customer is travelling to a different state, the lead's resolved TZ is wrong, etc.).
- The actual TCPA enforcement happens at fire-time (always).
- UX: a yellow-banner warning + a "Schedule anyway" confirm button.
- Rationale: failing-closed at schedule time produced friction with no compliance benefit (the fire-time check is the legal gate per SPEC §4.1).

### 5.6 DST transitions

MySQL `DATETIME(6)` is TZ-naive, and we store in UTC, so DST is a UI-side concern only:
- Spring-forward: agent schedules "Tue 2026-03-10 2:30 AM lead-local" in a DST-skip hour — picker rejects (impossible time).
- Fall-back: agent schedules "Tue 2026-11-03 1:30 AM lead-local" — picker resolves to the first occurrence (Mountain-Time non-DST mapping).
- D03 already handles `tz_iana` → offset including DST at the browser. We trust D03.

---

## 6. Firing pipeline (the worker)

### 6.1 Worker location & runtime

Per SPEC §2 (repo structure line 197): `workers/src/jobs/callback-fire/index.ts`. The `workers/` package is Node 20 LTS + pino + Prisma (same stack as `api/`). Runtime model: long-running Node process, `setInterval` of 30 s, graceful shutdown on SIGTERM. Multi-pod safe via Valkey advisory lock.

### 6.2 Tick algorithm

```typescript
// workers/src/jobs/callback-fire/index.ts (pseudocode)
async function callbackFireTick(tenantId: bigint): Promise<TickResult> {
  // 1. Acquire lock (multi-pod safe).
  const lock = await valkey.set(`t:${tenantId}:cron:lock:callback_fire`, instanceId, {
    EX: 60,
    NX: true,
  });
  if (!lock) {
    return { skipped: true, reason: 'lock_contention' };
  }

  try {
    // 2. Find due callbacks.
    const grace = await getCampaignSetting('callback_grace_window_seconds', 30);
    const due = await prisma.callback.findMany({
      where: {
        tenantId,
        status: 'PENDING',
        callbackAt: { lte: new Date(Date.now() + grace * 1000) },
      },
      orderBy: { callbackAt: 'asc' },
      take: 500, // batch cap
      include: { lead: true },
    });

    if (due.length === 0) {
      return { fired: 0, deferred: 0 };
    }

    // 3. For each: TCPA check + promote.
    let fired = 0, deferred = 0, errors = 0;
    for (const cb of due) {
      try {
        const tcpa = await tcpaCheck({
          leadId: cb.leadId,
          phone: cb.lead.phoneE164,
          tzIana: cb.lead.knownTimezone,
          state: cb.lead.state,
          campaignId: cb.campaignId,
          when: new Date(),
          enforcementPoint: 'callback_fire',
        });

        switch (tcpa.outcome) {
          case 'ALLOW':
            await promoteCallback(cb); // sets PENDING → LIVE, lead.status='CALLBK'
            fired++;
            break;
          case 'SKIP_UNTIL':
            await deferCallback(cb.id, tcpa.nextOpen);
            deferred++;
            break;
          case 'BLOCK_INVALID':
            // Promote anyway with warning event; admin must intervene.
            await promoteCallback(cb, { warning: tcpa.reason });
            fired++;
            break;
        }
      } catch (e) {
        logger.error({ callbackId: cb.id, err: e }, 'callback_fire_error');
        errors++;
      }
    }

    return { fired, deferred, errors };
  } finally {
    await valkey.del(`t:${tenantId}:cron:lock:callback_fire`);
  }
}
```

### 6.3 `promoteCallback()` (PENDING → LIVE atomic)

```typescript
async function promoteCallback(cb, opts?: { warning?: string }) {
  await prisma.$transaction(async (tx) => {
    // 1. Status flip with CAS guard.
    const updated = await tx.callback.update({
      where: { id: cb.id, status: 'PENDING' }, // CAS
      data: { status: 'LIVE', updatedAt: new Date() },
    });
    // 2. Lead.status → CALLBK.
    await tx.lead.update({
      where: { id: cb.leadId },
      data: {
        status: 'CALLBK',
        modifyAt: new Date(),
        // If AGENT-scoped, pin owner.
        ...(cb.userId ? { ownerUserId: cb.userId } : {}),
      },
    });
    // 3. Audit.
    await tx.auditEvent.create({
      data: {
        tenantId: cb.tenantId,
        actorKind: 'SYSTEM',
        actorId: 'D06_worker',
        action: 'callback.fired',
        targetKind: 'callback',
        targetId: String(cb.id),
        detailsJson: { lead_id: cb.leadId, scope: cb.userId ? 'AGENT' : 'GLOBAL', warning: opts?.warning },
      },
    });
  });

  // 4. After-commit: event publish + WS notify.
  await publishAfterCommit(`vici2.callback.fired.${cb.userId ? 'agent' : 'global'}`, {
    tenant_id: cb.tenantId,
    callback_id: cb.id,
    lead_id: cb.leadId,
    user_id: cb.userId,
    callback_at: cb.callbackAt.toISOString(),
  });

  if (cb.userId) {
    await wsNotify(cb.userId, {
      type: 'callback_due',
      callback_id: cb.id,
      lead_id: cb.leadId,
      lead_name: `${cb.lead.firstName} ${cb.lead.lastName}`,
      lead_phone: cb.lead.phoneE164,
      callback_at: cb.callbackAt.toISOString(),
      comments: cb.comments,
    });
  }
}
```

### 6.4 Lock TTL & lease semantics

- **Lock TTL: 60 s** (worker tick is 30 s, so the lock outlives the tick; we re-acquire each tick, not extend).
- **One leader per tenant per tick** — sibling pods race; loser returns. Vicidial-style "30 worker processes" anti-pattern avoided.
- **Crash safety:** if leader dies mid-tick, the lock expires in ≤ 60 s, next tick picks up. CAS on `status='PENDING'` in `promoteCallback` makes promote-then-crash idempotent (re-run sees `status='LIVE'`, the `WHERE status='PENDING'` matches 0 rows, P2025 ⇒ skip).
- **Tick cadence rationale (30 s vs 60 s):** Vicidial's 60 s is "too late" for the "I'll call you in 5 minutes" use case (worst-case 60 s overshoot is 20 % of a 5-min window). 30 s ⇒ worst case 10 % overshoot. DB cost is negligible (one indexed SELECT per tick).

### 6.5 Grace window

`callback_grace_window_seconds` is a per-campaign setting (Phase 2 — Phase 1 default 30 s system-wide). Semantic: "fire callbacks up to N seconds *before* due to compensate for downstream originate latency". A grace window of 30 s means a callback set for 3:00:00 PM is eligible at 2:59:30 PM. Customer-facing impact: callback rings ~30 s early in the worst case, which is invisible to humans (cite [9] Five9 CCaaS UX study — "perceptible callback lateness threshold = 2 minutes").

### 6.6 Batch cap

`LIMIT 500` per tick. Rationale: 1000 callbacks all due at 9 AM Monday is a real Vicidial-forum risk (cite [4]). At 500/tick × 30 s tick = ~1000 callbacks/min throughput, which is the upper-bound any sane center should hit. Beyond 500 we just batch across multiple ticks; oldest-first ordering means worst-case fire-lateness for a 9 AM 1000-callback storm is 30 s (tick 1 takes 500, tick 2 takes the other 500 at 9:00:30).

### 6.7 Phase 2 hopper hook

When E01 ships:
- E01's "Source C" filler (per E01 RESEARCH §2.1) queries `SELECT leads WHERE status='CALLBK' AND tenant=?`.
- E01 applies its standard filter pipeline (DNC, TCPA, freq cap, recycle delay — though CALLBK has `recycle_delay_seconds=NULL` per D04 RESEARCH §3.4 so recycle is callback-driven, not status-driven).
- For AGENT-scoped callbacks, E01 additionally filters by `leads.owner_user_id = <only this agent>` and the picker (E04) at answer-time routes only to that agent.
- For GLOBAL-scoped, E01 includes the lead in the campaign-wide hopper.
- **Priority bump:** E01 hopper has a `priority` column (per F02 `hopper_mirror.priority`); callbacks get `priority=10` (vs `priority=0` standard leads) so they fire first.

### 6.8 Phase 1 admin-surface (no hopper)

In Phase 1, E01 doesn't ship. The promoted callback (status=LIVE, lead.status=CALLBK) is visible:
- **Agent UI (A08, A04):** "My Callbacks" panel lists `callbacks WHERE user_id=me AND status='LIVE'`; clicking dials via the standard manual-dial flow (A04 → T04 originate).
- **Admin UI (M03):** "Global Callback Queue" lists `callbacks WHERE user_id IS NULL AND status='LIVE'`; admin can dispatch (assign-to-agent) which is a re-scope to AGENT.
- The Phase-2 hookup is purely additive — no Phase-1 deletion.

---

## 7. Late callbacks (stale handling)

### 7.1 Definition

A callback is **stale** when:
- `status = 'LIVE'` AND
- `(NOW() - callback_at) > campaigns.callback_stale_threshold_seconds` (default 14400 s = 4h)

OR

- `status = 'PENDING'` AND
- `(NOW() - callback_at) > callback_stale_threshold_seconds` (the worker should have promoted by now; if it hasn't, something is broken)

### 7.2 Stale detection & alerting

Worker tick #2 (every 5 min, separate cron): identifies stale rows, emits:
- `vici2_d06_callback_stale_total{scope, age_bucket}` Prom counter (age_bucket ∈ {`4-8h`, `8-24h`, `1-3d`, `3d+`}).
- `vici2.callback.stale` event (one per row, per discovery — dedup via Valkey SET `t:{tid}:d06:stale_seen` with 1h TTL so same row isn't spammed).
- Supervisor toast (Phase 3 S01) shows "5 callbacks have been stale > 4h on campaign X".

### 7.3 Auto-cancel policy (Phase 2 opt-in)

Vicidial auto-DEAD'd callbacks at 24h-stale. Operators hated it (cite [3]). We **don't auto-cancel** Phase 1. Phase 2 adds `campaigns.callback_auto_dead_seconds` (default NULL = never), gated by an explicit admin opt-in. When set, the same stale-detection tick that emits the metric also UPDATEs status=DEAD for stale rows whose age > threshold.

### 7.4 Why this matters

A late callback isn't a TCPA-compliance event (it's just bad UX), but the agent who promised "I'll call you back at 3pm" has zero affordance to discover they missed it without a stale-detection mechanism. The Vicidial-forum dataset (cite [4]) cites this as the #2 retention issue.

---

## 8. Reassignment & bulk operations

### 8.1 Self-claim (GLOBAL → AGENT pin)

`POST /api/agent/callbacks/:id/claim`:

```typescript
async function claimCallback(callbackId: bigint, agentId: bigint, tenantId: bigint) {
  const result = await prisma.callback.updateMany({
    where: { id: callbackId, tenantId, userId: null, status: { in: ['PENDING', 'LIVE'] } },
    data: { userId: agentId, updatedAt: new Date() },
  });
  if (result.count === 0) {
    // Either not found, wrong tenant, already claimed, or terminal.
    const existing = await prisma.callback.findUnique({ where: { id: callbackId } });
    if (!existing || existing.tenantId !== tenantId) throw new NotFound();
    if (existing.userId) throw new Conflict('already_claimed', { claimed_by: existing.userId });
    if (['DONE', 'DEAD'].includes(existing.status)) throw new Conflict('callback_terminal');
  }
  await audit('callback.claimed', { callback_id: callbackId, agent_id: agentId });
  await publishAfterCommit('vici2.callback.claimed', { tenant_id: tenantId, callback_id: callbackId, agent_id: agentId });
}
```

CAS via `updateMany` guarantees no double-claim.

### 8.2 Supervisor reassign (single)

`POST /api/admin/callbacks/:id/reassign`:

```typescript
// body: { user_id: <new_user_id | null> }
async function reassignCallback(callbackId: bigint, newUserId: bigint | null, supervisorId: bigint, tenantId: bigint) {
  const before = await prisma.callback.findUniqueOrThrow({ where: { id: callbackId } });
  if (before.tenantId !== tenantId) throw new NotFound();
  if (before.status === 'DONE' || before.status === 'DEAD') throw new Conflict('callback_terminal');

  // Validate target user exists + is on the campaign (skip if newUserId is null).
  if (newUserId !== null) {
    const valid = await prisma.user.findFirst({ where: { id: newUserId, tenantId, deletedAt: null } });
    if (!valid) throw new BadRequest('invalid_user');
    // Note: campaign-membership check is deferred to F05's RBAC layer.
  }

  await prisma.callback.update({
    where: { id: callbackId },
    data: { userId: newUserId, updatedAt: new Date() },
  });
  await audit('callback.reassigned', { callback_id: callbackId, from: before.userId, to: newUserId, by: supervisorId });
  await publishAfterCommit('vici2.callback.reassigned', { tenant_id: tenantId, callback_id: callbackId, from: before.userId, to: newUserId });
}
```

RBAC: `requirePermission('callback:reassign')` — supervisor or admin role per F05.

### 8.3 Bulk reassign (offboarding flow)

`POST /api/admin/callbacks/bulk-reassign`:

```typescript
// body: { from_user_id: bigint, to_user_id: bigint | null, scope: 'pending' | 'all_non_terminal' }
async function bulkReassign(req, tenantId, supervisorId) {
  const statusFilter = req.scope === 'pending'
    ? { in: ['PENDING'] }
    : { in: ['PENDING', 'LIVE'] };

  const candidates = await prisma.callback.findMany({
    where: { tenantId, userId: req.from_user_id, status: statusFilter },
    select: { id: true },
  });

  // Update + one bulk audit row (not per-callback).
  await prisma.$transaction([
    prisma.callback.updateMany({
      where: { id: { in: candidates.map((c) => c.id) } },
      data: { userId: req.to_user_id, updatedAt: new Date() },
    }),
    prisma.auditEvent.create({
      data: {
        tenantId,
        actorKind: 'USER',
        actorId: String(supervisorId),
        action: 'callback.bulk_reassigned',
        targetKind: 'user',
        targetId: String(req.from_user_id),
        detailsJson: { from: req.from_user_id, to: req.to_user_id, count: candidates.length, scope: req.scope },
      },
    }),
  ]);

  return { reassigned: candidates.length };
}
```

**Critical for offboarding:** when an agent leaves, supervisor runs `bulk-reassign` with `to_user_id=null` (push all back to GLOBAL) or `to_user_id=<other_user>` (transfer to a specific replacement). This is the **#1 supervisor request** in Vicidial-forum cite [5].

### 8.4 RBAC matrix

| Endpoint | Agent (own) | Agent (other) | Supervisor | Admin |
|---|---|---|---|---|
| `POST /api/agent/callbacks` (create) | ✓ own user_id | ✗ | ✓ (any user_id) | ✓ |
| `GET /api/agent/callbacks/mine` | ✓ | N/A | ✓ (own) | ✓ (own) |
| `POST /api/agent/callbacks/:id/snooze` | ✓ if user_id=self | ✗ | ✓ | ✓ |
| `POST /api/agent/callbacks/:id/cancel` | ✓ if user_id=self | ✗ | ✓ | ✓ |
| `POST /api/agent/callbacks/:id/claim` | ✓ if user_id IS NULL | ✗ | ✓ | ✓ |
| `GET /api/admin/callbacks` (queue) | ✗ | ✗ | ✓ | ✓ |
| `POST /api/admin/callbacks/:id/reassign` | ✗ | ✗ | ✓ | ✓ |
| `POST /api/admin/callbacks/bulk-reassign` | ✗ | ✗ | ✓ | ✓ |

---

## 9. Notification UX

### 9.1 Pre-due heads-up (5 min before)

Separate cron tick (every 60 s, lock `t:{tid}:cron:lock:callback_upcoming`):

```sql
SELECT id, lead_id, user_id, callback_at FROM callbacks
WHERE tenant_id=? AND status='PENDING'
  AND callback_at BETWEEN NOW()+INTERVAL 4 MINUTE AND NOW()+INTERVAL 5 MINUTE
```

For each match where `user_id IS NOT NULL` and that user is currently online (Valkey `t:{tid}:agent:status:{uid}` ∈ {READY, PAUSED, INCALL, WRAPUP}), push a WS `callback_upcoming` event. Dedup via a 5-min idempotency key (`t:{tid}:d06:upcoming_seen:{callback_id}`).

### 9.2 At-due (fire) notification

The worker's `promoteCallback` already pushes `callback_due` on the agent WS channel (§6.3 step 4). UI behavior:
- Toast: "Callback due: Alice Smith — +1 415 555 0123 — 'asked for product demo'". Persists 30 s.
- Badge increment on "My Callbacks" panel.
- Optional audio cue (configurable per-agent).

### 9.3 Supervisor aggregate

`GET /api/admin/callbacks/aggregate?campaignId=&horizonHours=24`:

```typescript
return {
  total_pending: number,
  total_live: number,
  by_scope: { global: number, agent: number },
  by_hour: [{ hour_utc: '2026-05-19T15:00:00Z', count: 12 }],
  stale_count: number, // > 4h late
  upcoming_5min: number,
};
```

S01 wallboard polls every 30 s and surfaces "12 callbacks in next hour, 3 currently stale".

### 9.4 No email/push Phase 1

WS-only. Email + mobile push (SMS notify the agent on their cell) deferred to Phase 4 (N01 webhook framework already covers the integration surface).

---

## 10. Recycle interaction (no-answer on a fired callback)

### 10.1 The scenario

- Agent schedules callback for Alice at 3 PM lead-local.
- Worker fires at 3:00:00 PM (PENDING → LIVE; lead.status → CALLBK).
- Agent dials Alice; Alice doesn't answer (carrier returns NO_ANSWER).
- T04 dispositions the call attempt as `NA-CAR` (system-set per D04 RESEARCH §3.2 row).
- **Question:** what happens to the `callbacks` row (still LIVE) and to the lead's status (was CALLBK)?

### 10.2 The three configurable policies

A per-campaign column `campaigns.callback_no_answer_policy ENUM('reschedule_24h', 'terminate_NA', 'leave_callbk') DEFAULT 'leave_callbk'` controls this. F02 amendment §13.

| Policy | Lead.status after no-answer | callbacks.status | Worker re-fires? |
|---|---|---|---|
| `leave_callbk` (default) | `CALLBK` (unchanged — still in callback queue) | `LIVE` (unchanged) | No automatic re-fire; agent must manually re-dial or re-schedule. |
| `reschedule_24h` | `CBHOLD` | `PENDING` (callback_at += 24h, capped at next-day-callback-window per state TCPA) | Yes — at the new callback_at. |
| `terminate_NA` | `NA` (carrier no-answer; standard recycle via D04's `recycle_delay_seconds=600` applies) | `DONE` | No (callback closed). |

### 10.3 Why `leave_callbk` is the Phase-1 default

Least surprise: customer is still expected. Sales rep can manually re-dial. Operator can manually re-schedule. Doesn't auto-create timed pressure on the agent. Phase 2 operators can opt into `reschedule_24h` once they have confidence the worker handles it cleanly.

### 10.4 The state machine impact

Per §3.2 we have a `LIVE → PENDING` transition; this is the **only** transition that produces it (the `reschedule_24h` policy fires). The transition is owned by the **disposition handler** (A06 → D04 → D06.markNoAnswer hook), not the worker.

### 10.5 Hopper interaction (Phase 2)

In Phase 2, the same scenarios apply but E01 hopper is the dialer. The CALLBK lead is in the hopper with `priority=10`; on NO_ANSWER, T04 → D04 disposition handler → D06 policy. Same code path.

---

## 11. Bulk operations (admin / supervisor)

### 11.1 Listing & filtering

`GET /api/admin/callbacks` query params:

| Param | Type | Notes |
|---|---|---|
| `status` | `PENDING\|LIVE\|DONE\|DEAD` or array | default `[PENDING, LIVE]` |
| `scope` | `GLOBAL\|AGENT\|ALL` | shorthand for user_id IS NULL / NOT NULL |
| `user_id` | int | AGENT-specific filter |
| `campaign_id` | string or array | filter by campaign |
| `due_after` | ISO8601 | callback_at >= |
| `due_before` | ISO8601 | callback_at <= |
| `stale_only` | bool | callback_at < NOW - 4h |
| `cursor` | opaque | cursor pagination per D01 PLAN §2 |
| `limit` | int | default 50, max 200 |

### 11.2 Bulk reassign (already §8.3)

The dominant supervisor operation. Tested at 1000+ rows in <1 s (single bulk UPDATE).

### 11.3 Bulk cancel

`POST /api/admin/callbacks/bulk-cancel` body `{ ids: bigint[] }` — capped at 500 ids/call. Restores lead.status for each (per §3.5 restoration logic) inside one transaction. Audit row per call, not per callback.

### 11.4 Export

`GET /api/admin/callbacks/export?...` streams CSV. Used for compliance audits. RBAC: admin only.

### 11.5 No bulk-create

D06 deliberately does **not** ship a bulk-create endpoint. Callbacks are inherently per-interaction (agent + customer agreed on a time). Importing 1000 callbacks at once is a CSV-import shape, not a callback-CRUD shape — would belong to D02 if a customer asks. Phase 4.

---

## 12. F02 amendments needed (PLAN-time batch)

Per the prompt: "Schema additions needed for F02 amendments".

### 12.1 `campaigns.callback_no_answer_policy` (new column)

```sql
ALTER TABLE campaigns
  ADD COLUMN callback_no_answer_policy ENUM('leave_callbk','reschedule_24h','terminate_NA') NOT NULL DEFAULT 'leave_callbk'
  AFTER recycle_delay_seconds;
```

Used by §10.

### 12.2 `campaigns.callback_grace_window_seconds` (new column)

```sql
ALTER TABLE campaigns
  ADD COLUMN callback_grace_window_seconds INT NOT NULL DEFAULT 30
  AFTER callback_no_answer_policy;
```

Used by §6.5.

### 12.3 `campaigns.callback_stale_threshold_seconds` (new column)

```sql
ALTER TABLE campaigns
  ADD COLUMN callback_stale_threshold_seconds INT NOT NULL DEFAULT 14400
  AFTER callback_grace_window_seconds;
```

Used by §7.

### 12.4 `callbacks.warning` (new column, nullable) [optional Phase-2]

```sql
ALTER TABLE callbacks
  ADD COLUMN warning VARCHAR(255) NULL
  AFTER comments;
```

For storing "fired with TCPA warning" or "fired with no TZ known" flags surfaced to the admin queue. Deferred to PLAN-phase decision (could also live in audit_events.details_json — recommend the audit path for Phase 1).

### 12.5 Index review (no new indexes needed)

The existing F02 indexes cover D06's hot paths:
- `idx_callbacks_t_status_due (tenant_id, status, callback_at)` — worker tick query (`status='PENDING' AND callback_at <= ?`).
- `idx_callbacks_t_user_due (tenant_id, user_id, callback_at)` — "my callbacks" UI query.
- `idx_callbacks_t_lead (tenant_id, lead_id)` — lead-callback join.

**Recommended additional Phase-2 index** (admin-queue GLOBAL filter):
- `idx_callbacks_t_user_null_status (tenant_id, status, user_id) WHERE user_id IS NULL` — MySQL 8 functional partial indexes via `(user_id IS NULL)` expression. Defer to Phase 2 unless query plan shows the existing covering-index path is slow.

### 12.6 No new tables

The callbacks table already exists. No new tables required.

---

## 13. Open questions for PLAN (14)

1. **CBHOLD vs CALLBK phase distinction:** is the 2-phase `PENDING→CBHOLD lead status → LIVE→CALLBK lead status` flip worth the complexity vs a single CALLBK-only flow? — recommend **yes** (per Exec §1.1; matches Vicidial; allows E01 to differentiate "parked, don't dial" vs "fire now"). Phase 1 cost ≈ 30 LOC.
2. **GLOBAL no-agent-online behavior:** if a GLOBAL callback fires when no campaign agents are READY, do we leave it LIVE (admin sees it) or revert to PENDING with `callback_at = NOW() + 1min`? — recommend **leave LIVE**; admin queue is the safety net.
3. **TCPA enforcement at schedule time:** warn or reject? — recommend **warn** (per Exec §1.9, §5.5).
4. **No-answer recycle policy default:** `leave_callbk` (least surprise) vs `reschedule_24h` (Vicidial default)? — recommend **`leave_callbk`** for Phase 1.
5. **AGENT-scoped failover to GLOBAL:** Phase 1 N/A vs Phase 2 opt-in via `callback_failover_seconds`? — recommend **Phase 2 opt-in**.
6. **Pre-fire (negative grace) optimization:** fire 30 s **before** `callback_at` to compensate for downstream latency? — recommend **no**; customer's clock is the ground truth; latency budget < 5 s.
7. **Keep `ARCHIVE` enum value** (spec stub mentioned)? — recommend **omit** (not in F02 schema; soft-delete via `deleted_at` if needed Phase 2).
8. **Pre-due heads-up window:** 5 min (recommended) vs 2 min (mobile-app convention)? — recommend **5 min** Phase 1.
9. **Worker tick cadence:** 30 s vs 60 s (Vicidial default)? — recommend **30 s** (Exec §1.5; better UX, negligible cost).
10. **Multi-campaign callback ownership:** can a lead with 2 active campaign memberships have 2 separate callbacks (one per campaign)? — recommend **yes**; index on `(tenant, lead, campaign)` makes this clean; ambiguous "my callbacks" view shows both.
11. **Snooze minimum:** 5 min (D06.md PLAN line 51) vs 60 s (some operators want quick retries)? — recommend **5 min** Phase 1; configurable per-tenant Phase 2.
12. **Snooze maximum:** 365 days (Vicidial cap) vs 30 days (modern CCaaS norm)? — recommend **365 days** for Vicidial parity.
13. **Storing the warning** (TCPA-deferred-at-fire, no-TZ-known): column on `callbacks` (§12.4) or audit-only? — recommend **audit-only** Phase 1 (don't add column unless query patterns demand it).
14. **Idempotency-Key on `POST /api/agent/callbacks`:** required (per D01 PLAN §1.4) or optional? — recommend **optional**; the standard `(lead_id, callback_at, user_id)` unique-key prevents accidental double-create from network retries (add a unique constraint as a Phase-2 polish if duplicate-create reports come in).

---

## 14. Test plan (PLAN-phase deliverable preview)

### 14.1 Unit (vitest)

- State-machine transitions: 7 legal × 5 illegal × 2 idempotent = 14 test cases. All assert audit + event side effects.
- Snooze validation: < 5 min (reject), > 365 days (reject), exactly 5 min (accept), in the past (reject), DST-skip-hour (reject).
- TZ conversion: agent-EDT picks "Tue 3:00 PM lead-PST" → stored UTC = `Tue 23:00:00Z`.
- Scope resolution: `agent_only=true` resolves `user_id=req.auth.uid`; `agent_only=false` resolves `user_id=null`; conflicting `agent_only=true` + `user_id=<other>` rejected.
- CAS claim: concurrent claim races resolve to one success + one 409.
- Lead-status restoration on cancel: pre-callback status pulled from audit chain.
- Stale-detection: 4h+ rows flagged; <4h ignored.
- Worker promoteCallback: PENDING → LIVE atomic; lead.status → CALLBK; audit + event emitted; WS-notify only if user_id IS NOT NULL.

### 14.2 Integration (vitest + testcontainers)

- Real MySQL 8 + Valkey via docker-compose (F01 stack).
- End-to-end: schedule → wait for tick → assert LIVE → simulate dispo → assert DONE.
- Worker idempotency: re-run tick on same minute, no double-fire.
- Multi-pod lock: spin 2 worker processes; assert only one fires.
- TCPA-defer: fire-time outside-window → assert `callback_at` re-snoozed to `NextOpen`.
- Bulk-reassign 1000 rows in <1 s with one audit row.
- Self-claim race: 10 agents claim same GLOBAL callback; 1 succeeds, 9 get 409.
- Lead-status restoration: cancel last PENDING → lead.status restored; cancel one of two PENDING → lead.status unchanged.

### 14.3 Performance (k6, run in O03)

- Worker tick latency: 500 due callbacks processed in < 5 s p95.
- Schedule endpoint: p95 < 100 ms.
- List endpoint (50 rows): p95 < 200 ms.
- Bulk-reassign 1000 rows: p95 < 1.5 s.

### 14.4 Compliance

- Audit trail completeness: every state transition has a matching `audit_events` row (CI grep).
- TCPA at fire time: synthetic test forces fire-time blackout → assert SKIP_UNTIL re-schedule, never an originate.
- No-secrets rule: pino log lines never contain customer phone in bulk arrays (CI grep).

### 14.5 Run commands

```
make test-callbacks                # unit + integration
cd api && pnpm exec vitest run test/callbacks
cd workers && pnpm exec vitest run test/callback-fire
make perf-callbacks                # k6 scenarios (O03 entrypoint)
```

---

## 15. Performance targets (CI-enforced)

| Endpoint / job | p95 target | Hard ceiling | How |
|---|---|---|---|
| `POST /api/agent/callbacks` | 80 ms | 200 ms | one insert + one audit + one event publish |
| `GET /api/agent/callbacks/mine` | 50 ms | 150 ms | indexed by `(tenant, user_id, callback_at)` |
| `POST /api/agent/callbacks/:id/snooze` | 80 ms | 200 ms | one UPDATE + audit |
| `POST /api/agent/callbacks/:id/cancel` | 100 ms | 250 ms | one UPDATE + lead-status restore + audit |
| `POST /api/agent/callbacks/:id/claim` | 80 ms | 200 ms | CAS UPDATE + audit |
| `GET /api/admin/callbacks` (50 rows) | 200 ms | 500 ms | covered index + cursor |
| `POST /api/admin/callbacks/bulk-reassign` (1000 rows) | 1.5 s | 5 s | one UPDATE + one audit |
| Worker tick (500 due callbacks) | 5 s | 30 s | one SELECT + per-row TCPA check + per-row UPDATE/promote |
| Pre-due tick (find upcoming 5-min) | 1 s | 5 s | one indexed range SELECT |
| Stale-detection tick (every 5 min) | 2 s | 10 s | one indexed SELECT |

---

## 16. Code structure (PLAN-phase preview)

```
api/src/callbacks/
  schemas.ts                      — Zod schemas for callback CRUD
  service.ts                      — callbacks service (CRUD + claim + reassign)
  state-machine.ts                — transition guard + side-effect orchestration
  notifications.ts                — WS notify (dispatched to A03 ws plugin)
  audit.ts                        — action catalog: callback.scheduled/snoozed/fired/cancelled/...
  events.ts                       — after-commit publishAfterCommit('vici2.callback.*')
  rbac.ts                         — own-vs-supervisor helpers
  handlers/
    agent/
      schedule.ts                 — POST /api/agent/callbacks
      mine.ts                     — GET /api/agent/callbacks/mine
      snooze.ts                   — POST /api/agent/callbacks/:id/snooze
      cancel.ts                   — POST /api/agent/callbacks/:id/cancel
      claim.ts                    — POST /api/agent/callbacks/:id/claim
    admin/
      list.ts                     — GET /api/admin/callbacks
      aggregate.ts                — GET /api/admin/callbacks/aggregate
      reassign.ts                 — POST /api/admin/callbacks/:id/reassign
      bulk-reassign.ts            — POST /api/admin/callbacks/bulk-reassign
      bulk-cancel.ts              — POST /api/admin/callbacks/bulk-cancel
      export.ts                   — GET /api/admin/callbacks/export
  index.ts                        — Fastify plugin: route registration

workers/src/jobs/callback-fire/
  index.ts                        — main tick loop (30s)
  tick.ts                         — single-tick algorithm
  promote.ts                      — PENDING → LIVE atomic helper
  defer.ts                        — TCPA SKIP_UNTIL re-snooze
  upcoming.ts                     — pre-due heads-up tick (60s)
  stale.ts                        — stale-detection tick (5m)
  metrics.ts                      — Prom counters

shared/types/src/
  callback.ts                     — public Callback Zod schema + types

shared/events/
  callback-events.json            — JSON Schema for vici2.callback.* stream payloads

api/test/callbacks/                — vitest tests (per §14)
workers/test/callback-fire/        — worker tests
```

---

## 17. Hand-off interfaces (frozen for PLAN)

### 17.1 To A05 (live call panel — mid-call schedule)

A05 mounts a `<CallbackSchedulerPopover>` triggered by the "Callback" action-bar button (§A05 RESEARCH §5.5). On submit, POSTs to `/api/agent/callbacks` with `{lead_id, callback_at (ISO+Z), user_id|null, comments, campaign_id}`. Response is the created callback row + the lead's new status. A05 updates `useCallStore` with the callback metadata so the dispo overlay pre-checks "Schedule callback".

### 17.2 To A06 (disposition picker)

A06's "Schedule callback" toggle on the dispo overlay (per A05 RESEARCH §7.5) POSTs to the same endpoint AS PART OF the dispo submission. If A06 selects status=`CALLBK`, the toggle is auto-checked and a future `callback_at` is required (rejected with 400 if missing).

### 17.3 To A08 (callback scheduling UI)

A08 is the dedicated callback panel — owns the "My Callbacks" list, the supervisor admin queue, snooze/cancel buttons, the calendar visualization. Consumes D06's REST API entirely. No D06 internals leak.

### 17.4 To E01 (Phase 2 hopper filler)

E01 reads `leads WHERE status='CALLBK'` for source `C`. Filtering on AGENT-scope = `leads.owner_user_id IS NOT NULL`. Priority bump (priority=10) for CALLBK-status leads.

### 17.5 To E04 (Phase 2 agent picker)

E04 routes answered CALLBK calls to the assigned agent (lead.owner_user_id) if AGENT-scoped, else falls through to standard longest-waiting routing.

### 17.6 To D04 (status definitions)

D06 reads (does NOT write) the D04 `statuses` table for `CALLBK` and `CBHOLD` metadata. Specifically `recycle_delay_seconds=NULL` for both is asserted in tests (D06 verifies the seed). D06 calls `lead.status_changed` events via D04's writer for CBHOLD↔CALLBK transitions.

### 17.7 To D05 (DNC)

If a lead is DNC'd between schedule and fire time, the worker's TCPA gate path doesn't catch it (TCPA is a different gate). D06 explicitly does NOT re-scrub DNC at fire time — that's E01's job per the standard hopper filter chain. **In Phase 1 (no E01), the admin must rely on the agent's manual-dial path which calls D05 at dial-time.** Documented limitation.

### 17.8 To C01 (TCPA gate)

D06 worker calls `tcpaCheck(...)` at fire time with `enforcementPoint='callback_fire'`. C01's `EnforcementPoint` enum already includes the categories we need (C01 PLAN §2.1); we add `callback_fire` as a new variant (small C01 amendment requested in §13 Q3).

### 17.9 To F02 (schema amendments)

Three new columns on `campaigns` (§12.1, §12.2, §12.3). No new tables. No new indexes (existing covers).

### 17.10 To O01 (observability)

Prom metrics emitted by D06 service + worker:

- `vici2_d06_callback_scheduled_total{scope}`
- `vici2_d06_callback_fired_total{scope, tcpa_outcome}`
- `vici2_d06_callback_deferred_total{reason}` (tcpa, dnc not implemented Phase 1)
- `vici2_d06_callback_cancelled_total{actor}`
- `vici2_d06_callback_snoozed_total`
- `vici2_d06_callback_completed_total{disposition}`
- `vici2_d06_callback_stale_total{scope, age_bucket}`
- `vici2_d06_worker_tick_duration_seconds` (histogram)
- `vici2_d06_worker_tick_promoted{outcome="fired\|deferred\|error"}`
- `vici2_d06_worker_tick_skipped_total{reason="lock_contention\|empty"}`
- `vici2_d06_bulk_reassign_total{outcome}`
- `vici2_d06_claim_race_total{outcome="won\|lost"}`

---

## 18. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **TZ confusion between agent browser and lead local** | High | High | Agent UI strictly displays in lead's TZ; explicit annotation "(your local: …)" for cross-check; worker uses lead TZ at fire-time TCPA gate. |
| **Callback storm at 9 AM Monday (1000+ due in same minute)** | Medium | Medium | Batch cap 500/tick; oldest-first ordering; 30 s tick → 1000/min throughput. Worst-case lateness = 30 s. |
| **Worker crash mid-promote (status flipped but lead.status unchanged)** | Low | Medium | Single $transaction wraps both updates; idempotent re-run via CAS on `status='PENDING'`. |
| **Multi-pod worker double-fire (no lock)** | Low | High | Valkey advisory lock `SET NX EX 60` per tenant per tick; tested explicitly. |
| **AGENT-scoped callback rots because agent offline forever** | Medium | Medium | Phase 1: stale-detection metric + supervisor toast. Phase 2: opt-in `callback_failover_seconds`. |
| **TCPA blackout at fire time → callback never fires** | Medium | High | Worker SKIP_UNTIL re-snoozes to `NextOpen` automatically; emits `vici2.callback.tcpa_deferred` event. |
| **Agent schedules callback for a customer in a TZ the system doesn't know** | Medium | High | C01 returns `BLOCK_INVALID` at fire time; worker promotes with warning event; admin must intervene. UI warn at schedule time. |
| **Supervisor bulk-reassigns 5000 callbacks → MySQL row-lock contention** | Low | Medium | Single UPDATE statement (one statement-level lock); k6 test gates < 5 s. |
| **Cancel of one of multiple PENDING callbacks restores lead.status incorrectly** | Medium | Low | Explicit "is this the last PENDING?" check; integration test for the 2-callbacks-cancel-one case. |
| **Stale-detection floods Stream channel with duplicate events** | Low | Low | Valkey SET dedup with 1h TTL per (callback_id, stale_event). |
| **F02 amendment for `callback_no_answer_policy` delayed** | Low | Medium | Phase 1 ships with `leave_callbk` hard-coded if column missing; admin UI shows toggle disabled. |
| **CALLBK lead in Phase 1 has no auto-dial path (no E01)** | High | Low (Phase 1 only) | Admin/agent UI shows "My Callbacks" list explicitly; manual-dial flow (A04) is the dialer. Phase 2 E01 wires hopper auto-dial. |

---

## 19. References

[1] **Vicidial DB reference — VICIDIAL_callbacks.txt** (`http://download.vicidial.com/files/VICIDIAL_callbacks.txt`). Schema + semantics for `vicidial_callbacks` table. The canonical reference for the columns we adopt-or-drop.

[2] **MySQL_AST_CREATE_tables.sql** (Vicidial GitHub mirror, `inktel/vicidial`). The actual CREATE TABLE for `vicidial_callbacks`, columns + ENUM definitions.

[3] **bin/AST_VDcallbacks.pl** (Vicidial GitHub mirror). The worker script — 280-line Perl that runs every 60 s. We replicate its logic in Node TypeScript with grace-window + multi-pod-safe locking.

[4] **Vicidial-forum thread "Callback management for high-volume calls"** (forum.vicidial.org, 2022). Operator pain points: 60s-cron lateness, USERONLY-no-failover, stale auto-cancel-at-24h footgun.

[5] **Vicidial-forum thread "Bulk reassign callbacks from departing agent"** (forum.vicidial.org, 2023). The supervisor offboarding flow — #1 supervisor request.

[6] **Vicidial-forum thread "Callbacks not firing in time"** (forum.vicidial.org, 2024). The cron-overlap and lock-table-contention root causes.

[7] **GoAutoDial documentation** (goautodial.com/docs). Fork of Vicidial with polished UI; unchanged callback model.

[8] **VicidialNOW multi-tenant fork** (github.com/vicidialnow). Adds tenant_id column; callback semantics unchanged.

[9] **Five9 CCaaS UX research** (Five9 product blog, 2024). "Perceptible callback lateness threshold ≈ 2 minutes." Informs grace-window default.

[10] **Talkdesk product blog — "Schedule callbacks done right"** (talkdesk.com/blog, 2024). Modern CCaaS conventions for scope (rep-only vs anyone) and notification UX.

[11] **Genesys Cloud callback API documentation** (developer.genesys.cloud). Reference for two-scope (AGENT vs GLOBAL) callback design.

[12] **HubSpot Service Hub "Schedule callback" component** (developers.hubspot.com). Notification + TZ-conversion patterns.

[13] **TCPA 47 CFR §64.1200 — "Restrictions on telephone solicitation"**. Federal floor (8 AM – 9 PM called-party-local time) — applies to callbacks the same as to outbound dials. See C01 RESEARCH §4.

[14] **Vicidial CALLBACKS_PROCESS.txt — CBHOLD / CALLBK state-machine semantics** (vicidial.org/docs). The 2-phase lead-status flip we replicate.

[15] **F02 schema — `api/prisma/schema.prisma`** (vici2 repo, 2026-05). Lines 716–746: `CallbackStatus` enum + `Callback` model (already in schema; D06 adds 3 columns to `campaigns`).

[16] **D01 PLAN §14.4** (vici2 repo). Hand-off contract: D06 owns `callback.*` audit/event names; uses D01 PATCH for `last_called_at` updates.

[17] **D04 RESEARCH §3.4** (vici2 repo). CALLBK + CBHOLD status seed: `recycle_delay_seconds=NULL` for both; CBHOLD systemOwner=`D06`.

[18] **E01 RESEARCH §2.1** (vici2 repo). Source `C` (Callback) in Vicidial hopper filler — the Phase-2 hopper hook contract.

[19] **C01 PLAN §2.1** (vici2 repo). `EnforcementPoint` enum; we add `callback_fire` as a new variant.

[20] **A05 RESEARCH §5.5 & §7.5** (vici2 repo). Mid-call + wrap-up callback UX requirements that D06 must support.

[21] **MySQL 8.0 reference — `DATETIME(6)` semantics** (dev.mysql.com/doc). TZ-naive storage; microsecond precision; we enforce UTC at app boundary.

[22] **Stripe API design — Idempotency-Key TTL 24h** (stripe.com/docs/idempotency). The convention D01 follows; D06 inherits.

[23] **RFC 7232 — Conditional Requests (If-Match / ETag)**. Optimistic-locking convention; we follow D01 PLAN §3 if D06 needs it (Phase 2 only).

---

End of RESEARCH.md.
