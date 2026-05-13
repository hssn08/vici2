# Module S02 — Supervisor Live-Monitor (Eavesdrop / Whisper / Barge) — PLAN

| Field | Value |
|---|---|
| Track | Supervisor |
| Phase | 3 |
| Status | PLAN — input to IMPLEMENT |
| Author | S02-PLAN sub-agent (Claude Sonnet 4.6) |
| Date | 2026-05-13 |
| Companion RESEARCH | [`spec/modules/S02/RESEARCH.md`](./RESEARCH.md) — 30 citations |
| Governing RFC | [`spec/rfc/RFC-002-conference-naming.md`](../../rfc/RFC-002-conference-naming.md) — ACCEPTED |
| Depth reference | [`spec/modules/F02/PLAN.md`](../F02/PLAN.md) (structural model) |
| Cross-cutting deps | T03, T01, F03, A02, C02, C03, F05, R01 |

> **Scope.** This PLAN freezes the public surface of S02: conference model,
> three-mode mechanics, mode-transition ordering rules, endconf flag contract,
> cross-tenant enforcement, recording during monitoring, compliance/consent
> treatment, UI flows, concurrent-supervisor support, API endpoint shapes,
> audit schema, DTMF fallback deferral, files to create, test plan, acceptance
> criteria, and downstream dependencies/risks. **No Go or TypeScript code is
> produced here**; IMPLEMENT will produce code from this freeze.

---

## 0. TL;DR — 12-bullet decision summary

1. **Single-conference model FROZEN.** Supervisor joins the existing
   `agent_t<tid>_u<uid>@default` conference (RFC-002). No second conference,
   no uuid_bridge, no Asterisk ChanSpy analogue. The supervisor is another
   member with different flags. (RESEARCH §3.4, T03 PLAN §11.5.)
2. **Three modes via member flags + `relate`.** Eavesdrop = `mute` flag.
   Whisper = `relate <SUP> <CUST> nospeak` (no mute). Barge = no flags,
   no relate. Defined in §3 below.
3. **Mode transitions are zero-glitch API calls.** No SIP rejoin. ≤2
   `bgapi conference` API calls per transition. Strict ordering rules to
   prevent audio leak during transitions (§4).
4. **Supervisor leg is browser-INVITE, not server-originate.** Pre-flight
   `POST /api/sup/monitor/start` mints a 60-second JWT, then the browser
   INVITEs `sip:*8{tid}_{uid}_{mode}@default`. Latency ~200 ms vs ~600 ms
   for originate path (RESEARCH §5.1).
5. **endconf contract:** Agent leg `endconf=true`, supervisor leg
   `endconf=false`. Conference lifecycle is owned by the agent. Supervisor
   dropped automatically when agent logs out (RESEARCH §5.2).
6. **Cross-tenant enforcement is defense-in-depth.** F05 RBAC at the API
   layer + JWT `tid`-scope + dialplan `mod_xml_curl` re-validation at the
   FS layer. If API has a bug, the dialplan rejects. (§6.)
7. **Recording: per-leg on customer leg only.** Supervisor voice is absent
   from customer recording in eavesdrop and whisper modes by construction.
   In barge mode, supervisor voice IS captured (correct — full participant).
   No recording-mask in Phase 1. (§7.)
8. **C02 consent message covers monitoring.** Reuse C02's consent message
   with wording "monitored or recorded." No additional join-beep required
   provided the verbal disclosure is in place. Barge mode is a legal-review
   checkpoint if recording is active (§8).
9. **Supervisor UI: wallboard tile → modal → session panel.** Agent UI
   shows aggregate supervisor count (no identity disclosure). Concurrent
   supervisors on the same agent are allowed (max 20 per conf). (§9.)
10. **DTMF `*1/*2/*3` hardphone mode-switch: DEFERRED to Phase 1.5/Q4.**
    Mid-session mode transitions go through the API; DTMF codes remain as
    undocumented dialplan stubs (F03 §4.4). Resolves RESEARCH Open Q4. (§11.)
11. **API surface: three endpoints.** `POST /api/sup/monitor/start`, `PATCH
    /api/sup/sessions/:id/mode`, `DELETE /api/sup/sessions/:id`. Plus one
    internal FS webhook for hangup audit. (§12.)
12. **Audit: 6 action types through C03 chain.** `monitor.session.requested`,
    `monitor.session.authorized`, `monitor.session.denied`,
    `monitor.session.started`, `monitor.mode.changed`,
    `monitor.session.ended`. (§13.)

---

## 1. Goals + non-goals

### 1.1 Goals (in scope)

- **G1.** Freeze the three-mode mechanics on top of mod_conference 1.10.12.
- **G2.** Define the dialplan extension shape for supervisor entry
  (`80_supervisor_monitor.xml`).
- **G3.** Define mode-transition API calls and ordering rules.
- **G4.** Define the pre-flight API (`POST /api/sup/monitor/start`) and
  the mode-switch/end APIs.
- **G5.** Cross-tenant and cross-team scope enforcement contract.
- **G6.** Recording safety matrix: which modes include supervisor voice in
  which recording types.
- **G7.** C02 compliance treatment for monitoring in 13 two-party states.
- **G8.** C03 audit schema for all session lifecycle events.
- **G9.** Agent-side and supervisor-side UI contract.
- **G10.** Concurrent supervisor support (multi-supervisor on one agent).
- **G11.** T03 amendment required to correct the whisper-mode flag typo
  (§14.1).
- **G12.** Test plan covering unit, integration, compliance, stress, and
  audit-completeness scenarios.

### 1.2 Non-goals (explicit out-of-scope)

- **NG1.** Producing Go or TypeScript code (IMPLEMENT phase).
- **NG2.** Server-side originate path for supervisor leg (rejected; browser
  INVITE wins, RESEARCH §5.1).
- **NG3.** Second conference / uuid_bridge architecture (rejected, RESEARCH
  §3.4).
- **NG4.** DTMF `*1/*2/*3` hardphone mode-switch (deferred to Phase 1.5).
- **NG5.** Team-scoped authorization (Phase 1.5; tenant-only in Phase 1,
  RESEARCH §6.1).
- **NG6.** Recording-mask during whisper (no-op in Phase 1; revisit at
  customer request, RESEARCH §7.3).
- **NG7.** Inter-tenant cross-monitor (Phase 4 open question, RESEARCH §12.
  Q11).
- **NG8.** Pre-recorded coaching audio injection (`uuid_broadcast`); tracked
  as a future S04 module candidate (RESEARCH §12 Q12).
- **NG9.** Native mobile app supervisor UX (tablet-web only in Phase 1,
  RESEARCH §9.4).
- **NG10.** Conference recording switch to conference-mix stereo recording
  (R01 must stay per-leg; R01 contract in §7.4).

---

## 2. Single-conference model (FROZEN)

### 2.1 Inherited invariants (RFC-002 + T03 + F03)

The conference `agent_t<tid>_u<uid>@default` is created implicitly when the
agent's SIP.js INVITE reaches the T03 dialplan extension. The following are
frozen by T03 PLAN and RFC-002 and S02 must not override them:

