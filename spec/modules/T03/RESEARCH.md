# T03 — Agent-Conference: RESEARCH

**Status:** PROPOSED — input to PLAN.
**Track:** Telephony · **Phase:** 1
**Author:** T03 RESEARCH agent
**Module spec:** [`spec/modules/T03.md`](../T03.md)
**Depends on RESEARCH:** [F03](../F03/RESEARCH.md) (FreeSWITCH base + conference profile),
[T01](../T01/RESEARCH.md) (ESL ConferenceCommand primitive), [F04](../F04/RESEARCH.md)
(Valkey agent state HASH).
**Sacred reference:** [SPEC §4.4](../../../SPEC.md) — *the conference-per-agent
primitive is sacred*; this module is the canonical implementation of that
invariant.

> **Scope.** This document answers the *what / why / how-to* for the
> conference-per-agent primitive — strategy, mechanics, citations, open
> questions. It does **not** include final XML, Go signatures, file lists,
> sequence diagrams, or test plan; those live in `PLAN.md`.

---

## 1. Executive summary (10 bullets)

1. **Conferences are implicitly created on first member join** — there is no
   explicit `conference create` API in `mod_conference 1.10`. The first
   `conference <name>@<profile>` application invocation, or the first
   `uuid_transfer <uuid> conference:<name>@<profile> inline` from ESL,
   instantiates the conference using the named profile.
   ([signalwire mod_conference docs](https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Modules/mod_conference_3965534/),
   [freeswitch-users 2010-11](https://lists.freeswitch.org/pipermail/freeswitch-users/2010-November/065435.html),
   [freeswitch-users 2008-06](https://lists.freeswitch.org/pipermail/freeswitch-users/2008-June/031720.html))
2. **Conferences auto-destroy when the last member leaves**, modulo the
   `endconf` member flag and `endconf-grace-time` profile parameter. We do
   NOT need a `conference destroy` call; we control teardown by which legs
   carry `endconf`. The default minimum-members for a dynamic (non-bridge)
   conference is 1; for bridge conferences (`bridge:` prefix) it is 2.
   ([confluence mod_conference §"Conferences stay alive…"](https://confluence.freeswitch.org/display/FREESWITCH/mod%5Fconference),
   [hangup_after_conference docs](https://developer.signalwire.com/freeswitch/Channel-Variables-Catalog/hangup_after_conference_16352955/))
3. **Agent leg holds the conference open.** The agent enters with member
   flags `moderator,nomoh` (no MoH while alone, no participant DTMF
   controls because we set `caller-controls=none` in the profile per F03
   §5). The customer enters with `endconf=false` (no flag) so the
   conference survives customer hangup. When the agent leg leaves AND no
   other endconf-carrying member remains, the conf collapses naturally —
   we just send `conference <name> kick all` on logout for explicit
   teardown.
   ([Member-Flags table](https://confluence.freeswitch.org/display/FREESWITCH/mod%5Fconference))
4. **`uuid_transfer <uuid> conference:<name>@<profile> inline`** is the
   single primitive for putting any leg (customer, third party, supervisor)
   into the agent's conference. The `inline` keyword tells FS to evaluate
   the destination as an inline-dialplan recipe rather than re-route via
   XML dialplan, so we don't need a per-target dialplan extension.
   ([Inline Dialplan docs](https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Dialplan/Inline-Dialplan_13173434/),
   [freeswitch-users 2013-02 — uuid_transfer→conference](http://lists.freeswitch.org/pipermail/freeswitch-users/2013-February/092545.html),
   [freeswitch-users 2012-04](http://lists.freeswitch.org/pipermail/freeswitch-users/2012-April/083004.html))
5. **3-way is solved by another `originate ... 'conference:<name>@<profile>+flags{join-only}' inline`.**
   The third leg lands directly in the same conf without bridging through
   the agent; `join-only` ensures the originate only proceeds if the conf
   already exists (it does — the agent is in it). All transfer modes from
   `AGENT_API.txt` collapse to "join member to conf" or "kick member from
   conf" — same primitive Vicidial used with MeetMe.
   ([DESIGN §1.4 — vicidial transfer_conference](../../../DESIGN.md),
   [stackoverflow — vicidial 3-way](https://stackoverflow.com/questions/18852917/vicidial-3-way-call-transfer-issue))
6. **member-id is per-conference, ephemeral, and discoverable two ways:**
   (a) consume `CUSTOM conference::maintenance` events with
   `Action: add-member` and read the `Member-ID` header at join time
   (canonical), or (b) `uuid_getvar <leg-uuid> conference_member_id`
   on-demand. We persist `(call_uuid → member_id)` and
   `(agent_id → moderator_member_id)` into Valkey HASH
   `t:{tid}:agent:{user_id}:conf_members` keyed by call-uuid (TTL = call
   lifetime).
   ([Channel variable conference_member_id](https://confluence.freeswitch.org/display/FREESWITCH/mod%5Fconference),
   [freeswitch-users 2014-01 — get member_id](http://lists.freeswitch.org/pipermail/freeswitch-users/2014-January/102529.html),
   [freeswitch-users 2011-03](http://lists.freeswitch.org/pipermail/freeswitch-users/2011-March/070736.html))
7. **Conference recording is per-conference and produces a single mixed
   wav/mp3** via `conference <name> record /path/to/file.wav`. **Stereo
   per-leg recording is NOT honoured by the conference recorder** — the
   `RECORD_STEREO` chan-var is read by `record_session` / `uuid_record`
   only, not by mod_conference. For Phase 1 we record at the per-leg level
   via `record_session` set in the customer-leg dialplan
   (`recording_follow_transfer=true` keeps the file growing as the leg
   moves between conferences).
   ([signalwire issue #895 — RECORD_STEREO not respected by conf](https://github.com/signalwire/freeswitch/issues/895),
   [freeswitch-users 2008-10](http://lists.freeswitch.org/pipermail/freeswitch-users/2008-October/035088.html),
   [freeswitch-users 2016-07 — stereo](https://lists.freeswitch.org/pipermail/freeswitch-users/2016-July/121601.html))
8. **Naming convention is the single biggest *open issue* before PLAN.**
   `SPEC.md §4.4` and `T03.md` say `conference_${user_id}@default`;
   `F03/PLAN.md §5` already froze `agent_${user_id}@default` (and the
   F03-shipped advertise glob is `agent_*@default`). T03 PLAN must pick
   ONE and (a) update the loser via RFC, (b) recommend
   `agent_t<tid>_u<uid>@default` for forward-compat with multi-tenant
   (Phase 4). Recommendation in §10 below.
9. **Performance ceiling: ~900 active conferences per FS instance** — the
   "Artoo R2D2" thread-creation wall in `switch_core_session.c:1818`
   triggers when `switch_thread_create()` fails to spawn the per-session
   threads, even at 20 % CPU on a 36-core box. This is the same wall
   already documented in F03/RESEARCH §15 and DESIGN §13. T03 inherits
   it; sharding (X02 Kamailio dispatcher) is the Phase 3.5 remedy. Empty
   conferences cost ~1 KB and one tick on the conf-thread interval
   (configurable, default 20 ms).
   ([signalwire issue #1729 — Artoo](https://github.com/signalwire/freeswitch/issues/1729))
10. **No FS restart needed for any T03 operation.** All conference create /
    join / mute / kick / record / destroy actions happen via ESL `bgapi
    conference …` or `bgapi uuid_transfer …`. Profile change requires
    `reloadxml` + `conference reload` (rarely needed; profile is
    parameterized via channel vars — see §6).

---

## 2. Conference creation strategy (implicit vs explicit)

### 2.1 What `mod_conference 1.10` actually exposes

There is **no `conference create` API command**. The full API command set
([signalwire docs](https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Modules/mod_conference_3965534/))
relevant to us is:

| Command | Purpose |
|---|---|
| `conference list [pretty\|summary\|count\|delim]` | Enumerate conferences / members |
| `conference xml_list` | Same, XML output |
| `conference <name> dial <endpoint>` | Originate a leg directly into the conf |
| `conference <name> bgdial <endpoint>` | Same, async, returns Job-UUID |
| `conference <name> mute <member-id\|all\|last\|non_moderator>` | Mute |
| `conference <name> tmute <…>` | Toggle mute |
| `conference <name> unmute <…>` | Unmute |
| `conference <name> deaf <…>` / `undeaf <…>` | Silence the *return* path to a member |
| `conference <name> kick <member-id\|all\|last\|non_moderator>` | Eject (with kick sound) |
| `conference <name> hup <…>` | Eject without kick sound |
| `conference <name> transfer <other-conf> <member-id>` | Move member between confs |
| `conference <name> dtmf <member-id\|all> <digits>` | Send DTMF as if member sent it |
| `conference <name> play <file> [member-id]` | Play file to all or one member |
| `conference <name> record <file>` ↔ `recording start` | Start mixed-recording |
| `conference <name> norecord <file\|all>` ↔ `recording stop` | Stop recording |
| `conference <name> chkrecord` ↔ `recording check` | Query state |
| `conference <name> pause <file>` / `resume` | Pause/resume recorder |
| `conference <name> lock` / `unlock` | Block/allow new joins |
| `conference <name> set <param> <val>` | Mutate conference-level params |
| `conference <name> setvar <name> <val>` (1.10.5+) | Set conf-level vars |
| `conference <name> getvar <name>` (1.10.5+) | Read conf-level vars |
| `conference <name> floor [member-id]` | Toggle/set talking-floor |
| `conference <name> vid-floor` / `vid-mute` (1.6+) | Video-floor / video-mute |

[signalwire mod_conference docs](https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Modules/mod_conference_3965534/),
[freeswitch.org.cn 1.7 reference (Chinese, but command list authoritative)](https://www.freeswitch.org.cn/books/references/1.7-mod_conference.html)

**Notice the absence of `create`.** This is by design — conferences are
purely a name; the first time a name is used, the conference is born; when
the last qualifying member leaves, it dies.

### 2.2 Three paths to "first member in"

| Path | Trigger | When we use it |
|---|---|---|
| **A. Dialplan `conference` app** | Agent dials `*9NNNN`, dialplan extension matches and runs `<action application="conference" data="agent_NNNN@default+flags{moderator,nomoh}"/>` | **Agent join** (T03 owns this extension; F03 ships a working stub at `01_agent_conference.xml`) |
| **B. ESL `uuid_transfer <uuid> conference:NAME@PROFILE inline`** | Customer leg already exists (originated by T04) and is parked / answered; dialer engine bgapi-transfers it into the conf | **Customer transfer-in** (T04+T01 issue this; T03 only requires the conference exists or auto-creates) |
| **C. ESL `bgapi originate <leg> 'conference:NAME@PROFILE+flags{join-only}' inline`** | Third party for 3-way; supervisor for S02 eavesdrop/whisper | **3-way / supervisor join** (A07 + S02 issue this) |

[freeswitch-users 2013-02](http://lists.freeswitch.org/pipermail/freeswitch-users/2013-February/092545.html),
[freeswitch-users 2010-11](https://lists.freeswitch.org/pipermail/freeswitch-users/2010-November/065435.html),
[Inline Dialplan](https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Dialplan/Inline-Dialplan_13173434/)

### 2.3 Persistent vs ephemeral

For us, **conferences are ephemeral, scoped to agent login session**. The
agent's join is the lifecycle anchor:

```
agent_login (browser SIP REGISTER + dial *9NNNN)
   → conference instantiated implicitly with agent as member 1 (moderator)
   → conference idle (1 member, nomoh ⇒ silence) — costs ~1 KB
   → ... customer transferred in / out repeatedly across many calls ...
   → agent_logout (BYE on SIP.js leg, OR explicit `conference … kick all` from API)
   → last endconf member gone ⇒ conference auto-destroyed by mod_conference
```

We do **not** need to `conference dial` a placeholder leg to keep an
empty conference open across re-logins. Two observations:

* The Vicidial pattern *did* depend on a persistent MeetMe room (the agent
  was placed into a numbered MeetMe room they kept across calls), but
  that's because Vicidial's predictive bridge originated against a
  pre-existing conference name. Our equivalent is the agent's SIP.js
  WebRTC leg — when it's up the conf is up, when it's down the conf is
  gone. This is *better* than Vicidial's "conf survives logout" pattern
  because there's never a stale-conf state to clean up — the
  channel/conference janitor (E06) becomes a defence-in-depth, not a
  primary cleanup mechanism.
* If a campaign needs a conference that outlives all logged-in agents
  (e.g., a closer queue that persists), use `mod_callcenter` (I01) —
  that's what it is for. Don't repurpose agent confs.

### 2.4 Should we explicitly "create" before agent joins?

**No.** Recommended sequence for agent login:

1. SIP.js dials `*9${user_id}` over WSS.
2. Extension `agent_conference_join` matches on `^\*9(\d+)$` and runs
   `<action application="conference" data="agent_$1@default+flags{moderator,nomoh,endconf}"/>`.
3. mod_conference creates the conf using profile `default` and adds the
   agent as member 1. Fires `CUSTOM conference::maintenance` with
   `Action: conference-create` (subclass header) followed by `Action:
   add-member`. Both events arrive on the global ESL stream that T01's Go
   ESL writer + Node ESL consumer subscribe to.
4. The Node ESL consumer (`api/src/esl/handlers/conference-maint.ts`)
   reads `Conference-Name`, `Member-ID`, and the channel var
   `vici2_user_id` (which the dialplan will set before joining), then
   updates Valkey `t:{tid}:agent:{user_id}` HASH `status=READY` (after
   the F05 auth check confirms the SIP user matches the requested
   `user_id` — see §3).

The Node consumer is **stateless** about conference creation; it learns
from events. There is zero pre-create RPC.

---

## 3. Agent join flow

### 3.1 Sequence (logical)

```
Browser (web/, A02)              FreeSWITCH                  ESL/Node API (T01)              Valkey (F04)
       │                              │                              │                              │
       │  1. INVITE sip:*91042@fs       │                              │                              │
       │     (auth: SIP user 1042)    │                              │                              │
       ├─────────────────────────────►│                              │                              │
       │                              │  2. REGISTER → directory     │                              │
       │                              │     (F05 verifies user 1042) │                              │
       │                              │                              │                              │
       │                              │  3. dialplan match           │                              │
       │                              │     ^\*9(\d+)$ extension     │                              │
       │                              │     ${sip_authorized_user}=1042│                              │
       │                              │     == $1 ⇒ proceed          │                              │
       │                              │     ${1} != ${sip_auth…} ⇒   │                              │
       │                              │       hangup UNAUTHORIZED    │                              │
       │                              │                              │                              │
       │                              │  4. conference app           │                              │
       │                              │     agent_1042@default       │                              │
       │                              │     +flags{moderator,nomoh,  │                              │
       │                              │            endconf}          │                              │
       │                              ├─────────────────────────────►│  5. CUSTOM conference::      │
       │                              │     mod_conference fires:    │     maintenance              │
       │                              │       conference-create      │     Action: add-member       │
       │                              │       add-member             │     Member-ID: 1             │
       │                              │                              │     Conference-Name: agent_1042│
       │                              │                              │     vici2_user_id: 1042      │
       │                              │                              │                              │
       │  6. 200 OK + RTP               │                              │                              │
       │◄──────────────────────────────┤                              │                              │
       │                              │                              │  7. handler reads vici2_…    │
       │                              │                              │     header → HSET            │
       │                              │                              │     t:1:agent:1042           │
       │                              │                              │       status=READY           │
       │                              │                              │       conf_name=agent_1042   │
       │                              │                              │       conf_member_id=1       │
       │                              │                              │       last_change_at=<ts>    │
       │                              │                              ├─────────────────────────────►│
       │                              │                              │                              │
       │                              │                              │  8. ZADD t:1:agents:by_status│
       │                              │                              │       :READY <ts> 1042       │
       │                              │                              ├─────────────────────────────►│
```

### 3.2 Auth check (preventing cross-conf join)

`SPEC.md §4.4` and the T03 spec require: **agent 1042 cannot join
conference for user 1099**. This is enforced in dialplan against
`${sip_authorized_user}` (set by Sofia after digest auth succeeds), NOT
`${sip_from_user}` (which is attacker-controlled in some configurations).

```xml
<condition field="destination_number" expression="^\*9(\d+)$">
  <condition field="${sip_authorized_user}" expression="^${1}$" break="never">
    <action application="answer"/>
    <action application="set" data="vici2_user_id=$1"/>
    <action application="set" data="vici2_tenant_id=${user_data($1@default var vici2_tenant_id)}"/>
    <action application="set" data="vici2_role=agent_leg"/>
    <action application="set" data="vici2_conf_name=agent_$1"/>
    <action application="conference" data="agent_$1@default+flags{moderator,nomoh,endconf}"/>
    <anti-action application="respond" data="403 Forbidden"/>
    <anti-action application="hangup" data="USER_NOT_AUTHORIZED"/>
  </condition>
</condition>
```

Notes:
* `${sip_authorized_user}` is post-auth. Verified at
  [SignalWire — Channel-Variables-Catalog](https://developer.signalwire.com/freeswitch/Channel-Variables-Catalog/).
  For digest-authenticated SIP requests this matches the SIP `user` digest
  field; it cannot be spoofed by a re-INVITE without the password.
* Tenant resolution via `user_data()` looks up the directory entry that
  F05 renders. Only one directory entry per `user_id` is permitted,
  enforced by F05's directory templating.
* `break="never"` causes the inner condition test to fall through to the
  outer's anti-action (the FS dialplan idiom for "if outer matched but
  inner failed, run anti-actions"). The PLAN will validate this idiom
  with a SIPp test.

### 3.3 Channel variables to set before joining

Per T03.md and consistent with F04 HASH layout:

| Var | Source | Used by |
|---|---|---|
| `vici2_user_id` | dialplan capture group | conf-maint handler → agent state |
| `vici2_tenant_id` | `user_data()` lookup | tenant scoping in events |
| `vici2_role` | dialplan literal `"agent_leg"` | event filtering, audit logs |
| `vici2_conf_name` | dialplan literal `agent_$1` | breadcrumb in events |
| `conference_auto_record` | empty (we record per-leg) | mod_conference |
| `conference_member_flags` | optionally set instead of `+flags{…}` syntax | mod_conference |

These show up as headers on `CUSTOM conference::maintenance` events so the
Node consumer can self-route without consulting any DB.
([signalwire — Settable Channel Variables](https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Modules/mod_conference_3965534/))

### 3.4 Idle MOH behaviour

* Agent enters with `nomoh`; profile sets `moh-sound=local_stream://moh`
  but `nomoh` overrides it for that member. Result: silence.
* If we *wanted* MoH while agent is alone (e.g., for a non-call-centre
  conference profile), we'd omit `nomoh`. For the agent-conf primitive
  silence is correct (agent is logged in, ready, doing other things in the
  UI; we don't want their headphones serenading them).
* `comfort-noise=true` (set in F03 §5 profile) supplies a faint hiss so
  the agent's speakers don't go fully silent — important for some VoIP
  endpoints that mute themselves under prolonged silence.
  ([F03/PLAN §5](../F03/PLAN.md))

### 3.5 Re-join / network blip handling

This is in T03's risk register (T03.md §"Risks"). Pattern:

* If agent's SIP.js loses WSS, FS sees CHANNEL_HANGUP → conf fires
  `del-member`; if agent was the only `endconf` carrier the conf
  destructs after `endconf-grace-time` (default 60s — we should lower to
  5s for snappier OFFLINE detection).
* `del-member` handler in Node debounces 5 s before flipping
  `status=OFFLINE`. If a fresh `add-member` for the same `user_id`
  arrives within the window, we cancel the OFFLINE flip → state stays
  READY, no flicker.
* Re-join is identical to first-join — same `*9NNNN` dial, same
  conference-app run, fresh `Member-ID` (counter resets when conf was
  destroyed; persists across re-joins if conf wasn't destroyed). The
  **member-id is *not* stable** across joins — the Valkey conf-members
  HASH must be re-populated on each `add-member`.

---

## 4. Customer transfer-in flow

### 4.1 Primitive: `bgapi uuid_transfer`

The single command — issued by Go dialer (T01 ConferenceCommand /
UUIDTransfer wrapper):

```
bgapi uuid_transfer <customer-call-uuid> conference:agent_<user_id>@default inline
```

[freeswitch-users 2013-02 — uuid_transfer→conference](http://lists.freeswitch.org/pipermail/freeswitch-users/2013-February/092545.html)

Why `inline`: without `inline`, FS would re-route `<customer-uuid>` to a
dialplan extension named `conference:agent_…` (unmatched ⇒ hangup). With
`inline`, FS treats `conference:agent_…` as `app:arg` syntax and runs
`<action application="conference" data="agent_…"/>` directly on the
customer's channel.
([Inline Dialplan](https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Dialplan/Inline-Dialplan_13173434/))

### 4.2 Pre-set channel vars on customer leg before transfer

The dialer engine should `bgapi uuid_setvar_multi` on the customer leg
*before* the transfer so that mod_conference picks them up:

```
bgapi uuid_setvar_multi <cust-uuid> vici2_role=customer_leg;vici2_user_id=<agent_id>;
                                    vici2_tenant_id=<tid>;vici2_call_uuid=<cust-uuid>;
                                    conference_member_flags=
```

The empty `conference_member_flags` overrides any default `endconf` so
the customer's hangup does NOT collapse the conference (agent must still
have `endconf`, which they got at login).

### 4.3 Sequence (customer transfer-in)

```
Dialer engine (Go)              FreeSWITCH                  Conf-maint Node consumer       Valkey
       │                            │                              │                              │
       │  bgapi uuid_setvar_multi   │                              │                              │
       ├───────────────────────────►│                              │                              │
       │  +OK Job-UUID:…              │                              │                              │
       │◄───────────────────────────┤                              │                              │
       │                            │                              │                              │
       │  bgapi uuid_transfer <cust>│                              │                              │
       │   conference:agent_1042@   │                              │                              │
       │   default inline           │                              │                              │
       ├───────────────────────────►│                              │                              │
       │  +OK Job-UUID:…              │                              │                              │
       │◄───────────────────────────┤                              │                              │
       │                            │                              │                              │
       │                            │  CUSTOM conference::         │                              │
       │                            │  maintenance                 │                              │
       │                            │    Action: add-member        │                              │
       │                            │    Member-ID: 2              │                              │
       │                            │    Channel-Call-UUID: <cust> │                              │
       │                            │    vici2_role: customer_leg  │                              │
       │                            ├─────────────────────────────►│  HSET t:1:call:<cust>        │
       │                            │                              │      conf_member_id=2        │
       │                            │                              │      conf_name=agent_1042    │
       │                            │                              ├─────────────────────────────►│
       │                            │                              │  HSET t:1:agent:1042         │
       │                            │                              │      status=INCALL           │
       │                            │                              │      lead_id=…, call_uuid=…  │
       │                            │                              ├─────────────────────────────►│
       │                            │                              │  WS broadcast to agent UI    │
       │                            │                              │  → screen-pop renders        │
```

### 4.4 Audio cut-through latency

Because the customer's leg is already up (we used `execute_on_answer=park`
per T01's `OnAnswer.Park` pattern), there is no SDP renegotiation when
the leg joins the conference — mod_conference replaces the channel's
read/write callbacks with conference mixing in microseconds. Audio
cut-through is well under 200 ms in practice
([T01/RESEARCH §"OnAnswer actions"](../T01/RESEARCH.md)).

### 4.5 Failure modes

* **Customer hangs up before transfer fires.** `uuid_transfer` returns
  error; dialer cleans up `t:{tid}:campaign:{cid}:in_flight` entry. No
  conf operation needed.
* **Conference doesn't exist (agent logged out between dispatch and
  transfer).** Without `join-only`, mod_conference would create a fresh
  conf with just the customer in it (bad — orphan). To prevent this,
  before transferring T01 should add `+flags{join-only}`:

  ```
  bgapi uuid_transfer <cust> conference:agent_1042@default+flags{join-only} inline
  ```

  If the conf doesn't exist, the transfer fails gracefully; dialer hangs
  up the customer with a safe-harbor message (DESIGN §13.7 / TCPA
  drop-handling). **PLAN must mandate `join-only` on every customer/3rd
  -party transfer.**
  ([Member-Flags table — `join-only`](https://confluence.freeswitch.org/display/FREESWITCH/mod%5Fconference))
* **Member-id event delayed.** Documented case (lists 2013-08) of 7 s
  delay between `uuid_transfer` and `add-member` event under load.
  Mitigation: don't block the screen-pop on the conf-maint handler;
  populate the agent UI from the dialer's pre-transfer state and treat
  conf_member_id as best-effort metadata used for later mute/kick. If
  needed, fall back to `uuid_getvar <cust-uuid> conference_member_id` on
  demand.
  ([freeswitch-users 2013-08 — add-member event delay](http://lists.freeswitch.org/pipermail/freeswitch-users/2013-August/098396.html))

---

## 5. 3-way call mechanics

### 5.1 Mode taxonomy (from Vicidial AGENT_API.txt, kept verbatim)

DESIGN §1.4 enumerates Vicidial's transfer universe; mod_conference
implements each as one or two operations:

| Vicidial transfer | FS implementation | Notes |
|---|---|---|
| **DIAL_WITH_CUSTOMER (3-way)** | `bgapi originate {originate_timeout=30,…}sofia/gateway/<carrier>/<3rd> 'conference:agent_<uid>@default+flags{join-only}' inline` | Third leg lands directly in the existing conf. Agent + customer + 3rd all hear ringback during originate (provided `ringback` chan-var is set on the originate string) |
| **Consultative warm transfer** | (a) Move customer to a *parking* conference: `bgapi conference agent_<uid> transfer agent_<uid>_park <cust-member-id>` so customer hears MoH alone; (b) originate 3rd into agent's conf (now agent + 3rd); (c) on agent confirm: `bgapi conference agent_<uid>_park transfer agent_<uid> <cust-member-id>` to merge customer back; (d) `bgapi conference agent_<uid> hup <agent-member-id>` to leave |
| **Leave 3-way (transfer + leave)** | `bgapi conference agent_<uid> kick <agent-member-id>` — customer + 3rd remain bridged. `recording_follow_transfer=true` keeps recording running |
| **Blind transfer** | `bgapi uuid_transfer <cust-uuid> sofia/gateway/<carrier>/<3rd> inline` (no conf involvement; just bridge customer to gateway leg) |
| **Park + dial** | `bgapi uuid_transfer <cust> park inline` then later originate 3rd and re-bridge; or move customer to a temp parking conf with MoH |
| **Voicemail-drop** | `bgapi uuid_broadcast <cust-uuid> file_string://greeting.wav aleg` or schedule `mod_voicemail` from dialplan |

[DESIGN §1.4](../../../DESIGN.md), [signalwire mod_conference — `transfer` API](https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Modules/mod_conference_3965534/),
[Vicidial AGENT_3WAY_PRESS-1_CALLS.txt](https://vicidial.org/docs/AGENT_3WAY_PRESS-1_CALLS.txt)

### 5.2 The `conference transfer` command

`conference <src-conf> transfer <dst-conf> <member-id>` *moves a member
between conferences without dropping audio*. This is the magic that makes
consultative warm transfer work cleanly. The source conf must exist and
contain the member; the destination conf is auto-created if it doesn't
exist (same implicit-create rule as join).

[signalwire mod_conference docs](https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Modules/mod_conference_3965534/),
[freeswitch.org.cn 1.7 reference](https://www.freeswitch.org.cn/books/references/1.7-mod_conference.html)

### 5.3 `conference dial` vs `originate … conference: inline`

Two ways to add an outbound 3rd leg:

**A.** `conference agent_1042 dial sofia/gateway/twilio/+15551234567`

* Pros: short, conf is the originator, no need to specify dest conf again.
* Cons: synchronous in some FS versions, no Member-ID returned in the API
  reply (see [lists 2011-03](http://lists.freeswitch.org/pipermail/freeswitch-users/2011-March/070736.html)),
  doesn't accept `+flags{}` cleanly.
* Use for: ops/CLI testing.

**B.** `bgapi originate {origination_uuid=<uuid>,…}sofia/gateway/twilio/+15551234567 'conference:agent_1042@default+flags{join-only}' inline`

* Pros: fully async via Job-UUID, you control the channel UUID,
  flags are first-class, integrates with T01's existing originate path.
* Cons: more verbose.
* **Use this** for all programmatic 3-way originates. Matches DESIGN §13.7
  recommendation.

[freeswitch-users 2009-01](http://lists.freeswitch.org/pipermail/freeswitch-users/2009-January/037729.html),
[Conference Add Call Example](https://freeswitch.org/confluence/display/FREESWITCH/Conference+Add+Call+Example)

### 5.4 4+ legs / supervisor barge

`max-members=20` is set in F03/PLAN §5 profile. A typical 3-way is 3
legs; an eavesdrop session with whisper is 4 (agent + customer + 3rd-party
+ supervisor). Profile cap of 20 leaves plenty of headroom for blended
campaigns where multiple supervisors barge.

For supervisor barge (S02), originate the supervisor leg with
`conference_member_flags=mute,deaf=false` (whisper to agent only) or
`conference_member_flags=mute,deaf=true` (silent listen). Per F03/PLAN
§5.

---

## 6. Mute / hold / kick API

### 6.1 Mute

```
bgapi conference agent_1042 mute <member-id> [quiet]
bgapi conference agent_1042 unmute <member-id> [quiet]
bgapi conference agent_1042 tmute <member-id> [quiet]   # toggle
```

* `[quiet]` suppresses the muted/unmuted-sound playback to that member —
  useful for self-mute toggles where the agent doesn't need a "you are
  muted" announcement (we want zero announcements anyway; F03 §5 sets
  `muted-sound=silence_stream://1`).
* `member-id` can be `all`, `last`, `non_moderator`, or a numeric id from
  conference list.
* Mute is `member-into-conf` direction (the conf doesn't hear the
  muted-member). To block conf→member instead, use `deaf` /
  `undeaf` (rare for agent UI).

[signalwire mod_conference](https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Modules/mod_conference_3965534/),
[freeswitch.org.cn 1.7](https://www.freeswitch.org.cn/books/references/1.7-mod_conference.html)

### 6.2 Hold (customer-side MoH while agent steps away)

The "hold" UX in a call-centre: agent presses Hold → customer hears MoH,
agent silence/MoH on agent side. mod_conference gives us **two
implementations**:

**Option A — `deaf+mute` the customer (no MoH for the customer):**

```
bgapi conference agent_1042 deaf <cust-member-id>
bgapi conference agent_1042 mute <cust-member-id>
```

Customer is muted (conf can't hear them) and deaf (they can't hear conf).
But they hear *silence*, not MoH. Not great UX.

**Option B — Move the customer to a parking conference with MoH:**

```
bgapi conference agent_1042 transfer agent_1042_hold <cust-member-id>
```

The `agent_1042_hold` conf is created on demand using a *different* profile
that has `moh-sound=local_stream://moh` and *no* `nomoh` flag, so the
single-member customer hears MoH. To resume:

```
bgapi conference agent_1042_hold transfer agent_1042 <cust-member-id>
```

PLAN should pick **Option B** as primary (proper MoH UX) and reserve A
for "mute-self" toggles. This requires defining a 2nd conference profile
`hold` in `conference.conf.xml` (PLAN's responsibility; F03 only ships
the single `default` profile).

[freeswitch-users 2016-06 — dynamic moh-sound](http://lists.freeswitch.org/pipermail/freeswitch-users/2016-June/120991.html)

### 6.3 Kick

```
bgapi conference agent_1042 kick <member-id>      # plays kicked-sound
bgapi conference agent_1042 hup <member-id>       # silent ejection
bgapi conference agent_1042 kick all              # destroy all members (used at logout)
bgapi conference agent_1042 kick non_moderator    # eject everyone except the agent
```

* The `kicked-sound` is silenced by F03 §5 profile (`silence_stream://1`)
  so kick == hup audio-wise. We use `kick` for clarity in logs.
* `kick all` is the explicit teardown used by T03 on logout — see §8.

### 6.4 Per-conference vs per-channel apps

Some operations are channel-level (`uuid_audio`, `uuid_record`,
`uuid_setvar`) and apply regardless of conference state; others are
conference-level (`conference … mute`). For mute, channel-level
`uuid_audio start mute` would also work, but conference-level mute is
preferred because:
* It's explicitly designed for multi-party mixing.
* It fires `mute-member` events that the supervisor wallboard (S01) can
  listen to.
* It respects the `non_moderator` selector.

---

## 7. Recording strategy (conf-level vs per-leg)

### 7.1 The two recorders, side by side

| Property | `conference <name> record <file>` | `record_session <file>` (or `uuid_record start`) |
|---|---|---|
| **Captures** | All members mixed (one stream) | One leg (channel UUID) |
| **Stereo (RECORD_STEREO)** | NOT honoured | Honoured (A leg = ch 1, B leg = ch 2) |
| **Sample rate** | Locked to conference rate (8 kHz default — F03 §5) | Configurable via `record_sample_rate` chan-var (44.1 kHz available) |
| **Persists across transfer** | No (recording stops if conf is destroyed) | Yes if `recording_follow_transfer=true` is set on the leg |
| **Per-call file naming** | `${conference_name}` chan-var available | Full chan-var substitution (`${campaign_id}_${lead_id}_${uuid}.wav`) |
| **CPU cost** | One mixer per conf | One per leg per recording |

[signalwire issue #895 — RECORD_STEREO + conference](https://github.com/signalwire/freeswitch/issues/895),
[freeswitch-users 2008-10](http://lists.freeswitch.org/pipermail/freeswitch-users/2008-October/035088.html),
[mod_conference — auto-record](https://confluence.freeswitch.org/display/FREESWITCH/mod%5Fconference)

### 7.2 Decision: per-leg recording on the customer channel (Phase 1)

This matches F03/PLAN §4.2 stub for `customer_into_agent_conf` extension:

```xml
<action application="set" data="RECORD_STEREO=true"/>
<action application="set" data="RECORD_MIN_SEC=2"/>
<action application="set" data="recording_follow_transfer=true"/>
<action application="record_session"
        data="$${recordings_dir}/$${tenant_id}/${strftime(%Y/%m/%d)}/${campaign_id}_${lead_id}_${uuid}.wav"/>
```

Why per-leg on the **customer** leg specifically:

* RECORD_STEREO gives us A (customer audio) and B (everyone-else mix from
  the conference, which includes agent + any 3rd party). Adequate for
  QA / dispute resolution.
* `recording_follow_transfer=true` keeps the file growing across the
  customer's lifecycle: enter conf → consultative-transfer to hold conf
  → return → leave-3-way → bridged with 3rd party only. One contiguous
  file per customer call.
* Does NOT depend on conference recording being on; the conf can be
  created/destroyed without affecting the recording.
* No FS-side mixing CPU above what's needed for the conference itself.

### 7.3 Limitations & where conf-level recording would be added later

* **True per-leg stereo.** If compliance requires *each* party in its own
  channel (some 2-party-consent jurisdictions), we'd add a second
  `record_session` on the agent leg, then post-process the two files
  into a 3-channel WAV via ffmpeg in the recording-encode worker (R02).
  Not required for Phase 1.
* **Supervisor / training playback.** Conf-level `conference … record`
  gives a clean mixed file useful for "how the call sounded to the
  customer". Add an explicit ESL-driven start for training-flag campaigns
  in Phase 2.
* **Dual recordings.** Both `record_session` (per-leg) AND
  `conference … record` (mixed) can run concurrently if needed. They
  produce two separate files; R02 reconciles by call_uuid.

### 7.4 Recording starts/stops events

For audit / R02 ingestion, the relevant events:

* `RECORD_START` (channel) — fires when `record_session` begins; carries
  `Record-File-Path`, `Caller-Channel-Call-UUID`.
* `RECORD_STOP` (channel) — fires when leg ends or stop is called.
* `CUSTOM conference::maintenance Action: record` — fires when
  `conference … record` starts/stops (carries `Path`).

T01's allow-list already includes RECORD_START / RECORD_STOP per
T01/RESEARCH §6.

---

## 8. Agent logout teardown

### 8.1 Two paths

**A. Graceful (browser closes, BYE on SIP.js leg):**

1. SIP.js sends BYE → FS receives → CHANNEL_HANGUP → CHANNEL_HANGUP_COMPLETE.
2. mod_conference fires `del-member` for the agent's member-id.
3. Because the agent had `endconf`, after `endconf-grace-time`
   (recommend 5 s, configurable in profile) and no other endconf member
   remains, conf is destroyed. Fires `conference-destroy` event.
4. Conf-maint Node consumer sees `del-member` (Channel-Call-UUID matches
   the agent leg, vici2_role=agent_leg) → debounces 5 s → if no fresh
   join, HSET `t:1:agent:1042 status=OFFLINE` and ZREM from by_status
   ZSETs.
5. If there were customer/3rd-party legs still in the conf when the
   agent dropped, they receive the `endconf-grace-time` warning silence
   then get ejected when conf destroys. **PLAN must address**: should we
   instead try to keep the customer alive (e.g., transfer them to a
   "wait for next agent" parking conf)? For Phase 1, accept that
   agent-disappearance ends the call.

**B. Explicit (logout API call from web UI):**

1. Web UI hits `POST /api/agent/logout` (A03/F05 surface).
2. API authenticates, then issues two ESL commands:
   ```
   bgapi conference agent_1042 kick all
   bgapi uuid_kill <agent-leg-uuid>            # belt-and-suspenders
   ```
3. `kick all` ejects every member (customer/3rd party get hung up
   normally; agent leg's conference app exits, falls through to next
   dialplan action which is usually `<action application="hangup"/>`).
4. Conf destroys (no members). Same Valkey state-flip as path A.

[mod_conference — kick / hup commands](https://confluence.freeswitch.org/display/FREESWITCH/mod%5Fconference)

### 8.2 Janitor backstop (E06)

If a conf somehow survives logout (network partition, crashed Node
consumer, etc.), the channel/conference janitor (E06, Phase 2) sweeps
every 60 s:

```
bgapi conference list summary
```

For each conf with an `agent_<id>` name where the corresponding agent
state in Valkey is OFFLINE for >5 min, issue
`bgapi conference <name> hup all` and increment
`vici2_dialer_orphaned_confs_total`. Defence-in-depth.

[DESIGN §16 — janitor](../../../DESIGN.md),
[Vicidial AST_conf_update_screen.pl analogue](https://vicidial.org/)

---

## 9. Member-id tracking

### 9.1 Why we care

* **Mute / kick / deaf operations** all require `member-id` (or a
  selector like `last` / `non_moderator`). Selectors don't disambiguate
  customer vs 3rd party in a 4-leg conference.
* **Wallboard (S01)** wants to display "customer is muted by agent at
  14:32:08" — needs to map the kick event back to which leg.
* **Audit log (C03)** wants to record exactly which member (call leg)
  was kicked, for dispute resolution.

### 9.2 Three discovery paths

| Method | When | Notes |
|---|---|---|
| **a) `CUSTOM conference::maintenance Action: add-member` event** | At join time, push-based | Carries `Member-ID`, `Channel-Call-UUID`, `Conference-Name`, plus all `vici2_*` chan-vars we set. Canonical source. |
| **b) `uuid_getvar <leg-uuid> conference_member_id`** | On-demand, pull-based | Useful as fallback if event was lost or for legacy code. Returns empty if leg isn't in any conf. |
| **c) `bgapi conference <name> list`** | Periodic reconciliation | Returns one row per member: `member-id;flags;uuid;caller-id-name;caller-id-number;…`. Use in E06 janitor or for debugging. |

[mod_conference — channel variables](https://confluence.freeswitch.org/display/FREESWITCH/mod%5Fconference),
[freeswitch-users 2014-01](http://lists.freeswitch.org/pipermail/freeswitch-users/2014-January/102529.html),
[freeswitch-users 2011-03](http://lists.freeswitch.org/pipermail/freeswitch-users/2011-March/070736.html),
[freeswitch-users 2015-10](https://lists.freeswitch.org/pipermail/freeswitch-users/2015-October/116821.html)

### 9.3 Storage in Valkey

Per F04/PLAN §4.5, agent state lives in `t:{tid}:agent:{user_id}` HASH.
T03 adds a sibling HASH for member-id mapping (transient; lifetime ==
conf lifetime):

| Key | Type | Field | Value | TTL |
|---|---|---|---|---|
| `t:{tid}:agent:{user_id}:conf_members` | HASH | `<call-uuid>` | `<member-id>:<role>` (role ∈ agent / customer / third / supervisor) | none — janitor cleans after agent OFFLINE |
| `t:{tid}:call:{call-uuid}` | HASH (existing per F04) | `conf_member_id` | numeric | call lifetime |
| `t:{tid}:call:{call-uuid}` | HASH | `conf_name` | `agent_<uid>` | call lifetime |

The `:conf_members` HASH is keyed by call-uuid because member-id is only
unique *within* a conference; the call-uuid is globally unique. Lookups
needed:
* "which member-id is the customer?" → iterate members, filter
  `role=customer` (typically only one).
* "kick the agent" → `role=agent`.
* "mute leg X" → reverse-lookup by call-uuid.

The `t:{tid}:call:{call-uuid}` HASH already exists in F04/PLAN §4.6 for
active call state — T03 just adds two fields.

### 9.4 Race: event arrives before HSET completes

If the dialer wants to immediately mute the customer right after
`uuid_transfer`, there's a race between the transfer API reply and the
`add-member` event landing in the Node consumer. Two mitigations:

1. **Don't issue the mute immediately**; the agent UI mute button is the
   only realistic trigger and that requires a human in the loop, hundreds
   of ms after transfer.
2. **Fall back to `uuid_getvar`** if the HASH lookup misses by >100 ms.
   T03 PLAN can spec a helper:
   ```go
   func (c *AgentConf) MemberIDForCall(ctx, agentID, callUUID) (int, error) {
       if id, ok := redisLookup(...); ok { return id, nil }
       return c.esl.UUIDGetVar(ctx, callUUID, "conference_member_id")
   }
   ```

---

## 10. Naming convention (multi-tenant)

### 10.1 The conflict to resolve

Three sources currently disagree:

| Source | Pattern |
|---|---|
| `SPEC.md §4.4` | `conference_${user_id}@default` |
| `spec/modules/T03.md` (Public interface, Pseudocode, Verification) | `conference_${user_id}@default` and `conference_<agent_id>` |
| `spec/modules/F03/PLAN.md §5` and §14.9 | `agent_${user_id}@default` (frozen in F03; advertise glob `agent_*@default`; F03 ships a working stub at this name) |

F03 PLAN explicitly states the name pattern is *"frozen"* in §14.9:
> **Conference name pattern:** `agent_<user_id>@default` — frozen.

F03 was approved upstream of T03 and ships dialplan + profile glob using
`agent_*`. Touching that ripples into F03's stub dialplan and SIPp tests.

### 10.2 Recommendation: adopt F03's `agent_<user_id>` and update SPEC

* **Keep `agent_` prefix.** Reasons:
  - F03 has shipped — changing now is a regression on an upstream module.
  - `agent_` is shorter and clearer than `conference_`; `conference_*` is
    a category, not a label, and reads redundantly in events
    (`Conference-Name: conference_1042` vs `Conference-Name: agent_1042`).
  - The advertise glob `agent_*@default` is already in F03's profile.
* **Multi-tenant: extend now, not later.** Per SPEC §4.5
  ("Tenant ID everywhere from day 1"), the Phase 1 default tenant is 1
  but the *naming convention* must be Phase-4 ready without rename. So:

  | Phase | Single-tenant compatible | Pattern |
  |---|---|---|
  | **Recommended (T03 PLAN proposes via RFC)** | yes | `agent_t<tenant_id>_u<user_id>@default` (e.g., `agent_t1_u1042@default`) |
  | **Compromise: keep F03 stub, add tenant later** | yes (Phase 1 only has tenant 1) | `agent_<user_id>@default` Phase 1 → `agent_<tenant_id>_<user_id>@default` Phase 4 (one-shot rename) |

  Strong recommendation: **`agent_t<tid>_u<uid>@default`**. Costs nothing
  in Phase 1 (just a more verbose string), avoids a Phase-4 migration
  where every running conference would need to be quiesced and renamed.
  globally.

  The advertise glob `agent_*@default` already covers this.

* **PLAN action items:**
  - Open `RFC-NNN-conference-naming.md` (per SPEC §12) updating SPEC §4.4
    and T03.md to `agent_t<tid>_u<uid>@default`.
  - Update F03 stub dialplan (`01_agent_conference.xml`) to compute the
    name as `agent_t${vici2_tenant_id}_u${1}@default`.
  - Define a single source-of-truth helper used by Go and Node:
    ```go
    func ConferenceName(tenantID, userID int64) string {
        return fmt.Sprintf("agent_t%d_u%d", tenantID, userID)
    }
    ```
    Mirror in TS as `confName(tid, uid)` exported from
    `shared/types/src/index.ts`.

### 10.3 Why `@default` (the profile suffix) stays

`@<profile>` selects the conference profile to apply. F03 ships a single
profile named `default` (F03/PLAN §5). Future profile additions (e.g.,
`hold` for customer-on-hold MoH conferences per §6.2 above) use the same
suffix syntax: `agent_t1_u1042_hold@hold`. No change to the agent-conf
profile name.

---

## 11. API surface (Go package signatures)

This is the *proposed* API for `dialer/internal/conference/`. PLAN
finalizes; this is the research-phase draft. Signatures align with T01's
Conn / ConferenceCommand primitive (T01/RESEARCH §"API surface").

```go
package conference

import (
    "context"
    "github.com/<repo>/dialer/internal/esl"
    "github.com/<repo>/dialer/internal/redis"
)

// AgentConf is the per-agent conference operator. One instance per
// dialer process; safe for concurrent use. Wraps an ESL Conn and a
// Valkey client.
type AgentConf struct {
    esl   esl.Conn
    redis redis.Client
    log   *slog.Logger
}

// New returns an AgentConf bound to the given ESL connection and Valkey
// client. Both must outlive the AgentConf.
func New(c esl.Conn, r redis.Client, log *slog.Logger) *AgentConf

// Name returns the canonical conference name for an agent. Pure function;
// callers may use it directly when crafting transfer strings.
//   "agent_t1_u1042"
func (c *AgentConf) Name(tenantID, userID int64) string

// JoinAgent does NOT initiate a conference join (the agent's SIP.js
// dialplan does). It simply confirms the conf exists and updates Valkey
// state to READY. Idempotent. Called by the conf-maint event handler
// when add-member arrives with vici2_role=agent_leg.
//
// Returns the member-id assigned by mod_conference.
func (c *AgentConf) JoinAgent(ctx context.Context,
    tenantID, userID int64, callUUID string, memberID int) error

// TransferCustomer moves a customer's call leg into the agent's conf.
// MUST be called only when the agent is READY (caller's responsibility;
// this method does NOT check). Uses join-only flag to prevent orphan
// conf creation if agent has logged out.
//
// Pre-sets vici2_* chan-vars on the customer leg before transfer.
// Returns the Job-UUID of the bgapi command. The actual member-id
// arrives via add-member event later.
func (c *AgentConf) TransferCustomer(ctx context.Context,
    tenantID, userID int64, customerCallUUID string,
    leadID, campaignID int64) (jobUUID string, err error)

// AddThirdParty originates a third leg directly into the agent's conf.
// Uses join-only so it fails if conf doesn't exist. Returns the
// Job-UUID; caller listens for BACKGROUND_JOB to get +OK / -ERR and
// for add-member to get the member-id.
func (c *AgentConf) AddThirdParty(ctx context.Context,
    tenantID, userID int64, gateway, dest string,
    cidName, cidNumber string) (jobUUID, originatedUUID string, err error)

// MuteMember mutes a specific member by member-id. Use Selector for
// "last" / "non_moderator" / "all".
func (c *AgentConf) MuteMember(ctx context.Context,
    tenantID, userID int64, memberID int) error
func (c *AgentConf) UnmuteMember(ctx context.Context,
    tenantID, userID int64, memberID int) error
func (c *AgentConf) MuteSelector(ctx context.Context,
    tenantID, userID int64, sel string) error  // sel ∈ "all"|"last"|"non_moderator"

// Hold moves the customer to a parking conference with MoH. Resume
// reverses the move. Both operations preserve recording (the
// recording_follow_transfer var on the customer leg).
func (c *AgentConf) Hold(ctx context.Context,
    tenantID, userID int64, customerCallUUID string) error
func (c *AgentConf) Resume(ctx context.Context,
    tenantID, userID int64, customerCallUUID string) error

// LeaveThreeWay kicks the agent leg out of the conf, leaving customer +
// 3rd party bridged. Uses 'kick' (sound silenced in profile).
func (c *AgentConf) LeaveThreeWay(ctx context.Context,
    tenantID, userID int64) error

// KickMember ejects a specific member (used by supervisors, S03).
func (c *AgentConf) KickMember(ctx context.Context,
    tenantID, userID int64, memberID int) error

// RecordConference starts a mixed-audio recording on the conference.
// Phase 1 callers should NOT use this — recording happens at the
// customer-leg level via record_session. This is reserved for
// supervisor "QA capture" flows in later phases.
func (c *AgentConf) RecordConference(ctx context.Context,
    tenantID, userID int64, path string) error
func (c *AgentConf) StopRecordConference(ctx context.Context,
    tenantID, userID int64, path string) error

// DestroyAgentConf is the explicit logout teardown. Issues
// `conference … kick all` then optionally uuid_kill on the agent leg
// for belt-and-suspenders. Idempotent (returns nil if conf doesn't
// exist).
func (c *AgentConf) DestroyAgentConf(ctx context.Context,
    tenantID, userID int64) error

// MemberIDForCall returns the member-id for a call leg currently in the
// agent's conference. Tries Valkey HASH first; falls back to
// uuid_getvar. Returns ErrNotInConference if the leg isn't a member.
func (c *AgentConf) MemberIDForCall(ctx context.Context,
    tenantID, userID int64, callUUID string) (int, error)

// ListMembers returns all members of the agent's conference. Used by
// E06 janitor and S01 wallboard.
func (c *AgentConf) ListMembers(ctx context.Context,
    tenantID, userID int64) ([]Member, error)

type Member struct {
    MemberID  int
    CallUUID  string
    Role      string  // agent | customer | third | supervisor
    CIDName   string
    CIDNumber string
    Flags     []string
    JoinedAt  time.Time
}

// Errors
var (
    ErrConfNotFound      = errors.New("conference: not found (agent not logged in)")
    ErrNotInConference   = errors.New("conference: leg not in conference")
    ErrAgentNotReady     = errors.New("conference: agent not in READY state")
)
```

### 11.1 Node-side counterpart

The Node API surface for T03 is much smaller — just the conf-maint event
handler. Lives at `api/src/esl/handlers/conference-maint.ts` and
`api/src/services/agent-presence.ts`:

```ts
// Stateless event router.
export function handleConferenceMaintenance(
  evt: EslEvent,
  ctx: HandlerCtx,
): Promise<void>;

// Updates Valkey agent state.
export const agentPresence = {
  async onJoin(tid: number, uid: number, callUuid: string, memberId: number, conf: string): Promise<void>,
  async onLeave(tid: number, uid: number, callUuid: string, memberId: number): Promise<void>,
  async debounceOffline(tid: number, uid: number, ms: number): Promise<void>,
};
```

These are out-of-scope for the Go package but must match the same Valkey
key naming.

---

## 12. Open questions for PLAN

1. **(BLOCKING) Conference name pattern.** SPEC and F03 disagree.
   Recommendation: `agent_t<tid>_u<uid>@default` via RFC. PLAN must
   resolve before any code is written. (§10)
2. **`endconf-grace-time` value.** Profile default is 60 s; we want
   ≤5 s for snappy OFFLINE detection. PLAN to pick exact value (5 s
   default; tunable per ops feedback). (§3.5, §8)
3. **Hold conference profile.** Need a 2nd profile in
   `conference.conf.xml` for customer-on-hold MoH. PLAN to define
   profile `hold` with `moh-sound=local_stream://moh`, `nomoh=false`,
   single-member-allowed. (§6.2)
4. **Customer-leg fate on agent-disappearance.** Today: agent dropping
   destroys conf, customer hangs up. Better UX: queue customer to next
   READY agent. Phase-1 PLAN may accept current behavior; revisit when
   I04 (closer/blended) lands. (§8.1)
5. **Stereo recording.** Per-leg recorder gives stereo (cust + mix).
   True 3-channel separation requires post-processing in R02. PLAN to
   confirm we accept the 2-channel "customer + everyone-else"
   compromise for Phase 1. (§7.2)
6. **Conf-maint event volume at scale.** With 500 agents × 200
   calls/day = 100k member-add + 100k member-remove + chatter. T01
   already filters subclass=conference::maintenance — fine. But the
   conf-maint handler should batch HSET via pipeline (Valkey RTT cost).
   PLAN to spec batch size & flush interval. (§3.1)
7. **Cross-tenant safety.** Once `agent_t<tid>_u<uid>` is used, ensure
   no code path lets tenant 1 issue ops against tenant 2's conferences.
   Enforce in the `Name()` function being the only producer of conf
   names; lint rule forbids raw `"agent_"` string concat. (§10.2)
8. **Member-id reuse after conf destroy.** When a conf is destroyed and
   re-created (agent re-login), member-ids restart at 1. PLAN must
   ensure Valkey state is wiped on `conference-destroy` event so we
   don't carry stale IDs. (§9.3)
9. **`conference_member_flags` vs `+flags{…}` syntax.** Both work.
   PLAN to pick one for consistency. Recommendation:
   `conference_member_flags` chan-var (more explicit, easier to template
   from Go without dial-string escaping).
10. **Logout debounce conflict with `endconf-grace-time`.** If both fire
    (FS waits 5 s, our handler also waits 5 s), worst case is 10 s
    OFFLINE detection. PLAN to align the two timers or document why
    they're independent. (§3.5, §8)
11. **3-way press-1 (Vicidial AGENT_3WAY_PRESS-1_CALLS.txt).** Spec
    silent on whether this Phase-1 feature is required. Can be added
    later with `bind_meta_app` in dialplan; flag for A07 handover. (§5.1)
12. **What CDR / event do we emit when conf is destroyed?** The
    `conference-destroy` event covers FS-side; the API should emit
    `vici2.agent.offline` (Redis Stream) so downstream (S01 wallboard,
    M08 reports) updates. PLAN to spec the schema in
    `shared/events/agent-offline.json`.

---

## 13. Citations

### 13.1 FreeSWITCH official docs

1. mod_conference (signalwire) — full API command reference, profile
   parameters, channel variables, member flags, conference flags, events.
   <https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Modules/mod_conference_3965534/>
2. mod_conference (confluence mirror) — same content, older URL still
   surfaces top in Google.
   <https://confluence.freeswitch.org/display/FREESWITCH/mod%5Fconference>
3. mod_conference 1.7 reference (Chinese, but command list authoritative
   for older but still valid commands).
   <https://www.freeswitch.org.cn/books/references/1.7-mod_conference.html>
4. Conference subsystem overview.
   <https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Conference/>
5. Conference Add Call Example — moderator-with-bind-digit pattern.
   <https://freeswitch.org/confluence/display/FREESWITCH/Conference+Add+Call+Example>
6. Inline Dialplan — `app:arg ... inline` syntax used for
   `uuid_transfer ... conference:NAME inline`.
   <https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Dialplan/Inline-Dialplan_13173434/>
7. Music on Hold — local_stream usage, vars.xml hold_music.
   <https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Configuration/Music-on-Hold_6587503/>
8. mod_local_stream — directory config, sample rates, MoH source.
   <https://freeswitch.org/confluence/display/FREESWITCH/mod_local_stream>
9. Channel variables: `conference_uuid`, `conference_member_id`,
   `conference_name`, `conference_recording`, `conference_moderator`.
   <https://developer.signalwire.com/freeswitch/Channel-Variables-Catalog/conference_uuid_16352952>
10. `hangup_after_conference` channel variable.
    <https://developer.signalwire.com/freeswitch/Channel-Variables-Catalog/hangup_after_conference_16352955/>
11. `conference_auto_outcall_flags` channel variable.
    <https://developer.signalwire.com/freeswitch/Channel-Variables-Catalog/conference_auto_outcall_flags_16352924/>
12. Event headers reference (`Action`, `Conference-Name`, `Member-ID`,
    `Conference-Unique-ID` headers used on conference::maintenance).
    <https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Introduction/Event-System/Event-headers_32178341/>
13. mod_commands — `uuid_transfer`, `uuid_record`, `uuid_setvar`
    canonical reference.
    <https://www.freeswitch.org/confluence/display/FREESWITCH/mod%5Fcommands>

### 13.2 FreeSWITCH-users mailing list (production patterns)

14. `uuid_transfer ... conference:confName@default inline` pattern (the
    canonical recipe).
    <http://lists.freeswitch.org/pipermail/freeswitch-users/2013-February/092545.html>
15. Implicit conference creation on first transfer.
    <https://lists.freeswitch.org/pipermail/freeswitch-users/2010-November/065435.html>
16. Conferences are dynamic; first member starts the conf thread.
    <https://lists.freeswitch.org/pipermail/freeswitch-users/2008-June/031720.html>
17. Two parked UUIDs into one new conf via `uuid_transfer`.
    <http://lists.freeswitch.org/pipermail/freeswitch-users/2012-April/082918.html>
    <http://lists.freeswitch.org/pipermail/freeswitch-users/2012-April/083004.html>
18. add-member event delay under load (worst-case 7 s).
    <http://lists.freeswitch.org/pipermail/freeswitch-users/2013-August/098396.html>
19. member_id discovery via `uuid_getvar conference_member_id`.
    <http://lists.freeswitch.org/pipermail/freeswitch-users/2011-March/070736.html>
    <http://lists.freeswitch.org/pipermail/freeswitch-users/2014-January/102529.html>
20. Outbound socket + add-member event filter pitfalls.
    <https://lists.freeswitch.org/pipermail/freeswitch-users/2015-October/116821.html>
21. `endconf` flag with originate.
    <http://lists.freeswitch.org/pipermail/freeswitch-users/2013-February/092244.html>
22. Stereo recording on conference — not honoured.
    <https://lists.freeswitch.org/pipermail/freeswitch-users/2016-July/121601.html>
23. RECORD_STEREO same-channel issue (same root cause).
    <https://lists.freeswitch.org/pipermail/freeswitch-users/2018-June/130085.html>
24. record_session vs uuid_record vs conference record CPU/disk
    differences.
    <http://lists.freeswitch.org/pipermail/freeswitch-users/2008-October/035088.html>
25. uuid_record + RECORD_STEREO + uuid_setvar (channel state caveat).
    <https://lists.freeswitch.org/pipermail/freeswitch-users/2012-December/090921.html>
26. Dynamic moh-sound via channel var (per-conf hold music).
    <http://lists.freeswitch.org/pipermail/freeswitch-users/2016-June/120991.html>
27. Conference-flags `wait-mod`, `audio-always`.
    <http://lists.freeswitch.org/pipermail/freeswitch-users/2009-May/042401.html>
28. Bridge call + join conference — one-way to do it.
    <http://lists.freeswitch.org/pipermail/freeswitch-users/2016-June/120791.html>
29. mod_conference user classes / member flags discussion.
    <http://lists.freeswitch.org/pipermail/freeswitch-dev/2010-June/003846.html>
30. Global limit on conference legs (no built-in cap besides
    `max-members` per-profile).
    <http://lists.freeswitch.org/pipermail/freeswitch-users/2009-January/037729.html>

### 13.3 Performance / scale

31. Issue #1729 — "Artoo R2D2" thread-creation wall at ~900 conferences
    / 1796 sessions on c5.9xlarge.
    <https://github.com/signalwire/freeswitch/issues/1729>
32. 2020-08 mailing list — Artoo at low session counts (ulimit fix).
    <https://lists.freeswitch.org/pipermail/freeswitch-users/2020-August/133879.html>
33. 2017-04 — limiting number of conferences (no `max-conferences`
    setting).
    <https://lists.freeswitch.org/pipermail/freeswitch-users/2017-April/125737.html>
34. Issue #895 — RECORD_STEREO + record_sample_rate not honoured by
    mod_conference recorder.
    <https://github.com/signalwire/freeswitch/issues/895>
35. PR #1138 — `conference setvar` / `getvar` API additions (1.10.5+).
    <https://github.com/signalwire/freeswitch/pull/1138>
36. signalwire freeswitch-docs source (mod_conference.mdx).
    <https://github.com/signalwire/freeswitch-docs/tree/main/docs/FreeSWITCH-Explained/Modules/mod_conference_3965534.mdx>

### 13.4 O'Reilly *FreeSWITCH 1.8* (Maruzzelli & Minessale)

37. conference-flags chapter — `audio-always`, `wait-mod`.
    <https://www.oreilly.com/library/view/freeswitch-18/9781785889134/df05026f-6130-4276-891e-e3c25c029414.xhtml>
38. member-flags chapter — moderator/wasteful/leader semantics.
    <https://www.oreilly.com/library/view/freeswitch-1-8/9781785889134/7d4d8473-768c-479c-bd79-78134eb89e47.xhtml>

### 13.5 Vicidial (Asterisk MeetMe pattern we leapfrog from)

39. AGENT_API.txt `transfer_conference` enum (BLIND, DIAL_WITH_CUSTOMER,
    LEAVE_3WAY_CALL, etc.).
    <https://vicidial.org/docs/AGENT_API.txt>
40. AGENT_3WAY_PRESS-1_CALLS.txt — outside-user must press 1 before
    bridge.
    <https://vicidial.org/docs/AGENT_3WAY_PRESS-1_CALLS.txt>
41. VICIDIALforum — LEAVE 3-WAY semantics.
    <http://vicidial.org/VICIDIALforum/viewtopic.php?f=4&t=4675>
42. VICIDIALforum — 3-way hangup, callerid challenges.
    <https://www.vicidial.org/VICIDIALforum/viewtopic.php?t=27731>
43. VICIDIALforum — "Leave 3-way" stuck after heavy use.
    <https://www.vicidial.org/VICIDIALforum/viewtopic.php?t=38074>
44. VICIDIALforum — Leave-3-way not working from agc/vicidial.php.
    <https://www.vicidial.org/VICIDIALforum/viewtopic.php?t=24496>
45. StackOverflow — vicidial 3-way transfer call flow walk-through
    ("transfers in Vicidial are nothing more than people entering a
    conference").
    <https://stackoverflow.com/questions/18852917/vicidial-3-way-call-transfer-issue>

### 13.6 Internal references

46. `DESIGN.md` §1.3-1.4 (conference-per-agent rationale + transfer enum)
    and §13 (mod_conference scale).
47. `SPEC.md` §4.4 (sacred conference-per-agent invariant), §4.5 (tenant
    everywhere), §12 (RFC process).
48. `spec/modules/T03.md` (this module's contract).
49. `spec/modules/F03/PLAN.md` §4.2 (stub agent_conference dialplan), §5
    (conference profile XML), §14.9 (frozen name pattern).
50. `spec/modules/T01/RESEARCH.md` §"Common ESL operations" (uuid_transfer
    / conference command), §"API surface" (ConferenceCommand /
    UUIDTransfer).
51. `spec/modules/F04/PLAN.md` §4.5 (agent state HASH), §4.6 (active call
    HASH).

---

*End of T03 RESEARCH. Next deliverable: `spec/modules/T03/PLAN.md`
(blocked on the naming-convention RFC).*
