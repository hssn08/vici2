# E04 — Picker (Lead → Originate Dispatcher + Agent/Lead Pairing) — RESEARCH

| Field | Value |
|---|---|
| Module | E04 (the "picker": pops leads, dispatches to T04, pairs answered calls to agents) |
| Phase | 2 (Phase-2 dialer engine; PROGRESSIVE/PREDICTIVE auto-dialing) |
| Owner agent type | backend-go |
| Status | RESEARCH (PLAN blocked on: (a) E02 PLAN to pin the E02↔E04 boundary on who pops the hopper, (b) E01 PLAN §1.3 freezes the `Consumer.Claim`/`Release` shape — DONE, (c) T04 PLAN §1.3 freezes `OriginateRequest.Mode=PREDICTIVE` PARK behaviour — DONE, (d) T03 PLAN §1.2 freezes `ConferenceFQN` helper — DONE, (e) D06 PLAN to pin the callback-fire trigger event — pending) |
| Date | 2026-05-13 |
| Module-spec source | `/root/vici2/spec/modules/E04.md` (3-screen skeleton — scoped E04 to "pick a READY agent on CHANNEL_ANSWER only". This RESEARCH **expands** the scope at orchestrator direction: E04 now owns lead-claim concurrency, originate dispatch to T04, retry-after-no-answer, callback firing, and agent/lead pairing for both PROGRESSIVE and PREDICTIVE. The E04.md spec is treated as a strict subset; this RESEARCH supersedes it where they collide and recommends a `MODULE_SPEC_UPDATE` patch be filed at PLAN time.) |
| Related plans read | E01 PLAN §1/§6/§8 (`Consumer.Claim`/`Release`/`ScheduleImmediate`, hopper ZSET shape, callback re-enqueue contract); E02 RESEARCH §1/§3/§7/§16 (pacing publishes "desired N" but the actual claim+dispatch loop is owned by **the picker** per the task brief — this RESEARCH formalises that the E02↔E04 split is "E02 says how many, E04 says who and how"); T04 PLAN §3.6/§4/§7 (5-gate pipeline, Mode→DialTarget table, one-UUID rule); T03 PLAN §1.2/§5 (`ConferenceFQN`, UUIDTransfer destination); F04 PLAN §4.1/§4.2/§4.6/§6.1/§6.4 (hopper ZSET, lead lock, agent ZSETs, `claim_lead_from_hopper.v1.lua`, `pick_agent_for_call.v1.lua`); C01 PLAN §2/§7 (TCPA Check at originate path); D04 RESEARCH §3/§7 (status taxonomy + `recycle_delay_seconds` per status); D06 module spec (callback worker fires; E04 receives `vici2.callback.due.*`); DESIGN.md §1.2/§5.2/§6.2 (dial modes, Redis live state, dialTick pseudocode); SPEC.md §4.2/§4.3/§7.4 (live state in Redis, dialer engine is the only originator, callback handling) |

---

## 1. Executive summary (10 bullets)

1. **E04 is the picker — the "who and how" of every outbound dial, distinct from E02's "how many".** Per the SPEC §4.3 "dialer engine is the only thing that originates", and per the task-brief redefinition of E04 (the original E04.md spec scoped this module to "agent-pick on answer" only — this RESEARCH expands and supersedes), E04 is the **synchronous driver loop** that (a) waits on E02's pacing budget signal, (b) pops the right lead off the per-campaign hopper ZSET via Lua, (c) pre-pairs an agent when the mode demands it (PROGRESSIVE/MANUAL), (d) hands the (lead, agent_or_PARK, attempt_uuid) tuple to **`T04.Originate`**, (e) for PREDICTIVE answers on PARK and subsequently picks an agent on `CHANNEL_ANSWER` then issues `T01.UUIDTransfer` into that agent's conference, (f) releases the E01 hopper claim on outcome, (g) fires due callbacks (D06 → priority hopper insert → claim → dispatch on next tick), and (h) emits retry telemetry. Surface size estimate: ~1100 LOC production + ~900 LOC test, two Go packages (`dialer/internal/picker` and `dialer/internal/picker/predictive`), and **no new Lua** (we reuse F04's `claim_lead_from_hopper.v1.lua` + `pick_agent_for_call.v1.lua`).

2. **The E02↔E04 split is `desired_count` → `claim+dispatch`, with E02 NEVER touching the hopper.** E02 RESEARCH §3.7 has E02's `for i := 0..desired { e01.Claim ...; t04.Originate }` loop inline in the pacing tick. The task brief reverses that: **E02 publishes the count, E04 owns the loop.** Rationale: (a) the loop is **stateful per-claim** (callback-priority pop, lead-claim TTL, T04 outcome→Release mapping, freq-cap INCR) and belongs with the picker, not the pacer; (b) PREDICTIVE-mode agent-pick-on-answer naturally lives in E04 — putting the dispatch loop there too lets the same module own *all* lead-and-agent pairing logic; (c) lets E02 stay a pure 10-µs decision function (testable + observable via the `pacing_desired_last_tick` STRING). The E02 RESEARCH explicitly notes (§16) "E04 is event-driven on FS CHANNEL_ANSWER; E02 has no direct interaction" — this RESEARCH closes that gap: **E02 writes a desired-count gauge, E04 reads it and claims that many leads.** Boundary table in §3.

3. **Two pairing models, one dispatch loop.** PROGRESSIVE/MANUAL/PREVIEW = **pre-pair** (E04 picks an agent FIRST from the campaign's READY ZSET, **reserves them** via `pick_agent_for_call.v1.lua`, then calls `T04.Originate(Mode=PROGRESSIVE, AgentID=X)`; T04 sets `execute_on_answer=transfer:agent_t<tid>_u<X>@default`; on customer answer FS bridges directly into that agent's conference). PREDICTIVE = **dial-then-pair** (E04 calls `T04.Originate(Mode=PREDICTIVE, AgentID=0)`; T04 sets `execute_on_answer=park`; FS parks the customer on answer; E04's stream consumer on `events:vici2.call.answered` reads the event, calls `pick_agent_for_call.v1.lua` for that campaign, issues `T01.UUIDTransfer(callUUID, "conference:agent_t<tid>_u<X>@default+flags{join-only}", ...)`, and on transfer-failure plays safe-harbor via E05). The pre-pair model has zero abandonment risk and is the recommended default for sub-10-agent campaigns; the dial-then-pair model exposes the FCC 3% abandon ceiling but doubles agent utilisation. Both share the same Originate-dispatch goroutine; only the `Mode` and the post-answer step differ. Full pairing matrix + race-condition analysis in §4.

4. **Lead-claim concurrency = three layers: ZSET pop is atomic, lock prevents double-dispatch, in_flight HASH gives janitor a tombstone.** Layer 1 = `claim_lead_from_hopper.v1.lua` (F04 PLAN §6.1) — single ZPOPMIN + SETNX of `t:{tid}:lead_lock:{cid}:{lid}` with 30 s TTL + HSET of `t:{tid}:campaign:{cid}:in_flight` (lead_id → instance_id:claim_ts); atomic in one EVALSHA, so two pickers across pods cannot pop the same lead. Layer 2 = the lock STRING with `EX 30` ensures even if E04 crashes between pop and T04 call the lock expires and E06 janitor re-queues the lead within ~30 s. Layer 3 = the in_flight HASH (which the script also HSETs) gives E06 + operators a queryable list of "who's holding what right now" — Vicidial-forum cite [4] documents Vicidial's lack of an equivalent visibility as a top operator pain point. We never trust the lock value to short-circuit anything; we trust **only the script return value**. Full Lua contract in §5.

5. **Filter chain pre-T04 is a thin "fast-fail" — most checks already ran at E01 hopper-fill time; E04 only catches state drift.** Per E01 PLAN §3.x the per-lead gate order (status, called_count, recycle_delay, freq-cap, DNC, TZ, TCPA, lead_filter) runs at filler time. By the time a lead is on the hopper ZSET it has been **fully cleared** for dial. However, between hopper-insert and pop, time can elapse: TCPA windows close, DNC entries get added, agents change status, the campaign drop-rate trips the gate. **T04's 5-gate pipeline (T04 PLAN §3) is the last-chance check**; E04 does NOT re-run gates — it just passes (lead, campaign, mode, agent_or_nil, attempt_uuid) to T04 and consumes T04's typed errors. E04 owns only **two cheap pre-T04 checks**: (a) "is the campaign still active?" (avoid dispatching for a campaign the admin just paused — process-cache hit ~50 ns), (b) "is the lead still in hopper-eligible state?" (skip — we'd waste a T04 audit row INSERT for a lead status that's already DROPPED/DNC; check via process-cache or a `HGET t:{tid}:lead:{lid} status` short-read). Detailed check list + budget in §6.

6. **Retry policy maps T04 outcomes + T01 hangup_cause to D04 status + `recycle_delay_seconds`.** When T04 returns `ErrCarrierFail` / `ErrGatewayLimit` / `ErrTCPABlocked` / `ErrDNCBlocked` / `ErrCircuitOpen` / `ErrRateLimited`, or when T01's BACKGROUND_JOB resolves with a hangup_cause (NO_ANSWER, USER_BUSY, NORMAL_TEMPORARY_FAILURE, …), E04 maps the outcome to a D04 status (see D04 RESEARCH §7's hangup-cause table) and calls `E01.Consumer.Release(claim, outcome)` with a re-queue hint. The hint sources `recycle_delay_seconds` from the status row (D04 RESEARCH §3.4 — `B=120`, `NA=300`, `N=600`, `CARRIER_FAIL=0`, `GATEWAY_LIMIT_TRY_LATER=0`, `TCPA=NULL` → use `tcpa.NextOpen()`, terminal=-1). E01 PLAN §7's release table already does the math; E04's job is just to pass the right outcome enum. **AMD policy is per-list config** (`lists.amd_action ENUM('drop','transfer','message','park')` per F02): E04 reads it post-T04 BRIDGED if the AMD detector flags a machine — drop is a hangup; transfer redirects to an in-group; message plays then hangs up; park (Phase 3 voicemail-drop). Outcome→action matrix in §7.

7. **Callbacks fire as priority hopper inserts, not direct dial.** D06 worker (per its module spec) every minute scans `callbacks WHERE status='PENDING' AND callback_at <= NOW()`. For **agent-only** callbacks, D06 emits `events:vici2.callback.due.agent` stream entry and surfaces a UI notification (A08); E04 does NOT auto-dial agent-only callbacks (the agent must click "Dial now" — an A04 MANUAL flow). For **anyone** callbacks, D06 calls `E01.Consumer.ScheduleImmediate(ctx, campaignID, leadID, priority=HIGH)` — which runs all gates (TCPA still applies!) and ZADDs into the hopper with a low score (high priority). Because E04 always pops the lowest-score lead first via `ZPOPMIN`, due callbacks naturally jump the queue without E04 needing a separate code path. The only E04-specific work for callbacks is: emit a metric `vici2_picker_callback_dispatched_total` so operators can attribute throughput. Detailed flow in §8.

8. **Tick model is event-driven for PREDICTIVE answer-handling, polling for the dispatch loop.** Two timing models cohabit in the E04 process: (a) **Dispatch loop** = polled at the rate E02 publishes (1 Hz outer + token-bucket sub-tick per E02 RESEARCH §6.2) — E04 reads `pacing_desired_last_tick` STRING (or, in the recommended PLAN posture, **E02 writes a `tokens_available` counter that E04 atomically DECRs as it dispatches** — cleaner contract than a static STRING; see §11). (b) **Answer handler** = subscribed to `events:vici2.call.answered` consumer group `picker-<podid>` via XREADGROUP BLOCK 5s; PREDICTIVE mode triggers `pick_agent_for_call.v1.lua` + `T01.UUIDTransfer` within ~10–30 ms of FS bridging the customer leg (well under the FCC 2 s safe-harbor floor). The two loops run in separate goroutines per campaign and communicate only via Valkey state — they never share Go memory. Detailed concurrency diagram in §9.

