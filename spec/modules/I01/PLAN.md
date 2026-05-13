# I01 — In-Groups (Inbound Queue + Agent Skill Routing) — PLAN

| Field | Value |
|---|---|
| **Module** | I01 — inbound queue service; DID→in-group routing; skill-based dispatch |
| **Phase** | 3 (Inbound/Blended) |
| **Author** | I01-PLAN sub-agent (Claude Sonnet 4.6, 1M ctx) |
| **Date** | 2026-05-13 |
| **Status** | PROPOSED — awaiting orchestrator/lead review |
| **RESEARCH** | [`spec/modules/I01/RESEARCH.md`](./RESEARCH.md) — 19 sections, 15 failure modes, 14 open questions |
| **Module spec** | `spec/modules/I01.md` (superseded where this PLAN conflicts — see §20) |
| **Depends on (FROZEN)** | F02 PLAN (schema: `ingroups`, `ingroup_agents`, `did_numbers`); T01 PLAN (ESL primitives: `UUIDTransfer`, `uuid_broadcast`, `bgapi`); T03 PLAN (conference-per-agent, `TransferCustomer`, hold profile, RFC-002 naming); F03 PLAN (dialplan public/default slots, `mod_say_en`, `mod_xml_curl` loaded, `local_stream://moh`); F04 PLAN (Redis key namespace, agent ZSETs); E02 PLAN (`t:{tid}:agents:by_status:READY` ZSET ownership); D01 PLAN (`lookupLeadByPhone` interface); D04 PLAN (disposition status catalog including DNC inbound path); D06 PLAN (`schedulePriorityCallback`); A05 PLAN (call panel — inbound preview event shape) |
| **Blocks** | I02 (DID→extension naming frozen here); I03 (IVR depends on I01 extension naming); I04 (blended: agent state transitions); I05 (voicemail overflow endpoint); S01 (wallboard Redis keys); S02 (eavesdrop — post-dispatch only); A05 (inbound preview WS event schema) |

---

## 0. TL;DR — 15-bullet decision summary

1. **Custom Go queue, NOT `mod_callcenter`.** This is the primary PLAN-phase deliberate refinement of I01.md. Three reasons each independently sufficient: (a) conference-per-agent is SACRED — `mod_callcenter` bridges point-to-point, not into existing conferences; (b) dual state machines (Redis agent state + mod_callcenter internal state) produce documented split-brain bugs; (c) multi-attribute skill matching requires combinatorial queue explosion under `mod_callcenter`. Full decision rationale in §2. F03 PLAN §8 already deferred `mod_callcenter`; I01 confirms: **do not load the module**.

2. **Phase 1 scope: DID→in-group direct.** Single dialplan transfer from I02's public extension to `ingroup_{id}` in the default context. No nested IVR menus in Phase 3 (I03 is a sibling module that consumes I01's frozen extension naming). Phase 3+ IVR in §1.

3. **Schema additions: 4 new tables + additive ALTER on 2 existing tables.** Tables: `ingroup_skills`, `agent_skills`, `queue_calls` (partitioned monthly), `queue_log` (partitioned monthly). ALTER: `did_numbers` (+4 columns), `ingroups` (+7 columns). All in I01 migration; reversible. Detail in §3.

4. **Skill model: free-form (key, value, proficiency 1-10) with required/optional gating.** Formula: score = Σ (proficiency − min_proficiency + 1) × weight for each matched skill requirement; any `required=true` clause with agent proficiency < min_proficiency = disqualified (score = nil). Higher score = better. Zero required skills = every assigned agent eligible (broad queue). Detail in §4.

5. **Default routing algorithm: `skill-priority` with longest-idle tiebreaker. Sticky-agent OFF by default.** Five algorithms ship in Phase 3: skill-priority, longest-idle, round-robin, top-down, fewest-calls. `ring-all` deferred to Phase 3+ (requires multi-leg originate with cancel-others logic). Per-in-group `ingroups.routing_strategy` ENUM column. Detail in §5.

6. **Redis ZSET is the queue; MySQL `queue_calls` is the audit.** Score = `enter_ts_ms − priority_boost_ms`. Lower score = dispatched first. On dispatcher restart, reconcile Redis from MySQL. Atomic dispatch via `dispatch_inbound.v1.lua` — a single Lua script touching 6 Redis keys atomically. Script is FROZEN in §6.

7. **Hold music: three-tier audio per in-group.** `moh_stream` (continuous loop), `welcome_audio` (one-shot on entry), position announcement every `announce_interval_sec` (default 30 s) using concatenated `mod_say` + pre-recorded prefix/suffix WAV. TTS via `mod_say_en` only (no external provider). No announcement when EWT < `announce_min_wait_sec` (default 60 s). Detail in §7.

8. **EWT formula: `pos × avg_handle_time / max(1, ready_agents)`. EWMA alpha = 0.1. No Erlang-C in Phase 3.** AHT seeded from last 100 inbound `call_log.talk_seconds` on startup; updated in-flight. Round UP to nearest 30 s for < 2 min, nearest 1 min thereafter. Detail in §8.

9. **Overflow: 3-level chain, configurable per in-group.** Entry gating: if queue full → `entry_full_action`; if outside business hours → `closed_action`. While waiting: if `max_wait_sec` elapsed → `no_agent_action`. Actions: `voicemail` (I05), `hangup` (apology TTS), `overflow_ingroup` (re-queue, max 2 hops), `callback_offer`, `external_transfer`. Loop detector hard-stops at hop 3. Detail in §9.

10. **Priority boosts: DID-based (cap 600 s) + CRM-rank-based (cap 300 s), total cap 900 s.** Score = `enter_ts_ms − boost_ms`. VIP cap ensures a 16-minute-waiting regular caller overtakes a max-VIP caller. CRM lookup via `D01.lookupLeadByPhone` with 200 ms deadline. Detail in §10.

11. **Callback offer: operator opt-in, disabled by default.** After `callback_offer_after_seconds` (default 90 s), play offer via `play_and_get_digits` (1 digit, 5 s timeout). Press 1 → capture callback number → `D06.schedulePriorityCallback` → exit queue with `exit_reason=callback`. Preserve-position stamp on `callbacks.queue_position_at_offer`. 96-hour expiry. Detail in §11.

12. **Agent UX: inbound preview via WS event `inbound_call_offer`; 3 s preview window (configurable 0-10 s); auto-answer default ON.** Preview shows caller ID, in-group name, wait seconds, lead match. Agent reject within preview window → skip this agent, write `queue_log.agent_no_answer`, agent stays READY. ≥3 rejects/hour → auto-PAUSE with code `REJECT_LIMIT`. Detail in §12.

13. **Recording: inherits R01/R02 path. Recording disclosure on `did_numbers` column first, `ingroups` as fallback.** Inbound recording mode per-in-group: ENUM `NEVER, ONDEMAND, ALL, ALLFORCE`. TCPA does NOT apply to inbound. State consent law disclosure played before queue entry by I02 dialplan (via `did_numbers.recording_disclosure_audio`). Detail in §13.

14. **Pacing race fix: `dispatch_inbound.v1.lua` is atomic.** Before T03 `TransferCustomer`, the Lua script atomically removes agent from `t:{tid}:agents:by_status:READY` ZSET and `t:{tid}:ingroup:{igid}:ready_agents` ZSET, removes call from `t:{tid}:ingroup:{igid}:queue`, and updates agent HASH status to INCALL. E02 cannot read a stale READY count in the gap. Detail in §6 and §14.

15. **Dialplan extension naming FROZEN: `ingroup_{ingroup_id}` in `dialplan/default/60_ingroup_*.xml`.** I02 must `transfer ingroup_SUPPORT XML default` to hand off. I03 consumes the same extension. Static XML templating (not `mod_xml_curl`) for Phase 3. Extension rendered by `IngroupRenderer` Go service; `bgapi reloadxml` after each admin save. Detail in §15.

---

## 1. Goals and non-goals

### 1.1 Phase 3 goals (this PLAN)

| Goal | Detail |
|---|---|
| G1 | Accept inbound calls arriving at a DID, resolve to an in-group via I02 (DID table lookup), enqueue in the in-group queue |
| G2 | Route waiting calls to agents using skill-based matching and configurable algorithm (default: skill-priority + longest-idle tiebreaker) |
| G3 | Atomically remove agent from outbound pacing's READY pool on dispatch (fix blended pacing race) |
| G4 | Bridge customer leg into agent's existing per-agent conference (T03 conference-per-agent sacred invariant) |
| G5 | Announce queue position / EWT while caller waits; play hold music per in-group |
| G6 | Offer callback after configurable wait time; schedule D06 callback preserving queue position |
| G7 | Enforce overflow chain on full queue, max-wait exceeded, or closed hours |
| G8 | Push inbound-call preview event to agent UI (WS) before bridging; support auto-answer and reject |
| G9 | Record all inbound calls per in-group recording mode; play disclosure before queue entry |
| G10 | Emit structured events for S01 wallboard and queue_log audit table |
| G11 | Provide supervisor force-dispatch and kick-from-queue endpoints |
| G12 | Multi-pod-safe dispatcher with Redis `SET NX EX 5` dispatch lock per in-group |

### 1.2 Non-goals (Phase 3)