| Member | Flags | Role |
|---|---|---|
| Agent (moderator) | `moderator,nomoh,endconf,join-only` | Conference lifecycle owner |
| Customer | (no flags, explicit empty `conference_member_flags=""`) | Participant; hangup does not tear down conf |
| Third-party | (no flags, `join-only`) | Optional; same as customer |
| **Supervisor** | Per-mode (§3.1 below) | **Defined by S02** |

The conference profile is `default` (F03 PLAN §5): silent enter/exit/alone,
`comfort-noise=true`, `rate=8000`, `interval=20`, `max-members=20`,
`endconf-grace-time=5s`. S02 relies on these; no profile changes required.

Member-id tracking is in Valkey HASH `t:{tid}:agent:{uid}:conf_members` (T03
PLAN §5.2). S02 extends this HASH to include supervisor entries keyed on the
supervisor call UUID, value `<mid>:supervisor:<mode>`.

### 2.2 Conference name helper usage

S02 IMPLEMENT must use only `conference.ConferenceFQN(tenantID, userID,
"default")` (Go) or `confFQN(tenantId, userId)` (TS) — never a raw string
literal. The RFC-002 lint guards are CI-blocking.

### 2.3 T03 RESEARCH §5.4 whisper-flag typo (CORRECTED HERE)

T03 RESEARCH §5.4 and T03 PLAN §11.5 state:

> Whisper (sup talks to agent only): `conference_member_flags=mute,deaf=false`

This is **semantically wrong**. `mute` means the supervisor's mic is muted
into the conference — the supervisor could not whisper at all. The correct
whisper implementation is:
- Supervisor joins with NO `mute` flag (unmuted mic).
- Post-join: `conference relate <SUP-MID> <CUST-MID> nospeak` prevents
  sup's audio from reaching the customer.

The correction is documented in §3 below and filed as T03 amendment §14.1.

---

## 3. Mode mechanics

### 3.1 Flag table (FROZEN)

| Mode | Join flags | Post-join API calls | Sup hears | Agent hears | Customer hears |
|---|---|---|---|---|---|
| **Eavesdrop** (listen-only) | `mute,join-only,endconf=false` | none | agent + customer | normal | normal |
| **Whisper** (sup→agent only) | `join-only,endconf=false` (no mute) | `relate <SUP> <CUST> nospeak` for every non-agent member | agent + customer | normal + supervisor | normal (NOT supervisor) |
| **Barge** (3-way) | `join-only,endconf=false` (no mute) | none | agent + customer | normal + supervisor | normal + supervisor |

Key design points:
- `endconf=false` is mandatory on every supervisor join. The supervisor must
  never be a conference lifecycle holder.
- `join-only` is mandatory. If the agent is not logged in (no conference
  exists), the join fails closed rather than creating an orphan conference.
- `hangup_after_conference=true` must be set on the supervisor's leg so
  the SIP leg terminates when the supervisor leaves the conference.

### 3.2 Eavesdrop mechanics

The supervisor joins with the `mute` member flag. mod_conference prevents
the supervisor's mic from being mixed into the conference output. The
supervisor receives the full conference audio mix (agent + customer). No
`relate` call is needed. This is the simplest mode.

To verify: `conference <name> list` shows the supervisor's member with the
`mute` flag set. The Valkey HASH entry for the supervisor member shows
`<mid>:supervisor:eavesdrop`.

### 3.3 Whisper mechanics (the `relate` primitive)

Whisper requires that the supervisor can speak into the conference BUT the
customer (and any third-party) does not receive the supervisor's audio. The
agent receives it normally.

The mod_conference `relate` primitive achieves this:

```
conference agent_t<tid>_u<uid> relate <SUP-MID> <CUST-MID> nospeak
```

This instructs the conference: "do not route SUP's audio into CUST's mix-out."
It is per-pair, one-way, and atomic under the conference mutex (applied at the
next 20 ms mix tick, ~10 µs mutex hold; RESEARCH §10.3).

**Multi-customer (3-way + supervisor):** When the agent's conference already
has a third-party transfer in progress, the whisper relate must cover ALL
non-agent members:

```
For each member M where M.role != agent AND M.role != supervisor:
  conference agent_t<tid>_u<uid> relate <SUP-MID> <M.mid> nospeak
```

S02's conf-maint handler (§5.3 below) enumerates non-agent members via
`T01.ConferenceList()` at join time. When a NEW member subsequently joins
the conference mid-monitor (additional 3rd-party transfer), the conf-maint
event handler must auto-issue the `relate nospeak` for the new member
against any active supervisor that is in whisper mode.

**Supervisor hears customer (by design):** We do NOT issue `relate <CUST>
<SUP> nohear`. The supervisor IS supervising this specific customer
interaction and must hear both parties. The asymmetry is intentional.

### 3.4 Barge mechanics

No flags, no `relate`. The supervisor is a fully participating conference
member. All three parties (agent, customer, supervisor) hear each other.
This is functionally identical to a 3-way transfer from mod_conference's
perspective.

In barge mode, the supervisor's voice WILL appear in the customer-leg
recording (§7 below). This is the correct and legally desired behavior since
the supervisor is actively participating in the customer conversation.

---

## 4. Mode transitions: zero-glitch ordering rules

### 4.1 Transition table

All transitions are ≤2 API calls via `T01.ConferenceCommand`. No SIP
re-INVITE or RTP disruption. The supervisor's audio leg stays up throughout.

| From | To | API sequence |
|---|---|---|
| Eavesdrop | Whisper | (1) `relate <SUP> <CUST> nospeak` (2) `unmute <SUP>` |
| Eavesdrop | Barge | (1) `unmute <SUP>` |
| Whisper | Eavesdrop | (1) `mute <SUP>` (2) `relate <SUP> <CUST> clear` |
| Whisper | Barge | (1) `relate <SUP> <CUST> clear` |
| Barge | Whisper | (1) `relate <SUP> <CUST> nospeak` |
| Barge | Eavesdrop | (1) `mute <SUP>` |

For transitions involving a 3-way conference, `<CUST>` above means ALL
non-agent, non-supervisor members (the relate calls are iterated per
RESEARCH §4.4).

### 4.2 Ordering rules (load-bearing for audio safety)

**Eavesdrop → Whisper (adding supervisor voice):**

Issue `relate nospeak` FIRST, then `unmute`. Rationale: if we unmuted
first, there is a ~millisecond window where the supervisor is audible to
the customer before the relate is applied. Issuing the relate first while
the supervisor is still muted is a no-op at the mixer (nothing to route),
then unmuting activates the route in its correct final state.

```
SAFE: (1) relate <SUP> <CUST> nospeak → (2) unmute <SUP>
UNSAFE: (1) unmute <SUP> → (2) relate <SUP> <CUST> nospeak
        (brief leak window between calls)
```

**Whisper → Eavesdrop (removing supervisor voice):**

Issue `mute` FIRST, then `relate clear`. Rationale: if we cleared the
relate first, there is a brief window where the customer can hear the
supervisor before the mute takes effect. Muting first silences the
supervisor atomically, then the relate cleanup is safe.

```
SAFE: (1) mute <SUP> → (2) relate <SUP> <CUST> clear
UNSAFE: (1) relate <SUP> <CUST> clear → (2) mute <SUP>
        (brief leak window)
```

