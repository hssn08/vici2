# T01 — ESL Bridge — PLAN

**Module:** T01 (Telephony, Phase 1)
**Author:** T01-PLAN sub-agent (Claude Opus 4.7, 1M ctx)
**Date:** 2026-05-06
**Status:** PROPOSED — awaiting orchestrator/lead review.
**Companion:** [RESEARCH.md](./RESEARCH.md) — 24 citations behind every choice.
**Scope:** Go-side ESL client + supervisor + event fan-out only. The
parallel Node ESL listener mentioned in T01.md §"Public interface" is
explicitly **deferred** to a sibling module (proposed name `T01N`) so
this PLAN is single-language and the boundary versus T04 stays sharp.
See §16 below.

This plan turns the T01 RESEARCH findings into the exact lib pin,
binary layout, file list, public Go API, env contract, metrics, and
hand-off interfaces the IMPLEMENT phase will deliver. Once approved,
**the public surface (`dialer/internal/esl` package API + ESL bridge
env vars + emitted Stream/pub-sub channel names + metric names) is
FROZEN**; internal supervisor/connection/parser internals may change
during IMPLEMENT without RFC.

---

## 0. TL;DR — 10-bullet decision summary

1. **Library pin: `github.com/percipia/eslgo` v1.5.0** (MPL-2.0,
   released 2025-12-10, Go 1.21+, idiomatic context-aware Go, used in
   production at percipia handling thousands of CPS). RESEARCH §2
   surveyed 5 candidates; eslgo is the only maintained option. Wrapped
   by an in-repo supervisor at `dialer/internal/esl/` (the lib has no
   built-in reconnect / circuit breaker).
2. **Binary topology: TWO Go binaries.** (a) `dialer/cmd/dialer/` (the
   pacing engine, owns its own `*esl.Client` for issuing originate /
   uuid_* / conference commands). (b) **NEW** `dialer/cmd/eslbridge/`
   (a dedicated event-fan-out daemon that owns the persistent ESL
   connection per FS host, subscribes to events, hydrates them, and
   publishes to Valkey Streams + pub/sub). Both binaries import the
   same `dialer/internal/esl` package. See §2 for the rationale.
3. **Connection model: ESL inbound, persistent TCP, one
   `*eslgo.Conn` per FS host.** Configured by env
   `FS_HOSTS=fs1.dc1.local:8021,fs2.dc1.local:8021` (Phase 1: single
   FS, comma-list of one entry; Phase 4: multi-FS without code
   change). Auth password from F03's frozen
   env `FS_EVENT_SOCKET_PASSWORD`.
4. **Reconnect strategy: exponential backoff
   300 ms → 30 s with 25 % jitter; alert when an FS is disconnected
   > 30 s; 3 consecutive failed reconnects → mark FS DEAD.**
   Originate calls to a DEAD FS return `ErrFSDead` instantly so
   upstream pickers route elsewhere. Reconciliation runs on every
   successful (re)connect (see §11).
5. **Per-FS circuit breaker:** 3 consecutive originate failures →
   OPEN for 30 s; HALF-OPEN allows a single test originate; success
   → CLOSED. Wrapping `Originate` only (read-only commands like
   `show channels` bypass the breaker for reconcile).
6. **Event subscription is a curated 18-event allowlist** (§6).
   Ingests CHANNEL lifecycle, CONFERENCE membership, DTMF, RECORD,
   HEARTBEAT, BACKGROUND_JOB, and `CUSTOM vici2.*`. Excludes the
   high-volume noise (CHANNEL_STATE, CHANNEL_CALLSTATE, CHANNEL_EXECUTE,
   RECV_RTCP_MESSAGE). ~10× volume reduction vs `events plain ALL`.
7. **Originate primitive:** always `bgapi`, never `api`; `Job-UUID:`
   header pre-supplied so we know the job correlation before the
   `+OK` ack arrives; channel var `origination_uuid={uuid}`
   pre-supplied so we know the channel UUID up front. 60 s
   `BACKGROUND_JOB` timeout → `ErrJobOrphaned` and metric.
8. **Event fan-out is split-by-criticality** (§10): durable Valkey
   Streams (per F04 PLAN frozen contract `events:vici2.<domain>.<event>`)
   for events that drive durable state (HANGUP_COMPLETE, BACKGROUND_JOB,
   RECORD_STOP, CONFERENCE_MEMBER_LEAVE, CHANNEL_BRIDGE) and ALSO
   pub/sub `t:{tid}:broadcast:agent:{user_id}` for low-latency screen-
   pop events (CHANNEL_CREATE, CHANNEL_ANSWER, CONFERENCE_MEMBER_ADD).
   Internal Go channel is bounded at 10 000; back-pressure drops
   non-critical events first and **never** drops critical events.
9. **Per-FS, per-gateway originate rate limiting** via Valkey token
   bucket (key `t:{tid}:rate:originate:{fs_host}` and
   `t:{tid}:rate:originate:gw:{gateway}`). Defense-in-depth against
   runaway pacing. Defaults `VICI2_ORIGINATE_RATE_PER_FS=50`,
   `VICI2_ORIGINATE_RATE_PER_GATEWAY=10`.
10. **T01 ↔ T04 boundary clarified** (§16): T01 is the *transport*
    (raw `bgapi originate` + uuid_* + conference primitives over ESL
    with reconnect/circuit/rate-limit). T04 is the *policy gate*
    (TCPA 8am–9pm window, DNC final-check, recording-consent gate,
    audit-log entry → calls `T01.Client.Originate`). T04 imports T01;
    T01 must never import T04. No business policy lives in
    `dialer/internal/esl/`.

---

## 1. Library pin — CONFIRMED

| Field | Value | Source |
|---|---|---|
| Module path | `github.com/percipia/eslgo` | RESEARCH §2.1 |
| Pinned version | **`v1.5.0`** (released 2025-12-10) | RESEARCH §2.1 |
| License | MPL-2.0 (file-level copyleft, compatible with our internal
non-distributed use; distribution of unmodified library file is unrestricted) | RESEARCH cite [11] |
| Go version | 1.22 (matches dialer's `go.mod`, F01 PLAN §1) | F01 PLAN |
| Where pinned | `dialer/go.mod` `require` directive; `go.sum` committed | F01 conventions |

**What we use from eslgo:**
- `eslgo.Dial(ctx, addr, password, onDisconnect)` — initial dial
- `*eslgo.Conn.SendCommand(ctx, command)` — generic command send
- `*eslgo.Conn.RegisterEventListener(eventName, handler)` — event sink
- `*eslgo.Conn.RegisterEventListenerByJobID(jobUUID, handler)` —
  BACKGROUND_JOB correlation by Job-UUID
- `*eslgo.Conn.SendEvent(ctx, eventName, headers, body)` — for
  emitting CUSTOM events when needed
- `*eslgo.Conn.ExitAndClose()` — graceful shutdown

**What eslgo does NOT do (we own):**
- Reconnect with backoff
- Circuit breaker per FS
- Rate limiting per FS / per gateway
- TCP keepalive on the underlying socket (we pre-dial via `net.Dialer`
  with `KeepAlive: 30s` and pass to `eslgo.NewConnection`)
- HEARTBEAT-based liveness probing
- Reconcile-on-reconnect (`show channels as json` diff)
- Per-FS metrics labels
- Event allowlist filtering at subscription time
- Per-call enrichment from `t:{tid}:in_flight:{call_uuid}` HASH

**Fallback if eslgo proves unsuitable during IMPLEMENT:** roll our
own ~600-LOC framer (the protocol is text-based and small). Do not
fall back to `0x19/goesl` (stale 2018) or `fiorix/go-eventsocket`
(no context, no JobUUID dispatcher). RESEARCH §2.1 confirms.

---

## 2. Service location — TWO Go binaries

T01.md does not mandate a single binary; it lists files under
`dialer/internal/esl/`. F01 PLAN §2 establishes the
`dialer/cmd/<binary>/main.go` pattern. We split T01's runtime work
into two `cmd/` binaries that share the `dialer/internal/esl`
library:

### 2.1 Binary A — `dialer/cmd/dialer/main.go` (existing, F01)

The pacing engine. Owns its own `*esl.Client` instance pointed at
the same FS hosts. Uses **only the command surface** (Originate,
UUIDTransfer, UUIDBridge, UUIDKill, UUIDPark, UUIDRecord,
ConferenceCommand). It does NOT subscribe to events — that is
`eslbridge`'s job. (Optionally subscribes to BACKGROUND_JOB locally
to consume its own originate-result callbacks; everything else is
fan-out via Valkey from `eslbridge`.)

### 2.2 Binary B — `dialer/cmd/eslbridge/main.go` (NEW, T01 IMPLEMENT)

