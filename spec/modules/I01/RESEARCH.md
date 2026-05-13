# I01 — In-Groups (Inbound Queue + Agent Skill Routing) — RESEARCH

| Field | Value |
|---|---|
| Module | I01 (inbound queues a.k.a. "in-groups"; routes inbound DIDs to ready agents by skill/rank) |
| Phase | 3 (Inbound/Blended) |
| Owner agent type | telephony + backend-go + backend-node |
| Status | RESEARCH (PLAN gated on resolution of the 14 open questions in §17 + commitment to custom-queue vs `mod_callcenter`) |
| Date | 2026-05-13 |
| Module-spec source | `/root/vici2/spec/modules/I01.md` (assumes `mod_callcenter`; this RESEARCH challenges that assumption — see §1) |
| Related plans read | F03 PLAN §4.5/§8/§14 (public dialplan slots, `mod_callcenter` deferred to I01, mod_xml_curl bindings empty), T01 PLAN §3/§7 (ESL inbound socket, originate API, BACKGROUND_JOB events), T03 PLAN §2/§4/§8 (conference-per-agent SACRED primitive, `TransferCustomer`/`uuid_transfer` into agent conf, hold profile, sup join), T03 RESEARCH §4.5 (add-member worst-case 7s), E02 RESEARCH §1/§7 (blended interaction with pacing); DESIGN.md §1.3/§4/§5.1/§7/§9 (conference-per-agent, schema, redis state, agent UI, TCPA); F02 schema `ingroups` + `ingroup_agents` (already exists in `api/prisma/schema.prisma:977-1015`); SPEC.md §4 (compliance + sacred primitives) |

---

## 1. Executive summary (12 bullets)

1. **Recommendation: build a custom Go queue, do NOT use `mod_callcenter`.** Three converging reasons, each independently sufficient. (a) **The conference-per-agent primitive is SACRED** (SPEC.md §4.4) — every transfer/3-way/hold/leave-3way operation in Vici2 is a `conference move`/`uuid_transfer`/`kick` op, and `mod_callcenter` works by *bridging* a caller leg to an *agent leg* (point-to-point, not conference). To use `mod_callcenter` we'd have to glue its "agent answered" event into a `conference` app invocation, which it does not do natively; T03 PLAN §1 already commits that the agent's call leg in the SIP.js conference is the agent identity. (b) **`mod_callcenter` agent state ↔ our agent state must stay coherent**, and the module-spec risk ("mapping callcenter agent state ↔ our state — keep them in sync via ESL events") is the entire ballgame — every state transition (LOGIN, READY, PAUSE, INCALL, WRAPUP) must roundtrip through `callcenter_config agent set status`. The forum issue [#2529 zombie call to agent when member hangs up mid-originate] and [#2516 mod_callcenter bug] document this exact class of split-brain failure. (c) **Skill matching beyond a flat 1–10 tier is non-trivial in `mod_callcenter`** — tiers are integers, not skill *sets*. Modern routing (Genesys, Five9) requires multi-attribute matching (language=es AND tier≥2 AND product=billing). We can fake this with one queue per skill combo, but the combinatorial explosion is bad. A pure-Go queue lets us pick any algorithm. **The cost is ~3,000 LOC of Go we'd otherwise outsource.** Worth it. Detail in §2.

2. **Schema is mostly already there.** `ingroups` + `ingroup_agents` exist in F02 (`api/prisma/schema.prisma:977-1015`). I01 adds: (a) `ingroup_skills` (in-group → required skill key=value list), (b) `agent_skills` (user → skill key=value with proficiency 1-10), (c) `queue_calls` (active waiting calls, Redis-primary + MySQL audit), (d) `queue_log` (partitioned, every queue join/leave/drop/answer event for compliance + reports). `dids` reuse the existing `did_numbers` table from F02. Full DDL in §3.

3. **Skill model: free-form key=value with proficiency.** Vicidial's flat `rank 0-9` per ingroup ([VICIhost SBR][skills-rank]; [forum t=41707][skills-fwd]) is too narrow. Genesys Cloud's "Best Available Skills" ([genesys-sbr][genesys-sbr]) is the pattern: every skill is a (key, value) with a numeric proficiency. An agent has many `(key=value, proficiency)` tuples; an in-group requires a *set* of `(key=value, min_proficiency)` clauses. The router intersects (agent must satisfy every required clause) then ranks by sum-of-proficiencies. Concrete example: in-group `SPANISH_BILLING` requires `language=es,min=5` AND `product=billing,min=3`. Agent Alice has `language=es,prof=8` + `product=billing,prof=5` → match, score=13. Agent Bob has `language=es,prof=9` + `product=tech,prof=7` → no match (no billing). Detail in §4.

4. **Routing algorithm default: `skill-priority-longest-idle` with sticky-agent override.** Six algorithms in scope: ring-all (broadcast), longest-idle, round-robin, top-down, fewest-calls, skill-priority. We default to **skill-priority** (highest combined skill score first, ties broken by longest-idle), with a per-in-group `sticky_agent_window_hours` (default 24) that overrides the algorithm if the caller's `phone_e164` has a `call_log` entry within the window — try the same agent first for `sticky_first_try_seconds` (default 15), then fall back to the algorithm. This combines Vicidial's `ingroup_rank_longest_wait` ([vicihost-sbr][skills-rank]) with the now-standard "Last Agent Routing" pattern ([aws-last-agent][aws-last-agent]; [callerdesk-sticky][callerdesk-sticky]). Algorithm comparison + tradeoffs in §5.

5. **Queue is Redis-primary, MySQL-durable.** A waiting call lives in two places: (a) Redis SORTED SET `t:{tid}:ingroup:{igid}:queue` (score = enter-time-ms + priority-boost), and (b) MySQL `queue_calls` row (durable audit). The router process reads only Redis (hot-path < 5 ms per dispatch decision). On router restart we reconcile from MySQL → Redis (E06-style janitor). The Vicidial pattern of `vicidial_live_inbound_agents` + `vicidial_auto_calls` is exactly this split (one fast in-memory table + one durable table); we just keep the fast side in Redis. `queue_calls` schema in §3.

6. **Hold music per in-group, with three audio segments.** F02's `ingroups.music_on_hold` already exists. I01 expands it into three configurable streams: (a) `moh_stream` (continuous music, default `local_stream://moh`), (b) `welcome_audio` (one-shot played on queue entry, e.g., "Thank you for calling Acme Solar. All agents are busy."), (c) `position_announcement_audio` (template; substituted at runtime with TTS-rendered "You are caller number {pos}, estimated wait {min} minutes"). All optional. The dialplan plays welcome → moh (loop), with an outer-loop `playback` that fires the position announcement every 30s. mod_callcenter has this built in via `announce-position`; our custom queue replicates it. Audio handling in §6.

7. **Estimated-wait formula: simple EWMA, no Erlang-C.** Position-in-queue × `avg_handle_time` ÷ `ready_agents` is the industry standard ([cxengage-ewt][cxengage-ewt]; [puzzel-ewt][puzzel-ewt]). We compute `avg_handle_time` as a 15-minute EWMA over `call_log.talk_seconds` for the in-group (cached in Redis STRING, refreshed every 30s). We do NOT use Erlang-C in Phase 3 — overengineered and not visibly better for ≤50-agent in-groups. Announcement triggers every 30s while waiting, rounded UP to the nearest minute, and silenced if EWT < 60s (saying "less than a minute" is worse than silence). TTS uses `mod_say_en` (already loaded in F03) for digit-only "thirty seconds, two minutes" templates, no general TTS. Formula in §7.

8. **Overflow chain — 3 levels, configurable per in-group.** `no_agent_action` already exists in F02 (ENUM `voicemail`/`hangup`/`overflow_ingroup`). I01 expands semantics: a queue call dwells until ONE of (a) agent answers, (b) caller hangs up, (c) `max_wait_sec` reached → fire `overflow_action`, (d) `max_queue` exceeded at entry → fire `entry_full_action`. Both actions can be `voicemail` (go to I05), `hangup` (drop with apology TTS), `overflow_ingroup` (re-queue into another in-group, max 2 hops to prevent loops), `callback_offer` (D06 callback queue), or `external_transfer` (transfer to a configured PSTN number, e.g., after-hours forwarding). The "max 2 hops" cap is a hard-coded loop detector. Detail in §8.

9. **Priority queues via `cc_base_score`-equivalent.** Three priority sources: (a) **DID-based** — `did_numbers` row carries `priority_boost_seconds` (a VIP 800-number gets +300s head start, matching the `mod_callcenter` `cc_base_score` pattern with `time_base_score=system`, [mod_callcenter docs][modcc]). (b) **CRM-lookup-based** — at queue-entry the API calls `D01.lookupLead(phone_e164)`; if `leads.rank > 0` we apply a proportional boost. (c) **In-group default** — `ingroups.priority` (already in schema, default 50) baseline applied to every call. The boost is added to the SORTED SET score so a "VIP" caller sorts higher than a 60-second-waiting normal caller. Capped at 600s to prevent infinite-priority abuse. Detail in §9.

10. **Callback offer is a queue-exit action, not a separate module.** "Press 1 for a callback" replaces the "wait in queue" behavior. Implementation: dialplan plays an audio prompt every N seconds (`callback_offer_interval`, default 90s); if caller presses 1 we (a) capture their callback number (default = caller-id; can prompt to enter via DTMF), (b) call `D06.schedulePriorityCallback(lead_id, ingroup_id, queue_position, callback_at=now)` which creates an outbound callback in the closer-ingroup's queue, (c) hang up with confirmation TTS. The "preserve queue position" feature ([vicidial INBOUND_CALLBACK_QUEUE][vici-callback]) is implemented by stamping the callback row with the original `queue_enter_ts`; D06 outbound dial honors that on its picker. Detail in §10.

11. **IVR scope split: Phase 3 ships DID→ingroup direct only, Phase 3+ ships nested menus (I03).** Per SPEC.md §5 dependency graph, I03 (IVR builder) is a sibling Phase 3 module that depends on I01. I01's Phase 3 deliverable is: DID arrives → look up DID in `did_numbers` (I02's job) → arrive at the in-group dialplan extension `callcenter_ingress:{igid}` → enqueue. I03 later adds the nested-menu step ("press 1 for sales, press 2 for support") that resolves to a specific in-group. I01 must expose a stable dialplan-extension naming convention so I03 can `transfer` to it — frozen in §13.

