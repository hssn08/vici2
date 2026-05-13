# T03 — Agent-Conference Primitive: PLAN

| Field | Value |
|---|---|
| **Status** | PROPOSED — input to IMPLEMENT |
| **Track** | Telephony · **Phase** 1 |
| **Author** | T03 PLAN sub-agent (Claude Opus 4.7, 1M ctx) |
| **Module spec** | [`spec/modules/T03.md`](../T03.md) |
| **RESEARCH** | [`spec/modules/T03/RESEARCH.md`](./RESEARCH.md) (1229 lines, 51 citations) |
| **Governing RFC** | [`spec/rfc/RFC-002-conference-naming.md`](../../rfc/RFC-002-conference-naming.md) — **ACCEPTED** |
| **Sacred reference** | [`SPEC.md` §4.4](../../../SPEC.md) — conference-per-agent invariant (this PLAN updates §4.4 example name; semantics unchanged) |

> **Scope.** This plan freezes the public surface of the T03 module:
> conference name format, lifecycle state machine, helper-function API
> (Go + TS), member-id tracking strategy, recording strategy hand-off to
> R01, hold/mute/kick/3-way/leave-3-way operations, cross-tenant guard,
> downstream module hand-offs, and the F03/SPEC amendments T03 IMPLEMENT
> will file. **No Go code in this PLAN.** IMPLEMENT phase will produce
> code; this PLAN is the freeze.

---

## 0. TL;DR (10 bullets)

1. **Conference name** `agent_t<tid>_u<uid>@default` (RFC-002 ACCEPTED). Phase 1
   (single-tenant) value: `agent_t1_u1042@default`. Single source-of-truth helper
   in Go (`dialer/internal/conference/name.go`) and TS
   (`shared/types/src/conference.ts`).
2. **Lifecycle = SIP.js → park-and-join extension → moderator member of an
   implicitly-created conference.** No `conference create` API call ever issued
   (mod_conference 1.10 has none — first member instantiates).
3. **Park-and-join extension pattern** `*9${tid}_${uid}` (e.g., `*91_1042`).
   Browser dials this on login; dialplan verifies `${sip_authorized_user}`
   matches `${uid}`; agent joins with member flags
   `moderator,nomoh,endconf,join-only`. Wrong-tenant or wrong-user attempt =
   403 Forbidden.
4. **`endconf-grace-time=5`** (override the FS default 60 s). T03 IMPLEMENT
   files an F03 amendment to add this param to the `default` conference profile.
5. **Customer transfer-in** is a single ESL primitive call:
   `T01.UUIDTransfer(customerUUID, "conference:agent_t<tid>_u<uid>@default+flags{join-only}", "inline", "default")`.
   `+flags{join-only}` is mandatory on every non-agent transfer to prevent orphan
   conf creation if agent has logged out.
6. **Member-id tracking** is event-driven (push) via `CUSTOM
   conference::maintenance` `Action: add-member` / `del-member` consumed by T01
   enrichment, with `uuid_getvar conference_member_id` as a fallback for the
   ≤7 s add-member event delay observed under load.
7. **Recording** is per-leg on the **customer** leg with `RECORD_STEREO=true`
   + `recording_follow_transfer=true` set in the `customer_into_agent_conf`
   dialplan extension (R01 owns; T03 does NOT issue any `uuid_record` against
   the conference).
8. **Hold UX** = move customer to a 2nd conference profile `hold` (single-member,
   MOH on, no `nomoh`). T03 IMPLEMENT files an F03 amendment to add the `hold`
   profile to `conference.conf.xml`. Resume = reverse `conference … transfer`.
9. **Mute / mute-customer / kick / 3-way / leave-3-way** are all
   `T01.ConferenceCommand` invocations with member-id resolved via
   `t:{tid}:agent:{uid}:conf_members` HASH (or fallback `uuid_getvar`).
10. **Lint guards** (CI-blocking, per RFC-002): golangci-lint custom check +
    ESLint custom rule forbid raw `"agent_"` string literal in conference
    contexts. Only the `ConferenceName` / `confName` helpers may produce conf
    names.

---

## 1. Conference name format (FROZEN per RFC-002)

### 1.1 Decision

```
agent_t<tenant_id>_u<user_id>@default
```

Examples:
- Phase 1, single-tenant, user 1042: `agent_t1_u1042@default`
- Phase 4, tenant 17, user 1042: `agent_t17_u1042@default`

The conference profile glob `agent_*@default` already shipped in
F03/PLAN §5 covers both forms; no profile change required.

### 1.2 Helper functions (single source of truth)

**Go** — `dialer/internal/conference/name.go`:

```go
package conference

import "fmt"

// ConferenceName returns the canonical, lint-enforced conference name
// for an agent's per-agent conference. This is the ONLY place in the
// code base allowed to assemble an "agent_*" conference name.
//
// Phase 1: tenantID is always 1.
// Phase 4: tenantID is the multi-tenant scoping id from JWT claims.
//
// Format: agent_t<tenantID>_u<userID>
//
// Callers must append "@default" (or another profile) when handing the
// name to FS APIs that expect a profile suffix; see ConferenceFQN below.
func ConferenceName(tenantID, userID int64) string {
    return fmt.Sprintf("agent_t%d_u%d", tenantID, userID)
}

// ConferenceFQN returns the name with profile suffix, suitable for use
// directly in conference: URIs (e.g., uuid_transfer destinations).
//
//   ConferenceFQN(1, 1042, "default") = "agent_t1_u1042@default"
//   ConferenceFQN(1, 1042, "hold")    = "agent_t1_u1042@hold"
func ConferenceFQN(tenantID, userID int64, profile string) string {
    return ConferenceName(tenantID, userID) + "@" + profile
}

// HoldConferenceName returns the parking-conference name used during
// the hold UX (different profile to enable MOH).
//
// Format: agent_t<tenantID>_u<userID>_hold
func HoldConferenceName(tenantID, userID int64) string {
    return fmt.Sprintf("agent_t%d_u%d_hold", tenantID, userID)
}
```

**TypeScript** — `shared/types/src/conference.ts`:

```ts
// confName returns the canonical, lint-enforced conference name for an
// agent's per-agent conference. Mirrors dialer/internal/conference.ConferenceName.
//
// Format: agent_t<tenantId>_u<userId>
export function confName(tenantId: number, userId: number): string {
  return `agent_t${tenantId}_u${userId}`;
}

// confFQN returns the name with profile suffix.
export function confFQN(tenantId: number, userId: number, profile = 'default'): string {
  return `${confName(tenantId, userId)}@${profile}`;
}

// holdConfName returns the parking-conference name (for the hold UX).
export function holdConfName(tenantId: number, userId: number): string {
  return `agent_t${tenantId}_u${userId}_hold`;
}
```

Both helpers are PURE FUNCTIONS — no I/O, no logging, no side effects, no
Valkey/MySQL access. Trivially unit-testable.

### 1.3 Lint guards (CI-blocking)

Per RFC-002 §"How to apply":

| Tool | Rule | Forbidden | Allowed |
|---|---|---|---|
| golangci-lint (custom analyzer in `dialer/tools/lints/agentprefix/`) | "agent prefix in conference contexts" | `"agent_" + …`, `fmt.Sprintf("agent_…")`, `"agent_t%d_u%d"` | calls to `conference.ConferenceName` / `conference.ConferenceFQN` / `conference.HoldConferenceName` |
| ESLint custom rule (`tools/eslint-rules/no-raw-conf-name.js`) | same intent for TS | string-literal regex `/agent_t?\d/` outside `shared/types/src/conference.ts` and the rule's allow-list | calls to `confName` / `confFQN` / `holdConfName` |

The lint rules ship as part of T03 IMPLEMENT; CI workflows already run
`golangci-lint` and `eslint` per `.github/workflows/ci.yml`.

### 1.4 Phase-4 zero-cost migration

`tenant_id` is always `1` in Phase 1, so the names are always
`agent_t1_u<uid>@default`. When multi-tenant lands (Phase 4):

- All call sites already pass `tenantID` through; no signature change.
- The advertise glob `agent_*@default` is unchanged.
- No running conference needs to be quiesced and renamed (the cost
  the simpler `agent_<uid>` form would incur).

---

## 2. Lifecycle state machine

The agent conference progresses through six states. State transitions are
driven by SIP signalling (login/logout) and ESL events (`add-member` /
`del-member` / `conference-create` / `conference-destroy`). T03 owns
states 1-3 and 6; T01/E04/A07 drive states 4-5.