The event-fan-out daemon. Owns the persistent ESL inbound
connection per FS host, runs the supervisor, subscribes to the
allowlist (§6), enriches events from Valkey HASHes, and publishes
to durable Streams + low-latency pub/sub (§10). Stateless — multiple
replicas run safely because Valkey Streams use consumer groups
downstream.

### 2.3 Why split

1. **Crash-domain isolation.** A bug in event fan-out should not kill
   the originate path (and vice versa).
2. **Independent scaling.** N event-fan-out replicas (one per FS, one
   for every-FS) scale independently of N pacing replicas.
3. **HA story.** The pacing engine becoming a stuck process must not
   block events from flowing to the wallboard / WS gateway.
4. **Mirrors T01.md's two-process design** (Go writer + Node consumer)
   while keeping both processes Go for now (Node is deferred — see
   §16.5).
5. **Aligns with F01 PLAN's `cmd/` pattern** — every long-running Go
   service is a separate binary with its own `/health` and `/metrics`
   port.

### 2.4 Port allocation

| Binary | Port | Use | Notes |
|---|---|---|---|
| `dialer` | 9102 | Prom `/metrics` | Already F01 |
| `dialer` | 7000 | gRPC | Already F01 |
| `eslbridge` | **9104** | Prom `/metrics` | NEW; F01 .env.example must add `ESLBRIDGE_METRICS_PORT=9104` (T01 IMPLEMENT will file the diff) |
| `eslbridge` | **8080** | HTTP `/health` | NEW |

`docker-compose.yml` adds an `eslbridge` service mirroring `dialer`'s
shape (same env, same `host.docker.internal` extra-hosts, same
healthcheck pattern). The compose change is part of T01 IMPLEMENT, not
F01; F01 IMPLEMENT only reserves port 9104 in `.env.example` so the
namespace doesn't collide.

### 2.5 Phase-1 single-process fallback

If lead review wants Phase 1 to ship as a single binary to reduce
operational surface, the fallback is to merge `eslbridge`'s `main.go`
into `dialer`'s `main.go` and run both goroutines in one process.
Code structure (everything in `dialer/internal/esl`) is unchanged.
Lead's call. Default in this PLAN: ship two binaries.

---

## 3. Connection model

### 3.1 Inbound, persistent, one Conn per FS host

Per RESEARCH §3.1, ESL inbound mode is the only correct choice for a
control-plane bridge (outbound is for per-call socket apps). One
`*eslgo.Conn` per FS host gives:

- Independent supervisor / circuit breaker per FS
- Independent reconnect timer
- Per-FS metric labels (`fs_host="fs1"`)
- Affinity-aware command dispatch by `OriginateRequest.FSHost`

### 3.2 Connection FSM (per FS host)

```
       ┌──────────────┐
       │  CONNECTING  │  initial dial; backoff on failure
       └──────┬───────┘
              │ AUTH OK
              ▼
       ┌──────────────┐
       │ RECONCILING  │  show channels as json → diff Valkey
       └──────┬───────┘
              │
              ▼
       ┌──────────────┐
       │   READY      │  events subscribed; cmds accepted
       └──────┬───────┘
              │ EOF / no-HEARTBEAT-40s / write error
              ▼
       ┌──────────────┐
       │ RECONNECTING │  exp backoff 300ms→30s + 25% jitter
       └──────┬───────┘
              │ retry
              └────► (CONNECTING)

       ┌──────────────┐
       │  CIRCUIT_OPEN │  3 consecutive originate fails → 30s
       └──────────────┘  → HALF_OPEN single test → READY|OPEN
```

### 3.3 Multi-FS routing

T01 does NOT make affinity decisions. The caller (T04 → E04 picker
→ X03 affinity) sets `OriginateRequest.FSHost` to the target host
string (must match a key in `FS_HOSTS`). T01:

1. Looks up the open `*esl.fsConn` for that host.
2. If circuit OPEN → return `ErrCircuitOpen`.
3. If host marked DEAD → return `ErrFSDead`.
4. Otherwise enqueue command on that host's Conn, return.

If `FSHost == ""`, T01 falls back to round-robin across healthy FSes
and emits a `vici2_esl_unaffined_originate_total` warning counter so
ops can trace the upstream caller that forgot to set affinity. This
should be rare; in steady state every originate has affinity.

Phase 1 = N=1 FS host. Phase 4 multi-FS is the interesting case;
architecture supports it from day 1.

### 3.4 Env contract

| Var | Default | Source | Used by |
|---|---|---|---|
| `FS_HOSTS` | `host.docker.internal:8021` | T01 (NEW; .env.example diff) | eslbridge + dialer |
| `FS_EVENT_SOCKET_PASSWORD` | `ClueCon` (dev) | F03 PLAN frozen | both |
| `FS_ESL_DIAL_TIMEOUT_MS` | `5000` | T01 (NEW) | both |
| `FS_ESL_HEARTBEAT_TIMEOUT_MS` | `40000` | T01 (NEW) | both |
| `FS_ESL_RECONNECT_INITIAL_MS` | `300` | T01 (NEW) | both |
| `FS_ESL_RECONNECT_MAX_MS` | `30000` | T01 (NEW) | both |
| `FS_ESL_CIRCUIT_FAIL_THRESHOLD` | `3` | T01 (NEW) | both |
| `FS_ESL_CIRCUIT_OPEN_DURATION_MS` | `30000` | T01 (NEW) | both |
| `FS_ESL_BG_JOB_TIMEOUT_MS` | `60000` | T01 (NEW) | both |
| `FS_ESL_INTERNAL_QUEUE_DEPTH` | `10000` | T01 (NEW) | eslbridge |
| `VICI2_ORIGINATE_RATE_PER_FS` | `50` | T01 (NEW) | both |
| `VICI2_ORIGINATE_RATE_PER_GATEWAY` | `10` | T01 (NEW) | both |
| `ESLBRIDGE_METRICS_PORT` | `9104` | T01 (NEW; F01 also reserves) | eslbridge |
| `ESLBRIDGE_HTTP_PORT` | `8080` | T01 (NEW) | eslbridge |

T01 IMPLEMENT files an `.env.example` diff PR adding the above with
inline comments. Existing F01/F03/F04 vars are not modified.

---

## 4. Reconnect strategy (full detail)

### 4.1 Backoff formula

```
attempt 1: 300 ms ± 25% jitter
attempt 2: 600 ms ± 25%
attempt 3: 1200 ms ± 25%
attempt 4: 2400 ms ± 25%
attempt 5: 4800 ms ± 25%
attempt 6: 9600 ms ± 25%
attempt 7: 19200 ms ± 25%
attempt 8+: capped at 30000 ms ± 25%
```

Computed as `delay = min(initial * 2^(attempt-1), cap) * (1 + jitter ∈ [-0.25, +0.25])`.
Jitter prevents the thundering-herd reconnect when an FS restarts
and N replicas of `eslbridge` all reconnect simultaneously.

### 4.2 Disconnect classification

| Trigger | Action |
|---|---|
| TCP EOF / `net.ErrClosed` / `io.EOF` | RECONNECTING immediately |
| `eslgo`'s `onDisconnect` callback | RECONNECTING immediately |
| No HEARTBEAT received for > `FS_ESL_HEARTBEAT_TIMEOUT_MS` (40 s default) | Force-close conn, RECONNECTING |
| Write error on the socket | RECONNECTING |
| `ctx.Done()` from supervisor | Graceful; no reconnect |

### 4.3 DEAD-host classification

After 3 consecutive failed reconnects (configurable
`FS_ESL_DEAD_THRESHOLD=3`), the FS host is marked DEAD:

- All `Originate(req)` calls with `req.FSHost == thisHost` return
  `ErrFSDead` instantly (no socket write attempt).
- Supervisor keeps trying to reconnect at the cap (30 s) interval.
- On successful reconnect, host transitions DEAD → RECONCILING → READY.
- Metric `vici2_esl_connection_status{fs_host=h, state="dead"}=1`.

Upstream (T04 / E04 picker) reads
`/health` from `eslbridge` to learn which FSes are alive and skip
DEAD ones. The `dialer` binary uses the `*esl.Client.HealthyHosts()`
helper that returns the currently-healthy host list.

### 4.4 Alerting

`vici2_esl_disconnect_seconds_total{fs_host}` (counter) accumulates
the wall-clock time each FS spent disconnected. Prometheus alert:

```promql
increase(vici2_esl_disconnect_seconds_total[1m]) > 30
```

fires `ESLDisconnectedTooLong` warning. Page on
`vici2_esl_connection_status{state="dead"} == 1 for 2m`.

---

## 5. Circuit breaker (per FS, per command class)

### 5.1 Why per-FS

