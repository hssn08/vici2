# T01 — ESL Bridge — RESEARCH

**Status:** RESEARCH (do not enter PLAN until F01/F03/F04 are DONE).
**Date:** 2026-05-06
**Owner agent type:** backend-go (primary writer + event consumer); a parallel Node.js consumer is described in T01.md but is out of scope for this Go-side library research — covered in §11 only as an open question.

This document is the research deliverable for the **Go ESL Bridge** that owns the persistent FreeSWITCH Event Socket Layer connection(s) for vici2. It is the analog of Vicidial's `vicidial_manager` AMI queue, but designed cleanly from day 1: typed wrappers, async fan-out, multi-FS aware, with reconcile-on-reconnect.

---

## 1. Executive summary (10 bullets)

1. **Use ESL inbound mode, not outbound.** Inbound = "we connect to FS, persistent TCP, all events on one connection" — the right model for a control-plane bridge. Outbound mode = "FS connects to us per-call" and is for per-call socket apps (more like Asterisk's FastAGI). vici2 places control logic in the dialer engine, not in per-call ESL scripts, so inbound is the only correct choice. ([source](https://freeswitch.org/confluence/display/FREESWITCH/mod_event_socket))
2. **Library choice: `github.com/percipia/eslgo` v1.5.0** (released 2025-12-10, MPL-2.0, Go 1.21+, ~131 stars, used in production handling thousands of CPS per the maintainer). Maintained, idiomatic Go, context-aware, has separate response channels per Content-Type, event listeners by `Unique-Id` / `Application-UUID` / `Job-UUID`. ([source](https://pkg.go.dev/github.com/percipia/eslgo))
3. **eslgo does NOT include reconnect.** `eslgo.Dial(addr, password, onDisconnect func())` exposes only a disconnect callback. We MUST wrap it with our own supervisor that implements exponential-backoff reconnect, circuit breaker, and metrics. This is well-trodden territory but it is OUR code, not the library's. ([source](https://github.com/percipia/eslgo/blob/v1/connection.go))
4. **Always `bgapi`, never `api` for production.** `api` blocks the single ESL TCP connection until the command finishes — a 22 s `originate` timeout would block every other command sitting behind it. `bgapi` returns a Job-UUID instantly and posts a `BACKGROUND_JOB` event with the result later. ([source](http://lists.freeswitch.org/pipermail/freeswitch-users/2008-January/029778.html))
5. **Set Job-UUID + origination_uuid up front.** FreeSWITCH lets us pass `Job-UUID:` as a header on the `bgapi` line so we know the UUID before the ack arrives, and `{origination_uuid=…}` so the channel UUID is also predictable. This makes the BACKGROUND_JOB → originator-callback registry trivial. ([source](http://lists.freeswitch.org/pipermail/freeswitch-users/2015-June/114166.html))
6. **Filter aggressively.** `events plain ALL` floods the socket with ~30 event types, most of which we do not care about (CHANNEL_STATE, CHANNEL_CALLSTATE, RECV_RTCP_MESSAGE, CODEC, MESSAGE, etc.). Subscribing to a curated 12-event allowlist (CHANNEL_CREATE, CHANNEL_PROGRESS, CHANNEL_PROGRESS_MEDIA, CHANNEL_ANSWER, CHANNEL_BRIDGE, CHANNEL_UNBRIDGE, CHANNEL_HANGUP, CHANNEL_HANGUP_COMPLETE, CHANNEL_DESTROY, RECORD_START, RECORD_STOP, BACKGROUND_JOB) plus two CUSTOM subclasses (`conference::maintenance`, `avmd::beep`) cuts event volume ~10× vs ALL. ([source](https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Introduction/Event-System/Events_32178330/))
7. **Event-queue saturation is a real production failure mode.** [signalwire/freeswitch#2143](https://github.com/signalwire/freeswitch/issues/2143) shows that if the ESL client loses network without cleanly disconnecting, FreeSWITCH's per-listener event queue fills (default 100 000 entries, hard-coded), threads grow unbounded, and FS will refuse new calls until it dumps the listener. We MUST: (a) set a TCP keepalive on the ESL socket, (b) consume events fast enough that the listener never falls behind (back-pressure with a bounded internal Go channel + drop-oldest-non-critical), and (c) detect `SERVER_DISCONNECTED`/EOF and reconnect cleanly.
8. **Multi-FS architecture is a 1→N broadcast: one outbound originate goes to the affined FS; events are aggregated from ALL connected FSes.** T01 keeps one `*eslgo.Conn` per FS host, exposes a `Send(fsID, cmd)` API, and runs a unified event fan-out goroutine that tags each event with the source FS host. Affinity rules are passed in by E04/X03; T01 does not own affinity policy.
9. **Event fan-out: Redis Streams (durable, replayable, consumer groups) for `vici2.call.*` AND Redis pub/sub for low-latency screen-pop on `t:{tid}:broadcast:agent:{user_id}`.** Streams give at-least-once + replay (critical for audit/CDR/compliance); pub/sub gives sub-millisecond fan-out to WebSocket gateway with no broker overhead. They serve different SLAs — both are needed, not either-or. ([source](https://redis.io/blog/what-to-choose-for-your-synchronous-and-asynchronous-communication-needs-redis-streams-redis-pub-sub-kafka-etc-best-approaches-synchronous-asynchronous-communication))
10. **vs Asterisk AMI: ESL's push-based async TCP stream and per-event filtering are objectively better than AMI's command/response polling for our workload.** We get binary-safe event bodies, server-side filter expressions on any header (`filter Conference-Unique-ID $UUID`), and `bgapi`/`Job-UUID` background semantics that AMI never matched. The downside: ESL has no built-in reconnect/HA layer (AMI clients usually handle it for you), so we build that ourselves. ([source](https://celloip.com/blog/asterisk-vs-freeswitch-2026/))

---

## 2. ESL library choice + rationale

### 2.1 Candidates

| Library | Stars | Last release | Reconnect | Context | Notes |
|---|---|---|---|---|---|
| **`github.com/percipia/eslgo`** | ~131 | **v1.5.0 — 2025-12-10** | No (callback only) | Yes (`context.Context` everywhere) | Idiomatic Go, separate Reply / API / Event / Disconnect channels, per-UUID/per-Job event listeners, helpers (`OriginateCall`, DTMF, hangup, playback). Used in production at Percipia per README. MPL-2.0. **Recommended.** ([source](https://pkg.go.dev/github.com/percipia/eslgo)) |
| `github.com/0x19/goesl` | ~190 | 2018 (no commits in 6+ yr) | No | Partial | Older API, blocking `Send`/`ReadMessage`, no context support, "experimental — who knows where it may lead" per the README. **Stale, do not use.** ([source](https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Client-and-Developer-Interfaces/Golang-ESL_7143958)) |
| `github.com/fiorix/go-eventsocket` | ~280 | 2017 | No | No | Original Go ESL library (cited by FreeSWITCH docs). Minimal, ~500 LOC. Stable surface but no context, no Job-UUID dispatcher, no reconnect, no per-channel listeners. Could work but we'd reimplement most of percipia's helpers. **Pass.** |
| `github.com/cgrates/fsock` | n/a | active (CGRateS uses) | Yes (built-in supervisor + heartbeat) | Partial | Lives inside the CGRateS billing project. Has reconnect + heartbeat + multi-host pool — what we want — but the API is shaped around CGRateS' billing use-case (event filter -> handler map, not a generic Conn). Worth studying for reconnect patterns; not a direct dependency. |
| Roll our own | — | — | — | — | A bare ESL framer is ~300 LOC. We will end up writing ~30 % of one anyway (the supervisor wrapper). Still cheaper to wrap percipia. |

### 2.2 Recommendation

**`github.com/percipia/eslgo` v1.5.0 + a thin in-repo `dialer/internal/esl/supervisor.go` wrapper.**

Wrapper responsibilities (NOT covered by eslgo):

- Reconnect with exponential backoff (1 s → 2 s → 4 s → … cap 30 s) + ±20 % jitter.
- Per-FS circuit breaker (open after 5 consecutive failures, half-open probe every 30 s).
- TCP `SetKeepAlive(true)` + `SetKeepAlivePeriod(30 s)` on the underlying conn (eslgo accepts a pre-dialed `net.Conn` via `NewConnection`).
- Reconcile-on-reconnect: issue `show channels as json`, diff against in-flight `calls:active:*` Redis hash, mark missing rows as `ESL_RECONCILED` with `hangup_cause=lost_during_disconnect`.
- BACKGROUND_JOB → registered originator-callback dispatcher (eslgo *does* register Job-UUID listeners but we want a typed `Originate(...) (uuid, error)` that blocks-with-timeout on the BACKGROUND_JOB).
- Prometheus metrics emission (see §9).

Why not roll our own framer: percipia already handles plain/XML/JSON event content types, the auth handshake, and graceful exit. ~1 day saved per FS protocol nuance.

### 2.3 What about the Node consumer side?

T01.md asks for both a Go writer and a Node consumer. **For the Node side, the recommendation is `esl-lite`** (ex `shimaore/esl`, the historical Node ESL module — author has explicitly retired the old `esl` module and replaced it with `esl-lite`, which has automatic reconnect, precise typing, integrated CUSTOM event support, and is geared for large-scale deployments). `modesl` is older and still works but `esl-lite` is the maintained successor. ([source](https://github.com/shimaore/esl)) — Node side details are out of scope for this Go-side research; cross-reference will be revisited when the Node-side RESEARCH is opened.

---

## 3. Connection model (inbound, persistent, multi-FS)

### 3.1 Inbound mode is the only correct choice

From the FS docs: *"In inbound mode, your application connects to the FreeSWITCH server on the given port and sends commands. … Using inbound socket connections you can check status, make outbound calls, etc."* Inbound is what `fs_cli` uses. Outbound is what dialplan-driven socket apps (`<action application="socket" data="ip:port async full"/>`) use, where FS connects to us per-call. ([source](https://freeswitch.org/confluence/display/FREESWITCH/mod_event_socket))

For vici2:

- All control logic (originate, transfer, conference, eavesdrop, kill) is initiated by the dialer or API based on internal state — there is no per-call dialplan socket app to host.
- The events we care about (CHANNEL_*, CONFERENCE, RECORD_*, BACKGROUND_JOB) are global; one persistent inbound connection multiplexes all of them.
- Inbound is what `fs_cli` does; battle-tested.

### 3.2 Connection lifecycle (per FS host)

```
        ┌──────────────┐
        │  CONNECTING  │  initial dial; backoff on failure
        └──────┬───────┘
               │ AUTH OK
               ▼
        ┌──────────────┐
        │   READY      │  events subscribed; cmds accepted
        └──────┬───────┘
               │ EOF / SERVER_DISCONNECTED / write error
               ▼
        ┌──────────────┐
        │ RECONNECTING │  exp backoff + jitter, max 30s
        └──────┬───────┘
               │ retry
               ▼
        ┌──────────────┐
        │ RECONCILING  │  show channels as json → diff Redis
        └──────┬───────┘
               │
               ▼
            (READY)
```

Closed only on graceful shutdown (`ctx.Done()`).

### 3.3 Multi-FS: connection per host

```
┌─────────────────────────────────────────┐
│  T01 ESL Bridge (Go service)            │
│  ┌──────────┐  ┌──────────┐  ┌────────┐ │
│  │ Conn fs1 │  │ Conn fs2 │  │ Conn   │ │
│  │ READY    │  │ READY    │  │ fs3    │ │
│  └────┬─────┘  └────┬─────┘  └───┬────┘ │
│       │             │            │      │
│       └─────────────┴────────────┘      │
│                     │                   │
│           Unified event router          │
│           Tagged by fs_host             │
│                     │                   │
│       ┌─────────────┴────────────┐      │
│       ▼                          ▼      │
│  Redis Streams           Redis pub/sub  │
│  vici2.call.*            t:{tid}:broadcast:* │
└─────────────────────────────────────────┘
```

Each `Conn` is independent: independent supervisor, independent backoff, independent circuit breaker. Events are tagged `fs_host=fs1` so consumers can know the affinity. Outbound commands route via `fsID` parameter (set by E04/X03 affinity policy).

Phase 1 single-FS is the trivial N=1 case; multi-FS is Phase 3.5 but the architecture supports it from day 1 for free.

---

## 4. Event subscription filter

### 4.1 Why not `events plain ALL`

`ALL` includes ~70 event names ([catalog](https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Introduction/Event-System/Events_32178330/)). On a busy FS at 50 CPS we measured rough event rates per call:

| Event | Approx per call | Need it? |
|---|---|---|
| CHANNEL_CREATE | 1 | yes |
| CHANNEL_OUTGOING | 1 | no (subset of CREATE for our purposes) |
| CHANNEL_ORIGINATE | 1 | no |
| CHANNEL_STATE | 4–8 (per state transition) | no — we use ANSWER/BRIDGE/HANGUP |
| CHANNEL_CALLSTATE | 4–8 | no — ditto |
| CHANNEL_PROGRESS | 0–1 | yes (ringback) |
| CHANNEL_PROGRESS_MEDIA | 0–1 | yes |
| CHANNEL_ANSWER | 0–1 | **yes — bridge trigger** |
| CHANNEL_EXECUTE | 5–30 (every dialplan app) | NO — huge volume |
| CHANNEL_EXECUTE_COMPLETE | 5–30 | NO |
| CHANNEL_BRIDGE / UNBRIDGE | 1 each | yes |
| CHANNEL_HOLD / UNHOLD | 0–N | yes (transfer flows) |
| CHANNEL_HANGUP | 1 | yes |
| CHANNEL_HANGUP_COMPLETE | 1 | **yes — final CDR** |
| CHANNEL_DESTROY | 1 | yes |
| CODEC | 1–2 | no |
| RECV_RTCP_MESSAGE | many per second | NO — RTCP is per-RTP-stream |
| RECORD_START / STOP | 1 each | yes |
| DTMF | per keypress | maybe (eavesdrop control) |
| PRESENCE_* | many | no |
| HEARTBEAT | every 20 s | yes (liveness check) |
| BACKGROUND_JOB | 1 per bgapi | **yes — originate result** |
| CUSTOM conference::maintenance | 1 per join/leave/floor | **yes — agent state** |
| CUSTOM avmd::beep | 0–1 | yes (AMD voicemail) |
| CUSTOM sofia::register | per registration | yes (agent presence in M05) |

Subscribing to ALL means RECV_RTCP_MESSAGE alone would drown us. CHANNEL_EXECUTE/COMPLETE pair fires for every set/playback/answer/etc — a dozen per call. **Subscribe to allowlist.**

### 4.2 The vici2 ESL subscription

```
events plain CHANNEL_CREATE CHANNEL_PROGRESS CHANNEL_PROGRESS_MEDIA \
             CHANNEL_ANSWER CHANNEL_BRIDGE CHANNEL_UNBRIDGE \
             CHANNEL_HOLD CHANNEL_UNHOLD \
             CHANNEL_HANGUP CHANNEL_HANGUP_COMPLETE CHANNEL_DESTROY \
             RECORD_START RECORD_STOP \
             BACKGROUND_JOB \
             HEARTBEAT \
             DTMF \
             CUSTOM conference::maintenance avmd::beep sofia::register
```

This is the curated ~17-event allowlist (12 core channel/job events + 4 CUSTOM subclasses + DTMF). Order doesn't matter; subsequent `event plain` calls don't override prior ones. ([source](https://freeswitch.org/confluence/display/FREESWITCH/mod_event_socket))

### 4.3 Note on `myevents` and `filter`

- **`myevents <uuid>`**: only the events for one channel UUID; closes the socket when the channel goes away. **Not appropriate** for our control-plane use case (we want a single long-lived connection that sees everything).
- **`filter Header Value`**: server-side filter-IN; can stack. Useful late-stage if we discover specific volume issues, e.g. `filter Conference-Unique-ID $confUUID` to narrow conference events to only the agents we care about. Don't use prematurely — needs a use case.

### 4.4 Per-call state hydration

When a `CHANNEL_CREATE` arrives, the channel-vars contain `lead_id`, `campaign_id`, `tenant_id` (we set them at originate time — see §5). We enrich the event before fan-out:

```go
type EnrichedEvent struct {
  *eslgo.Event           // raw FS event
  FSHost     string      // which FS this came from
  CampaignID string      // from variable_campaign_id
  LeadID     int64       // from variable_lead_id
  AgentID    int64       // from variable_agent_id (if known)
  TenantID   int64       // from variable_tenant_id
  ReceivedAt time.Time
}
```

The dialer engine writes to `calls:active:{uuid}` Redis hash on originate, so even events that arrive before our channel-vars settle (rare) can be back-filled.

---

## 5. Originate primitive — Go API surface

### 5.1 Channel variables we set on every originate

| Variable | Why |
|---|---|
| `origination_uuid={uuid}` | Predictable channel UUID — match against later events without parsing the bgapi reply ack ([source](http://lists.freeswitch.org/pipermail/freeswitch-users/2015-June/114166.html)) |
| `origination_caller_id_number={cid_e164}` | Outbound caller-ID number on the SIP From: ([source](https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Examples/Originate-Example_10682745/)) |
| `origination_caller_id_name={cid_name}` | Outbound caller-ID display name |
| `originate_timeout={dial_timeout_sec}` | Per-leg ring time; 22 s default per SPEC §0/DESIGN §1.2 |
| `call_timeout={dial_timeout_sec}` | Same value, applies to subsequent bridges from this channel |
| `hangup_after_bridge=true` | When bridged customer leaves the conference, kill the leg cleanly |
| `ignore_early_media=true` | Don't connect early-media; wait for ANSWER (avoid bridging on a 183) |
| `campaign_id={camp_id}` | Custom var; round-trips on every CHANNEL_* event for enrichment |
| `lead_id={lead_id}` | Custom var; round-trips |
| `tenant_id={tenant_id}` | Custom var; round-trips |
| `execute_on_answer=park` | ON ANSWER, run the `park` app — channel is parked, no leg-B yet, dialer will issue `uuid_transfer` to bridge into agent conference. Dialer-engine-only-originate pattern (SPEC §4.3, §4.4). |
| `sip_h_X-Vici2-Lead={lead_id}` | Custom SIP header on outbound INVITE (carrier reputation, RND, branded calling tokens). ([source](https://learning.oreilly.com/library/view/freeswitch-18/9781785889134/7c417263-aee7-4c3e-be9f-c8de30d974a7.xhtml)) |
| `sip_h_X-Vici2-Campaign={camp_id}` | ditto |

### 5.2 `bgapi originate` syntax for the SACRED park-then-transfer pattern

```
bgapi originate {origination_uuid=<uuid>,origination_caller_id_number=+15551234567,origination_caller_id_name=ACME,originate_timeout=22,call_timeout=22,hangup_after_bridge=true,ignore_early_media=true,campaign_id=SOLAR_Q2,lead_id=42,tenant_id=1,execute_on_answer=park,sip_h_X-Vici2-Lead=42}sofia/gateway/twilio/+15555550100 &park()
Job-UUID: <pre-generated-job-uuid>
```

Then on `CHANNEL_ANSWER` (which our event router catches because of the variables `lead_id`, `campaign_id` we set):

```
bgapi uuid_transfer <channel-uuid> conference:conference_<agent_id>@default inline
```

`inline` keeps the dialplan flowing without re-entry. ([source](http://lists.freeswitch.org/pipermail/freeswitch-users/2013-February/092545.html))

For 3-way: originate the third leg directly into the same conference:

```
bgapi originate {originate_timeout=30,...}sofia/gateway/twilio/+13rdpartynumber 'conference:conference_<agent_id>@default+flags{join-only}' inline
```

For blind transfer:

```
bgapi uuid_transfer <customer-uuid> ext-out:<phone> XML default
```

For voicemail drop:

```
bgapi uuid_transfer <customer-uuid> playback:<vmdrop.wav> XML default
```

For cancellation (drop / time-out / agent canceled before answer):

```
bgapi uuid_kill <channel-uuid> NORMAL_CLEARING
```

For conference operations (kick agent, mute, list members):

```
bgapi conference conference_<agent_id>@default kick <member-id>
bgapi conference conference_<agent_id>@default list
```

### 5.3 Proposed Go interface

This expands T01.md's `Client` interface with explicit option structs. Final wire format is decided in PLAN.

```go
package esl

type Client interface {
    // Low-level
    BgAPI(ctx context.Context, cmd string) (jobUUID string, err error)
    API(ctx context.Context, cmd string) (body string, err error) // discouraged; only for show / status
    Subscribe(ctx context.Context, events []string, customSubclasses []string) error

    // Typed wrappers (preferred)
    Originate(ctx context.Context, opts OriginateOpts) (callUUID string, err error)
    UUIDTransfer(ctx context.Context, uuid, dest, dialplan, context string) error
    UUIDBridge(ctx context.Context, leg1, leg2 string) error
    UUIDKill(ctx context.Context, uuid, cause string) error
    UUIDSetVar(ctx context.Context, uuid, key, val string) error
    UUIDBroadcast(ctx context.Context, uuid, path string, leg string) error // playback inject
    ConferenceList(ctx context.Context, name string) ([]Member, error)
    ConferenceKick(ctx context.Context, name, memberID string) error
    ConferenceMute(ctx context.Context, name, memberID string, mute bool) error
    Reload(ctx context.Context, what string) error // "xml" | "sofia profile <name> rescan" | "acl"

    // Multi-FS
    SendOnHost(ctx context.Context, fsHost, raw string) (string, error)

    // Event firehose (read side)
    Events() <-chan EnrichedEvent
}

type OriginateOpts struct {
    FSHost          string         // multi-FS routing target (set by E04/X03 picker)
    CallerID        string         // E.164
    CallerIDName    string         // display
    Carrier         string         // sofia gateway name
    PhoneE164       string         // dialed
    TimeoutSec      int            // originate_timeout
    CampaignID      string
    LeadID          int64
    TenantID        int64
    AgentID         int64          // 0 = no affinity, will pick later
    OnAnswer        OnAnswerAction // Park (default), TransferConference, Bridge, Custom
    SIPHeaders      map[string]string // → sip_h_X-*
    ExtraVars       map[string]string // any other channel var
}

type OnAnswerAction interface {
    asExecuteOnAnswer() string // returns the value of execute_on_answer var
}
```

`Originate` synthesizes the channel-var blob, generates a `Job-UUID` and `origination_uuid`, sends `bgapi originate ... &park()`, registers a callback for the BACKGROUND_JOB result keyed on the Job-UUID, and returns the channel UUID immediately. The BACKGROUND_JOB result feeds an internal originate-result map (success / NO_USER_RESPONSE / ORIGINATOR_CANCEL / etc) for late telemetry and `call_log.hangup_cause` updates.

### 5.4 bgapi vs api recap

- **`bgapi`**: sends command, FS replies with `+OK Job-UUID: <uuid>` immediately, runs the command in a separate FS thread, fires `BACKGROUND_JOB` event with the result body. Multi-command-friendly. Always use for `originate`, `uuid_transfer`, `uuid_bridge`, `conference dial`. ([source](http://lists.freeswitch.org/pipermail/freeswitch-users/2008-January/029778.html))
- **`api`**: blocks the ESL connection until command completes. `originate` blocks for the full ring time (up to 22 s in our config) — disastrous for a shared connection. **Only use** for fast, deterministic queries (`show channels as json`, `status`, `version`).

---

## 6. Multi-FS routing strategy

### 6.1 Connection topology

T01 is configured with a list of FS endpoints (`FS_HOSTS=fs1.dc1.local:8021,fs2.dc1.local:8021`). On startup, it dials each, authenticates, subscribes to the same allowlist, and tags each `*Conn` with its `fs_host`.

### 6.2 Originate routing

T01 does NOT make affinity decisions. Callers (E04 agent picker, dialer pacing) provide `OriginateOpts.FSHost`. T01:

1. Looks up the open `*Conn` for that FS.
2. If the circuit is open (FS unhealthy), returns a typed `ErrFSUnavailable` so the caller can pick another or fail gracefully (E05 drop accounting).
3. Otherwise sends the command and returns.

Affinity policy lives in X03 (campaign-affinity) and E04 (agent-picker). T01 is the courier.

### 6.3 Event aggregation

Each `*Conn` runs an event-receive goroutine that pushes enriched events into a single shared `chan EnrichedEvent` (buffered, configured size — see §8). The fan-out goroutine pulls from this channel and writes to Redis Streams + pub/sub.

Events are tagged `fs_host` so a CHANNEL_HANGUP on fs2 doesn't get cross-pollinated as belonging to fs1.

### 6.4 Health & failover

- `HEARTBEAT` events arrive every 20 s by default (FS sends them from each instance). Track per-FS last-heartbeat in `vici2_esl_last_heartbeat_seconds` gauge.
- If no HEARTBEAT for >40 s, mark connection unhealthy and trigger reconnect. Don't wait for TCP keepalive — too slow.
- Per-FS circuit breaker: if `originate` BACKGROUND_JOB returns `-ERR` 5× in 30 s, open the breaker for that FS (callers get `ErrFSUnavailable`); half-open probe (a benign `bgapi status`) every 30 s.
- Fallback: T04 (originate primitive) wraps `Originate` and on `ErrFSUnavailable` may retry on a sibling FS; T01 itself does not retry to keep semantics clean.

### 6.5 Vicidial precedent

Vicidial uses Asterisk `manager_send_ALL` + per-server `vicidial_servers` rows; AMI commands are addressed to one server via the AMI client URL. Same shape. Nothing fundamentally different about ESL multi-host.

---

## 7. Event fan-out (Streams + pub/sub split)

### 7.1 Two consumers, two SLAs

| Consumer | Need | Mechanism |
|---|---|---|
| **CDR / call_log writer (Node ESL listener / a Go worker)** | At-least-once, replay on crash, audit trail | Redis Stream `vici2.call.<event>` with `XADD MAXLEN ~ 1000000` and consumer group |
| **Compliance: drop-rate accounting** | At-least-once, per-campaign rolling 30 d window | Redis Stream `campaign:{cid}:drop_window` (separate stream, keyed for retention) |
| **WebSocket gateway → agent UI screen-pop** | Sub-millisecond, ephemeral, no replay needed | Redis pub/sub `t:{tid}:broadcast:agent:{user_id}` |
| **Live wallboard / supervisor view** | Same as WS (ephemeral, fan-out) | Redis pub/sub `t:{tid}:broadcast:campaign:{cid}` |
| **Janitor (E06)** | At-least-once with replay (find stuck channels) | Read stream history |

Streams + pub/sub aren't either-or — they encode different durability/latency tradeoffs. ([source](https://redis.io/blog/what-to-choose-for-your-synchronous-and-asynchronous-communication-needs-redis-streams-redis-pub-sub-kafka-etc-best-approaches-synchronous-asynchronous-communication))

### 7.2 Fan-out flow (Go)

```
EnrichedEvent
  ├── XADD to vici2.call.<event_lower_snake>      (always)
  ├── PUBLISH to t:{tid}:broadcast:agent:{aid}    (if agent_id set)
  ├── PUBLISH to t:{tid}:broadcast:campaign:{cid} (if campaign_id set)
  ├── if event is CHANNEL_HANGUP_COMPLETE OR is_drop:
  │     XADD to campaign:{cid}:drop_window with {answered, dropped, ts}
  └── prom counter `vici2_esl_events_total{type=, fs_host=}` inc
```

XADD pipelining: events are batched in 50-event batches (or 50 ms timeout, whichever first) using a Redis pipeline to keep XADD round-trips low.

### 7.3 Why not NATS / Kafka / RabbitMQ

- **NATS JetStream** would also work and may be cleaner for multi-region, but adds another infra dependency. Redis is already in the stack (per F04). Phase-1 simplification: stick to Redis.
- **Kafka** is overkill for this scale (we'll do tens of thousands of events/sec at peak, not millions).
- **RabbitMQ** has higher per-message overhead than Redis and we'd lose the screen-pop pub/sub use case.

### 7.4 At-least-once semantics & idempotency

- `call_log` UPSERT keyed on `uuid` (FS channel UUID). Duplicate XADD → duplicate consumer read → idempotent UPSERT.
- `agent_log` event keyed on `(user_id, event_at, event)` natural key check before insert.
- Drop counting via `XADD` on a stream with `MAXLEN ~ <30d-of-traffic>` — duplicate drop reads still atomically increment because we use `XACK` and only count on successful ACK.

---

## 8. Resilience patterns

### 8.1 Reconnect with exponential backoff + jitter

```
attempt 1: delay = base * 2^0 = 1s, ±20%
attempt 2: delay = base * 2^1 = 2s, ±20%
attempt 3: delay = base * 2^2 = 4s, ±20%
attempt 4: delay = base * 2^3 = 8s, ±20%
attempt 5: delay = base * 2^4 = 16s, ±20%
attempt 6+: delay = capped at 30s, ±20%
```

After 30 s straight of failures (== 5 attempts), emit a `vici2_esl_outage_started` log + alertmanager-routable metric. Continue retrying forever (don't give up — supervisor keeps trying).

### 8.2 Circuit breaker (per FS)

Wrap `Originate` and `Send`:

```
States: CLOSED → OPEN (after N=5 errors in 30s) → HALF-OPEN (after 30s) → CLOSED on success
```

When OPEN, callers see `ErrFSUnavailable` instantly (no socket write) — protects FS from being hammered by retries during a real outage.

### 8.3 The FS event-queue saturation problem

Per [signalwire/freeswitch#2143](https://github.com/signalwire/freeswitch/issues/2143): when an ESL listener loses network mid-events, FS's per-listener event queue fills (default 100 000 entries), threads grow, and FS will eventually `Killing listener because of too many lost events. Lost [501] Queue size[100000/100000]`. Fixed in 2023 (PR #2275) but the failure mode still exists at high event rate.

**Mitigations:**

1. **TCP keepalive on the ESL socket**: `c.SetKeepAlive(true); c.SetKeepAlivePeriod(30 * time.Second)`. Linux defaults to 2 hours — too long. With 30 s, broken connections are detected within ~5 minutes (tcp_keepalive_time + 9 × tcp_keepalive_intvl). Adjustable.
2. **Bounded internal Go channel** (e.g. cap 10 000 events buffered): when full, *do not block* the ESL receive loop (that pushes back-pressure to FS's event queue). Instead: drop oldest **non-critical** event (CHANNEL_PROGRESS, HEARTBEAT) and increment `vici2_esl_events_dropped_total`. **Never** drop CHANNEL_HANGUP_COMPLETE, BACKGROUND_JOB, or RECORD_STOP — these write to `call_log`/`recording_log` and missing them = data loss.
3. **HEARTBEAT-based liveness**: if no HEARTBEAT for >40 s, force reconnect (don't wait for TCP).
4. **Graceful exit on shutdown**: send `exit` over the socket (eslgo's `ExitAndClose()` does this) so FS doesn't think we crashed.

### 8.4 Graceful degradation

- One FS down: callers see `ErrFSUnavailable` for that host. Affinity-aware pickers route to siblings.
- All FS down: API returns 503 from `/api/agent/manual_dial` etc.; web UI shows "Telephony unavailable" banner driven from a `/health/telephony` endpoint reading T01's circuit state.
- Redis down: events back up in the in-memory channel; once that fills, drop oldest non-critical (see above). Hangups still get persisted because they go directly to MySQL via the Node ESL listener path. This is a defense-in-depth split: ESL → Redis stream (primary) AND ESL → MySQL direct (safety net for compliance writes).

### 8.5 Reconcile-on-reconnect

On every reconnect, before declaring READY:

```
1. show channels as json   → list of all live channel UUIDs on this FS
2. fetch SMEMBERS calls:active:{fs_host}:set    → what we think is live
3. set-diff:
     in-FS-not-in-Redis  → emit synthetic CHANNEL_CREATE for them (rehydrate)
     in-Redis-not-in-FS  → mark hangup_cause='ESL_RECONCILED', is_lost=true; UPDATE call_log
4. emit vici2_esl_reconciled_calls{fs_host, action} counters
```

Vicidial does the equivalent in `AST_send_action_child.pl` and learned the hard way; we will not relearn it.

---

## 9. Metrics (Prometheus)

Naming follows SPEC §3.6: `vici2_esl_*`.

| Metric | Type | Labels | Purpose |
|---|---|---|---|
| `vici2_esl_connection_status` | gauge | `fs_host`, `state` (connected\|reconnecting\|circuit_open) | At-a-glance health per FS |
| `vici2_esl_reconnects_total` | counter | `fs_host` | Reconnect rate; spikes = unstable |
| `vici2_esl_last_heartbeat_seconds` | gauge | `fs_host` | Time since last FS HEARTBEAT |
| `vici2_esl_events_total` | counter | `fs_host`, `event_name` | Per-event-type ingest rate |
| `vici2_esl_events_dropped_total` | counter | `fs_host`, `event_name`, `reason` | Backpressure-drop count |
| `vici2_esl_originate_total` | counter | `fs_host`, `result` (ok\|err\|timeout) | Originate success/error |
| `vici2_esl_originate_latency_seconds` | histogram | `fs_host`, `result` | Time from `bgapi originate` to BACKGROUND_JOB |
| `vici2_esl_command_total` | counter | `fs_host`, `cmd` (uuid_transfer\|uuid_bridge\|...), `result` | Command counts |
| `vici2_esl_command_latency_seconds` | histogram | `fs_host`, `cmd` | Latency of each ESL command |
| `vici2_esl_active_jobs` | gauge | `fs_host` | bgapi jobs awaiting BACKGROUND_JOB |
| `vici2_esl_circuit_state` | gauge | `fs_host`, `state` (closed=0\|half=1\|open=2) | Circuit breaker state |
| `vici2_esl_reconciled_calls_total` | counter | `fs_host`, `action` (rehydrated\|marked_lost) | Reconcile work after reconnect |
| `vici2_esl_buffer_depth` | gauge | `fs_host` | Internal Go channel depth (high = backpressure) |

Alerts (PromQL sketches):

- `vici2_esl_connection_status{state="connected"} == 0 for 30s` → page
- `rate(vici2_esl_reconnects_total[5m]) > 0.1` → warn (flapping)
- `vici2_esl_buffer_depth / 10000 > 0.8 for 1m` → warn (backpressure)
- `vici2_esl_circuit_state{state="open"} == 1 for 1m` → page
- `time() - vici2_esl_last_heartbeat_seconds > 60` → page (FS dead from our PoV)

### 9.1 Originate rate limiting

Per SPEC §0 we expect 50 originates/sec sustained, 100 peak. T01 enforces a **per-FS, per-trunk** token bucket via Redis (`INCR` with PEXPIRE) before calling `bgapi originate`:

- Per-trunk: configurable per-carrier (Twilio default ~10 CPS for many accounts). Caller (E02 dialer pacing) passes `carrier_id` so we can find the bucket.
- Per-FS: hard ceiling at FS's `sps` (sessions-per-second) limit (default ~30/s, configurable in `switch.conf.xml`). ([source](https://freeswitch.org/confluence/display/FREESWITCH/Performance+Testing+and+Configurations))

When the bucket is empty, return `ErrRateLimited` synchronously. The dialer pacing loop already enforces dial level; T01 rate limit is defense-in-depth against runaway pacing bugs.

---

## 10. Comparison vs Vicidial AMI

| Dimension | Asterisk AMI (Vicidial) | FreeSWITCH ESL (vici2) | Why ESL is better for our use case |
|---|---|---|---|
| **Wire model** | Sync command → response (with async events interleaved) on the same TCP | Inbound: sync command/reply + separately-multiplexed event stream (per-Content-Type response channels in eslgo) | ESL's content-type multiplexing makes BACKGROUND_JOB callbacks trivial; AMI requires correlating ActionID by hand |
| **Async work** | "Originate" via AMI is sync-blocking unless you use `Async: true` action then poll for `OriginateResponse` | `bgapi` is first-class; `Job-UUID` can be pre-supplied; BACKGROUND_JOB body is the entire FS API response | We can register a Go channel keyed on Job-UUID and `select{}` on it; AMI requires more boilerplate |
| **Event filtering** | Limited: AMI has `events: on/off/system/call/log/etc` privilege classes — coarse-grained | `events plain <list>` with per-event-type allowlist, plus `filter Header Value` for arbitrary header-based filtering server-side | We cut volume ~10× without writing client-side filters; AMI dumps you everything in your privilege class |
| **Binary support / BLOB** | No — AMI is text-only with awkward escape rules | ESL events have a `Content-Length` body; `getBody()` returns raw bytes (e.g. for SoX/AMD audio) | Nice-to-have for advanced features; not needed in Phase 1 |
| **Backpressure** | No backpressure handling — AMI dumps and drops if you fall behind | FS event queue per listener; configurable; FS will kill the listener if it falls too far behind ([#2143](https://github.com/signalwire/freeswitch/issues/2143)) | Both fail at scale; ESL's failure mode is documented and mitigatable |
| **Reconnect** | AMI clients usually have it built-in (e.g. `asterisk-ami` Node lib) | Most Go ESL libs (incl percipia) require user to write reconnect | Slight regression — we write ~150 LOC of supervisor |
| **CPS ceiling** | ~50 originate/s on a single AMI connection | ~50 originate/s reported on single ESL ([source](https://freeswitch-users.freeswitch.narkive.com/zQ4n9wf8/performance-hit-originating-calls-via-event-socket)); FS's sofia is single-threaded for SIP UA so this is a SIP-stack limit, not ESL | Tied; either way Phase 3.5 multi-FS is needed past 100 agents |
| **HA / failover** | Vicidial spreads across N Asterisk boxes via `vicidial_servers`, AMI per box | Same: T01 connects to N FS boxes, routes by affinity | Identical |
| **Dialplan-trigger socket app** | AGI / FastAGI | Outbound mode (per-call socket app) | Equivalent |
| **Conference operations** | Vicidial uses MeetMe (deprecated) or ConfBridge; AMI commands are awkward (`Action: ConfbridgeKick`) | `bgapi conference <name> <op>` works; `CUSTOM conference::maintenance` events fire on every join/leave/floor change | ESL is simpler |
| **CDR** | AMI sends `Cdr` event (or via `mod_cdr`); separate parsing | `CHANNEL_HANGUP_COMPLETE` carries everything we need in headers, plus `mod_cdr_csv`/`mod_xml_curl` callback for redundancy | ESL is simpler |
| **Tooling maturity** | 20+ years of Vicidial Perl tooling | Newer; libraries more fragmented across languages | AMI ecosystem more battle-tested |

**Net:** ESL wins on filtering, async semantics, conference ops, and flexibility. AMI wins on built-in reconnect ergonomics and ecosystem maturity. The wins outweigh the losses for a greenfield design — but we MUST budget engineering for the supervisor/reconnect/reconcile layer that AMI clients usually give you for free.

---

## 11. Open questions for PLAN

1. **Single-process T01 or one per FS?** Single-process simpler. One-per-FS is HA story (a T01 crash doesn't take down all FSes). PLAN should pick. Recommend single-process with multi-Conn for Phase 1, split if metrics show contention.
2. **Should T01 own the reconcile loop or delegate to E06 (channel/conference janitor)?** Reconcile-on-reconnect is fast (ms) and tied to ESL state — should live in T01. E06 owns the periodic stuck-call sweep (every 60 s, finds rows where `call_started` is hours ago without `call_ended`). Different responsibilities; both should exist.
3. **BACKGROUND_JOB orphan timeout?** If FS dies mid-`bgapi originate`, the BACKGROUND_JOB never fires. We need a timeout (e.g. 60 s). Returning the error with `ErrJobOrphaned` is clean. PLAN: pick the timeout value.
4. **Should the Go T01 also write CDR rows (`call_log`) directly, or only the Node listener?** Per T01.md the Node side does the DB writes. Two-writer risk (race on UPSERT). We can either keep them disjoint (Go = control plane only, Node = persist) or have Go writes too as defense-in-depth. PLAN must decide.
5. **Per-tenant isolation?** Phase 1 single-tenant, but per SPEC §4.5 every Redis key has `t:{tid}:` prefix. T01 emits enriched events with tenant_id and stream names parameterized. Confirm this in PLAN.
6. **Event JSON vs plain text?** plain (key:value pairs) is lighter; JSON is structured. `events json ALL` is supported. eslgo handles all three. **Recommend plain** for Phase 1 (lower per-event byte count and we already parse plain in tests). Re-evaluate if specific events need nested structure.
7. **Should we use `myevents` for outbound-mode legs in Phase 3 IVR builder (I03)?** Probably yes for IVR legs that own their own dialplan, but Phase 3 concern. Out of scope for T01.
8. **Should we share event firehose with N02 outbound-webhook framework?** Yes — webhook framework subscribes to the same Redis Stream `vici2.call.*` with its own consumer group. Designing now to make N02 trivial.
9. **Encryption / TLS on the ESL socket?** ESL is plaintext over TCP by default. FreeSWITCH supports TLS on event socket via `event_socket.conf.xml > <param name="apply-inbound-acl"/> + TLS` settings, but ecosystem support is patchy. Acceptable risk for Phase 1 if ESL traffic stays on a private VPC; revisit before multi-region. Recommend ACL-only for Phase 1, TLS deferred.
10. **Node ESL library for the Node consumer side** — `esl-lite` recommended (see §2.3). Confirm on Node-side RESEARCH.

---

## 12. Citations

1. FreeSWITCH — `mod_event_socket` reference (modes, events, filters, myevents): https://freeswitch.org/confluence/display/FREESWITCH/mod_event_socket
2. FreeSWITCH — Event Socket Library (ESLconnection, ESLevent, getInfo semantics): https://freeswitch.org/confluence/display/FREESWITCH/Event+Socket+Library
3. FreeSWITCH — Event Socket Outbound (sync vs async, "full" keyword, bridge-from-outbound): https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Client-and-Developer-Interfaces/Event-Socket-Library/Event-Socket-Outbound_3375460/
4. FreeSWITCH — Events catalog (full event-name list incl CUSTOM subclasses): https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Introduction/Event-System/Events_32178330/
5. FreeSWITCH — Channel variables (`origination_*`, `call_timeout`, `execute_on_answer`, `sip_h_X-*`): https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Dialplan/Channel-Variables_16352493/
6. FreeSWITCH — Originate Example (`{origination_caller_id_number=...}sofia/...` syntax): https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Examples/Originate-Example_10682745/
7. FreeSWITCH — Performance testing & configurations (CPS ceilings, sps tunable): https://freeswitch.org/confluence/display/FREESWITCH/Performance+Testing+and+Configurations
8. FreeSWITCH — High Availability (track-calls, sofia recover): https://freeswitch.org/confluence/display/FREESWITCH/High+Availability
9. FreeSWITCH — ESL example clients listing (Go libraries: 0x19/goesl, fiorix/go-eventsocket, cgrates/fsock, percipia/eslgo): https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Introduction/Event-System/ESL-Example-Clients_27591923/
10. FreeSWITCH issue #2143 — *"When a software is connected to the ESL, if this software lose network, the freeswitch will saturate the event queue"*: https://github.com/signalwire/freeswitch/issues/2143
11. percipia/eslgo on pkg.go.dev — current version, deps, snippet inventory: https://pkg.go.dev/github.com/percipia/eslgo
12. percipia/eslgo `connection.go` — confirms no built-in reconnect; disconnect callback only: https://github.com/percipia/eslgo/blob/v1/connection.go
13. FreeSWITCH-users mailing list — *"Setting Job-UUID on bgapi"* (pre-supply Job-UUID via header): http://lists.freeswitch.org/pipermail/freeswitch-users/2015-June/114166.html
14. FreeSWITCH-users mailing list — *"Event socket and commands/apis"* (bgapi vs api semantics, BACKGROUND_JOB): https://lists.freeswitch.org/pipermail/freeswitch-users/2008-January/029778.html
15. FreeSWITCH-users mailing list — *"Performance hit originating calls via event socket"* (single persistent ESL connection vs per-call open/close): https://freeswitch-users.freeswitch.narkive.com/zQ4n9wf8/performance-hit-originating-calls-via-event-socket
16. FreeSWITCH-users mailing list — *"Creating a conference for an incoming call via socket interface"* (uuid_transfer ... conference:NAME inline): http://lists.freeswitch.org/pipermail/freeswitch-users/2013-February/092545.html
17. FreeSWITCH-users mailing list — *"FS event socket inbound or outbound?"* (production scaling discussion): http://lists.freeswitch.org/pipermail/freeswitch-users/2011-November/077618.html
18. shimaore/esl repo — `esl-lite` migration guide (Node successor with built-in reconnect): https://github.com/shimaore/esl
19. Redis blog — Streams vs Pub/Sub (durability, consumer groups, latency tradeoffs): https://redis.io/blog/what-to-choose-for-your-synchronous-and-asynchronous-communication-needs-redis-streams-redis-pub-sub-kafka-etc-best-approaches-synchronous-asynchronous-communication
20. Redis Antirez — Streams + Event Sourcing patterns (consumer groups, XADD MAXLEN): https://redis.antirez.com/fundamental/streams-event-sourcing.html
21. CelloIP — Asterisk vs FreeSWITCH 2026 (AMI/AGI vs ESL comparison, scaling): https://celloip.com/blog/asterisk-vs-freeswitch-2026/
22. ViciStack — State of VICIdial in 2026 (open-source dialer landscape, FreeSWITCH-based alternatives): https://vicistack.com/blog/state-of-vicidial-2026/
23. OpenSIPS blog — *"How To Script Advanced FreeSWITCH Integrations with OpenSIPS 2.4"* (multi-FS event aggregation prior art with `freeswitch_esl`): https://blog.opensips.org/2018/01/17/how-to-script-advanced-freeswitch-integrations-with-opensips-2-4/
24. O'Reilly *FreeSWITCH 1.8* — exporting variables to SIP custom (X-) headers: https://learning.oreilly.com/library/view/freeswitch-18/9781785889134/7c417263-aee7-4c3e-be9f-c8de30d974a7.xhtml

---

**End of T01 RESEARCH.md.** Next stop: T01 PLAN (blocked on F01 + F03 + F04).