**Barge ↔ Whisper:** Only `relate` toggles; supervisor is unmuted in both
states. No ordering concern.

**Barge ↔ Eavesdrop:** Only `mute`/`unmute`; no relate. Atomic. No ordering
concern.

### 4.3 Rate limiting on mode switches

A supervisor toggling mode faster than 1 switch per second is suspicious
(RESEARCH §10.4). S02 IMPLEMENT must apply a per-session rate limiter:
`VICI2_MONITOR_MODE_SWITCH_RATE=1` (1 switch/sec/session, configurable).
Excess requests return `429 Too Many Requests`. Metric:
`vici2_monitor_mode_switch_rate_limited_total`.

### 4.4 Open question resolution: `relate` vs `mute` priority

RESEARCH §12 Q1: when `mute` and `relate nospeak` coexist, does `mute` win?
FS source (`conference_loop.c`) processes `mute` as a gate BEFORE the mix;
`relate` is post-mix routing. Therefore: `mute` takes precedence — a muted
member's audio never reaches the mixer, so `relate nospeak` is a no-op while
`mute` is active. This validates the ordering rules above. IMPLEMENT must
empirically verify in an integration test.

### 4.5 Browser-refresh resumption (resolves RESEARCH Q8)

**Decision:** No automatic resumption. If the supervisor's browser refreshes
mid-session, the SIP leg sends BYE, the conference member is removed, the
audit row `monitor.session.ended` is written with `reason=supervisor_disconnect`.
The supervisor must explicitly re-initiate via `POST /api/sup/monitor/start`.
Rationale: automatic reconnect-and-rejoin is complex and could create
duplicate audit sessions. Explicit re-join is simpler and more auditable.

---

## 5. Supervisor leg creation

### 5.1 Pre-flight API call

Before the browser places the SIP INVITE, it calls:

```
POST /api/sup/monitor/start
{
  "target_uid": 1042,
  "initial_mode": "listen" | "whisper" | "barge"
}
Authorization: Bearer <supervisor_jwt>
```

The API performs in order:
1. F05 RBAC: role check (`supervisor` or higher) + tenant scope.
2. Agent-in-call check: `t:{tid}:agent:{target_uid}` status must be
   `IN_CALL` (not READY, WRAPUP, or LOGOUT). Returns 404 if agent not
   found or 409 if agent not on a call.
3. Member budget: `conference list` count < 18 (leaves 2 slots headroom
   for 3-way transfers). Returns 503 if budget exceeded.
4. Agent consent check: target agent must have a current
   `user.acknowledged_monitor_consent` audit row (§8.4). Returns 412 if
   missing.
5. Mint a 60-second JWT (`monitor_grant_token`) with:
   `{iss, sub, tid, role, monitor_target_uid, monitor_initial_mode, iat, exp, jti}`.
   `jti` stored in Valkey as `SET vici2:monitor:jti:<jti> 1 EX 90 NX` for
   one-time use enforcement.
6. Write `monitor.session.requested` audit row (C03).
7. Write `monitor.session.authorized` audit row (C03).
8. Return `{token, expires_at, target_conf_name, dial_extension}`.

`dial_extension` = `*8{tid}_{target_uid}_{mode}` (e.g., `*81_1042_listen`).

### 5.2 Browser INVITE

The browser immediately places:
```
INVITE sip:*81_1042_listen@<fs-domain>
X-Vici2-Monitor-Token: <jwt>
```

SIP.js `SimpleUser` reuses the existing supervisor softphone (A02 PLAN §0.7).
The supervisor shares the same `SimpleUser` instance as for their own
agent-mode audio; a supervisor can only be in one monitor session per browser
tab. Multi-monitor requires multiple tabs.

### 5.3 Dialplan extension shape

S02 IMPLEMENT creates
`freeswitch/conf/dialplan/default/80_supervisor_monitor.xml`:

```xml
<extension name="supervisor_monitor_join">
  <condition field="destination_number"
             expression="^\*8(\d+)_(\d+)_(listen|whisper|barge)$">
    <!-- $1=tid  $2=target_uid  $3=initial_mode -->
    <!-- SIP digest auth has already run; sip_authorized_user is attacker-
         unforgeable (T03 PLAN §2.1). -->
    <condition field="${sip_authorized_user}" expression="^\d+$" break="never">
      <action application="set" data="vici2_mon_tid=$1"/>
      <action application="set" data="vici2_mon_target=$2"/>
      <action application="set" data="vici2_mon_mode=$3"/>
      <action application="set"
              data="vici2_mon_token=${sip_h_X-Vici2-Monitor-Token}"/>
      <!-- mod_xml_curl callout: validates token, role, tenant, returns
           200 OK or 403 Forbidden. Cost: ~5-15 ms/join; acceptable for
           low-frequency monitor events. -->
      <action application="set"
              data="api_hangup_hook=curl http://api:3000/internal/freeswitch/monitor_end?call=${uuid}"/>
      <action application="execute_extension"
              data="supervisor_monitor_${vici2_mon_mode} XML default"/>
      <anti-action application="respond" data="403 Forbidden"/>
    </condition>
  </condition>
</extension>

<extension name="supervisor_monitor_listen">
  <condition field="destination_number" expression="^supervisor_monitor_listen$">
    <action application="answer"/>
    <action application="set" data="vici2_role=supervisor"/>
    <action application="set" data="hangup_after_conference=true"/>
    <action application="conference"
            data="agent_t${vici2_mon_tid}_u${vici2_mon_target}@default+flags{mute,join-only,endconf=false}"/>
  </condition>
</extension>

<extension name="supervisor_monitor_whisper">
  <condition field="destination_number" expression="^supervisor_monitor_whisper$">
    <action application="answer"/>
    <action application="set" data="vici2_role=supervisor"/>
    <action application="set" data="hangup_after_conference=true"/>
    <!-- No mute: supervisor speaks; conf-maint handler issues relate nospeak -->
    <action application="conference"
            data="agent_t${vici2_mon_tid}_u${vici2_mon_target}@default+flags{join-only,endconf=false}"/>
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

Whisper and barge extensions are structurally identical at INVITE time; the
conf-maint handler post-join distinguishes them by `vici2_mon_mode` and issues
the `relate nospeak` for whisper.

### 5.4 Conf-maint handler addition (T03 amendment)

T03's `agentPresenceConfMaintHandler` (T03 PLAN §5) currently branches on
`vici2_role` for `agent`, `customer`, `third`. S02 extends it with a
`supervisor` branch:

```
on add-member where vici2_role == "supervisor":
  HSET t:{tid}:agent:{target_uid}:conf_members
       <sup-call-uuid> "<mid>:supervisor:<mode>"

  HSET t:{tid}:monitor:<sup-call-uuid>
       tid=<tid> target_uid=<target_uid> sup_uid=<sup_uid>
       mode=<mode> conf_member_id=<mid> started_at=<ts>

  ZADD t:{tid}:agent:{target_uid}:monitors <ts> <sup-call-uuid>

  XADD events:vici2.monitor.session_started *
       {tid, target_uid, sup_uid, mode, started_at}

  IF mode == "whisper":
    enumerate non-agent members M in conference:
      T01.ConferenceCommand(ctx, confName, "relate",
                            fmt.Sprintf("%d %d nospeak", supMid, M.mid))