A failing carrier behind one FS shouldn't trip a breaker for a
healthy sibling FS. The breaker is keyed on `(fs_host)`, not just
"the ESL bridge".

### 5.2 Why "originate-only"

- `Originate` is the load-bearing command and the one that can
  reasonably "fail" (carrier rejects, gateway down, no answer in
  upstream pool, etc.).
- `UUIDTransfer`, `UUIDBridge`, `UUIDKill`, `UUIDRecord`,
  `ConferenceCommand`, and `Reload` either succeed or are caller bugs
  — they don't justify protective breaking.
- Read-only commands used by reconcile (`show channels`,
  `status`) MUST bypass the breaker; otherwise we can never recover.

### 5.3 State machine

```
CLOSED ──(3 consecutive originate failures within 30s)──► OPEN
OPEN   ──(30s elapsed)──► HALF_OPEN
HALF_OPEN ──(single probe Originate succeeds)──► CLOSED
HALF_OPEN ──(single probe Originate fails)────► OPEN
```

While OPEN: `Originate` returns `ErrCircuitOpen` instantly. Counter
`vici2_esl_originate_total{outcome="circuit_open",fs_host=h}` ticks.

### 5.4 What counts as a "failure"

A `BACKGROUND_JOB` body that begins with `-ERR ` (e.g.,
`-ERR USER_BUSY`, `-ERR GATEWAY_DOWN`, `-ERR INVALID_GATEWAY`) OR a
`Job-UUID` timeout (60 s default). A no-answer (`NO_ANSWER`) DOES
count as a failure for breaker purposes — at FS level, the gateway
accepted the call but the destination didn't pick up; sustained
no-answers across many leads suggests a gateway/DID problem worth
backing off from.

(Per-lead "no answer" is normal; per-FS "all leads no-answer" is the
signal we want.)

---

## 6. Event subscription filter (allowlist)

### 6.1 Subscribed events

```
events plain CHANNEL_CREATE CHANNEL_ANSWER CHANNEL_HANGUP \
             CHANNEL_HANGUP_COMPLETE CHANNEL_BRIDGE CHANNEL_UNBRIDGE \
             RECORD_START RECORD_STOP \
             DTMF \
             BACKGROUND_JOB \
             HEARTBEAT \
             CUSTOM conference::maintenance vici2::*
```

| Event | Why subscribed | Critical? | Drop on backpressure? |
|---|---|---|---|
| `CHANNEL_CREATE` | screen-pop trigger; enrich + emit | live | yes (not durable) |
| `CHANNEL_ANSWER` | bridge trigger; screen-pop "answered" | live | yes |
| `CHANNEL_HANGUP` | first hangup signal | live | yes |
| `CHANNEL_HANGUP_COMPLETE` | final CDR write | **CRITICAL** | **NEVER** |
| `CHANNEL_BRIDGE` | call-bridged accounting | **CRITICAL** | **NEVER** |
| `CHANNEL_UNBRIDGE` | un-bridge accounting | live | yes |
| `RECORD_START` | recording lifecycle | live | yes |
| `RECORD_STOP` | recording finalization → R01 | **CRITICAL** | **NEVER** |
| `DTMF` | IVR phase 2 + barge controls | live | yes |
| `BACKGROUND_JOB` | originate result correlation | **CRITICAL** | **NEVER** |
| `HEARTBEAT` | liveness probe | live | yes |
| `CUSTOM conference::maintenance` | covers CONFERENCE_CREATE / DESTROY / MEMBER_ADD / MEMBER_LEAVE / MUTE / UNMUTE — ESL emits all of these as the `conference::maintenance` subclass with an `Action:` header (RESEARCH §6.4) | mixed (MEMBER_LEAVE = critical, MEMBER_ADD = live) | only non-critical actions |
| `CUSTOM vici2::*` | our own emitted CUSTOM events (e.g., `vici2::originate_started`, `vici2::dispo_logged`) | per-emitter | per-emitter |

### 6.2 Excluded events (reasoning)

| Event | Reason for exclusion |
|---|---|
| `CHANNEL_STATE` | ~6 per call; superset of CHANNEL_CREATE/ANSWER/HANGUP transitions |
| `CHANNEL_CALLSTATE` | ~6 per call; same |
| `CHANNEL_EXECUTE` | ~30 per call; one per dialplan app |
| `CHANNEL_EXECUTE_COMPLETE` | ~30 per call; companion |
| `RECV_RTCP_MESSAGE` | per-RTP-frame; would saturate the socket |
| `CODEC` | every codec negotiation; only debug value |
| `PRESENCE_*` | not used (no presence subsystem in Phase 1) |
| `MESSAGE` | SIP MESSAGE; not used |
| `CHANNEL_DESTROY` | redundant with HANGUP_COMPLETE for our purposes |
| `CHANNEL_PROGRESS` / `CHANNEL_PROGRESS_MEDIA` | covered by CHANNEL_CREATE + CHANNEL_ANSWER for Phase 1; revisit if SIT-tone detection needs them |
| All other ~50 events from RESEARCH cite [4] | not used |

### 6.3 Subclass naming for our own CUSTOM events

We emit our own CUSTOM events with subclass prefix `vici2::` (e.g.,
`vici2::originate_started`, `vici2::dispo_recorded`,
`vici2::recording_uploaded`). Allowlist subscription is `CUSTOM vici2::*`
(the trailing `*` is honored by FS as a wildcard subclass match — see
RESEARCH cite [4]).

This namespace is the FS-side analogue of the F04-PLAN-frozen Stream
naming (`events:vici2.<domain>.<event>`). Mapping is preserved in
the fan-out layer: a `CUSTOM vici2::originate_started` ESL event
becomes an XADD to `events:vici2.call.originate_started`.

### 6.4 `filter` not used at subscribe time

We do NOT use server-side `filter Header Value` at startup — events
are already trimmed by the allowlist. `filter` may be re-introduced
later if a specific high-volume CUSTOM subclass needs narrowing
(e.g., `filter Conference-Unique-ID <uuid>` to scope conference
events to only the conferences we care about). Not Phase 1.

---

## 7. Originate primitive — concrete Go signatures

### 7.1 Public types (in `dialer/internal/esl/`)

```go
package esl

// OriginateRequest is the typed input to Client.Originate.
// Set FSHost from upstream affinity (E04/X03); empty FSHost falls back
// to round-robin across healthy hosts (rare).
type OriginateRequest struct {
    // Routing
    FSHost           string            // target FS; "" = pick healthy
    GatewayName      string            // sofia gateway, e.g. "twilio_main"

    // Destination
    DestNumber       string            // E.164, e.g. "+14155550100"
    CallerIDNumber   string            // E.164
    CallerIDName     string

    // Behaviour
    OriginateTimeout int               // ring time, seconds; default 30
    OnAnswer         OnAnswerAction    // Park (default), Conference, Bridge, Custom
    ChannelVars      map[string]string // any additional FS channel vars

    // Correlation (round-trip via channel vars; appears on every event)
    LeadID           int64
    AgentID          int64             // 0 = unaffined
    CampaignID       int64
    TenantID         int64

    // Pre-supplied UUIDs (caller may set; if empty we generate)
    PreSuppliedUUID  string            // origination_uuid; channel UUID
    PreSuppliedJobID string            // Job-UUID; bgapi correlation
}

// OnAnswerAction is the typed value of execute_on_answer.
// Implementations marshal themselves to the channel-var string.
type OnAnswerAction interface{ asExecuteOnAnswer() string }

type OnAnswerPark struct{}
func (OnAnswerPark) asExecuteOnAnswer() string { return "park" }

type OnAnswerConference struct{ Name string } // e.g. "conference_42"
func (a OnAnswerConference) asExecuteOnAnswer() string {
    return fmt.Sprintf("transfer:%s XML default", a.Name)
}

type OnAnswerBridge struct{ Endpoint string }
func (a OnAnswerBridge) asExecuteOnAnswer() string {
    return fmt.Sprintf("bridge:%s", a.Endpoint)
}

type OnAnswerCustom struct{ Raw string }
func (a OnAnswerCustom) asExecuteOnAnswer() string { return a.Raw }
```

### 7.2 Public method

```go
// Originate issues `bgapi originate {vars}sofia/gateway/{gw}/{dest} &<onAnswer>`
// with a pre-supplied Job-UUID + origination_uuid, registers a callback for
// the BACKGROUND_JOB result, and returns the channel UUID immediately.
//
// Returns ErrCircuitOpen if the per-FS breaker is OPEN.
// Returns ErrFSDead if the FS host is marked DEAD.
// Returns ErrRateLimited if the per-FS or per-gateway token bucket is empty.
// Returns ErrJobOrphaned if BACKGROUND_JOB does not arrive within
//   FS_ESL_BG_JOB_TIMEOUT_MS (default 60s).
func (c *Client) Originate(ctx context.Context, req OriginateRequest) (callUUID string, err error)
```