| Non-goal | Deferred to |
|---|---|
| NG1 | Nested IVR menus ("press 1 for sales") | I03 (sibling Phase 3 module) |
| NG2 | `mod_callcenter` usage | Never (deliberate refinement, see §2) |
| NG3 | `ring-all` routing algorithm | Phase 3+ (multi-leg originate complexity) |
| NG4 | Erlang-C EWT formula | Phase 4 backlog |
| NG5 | External CRM skill injection (N03/N04) | Phase 4 |
| NG6 | ADA/TTY relay | Phase 4 |
| NG7 | Blended agent (serves outbound AND inbound simultaneously) | I04 |
| NG8 | Voicemail recording and retrieval | I05 |
| NG9 | DID provisioning / number porting | I02 |
| NG10 | Auto-DNC on inbound hang-up | Never (caller initiated; admin-only via M06) |

### 1.3 Deliberate refinements from I01.md module spec

I01.md assumed `mod_callcenter`. This PLAN overrides that assumption. The public interface (REST endpoints for `/api/admin/ingroups`, DID routing via I02, agent assign/unassign) is unchanged. The internal mechanism (queue storage, dispatch algorithm, dialplan app) is different. This refinement is documented per the F03 PLAN §1.3 pattern. No RFC required because the external API surface is compatible.

---

## 2. Queue implementation decision: custom Go queue (FROZEN)

### 2.1 Decision

**Build a custom Go inbound queue service. Do NOT load `mod_callcenter`.** This decision is FROZEN for Phase 3.

F03 PLAN §8 explicitly deferred `mod_callcenter` loading to I01. I01 PLAN resolves that deferral: the module is NOT loaded in production.

### 2.2 Three independently-sufficient reasons

**Reason A — Conference-per-agent is SACRED (SPEC.md §4.4).**
T03 PLAN §1/§2 commit that every agent operates inside a persistent `agent_t{tid}_u{uid}@default` conference for the entire login session. Customer legs are `uuid_transfer`'d into that conference. `mod_callcenter`'s dispatch model is the inverse: it originates a *fresh* agent leg on each call and creates a point-to-point bridge. Reconciling these two models requires intercepting `cc_member_pre_answer_uuid`, suppressing mod_callcenter's originate, and issuing a manual `uuid_transfer` into the agent's existing conference — brittle, against the grain, and against the SPEC §4.4 invariant.

**Reason B — State machine coherence.**
Vici2 agent state lives in Redis (`t:{tid}:agent:{uid}` HASH, status ∈ READY/INCALL/WRAPUP/PAUSED). `mod_callcenter` maintains its own parallel agent state (Available/On Break/Logged Out + Idle/Waiting/Receiving/InQueueCall). Two state machines in production diverge. FreeSWITCH forum issue #2529 documents zombie calls when state diverges (member hangs up mid-originate; mod_callcenter doesn't catch up). We would need a hot-path Redis subscriber → `callcenter_config agent set status` translator on every single state transition — identical total work to building a custom queue, but with more failure modes.

**Reason C — Skill matching expressivity.**
`mod_callcenter` tiers are a single integer per (agent, queue). Multi-attribute matching (language=es AND product=billing AND tier≥2) requires one queue per skill combination: 4 languages × 4 products × 3 tiers = 48 queues for a typical contact center. Unmanageable. The custom Go queue evaluates skill sets against agent skill sets using the formula in §4 — no combinatorial explosion.

### 2.3 Cost acknowledged

~3,000 LOC Go (production + tests). This is the knowingly accepted cost. The custom queue inherits the same Valkey client, metrics framework, ESL primitives, and test harness as E02/E04 — marginal cost is lower than a greenfield service.

### 2.4 mod_callcenter conceptual carryovers

The following concepts from `mod_callcenter` are re-implemented in the custom queue:
- Score-based ZSET dispatch (score = enter_ts − priority_boost)
- Tier-reserve wait (sticky-agent "wait window" before fallback)
- Per-in-group wrap-up override
- Five routing strategies (ring-all deferred)
- Queue-position + EWT announcement

---

## 3. Schema

All tables and columns belong to I01's migration (`api/prisma/migrations/<timestamp>_i01_ingroups/`). Reversible (up.sql + down.sql). All tables have `tenant_id BIGINT NOT NULL DEFAULT 1` leading every composite index per F02 PLAN §0 rule 4.

### 3.1 New table: `ingroup_skills`

```sql
CREATE TABLE ingroup_skills (
  tenant_id        BIGINT NOT NULL DEFAULT 1,
  ingroup_id       VARCHAR(32) NOT NULL,
  skill_key        VARCHAR(32) NOT NULL,
  skill_value      VARCHAR(32) NOT NULL,
  min_proficiency  TINYINT UNSIGNED NOT NULL DEFAULT 1,  -- 1-10
  required         BOOLEAN NOT NULL DEFAULT TRUE,         -- FALSE = scoring-only, not gating
  weight           SMALLINT UNSIGNED NOT NULL DEFAULT 100,
  created_at       DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6),
  updated_at       DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (tenant_id, ingroup_id, skill_key, skill_value),
  INDEX idx_igs_t_skill (tenant_id, skill_key, skill_value),
  CONSTRAINT fk_igs_ingroup FOREIGN KEY (tenant_id, ingroup_id)
    REFERENCES ingroups(tenant_id, id) ON DELETE CASCADE
);
```

### 3.2 New table: `agent_skills`

```sql
CREATE TABLE agent_skills (
  tenant_id      BIGINT NOT NULL DEFAULT 1,
  user_id        BIGINT NOT NULL,
  skill_key      VARCHAR(32) NOT NULL,
  skill_value    VARCHAR(32) NOT NULL,
  proficiency    TINYINT UNSIGNED NOT NULL DEFAULT 1,  -- 1-10
  certified_at   DATE,                                 -- informational only
  expires_at     DATE,                                 -- NULL = never; auto-deactivate after
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6),
  updated_at     DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (tenant_id, user_id, skill_key, skill_value),
  INDEX idx_as_t_skill (tenant_id, skill_key, skill_value, proficiency),
  CONSTRAINT fk_as_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
```

### 3.3 New table: `queue_calls` (partitioned)

```sql
CREATE TABLE queue_calls (
  id               BIGINT PRIMARY KEY AUTO_INCREMENT,
  tenant_id        BIGINT NOT NULL DEFAULT 1,
  call_uuid        VARCHAR(40) NOT NULL,
  ingroup_id       VARCHAR(32) NOT NULL,
  did_e164         VARCHAR(16),
  caller_id_e164   VARCHAR(16),
  lead_id          BIGINT,
  enter_at         DATETIME(6) NOT NULL,
  base_score       BIGINT NOT NULL,               -- enter_ts_ms − priority_boost_ms
  matched_skills   JSON,                           -- snapshot of required skills at entry
  dispatch_at      DATETIME(6),
  dispatch_user_id BIGINT,
  exit_at          DATETIME(6),
  exit_reason      ENUM(
                     'answered','caller_hangup','timeout','overflow',
                     'callback','full_at_entry','agent_no_answer'
                   ),
  position_at_entry INT,
  wait_seconds     INT,
  recording_uuid   VARCHAR(40),
  created_at       DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6),
  INDEX idx_qc_t_ingroup_enter (tenant_id, ingroup_id, enter_at),
  INDEX idx_qc_t_exit          (tenant_id, exit_at, exit_reason),
  INDEX idx_qc_t_lead          (tenant_id, lead_id),
  INDEX idx_qc_t_uuid          (tenant_id, call_uuid)
  -- NOTE: NO FK to call_log; both are partitioned tables. Integrity via app-layer assertion.
) PARTITION BY RANGE (TO_DAYS(enter_at)) (
  PARTITION p_2026_05 VALUES LESS THAN (TO_DAYS('2026-06-01')),
  PARTITION p_2026_06 VALUES LESS THAN (TO_DAYS('2026-07-01')),
  PARTITION p_2026_07 VALUES LESS THAN (TO_DAYS('2026-08-01')),
  PARTITION p_max     VALUES LESS THAN MAXVALUE
  -- O02 retention worker adds/drops partitions monthly.
);
```

### 3.4 New table: `queue_log` (partitioned)

```sql
CREATE TABLE queue_log (
  id             BIGINT PRIMARY KEY AUTO_INCREMENT,
  tenant_id      BIGINT NOT NULL DEFAULT 1,
  queue_call_id  BIGINT NOT NULL,
  event_at       DATETIME(6) NOT NULL,
  event          ENUM(
                   'enter','position_announce','offer_callback','accept_callback',
                   'sticky_attempt','dispatch','agent_no_answer','reroute',
                   'overflow','answer','caller_hangup','timeout','full_block'
                 ) NOT NULL,
  metadata       JSON,   -- algorithm, candidate_agents, picked_score, agent_user_id, position, EWT
  INDEX idx_ql_t_qc    (tenant_id, queue_call_id, event_at),
  INDEX idx_ql_t_event (tenant_id, event, event_at)
) PARTITION BY RANGE (TO_DAYS(event_at)) (
  PARTITION p_2026_05 VALUES LESS THAN (TO_DAYS('2026-06-01')),
  PARTITION p_2026_06 VALUES LESS THAN (TO_DAYS('2026-07-01')),
  PARTITION p_2026_07 VALUES LESS THAN (TO_DAYS('2026-08-01')),
  PARTITION p_max     VALUES LESS THAN MAXVALUE
);
```

### 3.5 Additive ALTER on `did_numbers` (F02 amendment)

```sql
ALTER TABLE did_numbers
  ADD COLUMN priority_boost_seconds   INT NOT NULL DEFAULT 0
    COMMENT 'VIP head-start seconds subtracted from ZSET score; cap 600',
  ADD COLUMN crm_lookup_enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN recording_disclosure_audio VARCHAR(255) DEFAULT NULL
    COMMENT 'WAV path played before queue entry; overrides ingroup fallback',
  ADD COLUMN business_hours_id        BIGINT DEFAULT NULL
    COMMENT 'FK to call_times; NULL = always open';
```