on del-member where vici2_role == "supervisor":
  HDEL t:{tid}:agent:{target_uid}:conf_members <sup-call-uuid>
  ZREM t:{tid}:agent:{target_uid}:monitors <sup-call-uuid>
  DEL  t:{tid}:monitor:<sup-call-uuid>
  XADD events:vici2.monitor.session_ended *
       {tid, target_uid, sup_uid, reason="member_left"}
  -- api_hangup_hook fires separately to write the C03 audit row

on add-member where vici2_role == "customer" OR "third":
  -- check if any active supervisors in whisper mode
  FOR EACH sup-uuid IN t:{tid}:agent:{target_uid}:monitors:
    IF monitor.<sup-uuid>.mode == "whisper":
      T01.ConferenceCommand(ctx, confName, "relate",
                            fmt.Sprintf("%d %d nospeak", supMid, newMid))
```

This is a small, additive change to T03's handler. S02 IMPLEMENT files it
as a T03 amendment (see §14.2).

---

## 6. Cross-tenant scope enforcement

### 6.1 Phase 1: tenant-only authorization

F05 RBAC enforces role (`supervisor` or higher) + tenant scope: every
resource lookup must satisfy `resource.tenant_id == jwt.tid`. A supervisor
in tenant A cannot obtain a `monitor_grant_token` for an agent in tenant B,
because the pre-flight API validates target agent's `tenant_id` against the
JWT `tid`.

**Team scope is Phase 1.5.** Phase 1 ships tenant-only — any supervisor in
the tenant may monitor any agent in the same tenant. A team model (M01 TBD)
is the Phase 1.5 gate. S02 IMPLEMENT adds an `// TODO(Phase-1.5): team-scope
check` comment and a feature-flag hook at the authorization point.

### 6.2 Defense-in-depth (dialplan layer)

API-side authorization is necessary but not sufficient. The dialplan provides
a second enforcement layer via mod_xml_curl:

1. **SIP digest auth** (F03 `wss` profile): `${sip_authorized_user}` is
   attacker-unforgeable. No unauthenticated caller can reach the dialplan.
2. **mod_xml_curl callout** to `api/internal/freeswitch/monitor_authz` with
   `{caller_uid, target_tid, target_uid, mode, token}`. The API re-validates:
   token signature + expiry, role, tenant scope, `jti` one-time use. Returns
   200 OK (with member flags as channel vars) or 403 Forbidden.
3. **Tenant prefix check**: the dialplan regex captures `$1` as `tid`. The
   callout compares `jwt.tid == $1`. Mismatch = 403.

Callout cost ~5-15 ms per join (acceptable; monitor joins are low-frequency).
Mode transitions after join do NOT re-trigger the callout; they use the API
directly. The grant token is single-use (jti) and expires in 60 seconds.

### 6.3 Audit-denial path

When authorization fails at any layer (API, dialplan, jti replay), a
`monitor.session.denied` audit row is written with a `reason` field:

| Reason | Trigger |
|---|---|
| `role_insufficient` | JWT role < supervisor |
| `tenant_mismatch` | JWT tid != target tenant_id |
| `token_expired` | JWT exp in the past |
| `token_replay` | jti already used |
| `agent_not_in_call` | Target agent is READY/LOGOUT |
| `member_budget_exceeded` | Conference at 18+ members |
| `agent_consent_missing` | Target agent has no monitor-consent audit row |

All denied rows flow through C03's hash chain. SOC 2 CC7.2, NIST 800-53
AU-9 require failed-access logging.

---

## 7. Recording during monitoring

### 7.1 Per-leg customer recording (current R01 model)

R01 records the customer leg via `record_session` set on the customer channel
BEFORE the customer is `uuid_transfer`'d into the agent's conference
(T03 PLAN §7, F03 PLAN §5). `RECORD_STEREO=true`. This records the audio
that the customer channel carries: the customer transmits + the customer
receives (which is the conference mix-out to the customer).

### 7.2 Mode-by-mode recording safety matrix

| Mode | Sup mic into conf | Relate nospeak active | Sup in customer mix-out | Sup voice in customer recording | Correct? |
|---|---|---|---|---|---|
| Eavesdrop | NO (mute) | NO | NO | **NO** | YES |
| Whisper | YES | YES | NO | **NO** | YES |
| Barge | YES | NO | YES | **YES** | YES (3-way participant) |

The matrix is correct by construction. No additional filtering needed.

**Edge case: barge + recording consent.** When a supervisor barges in while
C02's recording is active, the supervisor's voice will be captured. This is
the correct legal and operational behavior (supervisor is a full participant).
However, in PA (B2B carve-out under §5704(15)) and potentially in other
2-party states, the supervisor joining a recorded call may affect the
recording's admissibility. This is flagged as a legal-review checkpoint (§8.3).

### 7.3 Phase 1 recording-mask decision (resolves RESEARCH Q5)

**Decision: no `uuid_record mask` during whisper.** Recording is continuous.
The whisper's absence from the customer recording is guaranteed by `relate
nospeak` (§7.2 matrix above). Recording mask adds complexity (mask state
audit, gap in recording playback) with no additional privacy benefit given
the per-leg customer recording model.

This decision is conditional on R01 keeping the per-leg customer recording
model. See §7.4.

### 7.4 R01 contract (load-bearing)

S02 requires R01 to commit to the following in its PLAN:

1. **Per-leg customer recording only** in Phase 1 and Phase 2. Conference-mix
   recording (conference `record-session` param) is forbidden in the `default`
   profile.
2. **No per-agent-leg recording** unless accompanied by an S02 amendment
   review (agent-leg recording would capture whisper audio — see RESEARCH §7.2).
3. **Stereo customer recording** (`RECORD_STEREO=true`) is fine and expected.

S02 IMPLEMENT files an R01 amendment request formalizing this contract.

### 7.5 Agent-leg recording (future)

If R01 adds per-agent-leg recording in Phase 4+, supervisor whisper audio
WILL appear in the agent-leg recording. This is operationally intentional
(coaching playback for training). The legal basis is the Watkins business-
extension exception (11th Cir. 1983) + the employee monitor-consent notice
(§8.4 below). The S02/R01 amendment must coordinate on this.

---

## 8. Compliance + consent

### 8.1 Federal floor

18 USC §2511(2)(d) permits one-party consent. Supervisor monitoring of an
employee's call falls under the Watkins v. L.M. Berry (11th Cir. 1983)
business-extension exception: the employer party has consent, and the
employee is the other "party" who gives implied consent via employment and
notice. The customer's consent is governed by C02 (§8.2 below).

### 8.2 C02 interaction (13 two-party states)

C02 governs whether the customer's call can be recorded. C02's consent
message ("This call may be monitored or recorded for quality assurance
purposes") covers BOTH recording AND monitoring under 47 CFR §64.501 and
the state PUC analogues. No additional join-beep is required when the verbal
disclosure is present.

**S02 amendment to C02 (§14.3):** File a C02 amendment requesting that the
default `consent_msg_audio` wording explicitly includes "monitored or
recorded" (not just "recorded"). This is a content change to the audio file,
not a schema or code change.

**Barge + consent (resolves RESEARCH Q6):** No additional customer-side
beep on barge in Phase 1. The C02 verbal disclosure covers it. Legal-review
checkpoint for customers in CA, FL, IL, MA, WA who request explicit barge
notification — they may configure a `campaigns.consent_policy_override` of
`REQUIRE_ACTIVE` which already covers it.

### 8.3 PA B2B carve-out interaction

C02 PLAN §0 bullet 7: the PA §5704(15) B2B carve-out applies when
`LeadIsBusiness=true` AND `campaigns.recording_purpose ∈ {training,
quality_control, monitoring}`. Supervisor monitoring in barge mode is
`recording_purpose=monitoring`. When the carve-out applies, C02 downgrades
from `PROMPT_MESSAGE` to `ALLOW`, meaning no consent prompt is played.

This is the correct behavior: PA's B2B carve-out explicitly covers
"telephone marketing, quality control monitoring" calls. No S02 change
required; C02 handles.

### 8.4 Employee monitor-consent notice (Watkins compliance)

The supervisor monitor session is valid under Watkins only if the agent
(employee) was notified. S02 IMPLEMENT must:

1. F05 login flow shows a consent banner: "Your calls may be monitored,
   recorded, and reviewed by supervisors for quality assurance and training
   purposes. By logging in, you consent."
2. Login event writes `audit_log` row with
   `action=user.acknowledged_monitor_consent`,
   `after_json={"acked_text_hash": "<sha256-of-current-text>"}`.
3. Pre-flight API (`POST /api/sup/monitor/start`) validates that target agent
   has a current valid consent row. If the consent text has changed since the
   agent last acked, the API returns `412 Precondition Failed` and the agent
   must re-login.

This adds a dependency on F05 IMPLEMENT. S02 IMPLEMENT files an F05 amendment
(§14.4).

### 8.5 Barge mode + active recording — legal review checkpoint

When a supervisor barges into a call where C02 has already authorized a
`PROMPT_MESSAGE` consent (the customer agreed by staying on the line after
the message), the supervisor's voice in the recording is legally in scope of
that consent. However, the consent message was given BEFORE the supervisor
joined — in strict interpretations of FL, MA, and WA statutes, this could be
contested.

**Phase 1 posture:** Accept this risk; barge is an uncommon mode and the
consent message "This call may be monitored or recorded" is present.
**Phase 2 checkpoint:** Legal review of barge-in-recorded-call in FL/MA/WA
with a recommendation on whether to add a mid-call "This call is now being
monitored by a supervisor" announcement before enabling barge.

---

## 9. UI contracts

### 9.1 Supervisor entry flow (S01 wallboard)

1. Supervisor views S01 wallboard; agent grid shows agents with status badges.
2. Supervisor clicks an agent tile with status `IN_CALL`.
3. Modal opens: agent name, campaign, call duration. Three action buttons:
   **Listen** · **Whisper** · **Barge**.
4. Optional pre-flight info: lead last-4 phone digits, call duration, waveform
   (N04-ish; deferred to Phase 1.5 if N04 is not ready).
5. Supervisor clicks a mode button → browser calls `POST /api/sup/monitor/start`
   → receives `{token, dial_extension}`.
6. Browser places `INVITE sip:<dial_extension>@<domain>` via SIP.js `SimpleUser`.
7. After INVITE is answered (dialplan returns 200 OK): modal transitions to a
   **monitor session panel**:
   - Current mode badge (Listen / Whisper / Barge)
   - Mode-switch buttons (clicking changes mode via `PATCH /api/sup/sessions/:id/mode`)
   - "End session" button → `DELETE /api/sup/sessions/:id` + SIP.js BYE
   - Session duration counter
   - Waveform of the supervisor's incoming audio (deferred to N04/Phase 1.5)

### 9.2 Agent-side monitoring indicator

When `t:{tid}:agent:{uid}:monitors` becomes non-empty, the A03 WebSocket
gateway pushes a `monitor_active` event to the agent's browser. The agent UI
shows a banner:

- "1 supervisor listening" (eavesdrop)
- "1 supervisor coaching" (whisper)
- "1 supervisor in conversation" (barge)
- "2 supervisors: 1 listening, 1 coaching" (multi-sup aggregate)

**No individual identity is disclosed to the agent** (counts and modes only).
Rationale: individual identification creates social pressure that distorts the
monitored behavior (RESEARCH §9.1; same approach as Five9, Genesys, NICE).

The agent CANNOT disable the indicator. Disclosure is non-negotiable under
the Watkins business-extension exception — absence of notification would void
the legal basis for monitoring.

When the last supervisor leaves, `t:{tid}:agent:{uid}:monitors` becomes empty
and the banner is cleared.

### 9.3 Concurrent supervisors on the same agent

**Multiple concurrent supervisors on the same agent are allowed.**
`max-members=20` (F03 default profile) provides the hard ceiling. Practical
limit: S02 enforces `member_budget < 18` at pre-flight, leaving 2 slots for
3-way transfers.

When a second supervisor opens the monitor modal for an agent already being
monitored, the modal shows: "This agent is already being monitored by 1
supervisor. You may still join." The agent's banner aggregates.

Each supervisor sees only their own session panel. Multi-supervisor "who
else is monitoring" panel is deferred to Phase 1.5 (OPEN_Q).

Multi-supervisor mode independence: Sup A in whisper, Sup B in barge. Sup A's
`relate nospeak` (SUP_A ↔ CUST) is per-pair; Sup B's barge is unrestricted.
The customer hears Sup B but NOT Sup A. The agent hears both. This is
semantically correct and affirmed by RESEARCH §12 Q2 as an acceptance
criterion.

### 9.4 Supervisor disconnect handling

When the supervisor's browser disconnects (network drop, tab close, page
refresh):
1. SIP.js sends BYE on the sup leg.
2. mod_conference fires `del-member`; conf-maint handler clears Valkey state.
3. `api_hangup_hook` fires to the API; API writes `monitor.session.ended`
   audit row with `reason=supervisor_disconnect`.
4. Agent's banner updates (count decremented).
5. Agent's conference is unaffected (supervisor had `endconf=false`).

The supervisor's monitor session panel shows "Session ended: connection lost."
No automatic reconnect (RESEARCH §12 Q8 decision, §4.5 above).

---

## 10. DTMF hardphone fallback (DEFERRED)

F03 PLAN §4.4 stub-defines `*1`/`*2`/`*3` codes for mode switching on the
supervisor's in-call leg. These are deferred to Phase 1.5/Q4.

**Phase 1 resolution:**
- The `*1`/`*2`/`*3` DTMF codes remain in F03 as undocumented stubs.
- Mid-session mode switches go through `PATCH /api/sup/sessions/:id/mode` only.
- A supervisor on a hardphone (no web UI) can ENTER a monitor session via the
  normal dial extension `*8{tid}_{uid}_{mode}` if their hardphone is registered
  to FS and they know the extension pattern. But mid-session mode switching
  is API-only in Phase 1.

**Phase 1.5 scope (DTMF mode-switch):** When implemented, `*1`/`*2`/`*3`
will use `bind_meta_app` on the supervisor's leg to eat the DTMF and call
the mode-transition API. Key challenges: (a) WebRTC legs generate DTMF as
RFC 2833 or SIP INFO inconsistently; (b) DTMF leaking into the conference
mix before `bind_meta_app` can eat it. Server-side API is the more reliable
path; DTMF is strictly a convenience fallback for hardphone users.

---

## 11. API endpoints

### 11.1 `POST /api/sup/monitor/start`

**Authorization:** JWT with role `supervisor`, `admin`, or `super_admin`.

**Request:**
```json
{
  "target_uid": 1042,
  "initial_mode": "listen" | "whisper" | "barge"
}
```

**Response 200 OK:**
```json
{
  "session_id": "<jti>",
  "token": "<monitor_grant_jwt>",
  "expires_at": "<iso8601>",
  "dial_extension": "*81_1042_listen",
  "target_conf_name": "agent_t1_u1042"
}
```

**Error responses:**
| Status | Body `code` | Condition |
|---|---|---|
| 403 | `role_insufficient` | JWT role too low |
| 403 | `tenant_mismatch` | Target agent in different tenant |
| 404 | `agent_not_found` | No agent with target_uid in this tenant |
| 409 | `agent_not_in_call` | Agent status is not IN_CALL |
| 412 | `agent_consent_missing` | Agent has no current monitor-consent audit row |
| 503 | `member_budget_exceeded` | Conference already at 18 members |

**Audit rows written:** `monitor.session.requested`, then either
`monitor.session.authorized` (200) or `monitor.session.denied` (4xx/5xx).

### 11.2 `PATCH /api/sup/sessions/:id/mode`

**Authorization:** JWT of the supervisor who owns session `:id` (jti).

**Request:**
```json
{
  "mode": "listen" | "whisper" | "barge"
}
```

**Response 200 OK:**
```json
{
  "session_id": "<jti>",
  "previous_mode": "listen",
  "mode": "whisper",
  "transitioned_at": "<iso8601>"
}
```

**Error responses:**
| Status | Body `code` | Condition |
|---|---|---|
| 404 | `session_not_found` | No active session with this id for this supervisor |
| 409 | `same_mode` | Requested mode is already active |
| 429 | `rate_limited` | Mode switch rate > 1/sec |

Implementation: looks up session from `t:{tid}:monitor:<sup-call-uuid>`,
resolves member IDs from Valkey, calls `T01.ConferenceCommand` for the
appropriate transition sequence (§4.1 ordering rules), updates Valkey state,
writes `monitor.mode.changed` audit row.

**Audit row:** `monitor.mode.changed` with `before_json={mode: old}`,
`after_json={mode: new, transition_seq: N}`.

### 11.3 `DELETE /api/sup/sessions/:id`

**Authorization:** JWT of the supervisor who owns session, OR any admin/super_admin.

**Response 204 No Content.**

Implementation: calls `T01.ConferenceCommand(confName, "kick", supMemberID)`.
The BYE flows back to the supervisor's SIP.js. The `api_hangup_hook` fires
to write the `monitor.session.ended` audit row.

**Audit row:** `monitor.session.ended` via hangup hook.

### 11.4 Internal: `GET /internal/freeswitch/monitor_authz`

Called by the FS dialplan via mod_xml_curl. Not a public-facing endpoint.

**Query params:** `caller_uid`, `target_tid`, `target_uid`, `mode`, `token`.

**Response 200 OK** (with XML-format channel variables for FS):
```xml
<document type="freeswitch/xml">
  <section name="result">
    <result status="200"/>
  </section>
