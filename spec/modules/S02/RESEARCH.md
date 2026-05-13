# Module S02 — Supervisor Live-Monitor (Eavesdrop / Whisper / Barge) — RESEARCH

| Field | Value |
|---|---|
| Track | Supervisor |
| Phase | 3 |
| Status | RESEARCH |
| Author | S02 RESEARCH sub-agent (Claude Opus 4.7, 1M ctx) |
| Date | 2026-05-13 |
| Module spec | [`spec/modules/S02.md`](../S02.md) |
| Governing RFC | [`spec/rfc/RFC-002-conference-naming.md`](../../rfc/RFC-002-conference-naming.md) — **ACCEPTED** |
| Cross-cutting deps | T03 (agent conference), T01 (ESL), F03 (FS config + conference profile), A02 (SIP.js softphone), C02 (consent), C03 (audit immutability), F05 (RBAC), S01 (wallboard origin) |

> **Scope.** This RESEARCH document surveys every choice S02 PLAN must make:
> what mod_conference primitives we use for the three modes, whether the
> conference-per-agent model already gives us what we need or we have to
> add a second conference for whisper, how a supervisor leg gets created,
> which member flags belong to which mode, how mode transitions work, what
> the legal/compliance constraints look like in 2026, how the supervisor
> UI surfaces this, how many concurrent monitor sessions a Phase-1 FS host
> can sustain, and what the test plan must cover. Out-of-scope: writing
> the PLAN itself; writing code; deciding the UI button layout (S01/UX
> owns the surface, S02 owns the action). Every citation is a 2025/2026
> URL or a frozen vici2 PLAN/RESEARCH file path.

---

## 0. Executive summary — 12 bullets

1. **mod_conference natively does all three modes via member flags.** No
   second conference is needed. The agent's per-agent conference
   `agent_t<tid>_u<uid>@default` (RFC-002) is the single point of audio
   mixing; the supervisor joins it with different flags to express
   eavesdrop / whisper / barge. The supervisor is just another member of
   the same conference. (T03 RESEARCH §5.4 cites this directly; F03 PLAN
   §5 lines 666-668 freeze the flag combinations.)

2. **The three flag combinations** (frozen by F03 PLAN §5 and T03 RESEARCH
   §5.4) — supervisor joins with `conference_member_flags`:

   | Mode | Flags | Meaning |
   |---|---|---|
   | **Eavesdrop** (listen-only) | `mute,deaf=false` (i.e., `mute`) | Sup hears mix; sup mic muted into the mix; agent + customer hear nothing from sup |
   | **Whisper** (sup → agent only) | `mux-out=<agent-member-id>` *or* per-member `relate <sup> <cust> nospeak nohear` | Sup audio routes only to the agent; customer is excluded from receiving sup audio |
   | **Barge** (3-way) | (no flags) | Sup audio mixed into conf normally; all three parties hear each other |

   The whisper case is the only non-trivial one — see §3.3 for the two
   competing native mechanisms (`relate` vs per-member mux routing) and
   the recommendation (`conference … relate`).

3. **Conference model: single conference, not two.** The "second
   conference bridged via uuid_bridge" architecture (Asterisk's
   `ChanSpy()` legacy approach) is unnecessary in mod_conference 1.10
   because `relate` lets one conference do everything `ChanSpy` did.
   Going single-conference saves: one less leg per session, no
   uuid_bridge orchestration, one audit row not two, no recording
   double-counting. RESEARCH recommendation §3.4: **single conference.**

4. **Mode transitions are member-flag updates, NOT rejoin.** `conference
   <conf> mute <member-id>` / `unmute` / `deaf` / `undeaf` /
   `relate <a> <b> nospeak`-toggle achieve transitions without dropping
   the supervisor's audio leg. No `uuid_kill` + new INVITE is needed for
   eavesdrop ↔ whisper ↔ barge. This is the single biggest win over
   Asterisk `ChanSpy()`: zero-glitch mode switching. See §4.

5. **The supervisor leg is born via SIP.js INVITE from the supervisor's
   browser**, not via `originate` from the API. The supervisor is
   already logged into the same web app as agents; their browser already
   has a `SimpleUser` softphone (A02). When the supervisor clicks
   "Listen on agent 42", the browser INVITEs
   `sip:*8{tid}_{target_uid}_{mode}@default` (a new park-like extension
   pattern in the F03 dialplan, owned by S02 IMPLEMENT). The dialplan
   verifies the caller is in role `supervisor` or higher, looks up the
   agent's conference name via `${vici2_supervisor_target}` channel var,
   and `conference` apps the supervisor INTO that conference with the
   right flags. See §5.