### 3.6 Additive ALTER on `ingroups` (F02 amendment)

```sql
ALTER TABLE ingroups
  ADD COLUMN routing_strategy         ENUM('skill_priority','longest_idle','round_robin','top_down','fewest_calls')
                                      NOT NULL DEFAULT 'skill_priority',
  ADD COLUMN sticky_enabled           BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN sticky_window_hours      SMALLINT NOT NULL DEFAULT 24,
  ADD COLUMN sticky_first_try_seconds SMALLINT NOT NULL DEFAULT 15,
  ADD COLUMN sticky_wait_during_wrapup BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN wrapup_seconds           SMALLINT DEFAULT NULL
    COMMENT 'NULL = inherit from campaign or system default 60s',
  ADD COLUMN recording_mode           ENUM('NEVER','ONDEMAND','ALL','ALLFORCE')
                                      NOT NULL DEFAULT 'ALL',
  ADD COLUMN recording_disclosure_audio VARCHAR(255) DEFAULT NULL
    COMMENT 'Fallback if did_numbers.recording_disclosure_audio is NULL',
  ADD COLUMN moh_stream               VARCHAR(255) NOT NULL DEFAULT 'local_stream://moh',
  ADD COLUMN welcome_audio            VARCHAR(255) DEFAULT NULL,
  ADD COLUMN position_announce_template VARCHAR(255) DEFAULT NULL,
  ADD COLUMN announce_interval_sec    INT NOT NULL DEFAULT 30,
  ADD COLUMN announce_min_wait_sec    INT NOT NULL DEFAULT 60,
  ADD COLUMN entry_full_action        ENUM('hangup','overflow_ingroup','voicemail','callback_offer','external_transfer')
                                      NOT NULL DEFAULT 'hangup',
  ADD COLUMN entry_full_target        VARCHAR(64) DEFAULT NULL,
  ADD COLUMN callback_offer_enabled   BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN callback_offer_after_seconds INT NOT NULL DEFAULT 90,
  ADD COLUMN closed_action            ENUM('voicemail','hangup','overflow_ingroup','callback_offer')
                                      NOT NULL DEFAULT 'voicemail',
  ADD COLUMN closed_target            VARCHAR(64) DEFAULT NULL,
  ADD COLUMN business_hours_id        BIGINT DEFAULT NULL;
```

### 3.7 Redis live state (FROZEN)

```
t:{tid}:ingroup:{igid}:queue                  ZSET   score=base_score (enter_ts_ms − boost_ms); member=call_uuid
t:{tid}:ingroup:{igid}:queue_meta             HASH   {avg_handle_sec, ready_agents, last_dispatch_ts, dispatch_total}
t:{tid}:ingroup:{igid}:ready_agents           ZSET   score=last_ready_change_ts; member=user_id (READY agents matched to this ingroup)
t:{tid}:queue_call:{call_uuid}                HASH   {ingroup_id, lead_id, caller_id, enter_ts, base_score, last_announce_ts, sticky_target_user, overflow_hops}
t:{tid}:queue_dispatch_lock:{igid}            STRING SET NX EX 5  (single active dispatcher per ingroup; pod-id as value)
t:{tid}:sticky:{phone_e164}                   STRING TTL=sticky_window_hours*3600  (last_agent_user_id for sticky routing)
t:{tid}:ingroup:{igid}:ewt_sec_per_pos        STRING TTL 60s  (EWT per position unit; = avg_handle_sec / max(1, ready_agents))
t:{tid}:agent_skills:{user_id}                HASH   {skill_key:skill_value → proficiency}; TTL 300s; invalidated by pubsub
pubsub: agent_skills_changed:{user_id}        (published by M05/admin on skill save; triggers in-process cache bust)
```

---

## 4. Skill model

### 4.1 Design rationale

Vicidial's flat rank (0-9) per in-group requires one queue per skill combination. Modern routing platforms (Genesys Cloud "Best Available Skills", Five9 SBR) use multi-attribute matching with proficiency. Vici2 follows that pattern.

Dimensions a typical deployment uses: language (en/es/fr/...), product line (solar/billing/tech/retention/...), tier (tier1/tier2/tier3), special (VIP/escalation/pci_certified). With 4 languages × 4 products × 3 tiers = 48 Vicidial in-groups; with the key=value model = 1 in-group + 3 skill requirements.

### 4.2 Match formula (FROZEN)

```
function matchAgent(agent, requirements):
  score = 0
  for (k, v, min_prof, required, weight) in requirements:
    agent_prof = agent.proficiency_for(k, v)   -- 0 if not held
    if required AND agent_prof < min_prof:
      return nil                                -- GATING: agent disqualified
    if agent_prof >= min_prof:
      score += (agent_prof - min_prof + 1) * weight
  return score   -- nil = no match; integer ≥ 0 = match (higher is better)
```

**Tie-breaking within same score**: longest-idle (lowest `last_ready_change_ts` in ZSET).

### 4.3 Worked examples (table-driven test fixtures)

| In-group requirements | Agent skills | Expected |
|---|---|---|
| `(language=es, min=5, req=T, w=100)` | `(language=es, prof=8)` | score=400 |
| `(language=es, min=5, req=T, w=100)` + `(product=billing, min=3, req=T, w=80)` | `(lang=es, prof=8)` + `(product=billing, prof=5)` | score=640 |
| Same as above | `(lang=es, prof=9)` + `(product=tech, prof=7)` | nil (billing gated) |
| `(cert=PCI, min=1, req=F, w=20)` only | `(cert=PCI, prof=3)` | score=60 (optional match) |
| `(cert=PCI, min=1, req=F, w=20)` only | (no cert) | score=0, still eligible (no required gates) |
| No requirements | Any agent assigned to in-group | score=0, all eligible |
| `(language=es, min=5, req=T)` | `(language=es, prof=5)` — exactly at minimum | score=(5-5+1)*100=100; passes |
| `(language=es, min=5, req=T)` | `(language=es, prof=4)` — one below | nil (gated) |
| `(lang=es, min=5, req=T, w=100)` + `(lang=fr, min=3, req=F, w=50)` | `(lang=es, prof=7)` + `(lang=fr, prof=4)` | score=300+100=400 |
| Two required skills, agent has only first | First skill prof=8; no second | nil if second is required |

### 4.4 Skill caching

- Cache agent skills in Go dispatcher process memory: `map[userID]*AgentSkillSet`
- TTL: 5 minutes
- Invalidation: pubsub `agent_skills_changed:{user_id}` published by M05 admin on any save
- Read-path cost in steady state: zero MySQL hits

### 4.5 Skill expiry handling

`agent_skills.expires_at` is checked at cache population time. Expired skills (expires_at < today) are excluded from the loaded set. A nightly cron job (O02 worker) sets `active=false` on expired rows for clean audit trail.

---

## 5. Routing algorithms

### 5.1 Phase 3 algorithm set (FROZEN)

Five algorithms supported. One selected per in-group via `ingroups.routing_strategy`.

| Algorithm | Agent selection function | Use case |
|---|---|---|
| `skill_priority` **(default)** | highest `match_score` first; ties broken by lowest `last_ready_change_ts` (longest idle) | General; favors best skill match |
| `longest_idle` | lowest `last_ready_change_ts` in `ready_agents` ZSET among all eligible agents | Equal-skill agents; fair rotation |
| `round_robin` | lowest `last_dispatched_at` among eligible | Even call count regardless of idle time |
| `top_down` | lowest `agent.rank ASC`, then longest idle | Hierarchy; supervisor-first routing |
| `fewest_calls` | lowest `calls_handled_today` among eligible | Long-tail fairness; prevents burnout |

`ring-all`: **deferred to Phase 3+**. Requires parallel `bgapi originate` to all matched agents with `early_media=true` and cancel-others logic. Too complex for Phase 3; document in backlog.

### 5.2 Sticky-agent override (orthogonal to primary algorithm)

Enabled per in-group (`ingroups.sticky_enabled = false` by default; operator opt-in).

```
on dispatch attempt for call C:
  if not ingroup.sticky_enabled: skip sticky
  last_agent_id = redis.GET(t:{tid}:sticky:{caller_e164})
  if not last_agent_id: skip sticky
  agent = lookup(last_agent_id)
  if agent.status == READY AND matches_skills(agent, ingroup): dispatch to agent
  if agent.status == WRAPUP AND ingroup.sticky_wait_during_wrapup:
    wait up to ingroup.wrapup_seconds for READY transition, then fall through
  else: fall through to primary algorithm
```

**Sticky defaults (FROZEN):**
- `sticky_enabled`: `false` (opt-in)
- `sticky_window_hours`: `24`
- `sticky_first_try_seconds`: `15`
- `sticky_wait_during_wrapup`: `true`

Write sticky record: on dispatch confirmed, `SET t:{tid}:sticky:{caller_e164} {user_id} EX {sticky_window_hours*3600}`.

### 5.3 Algorithm implementation in Go

All algorithms operate on the `ready_agents` ZSET filtered by skill eligibility. The dispatcher calls `router.PickAgent(call *QueuedCall, ingroup *InGroup, candidates []*Agent) (*Agent, error)` — a pure function testable without Redis. Candidates are pre-filtered by skill match; the router applies the strategy ordering.

---