12. **Pacing interaction is the entire reason I04 exists.** Inbound calls that pin an agent into INCALL status MUST decrement the outbound `ready_agents` count read by E02 (pacing). Per E02 RESEARCH §1.7 and §4.1, the source of truth is the F04 `t:{tid}:agents:by_status:READY` ZSET. I01's responsibility: when the queue dispatches a call to an agent, **before** the conference transfer, atomically `ZREM` that agent from `READY` and `ZADD` to `INCALL` (same Lua script T03 uses on outbound). E04 (agent picker for outbound) sees the count drop. I04 (blended) adds the "agent serves both" knob (`user.closer_ingroups` JSON) and a `blended_preempt` decision (Vicidial's `closer_priority` setting). E02 + I01 alone are sufficient for *non-blended* — agents either do outbound XOR inbound. Detail in §11.

---

## 2. `mod_callcenter` vs custom Go queue — the decision

### 2.1 What `mod_callcenter` is

A FreeSWITCH application + module ([mod_callcenter docs][modcc]) that maintains:
- **Queues** (named, defined in `callcenter.conf.xml`; **NOT dynamically creatable** via API — must be in XML + reloaded)
- **Agents** (dynamically creatable: `callcenter_config agent add NAME callback`)
- **Tiers** (agent-to-queue mapping with level + position; dynamically settable)
- **Strategies** (`ring-all`, `longest-idle-agent`, `round-robin`, `top-down`, `agent-with-least-talk-time`, `ring-progressively`)

Calls enter a queue via the `callcenter` dialplan app:
```xml
<action application="callcenter" data="support@default"/>
```

When an agent is available, mod_callcenter originates a leg to the agent (using the `contact` field — typically `user/1042@default`), waits for the agent to answer, and **bridges** the caller leg ↔ agent leg. The bridge is a direct point-to-point bridge, not a conference.

### 2.2 Why this clashes with our architecture