### 7.3 Wire shape (what we send)

For the SACRED conference-per-agent pattern (SPEC §4.4):

```
sendmsg
Content-Type: command/api
content-length: <N>

bgapi originate {origination_uuid=<uuid>,origination_caller_id_number=+15551234567,origination_caller_id_name=ACME,originate_timeout=30,call_timeout=30,hangup_after_bridge=true,ignore_early_media=true,campaign_id=42,lead_id=123,agent_id=7,tenant_id=1,execute_on_answer=transfer:conference_7 XML default,sip_h_X-Vici2-Lead=123,sip_h_X-Vici2-Campaign=42}sofia/gateway/twilio_main/+14155550100 &park()
Job-UUID: <pre-generated-job-uuid>
```

Key invariants:
- `origination_uuid` and `Job-UUID` are pre-generated client-side
  (`uuid.NewV4()`) so we know both before the `+OK` ack.
- `&park()` keeps the channel parked on answer; `execute_on_answer`
  fires the configured action *after* park (idempotent).
- All correlation IDs (`lead_id`, `agent_id`, `campaign_id`,
  `tenant_id`) are passed as channel vars so they round-trip on
  every CHANNEL_* event header (`variable_lead_id`, etc.).

### 7.4 Always `bgapi`, never `api`

`api originate` blocks the whole ESL TCP connection for up to the
ring time (30 s default). On a single shared Conn this would queue
every other command. `bgapi` returns instantly with `+OK Job-UUID`
and posts the `BACKGROUND_JOB` event with the result later
(RESEARCH §1.4, cite [14]).

Internal `*esl.Client` exposes a private `bgAPI(ctx, cmd)` helper;
the only public command-shaped method that uses synchronous `api`
is the read-only `showChannels(ctx)` call used by reconcile.

---

## 8. Other primitives

All return `error` (typed, see §15). Each internally uses `bgapi` so
multiple in-flight commands don't queue. All accept `ctx` for
cancellation / deadline control.

```go
// UUIDTransfer transfers a parked channel to a new dialplan destination.
// Used for customer-leg → conference transfer in the SACRED pattern.
//   destination = "conference:conference_7@default" (typical)
//   dialplan    = "inline" or "XML"
//   context     = "default"
func (c *Client) UUIDTransfer(ctx context.Context,
    fsHost, callUUID, destination, dialplan, context string) error

// UUIDBridge bridges two parked legs.
func (c *Client) UUIDBridge(ctx context.Context,
    fsHost, leg1UUID, leg2UUID string) error

// UUIDKill terminates a channel with the given hangup cause.
//   cause = "NORMAL_CLEARING" | "ORIGINATOR_CANCEL" | "CALL_REJECTED" | etc.
func (c *Client) UUIDKill(ctx context.Context,
    fsHost, callUUID, cause string) error

// UUIDPark moves a channel to the park dialplan app.
// Used when a caller transitions a customer leg out of conference for hold.
func (c *Client) UUIDPark(ctx context.Context,
    fsHost, callUUID string) error

// UUIDRecord starts/stops/masks/unmasks recording on a channel.
//   action = "start" | "stop" | "mask" | "unmask"
//   path   = absolute filesystem path on the FS host (R01 builds the path)
func (c *Client) UUIDRecord(ctx context.Context,
    fsHost, callUUID, action, path string) error

// UUIDSetVar sets a channel variable on a live channel.
// Useful for late-binding correlation (e.g., agent_id assignment after
// originate).
func (c *Client) UUIDSetVar(ctx context.Context,
    fsHost, callUUID, key, value string) error

// UUIDBroadcast injects an audio file into a leg of a bridged call
// (for whisper / coaching). leg = "aleg" | "bleg" | "both".
func (c *Client) UUIDBroadcast(ctx context.Context,
    fsHost, callUUID, audioPath, leg string) error

// ConferenceCommand runs a `conference <name> <command> <args...>`.
// Examples:
//   ConferenceCommand(ctx, h, "conference_7", "list", "")
//   ConferenceCommand(ctx, h, "conference_7", "kick", "<member-id>")
//   ConferenceCommand(ctx, h, "conference_7", "mute", "<member-id>")
//   ConferenceCommand(ctx, h, "conference_7", "unmute", "<member-id>")
//   ConferenceCommand(ctx, h, "conference_7", "hold", "<member-id>")
//   ConferenceCommand(ctx, h, "conference_7", "play", "<file>")
// Returns the parsed reply body (JSON for `list`, `+OK` for actions).
func (c *Client) ConferenceCommand(ctx context.Context,
    fsHost, conferenceName, command, args string) (replyBody string, err error)

// Reload triggers an FS reload of the named subsystem.
//   what = "xmlcdr" | "mod_event_socket" | "sofia profile external rescan" |
//          "sofia profile external restart" | "acl" | "xml"
// Used by T02 (carrier mgmt) when re-rendering external gateways.
func (c *Client) Reload(ctx context.Context, fsHost, what string) error
```

### 8.1 Convenience helpers (typed wrappers over ConferenceCommand)

```go
type ConferenceMember struct {
    MemberID   string
    UUID       string
    CallerNum  string
    CallerName string
    JoinedAt   time.Time
    Flags      []string // "mute", "deaf", "floor", etc.
}

func (c *Client) ConferenceList(ctx context.Context,
    fsHost, conferenceName string) ([]ConferenceMember, error)

func (c *Client) ConferenceKick(ctx context.Context,
    fsHost, conferenceName, memberID string) error

func (c *Client) ConferenceMute(ctx context.Context,
    fsHost, conferenceName, memberID string, mute bool) error

func (c *Client) ConferenceHold(ctx context.Context,
    fsHost, conferenceName, memberID string, hold bool) error
```

These compose `ConferenceCommand` and parse its output. T03 (agent
conference module) consumes them.

---

## 9. Multi-FS routing (decision matrix)

Re-stated for clarity (see §3.3 for the FSM):

| `req.FSHost` | FS host status | Result |
|---|---|---|
| Set, healthy | READY | Dispatch on that Conn |
| Set, READY but circuit OPEN | OPEN | `ErrCircuitOpen` immediately |
| Set, DEAD | DEAD | `ErrFSDead` immediately |
| Set, unknown to T01 | n/a | `ErrFSUnknown` ("not in FS_HOSTS") |
| Empty, ≥1 healthy host | mixed | Round-robin across healthy hosts; emit `vici2_esl_unaffined_originate_total` warning |
| Empty, 0 healthy hosts | all DEAD/OPEN | `ErrAllFSDown` |

The `*esl.Client.HealthyHosts() []string` accessor lets callers
(T04) prefer to pick affinity-aware before calling `Originate`.

T01 itself does NOT retry on a sibling FS — that is T04's job (T04
knows campaign/agent affinity and what "fallback FS" is acceptable).
T01 returns the typed error and lets T04 decide.

---

## 10. Event fan-out architecture

### 10.1 Tagging

Every event passes through a per-FS receive goroutine that decorates
the raw `*eslgo.Event` with:

```go
type EnrichedEvent struct {
    *eslgo.Event
    FSHost       string
    TenantID     int64
    LeadID       int64
    AgentID      int64
    CampaignID   int64
    CallUUID     string
    ReceivedAt   time.Time
    Critical     bool   // never-drop flag (§6.1)
}
```

Tenant/lead/agent/campaign IDs come from `variable_*` headers
(channel vars set at originate time) plus a Valkey HASH lookup
(see §11) for events that arrive before vars settle.

### 10.2 Routing matrix (FROZEN)