## 6. `dispatch_inbound.v1.lua` — atomic dispatch script (FROZEN)

This Lua script runs under `redis.eval` / `redis.evalsha`. It is the atomicity guarantee for the pacing race fix (E02 ↔ I01 boundary). The script is stored in `dialer/internal/queue/scripts/dispatch_inbound.v1.lua` and loaded at dispatcher startup via `SCRIPT LOAD`.

**KEYS:** 6 keys passed positionally.
```
KEYS[1]  t:{tid}:ingroup:{igid}:queue              (ZSET of waiting calls)
KEYS[2]  t:{tid}:ingroup:{igid}:ready_agents        (ZSET of ready agents for this ingroup)
KEYS[3]  t:{tid}:agents:by_status:READY             (global READY ZSET — E02 reads this)
KEYS[4]  t:{tid}:agents:by_status:INCALL            (global INCALL ZSET)
KEYS[5]  t:{tid}:agent:{user_id}                    (agent state HASH)
KEYS[6]  t:{tid}:queue_call:{call_uuid}             (call state HASH)
```

**ARGV:** `ARGV[1]=call_uuid, ARGV[2]=user_id, ARGV[3]=now_ms, ARGV[4]=ingroup_id`

**Script body (pseudo-Lua; exact implementation in IMPLEMENT phase):**
```lua
local call_uuid = ARGV[1]
local user_id   = ARGV[2]
local now_ms    = tonumber(ARGV[3])
local igid      = ARGV[4]

-- Verify call still in queue (guard against race with caller hangup)
local in_queue = redis.call('ZSCORE', KEYS[1], call_uuid)
if not in_queue then return {err='CALL_NOT_IN_QUEUE'} end

-- Verify agent still READY in global pool
local in_ready = redis.call('ZSCORE', KEYS[3], user_id)
if not in_ready then return {err='AGENT_NOT_READY'} end

-- Atomic state transition
redis.call('ZREM',  KEYS[1], call_uuid)             -- remove call from ingroup queue
redis.call('ZREM',  KEYS[2], user_id)               -- remove agent from ingroup ready pool
redis.call('ZREM',  KEYS[3], user_id)               -- remove agent from global READY (E02 boundary)
redis.call('ZADD',  KEYS[4], now_ms, user_id)       -- add agent to global INCALL
redis.call('HSET',  KEYS[5],
  'status', 'INCALL',
  'call_uuid', call_uuid,
  'ingroup_id', igid,
  'incall_since', now_ms)
redis.call('HSET',  KEYS[6],
  'dispatch_at', now_ms,
  'dispatch_user_id', user_id)

return {ok='OK'}
```

The script returns `{ok='OK'}` or `{err='...'}`. The dispatcher treats any error as "dispatch aborted — re-run picker" (next tick or re-trigger). This prevents double-dispatch.

---

## 7. Hold music and announcements

### 7.1 Per-in-group audio configuration

| Column | Default | Semantics |
|---|---|---|
| `moh_stream` | `local_stream://moh` | Continuous looped music; FreeSWITCH native stream |
| `welcome_audio` | NULL | One-shot playback at queue entry (before park) |
| `position_announce_template` | NULL | Path prefix for pre-recorded WAV segments; NULL = use mod_say only |
| `announce_interval_sec` | 30 | Seconds between position announcements; 0 = disabled |
| `announce_min_wait_sec` | 60 | Do not announce if EWT < this value |

### 7.2 Dialplan flow (static XML template, rendered per in-group)

```xml
<extension name="ingroup_${id}">
  <condition field="destination_number" expression="^ingroup_${id}$">
    <action application="set"      data="vici2_role=customer_leg"/>
    <action application="set"      data="vici2_ingroup_id=${id}"/>
    <action application="set"      data="vici2_tenant_id=${tid}"/>
    <action application="set"      data="hangup_after_bridge=false"/>
    <action application="set"      data="continue_on_fail=true"/>
    <action application="answer"/>
    <!-- Welcome audio (one-shot; skip if NULL) -->
    <action application="playback" data="${ingroup_welcome_audio_${id}}"/>
    <!-- Set MOH for park -->
    <action application="set"      data="hold_music=${ingroup_moh_${id}}"/>
    <!-- Enroll in Redis queue via API -->
    <action application="curl"
            data="${api_url}/internal/queue/enroll?call_uuid=${uuid}&amp;ingroup=${id}&amp;tenant=${tid} post"/>
    <!-- Park: dispatcher will uuid_transfer to agent conf when ready -->
    <action application="park"/>
    <!-- Reached only on park failure / dispatcher timeout -->
    <action application="curl"
            data="${api_url}/internal/queue/timeout?call_uuid=${uuid} post"/>
    <action application="hangup"   data="NORMAL_CLEARING"/>
  </condition>
</extension>
```

### 7.3 Position announcement delivery

The dispatcher loop wakes every `announce_interval_sec` per in-group and, for each waiting call where `EWT ≥ announce_min_wait_sec`, issues:

```
T01.ESLCommand("bgapi uuid_broadcast <call_uuid> playback::<audio_sequence> both")
```

Audio sequence (concatenated via FreeSWITCH inline playlist):
```
sounds/you_are_caller_number.wav
say:en:NUMBER:pronounced:<position>
sounds/estimated_wait.wav
say:en:TIME_MEASURE:pronounced:<ewt_rounded_seconds>
sounds/please_hold.wav
```

`mod_say_en` handles the numeric synthesis; prefix/suffix WAVs ship in the I01 media bundle at `freeswitch/sounds/i01/`. No external TTS provider.

### 7.4 Custom MOH files

Per-in-group custom MOH files: `freeswitch/sounds/moh/{tenant_id}/{ingroup_id}.wav`. Uploaded via admin UI (new `POST /api/admin/ingroups/{id}/moh` endpoint). Stored on the `freeswitch_recordings` volume. The rendered XML references the absolute path at render time.

---

## 8. Estimated wait time

### 8.1 Formula (FROZEN)

```
EWT_seconds = ceil_to_interval(
  (queue_position × avg_handle_time_seconds) / max(1, ready_agents_count)
)
```

- `queue_position`: 1-indexed ZRANK + 1 in `t:{tid}:ingroup:{igid}:queue`
- `avg_handle_time_seconds`: EWMA of `call_log.talk_seconds` for handled inbound calls in this in-group (alpha = 0.1); seeded from last 100 records on startup; default fallback = 180 s
- `ready_agents_count`: `ZCARD t:{tid}:ingroup:{igid}:ready_agents`

**Rounding (FROZEN):**
- EWT < 60 s: no announcement (silence is better than "less than a minute")
- 60 s ≤ EWT < 120 s: round up to nearest 30 s
- EWT ≥ 120 s: round up to nearest 60 s

### 8.2 AHT EWMA update

```
on call_log write for inbound call (exit):
  current_aht = redis.HGET(t:{tid}:ingroup:{igid}:queue_meta, "avg_handle_sec") OR 180
  new_aht = 0.9 * current_aht + 0.1 * new_talk_seconds
  redis.HSET(t:{tid}:ingroup:{igid}:queue_meta, "avg_handle_sec", new_aht)
```

EWMA alpha = 0.1 (smooth over ~10 calls). This is FROZEN per RESEARCH §7.4.

### 8.3 EWT computation cadence

Dispatcher loop stores `ewt_sec_per_pos = avg_handle_sec / max(1, ready_agents)` in `t:{tid}:ingroup:{igid}:ewt_sec_per_pos` (TTL 60 s) every 30 s. Announcement scheduler reads `ewt_sec_per_pos × position` per call. Redis key TTL 60 s ensures stale values don't survive a dispatcher crash.

### 8.4 No Erlang-C (Phase 3)

Erlang-C gives better accuracy for large, high-traffic queues. For ≤50-agent in-groups the improvement is < 10 s and not user-visible. Erlang-C is Phase 4 backlog.

---

## 9. Overflow and fallback chain

### 9.1 Entry-time decision tree

```
on call arriving at ingroup_${id}:
  if ingroup.business_hours_id AND NOT within_business_hours(ingroup.business_hours_id):
    → fire ingroup.closed_action with ingroup.closed_target
    → done
  if ZCARD(queue) >= ingroup.max_queue:
    → write queue_log.event=full_block
    → fire ingroup.entry_full_action with ingroup.entry_full_target
    → done
  → enqueue (ZADD + INSERT queue_calls)
```

### 9.2 Wait-time overflow

```
dispatcher loop every 1 s per ingroup:
  for each call in queue where (now - enter_at) > ingroup.max_wait_sec:
    → fire ingroup.no_agent_action with ingroup.no_agent_target
    → write queue_log.event=timeout
    → ZREM from queue
    → UPDATE queue_calls.exit_reason=timeout
```

### 9.3 Overflow action implementations

| Action | Implementation |
|---|---|
| `hangup` | `T01.UUIDKill(call_uuid)` after playing apology TTS |
| `overflow_ingroup` | Check `overflow_hops ≤ 2`; HINCR `t:{tid}:queue_call:{uuid}.overflow_hops`; re-enroll in target in-group |
| `voicemail` | `T01.UUIDTransfer(call_uuid, "voicemail_${igid} XML default")` — I05 receives |
| `callback_offer` | Play callback offer prompt; if caller presses 1 → accept; else → fall through to `hangup` |
| `external_transfer` | `T01.UUIDTransfer(call_uuid, "sofia/external/${number}@${carrier_gateway}")` — loses recording/analytics; warn in docs |

### 9.4 Loop protection