```
            ┌────────────────────────────────────────────────────────┐
            │                                                        │
            ▼                                                        │
    ┌───────────────┐  SIP INVITE *9{tid}_{uid}                      │
 ┌─►│  S1 LOGGED_IN │──────────────────────────────────────┐         │
 │  └───────────────┘                                      │         │
 │                                                         ▼         │
 │  agent SIP.js                                  ┌────────────────┐ │
 │  closes browser                                │ S2 PARK+JOIN   │ │
 │  / network gone                                │ (conference    │ │
 │                                                │  app, +flags{  │ │
 │                                                │  moderator,    │ │
 │                                                │  nomoh,endconf,│ │
 │                                                │  join-only})   │ │
 │                                                └───────┬────────┘ │
 │                                                        │ add-member│
 │                                                        ▼          │
 │                                              ┌──────────────────┐ │
 │                                              │  S3 IDLE         │ │
 │                                              │  (1 member,      │ │
 │                                              │   silence/CN)    │ │
 │                                              └────────┬─────────┘ │
 │                                                       │           │
 │                                  T01.UUIDTransfer     │           │
 │                                  (customer leg)       │           │
 │                                                       ▼           │
 │                                              ┌──────────────────┐ │
 │                                              │  S4 ON_CALL      │ │
 │                                              │  (≥2 members,    │ │
 │                                              │   maybe 3-way 4+)│ │
 │                                              └────────┬─────────┘ │
 │                                                       │           │
 │                              customer / 3rd-party     │           │
 │                              del-member (last leaves) │           │
 │                                                       ▼           │
 │                                              ┌──────────────────┐ │
 │                                              │  S3 IDLE again   │ │
 │                                              └────────┬─────────┘ │
 │                                                       │           │
 │                            POST /api/agent/logout     │           │
 │                            (or BYE on SIP.js leg)     │           │
 │                                                       ▼           │
 │                                              ┌──────────────────┐ │
 │                                              │  S6 TEARDOWN     │ │
 │                                              │  (kick all,      │ │
 │                                              │   uuid_kill)     │ │
 │                                              └────────┬─────────┘ │
 │                                                       │           │
 │                                                       ▼           │
 └─────────────── (state cleanup) ──────────── conference-destroy ───┘
```

### 2.1 State 1 → State 2: agent login (SIP INVITE)

- A02 (browser softphone) places `INVITE sip:*9${tid}_${uid}@${domain}`
  via SIP.js over WSS.
- Sofia digest-auth completes. The `wss` profile (F03/PLAN §2.2)
  forwards into `default` dialplan context.
- T03 IMPLEMENT replaces F03's stub `01_agent_conference.xml` (F03/PLAN
  §4.2) with the production extension below (final XML deferred to
  IMPLEMENT; structure frozen here).

```xml
<extension name="agent_conference_join">
  <condition field="destination_number" expression="^\*9(\d+)_(\d+)$">
    <!-- $1 = tenant_id, $2 = user_id -->
    <condition field="${sip_authorized_user}" expression="^${2}$" break="never">
      <action application="answer"/>
      <action application="set" data="vici2_tenant_id=$1"/>
      <action application="set" data="vici2_user_id=$2"/>
      <action application="set" data="vici2_role=agent_leg"/>
      <action application="set" data="vici2_conf_name=agent_t${1}_u${2}"/>
      <action application="set" data="conference_auto_record=false"/>
      <action application="set" data="hangup_after_conference=true"/>
      <action application="conference"
              data="agent_t${1}_u${2}@default+flags{moderator,nomoh,endconf,join-only}"/>
      <anti-action application="respond" data="403 Forbidden"/>
      <anti-action application="hangup" data="USER_NOT_AUTHORIZED"/>
    </condition>
  </condition>
</extension>
```

Notes:

- `${sip_authorized_user}` (post-digest, attacker-cannot-spoof) is the auth
  source per RESEARCH §3.2.
- `+flags{… join-only}` looks paradoxical for the *first* joiner but is safe:
  for the agent (moderator) `join-only` is a no-op when combined with the
  conference application; mod_conference instantiates the conf because the
  agent IS the first member. We carry it for semantic uniformity (every
  caller that ever joins the conf carries `join-only` so misconfigurations
  fail closed). Confirmed against [signalwire docs](https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Modules/mod_conference_3965534/)
  and `confluence/mod_conference` Member-Flags table.
- `hangup_after_conference=true` ensures BYE on the agent leg cleanly hangs
  up if the conference is destroyed by `kick all` (state 6 graceful teardown).
- T03 sets `vici2_tenant_id` and `vici2_user_id` channel vars so they show
  up as headers on every `CUSTOM conference::maintenance` event for that
  member — the conf-maint handler reads them with no DB lookup.

### 2.2 State 2 → State 3: implicit conference creation

- mod_conference fires `CUSTOM conference::maintenance` with
  `Action: conference-create` (subclass header), then `Action: add-member`.
- T01 enrichment forwards both events (T01/PLAN §11 event-mapping table).
- T03's `agent-presence` handler (Node side, `api/src/services/agent-presence.ts`)
  consumes `add-member` where `vici2_role=agent_leg`:
  - `HSET t:1:agent:1042 status=READY conf_name=agent_t1_u1042 conf_member_id=1 last_change_at=<ts>`
  - `ZADD t:1:agents:by_status:READY <ts> 1042`
  - `XADD events:vici2.agent.state_changed * tenant_id=1 user_id=1042 from=LOGOUT to=READY`
  - `PUBLISH t:1:broadcast:agent:1042 …` (push to A03 WS gateway → screen)

The `t:1:agent:1042` HASH layout is exactly per F04/PLAN §4.5; T03 adds
two new fields to it: `conf_name` and `conf_member_id`. Documented in
§5.2 below.

### 2.3 State 3 (idle): agent alone, silence

- `nomoh` member flag overrides the profile's `moh-sound=local_stream://moh`,
  so the agent hears **silence** (not MOH) while waiting for a call. Comfort
  noise from the F03 profile (`comfort-noise=true`) supplies a faint hiss
  so the browser's audio path stays alive (some VoIP endpoints mute on
  prolonged silence).
- Memory cost ~1 KB per idle conf; CPU ~0 above the conf-thread tick (20 ms
  default in F03 `default` profile).

### 2.4 State 3 → State 4: customer transfer-in

T01 (called by E04 picker once an agent is matched to a leg) issues:

```
bgapi uuid_setvar_multi <cust-uuid> vici2_role=customer_leg;vici2_user_id=1042;
                                    vici2_tenant_id=1;vici2_call_uuid=<cust-uuid>;
                                    conference_member_flags=
bgapi uuid_transfer <cust-uuid> conference:agent_t1_u1042@default+flags{join-only} inline
```

In the dialer Go code this is:

```
T01.Client.UUIDSetVarMulti(ctx, fsHost, custUUID, map[string]string{
    "vici2_role":              "customer_leg",
    "vici2_user_id":           "1042",
    "vici2_tenant_id":         "1",
    "vici2_call_uuid":         custUUID,
    "conference_member_flags": "",   // explicit empty = NO endconf
})
T01.Client.UUIDTransfer(ctx, fsHost, custUUID,
    "conference:" + conference.ConferenceFQN(1, 1042, "default") + "+flags{join-only}",
    "inline",  // dialplan
    "default", // context
)
```

(`UUIDSetVarMulti` is added to T01 in T01/PLAN §8 — already exists as
`UUIDSetVar` for single-key; if multi-key isn't there yet, T03 IMPLEMENT
files a T01 amendment for the multi-key form. Fallback: N successive
`UUIDSetVar` calls.)

The empty `conference_member_flags=""` overrides any default `endconf`
inherited from the profile, ensuring the customer's hangup does NOT
collapse the conference.

`+flags{join-only}` causes the transfer to fail-closed if the conference
no longer exists (agent already logged out): the customer leg gets a
hangup cause `INVALID_GATEWAY` rather than spawning an orphan conference.

### 2.5 State 4 → State 3: customer leaves (call ends)

- Customer hangs up → `CHANNEL_HANGUP_COMPLETE` on customer leg → mod_conference
  fires `Action: del-member` for the customer's member-id.
- Conf-maint handler removes from `t:1:agent:1042:conf_members` HASH and
  from `t:1:call:<cust-uuid>` HASH.
- Agent leg remains in conf with `endconf` flag; conf survives because
  agent is a moderator with `endconf`. Agent state stays in S3 IDLE
  (status=READY); no transition needed if already in the proper status,
  or transition INCALL → WRAPUP per dialer disposition flow (E04/A07 own that).

### 2.6 State 3/4 → State 6: agent logout

Two paths:

**Graceful (browser closes / network drops):**
1. SIP.js BYE arrives → `CHANNEL_HANGUP` on agent leg → mod_conference fires
   `del-member` for agent member-id.