| Source event | Destination Stream (durable) | Destination pub/sub (live) |
|---|---|---|
| `CHANNEL_CREATE` | `events:vici2.call.created` | `t:{tid}:broadcast:agent:{aid}` (if aid set) + `t:{tid}:broadcast:campaign:{cid}` |
| `CHANNEL_ANSWER` | `events:vici2.call.answered` (per F04 §4.10 frozen) | `t:{tid}:broadcast:agent:{aid}` + `t:{tid}:broadcast:campaign:{cid}` |
| `CHANNEL_BRIDGE` | `events:vici2.call.bridged` (per F04) | `t:{tid}:broadcast:agent:{aid}` |
| `CHANNEL_UNBRIDGE` | `events:vici2.call.unbridged` | `t:{tid}:broadcast:agent:{aid}` |
| `CHANNEL_HANGUP` | `events:vici2.call.hangup` | `t:{tid}:broadcast:agent:{aid}` |
| `CHANNEL_HANGUP_COMPLETE` | `events:vici2.call.ended` (per F04) | `t:{tid}:broadcast:agent:{aid}` + `t:{tid}:broadcast:campaign:{cid}` |
| `RECORD_START` | `events:vici2.recording.started` | — |
| `RECORD_STOP` | `events:vici2.recording.stopped` | — |
| `DTMF` | (none — pub/sub only Phase 1) | `t:{tid}:broadcast:call:{call_uuid}:dtmf` |
| `BACKGROUND_JOB` | (none — internal Job-UUID dispatcher only) | — |
| `HEARTBEAT` | (none — metric only) | — |
| `CUSTOM conference::maintenance` action=add-member | `events:vici2.conference.member_added` | `t:{tid}:broadcast:agent:{aid}` |
| `CUSTOM conference::maintenance` action=del-member | `events:vici2.conference.member_left` | `t:{tid}:broadcast:agent:{aid}` |
| `CUSTOM conference::maintenance` action=conference-create | `events:vici2.conference.created` | — |
| `CUSTOM conference::maintenance` action=conference-destroy | `events:vici2.conference.destroyed` | — |
| `CUSTOM vici2::*` | passthrough → `events:vici2.<subclass-after-vici2::>` | per-emitter (in payload) |

Stream names that are NOT explicitly enumerated by F04 PLAN §4.10
(e.g. `events:vici2.call.created`, `events:vici2.call.hangup`,
`events:vici2.recording.*`, `events:vici2.conference.*`) are added
by T01 as new cross-cutting streams; `MAXLEN ~ 1000000` (matching
F04 PLAN §4.10), 7-day `XTRIM MINID` retention. T01 IMPLEMENT files
an addendum to F04 PLAN §5.1 listing the new streams.

Pub/sub channel naming (`t:{tid}:broadcast:*`) is the F04 PLAN §4.9
frozen contract. The Phase-1 new addition is
`t:{tid}:broadcast:call:{call_uuid}:dtmf` — added here (T01 IMPLEMENT
files an F04 addendum).

### 10.3 Drop-window dual-write (drives adaptive engine)

When a `CHANNEL_HANGUP_COMPLETE` carries `variable_originate_disposition`
indicating a drop (`USER_BUSY`, `NO_USER_RESPONSE`, `NO_ANSWER`,
`ORIGINATOR_CANCEL`, `CALL_REJECTED`, `NETWORK_OUT_OF_ORDER`,
`RECOVERY_ON_TIMER_EXPIRE`), `eslbridge` ALSO writes to the
F04-frozen drop-window stream:

```
XADD t:{tid}:campaign:{{cid}}:drop_window MAXLEN ~ 500000 *
  answered 0 dropped 1 ts <unix_ms> call_uuid <uuid>
```

Answered (bridged) calls write the inverse `answered=1 dropped=0`.

This is the data E03 (adaptive engine) consumes to compute the
30-day rolling drop %.

### 10.4 Internal channel + back-pressure policy

```
              ┌──────────── eslgo Event ────────────┐
              │  per-FS receive goroutine            │
              │  → enrich (channel vars + Valkey)    │
              │  → mark Critical?                    │
              └──────────────┬───────────────────────┘
                             ▼
                  bounded chan(EnrichedEvent), cap 10000
                             │
              ┌──────────────┴───────────────┐
              ▼                              ▼
    fan-out goroutine #1          fan-out goroutine #2
    (Streams: pipelined XADD,     (pub/sub: PUBLISH; no
     50-event batches w/ 50 ms     batching needed)
     timeout)
```

When the bounded chan reaches 80 % depth, a backpressure flag flips.
While set:

1. **Critical events** (HANGUP_COMPLETE, BRIDGE, RECORD_STOP,
   BACKGROUND_JOB, conference MEMBER_LEAVE) are *always* enqueued —
   if the chan is full, the per-FS receive goroutine blocks (up to a
   1 s deadline; if still full after 1 s the FS conn is force-closed
   and reconnect kicks in — preserves at-least-once semantics over
   silent drop).
2. **Non-critical events** (CREATE, ANSWER, UNBRIDGE, RECORD_START,
   DTMF, HEARTBEAT, conference MEMBER_ADD/MUTE/UNMUTE,
   CUSTOM vici2::*) are dropped with metric
   `vici2_esl_events_dropped_total{event_name, reason="backpressure"}`.

`vici2_esl_event_queue_depth` gauge alarms at 80 % for > 30 s.

### 10.5 At-least-once + idempotency

- Stream consumers MUST be idempotent (UPSERT on `(call_uuid, event)`,
  natural-key check before INSERT). F04 PLAN §5 already enshrines
  `XACK` consumer-group semantics.