`overflow_hops` counter in `t:{tid}:queue_call:{uuid}` HASH (`HINCR` on each overflow_ingroup hop). If counter reaches 3: force `hangup`. Emit metric `vici2_ingroup_overflow_loop_total{igid}`.

---

## 10. Priority queues

### 10.1 Three priority sources

| Source | Storage | Boost formula | Cap |
|---|---|---|---|
| DID-based | `did_numbers.priority_boost_seconds` | direct value | 600 s |
| CRM-rank-based | `leads.rank` × 30 s | `min(300, rank * 30)` | 300 s |
| Total cap | — | `min(900, did_boost + crm_boost)` | 900 s |

### 10.2 Score computation at entry (FROZEN)

```
boost_sec = 0
if did.priority_boost_seconds > 0:
  boost_sec += min(600, did.priority_boost_seconds)
if did.crm_lookup_enabled AND lead found AND lead.rank > 0:
  boost_sec += min(300, lead.rank * 30)
boost_sec = min(900, boost_sec)
base_score = enter_ts_ms - (boost_sec * 1000)
```

Lower `base_score` = dispatched first. A VIP with 900 s boost appears to have entered 15 minutes earlier than they did.

### 10.3 Anti-starvation

900 s total cap means a regular caller waiting 901 s (15 min 1 s) will sort ahead of a max-VIP entering at the same moment. Prevents VIP queue from starving all regular callers.

### 10.4 CRM lookup

Called at queue-enroll time: `D01.lookupLeadByPhone(phone_e164)`. Deadline: 200 ms. On timeout or not-found: `lead_id=NULL`, no boost. Does not block queue enrollment.

---

## 11. Callback offer

### 11.1 Configuration

Disabled by default per in-group (`ingroups.callback_offer_enabled = false`). Operator opt-in via admin UI.

### 11.2 Offer trigger

When `(now - queue_call.enter_at) ≥ ingroup.callback_offer_after_seconds` (default 90 s) AND the call has not previously received a callback offer, the dispatcher issues:

```
T01.ESLCommand("bgapi uuid_broadcast <call_uuid> execute::play_and_get_digits '1 1 1 5000 # sounds/i01/callback_offer.wav sounds/i01/invalid.wav VICI2_CB_DIGIT \\d 1000 ^1$'")
```

If `VICI2_CB_DIGIT = 1` (captured via DTMF, ESL DTMF event): fire callback accepted flow. Write `queue_log.event=offer_callback`.

### 11.3 Callback accepted flow

```
1. Read callback number: caller_id_e164 (default) OR DTMF-entered via play_and_get_digits
2. POST /internal/queue/exit_callback?call_uuid=...&number=...
   API transaction:
     a. INSERT callbacks (lead_id, ingroup_id, callback_number, status=PENDING,
                          queue_position_at_offer=<position>, expires_at=NOW()+96h)
     b. ZREM from ingroup queue
     c. UPDATE queue_calls SET exit_reason=callback, exit_at=NOW()
     d. Write queue_log.event=accept_callback
3. T01.ESLCommand: play confirmation TTS ("We'll call you back at <number>. Goodbye.")
4. T01.UUIDKill(call_uuid) with NORMAL_CLEARING
```

### 11.4 Preserve-position semantics

`callbacks.queue_position_at_offer` is an integer stamped at offer time. D06 callback scheduler sorts by this column ascending when batching priority callbacks. A caller who was position 2 when they accepted will be dialed before a caller who was position 5.

### 11.5 Callback expiry

96 hours (Vicidial INBOUND_CALLBACK_QUEUE default). O02 nightly cron marks `status=EXPIRED` on unfulfilled callbacks past `expires_at`.

### 11.6 Closed-time callback offer

When `ingroup.closed_action = callback_offer`, caller arriving outside business hours hears: "We're closed. Press 1 for a callback when we open." `callback_at = next_open_time(ingroup.business_hours_id)`.

---

## 12. Agent UX — inbound preview

### 12.1 WS event: `inbound_call_offer` (FROZEN for A05)

Published to `t:{tid}:broadcast:agent:{user_id}` pub/sub channel immediately before `TransferCustomer` is called:

```json
{
  "type": "inbound_call_offer",
  "call_uuid": "<uuid>",
  "ingroup_id": "SUPPORT",
  "ingroup_name": "Customer Support",
  "caller_id_e164": "+12125551234",
  "did_e164": "+18005550100",
  "wait_seconds": 47,
  "direction": "in",
  "preview_timeout_ms": 3000,
  "lead": {
    "id": 12345,
    "first_name": "Jane",
    "last_name": "Doe",
    "city": "NYC",
    "status": "CALLBK",
    "rank": 2
  }
}
```

`lead` field is null if `D01.lookupLeadByPhone` returned no match.

### 12.2 Preview window duration

**Default: 3 seconds** (configurable per-user: `users.inbound_preview_ms`, range 0–10000 ms; 0 = auto-accept with no preview UI). This is a PLAN-phase override of RESEARCH §12.1 (which suggested 5 s); 3 s is more aligned with live-agent call centers and reduces queue hold time.

### 12.3 Auto-answer behavior

`users.auto_answer_inbound BOOLEAN DEFAULT TRUE`. The SIP.js phone auto-answers the INVITE (DESIGN.md §7.2). The "preview" is purely informational UI — the call is already being bridged while the agent sees the caller info. If auto-answer is OFF, the agent's SIP.js must manually accept the INVITE; the bridge waits.

### 12.4 Reject behavior

Agent presses "Reject" within preview window:
1. API: mark `queue_log.event=agent_no_answer`
2. `T01.UUIDTransfer` is NOT called (call stays parked)
3. Dispatcher re-runs picker on next tick (picks next eligible agent)
4. Agent status remains READY (no penalty for first rejection)
5. Reject counter tracked in Redis: `t:{tid}:agent:{uid}:reject_count_hourly` (INCR, TTL 3600 s)
6. If count ≥ 3: API sets agent status = PAUSED with code `REJECT_LIMIT`; emit metric `vici2_agent_auto_pause_total{reason="REJECT_LIMIT"}`

### 12.5 Direction indicator in UI

A05 receives `call_started` event with `direction='in'`. UI shows green header for inbound vs blue for outbound. In-group badge displayed in top bar. Same disposition flow (D04), same A07 transfer options, same A08 callback flow, same hangup flow.

### 12.6 Inbound has no "next lead" button

Outbound path has A04 "dial next". Inbound is push-driven. UI shows "Waiting for inbound call" placeholder in idle state.

---

## 13. Recording

### 13.1 No new recording infrastructure

R01/R02 handle recording via `record_session` on the customer leg (`recording_follow_transfer=true`). Inbound calls follow the same path: customer leg is `uuid_transfer`'d into agent's existing conference; recording continues across the transfer. No new code in R01/R02.

### 13.2 Per-in-group recording mode

`ingroups.recording_mode` ENUM `(NEVER, ONDEMAND, ALL, ALLFORCE)`. Default `ALL`. Parity with `campaigns.recording_mode`. Logic identical to outbound path; I01 sets the channel var `vici2_recording_mode` before park; T03/R01 read it on conference join.

### 13.3 Recording disclosure

Disclosure audio (`did_numbers.recording_disclosure_audio` or fallback `ingroups.recording_disclosure_audio`) is played by the I02 public-context dialplan BEFORE transferring to `ingroup_{id}` extension. I01's dialplan extension does NOT play disclosure — I02 owns it per DID. This ensures the caller hears disclosure regardless of which in-group they route to.

Priority: `did_numbers.recording_disclosure_audio` → `ingroups.recording_disclosure_audio` → no disclosure (implied-consent states).

### 13.4 TCPA / DNC applicability

| Rule | Applies to inbound? | Reason |
|---|---|---|
| TCPA 47 CFR §64.1200 | NO | Caller initiated; TCPA regulates outbound predictive dialing |
| 8am-9pm time-of-day | NO | Applies to outbound only |
| 3% abandonment rate | NO | FCC abandonment rule targets predictive dialer dropouts |
| DNC (National + internal) | NO | Consumer called us; they opted in by calling |
| State recording-consent laws | YES | Must disclose in 2-party-consent states (CA, FL, IL, MD, MA, MT, NV, NH, PA, VT, WA) |
| TCPA "do not call me" spoken request | MANUAL | Agent's D04 disposition can include DNC status; no auto-DNC on inbound |

### 13.5 Drop-rate metric

Separate from TCPA-relevant outbound drop. `vici2_ingroup_abandon_pct{ingroup}` = caller_hangups_while_waiting / total_queue_entries. Industry target < 5%; no legal requirement.

---

## 14. Pacing race fix (E02 ↔ I01)

### 14.1 The invariant

E02 PLAN §0 bullet 7 reads `ZCARD t:{tid}:agents:by_status:READY` (3 ZCARD pipeline) on every 1 Hz tick. If an inbound dispatch removes an agent from READY non-atomically, E02 may over-originate one outbound call in that window.

### 14.2 The fix

`dispatch_inbound.v1.lua` (§6) atomically executes the `ZREM` from `t:{tid}:agents:by_status:READY` in the same Lua eval as all other state transitions. E02's pipelined ZCARD either sees the agent IN or OUT — no partial state. This is the same atomicity guarantee T03 uses for outbound dispatch.

### 14.3 Non-blended workflow (Phase 3)

In Phase 3, agents serve outbound XOR inbound. An agent assigned to an in-group is NOT simultaneously in an outbound campaign's picker. I01 dispatcher excludes agents with `status=INCALL` from pick; E04 outbound picker excludes agents with `ingroup_id` set in their state HASH.