2. Agent had `endconf`, so after `endconf-grace-time=5s` (overridden in
   profile per §6 amendment) the conference auto-destroys (assuming no
   other endconf-carrier — there isn't one in our model).
3. Conf-maint handler debounces 5 s on `del-member` (vici2_role=agent_leg).
   If a fresh `add-member` arrives within the window (re-join blip),
   cancel the OFFLINE flip; otherwise:
   - `HSET t:1:agent:1042 status=LOGOUT last_change_at=<ts>` (or DEL for hard
     wipe; F04/PLAN §4.5 says `DEL on logout`).
   - `ZREM` from all `t:1:agents:by_status:*` ZSETs.
   - `XADD events:vici2.agent.state_changed`.
   - Total OFFLINE detection latency: max(endconf-grace-time, debounce) =
     max(5, 5) = 5 s, not 10 s. Alignment confirmed in §11.5.
4. Customer/3rd-party legs (if any in the conf when agent dropped) hear
   silence then get ejected on conf destroy. Phase 1 accepts this; Phase
   3 (I04 closer/blended) may park the customer to a "next-agent" queue.

**Explicit (POST /api/agent/logout from web UI):**
1. API authenticates the request.
2. API issues `T03.DestroyAgentConf(ctx, tid, uid)` → which calls:
   - `T01.ConferenceCommand(ctx, fsHost, name, "kick all", "")`
   - `T01.UUIDKill(ctx, fsHost, agentLegUUID, "NORMAL_CLEARING")` (belt &
     suspenders)
3. `kick all` ejects every member. Customer/3rd-party legs receive a
   normal hangup (BYE). Agent leg's `conference` app exits and the
   `<action application="hangup"/>` (set via `hangup_after_conference=true`)
   completes the leg.
4. Conf destroys (no members). Same Valkey state-flip as graceful path.

---

## 3. Implicit creation (no explicit `create` API)

mod_conference 1.10 has **no** `conference create` API. Confirmed via:

- [signalwire docs API command list](https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Modules/mod_conference_3965534/) — RESEARCH §2.1.
- [freeswitch-users 2010-11](https://lists.freeswitch.org/pipermail/freeswitch-users/2010-November/065435.html), [2008-06](https://lists.freeswitch.org/pipermail/freeswitch-users/2008-June/031720.html) — implicit-creation pattern.

The first `conference NAME@PROFILE` invocation (whether via dialplan app
or `uuid_transfer ... conference:NAME@PROFILE inline`) instantiates the
conference using the named profile.

T03 design consequence: there is no `CreateAgentConf` operation. The
agent's SIP.js dial+dialplan IS the create. T03's Go API exposes
`EnsureAgentConfReady` (idempotent observation that the agent is in S3),
not `Create`. (Spec compatibility note: the original T03.md predated
this finding and uses the noun "create"; PLAN renames the operation
to clarify semantics — see §4 API surface below.)

---

## 4. API surface (Go package `dialer/internal/conference/`)

**Package name:** `conference`
**Path:** `dialer/internal/conference/`
**Imports:** `dialer/internal/esl` (for `ConferenceCommand`,
`UUIDTransfer`, `UUIDPark`, `UUIDKill`, `UUIDSetVar`, `Originate` —
T01/PLAN §7-§8), `dialer/internal/redis` (F04 keys), `log/slog`.

```go
package conference

import (
    "context"
    "log/slog"
    "time"

    "github.com/<repo>/dialer/internal/esl"
    "github.com/<repo>/dialer/internal/redis"
)

// ───────────────────────────────────────────────────────────────────────
// 4.1 Pure helpers (already shown in §1.2; restated for completeness)
// ───────────────────────────────────────────────────────────────────────

// ConferenceName returns "agent_t<tid>_u<uid>".
func ConferenceName(tenantID, userID int64) string

// ConferenceFQN returns "agent_t<tid>_u<uid>@<profile>".
func ConferenceFQN(tenantID, userID int64, profile string) string

// HoldConferenceName returns "agent_t<tid>_u<uid>_hold".
func HoldConferenceName(tenantID, userID int64) string

// ───────────────────────────────────────────────────────────────────────
// 4.2 Operator
// ───────────────────────────────────────────────────────────────────────

// Operator is the per-agent conference operator. One instance per
// dialer process; safe for concurrent use. Wraps an ESL Conn (T01) and
// a Valkey client (F04).
//
// All methods are idempotent. All methods accept ctx for cancellation /
// deadline. Errors are typed (see §4.4).
type Operator struct {
    esl    esl.Client     // from T01
    redis  redis.Client   // from F04
    log    *slog.Logger
    fsHost string         // affinity host for this operator instance
}

func New(c esl.Client, r redis.Client, fsHost string, log *slog.Logger) *Operator

// ───────────────────────────────────────────────────────────────────────
// 4.3 Operations (lifecycle, members, hold, recording stub, teardown)
// ───────────────────────────────────────────────────────────────────────

// EnsureAgentConfReady is the idempotent post-login check. It does NOT
// create the conference (mod_conference auto-creates on first member
// join — the agent's SIP.js dial). It verifies the conference exists
// with the agent as a member, populates Valkey state, and returns the
// agent's member-id.
//
// Called by the conf-maint event handler when add-member arrives with
// vici2_role=agent_leg. Returns ErrAgentNotInConf if the agent's member
// cannot be found within `confirmTimeout` (default 7 s, the worst-case
// add-member delay per RESEARCH §4.5).
func (o *Operator) EnsureAgentConfReady(ctx context.Context,
    tenantID, userID int64) (memberID int, err error)

// TransferCustomer transfers a customer's call leg into the agent's
// conference. MUST be called only when the agent is READY (caller's
// responsibility; method does NOT itself enforce). Uses join-only flag
// to fail-closed if the conf doesn't exist.
//
// Pre-sets vici2_* chan-vars on the customer leg before the transfer
// (vici2_role=customer_leg, vici2_user_id, vici2_tenant_id,
// vici2_call_uuid, conference_member_flags=""). The empty
// conference_member_flags overrides any default endconf so the
// customer's hangup does NOT collapse the conference.
//
// Returns the bgapi Job-UUID. The actual conf member-id arrives via
// add-member event (handled by conf-maint dispatcher). For
// race-sensitive operations needing the member-id immediately, use
// MemberIDForCall (which falls back to uuid_getvar if the HASH lookup
// misses).
func (o *Operator) TransferCustomer(ctx context.Context,
    tenantID, userID int64, customerCallUUID string) (jobUUID string, err error)

// TransferThirdParty originates a third leg directly into the agent's
// conference (3-way call). Uses join-only so it fails if the conf
// doesn't exist. Returns the originated leg's UUID and the bgapi
// Job-UUID; caller listens for BACKGROUND_JOB to get +OK / -ERR and
// for add-member to get the member-id.
//
// Note: because both customer and agent are already in the conf, the
// third leg's ringback is heard by all members (FS conference's
// "everybody hears the originate progress" behavior). Acceptable for
// Phase 1; A07 may later use bgapi conference … bgdial with mute-until-answer.
func (o *Operator) TransferThirdParty(ctx context.Context,
    tenantID, userID int64,
    gateway, dest, cidName, cidNumber string) (originatedUUID, jobUUID string, err error)

// MuteMember mutes a specific member (member-id from
// t:{tid}:agent:{uid}:conf_members or returned by add-member event).
// Used for self-mute (member-id = agent's own) and for supervisor
// mute-customer (sup authorization checked by API layer, not here).
func (o *Operator) MuteMember(ctx context.Context,
    tenantID, userID int64, memberID int) error

// UnmuteMember reverses MuteMember.
func (o *Operator) UnmuteMember(ctx context.Context,
    tenantID, userID int64, memberID int) error

// MuteCustomer is a convenience that resolves the customer member-id
// from the conf_members HASH (role=customer_leg) and mutes it. Used by
// the supervisor wallboard (S01) and supervisor barge (S02) when an
// authorized supervisor wants to silence the customer side. Returns
// ErrCustomerNotInConf if no customer is present.
func (o *Operator) MuteCustomer(ctx context.Context,
    tenantID, userID int64) error

// KickMember ejects a specific member. Used by self (kick yourself out
// of a 3-way → see LeaveThreeWay) and by supervisor authority.
//
// NOTE: kick-sound is silenced in the F03 profile (silence_stream://1)
// so kick == hup audio-wise. We use kick for clarity in audit logs.
func (o *Operator) KickMember(ctx context.Context,
    tenantID, userID int64, memberID int) error

// KickCustomer ejects all non-agent members from the conf (selector =
// non_moderator). Used when agent disposition's "drop" / "do-not-call"
// requires a clean cut.
func (o *Operator) KickCustomer(ctx context.Context,
    tenantID, userID int64) error

// HoldCustomer moves the customer member to a parking conference with
// MOH (the "hold" profile, see §6 below). Resume reverses the move.
// Both operations preserve recording (recording_follow_transfer=true on
// the customer leg).
func (o *Operator) HoldCustomer(ctx context.Context,
    tenantID, userID int64) error
func (o *Operator) ResumeCustomer(ctx context.Context,
    tenantID, userID int64) error

// LeaveThreeWay kicks the agent's own member out of the conf, leaving
// customer + 3rd party (and any other non-moderators) bridged. The
// conference survives because the customer/3rd-party legs are on the
// `endconf=false` flag — wait, actually because we removed agent's
// endconf carrier the conf would normally collapse. PLAN-time decision:
// before kicking the agent, T03 sets a transient "transfer" member-flag
// on the conference itself by issuing
//   conference <name> set endconf-grace-time 86400
// (24h grace) so the conf survives long enough for customer + 3rd-party
// to talk. Alternatively, we can grant endconf to the 3rd-party leg's
// member at originate time via member-flags=endconf. Default Phase 1:
// grant endconf to 3rd-party at TransferThirdParty time so removing the
// agent doesn't collapse the conf.
func (o *Operator) LeaveThreeWay(ctx context.Context,
    tenantID, userID int64) error

// DestroyAgentConf is the explicit logout teardown. Issues
//   conference <name> kick all
//   uuid_kill <agent-leg-uuid> NORMAL_CLEARING   (best-effort)
// then returns. Does NOT block on conference-destroy event (caller may
// listen separately if needed). Idempotent — returns nil if conf
// doesn't exist (the kick all -ERRs gracefully).
func (o *Operator) DestroyAgentConf(ctx context.Context,
    tenantID, userID int64) error

// GetMembers returns all current members of the agent's conference.
// Reads from Valkey HASH first (cheap); falls back to
//   bgapi conference <name> list
// if HASH is empty. Used by S01 wallboard and E06 janitor.
func (o *Operator) GetMembers(ctx context.Context,
    tenantID, userID int64) ([]Member, error)

// MemberIDForCall returns the member-id for a call leg currently in the
// agent's conference. Tries Valkey HASH first; if missing >100 ms after
// the leg was supposed to join, falls back to
//   uuid_getvar <call-uuid> conference_member_id
// (per RESEARCH §9.4). Returns ErrLegNotInConf if neither path
// produces a result.
func (o *Operator) MemberIDForCall(ctx context.Context,
    tenantID, userID int64, callUUID string) (memberID int, err error)

// ───────────────────────────────────────────────────────────────────────
// 4.4 Types and errors
// ───────────────────────────────────────────────────────────────────────

type Member struct {
    MemberID  int
    CallUUID  string
    Role      Role     // RoleAgent | RoleCustomer | RoleThird | RoleSupervisor
    CIDName   string
    CIDNumber string
    Flags     []string // "moderator", "mute", "deaf", "endconf", ...
    JoinedAt  time.Time
}

type Role string

const (
    RoleAgent      Role = "agent"
    RoleCustomer   Role = "customer"
    RoleThird      Role = "third"
    RoleSupervisor Role = "supervisor"
)

// Errors
var (
    ErrConfNotFound      = errors.New("conference: not found (agent not logged in)")
    ErrAgentNotInConf    = errors.New("conference: agent not in conference")
    ErrLegNotInConf      = errors.New("conference: leg not in conference")
    ErrCustomerNotInConf = errors.New("conference: no customer member in conference")
    ErrAgentNotReady     = errors.New("conference: agent not in READY state")
    ErrCrossTenant       = errors.New("conference: cross-tenant access denied")
)
```

### 4.5 Recording is NOT in the Operator surface

Per R01/RESEARCH §2 and §10.3, recording is owned by R01 and triggered
on the **customer leg** by the `customer_into_agent_conf` dialplan
extension (or T04's outbound originate channel-var blob). T03's Operator
deliberately exposes NO recording methods. Phase 2 may add
`RecordConference` for QA-mode mixed capture, but Phase 1 omits it to
keep R01 as the single recording authority (no duplicate-recording
risk).

---

## 5. Member-id tracking

### 5.1 Why we track it

mod_conference operations like `mute`, `kick`, `deaf` accept either a
selector (`all`, `last`, `non_moderator`) or a numeric `member-id`.
Selectors don't disambiguate customer vs 3rd party in 3+ leg confs, so
we need numeric IDs for fine-grained control (S01 wallboard, S02
supervisor whisper, A07 transfer ops).

### 5.2 Storage in Valkey (F04 amendment, no new key prefix)

Per RESEARCH §9.3 — three keys, all under existing F04/PLAN §4.5/§4.6
HASHes plus one new sibling HASH:

| Key | Type | Field | Value | TTL | Maintained by |
|---|---|---|---|---|---|
| `t:{tid}:agent:{uid}:conf_members` (NEW) | HASH | `<call-uuid>` | `<member-id>:<role>` (role ∈ `agent`/`customer`/`third`/`supervisor`) | none — wiped on `conference-destroy` | conf-maint handler |
| `t:{tid}:agent:{uid}` (existing per F04 §4.5) | HASH | `conf_name`, `conf_member_id` (NEW fields) | string, int | unchanged | conf-maint handler |
| `t:{tid}:call:{call-uuid}` (existing per F04 §4.6) | HASH | `conf_name`, `conf_member_id` (NEW fields) | string, int | unchanged | conf-maint handler |

**Key not prefixed with `{cid}` hash tag** because conf operations are
keyed by user_id, not campaign_id, and may span multiple campaigns
during a shift. Per F04/PLAN §4.7 convention — ✅.

The new HASH `t:{tid}:agent:{uid}:conf_members` is a per-agent map of
`call_uuid → member_id:role`. Lookups:

- "Which member-id is the customer?" → HSCAN, filter `role=customer`,
  expect ≤1.
- "Mute leg X" → HGET by call-uuid, parse out `member_id`.
- "Kick the agent (LeaveThreeWay)" → HSCAN, filter `role=agent`.

The HASH is wiped (DEL) when `Action: conference-destroy` arrives for
the agent's conf (so member-ids restart at 1 on next agent re-login,
matching mod_conference's behavior).

### 5.3 Event-driven population (push, primary path)

T01 already enriches and forwards `CUSTOM conference::maintenance`
events to Streams + Pub/Sub (T01/PLAN §11). T03 IMPLEMENT adds a
handler in `api/src/esl/handlers/conference-maint.ts` (file already
stubbed by T01) that:

```
on(evt where Event-Subclass = conference::maintenance):
  switch evt.Action:
    case "conference-create":
      // observation only; no Valkey op
    case "add-member":
      tid  = evt["vici2_tenant_id"]
      uid  = evt["vici2_user_id"]
      cuid = evt["Channel-Call-UUID"]
      mid  = evt["Member-ID"]
      role = evt["vici2_role"] ?? "unknown"
      pipeline:
        HSET t:{tid}:agent:{uid}:conf_members {cuid} "{mid}:{role}"
        HSET t:{tid}:call:{cuid} conf_name "{evt.Conference-Name}" conf_member_id {mid}
        if role == "agent_leg":
          HSET t:{tid}:agent:{uid} conf_name "{evt.Conference-Name}" conf_member_id {mid}
          // status flip to READY handled by F04 transition Lua (separate)
    case "del-member":
      tid  = evt["vici2_tenant_id"]
      uid  = evt["vici2_user_id"]
      cuid = evt["Channel-Call-UUID"]
      pipeline:
        HDEL t:{tid}:agent:{uid}:conf_members {cuid}
        HDEL t:{tid}:call:{cuid} conf_name conf_member_id
        if role == "agent_leg":
          schedule debounceOffline(tid, uid, 5000ms)
    case "conference-destroy":
      // re-derive (tid, uid) from Conference-Name via parseConfName()
      DEL t:{tid}:agent:{uid}:conf_members
```

Pipeline batching: per RESEARCH §11.6 open question, the handler
batches Valkey ops via redis-pipeline with batch-size=20 events or
flush-interval=50 ms (whichever first). Reduces RTT cost at scale (500
agents × 200 calls/day = ~200 k events/day = ~7 events/s peak).

### 5.4 Pull fallback (uuid_getvar)

Per RESEARCH §4.5 and §9.4: under load, `add-member` events have been
observed up to 7 s late. Race: dialer wants to mute customer immediately
after `TransferCustomer` returns, but conf-maint hasn't populated the
HASH yet.

Mitigation in `Operator.MemberIDForCall`:

```
1. HGET t:{tid}:agent:{uid}:conf_members <call-uuid>
   if hit: parse and return.
2. wait 100 ms (cheap; covers typical event latency).
3. HGET again.
   if hit: parse and return.
4. fallback: bgapi uuid_getvar <call-uuid> conference_member_id
   if non-empty: return.
5. return ErrLegNotInConf.
```

Real-world frequency: rare. Self-mute (the dominant mute case) has a
human latency between transfer and button-press easily covering 100 ms.

### 5.5 Reconciliation (`conference list`)

E06 (channel/conference janitor, Phase 2) periodically issues
`bgapi conference list summary` per FS instance and reconciles the
Valkey HASHes. T03 IMPLEMENT does NOT ship this; it's E06's job. The
Operator does expose `GetMembers()` which uses the same `bgapi conference
<name> list` parser, so E06 can reuse it.

---

## 6. Conference profile additions (F03 amendment)

T03 IMPLEMENT will file an amendment to F03's `conference.conf.xml`
(F03/PLAN §5) adding:

1. `endconf-grace-time=5` to the existing `default` profile.
2. A new `hold` profile for the customer-on-hold MOH UX.

### 6.1 `default` profile addition

Add inside the existing `<profile name="default">`:

```xml
<param name="endconf-grace-time" value="5"/>   <!-- T03 PLAN §6.1 -->
```

Rationale: F03's profile uses the FS default 60 s. RESEARCH §3.5 and
§8 picked 5 s for snappy OFFLINE detection. 5 s is shorter than the
typical browser-WSS reconnect retry interval (SIP.js default 4 s
exponential backoff first retry), which could cause a destroy-then-
recreate flicker on a fast network blip — PLAN accepts this risk as a
tradeoff for snappy OFFLINE detection. Mitigation: the
`agentPresence.debounceOffline(5000)` 5-s window in Node aligns with
this; the Node debounce IS the flicker absorber, not the FS grace
time.

### 6.2 `hold` profile (NEW)

Add as sibling of `default`:

```xml
<profile name="hold">
  <param name="rate" value="8000"/>
  <param name="interval" value="20"/>
  <param name="energy-level" value="100"/>
  <param name="comfort-noise" value="false"/>          <!-- pure MOH, no CN -->

  <!-- Silent enter/exit/etc -->
  <param name="enter-sound" value="silence_stream://1"/>
  <param name="exit-sound"  value="silence_stream://1"/>
  <param name="alone-sound" value="silence_stream://1"/>
  <param name="muted-sound" value="silence_stream://1"/>
  <param name="unmuted-sound" value="silence_stream://1"/>
  <param name="kicked-sound" value="silence_stream://1"/>

  <!-- MOH ON for single-member parking -->
  <param name="moh-sound" value="local_stream://moh"/>

  <param name="caller-controls" value="none"/>
  <param name="member-flags" value=""/>                <!-- no endconf default -->
  <param name="auto-record" value=""/>
  <param name="max-members" value="1"/>                <!-- one customer at a time -->
  <param name="endconf-grace-time" value="60"/>        <!-- if customer leg dies on hold, normal cleanup -->
</profile>
```

T03 IMPLEMENT files this as an F03 PLAN amendment commit (RFC not
required per SPEC §12 — adds capability, doesn't change downstream
contracts; T03/F03 both directly affected).

### 6.3 `member-flags=join-only` not set in profile

`join-only` is a per-member flag, not a profile-level setting. We pass
it on every `conference:` URI we hand to FS. Profile-level
`member-flags=endconf` (F03/PLAN §5) remains, providing the agent's
default `endconf` even though we set it explicitly in the conference
app data string for clarity.

---

## 7. Hold UX (Option B — separate parking conf)

Decision per RESEARCH §6.2: Option B (parking conference with MOH), not
Option A (deaf+mute customer in the same conf with no MOH).

### 7.1 Hold sequence

```
HoldCustomer(tid=1, uid=1042):
  1. resolve customer call_uuid via HSCAN of conf_members HASH (role=customer_leg)
  2. resolve customer member_id via same lookup
  3. T01.ConferenceCommand(fsHost,
       "agent_t1_u1042",                    // src conference
       "transfer agent_t1_u1042_hold",      // dst conference (will be auto-created)
       "<customer_member_id>")
  4. add hold marker to t:1:agent:1042 HASH: hold_state=ON, hold_since=<ts>
  5. emit XADD events:vici2.call.held *
```

Server-side, mod_conference's `conference SRC transfer DST MID` moves
the customer member from `agent_t1_u1042@default` to
`agent_t1_u1042_hold@hold` (instantiating the latter via the implicit-
create rule using the `hold` profile). The customer hears MOH.

### 7.2 Resume sequence

```
ResumeCustomer(tid=1, uid=1042):
  1. resolve customer call_uuid (now in conf_members of the hold conf,
     which we track via a second HSCAN — see §7.3)
  2. T01.ConferenceCommand(fsHost,
       "agent_t1_u1042_hold",
       "transfer agent_t1_u1042",
       "<customer_member_id>")
  3. clear hold marker
  4. emit XADD events:vici2.call.resumed *
```

### 7.3 conf_members HASH spans both conferences

The `t:1:agent:1042:conf_members` HASH stores the union of members in
BOTH `agent_t1_u1042` and `agent_t1_u1042_hold` because they belong to
the same agent. The role string is unchanged across the move; only the
member-id may change (mod_conference assigns a new member-id in the
destination conf). Conf-maint handler updates the HASH on both `del-
member` (from src) and `add-member` (in dst) — net effect: HSET with
new member-id.

Conf-maint handler enhancement: store conf-name alongside member-id in
the value, so we know which conference the member is currently in:

```
HSET t:1:agent:1042:conf_members <call_uuid> "{member_id}:{role}:{conf_short}"
where conf_short = "default" or "hold"  (parsed from Conference-Name suffix)
```

### 7.4 Recording survives hold (R01 dependency)

`recording_follow_transfer=true` on the customer leg (set by
`customer_into_agent_conf` per F03/PLAN §4.2 + R01 §10.3) keeps the
`record_session` media bug attached across the conference transfer. One
contiguous WAV per customer call.

---

## 8. Mute / kick / 3-way / leave-3-way

### 8.1 Mute self

```
agent UI clicks Mute self →
  POST /api/agent/conf/mute
  api resolves agent's own member_id from t:{tid}:agent:{uid}.conf_member_id
  api calls Operator.MuteMember(ctx, tid, uid, agent_member_id)
  Operator: T01.ConferenceCommand(fsHost, "agent_t<tid>_u<uid>", "mute", "<mid>")
```

### 8.2 Mute customer (supervisor only)

```
sup UI clicks Mute customer for agent X →
  POST /api/sup/conf/{agent_id}/mute-customer
  api authenticates sup role + scope (must own this agent / campaign per C03)
  api calls Operator.MuteCustomer(ctx, tid, uid)
  Operator: HSCAN conf_members for role=customer_leg → member_id
            T01.ConferenceCommand(fsHost, name, "mute", "<mid>")
```

Auth check happens at API layer per SPEC §4.5/§4.7 (T03 itself does
not enforce sup-vs-agent permissions — separation of concerns; C03 owns
RBAC).

### 8.3 Kick (agent self or supervisor)

```
Operator.KickMember(ctx, tid, uid, mid):
  T01.ConferenceCommand(fsHost, name, "kick", "<mid>")

Operator.KickCustomer(ctx, tid, uid):
  T01.ConferenceCommand(fsHost, name, "kick", "non_moderator")
```

The `non_moderator` selector in `KickCustomer` ejects every member that
isn't a moderator — i.e., customer + any 3rd parties. The agent (sole
moderator) stays.

### 8.4 3-way (add third party)

```
Operator.TransferThirdParty(ctx, tid=1, uid=1042, gw="twilio", dest="+15551234567",
                            cidName="Agent X", cidNumber="+18005551234"):
  // Build originate string per RESEARCH §5.3 option B (preferred).
  originateStr := fmt.Sprintf(
      "{origination_uuid=%s,originate_timeout=30,ringback=%%(2000,4000,440,480),"+
      "vici2_role=third_leg,vici2_user_id=%d,vici2_tenant_id=%d,"+
      "conference_member_flags=endconf,"+   // 3rd-party carries endconf so leave-3-way doesn't collapse conf
      "origination_caller_id_name='%s',origination_caller_id_number=%s}"+
      "sofia/gateway/%s/%s 'conference:%s+flags{join-only}' inline",
      newUUID, uid, tid, cidName, cidNumber, gw, dest, ConferenceFQN(tid, uid, "default"))
  jobUUID := T01.Originate(ctx, OriginateRequest{
      ExecuteOnAnswer: nil,                  // already 'conference:' inline — not park
      RawString:       originateStr,         // T01.Client.Originate accepts builder OR raw; PLAN clarifies in §11.7
  })
  return newUUID, jobUUID, nil
```

Note: T01's Originate API may require an extension to accept raw
originate strings (it currently builds them from typed
`OriginateRequest`). T03 IMPLEMENT files a T01 amendment for a
`Client.OriginateRaw(ctx, fsHost, raw string) (callUUID, jobUUID, err error)`
escape hatch if the builder can't represent `'conference:NAME inline'`
as the destination. (Likely path: extend `OriginateRequest.OnAnswer`
union with a new `OnAnswerConferenceJoinOnly` variant — cleaner and
keeps lint guard usable.)

### 8.5 Leave 3-way (agent drops, customer + 3rd party stay)

```
Operator.LeaveThreeWay(ctx, tid, uid):
  // Pre-condition: 3rd-party leg must carry endconf (set at TransferThirdParty)
  agentMID := lookup from t:{tid}:agent:{uid}.conf_member_id
  T01.ConferenceCommand(fsHost, ConferenceName(tid, uid),
                        "kick", strconv.Itoa(agentMID))
  // Conference survives; recording continues via recording_follow_transfer
```

The conference survives because the 3rd-party leg has `endconf` (set at
TransferThirdParty origination time). When eventually the customer or
3rd party hangs up, the conf collapses normally.

Audit-log emission: `vici2.transfer.leave_3way` event so call-log
correctly records the agent transferred-out vs hung-up.

---

## 9. Cross-tenant join guard

Per RESEARCH §3.2 / §10.2 and SPEC §4.5: enforce in dialplan via
`${sip_authorized_user}` (post-digest), NOT `${sip_from_user}` (which
can be spoofed by re-INVITE).

The §2.1 dialplan pattern `^\*9(\d+)_(\d+)$` extracts `(tid, uid)` and
`<condition field="${sip_authorized_user}" expression="^${2}$">` ensures
the SIP user matches the requested user_id. Cross-tenant attempt
(SIP user 1042 in tenant 1 dials `*92_1042`) succeeds the user-match
check but PLAN adds a second check: tenant scoping.

### 9.1 Tenant scoping in dialplan

T03 IMPLEMENT extends the dialplan extension to also check that the
SIP user belongs to the requested tenant:

```xml
<condition field="destination_number" expression="^\*9(\d+)_(\d+)$">
  <condition field="${sip_authorized_user}" expression="^${2}$" break="never">
    <condition field="${user_data($2@${domain} var vici2_tenant_id)}"
               expression="^${1}$" break="never">
      ... actions ...
      <anti-action application="respond" data="403 Forbidden"/>
      <anti-action application="hangup" data="WRONG_TENANT"/>
    </condition>
    <anti-action application="respond" data="403 Forbidden"/>
    <anti-action application="hangup" data="USER_NOT_AUTHORIZED"/>
  </condition>
</condition>
```

The `user_data($2@${domain} var vici2_tenant_id)` lookup queries the
F05-rendered directory entry. F05 IMPLEMENT must include `vici2_tenant_id`
as a `<variable>` in each directory user XML (T03 IMPLEMENT files an
F05 amendment if the variable isn't already present). For Phase 1
single-tenant, every directory entry has `vici2_tenant_id=1`; the
double-condition is harmless overhead.

### 9.2 Server-side cross-tenant guard in Operator

Defense-in-depth: every `Operator` method validates that the
`tenantID` parameter matches the agent's tenant in Valkey before
issuing ESL commands:

```
func (o *Operator) checkTenant(ctx, tid, uid int64) error {
  storedTID := redis.HGET(t:{tid}:agent:{uid}, tenant_id)  // F04 §4.5 — but tenant
                                                            // is in the key, so a different
                                                            // check is needed: assert key exists.
  if not exists or storedTID != tid: return ErrCrossTenant
  return nil
}
```

Phase 1 (tid always = 1) makes this trivial; Phase 4 lights up with
real teeth.

---

## 10. TS-side mirror (`api/src/conference/`)

The Node API layer (Hono) needs a thin wrapper for admin/sup endpoints
that don't go through the dialer Go layer. T03 IMPLEMENT will create:

```
api/src/conference/
  ├── name.ts          // re-exports confName / confFQN / holdConfName from shared/types
  ├── operator.ts      // thin client that issues HTTP RPC to dialer for ops
  ├── presence.ts      // moved from api/src/services/agent-presence.ts (PLAN renames)
  └── index.ts
```

### 10.1 Operator surface (TS)

```ts
export interface ConfOperator {
  ensureReady(tenantId: number, userId: number): Promise<{ memberId: number }>;
  transferCustomer(tenantId: number, userId: number, custUuid: string): Promise<{ jobUuid: string }>;
  transferThirdParty(tenantId: number, userId: number, gateway: string,
                     dest: string, cidName: string, cidNumber: string)
                     : Promise<{ originatedUuid: string; jobUuid: string }>;
  muteMember(tenantId: number, userId: number, memberId: number): Promise<void>;
  unmuteMember(tenantId: number, userId: number, memberId: number): Promise<void>;
  muteCustomer(tenantId: number, userId: number): Promise<void>;
  kickMember(tenantId: number, userId: number, memberId: number): Promise<void>;
  kickCustomer(tenantId: number, userId: number): Promise<void>;
  hold(tenantId: number, userId: number): Promise<void>;
  resume(tenantId: number, userId: number): Promise<void>;
  leaveThreeWay(tenantId: number, userId: number): Promise<void>;
  destroy(tenantId: number, userId: number): Promise<void>;
  members(tenantId: number, userId: number): Promise<Member[]>;
  memberIdForCall(tenantId: number, userId: number, callUuid: string): Promise<number>;
}
```

### 10.2 Operator implementation

Two impls:
- `HttpConfOperator` — issues HTTP POST to `dialer:8083/internal/conf/*`
  endpoints exposed by the Go `Operator`. Used in production where API
  and dialer are separate processes.
- `MockConfOperator` — for tests; in-memory state machine.

The dialer process exposes a small internal HTTP surface (NOT public)
on port 8083 for the API layer to call. Authenticated via shared HMAC
secret (env `INTERNAL_RPC_SECRET`). Routes:

```
POST /internal/conf/ensure-ready    {tid, uid} → {memberId}
POST /internal/conf/transfer-cust   {tid, uid, custUuid} → {jobUuid}
POST /internal/conf/transfer-third  {tid, uid, gw, dest, cidName, cidNumber} → {originatedUuid, jobUuid}
POST /internal/conf/mute            {tid, uid, memberId} → {}
POST /internal/conf/unmute          {tid, uid, memberId} → {}
POST /internal/conf/mute-customer   {tid, uid} → {}
POST /internal/conf/kick            {tid, uid, memberId} → {}
POST /internal/conf/kick-customer   {tid, uid} → {}
POST /internal/conf/hold            {tid, uid} → {}
POST /internal/conf/resume          {tid, uid} → {}
POST /internal/conf/leave-3way      {tid, uid} → {}
POST /internal/conf/destroy         {tid, uid} → {}
GET  /internal/conf/members?tid=&uid=   → [Member]
GET  /internal/conf/member-id?tid=&uid=&call_uuid=  → {memberId}
```

(Alternative: gRPC. PLAN picks HTTP for Phase 1 simplicity; gRPC at
Phase 3 if RPC volume warrants.)

### 10.3 Presence handler (existing T03.md surface)

The `agent-presence` service stays where T03.md spec puts it
(`api/src/services/agent-presence.ts`); `api/src/conference/presence.ts`
is a re-export. The handler:

```ts
export const agentPresence = {
  async onJoin(tid: number, uid: number, callUuid: string,
               memberId: number, conf: string): Promise<void>,
  async onLeave(tid: number, uid: number, callUuid: string,
                memberId: number): Promise<void>,
  async debounceOffline(tid: number, uid: number, ms: number): Promise<void>,
};
```

Implementation per §5.3 above (pipelined HSET / HDEL / ZADD / XADD).

---

## 11. Hand-offs to other modules

### 11.1 To A02 (browser softphone, SIP.js)

Provide:
- **Extension dial pattern** as an env var:
  `NEXT_PUBLIC_AGENT_PARK_PATTERN=*9{tid}_{uid}` (consumed by A02 build).
- **Helper TS function** `confName(tid, uid)` from `shared/types`.
- **Conference SIP URI form**: A02 does NOT dial the conference URI
  directly — it dials the park-and-join extension. The dialplan does
  the join.

A02 PLAN already exists; T03 IMPLEMENT files a one-line A02 amendment
adding the env var to A02's `.env.example` and to the build manifest.

### 11.2 To R01 (recording)

- Recording is triggered on the **customer leg** by R01's setup in the
  `customer_into_agent_conf` dialplan extension (R01/RESEARCH §10.3).
- T03 does NOT call `uuid_record` against the conference and does NOT
  call `conference … record`. Single-recorder invariant.
- T03's `HoldCustomer` and `ResumeCustomer` rely on
  `recording_follow_transfer=true` (set by R01) to keep one contiguous
  WAV across hold/resume.
- T03 makes NO changes to R01's surface; the `record_session` action
  stays in the existing `customer_into_agent_conf` extension authored by
  F03 + R01.

### 11.3 To T01 (ESL bridge)

T03 consumes from T01 (no T01 surface change required for Phase 1
except possibly):
- `Client.UUIDTransfer(ctx, fsHost, uuid, dest, dialplan, ctx)` ✅ exists.
- `Client.UUIDSetVar(ctx, fsHost, uuid, key, val)` ✅ exists; multi-key
  variant nice-to-have.
- `Client.UUIDKill(ctx, fsHost, uuid, cause)` ✅ exists.
- `Client.UUIDPark(ctx, fsHost, uuid)` ✅ exists (used by alt hold path).
- `Client.ConferenceCommand(ctx, fsHost, name, cmd, args)` ✅ exists.
- `Client.Originate(...)` ✅ exists; T03 uses for 3-way. Extension to
  represent `conference:NAME+flags{…} inline` as `OnAnswerAction` is
  the only T01 amendment T03 IMPLEMENT may file. See §8.4 above.

### 11.4 To E04 (picker)

`Operator.TransferCustomer(ctx, tid, uid, custUuid)` is the target API
for E04 once it has matched a customer leg to an agent. E04 calls it
with the agent's `(tid, uid)` from the picker Lua return value (F04/PLAN
§6.4) and the customer call_uuid from the in-flight HASH.

### 11.5 To S02 (eavesdrop / supervisor whisper)

Supervisor barge in whisper or listen mode:
- **Whisper (sup talks to agent only):** S02 originates the supervisor
  leg with `conference_member_flags=mute,deaf=false` per RESEARCH §5.4.
- **Listen-only (sup hears all, no mic):** `conference_member_flags=mute,deaf=true`.
- **Barge (sup talks to all):** `conference_member_flags=` (no flags).

S02 owns the originate; T03 only provides the conference name via
`ConferenceName(tid, uid)` and the `Operator.GetMembers` surface for
S02 to verify the agent is logged in before originating.

### 11.6 To F03 (FreeSWITCH config)

T03 IMPLEMENT files **two amendments** to F03:
1. Add `endconf-grace-time=5` to the `default` profile (§6.1).
2. Add the new `hold` profile to `conference.conf.xml` (§6.2).

Plus replaces F03's stub `01_agent_conference.xml` (F03/PLAN §4.2) with
the production extension (§2.1) — F03 PLAN explicitly says T03 owns the
final form; this is not an amendment, just T03 doing its job.

### 11.7 To SPEC.md §4.4

T03 IMPLEMENT updates SPEC §4.4 to reflect the new name format. Diff:

```diff
 ### 4.4 The conference-per-agent primitive is sacred.
-- Every agent who is logged in occupies `conference_${user_id}@default`.
+- Every agent who is logged in occupies `agent_t${tenant_id}_u${user_id}@default`.
 - Every customer call is `uuid_transfer`'d into the agent's conference.
 - Transfers/3-way/leave-3way are conference operations.
 - Don't invent a different model. See `DESIGN.md` §1.3.
```

The semantics (sacred-ness, the primitive itself) are unchanged — only
the name format string. Per RFC-002, this is the canonical update.

T03 IMPLEMENT files this commit alongside the `01_agent_conference.xml`
production extension, so the spec and dialplan stay in lockstep.

### 11.8 To F04 (Valkey)

T03 IMPLEMENT files a one-section addition to F04/PLAN §4.5/§4.6
documenting the new HASH `t:{tid}:agent:{uid}:conf_members` and the
new fields `conf_name`, `conf_member_id` on existing HASHes per §5.2
above. This is documentation-only — F04 doesn't change behavior; T03
just uses what's already there.

### 11.9 To F05 (auth, SIP credentials)

Two requirements on F05's directory entries (one new, one likely
already there):
1. Each user XML must include `<variable name="vici2_tenant_id" value="1"/>`
   for the dialplan's `user_data()` lookup (§9.1). T03 IMPLEMENT files
   an F05 amendment if missing.
2. Each user XML's `id="<user_id>"` must match the user_id used in the
   park-and-join extension. F05 already does this per F05/PLAN.

---

## 12. Lifecycle timing budget (alignment of timers)

| Event / timer | Value | Source | Why |
|---|---|---|---|
| FS `endconf-grace-time` | 5 s | F03 amendment §6.1 | Time after last endconf-carrier leaves before conf destroys |
| Node `agentPresence.debounceOffline` | 5 s | T03 PLAN §2.6 | Time after `del-member` (agent leg) before flipping status to LOGOUT in Valkey |
| SIP.js reconnect (1st retry) | 4 s | A02 default | Browser auto-reconnects after WSS drop |
| `add-member` event delay (worst case) | 7 s | RESEARCH §4.5 | mod_conference event-bus latency under load |
| `MemberIDForCall` HASH-miss wait | 100 ms | T03 PLAN §5.4 | Cheap pre-fallback wait |
| Conf-maint Valkey pipeline flush | 50 ms or 20 events | T03 PLAN §5.3 | Batches Valkey ops |

Net: **OFFLINE detection latency ≈ 5 s** (limited by FS grace-time and
Node debounce, which align). **READY detection latency ≈ 1 s** (event
travel + HSET, no debounce). **Reconnect window ≈ 4 s** so a 5 s grace +
debounce comfortably absorbs a single retry blip.

If A02 increases reconnect interval (e.g., DNS hiccup), an OFFLINE flip
*might* happen during the reconnect — by design. The agent should see a
"reconnecting…" UI state and the supervisor wallboard correctly shows
LOGOUT until they're fully back.

---

## 13. File list (T03 IMPLEMENT will create)

```
dialer/internal/conference/name.go                 # ConferenceName, ConferenceFQN, HoldConferenceName
dialer/internal/conference/name_test.go            # pure-fn unit tests
dialer/internal/conference/operator.go             # Operator + methods
dialer/internal/conference/operator_test.go        # mocked-ESL unit tests
dialer/internal/conference/types.go                # Member, Role, errors
dialer/internal/conference/parse.go                # parsers for `conference list` + Conference-Name → (tid, uid)
dialer/internal/conference/parse_test.go
dialer/tools/lints/agentprefix/agentprefix.go      # custom golangci-lint analyzer
dialer/tools/lints/agentprefix/agentprefix_test.go

shared/types/src/conference.ts                     # confName, confFQN, holdConfName + parse helpers
shared/types/src/conference.test.ts

api/src/conference/index.ts
api/src/conference/name.ts                         # re-exports
api/src/conference/operator.ts                     # HttpConfOperator + MockConfOperator
api/src/conference/operator.test.ts
api/src/conference/presence.ts                     # re-exports api/src/services/agent-presence
api/src/services/agent-presence.ts                 # join/leave/debounce
api/src/services/agent-presence.test.ts
api/src/esl/handlers/conference-maint.ts           # event router → presence + conf_members HASH

tools/eslint-rules/no-raw-conf-name.js             # ESLint custom rule
tools/eslint-rules/no-raw-conf-name.test.js
eslint.config.mjs                                  # ADD: load no-raw-conf-name rule

freeswitch/conf/dialplan/default/01_agent_conference.xml   # REPLACES F03 stub with production extension
freeswitch/conf/autoload_configs/conference.conf.xml       # AMENDS F03 — adds endconf-grace-time=5 + hold profile

# Spec & doc updates (commits filed by T03 IMPLEMENT):
SPEC.md                                            # §4.4 example name diff per §11.7
spec/modules/F03/PLAN.md                           # §5 amendment per §6
spec/modules/F04/PLAN.md                           # §4.5/§4.6 amendment per §11.8
spec/modules/F05/PLAN.md                           # directory variable amendment per §11.9 (if needed)
spec/modules/A02/PLAN.md                           # env var amendment per §11.1
spec/modules/T01/PLAN.md                           # OriginateRaw/OnAnswerConferenceJoinOnly amendment per §8.4 (if needed)
spec/modules/T03/HANDOFF.md                        # produced after VERIFY phase

# Tests:
api/test/conference/agent-presence.test.ts
api/test/conference/conf-maint-handler.test.ts
api/test/conference/operator-mock.test.ts
dialer/test/conference/operator_test.go
dialer/test/conference/integration_test.go         # talks to real FS in docker-compose
freeswitch/tests/sipp/agent-conference-join.xml
freeswitch/tests/sipp/agent-conference-cross-tenant-deny.xml
freeswitch/tests/esl/conference-lifecycle.sh
```

---

## 14. Acceptance criteria (from T03.md, refined)

Per `spec/modules/T03.md` §"Acceptance criteria", with PLAN-time
clarifications:

- [ ] **Agent join only succeeds when SIP user matches requested user_id.**
  Verified by `agent-conference-cross-tenant-deny.xml` SIPp scenario:
  user 1042 dials `*91_1099` → 403 Forbidden (USER_NOT_AUTHORIZED).
- [ ] **Agent join succeeds for matching tenant + user.** Verified by
  `agent-conference-join.xml` SIPp scenario: user 1042 in tenant 1 dials
  `*91_1042` → 200 OK + RTP, then `fs_cli -x 'conference list'` shows
  `agent_t1_u1042` with member 1.
- [ ] **Cross-tenant join attempt rejected.** SIPp: user 1042 (tenant 1)
  dials `*92_1042` → 403 Forbidden (WRONG_TENANT).
- [ ] **Agent presence flips to READY within 1 s of conference join.**
  Verified by `agent-presence.test.ts`: assert HGET
  `t:1:agent:1042 status` == "READY" within 1 s of issuing the SIP.js
  INVITE (real FS in docker-compose).
- [ ] **Agent presence flips to LOGOUT within 5 s of disconnect.** Same
  test, with browser-close simulation (BYE on agent leg).
- [ ] **Re-join within 5 s grace window doesn't flicker state.** Same
  test, with a 3 s gap between BYE and re-INVITE: assert no LOGOUT was
  ever stored in Valkey, status stayed READY throughout.
- [ ] **No MOH on idle conferences.** Verified by SIPp + RTP capture:
  agent joins, no other member, RTP captured for 5 s shows comfort-noise
  only (energy-level <100, no music).
- [ ] **`conference list` after agent-only join shows 1 member with
  flags including `moderator,nomoh,endconf`.**
- [ ] **`TransferCustomer` succeeds and conf shows 2 members; second has
  no `endconf` flag.** Verified by integration test that originates a
  fake customer leg, parks it, then issues `TransferCustomer`.
- [ ] **Customer hangup leaves agent alone in conf, status returns to
  READY (or stays INCALL until disposition; either correct).** Conf is
  NOT destroyed because agent retains endconf.
- [ ] **`DestroyAgentConf` removes all members and conf; agent status →
  LOGOUT.** Idempotent (calling twice returns nil the second time).
- [ ] **`HoldCustomer` moves customer to `agent_t1_u1042_hold`; customer
  hears MOH; recording WAV continues growing.** R01 + T03 integration test.
- [ ] **`ResumeCustomer` moves customer back; recording still growing in
  same file.**
- [ ] **3-way: `TransferThirdParty` adds a third member via originate +
  conference: inline; conf shows 3 members.**
- [ ] **`LeaveThreeWay` removes agent member; conf survives with 2
  members (cust + 3rd) because 3rd-party has endconf.**
- [ ] **Mute member-id 2 → next `conference list` shows member 2 with
  `mute` flag.**
- [ ] **50 concurrent agent joins, all in their own conferences, idle —
  CPU < 5% on reference hardware (1 core, 4 GB RAM container).**
- [ ] **Audit logs (`vici2.agent.online` / `vici2.agent.offline`) emitted
  on each transition.** Stream `events:vici2.agent.state_changed`
  contains the entries.
- [ ] **Lint guards** — both Go and TS lints reject a PR that introduces
  a raw `"agent_"` string literal in conference contexts.

(VERIFY.md will record outcomes per spec/conventions.md.)

---

## 15. Risks and open questions

### 15.1 Risks

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| `add-member` event delay up to 7 s under load | Medium | Low | Don't block screen-pop on conf-maint event; populate UI from dialer pre-transfer state. `MemberIDForCall` falls back to `uuid_getvar`. (RESEARCH §4.5) |
| Conference auto-destroy timing race vs new transfer-in | Low | Medium | Mandate `+flags{join-only}` on every customer/3rd-party transfer. Failed transfers fail-closed (customer hung up with safe-harbor message per DESIGN §13.7). |
| Multi-FS conference distribution (Phase 4) | N/A Phase 1 | High Phase 4 | A given agent's conf must live on ONE FS instance. X02 dispatcher must enforce affinity (agent's SIP REGISTER target = same FS as the agent conf). T01 already supports `req.FSHost` affinity (T01/PLAN §3.3) — T03 inherits. |
| `endconf-grace-time=5s` collides with SIP.js reconnect | Low | Low | Aligned with Node debounce (5 s). Reconnect blip < 5 s preserves status. >5 s blip correctly shows LOGOUT briefly; sup wallboard reflects reality. |
| Profile change (`endconf-grace-time` + `hold` profile) requires `fs_cli -x 'reloadxml; conference reload'` | Certain | Low | Documented in F03 amendment + HANDOFF runbook. Hot-applies; no FS restart. |
| Hold profile `max-members=1` blocks pathological multi-cust hold | Low | Low | Each agent holds at most 1 customer at a time (call-centre invariant). If we ever need multi-cust per agent we'd add a per-customer hold conf — different design, future RFC. |
| 3-way ringback heard by all conf members | Medium | Low | Documented; A07 may upgrade to `bgapi conference … bgdial` with mute-until-answer in Phase 2. Phase 1 acceptable. |
| Lint guard false positives (legit `"agent_"` strings in unrelated code) | Low | Low | Allow-list per file in lint config. Keep allow-list small; review at PR time. |
| Cross-tenant `user_data()` lookup depends on F05 directory containing `vici2_tenant_id` var | Medium | Medium | T03 IMPLEMENT files F05 amendment (§11.9). Phase 1 single-tenant: var absence is silently treated as tenant 1 (default match). |
| FS restart (host reboot, etc.) loses all running conferences | Certain | Medium | Inherent to mod_conference. Agents must re-login. No persistence layer in mod_conference; not a Phase 1 fix. Documented. |
| Performance ceiling: ~900 active conferences per FS instance | Certain | Phase-bounding | Inherited from F03/RESEARCH §15. Multi-FS via X02/X03 in Phase 3.5+. T03 has no work to do here. |