- Pub/sub events are best-effort by design (F04 PLAN §4.9 "Loss
  tolerance: all pub/sub. WS gateway issues full state snapshot on
  reconnect"). T01 makes no replay guarantees for pub/sub.

---

## 11. Per-call state hydration

### 11.1 The problem

When CHANNEL_CREATE arrives, the channel-var headers we set at
originate time (`variable_lead_id`, `variable_agent_id`, etc.) are
present *only if* we set them at originate time. For (a) inbound
calls (no originate), (b) legs we didn't originate (3-way), and (c)
edge cases where vars haven't propagated, we need a hydration
fallback.

### 11.2 The hydration HASH (F04 contract extension)

T04 (originate primitive) writes a Valkey HASH at originate time:

```
HSET t:{tid}:in_flight:{call_uuid}
     lead_id     <id>
     agent_id    <id>
     campaign_id <id>
     tenant_id   <id>
     started_at  <unix_ms>
     job_uuid    <job>
EXPIRE t:{tid}:in_flight:{call_uuid} 86400  # 24h safety
```

Note the key reuses F04 PLAN §4.8's pattern (`t:{tid}:call:{uuid}`)
but with `:in_flight:` prefix to distinguish "claimed but no
CHANNEL_CREATE seen yet" from "live call". The lifecycle is:

| Stage | Key |
|---|---|
| T04 calls T01.Originate | `t:{tid}:in_flight:{call_uuid}` HSET |
| CHANNEL_CREATE seen | T01 hydration reads `in_flight`, then T01 writes `t:{tid}:call:{uuid}` (F04 §4.8) |
| CHANNEL_HANGUP_COMPLETE | T01 deletes both keys |

This is a NEW F04 contract — T01 IMPLEMENT files an F04 PLAN
addendum (NOT an RFC, since we're adding keys, not changing existing
ones).

### 11.3 Hydration flow

On every CHANNEL_CREATE, ANSWER, BRIDGE, HANGUP_COMPLETE, or
conference event:

```
1. Read variable_lead_id, variable_agent_id, etc. from event headers
2. If any are missing AND Unique-Id is set:
     HGET t:{tid}:in_flight:{Unique-Id}  → backfill missing fields
3. Construct EnrichedEvent
4. Optionally emit a CUSTOM vici2::call.enriched event to FS for
   downstream consumers (T01 IMPLEMENT decision; default OFF)
5. Fan out per §10.2
```

If hydration fails (HASH miss, FS event for a call we never
originated like an inbound), the EnrichedEvent has zero IDs and is
still emitted; downstream consumers tolerate this.

---

## 12. Metrics (Prometheus, vici2_esl_* prefix)

Per SPEC §3.6 and F01 PLAN §5.1.

| Metric | Type | Labels | Purpose |
|---|---|---|---|
| `vici2_esl_connection_status` | gauge | `fs_host`, `state` (connected\|reconnecting\|circuit_open\|dead) | Per-FS health |
| `vici2_esl_reconnects_total` | counter | `fs_host` | Reconnect rate |
| `vici2_esl_disconnect_seconds_total` | counter | `fs_host` | Cumulative downtime; alert source |
| `vici2_esl_last_heartbeat_seconds` | gauge | `fs_host` | Time since last HEARTBEAT |
| `vici2_esl_events_total` | counter | `fs_host`, `event_name` | Per-event ingest rate |
| `vici2_esl_events_dropped_total` | counter | `fs_host`, `event_name`, `reason` | Backpressure drops |
| `vici2_esl_event_queue_depth` | gauge | `fs_host` | Internal Go chan depth |
| `vici2_esl_event_hydration_total` | counter | `result` (ok\|miss\|partial) | Hydration outcome |
| `vici2_esl_originate_total` | counter | `fs_host`, `gateway`, `outcome` (success\|gateway_failure\|timeout\|rate_limited\|circuit_open\|fs_dead) | Originate counts |
| `vici2_esl_originate_latency_seconds` | histogram (NHCB; buckets 0.1, 0.25, 0.5, 1, 2, 5, 10) | `fs_host`, `outcome` | originate→BACKGROUND_JOB latency |
| `vici2_esl_command_total` | counter | `fs_host`, `cmd`, `outcome` | uuid_*, conference, reload counts |
| `vici2_esl_command_latency_seconds` | histogram | `fs_host`, `cmd` | Command latency |
| `vici2_esl_active_jobs` | gauge | `fs_host` | bgapi jobs awaiting BACKGROUND_JOB |
| `vici2_esl_jobs_orphaned_total` | counter | `fs_host` | bgapi jobs that timed out |
| `vici2_esl_circuit_breaker_state` | gauge (0=closed,1=half_open,2=open) | `fs_host` | Breaker state |
| `vici2_esl_rate_limit_blocked_total` | counter | `fs_host`, `gateway`, `kind` (per_fs\|per_gateway) | Token bucket rejections |
| `vici2_esl_reconciled_calls_total` | counter | `fs_host`, `action` (rehydrated\|marked_lost) | Reconcile outcomes |
| `vici2_esl_unaffined_originate_total` | counter | (none) | Originate without FSHost (warning signal) |
| `vici2_esl_streams_xadd_total` | counter | `stream`, `outcome` | Stream publish counts |
| `vici2_esl_pubsub_publish_total` | counter | `channel_class` (agent\|campaign\|wallboard\|call), `outcome` | Pub/sub publish counts |

### 12.1 Alerts (PromQL sketches)

```promql
# Page if any FS conn is dead for >2m
max by (fs_host) (vici2_esl_connection_status{state="dead"}) == 1
  for 2m

# Warn on flapping (>0.1 reconnects/sec averaged over 5m)
rate(vici2_esl_reconnects_total[5m]) > 0.1

# Warn on backpressure
vici2_esl_event_queue_depth / 10000 > 0.8 for 1m

# Page on circuit open >1m (real outage)
vici2_esl_circuit_breaker_state == 2 for 1m

# Page on heartbeat lag >60s (FS dead from our PoV)
time() - vici2_esl_last_heartbeat_seconds > 60

# Warn on >1% job orphan rate
rate(vici2_esl_jobs_orphaned_total[5m]) /
  rate(vici2_esl_originate_total[5m]) > 0.01
```

---

## 13. Originate rate limiting (defense-in-depth)

### 13.1 Two buckets, both Valkey

| Scope | Key | Default rate | Burst |
|---|---|---|---|
| Per-FS | `t:{tid}:rate:originate:{fs_host}` | `VICI2_ORIGINATE_RATE_PER_FS=50` /s | 100 |
| Per-gateway | `t:{tid}:rate:originate:gw:{gateway}` | `VICI2_ORIGINATE_RATE_PER_GATEWAY=10` /s | 20 |

### 13.2 Implementation

Token bucket via Lua script (registered alongside F04 PLAN §6 scripts;
T01 IMPLEMENT files the addition). Sketch:

```lua
-- KEYS[1] = bucket key
-- ARGV[1] = capacity (max tokens)
-- ARGV[2] = refill rate (tokens/sec)
-- ARGV[3] = now_ms
-- Returns 1 if a token was consumed, 0 if rate-limited
```

Both buckets are checked atomically before `Originate` issues the
`bgapi`. If either is empty, return `ErrRateLimited` and emit
`vici2_esl_rate_limit_blocked_total{kind=...}`.

### 13.3 Why both layers

- E02 (dialer pacing) is the *primary* rate control. Bug in pacing
  → unbounded originates → carrier ban risk.
- T01 rate limit is **defense-in-depth**, not the primary control.
  Crossing it should fire an alarm — it means pacing is broken.

---

## 14. Resilience (consolidated)

| Threat | Mitigation |
|---|---|
| FS process dies | Per-FS reconnect with backoff; circuit breaker |
| Network partition | TCP keepalive 30 s; HEARTBEAT-based liveness 40 s |
| FS event-queue saturation (RESEARCH §1.7) | Allowlist (§6) + bounded internal chan + drop-non-critical (§10.4) |
| Carrier all-down | Per-FS circuit breaker scoped to originate |
| BACKGROUND_JOB orphaned (FS dies mid-bgapi) | 60 s timeout → ErrJobOrphaned + metric |
| Stuck channels (FS thinks call alive, we don't) | Reconcile-on-reconnect (§14.2) + E06 janitor sweep |
| Multi-writer race on `call_log` | T01 is SOLE writer of CHANNEL_CREATE/HANGUP rows; api service writes only dispo (§16.4) |
| Eslbridge crash | Stateless; restart picks up where Streams left off (consumer-group XACK semantics) |
| Valkey unavailable | Streams XADD fails → metric, plus we still hold events in the bounded chan; HEARTBEAT-style "valkey-down" backoff to avoid drops escalating; if Valkey down >30 s, escalate via alert |
| Bug in originate path | Rate limiter (§13) caps blast radius |

### 14.1 Reconcile-on-reconnect

On every successful (re)connect to an FS host, before declaring READY:

```
1. api/sync: show channels as json   → list of all live channel UUIDs on FS
2. SMEMBERS t:{tid}:call:active       → what we think is live (F04 §4.8)
3. Set-diff:
     in-FS-not-in-Valkey  → emit synthetic CUSTOM vici2::reconciled.rehydrate
                            event so downstream rebuilds state
     in-Valkey-not-in-FS  → emit synthetic CUSTOM vici2::reconciled.lost
                            event; downstream marks call_log
                            hangup_cause='ESL_RECONCILED', is_lost=1
4. Counter vici2_esl_reconciled_calls_total{fs_host, action} += N
5. Transition state RECONCILING → READY
```

Reconcile uses synchronous `api show channels as json` (NOT bgapi) to
get a coherent snapshot. Reconcile is the only place we use sync `api`
calls in the data path.

### 14.2 Graceful shutdown

On `ctx.Done()`:
1. Stop accepting new commands (return `ErrShuttingDown`).
2. Drain any in-flight bgapi jobs (best-effort, bounded by 5 s).
3. Send `exit` over each Conn (eslgo's `ExitAndClose`) so FS doesn't
   think we crashed and accumulate event queue.
4. Flush bounded internal chan to Streams (best-effort).
5. Close.

---

## 15. Code structure (`dialer/internal/esl/`)

Each file is the responsibility of one concern. T01 IMPLEMENT
deliverable.

```
dialer/internal/esl/
├── doc.go              package doc; module-level invariants
├── client.go           public *Client struct; multi-Conn manager;
│                       constructor `New(opts Options) (*Client, error)`
├── options.go          Options struct (env-driven)
├── supervisor.go       per-FS connection FSM, reconnect, heartbeat
│                       liveness, DEAD classification
├── conn.go             *fsConn struct: wraps *eslgo.Conn + state
├── circuit.go          per-FS, originate-only circuit breaker
├── rate.go             token-bucket rate limiter (Lua via F04 lib)
├── originate.go        Originate primitive: bgapi+Job-UUID handling,
│                       channel-var blob assembly, BACKGROUND_JOB await
├── transfer.go         UUIDTransfer, UUIDBridge, UUIDKill, UUIDPark,
│                       UUIDSetVar, UUIDBroadcast
├── record.go           UUIDRecord
├── conference.go       ConferenceCommand + typed wrappers
│                       (List/Kick/Mute/Hold)
├── reload.go           Reload primitive
├── events.go           subscribe(allowlist), event router, internal
│                       bounded chan, backpressure policy
├── enrich.go           variable_* parsing, Valkey HASH hydration
├── fanout.go           Stream XADD pipeline + pub/sub PUBLISH;
│                       uses dialer/internal/redis from F04
├── reconcile.go        show channels diff vs Valkey on reconnect
├── jobs.go             BACKGROUND_JOB → Job-UUID dispatcher map
├── metrics.go          Prom collectors for all §12 metrics
├── errors.go           ErrCircuitOpen, ErrFSDead, ErrFSUnknown,
│                       ErrAllFSDown, ErrRateLimited, ErrJobOrphaned,
│                       ErrShuttingDown
├── client_test.go      Client public-API tests
├── supervisor_test.go  reconnect/circuit/dead state tests
├── originate_test.go   originate wire-format tests
├── events_test.go      filter + backpressure tests
├── enrich_test.go      hydration tests (mock Valkey)
├── fanout_test.go      Stream + pub/sub publish tests
├── reconcile_test.go   diff-set logic tests
└── testutil/
    ├── fakefs.go       fake ESL server speaking real ESL protocol on
                        loopback (used by every test)
    └── fixtures.go     canned event payloads (CHANNEL_CREATE etc.)
```

T01 IMPLEMENT deliverable count: ~24 Go files including tests.
Estimated lines: ~3000 LOC + ~2000 LOC tests.

### 15.1 Cmd binaries

```
dialer/cmd/eslbridge/
├── main.go             new daemon: Client + event loop + /health + /metrics
└── README.md           operator guide
```

`dialer/cmd/dialer/main.go` (existing) gets a one-line addition:
construct `*esl.Client` from env and inject into pacing/originate
modules.

---

## 16. T01 ↔ T04 boundary clarification (FROZEN)

This is the load-bearing decision of this PLAN — it determines which
module owns which piece of work and prevents two teams from
re-implementing the other's gates.

### 16.1 T01 = transport layer

**T01 owns:**
- The persistent ESL connection per FS host
- `bgapi` framing, `Job-UUID` correlation, BACKGROUND_JOB callbacks
- Reconnect, circuit breaker, rate limiter, reconcile-on-reconnect
- Event subscription + allowlist
- Event enrichment + fan-out to Streams + pub/sub
- The raw `Originate` / `UUIDTransfer` / `UUIDBridge` / `UUIDKill` /
  `UUIDPark` / `UUIDRecord` / `UUIDSetVar` / `UUIDBroadcast` /
  `ConferenceCommand` / `Reload` primitives
- Per-FS metrics

**T01 does NOT own:**
- TCPA 8 am – 9 pm time-zone gate
- DNC final-check (Valkey cache + MySQL fallback)
- Recording-consent state-by-state policy
- Audit-log entries for "this originate happened"
- Lead → carrier affinity / SBC routing
- Pacing (CPS limits beyond the defense-in-depth bucket)
- Drop-rate accounting for adaptive pacing
- Hopper claim / lead lock

### 16.2 T04 = compliance-gated originate

**T04 owns:**
- The public `Originate(LeadOriginateRequest)` API the rest of the
  dialer engine calls
- TCPA window check (lead time-zone vs 8 am – 9 pm local)
- Federal/internal DNC final-check (one last Valkey lookup before
  dialing, in case the lead made it into the hopper before a DNC
  upload)
- Per-state recording-consent gate (1-party vs 2-party state list;
  decides whether to set `RECORD_STEREO=true` and inject the
  beep tone via `mod_avmd`)
- Audit-log row in `originate_audit` MySQL table BEFORE handing to
  T01 (immutable record of "we attempted to dial this lead at this
  time with this caller-id-number under this campaign, gated by
  these checks")
- Translating high-level `LeadOriginateRequest` to T01's transport
  `OriginateRequest` (resolves carrier name, picks `OnAnswerAction`,
  builds `ChannelVars`)

**T04 imports T01:**
```go
import "github.com/F01-org/vici2/dialer/internal/esl"
```

**T01 must NEVER import T04.** This is enforced by:
- `golangci-lint` rule `depguard` configured in `.golangci.yml`
  (T01 IMPLEMENT files the rule)
- Code review

### 16.3 Call graph (Phase 1)

```
Agent UI manual dial click
  ↓ POST /api/agent/dial
api (Node)
  ↓ gRPC
dialer/cmd/dialer (Go)
  ↓ T04.Originate(LeadOriginateRequest)
T04 (compliance gates)
  ├── TCPA window check       ← C01 / lead.time_zone
  ├── DNC final-check         ← Valkey cache + MySQL fallback
  ├── Recording-consent check ← C02
  ├── INSERT originate_audit  ← MySQL
  └── ↓ T01.Client.Originate(OriginateRequest)
       T01 (transport)
       ├── Rate limit (per-FS, per-gateway)
       ├── Circuit check
       ├── HSET t:{tid}:in_flight:{call_uuid}  ← Valkey
       ├── bgapi originate ...
       ├── register Job-UUID callback
       └── return callUUID

           (later, asynchronously)

FS BACKGROUND_JOB event
  ↓ eslbridge receives
  → (a) lookup Job-UUID dispatcher → resolve dialer's await → return result
  → (b) emit metric vici2_esl_originate_total{outcome=...}

FS CHANNEL_CREATE event
  ↓ eslbridge receives
  → enrich (var_*, hydrate from in_flight HASH)
  → XADD events:vici2.call.created (durable)
  → PUBLISH t:{tid}:broadcast:agent:{aid} (live)
```

### 16.4 Call-log writer responsibility

To resolve the multi-writer race RESEARCH §11 #4 flagged:

- **T01 is the SOLE writer of `call_log` rows for**
  `started_at`, `answered_at`, `bridged_at`, `ended_at`, `hangup_cause`,
  `is_drop`, `recording_path` columns. T01 writes via a Stream
  consumer in the `workers/` service (not direct DB writes from
  `eslbridge` — keeping `eslbridge` stateless), but logically T01
  owns the schema columns.
- **The api service is the SOLE writer of `call_log` rows for**
  `dispo`, `dispo_at`, `dispo_by_user_id`, `notes`,
  `callback_scheduled_at` columns (all dispo / agent-input fields).
- **T04 is the SOLE writer of `originate_audit` (separate table)** —
  one row per attempted originate, never updated.

This split is documented in F02 PLAN (DB schema) — T01 IMPLEMENT
files an F02 addendum noting the column-ownership split.

### 16.5 Why the Node consumer described in T01.md is deferred

T01.md §"Public interface" describes a Node ESL listener that
duplicates a subset of `eslbridge`'s work, with rationale "DB
writes" and "WS push". After RESEARCH:

- DB writes are better done by a single consumer subscribed to the
  Valkey Stream (one consumer per service, decoupled from ESL
  reconnect). Putting them in `eslbridge` directly would tie DB
  health to ESL receive performance.
- WS push (A03) likewise reads from Streams + pub/sub, not directly
  from ESL.

The Node listener was the "cheap parallel safety net" pattern from
Vicidial's two-process design (perl AMI listener + AST_send_action
writer). Our single-language (Go) `eslbridge` + Stream-consumer-
based downstream replaces it with a cleaner separation.

If, post-Phase-1, we want a redundant Node listener for safety-net
DB writes, that becomes a sibling module **`T01N`** (deliberately
not part of T01 scope). Filing this as RFC-T01-001 (see §19).

---

## 17. Hand-off interfaces (to other modules)

Concrete contracts every downstream module can depend on once T01
IMPLEMENT lands.

### 17.1 To O01 (Observability / freeswitch-exporter)
- T01 exports `dialer/internal/esl` as a standalone Go package usable
  by other binaries.
- O01's `freeswitch-exporter` binary uses **its own** `*esl.Client`
  with its own ESL connection (separate from `eslbridge`'s) — does
  NOT share Conn (would race on subscriptions).
- It DOES share the `dialer/internal/esl` package code → same
  reconnect/circuit/metrics behavior.
- Contract: O01 binary lives at `dialer/cmd/freeswitch-exporter/`
  alongside `dialer/cmd/eslbridge/`. Same env (`FS_HOSTS`,
  `FS_EVENT_SOCKET_PASSWORD`).

### 17.2 To T02 (Carrier management)
- `Reload(ctx, fsHost, "sofia profile external rescan")` is the
  primitive T02 calls when re-rendering external gateway XMLs.
- Originate calls use `req.GatewayName` strings T02 stores in MySQL
  `carriers` table.
- Contract: T02 must NOT directly send ESL commands; must go through
  `*esl.Client.Reload`.

### 17.3 To T03 (Agent conference)
- `UUIDTransfer(ctx, fsHost, customerUUID, "conference:conference_<aid>@default", "inline", "default")`
  is the primitive that implements the SACRED conference-per-agent
  pattern (SPEC §4.4).
- `ConferenceList`, `ConferenceKick`, `ConferenceMute`, `ConferenceHold`
  expose all conference operations T03 needs.
- `CUSTOM conference::maintenance` events flow via Streams +
  pub/sub for T03's UI updates.

### 17.4 To T04 (Originate primitive)
- The Originate API is `*esl.Client.Originate(ctx, OriginateRequest) (callUUID, error)`.
- T04 wraps with TCPA / DNC / recording gates and `originate_audit`
  insert. **T04 imports T01; T01 never imports T04.** (§16.2)

### 17.5 To E01–E06 (Dialer engine)
- Engine modules call T04, never T01 directly. (Maintains the gate.)
- Exception: E06 (channel/conference janitor) MAY call
  `*esl.Client.UUIDKill` directly to terminate stuck channels found
  during periodic sweeps — janitor work is out of TCPA scope.

### 17.6 To C01 (TCPA gate) and C02 (recording consent)
- Called by T04, never by T01. T01 has no awareness of these.

### 17.7 To R01 (Recording)
- `UUIDRecord(ctx, fsHost, callUUID, "start", path)` is the primitive
  R01 calls.
- R01 receives RECORD_START / RECORD_STOP events via the Stream
  `events:vici2.recording.*`.
- R01 builds the `path` argument per F03 PLAN §0 #8 frozen
  recording-path convention.

### 17.8 To A03 (WebSocket fan-out)
- A03 subscribes to pub/sub `t:{tid}:broadcast:agent:{aid}` for
  per-agent low-latency events (CHANNEL_CREATE, CHANNEL_ANSWER,
  CONFERENCE_MEMBER_ADD).
- A03 ALSO consumes Streams as a consumer-group member for
  durability on critical events (CHANNEL_HANGUP_COMPLETE).
- Contract: A03's Stream consumer-group name = `ws-gateway-<replica-id>`.

### 17.9 To S01 (Wallboard)
- S01 consumes Streams as `wallboard` consumer group on
  `events:vici2.call.*` and `events:vici2.agent.state_changed`.

### 17.10 To S02 (Eavesdrop / coaching / barge)
- S02 calls `*esl.Client.Originate` (via T04) for the supervisor leg
  with `OnAnswerCustom{Raw: "eavesdrop:<call-uuid> XML default"}` or
  `UUIDBroadcast(ctx, fsHost, agentLegUUID, audioPath, "aleg")` for
  whisper.

---

## 18. Testing

### 18.1 Unit tests

- `dialer/internal/esl/testutil/fakefs.go` implements a minimal
  ESL server speaking the real ESL wire protocol on a loopback
  socket. Replays canned auth + event sequences. Used by every test
  file in the package.
- Coverage targets: 85 % statements, 100 % of error paths, 100 %
  of state transitions in `supervisor.go` and `circuit.go`.
- Mock-Valkey: use `miniredis` for hydration / fan-out tests
  (`github.com/alicebob/miniredis/v2`).

### 18.2 Integration tests (require F03 IMPLEMENT done)

- `dialer/test/integration/eslbridge_test.go` runs against the real
  FreeSWITCH container brought up by F01's docker-compose.
- Covers: subscribe + receive 100 synthetic events; Originate +
  observe BACKGROUND_JOB + CHANNEL_CREATE; UUIDKill + observe
  HANGUP_COMPLETE; Reload of sofia profile; reconnect after
  FS restart.
- Tagged `//go:build integration` — `make test` runs unit only,
  `make test-integration` runs both. F01 PLAN's `Makefile` adds the
  target.

### 18.3 Chaos tests

- `dialer/test/chaos/fs_kill_test.go` (build-tag `chaos`):
  - Mid-call FS kill → reconnect → reconcile diff → CDR consistency
    verified
  - 1000-event-burst saturation → bounded chan caps depth → no
    critical event dropped → metric assertions
  - Network partition (iptables) for 60 s → state transitions
    READY → RECONNECTING → DEAD → RECONNECTING → READY → RECONCILING
- Run only in CI on a dedicated chaos workflow (O04 owns).

### 18.4 Concurrency tests

- 100 concurrent goroutines call `Originate` with distinct
  Job-UUIDs → all 100 BACKGROUND_JOB callbacks fire correctly with
  no garbled correlation. Repeated 100 iterations.

---

## 19. Risks, open questions, RFCs filed

### 19.1 Risks

| Risk | Impact | Mitigation |
|---|---|---|
| eslgo's lack of built-in reconnect | High if we don't write the supervisor; planned | Supervisor wrapper (§4) is in scope |
| FS event-queue saturation (RESEARCH §1.7) | High | Allowlist + bounded chan + drop-non-critical (§10.4) |
| BACKGROUND_JOB orphaning if FS dies mid-bgapi | Medium | 60 s timeout → ErrJobOrphaned (§7.2) |
| Multi-writer race on `call_log` | Medium | T01 sole-writer split (§16.4) |
| Reconcile rebuilds wrong state on reconnect | Medium | Synthetic events + idempotent consumers; integration tests |
| MPL-2.0 license obligations | Low | Library file-level copyleft only; we link unmodified, no obligation triggered. Confirmed RESEARCH §2.2 |
| eslgo abandonment after pinning v1.5.0 | Low | Fallback: roll our own ~600 LOC framer (RESEARCH §2.1) |

### 19.2 Open questions deferred to IMPLEMENT

1. Whether to subscribe to `CHANNEL_DESTROY` in addition to
   `CHANNEL_HANGUP_COMPLETE` for redundancy. Default: NO; revisit if
   integration tests show HANGUP_COMPLETE missed in any edge case.
2. Whether to use `events json` instead of `events plain`. Default:
   `plain` (lower bytes, eslgo handles both transparently). Revisit
   if any future event needs nested JSON.
3. Exact buckets for `vici2_esl_originate_latency_seconds` histogram;
   start with 0.1, 0.25, 0.5, 1, 2, 5, 10 s and tune from production
   data.

### 19.3 RFCs filed alongside this PLAN

| RFC | Title | Reason |
|---|---|---|
| **RFC-T01-001** | Defer Node ESL listener to sibling module `T01N` | T01.md §"Public interface" mandates a Node consumer; this PLAN explains why a single Go `eslbridge` + Stream consumers is cleaner. Stub at `spec/rfc/RFC-T01-001-defer-node-esl-listener.md`. |
| **RFC-T01-002** | Split ESL bridge into separate `eslbridge` cmd binary | T01.md does not mandate a separate binary; F01 PLAN's `cmd/` pattern + crash-domain isolation argue for a separate binary. Stub at `spec/rfc/RFC-T01-002-eslbridge-binary-split.md`. |
| **RFC-T01-003** | Reuse F04 cross-cutting Stream naming `events:vici2.<domain>.<event>` and add T01-specific streams under same convention | Brief mentioned `t:{tid}:events:vici2.<domain>.<event>` (tenant-prefixed); F04 PLAN §4.10 freezes these as cross-tenant `events:vici2.<domain>.<event>` (tenant in payload). T01 PLAN follows F04 PLAN. RFC documents the choice and lists T01's new stream additions. Stub at `spec/rfc/RFC-T01-003-stream-naming-alignment.md`. |

Each RFC is a stub markdown file with a 1-paragraph problem + the
proposed resolution above; lead/orchestrator can promote to full
RFC review or accept the proposed resolution inline.

### 19.4 PLAN addenda T01 IMPLEMENT will file (no RFC needed)

These are additive contract extensions, not changes — no RFC per
SPEC §12:

- F04 PLAN §4 — add `t:{tid}:in_flight:{call_uuid}` HASH (§11.2)
- F04 PLAN §4.9 — add `t:{tid}:broadcast:call:{call_uuid}:dtmf`
  pub/sub channel (§10.2)
- F04 PLAN §5.1 — add `events:vici2.call.created`, `.hangup`,
  `.unbridged`, `events:vici2.recording.started`, `.stopped`,
  `events:vici2.conference.created`, `.destroyed`, `.member_added`,
  `.member_left` Streams (§10.2)
- F04 PLAN §6 — add `originate_token_bucket.lua` (§13.2)
- F02 PLAN — document call_log column-ownership split (§16.4)
- F01 PLAN `.env.example` — add T01 env vars (§3.4)
- F01 PLAN docker-compose — add `eslbridge` service (§2.4)

---

## 20. Acceptance criteria (restated from T01.md, PLAN-level)

Verification (T01.md §"Verification phase") becomes:

- [ ] `eslbridge` connects to FS within 5 s of startup
- [ ] `dialer` and `eslbridge` both visible in `fs_cli> show clients`
- [ ] `Originate` returns a `callUUID` within 100 ms (bgapi
      semantics; not waiting for ring)
- [ ] BACKGROUND_JOB result correlates back to the originator's
      `await` channel via Job-UUID
- [ ] FS killed for 30 s → both clients reconnect within 5 s of FS
      restart, supervisor metric increments
- [ ] After reconnect, reconcile emits synthetic events for the
      delta with `call_log` (verified by Stream consumer assertions)
- [ ] Backpressure: 1000-event burst → critical events all
      delivered → non-critical drop counter increments → no panic
- [ ] 100 concurrent `Originate` from 100 goroutines → all 100
      BACKGROUND_JOB callbacks fire correctly
- [ ] All `vici2_esl_*` metrics in §12 present at
      `:9104/metrics` (eslbridge) and `:9102/metrics` (dialer's
      command-side metrics)
- [ ] No raw ESL strings in any caller (`grep -r "bgapi" dialer/
      | grep -v internal/esl/` returns empty)
- [ ] T01 package contains zero imports of `dialer/internal/esl/...`
      from any T04/E*/C* package — depguard rule passes

---

## 21. PLAN file count

This PLAN is the only deliverable for this phase. T01 IMPLEMENT
deliverables (24 Go files, 1 cmd binary, 1 compose service, 7 RFC
stubs / addenda, plus tests) are enumerated in §15 / §19 for the
implementer to consume.

End of PLAN.md.