### 14.4 Wrapup after inbound call

On `CHANNEL_HANGUP` for customer leg:
1. Agent → WRAPUP status for `min(ingroup.wrapup_seconds OR campaign.wrapup_seconds OR 60, 300)` seconds
2. A06 dispo UI shows disposition picker (D04 inbound dispositions)
3. After WRAPUP timer or dispo submission: agent → READY; ZADD back to `t:{tid}:agents:by_status:READY` and `t:{tid}:ingroup:{igid}:ready_agents`
4. AHT EWMA updated with call's `talk_seconds`

---

## 15. Dialplan integration

### 15.1 Extension naming convention (FROZEN for I02/I03)

```
Default context extension name:  ingroup_{ingroup_id}
File:                            freeswitch/conf/dialplan/default/60_ingroup_{ingroup_id}.xml
```

Examples:
- `ingroup_SUPPORT` in `60_ingroup_SUPPORT.xml`
- `ingroup_SPANISH_BILLING` in `60_ingroup_SPANISH_BILLING.xml`

I02's public dialplan (file range `10_*.xml` through `89_*.xml` per F03 PLAN §4.5) issues:
```xml
<action application="transfer" data="ingroup_${ingroup_id} XML default"/>
```

I03 (IVR) issues the same `transfer` when a menu option resolves to an in-group.

### 15.2 Render trigger

Admin saves/creates an in-group → API service `IngroupRenderer.Render(ingroupID)`:
1. Template `60_ingroup_${id}.xml` from Go `text/template`
2. Write to `freeswitch/conf/dialplan/default/60_ingroup_${id}.xml` (bind-mounted)
3. `T01.ESLCommand("bgapi reloadxml")` — idempotent, zero downtime
4. On in-group delete: remove the XML file + reloadxml

### 15.3 Static templating vs mod_xml_curl

**Phase 3: static templating.** In-groups change rarely (training events, not per-call). Static XML + reloadxml adds ~50 ms admin-save latency, zero call-setup latency. `mod_xml_curl` alternative (F03 PLAN §7) would add 100 ms per call-setup (latency to API + parse). Revisit if dynamic per-call routing logic is needed in Phase 4.

### 15.4 Public extension slot