### 15.2 Performance ceiling (restated for clarity)

Per RESEARCH §1.9 and DESIGN §13: ~900 active conferences per FS
instance is the Artoo R2D2 wall (`switch_thread_create` failure at
high session counts). T03 inherits this; it is the upper bound on
"logged-in agents per FS instance." Phase 3.5 X02/X03 dispatcher
shards across FS instances by user_id hash; agent affinity ensures the
agent's SIP REGISTER and their conf land on the same FS.

### 15.3 Open questions deferred to IMPLEMENT

1. **OriginateRaw vs OriginateRequest extension** for the 3-way path
   (§8.4). IMPLEMENT will pick the cleaner of the two and file a T01
   amendment if needed.
2. **Conf-maint event pipeline batch size** (§5.3). PLAN proposes 20
   events / 50 ms; IMPLEMENT validates under load and tunes.
3. **`vici2_tenant_id` directory variable** absence handling in F05
   (§11.9). IMPLEMENT verifies F05 ships it; if not, files F05 amendment.
4. **Whether to persist `conf_short` (default vs hold) in conf_members
   HASH value** (§7.3). PLAN says yes; IMPLEMENT validates this
   doesn't bloat the HASH past listpack threshold.
5. **3-way press-1 (Vicidial AGENT_3WAY_PRESS-1_CALLS.txt) parity** —
   Phase 1 silent; A07 may add via `bind_meta_app`. Not T03's call;
   handed to A07.