6. **Authorization is dialplan-side AND API-side, in that order.**
   The browser asks `POST /api/sup/monitor/start` for a short-lived JWT
   that carries `monitor_target_uid` + initial mode. F05 RBAC enforces
   `supervisor` role + tenant scope + team scope (supervisor manages
   this agent's team, see §6). The JWT becomes a SIP custom header
   `X-Vici2-Monitor-Token`; the F03 dialplan validates it server-side via
   `mod_xml_curl` directory binding OR (cheaper, Phase 1 only) channel
   variable check against an in-memory Valkey HASH populated at the API
   call. Defense-in-depth: SIP digest auth (the supervisor is a real
   logged-in user), JWT scope, dialplan re-check.

7. **Recording: the conference recording (R01 owns) MIXES the supervisor
   into whatever it's recording.** This is a problem in two of the three
   modes. Per-leg customer recording (R01's default per F03 §5
   `record-template`) records only the customer leg → supervisor audio
   was never on that leg → supervisor's voice does NOT end up in the
   customer recording. In whisper mode, the supervisor's voice DOES end
   up mixed into the agent leg's audio (because agent hears it), but
   we record the customer leg, not the agent leg, so we're safe.
   **However**, if R01 ever switches to stereo conference recording or
   to per-agent-leg recording (R01 RESEARCH OPEN), the supervisor's
   whisper would land in the recording — a privacy + legal issue. See
   §7 for the matrix and the recommended R01 contract.

8. **Compliance: supervisor monitoring is regulated**, more so in 2026
   than in 2020. The federal floor (18 USC §2511(2)(d)) allows one-party
   consent and the employer party of an employee call gives implied
   consent for QC monitoring (Watkins v. L.M. Berry, 11th Cir. 1983 — the
   business-extension exception is still good law). The 13 two-party
   states (CA, CT, DE, FL, IL, MD, MA, MI, MT, NH, OR, PA, WA — same set
   C02 uses) require both parties to consent. Most state PUC orders now
   require either (a) the call recording-consent message to also disclose
   monitoring ("This call may be monitored or recorded for quality
   purposes") OR (b) a separate beep tone audible to the customer when a
   supervisor joins (47 CFR §64.501 covers this for carriers; many
   enterprise policies follow it voluntarily). See §8. **Recommendation:
   reuse C02's consent message — the standard phrasing already covers
   monitoring. No separate beep required if the message includes the
   word "monitored".**

9. **Multiple concurrent supervisors on the same agent are ALLOWED
   technically** (max-members=20 per F03 §5; we use 4 typical = agent +
   customer + sup-1 + sup-2). The UX question is whether the agent
   should know how many supervisors are listening. Trade-off in §9.
   Recommendation: agent UI shows count + roles; aggregate count, no
   individual identification.

10. **Performance: a single FS 1.10.12 host can sustain ~200 active
    conference members at 8 kHz/PCMU/20 ms** (one core for ~50 mixes,
    F03 RESEARCH §9 / Artoo R2D2 thread-wall analysis). A monitor
    session adds 1 member, so 200 agents × 4 typical members/conf = 800
    members → already over capacity. **Phase-1 target: ≤50 active
    monitor sessions concurrently** (well below the wall), which lines
    up with the 50-agent Phase-1 footprint. See §10.

11. **Test plan: SIPp scenario for INVITE → audit-row → mode-switch DTMF
    → audit-row → leave → audit-row.** Plus a 5-supervisor stress test
    against one agent (verify max-members guard). Plus a compliance
    test: verify supervisor's voice does NOT appear in the customer-leg
    recording in any of the three modes. See §11.

12. **Top-3 risks for PLAN:** (R1) `relate` semantics under
    flag-update racing — what if eavesdrop→whisper→barge transitions
    fire faster than mod_conference processes them; (R2) supervisor's
    leg surviving agent logout (the conf is destroyed by `endconf` flag
    on the agent leg → sup gets dropped → SIP.js needs to detect and
    not auto-reconnect to a dead extension); (R3) cross-tenant scope
    leak — a supervisor in tenant A must NEVER be allowed to monitor an
    agent in tenant B, and the dialplan layer is the load-bearing
    defense if the API has a bug.

---

## 1. Background: what "supervisor monitor" means in a call center

### 1.1 Industry vocabulary (Genesys / Five9 / NICE / Talkdesk 2025-26)

The three classic modes were named by Aspect Communications in the 1990s
and are now universal across every CCaaS platform:

| Mode | Aspect/legacy name | Vicidial term | Five9 term (2025) | Genesys term | What the agent hears | What the customer hears |
|---|---|---|---|---|---|---|
| **Eavesdrop / silent monitor** | Silent monitor | "Listen" | Monitor (Listen-only) | Silent Monitoring | nothing extra | nothing extra |
| **Whisper / coach** | Whisper coach | "Whisper" | Whisper (Coach) | Coaching | supervisor's voice | nothing extra |
| **Barge / 3-way** | Barge in | "Barge" | Barge-in | Conference | supervisor's voice | supervisor's voice |

[Genesys Cloud "Listen, Whisper, Barge"](https://help.mypurecloud.com/articles/about-the-supervisor-listen-coach-barge-feature/) ·
[Five9 Supervisor monitor](https://www.five9.com/products/applications/supervisor) ·
[NICE CXone "Supervisor Monitor"](https://help.nice-incontact.com/content/supervisor/monitorings.htm) (all confirmed accessible 2025-Q4).

ViciDial's `astguiclient` ships [`AST_agent_monitor.pl`](https://github.com/billscholes/vicidial/blob/master/bin/AST_agent_monitor.pl)
which spawns an Asterisk `ChanSpy()` call. The vici2 design replaces
Asterisk + ChanSpy with FreeSWITCH + mod_conference — see §2.

### 1.2 Why mod_conference is fundamentally simpler than ChanSpy

`Asterisk ChanSpy()` is a dialplan application that grabs the audio from
a channel (the spied-on channel) and presents it to the spying channel,
optionally injecting whisper audio via `Whisper()` / `Barge()`. It works
but has well-known issues:

1. **Mode transitions are DTMF on the spying channel** — `4`=whisper,
   `5`=barge — which means the spied-on call has to be in a state where
   DTMF-eat doesn't intercept. RFC 2833 race conditions are common.
   ([asterisk-users 2021](https://lists.digium.com/pipermail/asterisk-users/2021-February/295765.html))
2. **`Whisper()` only works on bridged channels**, not on parked or
   queued channels. Pre-bridge eavesdropping silently does nothing.
3. **No clean barge** — Asterisk's `Barge()` is technically just
   `ChanSpy(... w)` with mode 5, but it injects via a side-channel that
   isn't fully duplex; latency is ~150 ms worse than a true conference.
   ([digium-users 2019](https://lists.digium.com/pipermail/asterisk-users/2019-October/293487.html))
4. **One spier per spied-on channel** in older Asterisk; lifted in 16+
   but with `MixMonitor` interaction quirks.

mod_conference does not have any of these problems because:
- The agent is already in a conference; there's no "bridge" to spy on.
- The supervisor is just another conference member with different flags.
- DTMF doesn't need to leak into anyone's RTP path; mode transitions
  are server-side `bgapi conference … <cmd>` API calls.
- `max-members` is the only limit.

(F03 RESEARCH §6 and T03 RESEARCH §5.4 are the existing internal
citations.)

### 1.3 What ViciDial users actually complain about (forum scan 2024-25)

[Vicidial mailing list "supervisor whisper crackling"](http://lists.vicidial.org/pipermail/vicidial-users/2024-September/056321.html),
[Vicidial forum "barge no audio one direction"](https://www.vicidial.org/VICIDIALforum/viewtopic.php?t=42118)
[Reddit r/Asterisk "ChanSpy mute"](https://www.reddit.com/r/asterisk/comments/16fve8r/) —
common complaints (synthesized):

1. **Whisper audio leaks to customer** — usually a bug in `ChanSpy()`'s
   spy buffer that injects on both legs if the agent un-holds.
2. **No audit of supervisor sessions** — ViciDial logs them in
   `vicidial_log_extended` but the timestamps are coarse (second-level)
   and the supervisor identity is often the call-center floor manager's
   shared phone, not the human.
3. **Cannot tell which supervisor is listening** — agent UI shows
   nothing.
4. **Whisper-only-to-agent's-ear vs whisper-to-bridge confusion** —
   ChanSpy's docs are ambiguous; sysadmins ship the wrong flag.

vici2 design intent: fix all four via (a) mod_conference's clean
`relate` primitive, (b) C03-chained `audit_log` row per session per
mode-change, (c) agent UI indicator (§9), (d) explicit dialplan
extension naming `*8...listen` / `*8...whisper` / `*8...barge` so the
flag-set is named, not inferred.

---

## 2. The conference-per-agent context S02 inherits

### 2.1 What T03 has frozen (RFC-002 + T03 PLAN)

From T03 PLAN §1, §2, §11.5 and RFC-002:

- Conference name format: `agent_t<tid>_u<uid>@default` (Phase 1:
  `agent_t1_u<uid>@default`).
- The agent is the **moderator** of their own conference; flags
  `moderator,nomoh,endconf,join-only`.
- The customer is a regular participant with `endconf=false` so their
  hangup doesn't tear down the agent's conference.
- All conferences use one profile, `default`, defined in F03 PLAN §5;
  `max-members=20`, comfort-noise on, silent enter/exit/alone, 8 kHz
  mix rate, PCMU/OPUS via codec negotiation per profile.
- Member-id tracking: `t:{tid}:agent:{uid}:conf_members` HASH (T03 PLAN
  §5.2), keyed on call_uuid, value `<member-id>:<role>` where
  `role ∈ {agent, customer, third, supervisor}`. **`supervisor` is
  already reserved in the role enum** — T03 RESEARCH §10.4 cite line
  773.
- F03 PLAN §5 line 668 already documents: "Supervisor (S02): flag
  `mute,deaf=false` (whisper) or `mute,deaf=true` (listen)." But this
  is a partial spec — barge mode and the `relate` mechanism for
  whisper-to-agent-only are NOT yet in F03. S02 PLAN must close those
  gaps.

T03 PLAN §11.5 explicitly hands off to S02:
> Supervisor barge in whisper or listen mode:
> - **Whisper (sup talks to agent only):** S02 originates the supervisor
>   leg with `conference_member_flags=mute,deaf=false`
> - **Listen-only (sup hears all, no mic):** `conference_member_flags=mute,deaf=true`
> - **Barge (sup talks to all):** `conference_member_flags=` (no flags)
>
> S02 owns the originate; T03 only provides the conference name via
> `ConferenceName(tid, uid)` and the `Operator.GetMembers` surface for
> S02 to verify the agent is logged in before originating.

**Caveat:** "Whisper = `mute,deaf=false`" in T03 RESEARCH §5.4 is
**WRONG** semantically. It would mute the supervisor's mic into the
conf, defeating whisper entirely. The intended phrasing is "whisper =
NOT mute, NOT deaf, BUT relate-only-to-agent". S02 RESEARCH proposes
correcting this in S02 PLAN via the `conference relate` mechanism
(§3.3 below). The T03 RESEARCH/PLAN line is a known typo / oversimplification.

### 2.2 What F03 has frozen

From F03 PLAN §4.4 (line 543-562 — `99_features.xml`):

```xml
<!-- *0 toggle silent supervisor mode (S02) — placeholder, S02 implements -->
<!-- *1 listen-only eavesdrop -->
<!-- *2 whisper -->
<!-- *3 barge -->
```

These are STUBS — F03 explicitly hands the implementation to S02. The
`*1` / `*2` / `*3` codes were designed to be DTMF-toggled from inside
the supervisor's call, but the better UX (RESEARCH §4.3, §5.2) is
server-driven mode switch via API call → `fs_cli conference … relate`,
NOT DTMF. S02 PLAN should rename the dialplan extensions to entry
extensions, not in-call DTMF, and reserve the `*1/*2/*3` DTMF slot for a
fallback path (telephone-only supervisor on a hardphone with no web UI).

### 2.3 What A02 (SIP.js softphone) inherits

A02 PLAN §3, §7 confirm:
- The supervisor uses the SAME `SimpleUser` / `useSoftphone()` hook as
  agents (A02 PLAN line 84: "S02 (supervisor whisper reuses
  `SimpleUser`)").
- Inbound INVITE handling is auto-answer (A02 PLAN line 64) — relevant
  if the supervisor leg arrives via API-driven `originate` instead of
  browser-driven INVITE. RESEARCH recommendation §5: browser-driven
  INVITE, simpler.
- The supervisor's browser maintains a single audio leg; the
  audio-element is shared. So the supervisor cannot be in two monitor
  sessions concurrently from one browser tab. Multi-monitor would
  require multiple browser tabs OR a multi-leg `SimpleUser` extension
  (out of scope for Phase 1).

---

## 3. mod_conference primitives — the full surface

### 3.1 Source-of-truth references for mod_conference 1.10.12

| Document | What it covers | URL |
|---|---|---|
| SignalWire mod_conference docs | Full member flag list, conference API, events | https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Modules/mod_conference_3965534/ |
| FreeSWITCH 1.10 confluence archive | Conference profile params, recording, MOH | https://freeswitch.org/confluence/display/FREESWITCH/mod_conference |
| FreeSWITCH source tree (1.10.12) | `src/mod/applications/mod_conference/` — authoritative | https://github.com/signalwire/freeswitch/tree/v1.10.12/src/mod/applications/mod_conference |
| freeswitch.org.cn mirror 1.7 | Older but exhaustive flag table | https://www.freeswitch.org.cn/books/references/1.7-mod_conference.html |
| Conference Add Call Example | Outbound originate-to-conference pattern | https://freeswitch.org/confluence/display/FREESWITCH/Conference+Add+Call+Example |
| FreeSWITCH 1.10.12 release notes | Confirm relate is stable | https://github.com/signalwire/freeswitch/releases/tag/v1.10.12 |

All confirmed accessible 2025-Q4 / 2026-Q1. F03 RESEARCH §6 already
sourced these; S02 RESEARCH does not duplicate evidence — it consumes
the existing F03/T03 evidence trail.

### 3.2 The relevant member flags (table)

From [SignalWire mod_conference](https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Modules/mod_conference_3965534/),
the flags S02 cares about:

| Flag | Direction | Meaning |
|---|---|---|
| `mute` | member → conf | Member's audio is NOT mixed into conference (mic muted) |
| `deaf` | conf → member | Member does NOT receive conference audio |
| `nomoh` | conf → member when alone | Suppresses moh-sound when alone in conference |
| `endconf` | conference lifecycle | Conference is destroyed when the last member with `endconf` leaves (after `endconf-grace-time`) |
| `join-only` | conference lifecycle | This member cannot CREATE the conference; only join existing |
| `moderator` | conference role | Can kick, mute others, terminate; affects who counts toward `non_moderator` selector |
| `ghost` | conference role | Member is invisible in `conference list`; useful for silent monitor in some legacy setups; **NOT recommended for S02** because we WANT the supervisor visible in `list` for audit |
| `vmute` / `vdeaf` | video | Not relevant (no video in vici2 Phase 1) |
| `wait-mod` | join control | Stay in waiting room until moderator joins |
| `nospeak` (NOT a member flag — see relate below) | relate primitive | Per-pair audio routing |

### 3.3 The `relate` primitive — the key to whisper

`conference <name> relate <member-A> <member-B> [nospeak|nohear|sendvideo|clear]`
is the per-pair audio routing primitive added in mod_conference's
mid-2010s rewrite (still present and stable in 1.10.12). It controls
the **one-way audio relation** between two members, overriding the
conference's default "everyone hears everyone" mixing.

| Form | Effect |
|---|---|
| `relate <A> <B> nospeak` | A does not speak to B (B does not receive A's audio); other pairs unchanged |
| `relate <A> <B> nohear` | A does not hear B (A does not receive B's audio) |
| `relate <A> <B> sendvideo` | (video only, n/a) |
| `relate <A> <B> clear` | Reset to default mixing for the pair |

**Whisper-to-agent-only is expressed as:**
```
conference agent_t1_u42 relate <SUP-MID> <CUST-MID> nospeak
conference agent_t1_u42 relate <CUST-MID> <SUP-MID> nohear
```

Both directions are needed because `nospeak` is one-way. The first
prevents the supervisor's audio from being mixed into the customer's
mix-out; the second prevents the supervisor from hearing the customer
(optional — RESEARCH recommendation: KEEP the supervisor hearing the
customer, because the supervisor IS supervising the agent's handling of
THIS customer, so the second `relate` is NOT issued — supervisor hears
both agent and customer, but customer hears only the agent).

[FreeSWITCH 1.10 mod_conference source `conference_api.c`](https://github.com/signalwire/freeswitch/blob/v1.10.12/src/mod/applications/mod_conference/conference_api.c)
implements `relate` in `conf_api_sub_relate()`. The relate flags are
stored per-pair in a hash table on the conference, updated atomically
under the conference mutex. Atomicity matters for §4 (mode transitions).

**Two competing whisper implementations:**

| Approach | Mechanism | Pros | Cons |
|---|---|---|---|
| **A. `relate <SUP> <CUST> nospeak`** | Per-pair audio routing | One conference; clean; one mute-relate state per session; atomic transition to barge via `relate clear` | Slightly more complex audit ("relate state X→Y") |
| **B. Two conferences** (agent in conf-1; sup+agent in conf-2; customer in conf-1; agent bridges audio between them) | uuid_bridge between confs | Maps to Asterisk mental model | Two confs to track; two recordings; cross-conf audio routing is fragile; **rejected by RESEARCH** |
| **C. mux-out per member** (mod_conference 1.6 era hack) | Channel var `mux-out=<mid>` directs a member's outbound only to one other member | Single-leg whisper | Deprecated; not in 1.10 docs; would require code archaeology |

**RESEARCH recommendation: A.** Single conference, `relate nospeak` for
whisper. Matches T03's single-conference model exactly; minimal code;
audit trail clean (just record "relate-set" / "relate-clear" along
with mode); atomic.

### 3.4 The single-conference vs multi-conference decision

**Decision: single conference per agent. Supervisor joins the existing
agent conference. Whisper expressed via `relate nospeak`.**

Rationale:

1. T03 PLAN already commits to the conference-per-agent model. Adding
   a second conference would require either dialplan-side bridge
   orchestration OR conference cascading (mod_conference 1.10's
   `bridge` command — exists but undocumented and unstable per FS
   developer list ~2022). Neither is worth it.
2. `relate` does whisper natively in one conference. F03 already loads
   mod_conference; no new modules.
3. Mode transitions (eavesdrop ↔ whisper ↔ barge) become one or two
   API calls each (§4 below), not a uuid_bridge dance.
4. Recording: the agent's conference recording strategy (R01 owns) is
   per-leg, not conference-mixed; single-conference doesn't double-
   record (§7).
5. Audit row count: one `monitor_session_started` + one
   `monitor_mode_changed` per transition + one `monitor_session_ended`
   — clean schema (§8.5).

The only argument for two conferences is "the supervisor's audio in
whisper mode is fundamentally a different mix than the customer's
audio, so they should be different conferences." This is true in
information theory but irrelevant in practice — `relate` IS the
per-pair mix difference, implemented inside one conference at the
mixer level. There is no cost saving from forcing it to be two
conferences.

---

## 4. Mode state machine

### 4.1 The three modes and their underlying primitives

| Mode | Member flags at join | Post-join API calls |
|---|---|---|
| **Eavesdrop** | `mute` (sup is muted into conf) | none |
| **Whisper** | (no mute) | `conference relate <SUP> <CUST> nospeak` |
| **Barge** | (no mute) | (no relate) — supervisor is a regular member |

Notice that whisper does NOT use `mute` because if sup were muted, they
couldn't whisper. `mute` is for eavesdrop only.

### 4.2 Transitions (zero-glitch via API calls, no rejoin)

```
                  eavesdrop (sup MUTE, no relate)
                     │
                     │ unmute(SUP)
                     │ relate(SUP, CUST, nospeak)
                     ▼
                  whisper (sup UNMUTE, relate nospeak)
                     │
                     │ relate(SUP, CUST, clear)
                     ▼
                  barge (sup UNMUTE, no relate)
                     │
                     │ relate(SUP, CUST, nospeak)
                     ▼
                  whisper
                     │
                     │ mute(SUP)
                     │ relate(SUP, CUST, clear)
                     ▼
                  eavesdrop
```

**Every transition is ≤2 API calls. No SIP signalling. No RTP
disruption. The supervisor's audio leg stays up throughout.**

The atomic sequence for each transition (T = transition target):

| From → To | API sequence |
|---|---|
| eavesdrop → whisper | (1) `conference … unmute <SUP-MID>` (2) `conference … relate <SUP-MID> <CUST-MID> nospeak` |
| eavesdrop → barge | (1) `conference … unmute <SUP-MID>` |
| whisper → eavesdrop | (1) `conference … relate <SUP-MID> <CUST-MID> clear` (2) `conference … mute <SUP-MID>` |
| whisper → barge | (1) `conference … relate <SUP-MID> <CUST-MID> clear` |
| barge → whisper | (1) `conference … relate <SUP-MID> <CUST-MID> nospeak` |
| barge → eavesdrop | (1) `conference … mute <SUP-MID>` |

**Issue: order of operations on whisper-from-eavesdrop.** If we
`unmute` first and then issue `relate nospeak`, there is a window of
~milliseconds where the supervisor is unmuted AND not yet `relate`d to
not-speak-to-customer. The customer might hear a partial sup-word in
that window.

**Mitigation:** issue `relate` first, THEN `unmute`. Reversed order:
relate-nospeak-while-muted is a no-op (no audio to route anyway);
unmuting after that activates the route in its final state.

```
eavesdrop → whisper SAFE ORDER:
  (1) conference … relate <SUP> <CUST> nospeak
  (2) conference … unmute <SUP>
```

For whisper → eavesdrop, the opposite logic applies — `mute` first,
then `relate clear`:

```
whisper → eavesdrop SAFE ORDER:
  (1) conference … mute <SUP>
  (2) conference … relate <SUP> <CUST> clear
```

For barge ↔ whisper, only `relate` toggles; sup is unmuted in both
states; no ordering issue.

For barge ↔ eavesdrop:
- barge → eavesdrop: `mute` immediately; no relate needed.
- eavesdrop → barge: `unmute` immediately; no relate needed.

**These ordering rules MUST be codified in S02 IMPLEMENT.** A unit test
on the transition table is essential (§11.1).

### 4.3 Why server-side transitions, not DTMF

The original F03 stub (`*1`/`*2`/`*3`) implies DTMF-driven transitions
on the supervisor's leg. Problems with that:

1. DTMF in RTP is unreliable on WebRTC legs (browsers vary in DTMF
   tone generation; sometimes use SIP INFO instead of RFC 2833).
2. DTMF leaks into the conference mix if not eaten by a `bind_meta_app`
   or `playback_terminators` — the agent and customer would hear the
   beeps.
3. The supervisor UI on a wallboard would have to instrument browser →
   DTMF, which is one extra layer of fragility.
4. Server-side `bgapi conference …` is sub-millisecond and atomic.

**Recommendation:** SIP-level entry extensions (`*8…listen` etc.) set
the initial mode at INVITE time; **mid-session mode switches go through
the API**, which calls T01's `ConferenceCommand` over ESL. The DTMF
codes are kept for hardphone fallback (a supervisor on a desk phone
with no web UI can press `*2` after joining — see §5.5).

### 4.4 Multi-customer in conference (3-way + sup, etc.)

T03 supports 3-way (agent + customer + 3rd party). When a supervisor
joins a 3-way that's in progress, the `relate nospeak` in whisper mode
must include EVERY non-agent member, not just the original customer:

```
For each non-agent member M in conference:
  conference … relate <SUP-MID> <M-MID> nospeak
```

S02 IMPLEMENT must enumerate non-agent members via T01's
`ConferenceList()` (T01 PLAN §8.1) and issue the relates iteratively.
Similarly, when a new member joins the conference (a 3rd-party
transferred in MID-monitor), the conf-maintenance handler must
auto-issue a fresh `relate nospeak` for the supervisor↔new-member pair.

This is a **non-trivial complexity** and must be handled in S02 IMPLEMENT,
not deferred. Test plan §11.1 covers.

---

## 5. The supervisor leg — how it's born

### 5.1 Two architecture options

**Option A — browser INVITE (matches A02's existing softphone):**
Supervisor's browser already has a `SimpleUser` connected to FS over
WSS. Pre-condition: supervisor is logged in, has a JWT, has an
authenticated SIP REGISTER. To start a monitor session, the browser
sends an `INVITE sip:*8{tid}_{target_uid}_{mode}@<domain>` over the
existing WSS. The dialplan answers, validates, and joins the supervisor
into the agent's conf.

**Option B — server-side originate (legacy ChanSpy pattern):**
Browser calls `POST /api/sup/monitor/start`. The API issues
`originate user/<sup_user_id> &conference(agent_t<tid>_u<target_uid>@default+flags{mute,join-only})`.
FS rings the supervisor's softphone (A02 auto-answers per A02 PLAN
§7), then joins to the conf.

| Criterion | A (browser INVITE) | B (originate) |
|---|---|---|
| Latency | ~200 ms (existing WSS) | ~600 ms (originate handshake + INVITE-back) |
| Reuses A02 code | yes | yes (auto-answer) |
| Server-side authoritative | no (browser drives) | yes (API enforces) |
| Audit trail starts when | server receives INVITE | server initiates originate |
| Failure modes | INVITE rejected = clean | originate stuck in `dialing` state = needs cleanup |
| ESL load | low | medium (one bgapi originate) |

**RESEARCH recommendation: A (browser INVITE)** with API pre-flight.
The pre-flight is a `POST /api/sup/monitor/start` that:
1. Authorizes (role + tenant + team scope) — F05 RBAC.
2. Verifies the target agent is logged in and on a call (Valkey HASH
   `t:{tid}:agent:{uid}:status` must be `IN_CALL`).
3. Verifies max-members budget for the target conf (`ConferenceList`,
   count < 18 to leave 2 slots for 3-way headroom).
4. Issues a short-lived (60 s) signed token `monitor_grant_token` that
   embeds `{tid, sup_uid, target_uid, mode, exp}`.
5. Writes the audit row `monitor_session_authorized` (C03).
6. Returns the token to the browser.

Browser places the INVITE with the token in a custom SIP header
`X-Vici2-Monitor-Token: <jwt>`. F03 dialplan validates the token
(see §6.2), looks up the target conference name via
`ConferenceName(tid, target_uid)`, and conferences the supervisor in
with the right initial flags.

### 5.2 Dialplan extension shape (S02 IMPLEMENT will own)

```xml
<!-- freeswitch/conf/dialplan/default/80_supervisor_monitor.xml -->
<extension name="supervisor_monitor_join">
  <condition field="destination_number" expression="^\*8(\d+)_(\d+)_(listen|whisper|barge)$">
    <!-- $1=tid  $2=target_uid  $3=initial_mode -->
    <!-- Verify caller is a real authenticated SIP user (digest auth ran) -->
    <condition field="${sip_authorized_user}" expression="^\d+$" break="never">
      <!-- Token validation: presence of header AND match against in-memory cache -->
      <action application="set" data="vici2_mon_tid=$1"/>
      <action application="set" data="vici2_mon_target=$2"/>
      <action application="set" data="vici2_mon_mode=$3"/>
      <action application="set" data="vici2_mon_token=${sip_h_X-Vici2-Monitor-Token}"/>
      <!-- Phase 1: dialplan does a synchronous mod_xml_curl callout to
           /internal/freeswitch/monitor_authz which is the F05 backend.
           Returns 200 OK + member flags string, or 403 Forbidden. -->
      <action application="set" data="api_hangup_hook=curl http://api:3000/internal/freeswitch/monitor_end?call=${uuid}"/>
      <!-- Branch on mode -->
      <action application="execute_extension" data="supervisor_monitor_${vici2_mon_mode} XML default"/>
      <anti-action application="respond" data="403 Forbidden"/>
    </condition>
  </condition>
</extension>

<extension name="supervisor_monitor_listen">
  <condition field="destination_number" expression="^supervisor_monitor_listen$">
    <action application="answer"/>
    <action application="set" data="conference_member_flags=mute"/>
    <action application="set" data="vici2_role=supervisor"/>
    <action application="set" data="hangup_after_conference=true"/>
    <action application="conference"
            data="agent_t${vici2_mon_tid}_u${vici2_mon_target}@default+flags{mute,join-only,ghost=false,endconf=false}"/>
  </condition>
</extension>

<extension name="supervisor_monitor_whisper">
  <condition field="destination_number" expression="^supervisor_monitor_whisper$">
    <action application="answer"/>
    <action application="set" data="vici2_role=supervisor"/>
    <action application="set" data="hangup_after_conference=true"/>
    <action application="conference"
            data="agent_t${vici2_mon_tid}_u${vici2_mon_target}@default+flags{join-only,endconf=false}"/>
    <!-- After join, the conf-maint handler will see add-member with
         vici2_role=supervisor + vici2_mon_mode=whisper and issue the
         relate nospeak for every non-agent member. -->
  </condition>
</extension>

<extension name="supervisor_monitor_barge">
  <condition field="destination_number" expression="^supervisor_monitor_barge$">
    <action application="answer"/>
    <action application="set" data="vici2_role=supervisor"/>
    <action application="set" data="hangup_after_conference=true"/>
    <action application="conference"
            data="agent_t${vici2_mon_tid}_u${vici2_mon_target}@default+flags{join-only,endconf=false}"/>
  </condition>
</extension>
```

Key design points:

- `+flags{... endconf=false}` is critical: the supervisor's leg must
  NOT hold the conference open. The conference's life is owned by the
  AGENT (who has `endconf` per T03). When the agent logs out and the
  agent leg leaves, the conference is destroyed and the supervisor's
  leg is dropped along with it — that's the desired behavior.
- `+flags{join-only}` is mandatory: if the agent is NOT logged in (no
  conf exists yet), the supervisor's join attempt must FAIL rather
  than implicitly create the conference. T03 PLAN §1 commits to
  join-only on every non-agent join for exactly this reason.
- `hangup_after_conference=true` ensures the supervisor's SIP leg
  hangs up when their member leaves the conference (kicked, conference
  destroyed, etc.).
- `api_hangup_hook` lets the API write the `monitor_session_ended`
  audit row server-side, not relying on the browser to phone home.

### 5.3 Conf-maintenance handler addition (T01/T03 update)

T03's `agentPresenceConfMaintHandler` (T03 PLAN §5) consumes
`add-member` events. It currently branches on `vici2_role` for `agent`
vs `customer` vs `third`. S02 extends it to:

```
on add-member where vici2_role == "supervisor":
  HSET t:{tid}:agent:{target_uid}:conf_members <sup-call-uuid> "<mid>:supervisor:<mode>"
  HSET t:{tid}:monitor:<sup-call-uuid> tid=<tid> target_uid=<target_uid> sup_uid=<sup_uid> mode=<mode> conf_member_id=<mid> started_at=<ts>
  ZADD t:{tid}:agent:{target_uid}:monitors <ts> <sup-call-uuid>
  XADD events:vici2.monitor.session_started * {tid, target_uid, sup_uid, mode, started_at}

  IF mode == "whisper":
    enumerate non-agent members M in conf:
      issue conference … relate <mid> <M.mid> nospeak via T01
```

This is a small, additive change to T03's existing handler — S02
IMPLEMENT files it as an amendment to T03 (analogous to how T03 itself
filed F03 amendments per T03 PLAN §11.6).

### 5.4 Agent UI signal (transparency / S02 acceptance criterion #5)

When `t:{tid}:agent:{target_uid}:monitors` becomes non-empty, the
agent's A03 WS pushes a `monitor_active` event to the agent's UI. The
agent UI shows a banner: "1 supervisor listening" (or "2 supervisors,
1 in whisper mode" if multiple). The supervisor's identity is NOT
shown to the agent (per RESEARCH §9.1 — aggregate count only, not
individual identification, to reduce social pressure that distorts
QC monitoring).

### 5.5 Hardphone fallback

Some customers (rare in vici2 target market, but real) have desk
phones for managers. A hardphone supervisor cannot use the web UI.
They dial `*81042_listen` from their hardphone (assuming they know
target tid=1 and uid=1042 — which they would from a printed roster).
Authorization in this path uses SIP digest realm + a flat list of
"supervisor SIP IDs" maintained by F05 directory. Phase 1 may defer
the hardphone path entirely; the dialplan handles it generically and
F05 can enforce a hardphone-only DENY for Phase 1 if desired.

---

## 6. Authorization & scope

### 6.1 Role + tenant + team scope

F05's RBAC matrix (per F05 RESEARCH §8) has five roles:
`super_admin > admin > supervisor > agent > integrator`. The
`supervisor` role has the `call:monitor` permission. `super_admin` and
`admin` also have it. `agent` and `integrator` do not.

Tenant scope is a HARD invariant (F05 RESEARCH §8): every authorized
resource must satisfy `resource.tenant_id == jwt.tid`. So a supervisor
in tenant A cannot monitor an agent in tenant B even if both share a
session.

**Team scope is a NEW requirement S02 introduces.** Not every
supervisor in a tenant should be able to monitor every agent in that
tenant — large call centers have multiple supervisors with disjoint
teams. F05 currently has no `team` model. RESEARCH options:

| Option | Mechanism | Phase |
|---|---|---|
| **a. Tenant-only scope (Phase 1)** | Any supervisor in tenant can monitor any agent in tenant | Phase 1 (default) |
| **b. Team table (Phase 1+)** | `teams` table; `team_members(team_id, user_id, role)`; M01 admin UI; M02 campaign editor associates team to campaign | Phase 1.5 / Phase 4 |
| **c. Campaign-scoped supervisor** | A supervisor can monitor only agents currently on a call in campaigns where the supervisor is listed in `campaigns.supervisor_user_ids` | Compromise (Phase 1) |

**Phase 1 RESEARCH recommendation: Option a (tenant-only)** plus an
explicit "team scope is Phase 1.5+" entry in the OPEN_QUESTIONS list.
Most Phase-1 customers are <50 agents and a single supervisor scope.
The team model is a non-trivial schema addition (3 tables, 2 admin UI
flows, audit columns) that should be its own module (M-something) in
Phase 1.5.

### 6.2 Dialplan-side defense-in-depth

API-side authorization is necessary but not sufficient. If the API has
a bug or is compromised, the dialplan MUST still reject unauthorized
monitor attempts. F03's dialplan does this via:

1. **SIP digest auth** — the supervisor's REGISTER had a real
   credential. `${sip_authorized_user}` is the post-auth user id (T03
   PLAN §2.1 cites). Anyone with no valid credential can't even reach
   the dialplan.
2. **Token validation via mod_xml_curl callout** — the dialplan does a
   synchronous HTTP POST to `api/internal/freeswitch/monitor_authz`
   with `{caller_uid, target_tid, target_uid, mode, token}`. The API
   re-validates: token signature, expiry, role, tenant scope, team
   scope (Phase 1.5+). Returns 200 OK with `<document><variables>...
   </variables></document>` to allow the join (and pass member flags
   as channel vars) or 403 Forbidden to reject.
3. **Cross-tenant guard** — even with a valid token, the dialplan
   regex `^\*8(\d+)_(\d+)_(listen|whisper|barge)$` captures the
   target's tid. If the JWT's `tid` doesn't equal `$1`, the callout
   returns 403. T01's `ConferenceCommand` further rejects if the
   conference name doesn't exist or its name doesn't match the JWT
   tid.

The callout cost (~5-15 ms per join) is acceptable because monitor
sessions are low-frequency events (a few per minute across the whole
tenant, not per-second). Mode transitions don't trigger the callout —
they go through the API layer directly.

### 6.3 Token contents

```json
{
  "iss": "vici2/api",
  "sub": "<supervisor_user_id>",
  "tid": 1,
  "role": "supervisor",
  "monitor_target_uid": 1042,
  "monitor_initial_mode": "listen",
  "iat": 1747262400,
  "exp": 1747262460,   // 60s
  "jti": "01HZX..."     // for one-time use enforcement (Valkey SET NX)
}
```

`jti` is checked against `SET vici2:monitor:jti:<jti> 1 EX 90 NX` —
one-time use; replay attempts within 90 s fail.

### 6.4 Audit-denial path

When authorization fails (token invalid, role insufficient, tenant
mismatch, etc.), the API writes a `monitor_session_denied` audit row
with the reason code. This is non-negotiable for compliance — anyone
TRYING to monitor someone they shouldn't is a security event. SOC 2
CC7.2, NIST 800-53 AU-9 explicitly require failed-access logging.

---

## 7. Recording during monitoring

This section is load-bearing for compliance. Get it wrong, and the
supervisor's voice ends up in a recording that was intended to capture
only the customer-facing conversation — possible privacy / wire-tapping
violation.

### 7.1 The current R01 recording strategy (per T03 PLAN §7, F03 PLAN §5)

R01 records the **customer leg** via `record_session` set on the
customer channel BEFORE the customer is `uuid_transfer`'d into the
agent's conference. `RECORD_STEREO=true` so the recording has the
agent's audio on one channel and the customer's on the other (the
agent's audio is captured because mod_conference mixes the agent INTO
the customer's incoming audio path before the recorder sees it).

This is per-leg, not conference-mixed. Critical observation:
**`record_session` on the customer leg records the audio that the
customer hears + the audio that the customer transmits.** In a
single-conference model with `relate nospeak` for whisper:

- The customer hears: agent (always) + supervisor IF NO `relate
  nospeak` is set (i.e., barge mode only).
- The recorder captures whatever the customer hears.

| Mode | Sup voice in customer recording? | Reasoning |
|---|---|---|
| Eavesdrop (sup MUTE) | **NO** | Sup mic is muted into conf; conf mix to customer excludes sup |
| Whisper (`relate SUP CUST nospeak`) | **NO** | Relate explicitly removes sup from customer's mix-out |
| Barge (no flags, no relate) | **YES** | Sup is a full participant; customer hears them; recorder captures |

**This is the legally desired behavior.** Barge = 3-way = sup speaks
to customer = recording captures sup's voice for accountability.
Eavesdrop + whisper = sup is NOT participating in the customer conversation =
their voice MUST NOT appear in the customer recording.

### 7.2 The agent-leg recording question (R01 open)

R01 RESEARCH has an open question about adding per-agent-leg recording
in addition to per-customer-leg. Per-agent-leg would capture what the
AGENT says + hears. In whisper mode, the agent hears the supervisor —
so the supervisor's voice WOULD appear in the agent-leg recording.

This is fine for QC training purposes but raises a question about
agent-side wiretap consent: in some jurisdictions, recording an
employee's call also requires the employee's consent if private
communications can be intercepted. Watkins (11th Cir. 1983) says
business-extension recording is permitted for QC IF the employee is
notified. vici2 must include "your calls may be recorded for QC and
training" in the employee handbook / SIP-login splash. (See §8.4.)

**RESEARCH recommendation:** If R01 adds agent-leg recording, the
supervisor's whisper voice WILL appear in it; this is operationally
intentional (training playback shows the supervisor's coaching) and
legally tolerable IF the employee notice is in place. S02 IMPLEMENT
must coordinate with R01 RESEARCH to confirm this matrix.

### 7.3 Mute-the-recording-during-whisper alternative

Some platforms (NICE, Five9) explicitly stop or mute the recording
during whisper segments. Genesys Cloud calls this "Pause for
Confidentiality." The mechanism is `uuid_record mask` during whisper,
`uuid_record unmask` on transition out. Trade-off:

| Approach | Pros | Cons |
|---|---|---|
| **No-op (RESEARCH default)** | Simple; recording is continuous; no gaps to explain at audit | Supervisor voice may be in agent-leg recording |
| **Mask during whisper** | Supervisor coaching never preserved; cleaner privacy story | Recording gaps complicate playback UX; mask state needs audit |

**RESEARCH recommendation:** No-op for Phase 1. Revisit if customer
explicitly requests confidentiality. Document the trade-off in
HANDOFF.md.

### 7.4 Customer-side notification ("This call may be monitored")

C02 PLAN already covers recording-consent prompts ("This call may be
recorded for quality assurance purposes"). The standard phrasing
"This call may be **monitored or recorded** for QC purposes" covers
both — recording AND monitoring. C02's `consent_msg_audio` field
should ideally include both verbs. RESEARCH recommendation: file a
C02 amendment to ensure the default phrasing covers both. C02 PLAN
§9 (consent_msg_audio column) provides the hook; the actual audio
content is per-tenant.

The federal carrier rule 47 CFR §64.501 ("recording prompts on
interstate calls") requires either (a) a verbal notification or
(b) a periodic beep tone or (c) a beep tone at the start of the
call (any one of the three is sufficient). The C02 verbal notification
checks box (a), so no separate sup-join beep is required.

---

## 8. Consent & compliance — the legal landscape

### 8.1 Federal floor (18 USC §2511(2)(d))

Federal wiretap statute permits recording with one-party consent. The
"party" is anyone on the call OR (for employees) the employer under
the business-extension exception (Watkins v. L.M. Berry, 704 F.2d 577
(11th Cir. 1983)). Supervisor monitoring of an employee's call is
covered by this exception PROVIDED the employee was notified.

### 8.2 The 13 two-party states (per C02 PLAN §0, §3)

CA, CT, DE, FL, IL, MD, MA, MI, MT, NH, OR, PA, WA require both
parties' consent. **Both parties** here means the call participants
(the agent and the customer). The supervisor monitoring is treated
under federal rules where the supervisor is a representative of the
employer-party-with-consent. So:

- The CUSTOMER's consent is needed for the recording (C02 handles).
- The AGENT's consent is implicit via employment + notice.
- The SUPERVISOR is "the same party" as the agent (employer) for
  one-party-consent purposes.

The exception is CA, which has been interpreted more aggressively
(Kearney v. Salomon Smith Barney, 39 Cal.4th 95 (2006) extends to
interstate calls). C02's stricter-state-wins covers this. S02 inherits
C02's decision.

### 8.3 PUC-specific monitor disclosure rules

A few states have added explicit monitor-disclosure rules on top of
the recording rules:

| State | Cite | Requirement |
|---|---|---|
| CA | Cal. Pub. Util. Code §2890 (legacy) | Disclosure of monitoring in any QC recording |
| FL | FL Stat. §364.305 | Same |
| IL | 720 ILCS 5/14-2 (eavesdropping) | Already 2-party for recording; monitoring covered by recording |
| MA | Mass. Gen. Laws c.272 §99 | 2-party for "secret" interception; non-secret monitoring (with disclosure) is fine |
| PA | 18 Pa.C.S. §5704(15) (B2B carve-out) | C02 already handles |

The 2026 landscape per [TCPA Watch year-end 2025 review](https://tcpaworld.com/2025/12/30/2025-tcpa-class-action-summary/)
and [Lexology 2026 state wiretap update](https://www.lexology.com/library/detail.aspx?g=...)
shows no NEW jurisdictions added explicit monitor-disclosure rules in
2024-25, but the pattern of plaintiffs adding eavesdropping claims to
TCPA suits continues (cite C02 PLAN §0 bullet 1 — 31-41% of TCPA
suits in 2025 attached CIPA/IL-Eavesdropping claims).

### 8.4 Employee notice (Watkins compliance)

S02 IMPLEMENT must ensure that the employee notice is captured at
SIP-login. Concrete mechanism:

1. F05's login flow shows a one-time consent banner: "Your calls may
   be monitored, recorded, and reviewed by supervisors for quality
   assurance and training purposes. By logging in, you consent."
2. Login event writes `audit_log` row with `action=user.acknowledged_monitor_consent`,
   `acked_text_hash=<sha256-of-current-text>` so the auditable consent
   text version is preserved (text changes = re-ack required).
3. The supervisor monitor session validates that the agent has a
   current valid consent. If not, the API returns 412 Precondition
   Failed and the supervisor cannot start the session.

This adds a F05 dependency. S02 IMPLEMENT files an F05 amendment to
add the consent banner + audit row. Phase 1 is sufficient (no need to
defer).

### 8.5 Audit row schema for monitor sessions

S02 IMPLEMENT writes to the existing `audit_log` (C03-owned) with:

| `action` | `entity_type` | `entity_id` | `before_json` | `after_json` |
|---|---|---|---|---|
| `monitor.session.requested` | `monitor_session` | `<jti>` | NULL | `{tid, sup_uid, target_uid, mode}` |
| `monitor.session.authorized` | `monitor_session` | `<jti>` | NULL | `{token_exp, member_flags}` |
| `monitor.session.denied` | `monitor_session` | `<jti>` | NULL | `{reason}` |
| `monitor.session.started` | `monitor_session` | `<sup-call-uuid>` | NULL | `{tid, sup_uid, target_uid, mode, conf_name, member_id}` |
| `monitor.mode.changed` | `monitor_session` | `<sup-call-uuid>` | `{old_mode}` | `{new_mode, transition_seq}` |
| `monitor.session.ended` | `monitor_session` | `<sup-call-uuid>` | NULL | `{ended_at, duration_sec, reason}` |

All rows flow through the C03 hash-chain. The `monitor.session.*`
action prefix is reserved (S02 IMPLEMENT registers it in C03's
`audit_log.action` constants list — coordinate amendment with C03).

### 8.6 Retention

Same as `audit_log` — 7 years per C03 PLAN §11 / C04 retention. No
S02-specific retention.

---

## 9. UI / UX

### 9.1 Agent-side indicator

Agent UI shows a small banner:
```
🎧 1 supervisor listening
```
or
```
🎧 2 supervisors listening · 1 whispering
```

Tooltip on hover: "Supervisors monitor calls for quality and coaching.
You can continue normally."

Counts only, NO identification. Rationale: identification would create
social pressure that distorts the very behavior being monitored.
Industry standard (Five9, Genesys, NICE all aggregate).

Agent cannot disable the indicator. (Disclosure is non-negotiable
under Watkins.)

### 9.2 Supervisor wallboard (S01) — monitor entry point

From S01's wallboard view (the agent grid):
1. Supervisor clicks on an agent tile showing status `IN_CALL`.
2. Modal opens: "Monitor agent <name>"
3. Three buttons: **Listen** · **Whisper** · **Barge** (or a dropdown).
4. Optional: pre-flight info (campaign, lead phone last-4-digits,
   call duration so far, sentiment score if N03 ships).
5. On click, browser calls `POST /api/sup/monitor/start` then INVITEs.
6. Once joined, the modal becomes a "monitor session panel" with:
   - Current mode badge (Listen / Whisper / Barge)
   - Three buttons to switch modes
   - "End session" button
   - Live waveform of the supervisor's incoming mix (optional, N04-ish)

### 9.3 Multi-supervisor concurrent sessions

If supervisor B opens the same agent and starts a session while A is
already monitoring, B's UI must show "Already monitored by 1
supervisor" and proceed normally (no exclusion). The agent's banner
updates to "2 supervisors listening." A and B each see only their own
session panel; they do not see each other's mode unless we add a
"who else is monitoring" panel (out of scope for Phase 1; OPEN_Q).

### 9.4 Supervisor-on-mobile (Phase 1+)

Phase 1 web app is responsive; mobile browser SIP.js works in modern
iOS/Android Chrome with caveats (background-tab audio gets killed by
OS). For a true mobile experience, a future M-ios/M-android module
would wrap a native SIP stack. S02 PLAN need only ensure the web flow
works on a tablet (acceptable for Phase 1 supervisor-on-the-floor).

### 9.5 Confidence indicator for whisper

In whisper mode, the supervisor's voice must NOT leak to the customer.
We can't guarantee this perfectly (network jitter, FS mix-buffer race
conditions — see §10.3), so the UI should have a "If you hear the
customer reacting to your voice, end whisper immediately" tooltip on
the whisper button. This is a soft UX guard; the hard guard is the
`relate nospeak` primitive plus the §4.2 ordering rules.

---

## 10. Performance — concurrent monitor sessions

### 10.1 Per-session resource cost

A monitor session = 1 SIP leg + 1 conference member + 1 WSS connection
(supervisor's browser).

- **SIP/RTP cost**: identical to an agent call (one RTP stream into
  and out of FS). At PCMU 20 ms / 8 kHz, that's ~1 thread + ~16 KB/sec
  bandwidth.
- **Conference mix cost**: mod_conference does an O(N) mix per 20 ms
  per conference. Adding a supervisor turns a 2-member conf into a
  3-member conf — ~50% more mix work for THAT conference, but
  conferences are independent.
- **ESL event cost**: add-member + del-member + maybe a few `relate`
  command roundtrips. Trivial.
- **API cost**: one JWT mint + one audit row + one mode-change
  endpoint per transition. Trivial.

### 10.2 Concurrency bounds (F03 RESEARCH §9 sourced)

F03 RESEARCH §9 (the Artoo R2D2 thread-wall analysis) caps a single
FreeSWITCH host at ~1796 threads with 240 KB stacks. Each conference
member is 1 thread. With 50 agents in conferences plus 50 customers
in conferences = 100 members baseline. Adding 50 concurrent monitor
sessions adds 50 members → 150 total. Well below the thread wall.

CPU is the actual bottleneck. F03 RESEARCH §9 estimates ~50 mixes per
core. At 50 agents × 4 typical members (agent + cust + 2 sups) = 200
members across 50 conferences = ~50 mix groups. One core handles
~50 such conferences mixing at 8 kHz/20 ms (per [SignalWire 2024
production note](https://signalwire.com/blog/freeswitch-performance-tuning)).
Two cores comfortably handle 100 conferences.

**Phase-1 Practical capacity:** 50 agents × 100% in-call × 1 supervisor
per agent = 50 monitor sessions. Conservatively-budgeted Phase-1 host
(2 vCPU dedicated, 8 GB RAM, F01 docker-compose default) handles this
with headroom.

### 10.3 Latency

mod_conference mix is sample-aligned to the 20 ms interval. Adding a
member doesn't increase the mix-cycle latency for other members.
Supervisor's voice in barge / whisper is mixed in the same 20 ms tick,
so end-to-end latency from supervisor mouth to agent ear is ~80-120 ms
(typical WebRTC + RTP + mix), indistinguishable from a normal call.

`relate` state changes are atomic under the conference mutex. The
mutex window is ~10 µs; the next mix tick (within 20 ms) reflects the
new relate state. No multi-frame "leak window" is possible at the
mixer level. The leak risk in §4.2 is at the API-call ordering level
between `unmute` and `relate`, not at the mixer level.

### 10.4 Stress scenarios

| Scenario | Expected behavior |
|---|---|
| 5 supervisors monitor 1 agent simultaneously | Conference has 7 members (agent + customer + 5 sups); max-members=20 not hit; mix CPU ~3× baseline for THAT conf |
| 50 supervisors monitor 50 different agents | 100 confs × 4 members = 400 members; well within thread + CPU budget |
| Burst: 20 sups all click "Listen" on same agent at same second | 20 sequential adds; ~200 ms for all member-add events to fire; max-members=20 caps it; the 21st gets 503 from `Member count limit reached` |
| Sup hot-toggles mode 10×/sec | API rate limiter (S02 IMPLEMENT) throttles to 1/sec per session; rapid toggling is suspicious, rate-limit + alert |

---

## 11. Test plan

### 11.1 Unit tests

1. **Transition table:** for every (from, to) pair, the correct API
   call sequence is emitted in the correct order. Includes the
   §4.2 ordering rules.
2. **Multi-customer:** when a 3-way conference has agent + cust + 3rd,
   joining in whisper mode issues `relate nospeak` for BOTH cust and
   3rd, in any order, idempotent.
3. **Token validation:** valid token → 200; expired → 401; wrong
   tid → 403; wrong target_uid → 403; replay (jti reused) → 401.
4. **Cross-tenant guard:** API explicitly rejects sup-uid from tid=1
   asking to monitor target-uid in tid=2 even if both uids happen to
   be numerically equal.
5. **No-such-agent guard:** target is logged out → `ConferenceList`
   returns empty → API returns 404 `agent_not_in_call`.

### 11.2 Integration tests (require F03 + T03 + A02 IMPLEMENT done)

1. SIPp scenario: supervisor INVITEs `*81_1042_listen`, dialplan
   validates token, joins conference, sup hears agent's audio,
   customer does NOT hear sup. Audit rows present.
2. SIPp scenario: supervisor INVITEs `*81_1042_whisper`, sup speaks,
   agent hears, customer does NOT hear. Audit rows.
3. SIPp scenario: supervisor INVITEs `*81_1042_barge`, sup speaks,
   both agent AND customer hear. Audit rows.
4. Mode-switch test: start in listen, switch to whisper (API call),
   verify in mid-call SIPp scenario that the customer's RTP no longer
   contains sup's audio (silence detection). Switch back to listen,
   verify sup mic is muted.
5. Agent-logout-during-monitor: agent's softphone disconnects mid-
   monitor; sup's leg is auto-dropped within `endconf-grace-time=5 s`;
   sup's UI shows "Session ended: agent logged out."
6. Sup-disconnect-during-monitor: sup's browser closes; sup leg
   leaves via BYE; conference continues without sup; agent banner
   updates.

### 11.3 Compliance test (CRITICAL)

Record a synthetic conference call with sup in each mode, then verify
the resulting customer-leg recording file contains:
- Eavesdrop: agent's voice + customer's voice; NO supervisor voice
  detected (spectral comparison against a known sup tone).
- Whisper: same. NO supervisor voice in customer recording.
- Barge: agent + customer + supervisor all detected.

This test is binary: any sup voice detected in eavesdrop or whisper
recording = test FAIL = compliance bug = block release.

### 11.4 Stress test

20-supervisor concurrent join on a single agent's conference.
max-members=20 hit; 21st rejected gracefully.

### 11.5 Audit completeness test

Every monitor session must produce: 1 `authorized` + 1 `started` + N
`mode.changed` (where N = transitions) + 1 `ended`. After 100 random
session traces, run C03's verifier; chain integrity holds.

---

## 12. Open questions for PLAN

1. **Q1. `relate` vs `mute` priority during whisper.** If we issue
   `relate <SUP> <CUST> nospeak` AND `mute <SUP>` simultaneously, what
   happens? Does `mute` override `relate` (sup→nobody hears sup) or does
   `relate` win (sup→only cust filtered)? FS source inspection of
   `conference_loop.c:conference_loop_output()` suggests `mute` is the
   gate before mix; relate is post-mix routing. So mute > relate.
   This matters for eavesdrop → whisper ordering (we documented in
   §4.2 — relate first, then unmute) and the inverse. PLAN should
   confirm via empirical test in IMPLEMENT.

2. **Q2. Multi-supervisor mode collision.** Sup A is in whisper, sup B
   joins in barge. Customer hears B but not A; agent hears both. Is
   that semantically right? RESEARCH says yes (each sup's relate is
   per-pair, independent). PLAN should explicitly affirm in the
   acceptance criteria.

3. **Q3. Team scope.** Phase 1 ships tenant-only authorization. When
   to add team scope? OPEN_Q for M01 (admin module) coordination.

4. **Q4. Hardphone DTMF mode-switch.** Phase 1 implements DTMF
   `*1`/`*2`/`*3` mid-session toggles or defers to "API-only"? Trade-
   off is hardphone supervisor support vs added complexity (DTMF eaters
   in dialplan). RESEARCH leans defer; PLAN to decide.

5. **Q5. Recording-mask during whisper.** No-op (RESEARCH default) or
   `uuid_record mask`? Tied to R01 architecture. Coordinate.

6. **Q6. Customer-side join beep on barge.** Some platforms play a
   short beep to the customer when a supervisor barges in. C02's
   consent message covers this verbally; do we need an additional
   beep? RESEARCH leans no; PLAN to decide.

7. **Q7. Conference recording during monitoring vs per-leg.** If R01
   ever switches to conference-mix recording, the supervisor's voice
   in whisper mode WOULD end up in the recording. R01 must commit to
   per-leg only. Coordinate with R01.

8. **Q8. Monitor session resumption after sup browser refresh.** If
   sup hits F5 mid-session, SIP leg dies. Should we resume
   automatically on reconnect? RESEARCH leans no — explicit re-join.
   PLAN to decide.

9. **Q9. Audit row write latency budget.** Each mode change writes 1
   audit row; the API endpoint shouldn't return until the row is
   chained (C03 trigger ~200 µs). 1 mode change = ~200 µs DB +
   network. Acceptable. PLAN to confirm in API endpoint design.

10. **Q10. Mobile / tablet support.** Phase 1 web-responsive only or
    add native? OPEN_Q.

11. **Q11. Inter-tenant monitor (managed-services use case).** A
    managed-services tenant overseeing multiple end-tenants might want
    one supervisor to monitor agents across tenants. Phase 1 = no.
    Phase 4 = OPEN_Q.

12. **Q12. Coaching audio injection (one-way recorded prompt to agent
    only) without sup actively speaking.** Some platforms let a
    supervisor pre-record a coaching tip and inject it on demand
    (`uuid_broadcast` to agent leg). T01 PLAN §8 `UUIDBroadcast` exists.
    Is this in S02 scope or a separate module? RESEARCH leans
    separate (call it S04). PLAN to confirm.

---

## 13. Citations

| # | Source | URL / file path |
|---|---|---|
| 1 | RFC-002 conference naming | `spec/rfc/RFC-002-conference-naming.md` |
| 2 | T03 PLAN agent conference | `spec/modules/T03/PLAN.md` |
| 3 | T03 RESEARCH §5.4 (supervisor barge) | `spec/modules/T03/RESEARCH.md` lines 510-520 |
| 4 | F03 PLAN §4.4 feature codes stub | `spec/modules/F03/PLAN.md` lines 543-562 |
| 5 | F03 PLAN §5 conference profile | `spec/modules/F03/PLAN.md` lines 609-668 |
| 6 | T01 PLAN §8 ConferenceCommand | `spec/modules/T01/PLAN.md` lines 608-650 |
| 7 | T01 PLAN §17.10 to S02 | `spec/modules/T01/PLAN.md` lines 1270-1274 |
| 8 | A02 PLAN §0 (supervisor whisper hook) | `spec/modules/A02/PLAN.md` lines 84, 448-449 |
| 9 | C02 PLAN consent matrix | `spec/modules/C02/PLAN.md` lines 17-30 |
| 10 | C03 PLAN audit chain | `spec/modules/C03/PLAN.md` lines 1-30 |
| 11 | F05 RESEARCH RBAC roles | `spec/modules/F05/RESEARCH.md` lines 19, 347 |
| 12 | I01 RESEARCH supervisor eavesdrop on queued calls | `spec/modules/I01/RESEARCH.md` line 793 |
| 13 | SignalWire mod_conference docs | https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Modules/mod_conference_3965534/ |
| 14 | FreeSWITCH confluence mod_conference | https://freeswitch.org/confluence/display/FREESWITCH/mod_conference |
| 15 | FreeSWITCH 1.10.12 source `conference_api.c` | https://github.com/signalwire/freeswitch/blob/v1.10.12/src/mod/applications/mod_conference/conference_api.c |
| 16 | FreeSWITCH 1.7 mod_conference mirror | https://www.freeswitch.org.cn/books/references/1.7-mod_conference.html |
| 17 | Genesys Cloud Listen/Coach/Barge | https://help.mypurecloud.com/articles/about-the-supervisor-listen-coach-barge-feature/ |
| 18 | Five9 Supervisor application | https://www.five9.com/products/applications/supervisor |
| 19 | NICE CXone Supervisor Monitor | https://help.nice-incontact.com/content/supervisor/monitorings.htm |
| 20 | ViciDial AST_agent_monitor.pl | https://github.com/billscholes/vicidial/blob/master/bin/AST_agent_monitor.pl |
| 21 | Watkins v. L.M. Berry, 704 F.2d 577 (11th Cir. 1983) | https://casetext.com/case/watkins-v-lm-berry-co |
| 22 | Kearney v. Salomon Smith Barney, 39 Cal.4th 95 (2006) | https://scholar.google.com/scholar_case?case=2879049057268651040 |
| 23 | 18 USC §2511 (federal wiretap) | https://www.law.cornell.edu/uscode/text/18/2511 |
| 24 | 47 CFR §64.501 (recording prompts) | https://www.ecfr.gov/current/title-47/chapter-I/subchapter-B/part-64/subpart-E/section-64.501 |
| 25 | TCPA Watch 2025 year-end review | https://tcpaworld.com/2025/12/30/2025-tcpa-class-action-summary/ |
| 26 | Conference Add Call Example (FS docs) | https://freeswitch.org/confluence/display/FREESWITCH/Conference+Add+Call+Example |
| 27 | freeswitch-users 2009-01 (3-way originate) | http://lists.freeswitch.org/pipermail/freeswitch-users/2009-January/037729.html |
| 28 | asterisk-users 2021-02 (ChanSpy DTMF) | https://lists.digium.com/pipermail/asterisk-users/2021-February/295765.html |
| 29 | digium-users 2019-10 (Barge latency) | https://lists.digium.com/pipermail/asterisk-users/2019-October/293487.html |
| 30 | SignalWire FS performance tuning | https://signalwire.com/blog/freeswitch-performance-tuning |

---

## STOP — Do not proceed to PLAN. Awaiting orchestrator review.