9. **One E04 process per dialer pod; one goroutine per active campaign per pod; multi-pod safety via per-claim atomicity (Lua) — no tick-lock needed.** Unlike E02 (which needs `t:{tid}:dialer:tick:{cid}` `SET NX EX 1` to ensure exactly-one-tick-per-second), E04 has **no leader-election requirement** because the Lua claim script makes each pop atomic across pods — two E04 goroutines on different pods popping the same hopper just get two different leads (first-come ZPOPMIN wins). This is a **major operational simplification** vs Vicidial which serializes per-campaign via `LOCK TABLES vicidial_hopper WRITE` (cite [1]). We sidestep the lock-contention pain. The token-bucket coordination is enforced by the shared `tokens_available` counter (DECR-after-claim, ATOMICITY VIA DECR NOT VIA LOCK — Valkey DECR is atomic and returns the new value; if returns < 0 we just released a token we shouldn't have, which is harmless if rare and we INCR-back immediately). Detailed multi-pod model in §10.

10. **Top 3 PLAN-phase open questions.** (i) **The pacing↔picker handoff shape — STRING gauge vs Stream vs DECR-counter?** Recommend the DECR counter: `t:{tid}:campaign:{cid}:dispatch_tokens` INT, E02 SETs each tick (`SET ... EX 2`, idempotent overwrite), E04 atomically DECRs per dispatch, refuses to claim when DECR returns ≤ 0 — exact CPS control without round-trip-per-dispatch. (ii) **PREDICTIVE answer-side latency budget vs FCC 2 s safe-harbor.** Recommend ≤ 250 ms total budget: 50 ms stream-event delivery + 100 ms agent-pick Lua + 100 ms `UUIDTransfer` ESL roundtrip = 250 ms p99; remaining 1750 ms is E05's safe-harbor playback budget. (iii) **Agent-pick strategy: longest_wait | random | fewest_calls | rank — which is default?** Recommend `longest_wait` (Vicidial default; cite [11]); the original E04.md spec lists all 4 — Phase 2 ships longest_wait only, others tracked in HANDOFF. Full 12 questions in §13.

---

## 2. Vicidial reference (`AST_VDauto_dial.pl` + `AST_VDhopper.pl`) — what to keep, what to ditch

Vicidial's predictive dialer collapses E02 + E04 (in our terminology) into one Perl daemon `AST_VDauto_dial.pl`. The hopper filler `AST_VDhopper.pl` is a separate process. Understanding the Vicidial collapse is essential because all operator mental-models come from there.

### 2.1 The Vicidial auto-dial loop (`AST_VDauto_dial.pl`, cite [1])

Pseudocode of the inner loop:

```perl
# Every 2.5 s per campaign-server:
@agents     = SELECT user FROM vicidial_live_agents
                WHERE campaign_id=? AND status='READY' AND server_ip=?;
$adlevel    = (campaign.dial_method == 'ADAPT_*'
                ? vicidial_campaign_stats.differential_calls / agents
                : campaign.auto_dial_level);
$goalcalls  = round($adlevel * scalar(@agents));
$active     = SELECT COUNT(*) FROM vicidial_auto_calls WHERE campaign_id=?;
$want       = $goalcalls - $active;

if ($want > 0) {
  @leads = SELECT lead_id, phone_number FROM vicidial_hopper
             WHERE campaign_id=? AND status='READY'
             ORDER BY priority DESC, hopper_id ASC LIMIT $want;
  for $lead (@leads) {
    UPDATE vicidial_hopper SET status='QUEUE' WHERE hopper_id=$lead->{id};
    INSERT vicidial_auto_calls (lead_id, status='LIVE', server_ip, ...);
    $cmd = "originate {SIPHeader=...,LeadId=$lid,...}sofia/gateway/$gw/$phone &park";
    asterisk_originate($cmd);  # via Manager Interface (AMI)
  }
}

# Separate loop: handle answered calls.
@parked = SELECT * FROM vicidial_auto_calls WHERE status='LIVE' AND parked='Y';
for $call (@parked) {
  $agent = pick_longest_wait_agent($call->{campaign_id});
  if (!$agent) { hangup_drop($call); next; }
  asterisk_originate("Local/$agent->{user}@vicidial-conf");  # rings the agent
}
```

The `vicidial_auto_calls` table is essentially Vicidial's equivalent of our **Valkey active_calls SET + originate_audit row**. The "originate-then-park-then-pick-agent" is exactly the PREDICTIVE flow. The MANUAL/PROGRESSIVE equivalent is `AST_VDadFILL.pl` (cite [2]) which originates direct to `Local/$agent`.

### 2.2 Lessons we keep (and why)

| Vicidial pattern | We keep | Why |
|---|---|---|
| Originate to PARK for PREDICTIVE, then pick agent | ✓ | Industry-standard FCC-compliant flow; matches T04 PLAN §4 Mode→DialTarget table |
| Originate direct to agent for PROGRESSIVE/MANUAL | ✓ | Zero-abandonment by design |
| Longest-waiting agent as default pick strategy | ✓ | Fair (avoids one agent getting all the work); matches `pick_agent_for_call.v1.lua` (F04 PLAN §6.4) |
| Per-status recycle_delay (Vicidial `vicidial_statuses.scheduled_callback`) | ✓ | D04 PLAN §3.4 already commits to per-status `recycle_delay_seconds` |
| Hopper priority ordering (Vicidial `hopper.priority` column) | ✓ | F04 PLAN §4.1 ZSET score = `(MAX_PRIO - priority) * 1e10 + entry_ts` |
| Drop calls (no agent within 2 s) to safe-harbor playback | ✓ | E05 owns this; E04's job is to detect "no agent" and emit the event |

### 2.3 Lessons we explicitly ditch

| Vicidial pattern | We reject | Why |
|---|---|---|
| `LOCK TABLES vicidial_hopper WRITE` per campaign | ✗ | Cited by Vicidial-forum [3] as the single largest scalability bottleneck. Atomic Lua ZPOPMIN solves it cleanly. |
| `vicidial_auto_calls` row mid-call | ✗ | We use Valkey active_calls SET + originate_audit row (forensic) + F04 `t:{tid}:call:{uuid}` HASH (state). MySQL writes per-originate is overkill. |
| Polling DB for "answered parked calls" every 100 ms | ✗ | We subscribe to `events:vici2.call.answered` stream — event-driven, ~5–50 ms latency. |
| `pickup_minimum` / `pickup_maximum` (window for agent answer) | ✗ | Phase 2 has fixed 2 s drop-window (FCC compliance). Tunable per-campaign in Phase 3. |
| Per-campaign-server `server_ip` partitioning | ✗ | We use multi-pod safety via Lua atomicity; no campaign-to-server affinity (X03 handles FS affinity at the FS level, transparent to E04). |
| Picker built into the auto-dial loop | partial | We **split** — agent-pick (PREDICTIVE) is its own goroutine consuming `events:vici2.call.answered`; the dispatch loop runs in parallel. Cleaner separation of concerns; ~30 % less code than Vicidial's monolith. |
| `LiveCallTimers` PHP process that hangs up unanswered calls | ✗ | T01 sets `originate_timeout=22` (channel var); FS hangs up via NORMAL_TEMPORARY_FAILURE or NO_USER_RESPONSE; T01's BACKGROUND_JOB callback then resolves with timeout outcome. Zero extra processes. |

### 2.4 The "list-mix" feature (Vicidial campaigns supporting multiple lists)

Vicidial's `AST_VDhopper.pl` can pull leads from N lists in proportions configured in `vicidial_campaigns.list_order_mix` (e.g., `30:50:20` across 3 lists). E01 PLAN §16 punts this to Phase 2 with `EVEN` as default and operator-tunable later. **E04 is list-agnostic** — by the time leads reach the hopper, list_id is just one of many lead columns; E04 pops in score order regardless. Document for HANDOFF that the list-mix logic is **entirely** an E01 filler concern.

### 2.5 GoAutoDial / VicidialNOW forks

GoAutoDial 4 (cite [4]) preserved the Vicidial auto-dial loop verbatim (Perl-to-Perl rewrite for the web UI changes; dialer is untouched). VicidialNOW (cite [5]) added multi-tenancy but kept the dial loop. **No useful schema-or-algorithm deltas to import.**

---

## 3. The E02↔E04 boundary (rewritten — this RESEARCH supersedes E02 RESEARCH §16)

The most important architectural decision in this module is the redrawing of the E02↔E04 boundary. E02 RESEARCH (a) inlined the `for i := 0..desired { e01.Claim ...; t04.Originate }` loop into E02's tick, and (b) declared "E04 is event-driven on FS CHANNEL_ANSWER; E02 has no direct interaction." The task brief reverses both. This section pins the new boundary.

### 3.1 Updated diagram

```
   ┌─────────────────────────────────────────────────────────┐
   │ MySQL: leads, dnc, callbacks, hopper_mirror, call_log  │
   └────────────────────────────┬────────────────────────────┘
                                 │ SELECT  (E01 filler)
                                 ▼
   ┌──────────────────────────────────────────────────────────┐
   │ E01 Filler  (cron 30 s + pubsub trigger)                 │
   │  - SQL → all gates → ZADD into hopper                    │
   └────────────────────────────┬─────────────────────────────┘
                                 │ ZADD
                                 ▼
   ┌──────────────────────────────────────────────────────────┐
   │ Valkey ZSET  t:{tid}:campaign:{cid}:hopper                │
   └────────────────────────────┬─────────────────────────────┘
                                 │ EVALSHA claim_lead_from_hopper
                                 │ (driven by E04, NOT E02)
                                 ▼
   ┌──────────────────────────────────────────────────────────┐
   │ E04 Picker dispatch loop  (this module)                  │
   │  - Reads  t:{tid}:campaign:{cid}:dispatch_tokens (DECR)  │
   │  - Lua claim → LeadClaim                                  │
   │  - For PROGRESSIVE/MANUAL: pre-pair via pick_agent…       │
   │  - For PREDICTIVE: AgentID=0                              │
   │  - Calls T04.Originate(req)                              │
   │  - Maps outcome → E01.Release(claim, outcome)            │
   └────────────────────────────┬─────────────────────────────┘
                                 │ T04 returns
                                 │ (sync for blocks; async via job for ALLOW)
                                 ▼
                              T04 / T01

   ┌──────────────────────────────────────────────────────────┐
   │ events:vici2.call.answered  STREAM   (T01 writes)        │
   └────────────────────────────┬─────────────────────────────┘
                                 │ XREADGROUP picker-<pod>
                                 ▼
   ┌──────────────────────────────────────────────────────────┐
   │ E04 Picker answer handler  (this module, separate goro)  │
   │  - Filter: only PARKED PREDICTIVE calls                  │
   │  - EVALSHA pick_agent_for_call.v1.lua                    │
   │  - T01.UUIDTransfer(callUUID, conf:agent_t<tid>_u<X>…)   │
   │  - On no-agent: emit drop event for E05 safe-harbor      │
   └──────────────────────────────────────────────────────────┘

   E02 Pacing  (parallel, no hopper interaction)
   ┌──────────────────────────────────────────────────────────┐
   │  - 1 Hz tick, decide_desired_new_originates(snapshot)    │
   │  - SET t:{tid}:campaign:{cid}:dispatch_tokens N EX 2     │
   │  - That's it.  Never claims, never dispatches.           │
   └──────────────────────────────────────────────────────────┘
```

### 3.2 Boundary responsibility table

| Concern | Owner | Mechanism |
|---|---|---|
| "How many lines should be in flight right now?" | **E02** | Read agent ZCARD + active SCARD + dial_level + clamps → write `dispatch_tokens` STRING |
| "Which lead do we dial next?" | **E04** | `ZPOPMIN` via Lua (sorted by priority + entry_ts) |
| "Which agent gets this lead?" (PROGRESSIVE) | **E04** | `pick_agent_for_call.v1.lua` BEFORE T04.Originate |
| "Which agent gets this answered call?" (PREDICTIVE) | **E04** | `pick_agent_for_call.v1.lua` AFTER answered-event |
| "Issue `bgapi originate`" | T01 | Via T04 (T04 is the policy wrapper) |
| "Run 5 compliance gates" | T04 | T04 PLAN §3 |
| "Release the hopper lock + write status" | **E04** | `E01.Consumer.Release(claim, outcome)` |
| "Increment freq-cap counter on BRIDGED" | **E04** | `INCR t:{tid}:freq:{phone}:{cid}` after T04 returns BRIDGED |
| "Fire due callbacks" | D06 worker | Calls `E01.Consumer.ScheduleImmediate` → hopper insert → E04 picks naturally |
| "Play safe-harbor on no-agent abandon" | E05 | Subscribes to `events:vici2.call.dropped` |
| "Adjust dial_level on drop%" | E03 | Independent — E04 unaffected |

### 3.3 Why this split is cleaner than E02 RESEARCH's original

Three concrete benefits:

1. **E02 becomes a pure decision function** — easier to test, easier to A/B (swap Vicidial math for Erlang A in a single file). The claim/dispatch side-effects move to E04, where they belong.
2. **PREDICTIVE answer-pick lives with PROGRESSIVE pre-pick** in one module — same Lua helper, same Go types, same metrics shape.
3. **The token-bucket CPS control is on Valkey, not in-process** — multi-pod natural fit: 3 pods × 5 CPS each is 15 CPS aggregate, controlled by one shared counter. E02 RESEARCH's in-process token bucket required tick-lock arbitration; this design doesn't.

### 3.4 Trade-off — slight extra Valkey op per dispatch

E02 RESEARCH's design had one Valkey op per dispatch (the Lua claim). The new design adds one DECR per dispatch (the `dispatch_tokens` decrement). That's +50 µs per dispatch — utterly negligible vs the ~50 ms T04 gate pipeline.

### 3.5 Hot-config reload

When `campaigns.dial_method` flips (admin changes via M02), E02's pacing goroutine reloads first (it reads campaigns row to derive `level`). E04's dispatch loop reloads on the same pubsub event (`t:{tid}:broadcast:campaign:{cid}:config_changed`). The race "E02 already set tokens for MANUAL, E04 still in PROGRESSIVE mode" is **harmless** — E04 will dispatch PROGRESSIVE (pre-pair) for ≤ 1 tick before reloading; the agent gets the call. Worst case: ≤ 1 second of stale mode behaviour per config change.

---

## 4. The two pairing models — pre-pair vs dial-then-pair

### 4.1 PROGRESSIVE / MANUAL / PREVIEW = pre-pair (agent picked BEFORE originate)

```
E04 dispatch tick:
  1. DECR dispatch_tokens → if ≤ 0, no-op
  2. EVALSHA pick_agent_for_call.v1.lua (campaign READY ZSET → RESERVED)
     → agent_id, or nil if no READY agent
  3. if nil: skip this dispatch (no agent → no point dialing)
     INCR dispatch_tokens back (return the token)
     INCR vici2_picker_no_ready_agent_total{campaign}
     return
  4. EVALSHA claim_lead_from_hopper.v1.lua → lead_id (or nil)
  5. if nil:
     - Release agent reservation (move them back to READY)
     - Publish refill_request to wake E01 filler
     - Return
  6. Build OriginateRequest{
       AttemptUUID: uuid.New(),
       Mode:        PROGRESSIVE,   // or MANUAL/PREVIEW based on campaign
       AgentID:     agent_id,
       LeadID:      lead_id, CampaignID, ListID, …,
       DestNumber:  lead.phone_e164,
     }
  7. result, err := T04.Originate(ctx, req)  -- sync; ~50 ms for ALLOW + INSERT
  8. Process outcome:
     - ALLOW + T01 success → release dispatched, E01.Release(BRIDGED outcome eventually via event stream)
     - ALLOW + T01 carrier-fail → release agent back to READY, E01.Release(CARRIER_FAIL)
     - any BLOCK → release agent back to READY (lead claim already auto-released by T04 release path)
```

**Wire form** (handed to T01 by T04): `execute_on_answer=transfer:agent_t<tid>_u<X>@default XML default` — on customer answer, FS atomically transfers the customer leg into the agent's conference, which already contains the agent. Bridging latency: ~5 ms post-answer.

**Zero abandonment risk:** the agent is *reserved* before the customer's phone rings; if the customer answers, the agent is guaranteed to be on the call. If the agent logs out between reservation and answer (rare — typical reservation→answer gap is 2–8 s), FS still bridges into the conference; the conference has no agent member; we fall back to safe-harbor (same code path as PREDICTIVE no-agent — E05 owns).

### 4.2 PREDICTIVE = dial-then-pair (agent picked AFTER customer answers)

```
E04 dispatch tick:
  1. DECR dispatch_tokens → if ≤ 0, no-op
  2. EVALSHA claim_lead_from_hopper.v1.lua → lead_id (or nil)
  3. Build OriginateRequest{
       AttemptUUID: uuid.New(),
       Mode:        PREDICTIVE,
       AgentID:     0,            // !!! no agent reserved
       LeadID:      lead_id, …,
       DestNumber:  lead.phone_e164,
     }
  4. result, err := T04.Originate(ctx, req)
  5. T04 hands to T01 with execute_on_answer=park
  6. T01 returns BACKGROUND_JOB ack; T04 audit row INSERTed; E04 returns; tick continues

E04 answer-handler goroutine (parallel):
  XREADGROUP GROUP picker-<podid> COUNT 10 BLOCK 5000 STREAMS events:vici2.call.answered >
  for each event where call.mode == PREDICTIVE:
    7. EVALSHA pick_agent_for_call.v1.lua → agent_id or nil
    8. if nil:
       - emit XADD events:vici2.call.dropped (E05 catches → plays safe-harbor)
       - bump vici2_picker_predictive_drop_total{campaign}
       - return (FS will hang up the customer leg after E05 finishes)
    9. err := T01.UUIDTransfer(callUUID,
                "conference:agent_t<tid>_u<agent_id>@default+flags{join-only}",
                "inline", "default")
   10. if err != nil:
       - release agent back to READY (transfer failed, agent never got the call)
       - emit drop event
       - return
   11. Track in t:{tid}:call:{uuid} HASH that agent=agent_id; success
```

**Wire form** (handed to T01 by T04): `execute_on_answer=park` — on customer answer, FS parks the customer (silence/MOH) and emits CHANNEL_ANSWER → T01 enrichment → events:vici2.call.answered. E04's stream consumer picks an agent and transfers.

**Abandonment risk:** non-zero — between answer and transfer, if no agent is available, the customer hears MOH for ≤ 2 s then E05 plays safe-harbor + hangup. The FCC 3 % rolling-30-day window caps this.

### 4.3 Race conditions enumerated

| # | Race | Frequency | Mitigation |
|---|------|-----------|------------|
| R1 | Two pickers (diff pods) pop same lead | Never | Atomic Lua ZPOPMIN |
| R2 | Two pickers (diff pods) reserve same agent (PROGRESSIVE pre-pair) | Never | Atomic Lua: pick_agent_for_call removes user from READY ZSET in one EVAL |
| R3 | Picker reserves agent for PROGRESSIVE, agent logs out before customer answers | ~0.1 % | FS bridges into empty conference; E05 safe-harbor; lead re-queued via E06 janitor catching `__USR-NOTFOUND-001` or similar |
| R4 | PREDICTIVE: customer answers but ALL agents went WRAPUP in the 4-sec ring window | <1 % at well-paced campaigns; rises with bad pacing | E04 answer-handler picks the longest-waiting available; if none → drop event → E05 plays safe-harbor |
| R5 | T04 returns ALLOW but BACKGROUND_JOB never resolves (FS crashed) | Rare | E06 janitor sweeps originate_audit `outcome='OTHER' AND originated_at < NOW()-5min` and marks `JOB_ORPHANED`; lead re-queued by E01 via D04 status |
| R6 | E04 dispatch crashes between claim and T04.Originate | Rare | Lead-lock TTL 30 s; E06 janitor reads `t:{tid}:campaign:{cid}:in_flight` HASH and finds orphaned claim → call `Release(re-queue immediate)` |
| R7 | E04 answer-handler crashes between pick_agent and UUIDTransfer | Rare | Agent stuck in RESERVED state; F04 agent-state janitor sweeps after 30 s and reverts to READY; customer leg eventually hits 30-s park timeout → hangup |
| R8 | Two E04 answer-handlers (diff pods) read same `events:vici2.call.answered` entry | Never | Consumer group + XACK; only one consumer in the group receives each entry |
| R9 | E04 process flips from PROGRESSIVE→PREDICTIVE config mid-tick after already reserving an agent | <0.1 % | Agent stays reserved through the originate; lead lands in agent's conf via PROGRESSIVE wire form; harmless |
| R10 | T04 gateway-cap fires AFTER E04 reserved agent (PROGRESSIVE) | Rare | E04 catches `ErrGatewayLimit` → release agent + release lead (re-queue immediate); INCR dispatch_tokens back so next dispatch can try a different gateway |

### 4.4 Decision matrix — which model when?

| Campaign profile | Recommended mode | Why |
|---|---|---|
| < 10 agents, sales | PROGRESSIVE | No abandonment risk; agent has full pre-answer prep time |
| 10–50 agents, sales | PREDICTIVE w/ ADAPT_TAPERED level | Higher agent utilisation; drop-rate adaptive engine keeps abandons < 1 % |
| 50+ agents, surveys | PREDICTIVE w/ ADAPT_AVERAGE | Max throughput; survey calls have shorter AHT (lower abandons even at high overdial) |
| Compliance-sensitive (collections, regulated industries) | PROGRESSIVE | Zero abandon exposure |
| Callbacks | PROGRESSIVE (forced for the callback dispatch even if campaign default is PREDICTIVE) | Callback agent assignment is intentional; we don't want to abandon a callback |
| Manual click-to-dial | MANUAL | Agent-initiated; same pre-pair wire as PROGRESSIVE |

A06 / M02 surface the dial_method picker with this guidance baked in.

---

## 5. Lead-claim concurrency — three layers

### 5.1 Layer 1 — atomic ZPOPMIN via Lua

We use F04 PLAN §6.1's `claim_lead_from_hopper.v1.lua`. Reproduced for E04 PLAN's reference:

```lua
-- KEYS[1] = hopper ZSET                 t:{tid}:campaign:{42}:hopper
-- KEYS[2] = lead_lock prefix            t:{tid}:lead_lock:{42}:
-- KEYS[3] = in-flight HASH              t:{tid}:campaign:{42}:in_flight
-- ARGV[1] = lock TTL seconds            "30"
-- ARGV[2] = dialer instance id          "e04-pod-42"
-- ARGV[3] = now_ms                      "1715623456789"
-- Returns: lead_id (string) or nil

local popped = redis.call('ZPOPMIN', KEYS[1], 1)
if #popped == 0 then return nil end
local lead_id = popped[1]
local lock_key = KEYS[2] .. lead_id
local lock_val = ARGV[2] .. ':' .. ARGV[3]
local ok = redis.call('SET', lock_key, lock_val, 'EX', tonumber(ARGV[1]), 'NX')
if not ok then
  redis.call('ZADD', KEYS[1], popped[2], lead_id)
  return nil
end
redis.call('HSET', KEYS[3], lead_id, lock_val)
return lead_id
```

This script gives us **three atomic effects** in one round-trip:
1. **ZPOPMIN** — pop lowest score (highest priority → next due).
2. **SET NX** lead-lock string with 30 s TTL — even if Go process crashes after this point, the lock auto-expires.
3. **HSET** in_flight tracking — gives janitor + operator a queryable view.

Total latency: ~150 µs Valkey-local, ~250 µs Valkey-remote. Atomic across pods.

### 5.2 Layer 2 — lock value as fence token

The `lock_val = instance_id:claim_ts_ms` is the **fence token**. E04 holds it through the T04 round-trip. On `E01.Consumer.Release(claim, outcome)`:

```lua
-- release_hopper_lock.v1.lua (F04 PLAN §6.2)
local current = redis.call('GET', KEYS[1])
if current and current ~= ARGV[4] then
  return 0    -- not our lock; do nothing
end
redis.call('DEL', KEYS[1])
redis.call('HDEL', KEYS[2], ARGV[1])
if ARGV[2] == '1' then
  redis.call('ZADD', KEYS[3], tonumber(ARGV[3]), ARGV[1])
end
return 1
```

The fence check (`current ~= ARGV[4]`) protects against the case: E04 claims lead L, lock TTL expires (E04 was stuck on a slow T04 call), E06 janitor sweeps + re-queues L, another E04 claims L → E04-A finally returns from T04 and tries to release → fence mismatch → no-op. The lead stays with the second claimant.

### 5.3 Layer 3 — in_flight HASH for observability + janitor

`t:{tid}:campaign:{cid}:in_flight` HASH `lead_id → instance_id:claim_ts` is what E06 janitor reads:

```go
// E06 sweep, every 60 s
inFlight := valkey.HGetAll(ctx, "t:1:campaign:{42}:in_flight")
for leadID, val := range inFlight {
  claim_ts := parseClaimTs(val)
  if time.Since(claim_ts) > 5 * time.Minute {
    // Orphaned. Re-queue via E01.Release with re-queue=true.
    // (E01's Release Lua will skip the fence check if we pass a magic "janitor" token.)
    e01.JanitorRelease(ctx, campaignID, leadID, ...)
    emitMetric("janitor_orphaned_claim_total", campaignID)
  }
}
```

This is the **only** janitor sweep needed for E04 — F04 PLAN's other janitor sweeps (agent state stale, call HASH stale) are owned by F04/E06.

### 5.4 Lock TTL sizing

| Phase | Default TTL | Rationale |
|---|---|---|
| Dispatch tick (E04 → T04 ALLOW) | 30 s | Covers: T04 5-gate pipeline (~10 ms) + T01 ESL roundtrip (~50 ms) + T01 BACKGROUND_JOB wait (up to 4 s ring) + safety margin |
| PREDICTIVE answer-handler (claim already released; agent reservation TTL) | 15 s | Agent RESERVED status TTL via `pick_agent_for_call.v1.lua` — short because the UUIDTransfer is ~10 ms |

Configurable per-campaign via `campaigns.lead_lock_ttl_seconds`; campaign-save validator (M02) enforces `>= dial_timeout_sec + 5`.

### 5.5 The "claim collision" pseudo-metric

We track `vici2_picker_claim_collision_total` — increments only when our Lua script returns nil due to layer-1 ZPOPMIN finding the lock already exists (the `if not ok then ZADD-back` path inside the script). This should be **effectively zero** in steady-state; a non-zero rate indicates a clock skew or a janitor bug. PAGE-severity alert.

---

## 6. Filter chain pre-T04 (the cheap "fast-fail" path)

E04 does NOT re-run compliance gates — that's T04's job. But E04 owns two **cheap checks** to avoid wasting a T04 audit-row INSERT.

### 6.1 Check 1 — campaign still active?

```go
// In E04 dispatch loop, after claim:
if !campaignCache.IsActive(campaignID) {
   // Operator paused the campaign between hopper insert and pop.
   e01.Release(claim, outcome=CAMPAIGN_PAUSED, requeue=delayed)
   emitMetric("dispatch_aborted_campaign_paused_total", campaignID)
   return
}
```

`campaignCache.IsActive` is a `sync.Map[campaignID]CampaignState` updated via pubsub `t:{tid}:broadcast:campaign:{cid}:config_changed`. Read: ~50 ns.

### 6.2 Check 2 — lead still hopper-eligible?

Optional but recommended. Race: E01 filler ZADDed lead L at 14:00:00 with status=NEW; agent dispositioned it as DNC via a different campaign at 14:00:03; E04 pops L at 14:00:05.

```go
status, _ := valkey.HGet(ctx, "t:1:lead:lid")
if !d04.IsDialEligible(status) {  // process-cached D04 status flags
   e01.Release(claim, outcome=LEAD_INELIGIBLE, requeue=false)
   return
}
```

Trade-off: adds one Valkey GET per dispatch (~50 µs). PLAN decision (§13 Q): **include the check** — 50 µs is cheap vs an orphan T04 audit row and a wasted FCC-counted originate.

### 6.3 What we explicitly DON'T check (T04's job)

- TCPA window (TCPA can flip in the seconds between hopper-fill and dispatch — T04 PLAN §3.3 last-chance gate)
- DNC (federal/state/internal — T04 PLAN §3.4)
- Gateway capacity (T04 PLAN §3.1)
- Drop-rate gate (T04 PLAN §3.2; Phase 2 enabled)
- Consent matrix (T04 PLAN §3.5)
- Frequency cap (filler-time only per E01 PLAN §3.5)

Re-running these in E04 would (a) duplicate logic, (b) widen our blast radius, (c) waste cycles on the hot path.

### 6.4 Budget per dispatch

| Step | Latency budget |
|---|---|
| DECR dispatch_tokens | 50 µs |
| Claim lead Lua | 250 µs |
| Campaign-active check | 50 ns |
| Lead-status check (optional) | 50 µs |
| Pick agent Lua (PROGRESSIVE only) | 200 µs |
| Build OriginateRequest | 5 µs |
| **Sub-total before T04** | **~600 µs** |
| T04.Originate (ALLOW path; gates + audit INSERT + T01 ack) | ~50 ms |
| Total per dispatch | ~51 ms |

At 5 CPS per campaign × 50 campaigns = 250 dispatches/s aggregate × 51 ms = 12.75 s/s = ~13 goroutines worth. Fits easily in one pod.

---

## 7. Retry policy — outcome → status → recycle_delay

### 7.1 Outcome taxonomy from T04 + T01

T04 PLAN §8 freezes the typed-error set. Add T01's hangup_cause vocabulary (resolved post-T04 via the BACKGROUND_JOB callback). E04 unifies these into a single `DialOutcome` enum:

```go
type DialOutcome int
const (
    OutcomeBridged DialOutcome = iota  // T01 BACKGROUND_JOB result + later CHANNEL_BRIDGE
    OutcomeNoAnswer                    // hangup_cause = NO_ANSWER / NO_USER_RESPONSE
    OutcomeBusy                        // hangup_cause = USER_BUSY / CALL_REJECTED
    OutcomeAMD                         // post-bridge AMD detector said machine
    OutcomeInvalidNumber               // UNALLOCATED_NUMBER / INVALID_NUMBER_FORMAT
    OutcomeCarrierFail                 // NETWORK_OUT_OF_ORDER / NORMAL_TEMPORARY_FAILURE / GATEWAY_DOWN / T04.ErrCarrierFail
    OutcomeGatewayLimit                // T04.ErrGatewayLimit
    OutcomeTCPABlocked                 // T04.ErrTCPABlocked
    OutcomeDNCBlocked                  // T04.ErrDNCBlocked
    OutcomeConsentBlocked              // T04.ErrConsentBlocked
    OutcomeCircuitOpen                 // T04.ErrCircuitOpen
    OutcomeRateLimited                 // T04.ErrRateLimited (drop-cap)
    OutcomeMediaTimeout                // MEDIA_TIMEOUT hangup
    OutcomeTimeout                     // RECOVERY_ON_TIMER_EXPIRE / originate_timeout fired
    OutcomeDropAbandon                 // PREDICTIVE answered but no agent
    OutcomeAgentDisconnect             // PREDICTIVE answered, agent picked, but agent's leg dropped before bridge
)
```

### 7.2 Outcome → D04 status → recycle_delay table

Built from T04 PLAN §3.x BLOCK reasons + D04 RESEARCH §5/§7 hangup-cause map + §3.4 default `recycle_delay_seconds`:

| DialOutcome | D04 status | `recycle_delay` source | Re-queue? | Notes |
|---|---|---|---|---|
| `Bridged` | `A` (system AMD) or terminal-agent-dispo | -1 (terminal) | No | Agent's dispo overrides; this is the post-T01-bridge state |
| `NoAnswer` | `NA` | 300 s default | Yes | configurable per status |
| `Busy` | `B-CAR` (system busy) | 180 s | Yes | |
| `AMD` | `A` (machine) | -1 if `lists.amd_action=drop`; recycle if `=transfer` | Conditional | Per-list policy |
| `InvalidNumber` | `INVALID` | -1 | No (terminal) | Vicidial-equivalent dead-number |
| `CarrierFail` | `CARRIER_FAIL` | 0 (immediate) | Yes, immediate | Pacing problem not lead problem; bumps retry attempt counter |
| `GatewayLimit` | `GATEWAY_LIMIT_TRY_LATER` | 0 | Yes, immediate | Try sibling gateway via T02 routing |
| `TCPABlocked` | `TCPA` | NULL → use C01's `nextOpen` (~9 AM local next day) | Yes, delayed | Pushed to E01's `delayed` ZSET |
| `DNCBlocked` | `DNC` | -1 | No | Permanently DNC-flagged |
| `ConsentBlocked` | `CONSENT_NOT_OBTAINED` | -1 | No | Reserved for future state-bans-recording-entirely |
| `CircuitOpen` | (no status change) | freeze 30 s | Yes after freeze | T01 circuit breaker for the FS pod |
| `RateLimited` | (no status change) | 300 s campaign-wide | Yes | drop-cap gate fired |
| `MediaTimeout` | `MEDIA_TO` | 300 s | Yes | RTP path broken |
| `Timeout` | `TIMEOT` | 900 s | Yes | originate_timeout (22 s default) hit |
| `DropAbandon` | `DROP` (counts vs 3% FCC) | 300 s | Yes | E05 also records for safe-harbor; counts in drop_window stream |
| `AgentDisconnect` | `ADC` (carrier disconnect) | 0 | Yes immediate | rare; usually agent's browser closed mid-bridge |

The mapping table lives in `dialer/internal/picker/retry_policy.go` as a const map, tested per row.

### 7.3 Per-status recycle_delay sourcing

E04 doesn't compute `recycle_delay_seconds`; it passes the D04 status code to `E01.Consumer.Release(claim, outcome)`. E01's release implementation (E01 PLAN §7) reads `statuses` row + `campaign_status_overrides` row + applies the merge precedence (D04 RESEARCH §6) to compute the actual delay. The delay becomes the score offset in the hopper ZADD on re-queue.

Why E04 doesn't compute the delay: keeps E04 stateless w.r.t. D04 schema; one place owns the merge logic; tests at E01 layer cover the merge.

### 7.4 Failure-counter and "lock out after N failures"

D04 RESEARCH §10 punts "lead-locked-out-after-N-failures" to T04 PLAN scope, which punted it to E01/D04 layer. **PLAN-phase decision needed:** does E04 increment a per-lead `failed_calls` counter? Recommend: **no** — `leads.called_count` (already in F02) is the authoritative counter; E01's filler-time check (`called_count <= dial_count_limit`) is the lock-out enforcement. E04's job is just to call Release with the right outcome.

### 7.5 AMD post-BRIDGED handling

When T04 returns BRIDGED + T01 raises `mod_avmd` AMD detection, E04's path:

```go
// Subscribe to events:vici2.call.amd_detected
for ev := range amdEvents {
    list := getListCache(ev.ListID)
    switch list.AmdAction {
    case "drop":
        t01.UUIDKill(ev.CallUUID, "NORMAL_CLEARING")
        e01.Release(claim, OutcomeAMD)
    case "transfer":
        t01.UUIDTransfer(ev.CallUUID, "ingroup:VOICEMAIL_TRANSFER_GROUP", ...)
    case "message":
        t01.UUIDBroadcast(ev.CallUUID, "play_and_hangup,/var/lib/vici2/audio/amd_msg.wav")
    case "park":
        // Phase 3 voicemail-drop
    }
}
```

AMD action is **per-list** (not per-campaign) per F02 — different lists may want different handling. E04 reads the action from a process-cached lists table.

---

## 8. Callback firing — D06 → E01 → E04 (naturally)

### 8.1 Flow

```
1. D06 worker (every 60 s):
   SELECT id, lead_id, campaign_id, agent_only, agent_user_id
     FROM callbacks
    WHERE status='PENDING' AND callback_at <= NOW();

2. For each row:
   a. UPDATE callbacks SET status='LIVE' WHERE id=?;
   b. if agent_only:
        emit events:vici2.callback.due.agent {callback_id, lead_id, agent_user_id}
        (UI delivers notification; agent clicks "Dial now" → A04 MANUAL flow; out of E04's scope)
      else (anyone callback):
        err := e01.ScheduleImmediate(ctx, campaign_id, lead_id, priority=HIGH)
        // E01.ScheduleImmediate runs all gates (TCPA still applies for callbacks!)
        // if pass: ZADD into hopper with high-priority score
        // if SKIP_UNTIL: pushed to delayed-set
        // if BLOCK: returns error → D06 marks callback ARCHIVE
        // D06 emits events:vici2.callback.dispatched on success

3. E04 picks the callback's lead on its next dispatch tick (naturally — score is lowest).
4. T04 sees the originate as normal — no special path; gates apply.
5. On BRIDGED: agent's screen pop shows the callback notes (D06 attaches as call context).
```

### 8.2 Why E04 has no callback-specific code path

The hopper is **already priority-ordered** (`(MAX_PRIO - priority) * 1e10 + entry_ts`). Callbacks come in with `priority=HIGH` (e.g., score-prefix `0`), which sorts before normal leads (`priority=0`, prefix `9`). `ZPOPMIN` naturally pops callbacks first. **Zero code in E04.**

Exception: a metric — `vici2_picker_callback_dispatched_total{campaign}` — is incremented by reading a flag on the claim payload (E01 populates `claim.IsCallback bool` from the lead's metadata or from the score range). Two lines of code in E04; everything else is generic.

### 8.3 Agent-only callbacks vs PROGRESSIVE/PREDICTIVE mode

The D06 spec says agent-only callbacks go directly to the named agent. **E04 does NOT pre-pair to that specific agent** in the standard dispatch loop — agent-only callbacks are out-of-band (manual dial flow). The reason: the agent might not be READY at the moment the callback fires; we can't reserve someone who's on a different call. A04's UI shows the agent "Callback ready for {customer name}, click to dial"; the agent's click triggers MANUAL mode through E04, which **then** does the pre-pair (with that specific agent — `OriginateRequest.AgentID = callback.AgentUserID`).

For **anyone** callbacks: the lead is just a high-priority hopper entry; whichever agent is READY at the moment it pops gets the call. (PROGRESSIVE mode reserves any READY agent; PREDICTIVE mode picks one post-answer.)

### 8.4 Failure modes

| Scenario | Behaviour |
|---|---|
| D06 fires callback, E01.ScheduleImmediate BLOCKs on TCPA | D06 marks callback `LIVE`, but lead doesn't reach hopper; callback `callback_at` should be updated to TCPA's `nextOpen`. D06's responsibility (we recommend a D06 retry queue) |
| D06 fires callback at 9 AM Monday for 1000 leads | Hopper ZSET grows by 1000 entries; E04 dispatches at CPS rate per campaign; takes ~3 minutes at 5 CPS — acceptable. D06 spec mentions "Callback overrun" as a known risk |
| Agent-only callback fires, target agent is logged out | A08 UI delivers notification to admin instead (per D06 spec); E04 unaffected |
| Anyone-callback lead's agent picks up but the original assigned agent (D06.agent_user_id was set!) is a different person | Anyone callback has agent_user_id NULL by definition (it's "anyone"). The screen pop should display callback metadata regardless of which agent gets it |

---

## 9. Tick model — dispatch loop + answer handler concurrency

### 9.1 Two goroutines per campaign per pod

```
┌──────────────────────────────────────────────────────────────┐
│ E04 process on dialer pod                                     │
│                                                                │
│   Supervisor (one goroutine; spawns/kills per-campaign goros) │
│   │                                                            │
│   ├─ Dispatch loop for campaign 42                            │
│   │     - reads campaign config (mode, list_ids, etc.)        │
│   │     - 100 ms ticker (sub-tick polling)                    │
│   │     - on tick: DECR dispatch_tokens; if > 0:              │
│   │       - claim lead → (pre-pair agent if PROG/MAN/PRE)     │
│   │       - T04.Originate                                     │
│   │       - process outcome → E01.Release                     │
│   │     - on tick: handle T04 async-resolved outcomes from    │
│   │       events:vici2.call.ended (post-dial-state outcomes)  │
│   │                                                            │
│   ├─ Answer handler for campaign 42                           │
│   │     - XREADGROUP picker-pod42 BLOCK 5000                  │
│   │     - on event (PREDICTIVE only):                         │
│   │       - pick_agent_for_call.v1.lua                        │
│   │       - T01.UUIDTransfer or emit drop event               │
│   │                                                            │
│   ├─ Dispatch loop for campaign 43                            │
│   ├─ Answer handler for campaign 43                           │
│   ├─ ...                                                       │
└──────────────────────────────────────────────────────────────┘
```

### 9.2 Dispatch-loop tick rate

E02 RESEARCH §6 pinned 1 Hz pacing tick + token-bucket burst-spread. E04 polls at a higher rate (100 ms) so it can spread the token consumption smoothly across each second. Per E04 tick:

1. DECR `dispatch_tokens` — atomic; if returns ≤ 0, we used our budget; sleep until next tick.
2. If returns > 0: proceed to claim + dispatch.

Caveat: each pod's E04 has its own 100 ms ticker; with 3 pods that's 30 polls/s per campaign. Aggregate Valkey DECR rate at 50 campaigns × 3 pods × 10/s = 1500 DECR/s — trivial.

### 9.3 Answer-handler XREADGROUP cadence

```
XREADGROUP GROUP picker-<podid> <consumer-id> COUNT 10 BLOCK 5000 STREAMS events:vici2.call.answered >
```

`BLOCK 5000` = wait up to 5 s for a new entry. Under load, returns immediately with one or more events. Under idle, polls every 5 s. Negligible idle cost.

Per-pod consumer ID lets multiple pods share the consumer group: each event delivered to exactly one pod. Failover: `XAUTOCLAIM` reclaims stuck PEL entries after 60 s (per F04 PLAN §5.3).

### 9.4 Per-campaign goroutine isolation

A slow T04 call in campaign 42 must not block campaign 43's dispatch. Each campaign goroutine has its own ticker + its own answer-handler XREADGROUP. The Valkey connection pool is per-pod (shared); no goroutine blocks others.

If T04 is slow for campaign 42 (say 5 s), the per-campaign loop just dispatches one less per tick — backpressure flows naturally through the DECR-then-dispatch protocol.

### 9.5 Event-driven sub-tick triggers

Three triggers can wake the dispatch loop out-of-band:

1. **`dispatch_tokens` SET event** (E02 just wrote new tokens). Subscribed via `t:{tid}:broadcast:campaign:{cid}:tokens_replenished` pubsub.
2. **`agent_state_changed` to READY** (a new agent un-paused). Triggers an immediate dispatch attempt — PROGRESSIVE can pair them right away.
3. **`refill_request` from E01 filler** completing (new leads available). Currently the E04 dispatch loop just polls and tries again; PLAN may add a pubsub wake to reduce idle latency.

All three are opportunistic; the 100 ms ticker is the steady-state backstop.

### 9.6 Hot-config reload

Same pattern as E02 (§3.5): subscribe to `t:{tid}:broadcast:campaign:{cid}:config_changed`, reload campaign config snapshot. Worst-case staleness: 100 ms (one tick).

Mode-change handling:
- MANUAL → PROGRESSIVE: dispatch loop starts working (was no-op for MANUAL — only A04 manual driver was originating).
- PROGRESSIVE → PREDICTIVE: skip agent-reservation step; subsequent dispatches use AgentID=0.
- ADAPT_* → MANUAL: dispatch loop returns 0 from tick (E02 already wrote tokens=0 effectively); no harm.

### 9.7 Dispatch deadline

A single dispatch attempt has a 200 ms wall-clock soft cap (matches E02's tick deadline) — if T04 hasn't returned in 200 ms, the goroutine moves on to the next tick. The T04 call doesn't get cancelled (the audit row is already INSERTed); it completes in the background. **Caveat:** if T04 returns OK, the dispatch_tokens was already consumed; if T04 returns an error after the 200 ms deadline, the next tick will not know to INCR-back. **PLAN decision needed:** how do we recover the token? Option (a) emit `events:vici2.dispatch.completed` on T04 return; the dispatch loop's goroutine listens and INCRs on error; option (b) accept some token leakage as ε (~0.1 % of dispatches at p99). Recommend (b) — leakage is bounded and noisy in metrics rather than silent.

---

## 10. Concurrency model (multi-pod, multi-campaign)

### 10.1 Topology

Same shape as E02 (one process per pod, per-campaign goroutines, supervisor pattern). Differences:

1. **No leader-election needed.** Lua atomicity on the hopper claim makes multi-pod safe by construction. Vicidial RECOMMENDS one auto-dial process per campaign per server (cite [1]); we go simpler.
2. **One answer-handler consumer per pod** (per campaign) — sharing the `picker-<podid>` consumer group. The stream library handles fanout to exactly one consumer per event.
3. **No tick-lock.** E02 had `t:{tid}:dialer:tick:{cid}` lock with TTL 1s. E04 doesn't. The DECR-tokens contract enforces aggregate CPS without a lock.

### 10.2 Sharding strategy

For Phase 2 (≤ 50 agents, ≤ 50 campaigns): **one pod is sufficient**. All campaign goroutines run on one E04 process; per-campaign Valkey ops total ~30/s. No sharding needed.

For Phase 4 (200+ agents, 200+ campaigns): **horizontal scale** by running 2–3 pods, no campaign affinity. The DECR-tokens contract spreads dispatch load evenly across pods (whichever pod ticks first gets the token).

Future option: **campaign-affinity sharding** — each pod owns a subset of campaigns (via consistent-hash on `cid % N`). Reduces XREADGROUP fanout. Defer to Phase 4; document in HANDOFF.

### 10.3 Pod failure handling

| Failure | Recovery |
|---|---|
| Pod crashes mid-dispatch (between claim and T04) | Lead-lock TTL (30s) fires → janitor re-queues |
| Pod crashes mid-answer-pick (between pick_agent and UUIDTransfer) | Agent stuck in RESERVED → F04 janitor reverts to READY after 30s; FS park-timeout (default 30s) hangs up customer; lead recycled |
| Pod crashes mid-XREADGROUP | XPENDING entry; sibling pod's `XAUTOCLAIM` reclaims after 60s |
| All pods crash | E01 hopper accumulates; on first pod restart, dispatch resumes; backlog drains in 1–2 ticks |
| Valkey unavailable | E04 dispatch loop sleeps with backoff; emits `valkey_unavailable_seconds`; no originates issued (correct safety) |
| T04 unavailable (process dead, gRPC fail) | E04 catches the error, releases the claim with re-queue (delayed), backs off |

### 10.4 Sudden agent logout mid-dispatch

PROGRESSIVE pre-pair race:
1. E04 reserves agent A via Lua (READY → RESERVED)
2. Agent A's browser closes (a02 sends LOGOUT)
3. F04 agent_state_transition Lua moves A to LOGOUT (RESERVED → LOGOUT)
4. E04 calls T04.Originate(AgentID=A)
5. T04 calls T01.Originate with `execute_on_answer=transfer:agent_t<tid>_u<A>@default`
6. Customer answers; FS tries to transfer to `agent_t<tid>_u<A>@default` conference
7. Conference has no members (A's SIP.js gone)
8. FS hangs up customer with `__USR-NOTFOUND-001` or media times out

Mitigation: E04 tracks reservation in a per-call HASH; if an `events:vici2.agent.state_changed{to=LOGOUT}` arrives for a reserved agent, E04 catches it and:
- If T04.Originate hasn't yet returned: cancel (best-effort)
- If already originated: cannot un-originate; E05 plays safe-harbor when customer answers an empty conference

Frequency: < 0.1 % expected. Acceptable abandon vector.

### 10.5 Scaling math

| Phase | Agents | Campaigns | E04 pods | Valkey ops/s | T04 calls/s |
|---|---|---|---|---|---|
| Phase 2 demo | 30 | 5 | 1 | ~150 | 25 |
| Phase 3 | 100 | 20 | 1 | ~600 | 100 |
| Phase 4 | 500 | 100 | 3 | ~5000 | 500 |

At 5000 Valkey ops/s, single Valkey node easily handles (100k+/s capacity). T04 is the bottleneck (5-gate pipeline at ~50 ms means ~20/s per goroutine; we'd need ~25 dispatch goroutines for 500/s). Spread across 3 pods with ~80 goroutines/pod is comfortable.

---

## 11. Inputs + outputs (Valkey schema)

### 11.1 Inputs (E04 reads)

| Key | Type | Used for | Owner (writer) |
|---|---|---|---|
| `t:{tid}:campaign:{cid}:hopper` | ZSET | Claim leads via ZPOPMIN | E01 (filler) |
| `t:{tid}:campaign:{cid}:dispatch_tokens` | STRING | DECR per dispatch; refuse if ≤ 0 | E02 (per-tick SET) |
| `t:{tid}:agents:by_campaign:{cid}:by_status:READY` | ZSET | `pick_agent_for_call.v1.lua` | A01 / agent state writer |
| `t:{tid}:agent:{uid}` | HASH | Read agent metadata during pick (status, last_change_at) | A01 |
| `t:{tid}:lead:{lid}` | HASH | Optional pre-T04 status check | D01 / D04 |
| `t:{tid}:campaign:{cid}:config_snapshot` | STRING (JSON) | Campaign mode, ramp config | M02 (hot-reload pubsub) |
| `events:vici2.call.answered` | STREAM | Answer handler subscribes via XREADGROUP | T01 |
| `events:vici2.call.amd_detected` | STREAM | AMD post-bridge action | T01 + AMD detector |
| `t:{tid}:broadcast:campaign:{cid}:config_changed` | PUBSUB | Hot-reload trigger | M02 |
| `t:{tid}:broadcast:campaign:{cid}:tokens_replenished` | PUBSUB | Wake dispatch loop early | E02 (optional) |

### 11.2 Outputs (E04 writes)

| Key | Type | Op | Purpose |
|---|---|---|---|
| `t:{tid}:lead_lock:{cid}:{lid}` | STRING | SET NX EX 30 (via Lua) | Claim lock |
| `t:{tid}:campaign:{cid}:in_flight` | HASH | HSET (via Lua) / HDEL (via Release) | Janitor visibility |
| `t:{tid}:campaign:{cid}:active_calls` | SET | SADD (via T01 — E04 indirect) | T01 maintains, not E04 |
| `t:{tid}:campaign:{cid}:dispatch_tokens` | STRING | DECR | Token consumption |
| `t:{tid}:agents:by_campaign:{cid}:by_status:READY` | ZSET | ZREM (via pick_agent Lua) | Agent reservation |
| `t:{tid}:agents:by_campaign:{cid}:by_status:RESERVED` | ZSET | ZADD (via pick_agent Lua) | Reserved tracking |
| `t:{tid}:freq:{phone}:{cid}` | STRING | INCR + EXPIRE on BRIDGED | Frequency cap counter |
| `events:vici2.call.dropped` | STREAM | XADD when PREDICTIVE no-agent | E05 consumes for safe-harbor |
| `events:vici2.picker.dispatched` | STREAM | XADD per successful dispatch | O01 audit |
| `t:{tid}:campaign:{cid}:picker_metrics` | HASH | HINCRBY per outcome | Live operator view |

### 11.3 The `dispatch_tokens` STRING (E02→E04 contract)

```
SET t:{tid}:campaign:{cid}:dispatch_tokens <n> EX 2
```

E02 sets this each tick with the value = `desired_new_originates` (after clamps). TTL=2s means if E02 dies, no dispatches happen (correct safety — the alternative of stale-token-on-disk could over-dial).

E04 reads via:

```
DECR t:{tid}:campaign:{cid}:dispatch_tokens
```

DECR is atomic; returns the new value. If new value < 0, we over-decremented (raced with another pod or with the TTL flip); INCR it back and skip this tick:

```go
newVal := valkey.Decr(ctx, key)
if newVal < 0 {
    valkey.Incr(ctx, key)   // restore
    return  // wait for next tick
}
// Proceed with dispatch (we hold a token)
```

Atomicity: DECR returns the new value atomically, so if two pods DECR simultaneously, each sees its own decrement. Aggregate decrements equal aggregate dispatches.

Optional refinement (Phase 3): script the DECR with a >= 0 check + Lua atomic guard. Phase 2 keeps it simple.

### 11.4 What we deliberately don't write

- No `t:{tid}:picker:audit:{cid}` stream — T04's `originate_audit` MySQL row is the forensic record; we don't duplicate.
- No per-lead "retry attempt counter" — `leads.called_count` is authoritative; E01 updates it via Release.
- No "drop count per campaign" — E05's `drop_window` stream is authoritative; we just XADD to `events:vici2.call.dropped` and E05 records.

---

## 12. Metrics + observability (Prometheus + logs)

### 12.1 Counter / gauge / histogram set

| Metric | Type | Labels | Purpose |
|---|---|---|---|
| `vici2_picker_dispatch_total` | counter | `{tenant, campaign, mode, outcome}` | dispatches by outcome (BRIDGED, NO_ANSWER, …) |
| `vici2_picker_claim_total` | counter | `{tenant, campaign, result}` | result = `success|empty_hopper|lead_lock_collision` |
| `vici2_picker_no_ready_agent_total` | counter | `{tenant, campaign, mode}` | PROGRESSIVE skipped tick because no READY agent |
| `vici2_picker_pick_latency_seconds` | histogram | `{tenant, campaign, mode, phase}` | phase = `claim|pick_agent|t04|total`; buckets 0.001/0.01/0.1/1 |
| `vici2_picker_retry_total` | counter | `{tenant, campaign, outcome, recycled}` | recycled = `true|false` |
| `vici2_picker_callback_dispatched_total` | counter | `{tenant, campaign}` | callbacks fired via E04 |
| `vici2_picker_predictive_answered_total` | counter | `{tenant, campaign}` | PREDICTIVE customer answers (entry to answer-handler) |
| `vici2_picker_predictive_drop_total` | counter | `{tenant, campaign, reason}` | reason = `no_agent|agent_transfer_failed|agent_logged_out` |
| `vici2_picker_amd_action_total` | counter | `{tenant, campaign, list, action}` | AMD detected → action taken |
| `vici2_picker_tokens_decr_total` | counter | `{tenant, campaign, result}` | result = `consumed|over_decremented_restored` |
| `vici2_picker_orphaned_claim_total` | counter | `{tenant, campaign}` | janitor reaped this many |
| `vici2_picker_active_inflight` | gauge | `{tenant, campaign}` | HLEN of in_flight HASH; per-campaign live count |

### 12.2 Alert recipes (to O01)

- `vici2_picker_claim_total{result=lead_lock_collision}` rate > 0 sustained → **page** (clock skew or janitor bug)
- `vici2_picker_predictive_drop_total{reason=no_agent}` rate > 1/s sustained → **warn** (pacing too aggressive; E03 should be auto-correcting; if not, page)
- `vici2_picker_no_ready_agent_total` rate > 5/s sustained → **info** (campaign mismatched to staffing; M02 admin alert)
- `vici2_picker_orphaned_claim_total` rate > 0 ongoing → **warn** (E04 pods crashing or T04 wedging; investigate)
- `vici2_picker_pick_latency_seconds{phase=total}` p99 > 200ms sustained → **warn** (T04 slow; check carrier health)

### 12.3 Per-dispatch log line (structured)

```
{
  "ts": "2026-05-13T19:23:45.123Z",
  "level": "info",
  "msg": "picker_dispatch",
  "tenant_id": 1,
  "campaign_id": "SOLAR_Q2",
  "mode": "PREDICTIVE",
  "attempt_uuid": "9e5d…",
  "lead_id": 1234567,
  "phone_e164": "+14155551111",
  "agent_id": 42,    // 0 for PREDICTIVE pre-answer
  "claim_latency_ms": 0.31,
  "pick_agent_latency_ms": 0.0,  // 0 if PREDICTIVE
  "t04_latency_ms": 48.2,
  "outcome": "BRIDGED",
  "is_callback": false
}
```

Sampling: 100 % at debug, 1 % at info under load (configurable via campaign).

### 12.4 OpenTelemetry tracing

Each dispatch is a trace span: `picker.dispatch` with children `claim`, `pick_agent` (optional), `t04.originate`. Propagated via `attempt_uuid` as the W3C TraceContext key. The originate_audit row stores the trace_id so operator can jump from the row to the trace in Jaeger.

### 12.5 What's missing for "100 agents × 10k leads" testing

§14 covers the test plan. Metrics-wise: histograms on hopper-pop rate and answer-handler latency are sufficient. We don't need a special "load test" metric set.

---

## 13. Open questions for PLAN (top 12)

1. **Tokens contract shape — STRING DECR vs Stream vs gRPC?** Recommend **STRING DECR** with `SET ... EX 2` per E02 tick. Cheap (50 µs/dispatch), correct under multi-pod, no extra Lua. Alternative: Stream where E02 XADDs N tokens and E04 XREADGROUPs them — more event-shaped but adds 2× latency. PLAN should pin DECR.

2. **Pre-T04 lead-status double-check — yes/no?** Recommend **yes** (one extra Valkey GET per dispatch = ~50 µs); avoids T04-audit-row INSERT for a lead that became DNC seconds ago. The 50 µs cost is invisible vs the 50 ms T04 pipeline.

3. **AgentID for PROGRESSIVE: reserve BEFORE claim or AFTER claim?** Recommend **agent BEFORE lead** — if no READY agent, don't waste a lead-claim. The cost is: if no leads in hopper but agents READY, we briefly reserve+release the agent (~1 ms gap). Vs the reverse order: if no agents READY but leads available, we'd uselessly claim a lead (~30 s lock TTL wasted). Agent-first is cheaper to undo.

4. **Pick strategy default — `longest_wait` | `random` | `fewest_calls` | `rank`?** Recommend **`longest_wait`** (Vicidial default; fair across agents; F04's `pick_agent_for_call.v1.lua` already implements via ZRANGE 0 0). Other strategies ship as Phase 3+ enhancements.

5. **PREDICTIVE answer-handler: separate gRPC service or in-process?** Recommend **in-process** (same E04 binary, separate goroutine per campaign). Cross-process adds ~1 ms gRPC + serialization overhead per pick that we can't afford under the 2 s safe-harbor budget. The cost: harder to scale answer-handler independently. Phase 2 acceptable.

6. **Should E04 expose a gRPC service?** Recommend **no** — E02 SETs tokens, D06 calls E01.ScheduleImmediate, A04 calls T04 directly for MANUAL. E04 is purely internal. Inverse of T04 which IS gRPC-exposed for A04 cross-process.

7. **`pick_agent_for_call.v1.lua` already handles READY→RESERVED transition; do we need a separate RESERVE→INCALL hop?** Recommend **yes** — separate Lua for RESERVED→INCALL fired when T01 confirms CHANNEL_ANSWER. The intermediate RESERVED state lets supervisors see "this agent is paired but not yet talking" — useful UX.

8. **Token leakage on dispatch-deadline timeout (§9.7) — accept or recover?** Recommend **accept** with metric `vici2_picker_token_leaked_total` so we can monitor. Recovery code is complex (must wait for T04's true return, INCR-back, possibly retry — race-prone).

9. **Agent-only callback dispatch — does E04 ever do it automatically?** Recommend **never** — D06 spec says agent-only callbacks surface as UI notification; agent clicks "Dial" → A04 MANUAL → E04 dispatches with the specific agent. Automatic dial without agent click would surprise the agent. Document for HANDOFF.

10. **AMD `lists.amd_action` per-list vs per-campaign?** F02 already pins **per-list**. PLAN should confirm + document. Phase 3 can add per-campaign fallback.

11. **Drop event handoff to E05 — XADD vs PUBSUB?** Recommend **XADD to events:vici2.call.dropped** (durable; ordered; consumer-group). PUBSUB is fire-and-forget and would lose drops on E05 restart — drops are FCC-counted, can't lose.

12. **Multi-list "weighted pop"?** Vicidial's `list_order_mix` lets one campaign blend leads from N lists in proportions. E01 PLAN punts this to Phase 2 with EVEN as default. **E04 is intentionally list-blind** — pops happen by score; list_id is just metadata. Confirm in PLAN that E04 makes no list-aware decisions.

### Other questions resolved by analysis (not blocking)

| Q | Resolution |
|---|---|
| Does E04 know about gateway-id at dispatch time? | No — T04 picks gateway from carrier pool. E04 just sets `CarrierID=0` and lets T02 pick. |
| Does E04 know about list-id? | Yes — passed through to T04 for caller-ID waterfall (lists.caller_id_override). |
| Does E04 use D03 TZ? | No — TZ resolution is C01's job at filler-time and T04's last-chance gate. |
| Does E04 set `originate_timeout`? | No — T01 sets it from `campaigns.dial_timeout_sec`. E04 just passes campaign id. |
| Does E04 set `recording_mode`? | No — T04's consent gate decides; channel vars set by T04. |

---

## 14. Test plan — 100 agents × 10k leads simulation

### 14.1 Unit test scope (per package)

- `dispatch_loop_test.go` — table-driven: 24 (mode × outcome) tuples; mock T04, mock E01. Asserts: correct OriginateRequest built, correct Release call after outcome.
- `retry_policy_test.go` — table-driven over the §7.2 status table. Asserts: outcome enum → D04 status + recycle hint.
- `answer_handler_test.go` — mock pick_agent_for_call, mock T01.UUIDTransfer; assert: success-path transfer issued, no-agent path emits drop event.
- `concurrency_test.go` — 100 goroutines × 100 dispatches against a mocked Valkey; assert: no double-claim, no token-over-consumption.
- `pre_t04_check_test.go` — campaign-paused / lead-status-ineligible / lead-status-eligible.

Total ~600 LOC unit tests, target coverage > 85 %.

### 14.2 Integration test — testcontainers

```
docker-compose (test): valkey + mysql + mock-T04 (gRPC stub returning canned responses)
```

Scenarios:

1. **Smoke** — 10 leads in hopper, 5 agents READY, PROGRESSIVE mode → all 10 dispatched, agents paired, BRIDGED outcomes recorded.
2. **PREDICTIVE answer-flow** — 5 leads, 0 agents, all park-and-drop → 5 entries in events:vici2.call.dropped, 0 entries in events:vici2.call.bridged.
3. **PREDICTIVE happy-path** — 5 leads, 5 agents — simulate FS answer events post-T04, agent-pick fires, UUIDTransfer recorded.
4. **Retry on NO_ANSWER** — lead gets NO_ANSWER outcome → lead re-added to hopper (delayed by `recycle_delay`), called again on second tick.
5. **TCPA block** — T04 returns ErrTCPABlocked → lead released to delayed-set, not re-tried within window.
6. **Pod crash recovery** — kill E04 mid-dispatch, restart, E06 janitor reaps orphan, lead re-enters hopper.
7. **Token over-consumption** — 2 simulated pods each ticking 100ms; assert aggregate dispatches ≤ E02-set token count over 10 s.

### 14.3 Load test — 100 agents × 10k leads simulation

Scenario:
- 1 campaign, PREDICTIVE mode, dial_level=2.0, drop_target=2%
- 100 agents in READY state (simulated; cycling through INCALL → WRAPUP → READY)
- 10,000 leads in MySQL → E01 fills hopper to ~3000 entries
- Mock T04 returns: 60% BRIDGED, 20% NO_ANSWER, 10% BUSY, 5% INVALID, 5% CARRIER_FAIL
- Mock FS event stream emits CHANNEL_ANSWER for 60% of dispatches (matching the BRIDGED proportion)

Run for 10 minutes (~6000 dispatches at 10 CPS).

Assertions:
- Aggregate dispatch CPS = E02-published token rate ± 5%
- Drop rate < 3% (FCC ceiling)
- No double-dispatch (zero duplicate originate_audit rows by attempt_uuid)
- p99 pick_latency < 250 ms (claim + pick + T04)
- p99 answer-handler latency (XREADGROUP-to-UUIDTransfer) < 250 ms
- Zero orphaned claims after run (janitor sweeps cleared)
- Hopper depletes; refill events fire; E01 stays caught up

### 14.4 Chaos tests

- Kill Valkey for 5 s mid-run; assert E04 sleeps, no originates issued, recovers cleanly.
- Kill T04 for 10 s; assert E04 catches errors, releases claims, retries.
- Kill one of 3 E04 pods mid-run; assert no work lost.
- Inject 100 simultaneous agent un-pause events; assert no dispatch storm (ramp_up_clamp on E02 side; E04 just sees a normal token rate).

### 14.5 Performance baseline

| Metric | Target |
|---|---|
| Dispatch p50 | < 50 ms |
| Dispatch p99 | < 250 ms |
| Answer-handler p99 | < 250 ms |
| Goroutine count under steady-state (50 campaigns) | ≤ 200 |
| Valkey ops/s per E04 pod | ≤ 5000 |
| Memory per E04 pod | < 200 MB |

Established in CI via `go test -bench` for hot paths.

---

## 15. Failure modes matrix (16 rows)

Built on E02 RESEARCH §10 (16 rows), specialised for E04:

| # | Failure | Detection | E04 action | Metric | Severity |
|---|---|---|---|---|---|
| 1 | `dispatch_tokens` STRING missing / expired (E02 not running) | DECR returns nil | No-op; do not originate without budget | `tokens_missing_total` | Page if persistent |
| 2 | Token over-decrement (race) | DECR returns < 0 | INCR-back; skip tick | `tokens_over_decremented_restored_total` | Info |
| 3 | Hopper empty | Lua claim returns nil | Publish refill_request; release agent if PROGRESSIVE; skip | `claim_total{result=empty_hopper}` | Info |
| 4 | Lead-lock collision (Lua falls into ZADD-back) | Lua returns nil after pop-then-collision | Skip | `claim_total{result=lead_lock_collision}` | Page if non-zero ongoing |
| 5 | No READY agent (PROGRESSIVE) | pick_agent Lua returns nil | Skip dispatch; INCR token back | `no_ready_agent_total` | Info — staffing issue |
| 6 | T04 returns ErrTCPABlocked | gRPC error type | Release agent (PROGRESSIVE) + Release claim with TZ-delayed recycle | n/a (T04 counts) | Info |
| 7 | T04 returns ErrDNCBlocked | gRPC error type | Release agent + Release claim terminal | n/a | Info |
| 8 | T04 returns ErrGatewayLimit | gRPC error type | Release agent + Release claim with re-queue immediate | `dispatch_total{outcome=gateway_limit}` | Warn — capacity |
| 9 | T04 returns ErrCircuitOpen | gRPC error type | Freeze campaign 30 s; release agent + Release claim with re-queue delayed | `circuit_open_total` | Page if persistent |
| 10 | T01 BACKGROUND_JOB doesn't resolve (FS crashed) | T04 reports OTHER after 60 s timeout | E06 sweeps the originate_audit row → JOB_ORPHANED; lead re-queues via D04 | `orphaned_claim_total` | Warn |
| 11 | Agent logout mid-pre-pair race | events:vici2.agent.state_changed | Best-effort cancel; if can't, accept abandon via E05 | `pre_pair_lost_agent_total` | Info |
| 12 | PREDICTIVE answer with no available agent | pick_agent_for_call.v1.lua returns nil | XADD drop event; E05 plays safe-harbor; lead recycle | `predictive_drop_total{reason=no_agent}` | Warn |
| 13 | UUIDTransfer fails (agent leg dropped) | T01.UUIDTransfer returns error | Release agent back to READY; emit drop event; lead recycle | `predictive_drop_total{reason=agent_transfer_failed}` | Warn |
| 14 | E04 pod crashes mid-dispatch | Lead-lock TTL fires + in_flight HASH lingers | E06 janitor cleans up after 5 min | `orphaned_claim_total` | Info — expected |
| 15 | E04 answer-handler crashes mid-pick | XPENDING accumulates | XAUTOCLAIM on sibling pod reclaims | n/a (consumer group recovery metric) | Info |
| 16 | Sustained Valkey unavailable | F04 helper error | Sleep with exp-backoff; never originate blind | `valkey_unavailable_seconds` | Page |

---

## 16. File layout (proposal — PLAN to confirm)

```
dialer/cmd/dialer/                          -- already exists (T01 + E02 share pod)
  main.go                                   -- spawn E04 supervisor on startup

dialer/internal/picker/
  supervisor.go                             -- per-campaign goroutine spawn/kill
  dispatch_loop.go                          -- per-campaign 100 ms tick loop
  predictive_answer_handler.go              -- XREADGROUP consumer for events:vici2.call.answered
  claim.go                                  -- wraps F04 claim_lead_from_hopper.v1.lua
  pair.go                                   -- wraps F04 pick_agent_for_call.v1.lua
  retry_policy.go                           -- outcome → D04 status mapping (§7.2 table)
  pre_t04_checks.go                         -- campaign-active + lead-status-eligible
  amd_action.go                             -- AMD post-bridge action dispatcher
  tokens.go                                 -- DECR/INCR helpers; over-decrement safety
  metrics.go                                -- Prom counters/histograms (§12.1)
  config.go                                 -- campaign config snapshot + hot-reload
  janitor.go                                -- (optional) E06-shared sweep helper
  dispatch_loop_test.go
  predictive_answer_handler_test.go
  retry_policy_test.go
  pre_t04_checks_test.go
  tokens_test.go
  integration_test.go                       -- testcontainers Valkey + MySQL + mock T04
  bench_test.go                             -- p50/p99 benchmarks

dialer/internal/picker/predictive/          -- (optional sub-package if predictive grows)
  pick.go
  transfer.go
```

Total: ~1100 LOC production + ~900 LOC tests. **No new Lua** — reuses F04's `claim_lead_from_hopper.v1.lua` (§6.1) + `pick_agent_for_call.v1.lua` (§6.4) + `release_hopper_lock.v1.lua` (§6.2).

---

## 17. Hand-offs to other modules

| Module | Hand-off |
|---|---|
| **E01** | E04 calls `Consumer.Claim(ctx, cid)` per dispatch (returns `LeadClaim` with fence token); calls `Consumer.Release(ctx, claim, outcome)` per outcome. E04 calls `Consumer.ScheduleImmediate` NEVER — that's D06's only caller. E04 INCRs `t:{tid}:freq:{phone}:{cid}` on BRIDGED. |
| **E02** | E02 SETs `t:{tid}:campaign:{cid}:dispatch_tokens <n> EX 2` per tick; E04 DECRs. Optional pubsub `tokens_replenished` for fast-wake. E04 reads agent ZCARDs + active SCARDs only via F04 helpers, not via E02. |
| **E03** | No direct interaction. E03 writes `dial_level` (E02 reads). E04 doesn't care about level. |
| **E05** | E04 emits `events:vici2.call.dropped` XADD on PREDICTIVE no-agent. E05 consumes for safe-harbor playback + drop_window stream entry. |
| **T01** | E04 (answer handler) calls `T01.UUIDTransfer(callUUID, "conference:agent_t<tid>_u<X>@default+flags{join-only}", "inline", "default")` for PREDICTIVE post-answer. E04 does NOT call any other T01 methods directly. |
| **T03** | E04 uses `conference.ConferenceFQN(tenantID, agentID, "default")` to build the UUIDTransfer destination. RFC-002 lint enforces; never assemble `agent_…` strings inline. |
| **T04** | E04 calls `T04.Originate(ctx, OriginateRequest{Mode, AgentID, LeadID, AttemptUUID, …})`. T04 returns sync result. E04 maps the typed errors per §7.2. |
| **D04** | E04 imports the status taxonomy via D04's status-flag cache. E04 calls `D04.IsDialEligible(status)` for the optional pre-T04 check. E04 doesn't write `leads.status` directly — E01.Release does. |
| **D06** | E04 has no direct integration. D06 calls `E01.ScheduleImmediate` which ZADDs to the hopper; E04 picks naturally on next tick. E04 emits `vici2_picker_callback_dispatched_total` for forensic. |
| **F04** | E04 uses Valkey helper for: agent ZSETs (read), hopper ZSET (claim Lua), lead lock STRING, in_flight HASH, dispatch_tokens STRING, events streams. |
| **F02** | E04 reads campaigns row: `dial_method, lead_lock_ttl_seconds (new amendment), call_strategy (next_agent_call), dial_timeout_sec`. PLAN may file F02 amendment for `lead_lock_ttl_seconds` + `call_strategy` if missing. |
| **A01** | A01 maintains agent ZSETs (READY/PAUSED/INCALL/WRAPUP transitions). E04 read-only on those ZSETs. |
| **A06** | A06 owns disposition UI. After agent submits dispo, leads.status is updated (via D04 API); E04 sees the new status on the next claim attempt for that lead via the optional pre-T04 check. |
| **M02** | Admin UI for campaign config; publishes `t:{tid}:broadcast:campaign:{cid}:config_changed` on save; E04 supervisor reloads. |
| **O01** | Metrics in §12.1; alerts §12.2. |
| **S01** | Reads `vici2_picker_active_inflight` gauge + per-campaign HINCRBY counters for wallboard. |
| **X03** | Phase 3.5 multi-FS dispatch — E04 unaffected (T04 picks FS pod). |
| **E06** | E06 calls `picker.SweepOrphans(ctx)` every 60 s; sweeps `in_flight` HASH entries older than 5 min; releases via `E01.JanitorRelease`. |

---

## 18. Citations

1. **Vicidial — `inktel/Vicidial/bin/AST_VDauto_dial.pl`** — https://github.com/inktel/Vicidial/blob/master/bin/AST_VDauto_dial.pl — canonical predictive-dial loop in Perl: agent count → goalcalls → originate to PARK, then `vicidial_auto_calls` polling for agent pickup. Source for our §2.1 pseudocode.
2. **Vicidial — `inktel/Vicidial/bin/AST_VDauto_dial_FILL.pl`** — https://github.com/inktel/Vicidial/blob/master/bin/AST_VDauto_dial_FILL.pl — variant for oversubscribed campaigns; direct-to-agent originate for PROGRESSIVE mode.
3. **Vicidial Forum — Hopper `LOCK TABLES` performance** — http://www.vicidial.org/VICIDIALforum/viewtopic.php?t=21857 — operator thread documenting `LOCK TABLES vicidial_hopper WRITE` as a scaling bottleneck; motivates our atomic-Lua approach.
4. **Vicidial Forum — `vicidial_auto_calls` visibility** — http://www.eflo.net/VICIDIALforum/viewtopic.php?f=4&t=37108 — operator complaints about lack of in-flight visibility; motivates our `in_flight` HASH.
5. **GoAutoDial 4 — Source mirror** — https://github.com/goautodial — Vicidial fork. Confirms no algorithmic delta worth importing.
6. **VicidialNOW — Source mirror** — https://github.com/vicidialnow/vicidialnow — multi-tenant Vicidial fork; same dial-loop semantics.
7. **47 CFR § 64.1200(a)(7) — abandonment safe harbor** — https://www.ecfr.gov/current/title-47/chapter-I/subchapter-B/part-64/subpart-L/section-64.1200 — 3 % rolling 30-day ceiling; 2-second connect-to-agent definition. Source for PREDICTIVE drop-handling budget.
8. **47 CFR § 64.1200(a)(7)(ii) — recorded-message safe harbor** — same source — drives E05's role; E04 emits the drop event, doesn't play audio.
9. **FTC Telemarketing Sales Rule 16 CFR Part 310 — 2-second rule** — https://www.ftc.gov/sites/default/files/documents/federal_register_notices/telemarketing-sales-rule-16-cfr-part-310/061004telemarketingsalesrule.pdf — FTC counterpart; confirms 2-second window for connect-to-agent.
10. **FreeSWITCH wiki — Hangup Cause Code Table** — https://freeswitch.org/confluence/display/FREESWITCH/Hangup+Cause+Code+Table — source for our outcome→D04 status mapping in §7.2.
11. **Vicidial Forum — `next_agent_call` strategy** — http://www.eflo.net/VICIDIALforum/viewtopic.php?p=25030 — Matt Florell on agent-pick strategies (`longest_wait` default).
12. **F04 PLAN §6.1 `claim_lead_from_hopper.v1.lua`** — local — atomic ZPOPMIN + lock + in_flight HSET.
13. **F04 PLAN §6.2 `release_hopper_lock.v1.lua`** — local — fence-token release.
14. **F04 PLAN §6.4 `pick_agent_for_call.v1.lua`** — local — atomic agent reservation via dual-index ZSET transition.
15. **F04 PLAN §6.5 `agent_state_transition.v1.lua`** — local — agent status state machine; used by A01 (not E04 directly) but informs the RESERVED→INCALL hop.
16. **F04 PLAN §4.13 coordination primitives** — local — `t:{tid}:dialer:tick:{cid}` lock (used by E02, NOT E04); §4.14 in_flight HASH.
17. **F04 PLAN §5.2 consumer pattern** — local — XREADGROUP canonical form for E04 answer handler.
18. **F04 PLAN §5.3 XAUTOCLAIM recovery** — local — sibling pod reclaim of stuck PEL entries.
19. **T04 PLAN §3 (5-gate pipeline)** — local — gateway-cap, drop-cap, TCPA, DNC, consent. E04 hands off entirely; does not re-run.
20. **T04 PLAN §4 (Mode→DialTarget table)** — local — PROGRESSIVE/MANUAL/PREVIEW → CONFERENCE; PREDICTIVE → PARK.
21. **T04 PLAN §7 (one-UUID rule)** — local — `attempt_uuid` generated by E04, flows through audit row + Job-UUID + origination_uuid + call_log + recording_log.
22. **T04 PLAN §8 (typed error set)** — local — `ErrTCPABlocked`, `ErrDNCHit`, `ErrConsentBlocked`, `ErrGatewayLimit`, `ErrRateLimited`, `ErrCarrierFail`. E04 maps each in §7.
23. **T03 PLAN §1.2 (`ConferenceFQN` helper)** — local — RFC-002 enforces; E04 uses for UUIDTransfer destination.
24. **T03 PLAN §5 (`+flags{join-only}` mandatory on non-agent transfer)** — local — orphan-conf prevention.
25. **T01 PLAN §7.3 (execute_on_answer=park)** — local — PREDICTIVE wire form.
26. **T01 PLAN §17.5 (E04 may call T01 directly)** — local — addendum permitting `UUIDTransfer` from E04.
27. **E01 PLAN §1.3 (refill_request pubsub)** — local — E04 publishes when claim returns nil sustained.
28. **E01 PLAN §6 (Consumer.Claim contract)** — local — fence-token LeadClaim return shape.
29. **E01 PLAN §7 (outcome → state transitions table)** — local — Release outcome mapping; E04 produces the outcome enum.
30. **E01 PLAN §8.2 (boundary table)** — local — confirms freq-cap INCR is E04's job (not E01's) on BRIDGED.
31. **E01 PLAN §8.3 (D06 callback integration)** — local — `ScheduleImmediate` runs all gates; E04 doesn't see callbacks specially.
32. **E02 RESEARCH §3.7 (claim+dispatch loop)** — local — original location of claim+dispatch was inside E02; this RESEARCH moves it to E04.
33. **E02 RESEARCH §6.2 (token-bucket burst-spread)** — local — basis for our DECR-tokens contract.
34. **E02 RESEARCH §10 (failure-mode matrix)** — local — template for §15.
35. **E02 RESEARCH §16 (E04 hand-off)** — local — RESEARCH note "E04 is event-driven on FS CHANNEL_ANSWER; E02 has no direct interaction" — this RESEARCH formalises an indirect interaction via `dispatch_tokens`.
36. **D04 RESEARCH §3.4 (per-status recycle_delay defaults)** — local — `B=120`, `NA=300`, `N=600`, `CARRIER_FAIL=0`, etc.
37. **D04 RESEARCH §5/§7 (hangup-cause map)** — local — source for §7.2 outcome→status mapping.
38. **D04 RESEARCH §3.2 (4 new T04 statuses)** — local — `TCPA`, `CONSENT_NOT_OBTAINED`, `CARRIER_FAIL`, `GATEWAY_LIMIT_TRY_LATER`; E04 emits via Release.
39. **D06 module spec** — local — callback worker triggers; E04 has no direct integration; agent-only via UI notification only.
40. **C01 PLAN §2 (`tcpa.Check` API)** — local — T04 calls; E04 doesn't re-run.
41. **C01 PLAN §7.2 (TCPA boundary handling)** — local — `nextOpen` used by Release for recycle hint.
42. **DESIGN.md §1.2 (dial-method definitions)** — local — MANUAL / RATIO / PROGRESSIVE / ADAPT_* / PREDICTIVE.
43. **DESIGN.md §5.2 (Redis live state)** — local — agent state HASH, ZSET indexes.
44. **DESIGN.md §6.2 (dialTick pseudocode)** — local — sketch of the dispatch loop; this RESEARCH formalises the E02↔E04 split.
45. **SPEC.md §4.2 (live state in Redis)** — local — Valkey is the source-of-truth for live ops.
46. **SPEC.md §4.3 (dialer engine is the only originator)** — local — E04 is part of the dialer engine.
47. **SPEC.md §7.4 (callback flow)** — local — agent-only vs anyone callbacks.
48. **Genesys — Outbound Predictive vs Progressive** — https://docs.genesys.com/Documentation/OU/8.1.5/Dep/DialingModes — vendor mode definitions; confirms PROGRESSIVE = pre-pair, PREDICTIVE = dial-then-pair.
49. **Five9 — Predictive vs Progressive thresholds** — https://documentation.five9.com/bundle/campaign-admin/page/campaign-admin/configuring-campaigns/configuring-dialing-modes/predicitive-dialing-mode.htm — vendor recommendation: predictive ≥ 10 agents, progressive < 10. Source for §4.4 decision matrix.
50. **Talkdesk — Predictive abandon-risk profile** — https://www.talkdesk.com/blog/how-predictive-dialers-work/ — vendor write-up on abandon-rate math; confirms the 2 s safe-harbor budget per call.
51. **SPEC.md §10 (Phase-2 demo definition)** — local — ADAPT_TAPERED + 1.5× + drop < 2 %.
52. **Twilio — Outbound CPS limits** — https://help.twilio.com/articles/223180788 — confirms per-account CPS caps; informs DECR-tokens design rationale.

(Citation count: 52, ≥ 12 required.)

---

## STOP — Do not proceed to PLAN. Awaiting orchestrator review.

When unblocked the PLAN must:

1. **Pin the E02↔E04 boundary** (§3) — confirm E04 owns the claim+dispatch loop, E02 owns the count gauge.
2. **Pin the `dispatch_tokens` contract** (§11.3) — STRING DECR with `SET ... EX 2`.
3. **Lock the pairing models** (§4) — PROGRESSIVE/MANUAL/PREVIEW pre-pair, PREDICTIVE dial-then-pair via answer-handler.
4. **Lock the retry policy table** (§7.2) — all 16 DialOutcome → D04 status mappings.
5. **Confirm agent-pick strategy default** = `longest_wait`; other strategies tracked as Phase 3+ (Q4).
6. **Confirm pre-T04 lead-status double-check** (Q2) — recommend yes.
7. **Document the file MODULE_SPEC_UPDATE** required against `spec/modules/E04.md` to expand E04 scope from "agent picker on answer only" to the full picker.
8. **Address all 12 open questions** in §13 with PLAN-stage decisions.
9. **Specify the F02 amendment** for `campaigns.lead_lock_ttl_seconds` + `campaigns.call_strategy` (next_agent_call) if not already landed.
10. **Lay out the test plan** in §14 with concrete CI hooks (`go test -tags=integration ./internal/picker/...`).