### 15.4 Open questions resolved at PLAN

| RESEARCH §12 open question | Resolution at PLAN |
|---|---|
| 1. Conference name pattern (BLOCKING) | RFC-002 ACCEPTED: `agent_t<tid>_u<uid>@default`. §1 |
| 2. `endconf-grace-time` value | **5 s** — F03 amendment §6.1 |
| 3. Hold conference profile | **New `hold` profile** — F03 amendment §6.2 + Hold UX §7 |
| 4. Customer-leg fate on agent-disappearance | **Phase 1: customer hangs up.** Phase 3 (I04) may queue. §2.6 |
| 5. Stereo recording | **Single per-leg stereo WAV on customer leg accepted for Phase 1.** R01-owned. §11.2 |
| 6. Conf-maint event volume at scale | Pipeline batched (20 events / 50 ms). §5.3 |
| 7. Cross-tenant safety | Helper-only conf-name production + lint guards + dialplan tenant check. §1.3, §9 |
| 8. Member-id reuse after destroy | DEL `:conf_members` HASH on `conference-destroy` event. §5.3 |
| 9. `conference_member_flags` vs `+flags{…}` syntax | **Mixed**: profile uses `member-flags=`; per-channel uses `conference_member_flags` chan-var (set via uuid_setvar) for customer/3rd-party legs; agent uses `+flags{…}` in conf application data string for visibility in the dialplan. Documented in §2.1, §2.4, §8.4. |
| 10. Logout debounce vs endconf-grace-time alignment | Both 5 s. Net OFFLINE latency 5 s, not 10 s. §12 |
| 11. 3-way press-1 | Deferred to A07. §15.3 |
| 12. Conf-destroyed event emission | XADD `events:vici2.agent.state_changed` (existing F04 stream). §2.6 |