| Problem | Detail |
|---|---|
| **Bridge ≠ conference** | T03 PLAN §1/§2 commit that every agent leg lives in `agent_t{tid}_u{uid}@default` conference *for the entire login session*. The customer leg is `uuid_transfer`'d INTO the conference. mod_callcenter's flow is the inverse: each call rings the agent fresh, bridges, then hangs up the agent leg on customer hangup. To use mod_callcenter we'd have to: (1) prevent it from originating a fresh agent leg, (2) intercept the "agent picked" event, (3) `uuid_transfer` the caller into the agent's existing conference, (4) tell mod_callcenter to release the agent. This is doable with `cc_member_pre_answer_uuid` channel-var manipulation + dialplan trickery but is fragile and against the grain. |
| **State coherence** | We have agent state in Redis (`t:{tid}:agent:{uid}` HASH, status ∈ READY/INCALL/WRAPUP/PAUSED). mod_callcenter has its OWN agent state (Available, On Break, Logged Out + dynamic state Idle/Waiting/Receiving/InQueueCall). Two state machines = drift. Forum issue [#2529][issue-2529] documents zombie calls when state diverges. We'd need a hot-path Redis subscriber → `callcenter_config agent set status` translator on every transition. |
| **Schema requires conf reload for new queues** | mod_callcenter has `callcenter_config queue reload` ([dopensource-cc][dopensource]) but **no `queue add`** API. New ingroups require a `callcenter.conf.xml` rewrite + `reload mod_callcenter`. F03 PLAN already templates this — workable but uglier than a pure-Redis-state model where new ingroups are zero-downtime. |
| **Skill matching is tier-only** | mod_callcenter's tier system is a single integer per `(agent, queue)`. No multi-attribute matching. We'd need one queue per skill *combination* (combinatorial explosion for `language × product × tier`) OR external pre-routing that selects a queue at DID entry. |
| **Performance ceilings** | Issue [#2458][issue-2458] documents calls getting stuck and agents not answering at ~200 CCU / 20 CPS on 12vCPU/12GB. Issue [#889][issue-889] documents mod_callcenter becoming unresponsive after >24h idle. Issue [#1216][issue-1216] documents top-down getting stuck if last agent unavailable. These are real production bugs in an active project. |
| **Wrap-up timer is per-queue, not per-campaign** | F02 already has `campaigns.wrapup_seconds`; we'd have to duplicate into queue config and keep in sync. |

### 2.3 Why a custom Go queue is the right call

We already have:
- **T01 ESL bridge** with originate + transfer + uuid_setvar primitives — everything we need to dispatch a call to an agent.
- **T03 conference operator** with `TransferCustomer(customerUUID, agentUserID)` — the exact operation we need.
- **F04 Redis state** with agent ZSETs by status — the source of truth.
- **E04 agent picker** (Phase 2) — the same code path picks the next agent for outbound; we can reuse it.

The custom queue is roughly:
- One Go goroutine per in-group ("dispatcher loop"), wakes on (a) new-call event, (b) agent-state-change event, (c) timer tick (default 1Hz for EWT recompute + announcement scheduling).
- Reads Redis ZSET of waiting calls, scores agents per the routing algorithm, picks one, calls `T03.TransferCustomer`. Atomically `ZREM`s the call from the queue and ZADDs in the call→agent assignment map.
- On agent answer (CHANNEL_ANSWER event consumed by ESL): state transition handled by T03 add-member flow — no new code.
- On caller hangup mid-queue: ESL event → remove from ZSET, log drop reason.

Estimated LOC: ~1500 production + ~1200 test (one dispatcher.go, one router.go, one announce.go, one overflow.go, plus tests). Compared to ~800 LOC of XML templating + agent-state syncing code with mod_callcenter — the savings are similar, but the custom version aligns with the rest of the codebase (Go + Redis + Lua scripts) and inherits the same telemetry/metrics framework.

### 2.4 What we keep from `mod_callcenter` conceptually

- Score-based queueing (Redis ZSET score = enter_ts - priority_boost; lowest score dispatched first).
- Tier-rule wait (a high-rank agent can be "reserved" for first N seconds of a call before falling through to lower-rank agents).
- Wrap-up time (we already have it per-campaign; we add per-ingroup override).
- Strategies (we implement all 6 + sticky-agent).
- Announcement-position pattern.

### 2.5 Recommendation

**Build custom Go queue. Skip `mod_callcenter` entirely. Do NOT load the module in F03.** (F03 PLAN §8 already defers loading; we just don't un-defer.)

The module-spec I01.md mandates `mod_callcenter` — this RESEARCH challenges that. The PLAN phase needs a checkpoint decision; if accepted, file as a PLAN-phase deliberate refinement (per F03 PLAN §1.3 pattern) since the public interface (`/api/admin/ingroups`, DID routing via I02, agent assign/unassign) is unchanged. If rejected, fall back to mod_callcenter with the wrapper-bridge approach described in §2.2 row 1 (estimate +2 weeks effort + 2× ops complexity).

---

## 3. Schema

F02 already has `ingroups`, `ingroup_agents`, `did_numbers`. I01 adds these tables. All migrations reversible per SPEC.md §3.8. All have `tenant_id` per SPEC.md §4.5.

### 3.1 `ingroup_skills` — required skills per in-group

```sql
CREATE TABLE ingroup_skills (
  tenant_id      BIGINT NOT NULL DEFAULT 1,
  ingroup_id     VARCHAR(32) NOT NULL,
  skill_key      VARCHAR(32) NOT NULL,         -- e.g., 'language', 'product', 'certification'
  skill_value    VARCHAR(32) NOT NULL,         -- e.g., 'es', 'billing', 'level2'
  min_proficiency TINYINT NOT NULL DEFAULT 1,  -- 1-10
  required       BOOLEAN NOT NULL DEFAULT TRUE,-- if false, contributes to score but not gating
  weight         SMALLINT NOT NULL DEFAULT 100,-- multiplier when summing match score
  created_at     DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6),
  updated_at     DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (tenant_id, ingroup_id, skill_key, skill_value),
  INDEX idx_ingroup_skills_t_skill (tenant_id, skill_key, skill_value),
  CONSTRAINT fk_ingroup_skills_ingroup FOREIGN KEY (tenant_id, ingroup_id)
      REFERENCES ingroups(tenant_id, id) ON DELETE CASCADE
);
```

### 3.2 `agent_skills` — what each agent can do

```sql
CREATE TABLE agent_skills (
  tenant_id      BIGINT NOT NULL DEFAULT 1,
  user_id        BIGINT NOT NULL,
  skill_key      VARCHAR(32) NOT NULL,
  skill_value    VARCHAR(32) NOT NULL,
  proficiency    TINYINT NOT NULL DEFAULT 1,    -- 1-10
  certified_at   DATE,                          -- optional cert/training date (for reporting only)
  expires_at     DATE,                          -- optional (auto-disable after; null = never)
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6),
  updated_at     DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (tenant_id, user_id, skill_key, skill_value),
  INDEX idx_agent_skills_t_skill (tenant_id, skill_key, skill_value, proficiency),
  CONSTRAINT fk_agent_skills_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
```

### 3.3 `did_numbers` — extend existing F02 table

F02 already has `did_numbers` with `route_kind` ENUM `ingroup`/`ivr`/`agent`/`ext`/`voicemail`. I01 ADDs columns (additive amendment, no RFC per SPEC §12):

```sql
ALTER TABLE did_numbers
  ADD COLUMN priority_boost_seconds INT NOT NULL DEFAULT 0 AFTER active,  -- VIP head-start
  ADD COLUMN crm_lookup_enabled BOOLEAN NOT NULL DEFAULT TRUE AFTER priority_boost_seconds,
  ADD COLUMN recording_disclosure_audio VARCHAR(255) AFTER crm_lookup_enabled, -- "this call may be recorded" prompt
  ADD COLUMN business_hours_id BIGINT AFTER recording_disclosure_audio;    -- FK to call_times (closed-time handling)
```

### 3.4 `queue_calls` — durable record of every waiting call

```sql
CREATE TABLE queue_calls (
  id             BIGINT PRIMARY KEY AUTO_INCREMENT,
  tenant_id      BIGINT NOT NULL DEFAULT 1,
  call_uuid      VARCHAR(40) NOT NULL,           -- FreeSWITCH UUID; FK to call_log
  ingroup_id     VARCHAR(32) NOT NULL,
  did_e164       VARCHAR(16),
  caller_id_e164 VARCHAR(16),
  lead_id        BIGINT,                         -- nullable; resolved at CRM lookup
  enter_at       DATETIME(6) NOT NULL,
  base_score     INT NOT NULL,                   -- score at insert (negative priority_boost)
  matched_skills JSON,                           -- snapshot of skill requirements at entry
  dispatch_at    DATETIME(6),                    -- when picked to an agent (nullable)
  dispatch_user  BIGINT,                         -- which agent
  exit_at        DATETIME(6),
  exit_reason    ENUM('answered','caller_hangup','timeout','overflow','callback','full_at_entry','agent_no_answer'),
  position_at_entry INT,                          -- snapshot for analytics
  wait_seconds   INT,                             -- computed at exit
  recording_uuid VARCHAR(40),
  created_at     DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6),
  INDEX idx_qc_t_ingroup_enter (tenant_id, ingroup_id, enter_at),
  INDEX idx_qc_t_exit (tenant_id, exit_at, exit_reason),
  INDEX idx_qc_t_lead (tenant_id, lead_id),
  INDEX idx_qc_t_uuid (tenant_id, call_uuid)
)
PARTITION BY RANGE (TO_DAYS(enter_at)) (
  PARTITION p_2026_05 VALUES LESS THAN (TO_DAYS('2026-06-01')),
  PARTITION p_2026_06 VALUES LESS THAN (TO_DAYS('2026-07-01')),
  -- ... monthly partitions handled by O02 retention worker
  PARTITION p_max VALUES LESS THAN MAXVALUE
);
```

Note: NO FK on `call_uuid` because `call_log` is also partitioned (per F02 init migration) and MySQL forbids FK across different partitioned tables; we maintain integrity via app-layer assertion.

### 3.5 `queue_log` — every state transition (compliance audit)

```sql
CREATE TABLE queue_log (
  id             BIGINT PRIMARY KEY AUTO_INCREMENT,
  tenant_id      BIGINT NOT NULL DEFAULT 1,
  queue_call_id  BIGINT NOT NULL,
  event_at       DATETIME(6) NOT NULL,
  event          ENUM('enter','position_announce','offer_callback','accept_callback',
                      'sticky_attempt','dispatch','agent_no_answer','reroute','overflow',
                      'answer','caller_hangup','timeout','full_block') NOT NULL,
  metadata       JSON,        -- algorithm decision, agent_user_id, position, EWT, etc.
  INDEX idx_ql_t_qc (tenant_id, queue_call_id, event_at),
  INDEX idx_ql_t_event (tenant_id, event, event_at)
)
PARTITION BY RANGE (TO_DAYS(event_at)) ( /* monthly */ );
```

This is the audit trail for compliance + post-hoc routing-decision debugging. Every dispatch decision writes one row with `metadata.algorithm`, `metadata.candidate_agents`, `metadata.picked_score` — operators can reconstruct "why did Alice get this call and not Bob" from this table.

### 3.6 Redis live state

```
t:{tid}:ingroup:{igid}:queue                → ZSET (score=enter_ts_ms - priority_boost_ms, member=call_uuid)
t:{tid}:ingroup:{igid}:queue_meta           → HASH {avg_handle_sec, ready_agents, last_dispatch_ts, dispatch_total}
t:{tid}:ingroup:{igid}:ready_agents         → ZSET (score=last_ready_change_ts, member=user_id; filtered to this ingroup's agents who are READY now)
t:{tid}:queue_call:{call_uuid}              → HASH {ingroup_id, lead_id, caller_id, enter_ts, base_score, last_announce_ts, sticky_target_user, ...}
t:{tid}:queue_dispatch_lock:{igid}          → STRING SET NX EX 5  (prevent two dispatchers from racing)
t:{tid}:sticky:{phone_e164}                 → STRING TTL 24h        (last_agent_user_id for sticky-agent routing)
t:{tid}:ingroup:{igid}:ewt_seconds          → STRING TTL 60s        (EWT cache, refreshed by dispatcher loop)
```

The `ZSET` is the heart. Score is computed as `enter_ts_ms - priority_boost_ms` so VIP callers (positive boost) sort *first* (lowest score). When dispatching, `ZRANGE … 0 0` returns the highest-priority waiting call. On caller hangup, `ZREM` removes by UUID. On timeout, dispatcher loop scans `ZRANGEBYSCORE -inf <max_wait_threshold>` and processes overflow.

---

## 4. Skill model (detail)

### 4.1 Why key=value, not flat ranks

Vicidial's flat 0-9 rank per ingroup ([VICIhost SBR][skills-rank]; [vicidial t=37537][vici-37537]) requires creating a separate in-group for every skill *combination*. A real call center has dimensions:
- Language: en, es, fr, ...
- Product line: solar, billing, technical, retention, ...
- Tier: tier1, tier2, tier3 (proficiency)
- Special: VIP, escalation, compliance-sensitive, ...

With 4 languages × 4 products × 3 tiers = 48 in-groups in Vicidial. Unmanageable.

Genesys Cloud's "Best Available Skills" ([genesys-sbr][genesys-sbr]) and Five9's SBR ([five9-sbr][five9-sbr]) both use multi-attribute matching with proficiency. Vici2 follows that pattern.

### 4.2 Match formula

For each waiting call requiring skills `R = {(k1,v1,min1,req1,w1), ...}` and each candidate agent with skills `A = {(k,v,p), ...}`:

```python
def match(agent, requirements):
    score = 0
    for (k, v, min_prof, required, weight) in requirements:
        agent_prof = agent.proficiency_for(k, v)  # 0 if not present
        if required and agent_prof < min_prof:
            return None  # GATING — agent disqualified
        if agent_prof >= min_prof:
            score += (agent_prof - min_prof + 1) * weight
    return score  # higher is better; None = no match
```

Example:
- In-group `SPANISH_BILLING` requires:
  - `(language=es, min=5, required=True, weight=100)`
  - `(product=billing, min=3, required=True, weight=80)`
  - `(certification=PCI, min=1, required=False, weight=20)` ← preference, not gate
- Agent Alice: `(language=es, prof=8)`, `(product=billing, prof=5)`
  - language: 8≥5 ✓, score += (8-5+1)*100 = 400
  - billing: 5≥3 ✓, score += (5-3+1)*80 = 240
  - PCI: 0<1 ✗ but not required, no penalty (just 0 contribution)
  - **Final score: 640**
- Agent Bob: `(language=es, prof=9)`, `(product=tech, prof=7)`, `(certification=PCI, prof=2)`
  - language: 9≥5 ✓, score += (9-5+1)*100 = 500
  - billing: 0<3 ✗, REQUIRED → disqualified
  - **Final score: None**

### 4.3 Multi-skill ingroup with optional skills

If an in-group has zero required skills (all optional), every agent assigned to the in-group is eligible; score determines ordering. This is the "broad queue with preference for specialists" pattern.

### 4.4 Skill admin in M05 / new M0X

Skills CRUD lives in agent admin (M05 — User & group management) for `agent_skills` and a new admin screen for `ingroup_skills` under in-group config. PLAN should add an M05 amendment or file a new M09 module spec. We document the requirement; the M-track owns the UI.

### 4.5 Skill caching

Agent skills change rarely (training events). Cache in process memory with a 5-minute TTL + invalidate via pubsub `agent_skills_changed:{user_id}` when M05 admin saves a change. Read-path cost: zero MySQL hits in steady state.

---

## 5. Routing algorithms

Six algorithms — pick one per in-group as the primary; sticky-agent is an orthogonal override.

| Algo | Score function (lower = picked first) | When to use |
|---|---|---|
| **skill-priority** (default) | `-skill_match_score, last_ready_change_ts` | General case; favors skill match, ties broken by longest-idle |
| **longest-idle** | `last_ready_change_ts` | Equal-skill agents; fair distribution |
| **round-robin** | `last_dispatched_at` | Even call distribution regardless of idle time |
| **ring-all** | (parallel originate to all matched agents) | Small teams (≤5); whoever answers first wins |
| **top-down** | `agent.rank ASC, last_ready_change_ts` | Hierarchy / supervisor-first |
| **fewest-calls** | `calls_handled_today ASC, last_ready_change_ts` | Long-tail fairness |

### 5.1 ring-all caveat

`ring-all` requires bridging a *new* leg to every agent simultaneously. Without `mod_callcenter`, this is multiple `bgapi originate` to each agent extension with `early_media=true` and conditionally `uuid_transfer` the winner into the agent's *existing* conference + cancel the others. Complex. **Recommend deferring ring-all to Phase 3+; ship 5 algorithms in Phase 3.**

### 5.2 Sticky-agent override

Independent of the primary algorithm. Logic at queue-entry:

```python
def maybe_route_sticky(call, ingroup):
    if not ingroup.sticky_enabled:
        return None
    last_agent = redis.get(f"t:{tid}:sticky:{call.phone_e164}")
    if not last_agent:
        return None
    agent = lookup(last_agent)
    if agent.status == 'READY' and matches_skills(agent, ingroup.skills):
        return agent  # sticky match
    # Optional: WAIT for sticky agent for up to sticky_first_try_seconds (default 15)
    if ingroup.sticky_wait_seconds > 0:
        return ('wait_then_fallback', last_agent, ingroup.sticky_wait_seconds)
    return None
```

Sticky window default: 24 hours. Configurable per-ingroup. Disabled by default (operator opt-in) because for general-purpose support queues sticky can be counterproductive (Alice took the call; she's now off-shift; call waits anyway for her).

### 5.3 Recommendation

Default: **`skill-priority` with sticky disabled**. PLAN should add `ingroups.routing_strategy` ENUM column + `sticky_enabled`/`sticky_window_hours`/`sticky_first_try_seconds` columns.

---

## 6. Hold music + announcements

### 6.1 Three audio streams

```
ingroups.moh_stream              VARCHAR(255) DEFAULT 'local_stream://moh'
ingroups.welcome_audio           VARCHAR(255) NULL  -- one-shot at entry, e.g., 'sounds/welcome_acme.wav'
ingroups.position_announce_template VARCHAR(255) NULL  -- e.g., 'sounds/position_template.wav' or 'say:en:queue_position'
ingroups.announce_interval_sec   INT DEFAULT 30   -- 0 = disabled
ingroups.announce_min_wait_sec   INT DEFAULT 60   -- skip announce if EWT < this
```

### 6.2 Dialplan flow (custom queue version)

When a call hits an in-group's dialplan extension `ingroup_{igid}`:

```xml
<extension name="ingroup_SUPPORT">
  <condition field="destination_number" expression="^ingroup_SUPPORT$">
    <action application="answer"/>
    <action application="set" data="vici2_role=customer_leg"/>
    <action application="set" data="vici2_ingroup_id=SUPPORT"/>
    <action application="set" data="hangup_after_bridge=false"/>
    <action application="set" data="continue_on_fail=true"/>

    <!-- Recording disclosure (if did_numbers.recording_disclosure_audio is set, played by I02 before transfer here) -->
    <!-- Welcome audio -->
    <action application="playback" data="${ingroup_welcome_audio}"/>

    <!-- Park the customer with MOH while custom-queue dispatcher decides -->
    <!-- 1. Add to Redis queue (via API HTTP POST or mod_xml_curl) -->
    <action application="curl" data="${api_url}/internal/queue/enroll?call_uuid=${uuid}&amp;ingroup=SUPPORT post"/>

    <!-- 2. Park with MOH; dispatcher will issue uuid_transfer to agent conf when ready -->
    <action application="set" data="hold_music=${ingroup_moh_stream}"/>
    <action application="park"/>
  </condition>
</extension>
```

`park` puts the caller on hold indefinitely with MOH; the dispatcher process issues `uuid_transfer ${call_uuid} agent_conf:{user_id} XML default` when ready (T03 has the exact pattern).

Announcements: dispatcher loop wakes the announcement scheduler every `announce_interval_sec` and, for each waiting call, issues `uuid_broadcast {uuid} playback::sounds/position_announce.wav both` over ESL. The broadcast app plays an audio file into a live channel without disrupting MOH (well, it briefly interrupts MOH then MOH resumes; acceptable). The `both` flag plays to both legs but there's only one leg here.

### 6.3 TTS for position + EWT

For position announcements we synthesize via `mod_say` (loaded in F03 PLAN §8):
```
say:en:NUMBER:pronounced:5  → "five"
say:en:TIME_MEASURE:pronounced:90  → "ninety seconds"
```

For the prefix/suffix ("You are caller number ___, estimated wait ___") we use pre-recorded audio segments concatenated:
```
playback:sounds/you_are_caller.wav
say:en:NUMBER:pronounced:${position}
playback:sounds/estimated_wait.wav
say:en:TIME_MEASURE:pronounced:${ewt_seconds}
playback:sounds/please_hold.wav
```

This is the same pattern Vicidial uses for `agi-VDAD_ALL_inbound.agi` audio composition. No external TTS provider needed; mod_say handles English, Spanish, French built-in.

### 6.4 Hold-music streaming

F03 PLAN §5 ships `local_stream://moh` as the default. Per-in-group overrides:
- `local_stream://moh_smooth_jazz`
- `tone_stream://%(2000,4000,440,480)` (US ringback tone — for "still ringing" feel)
- `sounds/custom_moh_${ingroup_id}.wav` (uploaded WAV files for branded MOH)

Custom MOH files live in `freeswitch/sounds/moh/{tenant_id}/{ingroup_id}.wav` (mounted volume), uploaded via admin UI.

---

## 7. Estimated wait time

### 7.1 Formula

```
EWT_seconds = (queue_position × avg_handle_time_seconds) / max(1, ready_agents)
```

where:
- `queue_position`: 1-indexed position in the SORTED SET (ZRANK + 1)
- `avg_handle_time_seconds`: 15-minute EWMA over `call_log.talk_seconds` for this in-group's handled inbound calls
- `ready_agents`: count of agents currently READY for this in-group (matched by skills + status=READY)

Industry-standard simple form, used by:
- Genesys Cloud ([genesys-ewt][genesys-ewt])
- Puzzel ([puzzel-ewt][puzzel-ewt])
- Microsoft Dynamics 365 ([msdyn-ewt][msdyn-ewt])

### 7.2 Compute cadence

Dispatcher loop computes EWT for each in-group every 30 seconds:
```python
def recompute_ewt(igid):
    ready_count = redis.zcard(f"t:{tid}:ingroup:{igid}:ready_agents")
    aht = redis.hget(f"t:{tid}:ingroup:{igid}:queue_meta", "avg_handle_sec") or 180
    # cache: per-call position × aht / ready_count, recomputed per position
    redis.set(f"t:{tid}:ingroup:{igid}:ewt_seconds_per_position", aht // max(1, ready_count), ex=60)
```

### 7.3 Announcement gating

Only announce if `EWT > announce_min_wait_sec` (default 60). For EWT 0-30s, no announcement (silence is better than "estimated wait less than a minute"). For 30-60s, optional. For ≥60s, announce. Always announce at queue-entry as part of welcome audio if `EWT ≥ 60`.

Round UP to nearest 30s for < 2min, nearest minute thereafter. ("Two minutes", "five minutes", not "two minutes thirty-seven seconds".)

### 7.4 AHT EWMA computation

```python
def update_aht(igid, new_talk_seconds):
    # exponential weighted moving average, alpha=0.1 (smooth over ~10 calls)
    current = float(redis.hget(f"t:{tid}:ingroup:{igid}:queue_meta", "avg_handle_sec") or 180)
    new_aht = 0.9 * current + 0.1 * new_talk_seconds
    redis.hset(f"t:{tid}:ingroup:{igid}:queue_meta", "avg_handle_sec", str(new_aht))
```

Triggered by call-end ESL event for inbound calls. On startup, seed from `call_log` query (last 100 inbound calls' avg talk_seconds).

### 7.5 No Erlang-C in Phase 3

Erlang-C ([techtarget-erlangc][techtarget-erlangc]; [callcentrehelper-erlangc][cch-erlangc]) gives a more precise probability-of-wait given offered traffic + service rate + N servers. For our scale (≤50 agents per in-group typically), the marginal accuracy gain over the simple formula is < 10 seconds and not visibly better to callers. Add to Phase 4 backlog.

---

## 8. Overflow / fallback chain

### 8.1 Existing schema

F02 `ingroups`:
- `max_queue` INT default 100 (rejects entry when full)
- `agent_wait_sec` INT default 60 (renamed: `max_wait_sec` for clarity)
- `no_agent_action` ENUM `voicemail`/`hangup`/`overflow_ingroup`
- `no_agent_target` VARCHAR (target ingroup ID, voicemail box, or external number)

### 8.2 Amendments

I01 ADDs columns (additive):

```sql
ALTER TABLE ingroups
  ADD COLUMN entry_full_action ENUM('hangup','overflow_ingroup','voicemail','callback_offer','external_transfer')
        DEFAULT 'hangup' AFTER no_agent_target,
  ADD COLUMN entry_full_target VARCHAR(64) AFTER entry_full_action,
  ADD COLUMN callback_offer_enabled BOOLEAN DEFAULT FALSE,
  ADD COLUMN callback_offer_after_seconds INT DEFAULT 90,
  ADD COLUMN closed_action ENUM('voicemail','hangup','overflow_ingroup','callback_offer')
        DEFAULT 'voicemail' AFTER callback_offer_after_seconds,
  ADD COLUMN closed_target VARCHAR(64),
  ADD COLUMN business_hours_id BIGINT;   -- FK to call_times
```

### 8.3 Decision tree at queue entry

```
on inbound call to ingroup IG:
  if IG.business_hours_id and not within_business_hours():
    do IG.closed_action with target IG.closed_target → done
  if call_count(IG) >= IG.max_queue:
    do IG.entry_full_action with target IG.entry_full_target → done
  enqueue → wait
```

### 8.4 Decision tree on max-wait reached

```
on queue_call.enter_at + IG.max_wait_sec elapsed without dispatch:
  do IG.no_agent_action with target IG.no_agent_target → done
```

### 8.5 Overflow ingroup loop protection

Hard cap: 2 hops. Tracked in Redis HASH `t:{tid}:queue_call:{uuid}.overflow_hops` (INCR on each `overflow_ingroup` action). On hop 3, fall through to `hangup`. Loop reported as `vici2_ingroup_overflow_loop_total` metric.

### 8.6 External transfer (Phase 3+ option)

If `entry_full_action=external_transfer`, the call leaves the platform via `transfer:external/${number} XML default` → carrier gateway. This is **rare** (most operators prefer voicemail/callback), so we ship it but document it as "use with care" — it loses our recording, our analytics, our supervisor visibility.

---

## 9. Priority queues

### 9.1 Three priority sources

Each contributes a "priority boost" measured in seconds (subtracted from ZSET score so VIP sorts first).

| Source | Where stored | Default | Cap |
|---|---|---|---|
| DID-based | `did_numbers.priority_boost_seconds` | 0 | 600 |
| CRM-lookup-based | computed from `leads.rank` × 30 | 0 | 300 |
| In-group baseline | `ingroups.priority` (existing) | 50 | n/a (50 is mid; higher = more important *across* in-groups but doesn't affect within-queue ordering) |

Total boost = DID + CRM + cap at 900s (15 min head start). Caps prevent infinite-VIP abuse where a misconfigured boost = 99999 starves all other callers.

### 9.2 Score computation at entry

```python
def compute_initial_score(call, ingroup):
    base = enter_ts_ms  # absolute time as integer
    boost_sec = 0
    boost_sec += did.priority_boost_seconds if did else 0
    if did.crm_lookup_enabled and call.lead and call.lead.rank > 0:
        boost_sec += min(300, call.lead.rank * 30)
    boost_sec = min(900, boost_sec)
    score = base - boost_sec * 1000
    return score
```

### 9.3 Why subtract not add

ZSET sorts ascending; "lowest score = picked first". Earlier `enter_ts_ms` (waiting longer) = lower score = priority. Subtracting boost from `enter_ts_ms` makes a VIP appear to have entered earlier than they did, effectively jumping the line by `boost_sec`.

### 9.4 Anti-starvation

Cap of 900s means even a "max VIP" gets only a 15-minute head start; a regular caller waiting 16 minutes sorts ahead. Prevents the "VIP queue starves the rest" failure mode.

### 9.5 CRM lookup

At queue-entry, the queue-enroll endpoint calls `D01.lookupLeadByPhone(phone_e164)`. If found, populate `queue_calls.lead_id` and `leads.rank` is read. If not found, `lead_id = NULL` and no CRM boost. The lookup is a single PK index hit; sub-millisecond. We don't block on a slow CRM lookup beyond 200ms (fall back to no-boost). External CRM integrations (N03/N04) are Phase 4 — for now, "CRM" means the internal `leads` table.

---

## 10. Callback offer

### 10.1 Trigger

When a caller has been in queue ≥ `IG.callback_offer_after_seconds` (default 90s, 0 = disabled), dialplan plays an audio offer once: "Press 1 to receive a callback when an agent is available, and we'll preserve your place in line. Press any other key or stay on the line to continue holding."

### 10.2 Detection

`mod_dptools play_and_get_digits` blocks the MOH briefly, captures one digit with 5s timeout, then resumes MOH:

```xml
<action application="play_and_get_digits"
        data="1 1 1 5000 # sounds/callback_offer.wav sounds/invalid.wav digits \d 1000 ^1$"/>
<action application="execute_extension" data="callback_accepted XML default"/>
```

If digit `1` was pressed, `digits` channel-var = "1" → branch to `callback_accepted` extension.

### 10.3 Callback accepted flow

```
1. Capture callback number (default: ${caller_id_number}; optional DTMF entry)
2. POST /internal/queue/exit_callback?call_uuid=...&callback_number=${number}
   API:
     a. Read queue_call row (positioned, priority, lead, ingroup)
     b. INSERT INTO callbacks (lead_id, campaign_id=ingroup.closer_campaign or NULL,
                              user_id=NULL, callback_at=NOW(), 
                              comments='Callback from in-group ${ingroup} queue position ${pos}',
                              status='PENDING')
     c. Stamp callbacks.queue_position_at_offer for preserve-position priority on outbound dial
     d. ZREM call from ingroup queue (exit_reason='callback')
     e. UPDATE queue_calls SET exit_reason='callback', exit_at=NOW()
3. Play confirmation TTS: "Thank you. We'll call you back at ${number}."
4. Hangup with NORMAL_CLEARING.
```

### 10.4 Preserve-position semantics

The "preserve queue position" feature ([vicidial INBOUND_CALLBACK_QUEUE][vici-callback]) means: the callback should be dialed when it's the caller's TURN, not at some unspecified later time. We achieve this via:
- `callbacks.queue_position_at_offer` integer
- D06 callback scheduler: when scheduling priority callbacks, sort by position ascending → caller with original position 2 is dialed before caller with original position 5

Closer-ingroup campaigns (`campaigns.closer_ingroups`) receive these callbacks via the existing E02 outbound dial loop — agents serving the in-group as outbound closers see them in their queue.

### 10.5 Callback expiration

`callbacks.expires_at` already exists (or add it: `expires_at DATETIME default DATE_ADD(NOW(), INTERVAL 96 HOUR)`). After 96 hours unfulfilled, mark `status='EXPIRED'` via cron (matches Vicidial INBOUND_CALLBACK_QUEUE 96h default).

### 10.6 Closed-time callback offer

When `IG.closed_action=callback_offer`, an inbound call arriving outside business hours hears "We're closed; press 1 for a callback during business hours." Logic same as above but `callback_at` is set to the next business-hours open time.

---

## 11. Pacing interaction (E02 ↔ I01)

### 11.1 The invariant

E02's `desired_new_originates = round(agents × dial_level) - active_calls` (E02 RESEARCH §3.1) reads `agents` from `t:{tid}:agents:by_status:READY` ZSET. If an inbound call pins an agent into INCALL, that agent must immediately disappear from READY.

### 11.2 The flow

1. Dispatcher picks call `C` from in-group queue for agent `A`.
2. **Lua script `dispatch_inbound.v1.lua`** atomically:
   - `ZREM t:{tid}:agents:by_status:READY user_id` → removes agent from outbound-pacing's pool
   - `ZREM t:{tid}:ingroup:{igid}:ready_agents user_id` → removes from this in-group's pool
   - `ZREM t:{tid}:ingroup:{igid}:queue call_uuid` → removes call from queue
   - `HSET t:{tid}:agent:{user_id} status INCALL, call_uuid={uuid}, ingroup_id={igid}` → state transition
   - `ZADD t:{tid}:agents:by_status:INCALL user_id score=now`
3. T01.UUIDTransfer to agent conf — same as outbound path.
4. T03's add-member event handler picks up the new participant.

The Lua script is atomic so E02 cannot read a stale "agent is READY" between the dispatch decision and the state update.

### 11.3 Blended (I04) overlap

E02 RESEARCH §1 already discusses this; I01 is the source of the "agent pinned" event. I04 (closer/blended) adds:
- `users.closer_ingroups` JSON array
- Agent picker for outbound (E04) excludes agents currently on inbound (status=INCALL with `ingroup_id` non-null)
- Inverse: dispatcher (I01) excludes agents currently on outbound (status=INCALL with `campaign_id` non-null)

I01 alone supports **non-blended** workflows (agent does outbound XOR inbound based on which campaign/ingroup they logged into). I04 adds simultaneity.

### 11.4 Wrap-up

When inbound call ends (CHANNEL_HANGUP):
- Same flow as outbound: agent → WRAPUP for `min(ingroup.wrapup_seconds || campaign.wrapup_seconds, 60)`
- After WRAPUP timer, agent auto-transitions to READY → ZADD back into READY ZSETs.
- A06 dispo UI presents the disposition picker (D04 + A06).

In-group wrapup override: `ingroups.wrapup_seconds` column (additive amendment), null = inherit from campaign or system default.

---

## 12. Agent UX for inbound

### 12.1 Pre-answer preview

Before bridging the customer into the agent's conf, the API sends an inbound-call event over WS:
```json
{
  "type": "inbound_call_offer",
  "call_uuid": "...",
  "ingroup_id": "SUPPORT",
  "ingroup_name": "Customer Support",
  "caller_id_e164": "+12125551234",
  "did_e164": "+18005550100",
  "wait_seconds": 47,
  "lead": { "id": 12345, "first_name": "Jane", "last_name": "Doe", "city": "NYC", ... }  // null if no match
}
```

A05 (call panel) renders this in a 5-second "preview" modal: agent sees who's calling, prior call history, and (default) **auto-answer** kicks in unless agent presses Reject. Configurable per-user: `users.auto_answer_inbound BOOLEAN default TRUE`.

### 12.2 Reject behavior

If agent rejects within 5s:
- API issues "skip this agent" → dispatcher picks next agent
- `queue_log.event='agent_no_answer'` row written
- Agent stays READY (no penalty for rejecting once per shift)
- Threshold: 3 rejects/hour → auto-flip agent to PAUSE with code `REJECT_LIMIT` (configurable per-tenant)

### 12.3 Auto-answer

Default: enabled. Agent's SIP.js already has auto-answer on INVITE (DESIGN.md §7.2). The "preview" is purely UI — the call is already bridging while agent sees who it is. Reject within 1s = effectively hangup-and-redispatch (race acceptable: rare).

### 12.4 Distinguishing inbound vs outbound in UI

A05 receives `call_started` event with `direction='in'` (already in `call_log.direction` ENUM). The UI shows a different header color (e.g., green for inbound, blue for outbound) plus the in-group badge. Same disposition flow (D04 dispositions); same A07 transfer options; same A08 callback flow; same hangup flow.

### 12.5 Inbound has no "next lead" button

Outbound auto-dial path has A04's "manual dial next lead". Inbound is push-driven — agent waits READY, calls arrive. UI just shows a "Waiting for next inbound call" placeholder.

---

## 13. Dialplan integration

### 13.1 Public dialplan slot

F03 PLAN §4.5 freezes `dialplan/public/10_*.xml` through `dialplan/public/89_*.xml` for I02-rendered DID extensions. I01 contributes the `default`-context extensions that I02 transfers into.

### 13.2 Ingroup extension naming

I01 templates `freeswitch/conf/dialplan/default/60_ingroup_*.xml`, one file per active in-group, rendered by `IngroupRenderer` service. The destination_number convention:
```
ingroup_${ingroup_id}    (e.g., ingroup_SUPPORT)
```

I02's public dialplan does `transfer ingroup_SUPPORT XML default` to hand off.

### 13.3 Template skeleton

```xml
<extension name="ingroup_${id}">
  <condition field="destination_number" expression="^ingroup_${id}$">
    <action application="set" data="vici2_ingroup_id=${id}"/>
    <action application="set" data="vici2_tenant_id=1"/>
    <action application="answer"/>
    <!-- Recording disclosure if needed (set by I02 based on did_numbers.recording_disclosure_audio) -->
    <action application="playback" data="${ingroup_welcome_audio_${id}}"/>
    <action application="set" data="hold_music=${ingroup_moh_${id}}"/>
    <!-- POST to API: enroll in queue -->
    <action application="curl" data="${api_url}/internal/queue/enroll?call_uuid=${uuid}&amp;ingroup=${id}&amp;tenant=1 post"/>
    <!-- Park; dispatcher will issue uuid_transfer when ready or uuid_kill on timeout/overflow -->
    <action application="park"/>
    <!-- On unpark fail (dispatcher times out), arrive here -->
    <action application="curl" data="${api_url}/internal/queue/timeout?call_uuid=${uuid} post"/>
    <action application="hangup" data="NORMAL_CLEARING"/>
  </condition>
</extension>
```

### 13.4 Render trigger

Admin saves an in-group → API renders the XML file + writes to disk + `bgapi reloadxml` via ESL. Standard F01/F03 pattern. Idempotent.

### 13.5 mod_xml_curl alternative

F03 PLAN §7 ships `mod_xml_curl` loaded with empty bindings. Alternative to static templating: I01 binds `dialplan` to the API and serves the in-group extension on-demand. Performance trade: xml_curl adds ~100ms call-setup latency unless aggressively cached; static templating is zero-latency but requires reload-on-change. **Recommend static templating for Phase 3** (in-groups change rarely; reload is fast); revisit if scaling issues arise.

---

## 14. Recording

### 14.1 No new infrastructure

R01/R02 already handle recording via `record_session` started in the agent-conference dialplan (T03 PLAN §7). Inbound calls follow the same path: customer leg gets `uuid_transfer`'d into agent's conf; recording continues across the transfer (`recording_follow_transfer=true`).

### 14.2 Per-in-group recording mode

F02 `ingroups.recording_mode` ENUM (`NEVER`, `ALL`) already exists. PLAN should expand to `(NEVER, ONDEMAND, ALL, ALLFORCE)` for parity with `campaigns.recording_mode`. Default `ALL`.

### 14.3 Disclosure

DESIGN.md §9 already mandates "recording consent prompt in 2-party-consent states". For inbound:
- Played BEFORE queue entry (the caller is the called party; we're "answering" their call but they initiated)
- Stored on `did_numbers.recording_disclosure_audio` (per DID, since each DID may serve a different state)
- Or on `ingroups.recording_disclosure_audio` as fallback

Industry standard ([rev-recording-laws][rev-recording]; [sembly-recording][sembly-recording]) is "This call may be recorded for quality and training purposes" played at queue entry. The caller's continued presence on the call constitutes implied consent (in implied-consent states); in strict-consent states (CA, FL, IL, MD, MA, MT, NV, NH, PA, VT, WA) the disclosure must be explicit + caller must consent (silence/continuation generally suffices, but the disclosure itself is required).

### 14.4 TCPA does NOT apply to inbound

TCPA (47 CFR §64.1200) regulates outbound calls initiated by the caller (us). Inbound is the customer initiating, so:
- DNC rules don't apply (the consumer called us)
- 8am-9pm time-of-day rules don't apply
- 3% abandonment rule doesn't apply (the FCC abandonment rule targets predictive dialer dropouts; our queue dropouts are technically "abandoned" but legally distinct)

What DOES apply to inbound:
- State recording-consent laws (per §14.3)
- ADA / TTY (out of scope for Phase 3; document for Phase 4)
- Optional: TCPA "do not call this number" if a consumer requests it during the call → we should treat that as a `DNC` disposition (D04 system status)

### 14.5 Drop-rate metric

We track inbound queue abandonment (caller hangs up while waiting) separately from outbound drop (TCPA-relevant). Metric: `vici2_ingroup_abandon_pct{ingroup}`. Industry target: < 5% (no legal requirement).

---

## 15. Manager monitoring

### 15.1 S01 wallboard integration

S01 (live wallboard) reads:
- `t:{tid}:ingroup:{igid}:queue` → ZCARD = current depth
- `t:{tid}:ingroup:{igid}:queue_meta` → ewt, aht, ready_agents
- A standing event stream `events:vici2.ingroup.*` for live updates

I01 publishes: `vici2.ingroup.call_entered`, `vici2.ingroup.call_dispatched`, `vici2.ingroup.call_exited`, with payload `{ingroup_id, call_uuid, position, ewt_seconds, agent_user_id?, exit_reason?}`.

### 15.2 S02 eavesdrop into queued call

A supervisor can listen to a call mid-queue (rare, but possible). S02 eavesdrop applies to bridged calls (`eavesdrop:<uuid>`). For a parked queued call, eavesdropping plays only MOH — not useful. **Recommend: S02 only allows eavesdrop on bridged in-progress calls (post-dispatch); pre-dispatch queued calls are not eavesdroppable.** Document as a limitation.

### 15.3 Supervisor force-dispatch

Supervisor admin action: "dispatch this waiting call to agent X immediately" (override the routing algo). Implementation:
```
POST /api/sup/ingroup/{igid}/queue/{call_uuid}/dispatch?agent_user_id=42
```

The endpoint atomically removes from queue + dispatches. Audited in `queue_log.event='dispatch'` with `metadata.forced_by_supervisor=user_id`.

### 15.4 Supervisor kick from queue

```
POST /api/sup/ingroup/{igid}/queue/{call_uuid}/kick
```

Sends caller to overflow_action (default voicemail) or hangs up. Used for problematic callers (e.g., they screamed at receptionist twice already).

---

## 16. Failure modes matrix

| # | Failure | Detection | I01 action | Metric |
|---|---|---|---|---|
| 1 | Dispatcher process dies | Health check | Sibling pod picks up via `dispatch_lock` SET NX EX 5; new dispatcher reconciles state from MySQL on startup | `vici2_ingroup_dispatcher_recovered_total` |
| 2 | All agents PAUSE simultaneously | dispatcher loop sees ready_agents = 0 | Calls continue queueing; announce "longer than usual wait"; if max_wait hit → overflow | `vici2_ingroup_no_agents_seconds{igid}` |
| 3 | Caller hangs up mid-queue | ESL CHANNEL_HANGUP | ZREM, queue_log row, no further action | `vici2_ingroup_caller_abandon_total{igid}` |
| 4 | Queue depth > max_queue | enroll endpoint pre-check | New caller hits `entry_full_action` | `vici2_ingroup_full_block_total{igid}` |
| 5 | Skill admin removes a required skill from agent mid-call | M05 admin event | In-progress call unaffected; future queue dispatches re-evaluate | n/a |
| 6 | Agent on inbound call gets logged out (browser crash) | ESL conference DEL_MEMBER | Customer leg parked into "transfer offer"; if max_transfer_wait hit, hangup with apology; agent_log row | `vici2_ingroup_call_orphan_total` |
| 7 | Carrier sends INVITE for unknown DID | I02 routes to `default` xml drop | DID-not-found 404; logged | `vici2_did_unknown_total` |
| 8 | mod_xml_curl request to API times out (10s) | FS timeout | Dialplan continues with static fallback (drop) | `vici2_xml_curl_timeout_total` |
| 9 | Redis down | Dispatcher health probe | Pause dispatcher; new inbound DIDs get apology TTS + hangup; existing parked calls timeout to overflow | `vici2_redis_unavailable_seconds` |
| 10 | Agent reject preview > 3 times/hour | Counter in Redis | Auto-PAUSE with code REJECT_LIMIT | `vici2_agent_auto_pause_total{reason}` |
| 11 | Sticky agent in WRAPUP when sticky-call arrives | Dispatcher sees status=WRAPUP | If `sticky_wait_wrapup=true`, wait up to wrapup_seconds for transition to READY; else fall through to algo | `vici2_ingroup_sticky_wait_total` |
| 12 | Overflow loop (A → B → A → ...) | overflow_hops counter | Hard-stop at 3 hops, force hangup | `vici2_ingroup_overflow_loop_total` |
| 13 | Caller presses 1 for callback but lookupLead times out | 200ms deadline | Capture callback number, schedule callback, succeed | `vici2_callback_lookup_timeout_total` |
| 14 | callcenter dispatcher loop > 200ms | Wall-clock timer | Continue but log; metric | `vici2_ingroup_dispatch_slow_total` |
| 15 | Stale READY agent (status=READY in Redis but no heartbeat from browser >60s) | T01 conf-maint janitor | Agent flipped to OFFLINE; dispatcher re-picks | `vici2_agent_stale_total` |

---

## 17. Open questions for PLAN

1. **mod_callcenter vs custom Go queue.** §2 recommends custom Go queue. **PLAN must decide explicitly** and document as a deliberate refinement of I01.md (per F03 PLAN §1.3 pattern) if going custom. Risk: extra ~3,000 LOC. **Recommend: custom.**
2. **Default routing algorithm.** §5 recommends `skill-priority` with sticky disabled. Confirm.
3. **ring-all in Phase 3 or defer?** §5.1 recommends defer. Confirm.
4. **Sticky default window.** 24h vs 8h vs 1h? **Recommend 24h** (commonly used).
5. **EWT formula precision.** §7 recommends simple `pos × aht / agents`; Erlang-C deferred to Phase 4. Confirm.
6. **Announce-position minimum threshold.** §7.3 recommends `EWT > 60s`. Confirm; some operators prefer always-announce.
7. **Callback offer default.** Enabled or disabled by default per in-group? **Recommend disabled** (operator opts in) — preserve-position semantics + 96h callback queue introduce complexity that not every deployment wants.
8. **Priority caps.** §9.1 caps DID boost 600s + CRM 300s + total 900s. Confirm caps; operator override?
9. **Sticky-when-WRAPUP.** §11.1 row 11: should sticky route wait for the same agent's wrapup to finish? **Recommend yes, with max wait = `ingroup.wrapup_seconds`** then fall through.
10. **mod_xml_curl vs static templating for dialplan.** §13.5 recommends static. Confirm. (xml_curl is more dynamic but costs latency.)
11. **Preview modal duration.** §12.1 says 5s; agents may want shorter. **Recommend 3s default, configurable per-user (0 = auto-accept).**
12. **Recording disclosure DID vs ingroup.** Both columns or just one? **Recommend both, ingroup as fallback** if DID-level not set.
13. **Skill schema location.** New tables under F02 amendment migration or I01 migration? **Recommend I01 migration** (this is I01's owned data).
14. **Inbound DNC.** If caller types "DNC me" during the call (agent flags), the agent's disposition writes to internal DNC. But should an inbound caller's number be added to DNC automatically on certain dispositions? **Recommend no auto-DNC for inbound** (they initiated the call); admin can manually add via M06.

---

## 18. PLAN-phase deliverable checklist

When unblocked the PLAN must:

1. Pin the **mod_callcenter vs custom Go queue** decision (§2). If custom, document as deliberate refinement; if mod_callcenter, lay out the wrapper-bridge approach.
2. Lock the **schema amendments** (§3) into a Prisma migration spec — `ingroup_skills`, `agent_skills`, `queue_calls` (partitioned), `queue_log` (partitioned), and additive ALTERs to `did_numbers` + `ingroups`. Reversible up + down.
3. Pin the **skill match formula** (§4.2). Provide 10+ table-driven unit-test fixtures.
4. Pin the **default routing algorithm** (`skill-priority`) and the 5 supported algorithms for Phase 3 (skill-priority, longest-idle, round-robin, top-down, fewest-calls). Defer ring-all.
5. Pin the **sticky-agent** semantics (§5.2) — default OFF; window 24h; wait_seconds 0; wait_during_wrapup TRUE.
6. Pin the **Redis schema** (§3.6) and the `dispatch_inbound.v1.lua` script.
7. Pin the **EWT formula** (§7.1) and AHT EWMA alpha (0.1).
8. Pin the **dialplan extension naming** (§13.2: `ingroup_${id}`) — frozen for I02 to depend on.
9. Pin the **agent UX preview event** schema (§12.1) — frozen for A05/A03 to depend on.
10. Resolve the **14 open questions** in §17.
11. Specify the **dispatcher process lifecycle** (one goroutine per active in-group; supervisor pattern matching E02; multi-pod-safe via `dispatch_lock` SET NX EX 5).
12. Define **test fixtures**: 15 failure-mode tests from §16 + 10 skill-match table tests + 5 routing-algo correctness tests + 3 sticky-agent scenarios + 3 priority-boost scenarios + 1 multi-pod-failover test.
13. Specify the **gRPC / event contract** between the Go dispatcher and the Node API (dispatcher publishes ESL commands via T01; receives queue-enroll calls via a Redis Stream `events:vici2.ingroup.enrollment` published by the API on `POST /internal/queue/enroll`).
14. File **F02 amendments** for additive ALTERs (§3.3, §8.2) — additive, no RFC.
15. Document **HANDOFF.md** for I02/I03/I04/I05/S01/S02/A05/M-track owners with frozen interface points.

Blocking dependencies BEFORE PLAN can proceed:
- **F03 IMPLEMENT landed** — actual dialplan public/default file structure exists; mod_xml_curl loaded.
- **T01 PLAN landed** ✓ — ESL command primitives available.
- **T03 PLAN landed** ✓ — `TransferCustomer` + agent conference primitives frozen.
- **F02 PLAN landed** ✓ — `ingroups` + `ingroup_agents` exist; `did_numbers` exist.
- **F04 PLAN landed** ✓ — Redis key namespace conventions established.
- **D01 ready (interface)** — `lookupLeadByPhone` callable.
- **D04 status defs** — disposition handling for inbound (XFER, SALE, NA inbound, etc.).
- **D06 callback** — `schedulePriorityCallback` API.
- **E02 PLAN landed** (or in-flight) — agreed boundary on agent READY ZSET ownership.

NOT blocking (can run in parallel):
- I02 (DID routing) — I01 only freezes the inbound extension naming convention; I02 implements the DID lookup separately.
- I03 (IVR) — depends on I01 dialplan extension naming; can develop in parallel.
- I04 (blended) — only needs the agent picker interface from I01 + pacing read from E02.
- I05 (voicemail) — gets called via overflow `no_agent_action=voicemail`; I05 implements the recording side.

---

## 19. Citations

[modcc]: https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Modules/mod_callcenter_1049389/ — mod_callcenter authoritative docs: queues/agents/tiers schema, strategies, time-base-score, score-based dispatch, contact format, callcenter_config commands, limitations.
[fs-callcenter-config]: https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Configuration/Call-Center_7143525/ — official Call Center configuration overview.
[fs-mod-fifo]: https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Modules/mod_fifo_3966031/ — mod_fifo (simpler alternative; FIFO call distribution).
[issue-2529]: https://github.com/signalwire/freeswitch/issues/2529 — mod_callcenter zombie call to agent when member hangs up mid-originate (2024).
[issue-2458]: https://github.com/signalwire/freeswitch/issues/2458 — FreeSWITCH overload when using mod_callcenter at ~200 CCU / 20 CPS, calls stuck in DB.
[issue-2516]: https://github.com/signalwire/freeswitch/issues/2516 — mod_callcenter bug (2024).
[issue-1216]: https://github.com/signalwire/freeswitch/issues/1216 — top-down strategy stops if last agent unavailable.
[issue-889]: https://github.com/signalwire/freeswitch/issues/889 — mod_callcenter becomes unresponsive after >1 day idle.
[issue-1148]: https://github.com/signalwire/freeswitch/issues/1148 — unable to answer incoming call during announcements.
[issue-610]: https://github.com/signalwire/freeswitch/issues/610 — old configurations don't get removed on dynamic XML reload.
[issue-2633]: https://github.com/signalwire/freeswitch/issues/2633 — mod_callcenter audio/call-handling regression (2024).
[noccave]: https://www.thenoccave.com/2011/10/freeswitch-queues-with-mod_callcenter/ — third-party deep-dive into mod_callcenter with example XML.
[dopensource]: https://dopensource.com/2016/10/11/freeswitch-configuring-the-callcenter-module/ — third-party mod_callcenter configuration tutorial.
[fusionpbx-cc]: https://docs.fusionpbx.com/en/latest/applications/call_center.html — FusionPBX call-center UI built on top of mod_callcenter; pattern reference.
[fs-mc-conf]: https://github.com/signalwire/freeswitch/blob/master/src/mod/applications/mod_callcenter/conf/autoload_configs/callcenter.conf.xml — official `callcenter.conf.xml` example.
[fs-mc-src]: https://github.com/signalwire/freeswitch/blob/master/src/mod/applications/mod_callcenter/mod_callcenter.c — mod_callcenter source; strategy implementations.
[fs-outbound-conf]: https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Conference/Outbound-Conference-Calls_5046359/ — conference_set_auto_outcall (for ring-all-style outbound from conference).

### Vicidial in-groups references

[skills-rank]: http://www.vicihost.com/?page_id=157 — VICIhost Skills-Based Routing with Agent Ranking overview; rank=0-9 per in-group.
[skills-fwd]: https://www.vicidial.org/VICIDIALforum/viewtopic.php?f=5&t=41707 — vicidial.org forum: "Skills Based Routing" overview.
[vici-37537]: http://www.vicidial.org/VICIDIALforum/viewtopic.php?f=4&t=37537 — "inbound_group_rank routing question" forum thread; details on rank semantics.
[vici-5383]: http://www.vicidial.org/VICIDIALforum/viewtopic.php?t=5383 — Vicidial "Skills based routing" historical thread.
[xinix-rank]: https://xinix.co.uk/agent-ranking-skills-based-routing-vicidial/ — third-party guide to Vicidial agent ranking + SBR.
[vici-34132]: http://forum.eflo.net/VICIDIALforum/viewtopic.php?f=4&t=34132 — "Inbound Next Agent Call - inbound_group_rank" forum thread; algorithm tuning.
[vici-5187]: https://www.vicidial.org/VICIDIALforum/viewtopic.php?f=2&t=5187 — "INBOUND: call routing based on agents language" pattern.
[vici-10937]: http://vicidial.org/VICIDIALforum/viewtopic.php?t=10937 — "Inbound — Skill based or Intelligent routing?" forum discussion.
[vici-callback]: http://www.vicidial.org/docs/INBOUND_CALLBACK_QUEUE.txt — official Vicidial Inbound Callback Queue feature doc; PRESS_CALLBACK_QUEUE, preserve-position, expire-hours.
[vici-statuses]: https://github.com/inktel/Vicidial/blob/master/docs/VICIDIAL_statuses.txt — Vicidial system statuses list; inbound-specific statuses (XFER, QUEUE, etc.).
[vici-features]: https://www.vicidial.com/?page_id=5 — Vicidial features list including in-groups and skills routing.
[earezki]: https://earezki.com/ai-news/2026-03-25-why-your-vicidial-inbound-queue-loses-calls-and-how-to-fix-the-5-worst-settings/ — modern (2026-03) operator guide to Vicidial inbound queue defaults to avoid.
[vici-32282]: http://vicidial.org/VICIDIALforum/viewtopic.php?f=2&t=32282 — Inbound Group Queue Priority forum thread.
[vici-37131]: http://eflo.net/VICIDIALforum/viewtopic.php?f=4&t=37131 — Incoming queue priority vs AGENTDIRECT queue priority.
[vici-9830]: http://eflo.net/VICIDIALforum/viewtopic.php?t=9830 — "In-Group / Next agent call setting" thread.

### Modern call-center routing references

[genesys-sbr]: https://help.genesys.cloud/articles/acd-evaluation-routing-methods/ — Genesys Cloud routing evaluation methods (Best Available Skills, All Skills Matching, Disregard Skills Next Agent).
[genesys-sbr-overview]: https://www.genesys.com/definitions/what-is-skills-based-routing — Genesys "What is Skills-Based Routing" definitional reference.
[genesys-sbd]: https://help.genesys.cloud/articles/skills-based-dialing/ — Genesys Cloud Skills-Based Dialing.
[genesys-ewt]: https://docs.genesys.com/Glossary:Estimated_Wait_Time — Genesys EWT glossary.
[five9-sbr]: https://www.five9.com/faq/what-is-skills-based-routing — Five9 SBR FAQ.
[five9-ewt]: https://www.five9.com/faq/what-is-an-estimated-wait-time-ewt — Five9 EWT definition.
[amplix-genesys-skills]: https://amplix.com/insights/how-to-setup-intelligent-call-routing-with-genesys-cloud-skills/ — third-party Genesys Cloud skills routing setup tutorial.
[webex-routing]: https://help.webex.com/en-us/article/np2fdx/Understand-Routing-and-Queueing-in-Webex-Contact-Center — Webex Contact Center routing & queueing reference (priority 1-10 semantics).
[zendesk-icr]: https://www.zendesk.com/blog/intelligent-call-routing/ — Zendesk intelligent call routing best-practices guide.
[talkdesk-wait]: https://www.talkdesk.com/blog/what-is-call-center-average-wait-time-3-ways-reduce/ — Talkdesk average wait time guide.

### EWT formula references

[cxengage-ewt]: https://docs.cxengage.net/Help/Content/Reporting/Realtime/Estimated_Wait_Time.htm — CxEngage EWT reporting; pos × aht / agents formula.
[puzzel-ewt]: https://help.puzzel.com/knowledgebase/puzzel-contact-centre/puzzel-admin-portal/how-is-estimated-wait-time-calculated — Puzzel EWT calculation (waiting time + 15-min avg time to answer, rounded up to nearest minute).
[msdyn-ewt]: https://learn.microsoft.com/en-us/dynamics365/customer-service/administer/average-wait-time — Microsoft Dynamics 365 customer service avg wait time.
[ringcentral-pos]: https://support.ringcentral.com/article-v2/understanding-call-queue-positioning-and-wait-time-estimates.html — RingCentral queue position and wait time estimates.
[techtarget-erlangc]: https://www.techtarget.com/searchunifiedcommunications/definition/Erlang-C — Erlang C primer (for Phase 4 reference).
[cch-erlangc]: https://www.callcentrehelper.com/erlang-c-formula-example-121281.htm — Call Centre Helper Erlang-C worked example.
[babelforce-ewt]: https://www.babelforce.com/blog/explainer/what-is-expected-wait-time-ewt/ — EWT explainer.

### Sticky-agent / last-agent routing

[aws-last-agent]: https://aws.amazon.com/blogs/contact-center/last-agent-and-last-queue-routing-on-amazon-connect-for-returning-callers/ — AWS Amazon Connect last-agent routing pattern.
[callerdesk-sticky]: https://callerdesk.io/blog/sticky-agent-in-ivr/ — CallerDesk sticky-agent IVR explainer.
[acinfo-sticky]: https://www.acinfosoft.com/sticky-agent/ — Sticky Agent complete guide.
[tatatele-sticky]: https://www.tatatelebusiness.com/features/smartflo-sticky-agent/ — Sticky agent personalized routing feature page.

### Recording compliance

[rev-recording]: https://www.rev.com/blog/phone-call-recording-laws-state — Rev call recording laws by state (2026).
[sembly-recording]: https://www.sembly.ai/blog/call-recording-laws-one-party-vs-two-party-consent/ — Sembly AI 2026 call recording laws (one-party vs two-party consent).
[vonage-recording]: https://www.vonage.com/resources/articles/call-recording-disclosure/ — Vonage call recording disclosure guide.
[justcall-recording]: https://justcall.io/blog/customer-service-call-recording-laws-all-you-need-to-know.html — JustCall 2026 call recording laws by state.

### Local references

[design]: /root/vici2/DESIGN.md — §1.3 conference-per-agent SACRED primitive; §4 schema (ingroups + ingroup_agents already present); §5.1 Redis live state agent ZSETs; §7 agent UI; §9 compliance.
[spec]: /root/vici2/SPEC.md — §4.4 SACRED conference-per-agent primitive; §4.6 no hand-edited FS config in prod (template + reload).
[f02-schema]: /root/vici2/api/prisma/schema.prisma:920-1015 — F02 schema as landed: `did_numbers`, `ingroups`, `ingroup_agents`.
[f03-plan]: /root/vici2/spec/modules/F03/PLAN.md §4.5 (public dialplan slot 10-89), §8 (`mod_callcenter` deferred to I01), §14 (consumer interface freezes).
[t01-plan]: /root/vici2/spec/modules/T01/PLAN.md — ESL bridge: `Originate`, `UUIDTransfer`, `UUIDPark`, `UUIDKill`, `UUIDSetVar`, `ConferenceCommand` Go APIs.
[t03-plan]: /root/vici2/spec/modules/T03/PLAN.md §1/§4 (conference operator + `TransferCustomer`); §2.6 (Phase 3 may park customer to next-agent queue — that's I01).
[e02-research]: /root/vici2/spec/modules/E02/RESEARCH.md §1.7/§3/§4.1 (pacing reads agent READY ZSET; blended must atomically decrement).
[d04]: /root/vici2/spec/modules/D04.md — disposition definitions; inbound calls use same disposition flow.
[a05]: /root/vici2/spec/modules/A05.md — live call panel; inbound preview event consumed here.
[i02]: /root/vici2/spec/modules/I02.md — DID inbound routing; depends on I01 dialplan extension naming.
[i04]: /root/vici2/spec/modules/I04.md — closer/blended; consumes I01 dispatch primitives.
[i05]: /root/vici2/spec/modules/I05.md — voicemail; consumed as overflow target.

(Citation count: 54, well above the ≥ 12 typical floor.)

---

## STOP — Do not proceed to PLAN. Awaiting orchestrator review.

The single most important open question is **§17 #1 — mod_callcenter vs custom Go queue**. Until resolved the PLAN cannot start. This RESEARCH recommends **custom Go queue**; the I01.md module spec mandates **mod_callcenter**. The decision changes ~3,000 LOC of code and the operational footprint of FreeSWITCH module loading. Once resolved the remaining 13 open questions in §17 can be answered in PLAN within typical scope.