I01 does NOT use the `public` context (10–89 range). All inbound routing from the public context lands on the DID extension (I02's job), which then transfers to the `default` context `ingroup_*` extension. I01 owns only the `default` context `60_*.xml` files.

---

## 16. Supervisor monitoring

### 16.1 S01 wallboard integration

I01 publishes the following events to Valkey Streams (key `events:vici2.ingroup.*`):

| Event | Payload |
|---|---|
| `vici2.ingroup.call_entered` | `{ingroup_id, call_uuid, position, ewt_seconds, caller_id_e164}` |
| `vici2.ingroup.call_dispatched` | `{ingroup_id, call_uuid, agent_user_id, wait_seconds, skill_score}` |
| `vici2.ingroup.call_exited` | `{ingroup_id, call_uuid, exit_reason, wait_seconds}` |
| `vici2.ingroup.agent_ready` | `{ingroup_id, user_id}` |
| `vici2.ingroup.agent_unavailable` | `{ingroup_id, user_id, reason}` |

S01 reads live state from:
- `ZCARD t:{tid}:ingroup:{igid}:queue` → current depth
- `HGETALL t:{tid}:ingroup:{igid}:queue_meta` → avg_handle_sec, ready_agents, last_dispatch_ts
- Stream subscription for live updates

### 16.2 S02 eavesdrop limitation

Eavesdrop (`eavesdrop:<uuid>`) on a parked / MOH-playing channel yields only hold music — not useful. **I01 limitation: eavesdrop is only available on calls post-dispatch** (when the customer leg is inside the agent's conference). Pre-dispatch queued calls are not eavesdroppable. Documented in HANDOFF.md.

### 16.3 Supervisor force-dispatch endpoint

```
POST /api/sup/ingroups/{igid}/queue/{call_uuid}/dispatch
Body: {"agent_user_id": 42}
Auth: requireSupervisor
```

Atomically removes from queue + runs `dispatch_inbound.v1.lua` for the specified agent (overrides algorithm). Writes `queue_log.event=dispatch` with `metadata.forced_by_supervisor=<supervisor_user_id>`.

### 16.4 Supervisor kick-from-queue endpoint

```
POST /api/sup/ingroups/{igid}/queue/{call_uuid}/kick
Body: {"reason": "abusive_caller"}
Auth: requireSupervisor
```

Sends caller to in-group's `no_agent_action` (default voicemail). Writes audit `queue_log.event=overflow` with `metadata.kicked_by=<supervisor_user_id>`.

---

## 17. API endpoints

### 17.1 Admin endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/admin/ingroups` | List all in-groups (paginated) |
| `POST` | `/api/admin/ingroups` | Create in-group + render XML |
| `GET` | `/api/admin/ingroups/:id` | Get in-group detail |
| `PATCH` | `/api/admin/ingroups/:id` | Update in-group + re-render XML |
| `DELETE` | `/api/admin/ingroups/:id` | Soft-delete + remove XML |
| `GET` | `/api/admin/ingroups/:id/skills` | List required skills |
| `POST` | `/api/admin/ingroups/:id/skills` | Add required skill |
| `DELETE` | `/api/admin/ingroups/:id/skills/:skill_key/:skill_value` | Remove required skill |
| `GET` | `/api/admin/users/:uid/skills` | List agent skills |
| `POST` | `/api/admin/users/:uid/skills` | Add agent skill |
| `PATCH` | `/api/admin/users/:uid/skills/:key/:value` | Update proficiency |
| `DELETE` | `/api/admin/users/:uid/skills/:key/:value` | Remove agent skill |
| `POST` | `/api/admin/ingroups/:id/moh` | Upload custom MOH WAV |
| `GET` | `/api/admin/ingroups/:id/queue` | Live queue snapshot (depth, calls, EWT) |

### 17.2 Internal endpoints (called by dialplan/Go dispatcher)

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/internal/queue/enroll` | `X-Internal-Secret` | Enroll call in queue; performs CRM lookup + priority compute |
| `POST` | `/internal/queue/timeout` | `X-Internal-Secret` | Called by dialplan on park failure |
| `POST` | `/internal/queue/exit_callback` | `X-Internal-Secret` | Callback offer accepted; schedule D06 callback |
| `POST` | `/internal/queue/hangup` | ESL event → T01 → internal | Caller hung up mid-queue; cleanup |

### 17.3 Supervisor endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/sup/ingroups/:id/queue` | Live queue with per-call detail |
| `POST` | `/api/sup/ingroups/:id/queue/:uuid/dispatch` | Force-dispatch to agent |
| `POST` | `/api/sup/ingroups/:id/queue/:uuid/kick` | Kick caller to overflow |

### 17.4 Dispatcher ↔ API event contract

The Go dispatcher consumes queue-enroll events via Valkey Stream `events:vici2.ingroup.enrollment` (published by `POST /internal/queue/enroll`). This decouples the dialplan HTTP call from the dispatcher goroutine — the API adds to Redis + publishes; the dispatcher wakes on stream event.

Stream entry format:
```json
{
  "call_uuid": "...",
  "ingroup_id": "SUPPORT",
  "tenant_id": 1,
  "caller_id_e164": "+12125551234",
  "did_e164": "+18005550100",
  "base_score": 1747123456789,
  "lead_id": 12345,
  "matched_skills_json": "[...]"
}
```

---

## 18. Go dispatcher process

### 18.1 Binary location

`dialer/cmd/queuerd/` — a new Go binary (`queuerd` = queue daemon). Imports `dialer/internal/queue/`, `dialer/internal/esl/` (T01), `dialer/internal/conference/` (T03).

### 18.2 Goroutine structure

```
main()
  └── QueueSupervisor.Run()
       ├── for each active ingroup:
       │     DispatcherLoop(igid) -- goroutine
       │       on new enrollment event (stream): wake dispatch cycle
       │       on agent_state_change event (pub/sub): wake dispatch cycle
       │       1 Hz ticker: EWT recompute, announcement schedule, overflow check
       │
       ├── AnnouncementScheduler -- goroutine
       │     reads t:{tid}:ingroup:{igid}:queue every 30s per ingroup
       │     issues uuid_broadcast for due announcements
       │
       ├── AHTUpdater -- goroutine
       │     subscribes to events:vici2.call.ended (inbound only)
       │     updates EWMA per ingroup
       │
       └── Janitor -- goroutine (runs on startup + every 5 min)
             reconciles Redis ZSET from MySQL queue_calls (for crash recovery)
```

### 18.3 Multi-pod safety

Each `DispatcherLoop(igid)` acquires `SET t:{tid}:queue_dispatch_lock:{igid} <pod_id> NX EX 5` before running the dispatch cycle. If the lock exists (held by another pod): skip this tick. Lock TTL 5 s; dispatcher renews every 2 s while holding. On pod death, lock expires in ≤5 s; a sibling pod wins on next attempt.

### 18.4 Startup reconciliation

On binary start:
```sql
SELECT id, call_uuid, ingroup_id, base_score FROM queue_calls
WHERE tenant_id = $tid AND exit_at IS NULL AND enter_at > NOW() - INTERVAL 2 HOUR
```
For each row: `ZADD t:{tid}:ingroup:{igid}:queue NX <base_score> <call_uuid>`. This restores Redis state after a Redis flush or dispatcher restart without duplicate entries (`NX` = only add if not present).

---

## 19. Files to create

### 19.1 Go (dialer)

| File | Contents |
|---|---|
| `dialer/cmd/queuerd/main.go` | Binary entrypoint; reads env; starts QueueSupervisor |
| `dialer/internal/queue/supervisor.go` | QueueSupervisor: ingroup discovery, goroutine lifecycle |
| `dialer/internal/queue/dispatcher.go` | DispatcherLoop per in-group; dispatch cycle; overflow check |
| `dialer/internal/queue/router.go` | Pure `PickAgent` function; all 5 algorithms + sticky-agent |
| `dialer/internal/queue/announce.go` | AnnouncementScheduler; EWT compute; uuid_broadcast |
| `dialer/internal/queue/aht.go` | AHTUpdater; EWMA; seed-from-DB on startup |
| `dialer/internal/queue/janitor.go` | Startup reconciler; periodic consistency check |
| `dialer/internal/queue/lua.go` | Loads `dispatch_inbound.v1.lua` via SCRIPT LOAD on startup |
| `dialer/internal/queue/overflow.go` | Overflow chain executor (all 5 action types) |
| `dialer/internal/queue/skills.go` | Agent skill cache; match formula; pub/sub invalidation |
| `dialer/internal/queue/scripts/dispatch_inbound.v1.lua` | Atomic dispatch Lua script (FROZEN §6) |
| `dialer/internal/queue/scripts/dispatch_inbound.v1.sha` | SHA1 of the Lua script (generated at build; checked at startup) |
| `dialer/internal/queue/renderer.go` | IngroupRenderer: XML templating + reloadxml |
| `dialer/internal/queue/templates/ingroup.xml.tmpl` | Go text/template for dialplan extension |
| `dialer/internal/queue/dispatcher_test.go` | Dispatch cycle unit tests (15 failure modes × 3 scenarios) |
| `dialer/internal/queue/router_test.go` | Algorithm unit tests (5 algos × 5 fixtures + sticky × 3 + skill × 10) |
| `dialer/internal/queue/overflow_test.go` | Overflow chain tests (5 action types + loop detector) |

### 19.2 API (Node/TypeScript)

| File | Contents |
|---|---|
| `api/src/routes/internal/queue.ts` | `POST /internal/queue/enroll`, `exit_callback`, `timeout`, `hangup` |
| `api/src/routes/admin/ingroups.ts` | Admin CRUD for in-groups, skills, MOH upload |
| `api/src/routes/sup/ingroups.ts` | Supervisor queue view, force-dispatch, kick |
| `api/src/services/QueueService.ts` | Enroll logic: CRM lookup, priority compute, Redis ZADD, stream publish |
| `api/src/services/IngroupSkillService.ts` | CRUD for `ingroup_skills` + pubsub invalidation |
| `api/src/services/AgentSkillService.ts` | CRUD for `agent_skills` + pubsub invalidation |
| `api/src/services/CallbackOfferService.ts` | Accept callback: D06 call + queue_calls update |
| `api/src/lib/validators/ingroup.ts` | Zod schemas for all ingroup API bodies |

### 19.3 Schema

| File | Contents |
|---|---|
| `api/prisma/migrations/<ts>_i01_ingroups/migration.sql` | All DDL from §3: 4 new tables + 2 ALTERs |
| `api/prisma/migrations/<ts>_i01_ingroups/down.sql` | Reverse DDL (dev/test use only) |

### 19.4 FreeSWITCH / media

| Path | Contents |
|---|---|
| `freeswitch/sounds/i01/you_are_caller_number.wav` | Pre-recorded announcement segment |
| `freeswitch/sounds/i01/estimated_wait.wav` | Pre-recorded announcement segment |
| `freeswitch/sounds/i01/please_hold.wav` | Pre-recorded announcement segment |
| `freeswitch/sounds/i01/callback_offer.wav` | "Press 1 for a callback" prompt |
| `freeswitch/sounds/i01/invalid.wav` | "Invalid input" for callback DTMF |
| `freeswitch/sounds/i01/callback_confirmed.wav` | "We'll call you back" confirmation |
| `freeswitch/sounds/i01/apology_hangup.wav` | "No agents available" hang-up apology |
| `freeswitch/conf/dialplan/default/60_ingroup_DEFAULT.xml` | Seed/example for the `DEFAULT` in-group |

---

## 20. Test plan

### 20.1 Unit tests — skill match formula (10 table-driven fixtures)

See §4.3 worked examples. Implemented in `router_test.go` as table-driven tests. All 10 fixtures must pass; any change to the match formula requires updating all 10.

### 20.2 Unit tests — routing algorithms (5 × 5 = 25 fixtures)

For each of the 5 algorithms, 5 fixtures covering: single-agent pool, multi-agent tie, no-eligible-agent (empty), sticky-agent present, sticky-agent wrapup wait.

### 20.3 Unit tests — priority score computation (5 fixtures)

DID-only boost, CRM-only boost, combined boost, cap enforcement (boost > 900 s), no boost.

### 20.4 Unit tests — overflow chain (per action type)

`hangup` → verify UUIDKill called. `overflow_ingroup` → verify re-enroll with hop increment. `voicemail` → verify transfer to I05. `callback_offer` → verify D06 call. `external_transfer` → verify sofia/external transfer. Loop detector: 3rd hop → force hangup.

### 20.5 Integration tests — dispatcher lifecycle (15 failure modes)

Each failure mode from RESEARCH §16 implemented as a test:

| # | Test | Assertion |
|---|---|---|
| FM-1 | Dispatcher pod dies mid-dispatch | Sibling pod wins lock on next tick; call dispatched within 6 s |
| FM-2 | All agents PAUSE simultaneously | Queue depth grows; no dispatch; announce continues; max_wait → overflow |
| FM-3 | Caller hangs up mid-queue | ZREM executed; queue_log=caller_hangup; no dispatch attempt |
| FM-4 | Queue depth > max_queue | New caller hits entry_full_action; existing queue unaffected |
| FM-5 | Skill admin removes required skill from agent | Next dispatch re-evaluates; agent may be excluded |
| FM-6 | Agent browser crash mid-inbound call | ESL conf DEL_MEMBER → customer leg parked; max_transfer_wait → apology hangup |
| FM-7 | Carrier sends INVITE for unknown DID | I02 routes to drop extension; DID-not-found 404 logged |
| FM-8 | `curl` to /internal/queue/enroll times out (FS side) | Dialplan timeout extension fires; call exits cleanly |
| FM-9 | Redis down | Dispatcher health probe fails; new inbound DIDs get apology TTS; existing parked calls timeout |
| FM-10 | Agent rejects 3 times in 1 hour | Auto-PAUSE with REJECT_LIMIT; metric emitted |
| FM-11 | Sticky agent in WRAPUP when sticky call arrives | Wait up to wrapup_seconds; on transition to READY, dispatch |
| FM-12 | Overflow loop A→B→A | 3rd hop forced to hangup; vici2_ingroup_overflow_loop_total incremented |
| FM-13 | Callback lookup times out (> 200 ms) | Callback scheduled without lead_id; call exits queue cleanly |
| FM-14 | Dispatch cycle > 200 ms wall time | Logged + metric vici2_ingroup_dispatch_slow_total; no functional impact |
| FM-15 | Stale READY agent (no heartbeat > 60 s) | T01 janitor flips to OFFLINE; dispatcher re-picks |

### 20.6 Integration test — multi-pod failover

1. Start two `queuerd` pods targeting same Redis.
2. Verify only one pod holds the dispatch lock per in-group at any time.
3. Kill the lock-holding pod.
4. Verify the second pod acquires lock within 6 s (5 s TTL + 1 s slack).
5. Verify the call in-queue is dispatched by the new pod.

### 20.7 Acceptance criteria (minimum to ship Phase 3)

| ID | Criterion |
|---|---|
| AC-1 | A DID inbound call arrives, enrolls in the correct in-group queue, and is dispatched to a skill-matched READY agent within 2 s of the agent becoming available |
| AC-2 | The dispatched agent's status transitions from READY to INCALL atomically; E02 sees zero stale READY count |
| AC-3 | The customer leg enters the agent's existing `agent_t1_u{uid}@default` conference (T03 sacred invariant preserved) |
| AC-4 | Queue-position announcement plays every 30 s while caller waits |
| AC-5 | Caller hanging up mid-queue removes from Redis ZSET within 500 ms of ESL CHANNEL_HANGUP |
| AC-6 | All 10 skill-match unit test fixtures pass |
| AC-7 | All 5 routing-algorithm fixtures pass |
| AC-8 | Overflow chain fires correctly for each of the 5 action types |
| AC-9 | Agent preview WS event arrives at agent UI before `uuid_transfer` is called |
| AC-10 | Three rejects within 1 hour auto-PAUSES the agent |
| AC-11 | Callback accepted: D06 `schedulePriorityCallback` called; queue_calls.exit_reason=callback |
| AC-12 | Recording starts on inbound call per `ingroups.recording_mode` |
| AC-13 | Multi-pod failover: lock transfer within 6 s; no call lost |
| AC-14 | `queue_log` row written for every state transition (enter, dispatch, answer, exit) |
| AC-15 | Supervisor force-dispatch moves call to specified agent; audit row written |

---

## 21. Metrics

All metrics labeled `{tenant_id, ingroup_id}` where applicable.

| Metric | Type | Description |
|---|---|---|
| `vici2_ingroup_queue_depth{igid}` | Gauge | Current ZCARD of queue ZSET |
| `vici2_ingroup_ready_agents{igid}` | Gauge | Current ZCARD of ready_agents ZSET |
| `vici2_ingroup_ewt_seconds{igid}` | Gauge | Current EWT for position 1 |
| `vici2_ingroup_calls_entered_total{igid}` | Counter | Total calls enrolled |
| `vici2_ingroup_calls_dispatched_total{igid}` | Counter | Total calls dispatched to agents |
| `vici2_ingroup_calls_abandoned_total{igid}` | Counter | Caller hung up while waiting |
| `vici2_ingroup_calls_overflow_total{igid,action}` | Counter | Calls exited via overflow action |
| `vici2_ingroup_calls_callback_total{igid}` | Counter | Callback offers accepted |
| `vici2_ingroup_wait_seconds{igid}` | Histogram | Wait time from enter to dispatch |
| `vici2_ingroup_dispatch_slow_total{igid}` | Counter | Dispatch cycles > 200 ms |
| `vici2_ingroup_dispatcher_recovered_total{igid}` | Counter | Times dispatcher picked up from dead pod |
| `vici2_ingroup_overflow_loop_total{igid}` | Counter | Overflow loop hard-stops |
| `vici2_ingroup_no_agents_seconds{igid}` | Counter | Seconds with zero ready agents |
| `vici2_ingroup_full_block_total{igid}` | Counter | Calls blocked at entry (queue full) |
| `vici2_agent_auto_pause_total{reason}` | Counter | Auto-pauses triggered by reject limit |
| `vici2_ingroup_sticky_wait_total{igid}` | Counter | Sticky-agent wait for WRAPUP transitions |
| `vici2_callback_lookup_timeout_total{igid}` | Counter | D01 CRM lookups that timed out (> 200 ms) |
| `vici2_ingroup_skill_cache_hit_ratio` | Gauge | In-process skill cache hit rate |

---

## 22. Dependencies and risks

### 22.1 Hard dependencies (must land before I01 IMPLEMENT)

| Dependency | Status | Owned by | Risk if late |
|---|---|---|---|
| F03 IMPLEMENT (actual dialplan file structure) | TBD | F03 | I01 cannot write `60_*.xml` without real default/ dir |
| T01 PLAN + partial IMPLEMENT | PROPOSED | T01 | ESL commands (`uuid_broadcast`, `uuid_transfer`, `bgapi`) must be callable |
| T03 PLAN + `TransferCustomer` | PROPOSED | T03 | Sacred primitive; I01 dispatch endpoint must call it |
| F04 PLAN (Redis key namespace) | Implied by E02 PLAN | F04 | Key naming conflicts if not frozen |
| E02 PLAN (READY ZSET ownership) | PROPOSED | E02 | Pacing race fix depends on shared ZSET key |
| D01 (lookupLeadByPhone interface) | Implied | D01 | 200 ms deadline assumption; any change needs notification |
| D04 (disposition catalog for inbound) | PROPOSED | D04 | DNC inbound disposition flag must exist |
| D06 (schedulePriorityCallback) | TBD | D06 | Callback offer feature blocked |

### 22.2 Soft dependencies (parallel, do not block)

| Dependency | Notes |
|---|---|
| I02 (DID routing) | I01 only freezes the extension naming; I02 implements the lookup |
| I03 (IVR builder) | Depends on `ingroup_${id}` convention; can develop in parallel |
| I04 (blended) | Needs agent picker interface; I01 provides state transitions |
| I05 (voicemail) | Gets called via overflow `no_agent_action=voicemail` |
| S01 (wallboard) | Reads Redis keys frozen here; can implement in parallel |
| A05 (call panel) | WS event schema frozen in §12.1 |

### 22.3 Risks

| Risk | Probability | Mitigation |
|---|---|---|
| `uuid_broadcast` interrupts MOH in a perceptible way | Medium | Test with FreeSWITCH 1.10.12; if audible gap > 500 ms, switch to a conference-side play mechanism |
| `park` + `curl` to API call has race with fast dispatcher | Low | `/internal/queue/enroll` enqueues to Redis before returning; dialplan `park` issued after `curl` returns; dispatcher wakes on stream event |
| Redis ZSET score collision for two simultaneous callers | Negligible | Scores are milliseconds since epoch; two calls same ms → ZADD keeps both with same score; ZRANGE ordering is by insertion for equal scores — acceptable |
| Skill cache 5-min TTL causes stale routing on rapid agent promotion | Low | Pub/sub invalidation on every skill save brings TTL to effectively 0 s for admin-triggered changes |
| Dispatcher goroutine leak if ingroup deleted while calls in queue | Medium | Supervisor pattern: DELETE in-group API call first drains queue (refuse delete if queue_depth > 0), then stops goroutine |
| `dispatch_inbound.v1.lua` SHA mismatch after Redis flush | Low | On startup, re-run `SCRIPT LOAD`; verify SHA matches embedded constant; fail loud if mismatch |

---

## 23. Open question resolutions

All 14 RESEARCH §17 open questions resolved here:

| Q# | Question | Resolution |
|---|---|---|
| Q1 | `mod_callcenter` vs custom Go queue | **CUSTOM GO QUEUE** — FROZEN. See §2 for 3 reasons. |
| Q2 | Default routing algorithm | **`skill_priority`** with longest-idle tiebreaker. FROZEN in §5. |
| Q3 | `ring-all` in Phase 3 or defer? | **DEFER to Phase 3+**. Multi-leg originate complexity not justified for Phase 3. |
| Q4 | Sticky default window | **24 hours**. Operator can reduce. FROZEN in §5.2. |
| Q5 | EWT formula precision | **Simple `pos × aht / agents`; Erlang-C deferred to Phase 4.** FROZEN in §8. |
| Q6 | Announce-position minimum threshold | **EWT > 60 s**. Operators can lower via `announce_min_wait_sec`. FROZEN in §8.1. |
| Q7 | Callback offer default | **DISABLED by default** (`callback_offer_enabled=false`). Operator opt-in. FROZEN in §11. |
| Q8 | Priority caps | **DID: 600 s, CRM: 300 s, total: 900 s**. FROZEN in §10. No operator override above these caps (prevents starvation). |
| Q9 | Sticky-when-WRAPUP | **YES, wait up to `ingroup.wrapup_seconds`, then fall through to algorithm.** FROZEN in §5.2. |
| Q10 | `mod_xml_curl` vs static templating | **Static templating for Phase 3.** FROZEN in §15.3. |
| Q11 | Preview modal duration | **3 seconds default** (PLAN-phase override from RESEARCH 5 s suggestion). Configurable per-user `users.inbound_preview_ms` (0–10000 ms). FROZEN in §12.2. |
| Q12 | Recording disclosure DID vs ingroup | **Both columns; DID-level takes precedence, ingroup as fallback.** FROZEN in §13.3. |
| Q13 | Skill schema location | **I01 migration** (not F02 amendment). Skills are I01-owned data. |
| Q14 | Inbound DNC auto-add | **NO auto-DNC for inbound**. Caller initiated; agent manually applies DNC disposition via D04 if needed. M06 admin can add manually. |

---

## 24. HANDOFF interface freeze

The following interfaces are FROZEN for downstream module owners:

### 24.1 For I02 (DID routing)

```
Extension naming:  ingroup_{ingroup_id}
Context:           default
File:              dialplan/default/60_ingroup_{id}.xml
Transfer command:  <action application="transfer" data="ingroup_${ingroup_id} XML default"/>
Disclosure audio:  Play did_numbers.recording_disclosure_audio BEFORE transfer (I02's responsibility)
```

### 24.2 For I03 (IVR)

Same extension naming as I02. IVR menu option resolves to `ingroup_id`, then `transfer ingroup_${id} XML default`. I03 does NOT call `/internal/queue/enroll` directly — that is called by the dialplan `curl` action within the ingroup extension.

### 24.3 For I04 (blended)

- Agent state HASH: `t:{tid}:agent:{uid}` `status`, `call_uuid`, `ingroup_id` fields
- Global INCALL ZSET: `t:{tid}:agents:by_status:INCALL`
- I01 excludes agents with `campaign_id` set (on INCALL for outbound) from inbound dispatch
- I04 extends `users.closer_ingroups` JSON array + blended picker in E04

### 24.4 For I05 (voicemail)

```
Transfer convention:  T01.UUIDTransfer(call_uuid, "voicemail_{ingroup_id} XML default")
I05 must implement:   extension "voicemail_{ingroup_id}" in dialplan/default/
I01 passes:           channel var vici2_ingroup_id, vici2_tenant_id, vici2_caller_id
```

### 24.5 For S01 (wallboard)

Redis keys (read-only):
- `t:{tid}:ingroup:{igid}:queue` (ZSET; ZCARD for depth)
- `t:{tid}:ingroup:{igid}:queue_meta` (HASH; avg_handle_sec, ready_agents)
- `t:{tid}:ingroup:{igid}:ewt_sec_per_pos` (STRING)
- Valkey Stream `events:vici2.ingroup.*`

### 24.6 For A05 (call panel)

WS event `inbound_call_offer` schema FROZEN in §12.1. Field `preview_timeout_ms` configures the UI countdown. Field `direction: "in"` signals inbound UI mode.

### 24.7 For S02 (supervisor eavesdrop)

Limitation: eavesdrop only works on post-dispatch calls (customer leg inside agent conference). Pre-dispatch queued calls are not eavesdroppable — the channel only carries MOH audio. S02 PLAN must document this constraint.