---

## 16. RFC-002 acknowledgement

This PLAN explicitly applies **RFC-002 — Conference Naming Convention**
(ACCEPTED 2026-05-06). The decision `agent_t<tenant_id>_u<user_id>@default`
is the load-bearing assumption underlying §§1, 2, 4, 5, 7, 8, 9, 10, 11.
T03 IMPLEMENT MUST cite RFC-002 in commit messages that touch the
conference name format.

The single source-of-truth helpers in `dialer/internal/conference/name.go`
and `shared/types/src/conference.ts` are the only allowed producers of
conference names. Lint guards (golangci-lint custom analyzer + ESLint
custom rule) enforce this CI-blocking, per RFC-002 §"How to apply".

---

## 17. F03 / SPEC amendments T03 IMPLEMENT will file

Summary table for the orchestrator's tracking:

| Target | Change | Rationale | Section in this PLAN |
|---|---|---|---|
| `freeswitch/conf/autoload_configs/conference.conf.xml` (F03 file) | Add `<param name="endconf-grace-time" value="5"/>` to `default` profile | RESEARCH §3.5/§8 — snappy OFFLINE detection | §6.1 |
| Same file | Add new `<profile name="hold">` (single-member, MOH on, no endconf, max-members=1) | RESEARCH §6.2 — proper hold UX | §6.2 |
| `freeswitch/conf/dialplan/default/01_agent_conference.xml` (F03 stub) | REPLACE stub with production extension that (a) parses `^\*9(\d+)_(\d+)$`, (b) checks `${sip_authorized_user}`, (c) checks tenant via `user_data()`, (d) joins `agent_t${1}_u${2}@default+flags{moderator,nomoh,endconf,join-only}` | RFC-002 + RESEARCH §3 | §2.1, §9.1 |
| `spec/modules/F03/PLAN.md` | Document the two `conference.conf.xml` amendments and the dialplan replacement | Keep PLAN truthful | §6, §11.6 |
| `spec/modules/F04/PLAN.md` | Add §4.5/§4.6 documentation for new HASH `t:{tid}:agent:{uid}:conf_members` and new fields `conf_name`, `conf_member_id` on existing HASHes | T03 storage needs documentation in F04 | §5.2, §11.8 |
| `spec/modules/F05/PLAN.md` (if needed) | Ensure each directory user XML includes `<variable name="vici2_tenant_id" value="…"/>` | Cross-tenant guard `user_data()` lookup needs it | §9.1, §11.9 |
| `spec/modules/A02/PLAN.md` | Add env var `NEXT_PUBLIC_AGENT_PARK_PATTERN=*9{tid}_{uid}` to A02 build config | Browser softphone needs the new dial pattern | §11.1 |
| `spec/modules/T01/PLAN.md` (if needed) | Add `Client.OriginateRaw` escape hatch OR new `OnAnswerAction` variant `OnAnswerConferenceJoinOnly` for 3-way originate | T03 3-way path needs it | §8.4, §11.3 |
| `SPEC.md` §4.4 | Update example name from `conference_${user_id}@default` to `agent_t${tenant_id}_u${user_id}@default`. SACRED-ness preserved; only the name format string changes. | RFC-002 canonical update | §11.7 |

---

*End of T03 PLAN. Next deliverable: T03 IMPLEMENT.*