</document>
```

**Response 403 Forbidden:**
```xml
<document type="freeswitch/xml">
  <section name="result">
    <result status="403" reason="token_invalid"/>
  </section>
</document>
```

### 11.5 Internal: `POST /internal/freeswitch/monitor_end`

Called by `api_hangup_hook` when supervisor's leg hangs up. Writes the
`monitor.session.ended` audit row. Idempotent (jti-keyed check prevents
double-write if both the API DELETE and the hangup hook fire).

---

## 12. Valkey state layout

### 12.1 Keys introduced by S02

| Key | Type | Content | TTL |
|---|---|---|---|
| `t:{tid}:monitor:<sup-call-uuid>` | HASH | `tid, target_uid, sup_uid, mode, conf_member_id, conf_name, started_at` | None (deleted on session end) |
| `t:{tid}:agent:{uid}:monitors` | ZSET | Members: sup-call-uuids; scores: started_at timestamps | None (cleared per del-member) |
| `vici2:monitor:jti:<jti>` | STRING | `1` | 90 s (NX set at token mint; prevents replay) |

### 12.2 Extension of T03's HASH

T03's `t:{tid}:agent:{uid}:conf_members` HASH (T03 PLAN §5.2) gains a new
role value format for supervisor entries:

```
<sup-call-uuid> → "<member-id>:supervisor:<mode>"
```

Existing agent/customer/third entries are unchanged.

---

## 13. Audit schema (C03 chain)

### 13.1 Action vocabulary

All six actions flow through the C03 `audit_log` table (existing). No new
table is required for monitor sessions.

| `action` | `entity_type` | `entity_id` | `before_json` | `after_json` |
|---|---|---|---|---|
| `monitor.session.requested` | `monitor_session` | `<jti>` | `null` | `{tid, sup_uid, target_uid, mode}` |
| `monitor.session.authorized` | `monitor_session` | `<jti>` | `null` | `{token_exp, member_budget_remaining}` |
| `monitor.session.denied` | `monitor_session` | `<jti>` | `null` | `{reason}` (vocabulary §6.3) |
| `monitor.session.started` | `monitor_session` | `<sup-call-uuid>` | `null` | `{tid, sup_uid, target_uid, mode, conf_name, member_id}` |
| `monitor.mode.changed` | `monitor_session` | `<sup-call-uuid>` | `{mode: old}` | `{mode: new, transition_seq}` |
| `monitor.session.ended` | `monitor_session` | `<sup-call-uuid>` | `null` | `{ended_at, duration_sec, reason}` |

### 13.2 Action registration

S02 IMPLEMENT registers the `monitor.*` action prefix in C03's action-constants
file. C03 PLAN NG1 explicitly states that C03 does not define event taxonomies;
each writer module owns its vocabulary. S02 owns `monitor.*`.

### 13.3 Retention

Same as `audit_log` — 7 years (C03 PLAN §8.6 / C04 retention). No S02-specific
retention schedule.

### 13.4 `actor_user_id` on each row

| Event | `actor_user_id` | `actor_kind` |
|---|---|---|
| `requested` | supervisor uid | `user` |
| `authorized` | supervisor uid | `user` |
| `denied` | supervisor uid (attempted) | `user` |
| `started` | FS system (via hangup hook) | `system` |
| `mode.changed` | supervisor uid (API caller) | `user` |
| `ended` | FS system (via hangup hook) or supervisor (API DELETE) | `system` or `user` |

---

## 14. Amendments to other modules

### 14.1 T03 amendment: whisper-flag typo correction

**File:** `spec/modules/T03/PLAN.md` §11.5
**Change:** Replace the erroneous description:
> "Whisper (sup talks to agent only): `conference_member_flags=mute,deaf=false`"

With the correct description:
> "Whisper (sup talks to agent only): supervisor joins with NO `mute` flag;
> post-join, `conference relate <SUP-MID> <CUST-MID> nospeak` prevents sup
> audio from reaching the customer. See S02 PLAN §3.3 for the full relate
> mechanism. The T03 RESEARCH §5.4 description (`mute,deaf=false`) was an
> oversimplification; S02 PLAN §2.3 formally corrects it."

**Note:** This amendment is to documentation only. T03 IMPLEMENT has not yet
produced code, so no code correction is needed — only the PLAN text. S02
IMPLEMENT will file this as a T03 amendment PR when filing its IMPLEMENT work.

### 14.2 T03 amendment: conf-maint handler supervisor branch

**File:** `dialer/internal/conference/` (T03 IMPLEMENT scope)
**Change:** Add supervisor `add-member` and `del-member` handling, plus the
new-member auto-relate check for active whisper sessions (§5.4 above).
This is a new code branch in the existing handler, not a structural change.

### 14.3 C02 amendment: consent message wording

**File:** `freeswitch/sounds/consent/vici2_consent_msg_default.wav` (and
`campaigns.consent_msg_audio` default)
**Change:** Ensure the default phrasing includes "monitored or recorded" (not
just "recorded"). The schema hook exists (`campaigns.consent_msg_audio` per
C02 PLAN §9); the actual audio content must be updated. S02 IMPLEMENT files
an amendment to C02 PLAN's wording note.

### 14.4 F05 amendment: employee monitor-consent banner

**File:** F05 login flow
**Change:** Add one-time consent banner on agent login + write
`user.acknowledged_monitor_consent` audit row. Re-prompt if the consent text
SHA-256 changes. S02 IMPLEMENT files this as an F05 amendment.

### 14.5 R01 amendment: per-leg recording contract

**Change:** Formalize the R01 constraint that conference-mix recording and
per-agent-leg recording are blocked until a coordinated S02 amendment review.
Per-leg customer recording only. S02 IMPLEMENT files this as an R01 amendment
when both modules reach IMPLEMENT phase.

---

## 15. Files to create (IMPLEMENT scope)

### 15.1 API (`api/src/routes/supervisor/`)

```
api/src/routes/supervisor/
├── index.ts                         ← Express/Fastify router mount
├── monitor.start.ts                 ← POST /api/sup/monitor/start
├── monitor.mode.ts                  ← PATCH /api/sup/sessions/:id/mode
├── monitor.end.ts                   ← DELETE /api/sup/sessions/:id
├── monitor.authz.internal.ts        ← GET /internal/freeswitch/monitor_authz
├── monitor.hangup-hook.internal.ts  ← POST /internal/freeswitch/monitor_end
├── monitor.token.ts                 ← JWT mint/validate for monitor_grant_token
└── monitor.schema.ts                ← Zod schemas for request/response
```

### 15.2 Dialer (`dialer/internal/supervisor/`)

```
dialer/internal/supervisor/
├── monitor.go        ← MonitorSession struct; mode-transition logic
├── transition.go     ← transition table + ordering rules (§4.1)
├── relate.go         ← relate nospeak/clear helpers wrapping T01.ConferenceCommand
└── monitor_test.go   ← unit tests for transition table + ordering rules
```

### 15.3 Dialplan (`freeswitch/conf/dialplan/default/`)

```
80_supervisor_monitor.xml   ← S02 dialplan extension (§5.3)
```

### 15.4 Web (`web/src/app/(sup)/`)

A01 must reserve the `(sup)` route group if not already done.

```
web/src/app/(sup)/
├── layout.tsx                      ← supervisor shell (parallels (agent) shell)
├── monitor/
│   ├── page.tsx                    ← wallboard entry point (or S01 embeds)
│   ├── MonitorModal.tsx            ← agent-click → mode-select modal
│   ├── MonitorSessionPanel.tsx     ← active session panel (mode badge + controls)
│   └── useMonitorSession.ts        ← hook: starts, switches mode, ends session
web/src/components/agent/
└── MonitorBanner.tsx               ← Agent-side indicator ("1 supervisor listening")
```

### 15.5 Shared types (`shared/types/src/`)

```
monitor.ts   ← MonitorMode type, MonitorSession type, MonitorStartResponse type
```

---

## 16. Test plan

### 16.1 Unit tests

| # | Test | File | Asserts |
|---|---|---|---|
| U1 | Transition table completeness | `monitor_test.go` | Every (from, to) pair emits exactly the correct API sequence in the correct order |
| U2 | Eavesdrop→Whisper ordering | `transition_test.go` | `relate` call emitted BEFORE `unmute` |
| U3 | Whisper→Eavesdrop ordering | `transition_test.go` | `mute` call emitted BEFORE `relate clear` |
| U4 | Multi-customer relate enumeration | `relate_test.go` | 3-way conf → 2 `relate nospeak` calls issued for whisper join |
| U5 | Token validation | `monitor.token.test.ts` | Valid → 200; expired → 401; wrong tid → 403; replay (jti reused) → 401 |
| U6 | Cross-tenant guard | `monitor.start.test.ts` | sup_uid from tid=1 → target_uid in tid=2 → 403 |
| U7 | Agent-not-in-call guard | `monitor.start.test.ts` | target READY → 409 |
| U8 | Rate limiter | `monitor.mode.test.ts` | 2nd switch within 1s → 429 |
| U9 | Multi-supervisor mode independence | `relate_test.go` | Sup A whisper relate does not affect Sup B barge |
| U10 | New-member auto-relate | `transition_test.go` | 3rd-party joins mid-whisper → relate nospeak auto-issued |

### 16.2 Integration tests (require F03 + T03 + A02 IMPLEMENT done)

| # | Scenario | Asserts |
|---|---|---|
| I1 | SIPp eavesdrop: INVITE `*81_1042_listen` → join → verify | Customer RTP contains NO supervisor audio; audit rows: requested+authorized+started+ended |
| I2 | SIPp whisper: INVITE `*81_1042_whisper` → sup speaks → verify | Agent RTP contains supervisor; customer RTP contains NO supervisor; audit rows present |
| I3 | SIPp barge: INVITE `*81_1042_barge` → sup speaks → verify | Both agent and customer RTP contain supervisor; audit rows present |
| I4 | Mode-switch mid-call | Start listen → switch to whisper (API) → switch to barge → switch back; each transition: correct audio routing; audit mode.changed row per switch |
| I5 | Agent-logout-during-monitor | Sup is listening; agent BYE → conf destroys after 5s; sup leg auto-dropped; sup UI shows "agent logged out"; audit ended row |
| I6 | Sup-disconnect-during-monitor | Sup browser closes → BYE → del-member; conference continues; agent banner decrements; audit ended row |
| I7 | Token replay rejection | Same JTI presented twice → second attempt gets 403 at dialplan |
| I8 | Cross-tenant attempt | Sup in t=1 presents token with tid=2 → dialplan 403 |
| I9 | Agent-consent-missing | Target agent has no acked consent → pre-flight 412 |
| I10 | Member budget at 18 | Pre-populate conf with 18 members → pre-flight 503 |

### 16.3 Compliance test (CRITICAL — binary pass/fail)

Record a synthetic conference call. Supervisor joins in each mode. Verify
using spectral analysis:

- **Eavesdrop:** Customer-leg recording contains agent + customer voices;
  ZERO supervisor-frequency components detected.
- **Whisper:** Customer-leg recording contains agent + customer voices;
  ZERO supervisor-frequency components detected.
- **Barge:** Customer-leg recording contains agent + customer + supervisor
  voices; all three detected.

**Any supervisor voice in eavesdrop or whisper customer recording = CI FAIL =
block release.** No exceptions.

### 16.4 Stress test

20 supervisors join one agent's conference simultaneously via concurrent
SIPp sessions. Assert:
- Members 1-18 join successfully.
- Members 19+ get rejected (503 from pre-flight budget check, or `Member
  count limit reached` from FS).
- Conference continues normally after the burst.
- All 18 successful joins have audit started rows.

### 16.5 Audit completeness test

Run 100 monitor sessions with randomized mode transitions. After all sessions:
- Each session has exactly 1 `authorized` + 1 `started` + N `mode.changed`
  (N = number of transitions) + 1 `ended`.
- Run `scripts/verify-audit-chain.ts`; chain integrity holds for all 600+
  rows generated.

---

## 17. Acceptance criteria

| # | Criterion | How verified |
|---|---|---|
| AC1 | Supervisor joins agent conf in listen mode; agent and customer do not hear supervisor | I1 integration test + C test |
| AC2 | Supervisor in whisper speaks to agent; customer hears NOTHING from supervisor | I2 integration + compliance test |
| AC3 | Supervisor barges; all three parties hear each other | I3 integration test |
| AC4 | Mode transitions are zero-glitch (no SIP re-INVITE; no RTP gap audible) | I4 integration test; RTP sequence analysis |
| AC5 | Agent UI shows supervisor count + mode aggregate; no identity disclosed | Manual UI test + unit test for banner logic |
| AC6 | Concurrent supervisors on same agent: each has independent mode; routing is correct | U9 + manual concurrent SIPp test |
| AC7 | Agent logout drops supervisor leg within 5s; sup UI shows "session ended" | I5 integration test |
| AC8 | Cross-tenant monitor attempt is rejected at both API layer and dialplan layer | I8 + U6 unit tests |
| AC9 | Every session produces complete audit trail in C03 hash chain; chain verifies | I-series + audit completeness test |
| AC10 | Pre-flight token is single-use; replay within 90s is rejected | I7 + U5 unit test |
| AC11 | Mode-switch rate limiter: >1 switch/sec returns 429 | U8 unit test |
| AC12 | Max-member budget (18) enforced at pre-flight; graceful 503 | I10 integration test |
| AC13 | Supervisor voice absent from customer recording in eavesdrop and whisper modes | 16.3 compliance test — binary PASS required for release |

---

## 18. Dependencies + risks

### 18.1 Hard dependencies (must be IMPLEMENT-stable before S02 IMPLEMENT starts)

| Module | What S02 needs |
|---|---|
| T03 | `agentPresenceConfMaintHandler` with S02 amendment (§14.2); `ConferenceFQN` helper; `T01.ConferenceCommand` with `relate` support |
| T01 | `ConferenceCommand` accepting `relate <A> <B> nospeak|clear`; `ConferenceList()` to enumerate members |
| F03 | `wss` profile operational; `80_supervisor_monitor.xml` slot available |
| A02 | `SimpleUser` with inbound INVITE auto-answer; supervisor uses same softphone |
| C03 | `AuditWriter` accepting `monitor.*` actions |
| F05 | RBAC `supervisor` role with `call:monitor` permission; employee consent banner amendment |

### 18.2 Soft dependencies (can develop in parallel but must integrate before release)

| Module | Interface needed |
|---|---|
| S01 | Wallboard agent-tile click → S02 MonitorModal; S02 provides the modal component |
| R01 | Commitment to per-leg customer recording only (§7.4 R01 contract) |
| C02 | Consent message wording amendment (§14.3) |

### 18.3 Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | `relate` state racing under rapid eavesdrop→whisper→barge cycles | Low | High (customer hears sup) | Ordering rules §4.2; rate limiter §4.3; integration test I4 |
| R2 | Supervisor leg surviving after agent logout (conf not yet destroyed) | Medium | Medium (orphan audio) | `endconf-grace-time=5s` on agent + `endconf=false` on sup; `hangup_after_conference=true` on sup leg; integration test I5 |
| R3 | Cross-tenant scope leak via API bug | Low | Critical (privacy/legal) | Defense-in-depth: API + dialplan + integration test I8; AC8 |
| R4 | R01 adds conference-mix recording without coordinating with S02 | Low | High (sup voice in recordings) | R01 amendment (§14.5) formalizes the constraint as a blocking gate |
| R5 | Multi-customer 3-way: new member joins mid-whisper without auto-relate | Medium | High (customer hears sup) | Conf-maint handler auto-relate (§5.4); integration test I4 mode-switch covering 3-way |
| R6 | Employee monitor-consent not re-checked on policy text change | Low | Medium (Watkins basis voided) | F05 amendment: consent text hash stored; API blocks if stale |
| R7 | WebRTC leg generates DTMF differently than expected (future Phase 1.5 risk) | Low | Low (deferred; API-only in Phase 1) | DTMF is deferred; no Phase 1 risk |

---

## 19. Open questions (resolved vs. deferred)

| Q# (RESEARCH §12) | Status | Resolution |
|---|---|---|
| Q1 `relate` vs `mute` priority | **RESOLVED** | `mute` gates before mix; `relate` is post-mix routing. Ordering rules in §4.2 account for this. Empirical verification required in IMPLEMENT. |
| Q2 Multi-supervisor mode collision | **RESOLVED** | Each sup's relate is per-pair independent. Customer hears barge-sup but not whisper-sup. Semantically correct. Acceptance criterion AC6. |
| Q3 Team scope | **DEFERRED** | Phase 1.5; tenant-only in Phase 1. OPEN_Q remains for M01 module. |
| Q4 Hardphone DTMF mode-switch | **DEFERRED** | Phase 1.5/Q4. API-only in Phase 1. §10 above. |
| Q5 Recording-mask during whisper | **RESOLVED** | No-op (Phase 1). Per-leg customer recording guarantees safety. §7.3. |
| Q6 Customer-side join beep on barge | **RESOLVED** | No additional beep. C02 verbal disclosure covers it. §8.2. Legal-review checkpoint for Phase 2. |
| Q7 Conference recording vs per-leg | **RESOLVED** | Per-leg only. R01 contract in §7.4. R01 amendment in §14.5. |
| Q8 Monitor session resumption after browser refresh | **RESOLVED** | No auto-resume. Explicit re-join required. §4.5. |
| Q9 Audit row write latency budget | **RESOLVED** | C03 trigger ~200 µs + network. Acceptable. API returns after audit write (synchronous for `monitor.*` critical actions). |
| Q10 Mobile/tablet support | **RESOLVED** | Phase 1 = tablet-responsive web. Native app is Phase 2+. |
| Q11 Inter-tenant monitor | **RESOLVED** | Phase 1 = hard NO. Phase 4 = open question. §6.1. |
| Q12 Pre-recorded coaching injection | **RESOLVED** | Out of S02 scope. Tracked as future S04 module candidate. |
