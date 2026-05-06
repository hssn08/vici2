# Vici2 — Master Implementation Spec for Agent Teams

**Audience:** Coding agents implementing modules in parallel.
**Companion docs:** `DESIGN.md` (architecture), `spec/modules/*.md` (per-module specs).
**Goal:** ship a Vicidial alternative on FreeSWITCH + MySQL + BYOC SIP. See `DESIGN.md` for the full architecture rationale.

---

## 0. How to use this spec

This spec organizes work into **~50 modules**, each scoped to **1–3 weeks of focused work** for one agent. Each module has a complete workflow embedded in its sub-spec.

### 0.1 Per-module agent workflow (the loop every agent runs)

```
1. READ        → DESIGN.md + SPEC.md + spec/modules/<id>.md + every dependency's HANDOFF.md
2. RESEARCH    → Run prescribed MCP queries; produce spec/modules/<id>/RESEARCH.md
3. PLAN        → Produce spec/modules/<id>/PLAN.md (API contracts, schema, files, sequence diagrams)
                 → CHECKPOINT: human or lead-agent review before proceeding
4. IMPLEMENT   → Code following repo conventions (see §3); commit on feat/<id>-<slug> branch
5. VERIFY      → Run prescribed manual checks; record output in spec/modules/<id>/VERIFY.md
6. TEST        → Write & run unit + integration tests; coverage > 70% for new code
7. HANDOFF     → Produce spec/modules/<id>/HANDOFF.md (public interface, gotchas, open issues)
8. PR          → Open PR referencing module ID; checklist must be green
9. DONE        → Module marked complete in tracking; downstream modules unblock
```

**The PLAN checkpoint matters.** Implementations diverge cheaply at the planning stage, expensively after code is written. Don't skip it.

### 0.2 Parallelism

Modules are organized into **tracks**. Modules in different tracks with no dependency arc can run fully in parallel. The dependency graph (§5) is the source of truth — read it before assigning agents.

### 0.3 What an agent should escalate to a human

- Spec ambiguity that affects the public interface
- A dependency turned out to be wrong (different from spec)
- A research finding that invalidates the design (e.g., FreeSWITCH limit lower than assumed)
- An acceptance criterion that's untestable as written
- A security concern not anticipated in the spec

Never escalate: code style choices, internal naming, file organization within the module's directory, library version selection within stated constraints.

---

## 1. Module template

Every `spec/modules/<id>.md` has these sections in this order. If a section is empty, write "N/A" — do not omit.

```markdown
# Module <ID> — <Name>

| Field | Value |
|---|---|
| Track | <number/name> |
| Phase | <1 / 2 / 3 / 3.5 / 4> |
| Effort | <1–3 weeks> |
| Owner agent type | backend-go / backend-node / frontend / sre / fullstack |
| Status | NOT_STARTED / IN_RESEARCH / IN_PLAN / IN_IMPL / IN_TEST / DONE |

## Goal
<One sentence stating what this module produces.>

## Dependencies
- <module-id>: <why we need its output>

## Blocks (downstream)
- <module-id>: <what they need from us>

## Public interface
<APIs, events, DB tables, files this module exposes to the rest of the system.
This is the contract. Once a PLAN is approved, this is FROZEN. Changes require RFC.>

## Research phase
**MCPs:** <which Exa/Ref/grep tools, with literal queries to run>
**Questions to answer:**
- ...
**Deliverable:** `spec/modules/<id>/RESEARCH.md`

## Plan phase
**Deliverable:** `spec/modules/<id>/PLAN.md` containing:
- API/event/schema contracts (with examples)
- Sequence diagrams for non-trivial flows
- File list (paths to be created/modified)
- Library/version choices with justification
- Test plan (what unit/integration tests will exist)
**Checkpoint:** PLAN.md must be reviewed before code starts.

## Implementation phase
**Files to create:** <paths>
**Files to modify:** <paths>
**Pseudocode for non-obvious parts:** <inline>

## Verification phase
**Manual checks:**
- <observable behavior + how to observe>
**Record output in:** `spec/modules/<id>/VERIFY.md`

## Test phase
**Unit tests:** <coverage targets, edge cases>
**Integration tests:** <what's wired together, with what fixture data>
**Run command:** `<exact command>`

## Acceptance criteria
- [ ] <testable, binary>
- [ ] ...

## Risks
<Known unknowns, places likely to need rework.>

## Handoff documentation
**Deliverable:** `spec/modules/<id>/HANDOFF.md` containing:
- What was built (1 paragraph)
- Public interface (URLs, event names, function signatures, DB tables)
- Gotchas downstream consumers must know
- Open issues / TODOs
- Pointers to RESEARCH.md and PLAN.md
```

---

## 2. Repository structure (immutable)

```
vici2/
├── DESIGN.md                       # architecture (do not edit; generates from this spec)
├── SPEC.md                         # this file
├── README.md                       # quick-start for devs
├── docker-compose.yml              # one-command dev environment
├── docker-compose.prod.yml         # production reference
├── .env.example                    # all env vars documented
├── Makefile                        # common dev commands
├── spec/
│   ├── conventions.md              # repo conventions detail (see §3)
│   ├── api-contract.md             # global API decisions
│   ├── event-contract.md           # Redis Streams + ESL events
│   ├── modules/
│   │   ├── F01.md                  # one file per module
│   │   ├── F01/
│   │   │   ├── RESEARCH.md         # filled in during workflow
│   │   │   ├── PLAN.md
│   │   │   ├── VERIFY.md
│   │   │   └── HANDOFF.md
│   │   └── ...
│   └── runbooks/                   # operational procedures
├── shared/
│   ├── proto/                      # gRPC contracts between Go and Node
│   ├── events/                     # Redis Stream schemas (JSON Schema)
│   └── openapi/openapi.yaml        # public REST API spec
├── freeswitch/
│   ├── Dockerfile
│   ├── conf/
│   │   ├── vars.xml
│   │   ├── autoload_configs/event_socket.conf.xml
│   │   ├── autoload_configs/callcenter.conf.xml.tmpl
│   │   ├── autoload_configs/conference.conf.xml
│   │   ├── sip_profiles/internal.xml
│   │   ├── sip_profiles/external.xml
│   │   ├── sip_profiles/external/.gitkeep   # carrier XMLs rendered at runtime
│   │   ├── dialplan/default/00_internal_dialer.xml
│   │   ├── dialplan/default/01_agent_conference.xml
│   │   ├── dialplan/default/02_outbound.xml
│   │   ├── dialplan/public/00_from_carrier.xml
│   │   └── acl.conf.xml
│   ├── tls/                        # WSS certs (gitignored)
│   └── scripts/                    # carrier XML renderer, etc.
├── api/                            # Node 20 + Fastify + Prisma + TypeScript
│   ├── src/
│   │   ├── server.ts
│   │   ├── auth/
│   │   ├── routes/{agent,admin,sup,external}/
│   │   ├── ws/                     # WebSocket gateway
│   │   ├── services/
│   │   ├── esl/                    # Node ESL client (read-only event consumer)
│   │   ├── prisma/
│   │   └── lib/{logger,errors,metrics}/
│   ├── prisma/schema.prisma
│   ├── prisma/migrations/
│   ├── test/                       # vitest
│   └── package.json
├── dialer/                         # Go 1.22+
│   ├── cmd/dialer/main.go
│   ├── internal/
│   │   ├── esl/                    # ESL client (write + event consumer)
│   │   ├── hopper/
│   │   ├── pacing/
│   │   ├── adapt/
│   │   ├── picker/
│   │   ├── compliance/
│   │   ├── janitor/
│   │   ├── db/
│   │   ├── redis/
│   │   └── telemetry/
│   ├── go.mod
│   └── test/
├── workers/                        # Node — DNC sync, recording encode, transcribe
│   ├── src/jobs/{dnc-sync,record-encode,transcribe,callback-fire,retention-sweep}/
│   └── package.json
├── web/                            # Next.js 14 (App Router) + Tailwind + Zustand
│   ├── app/
│   │   ├── (agent)/
│   │   ├── (admin)/
│   │   ├── (sup)/
│   │   └── api/                    # auth/health proxies only; main API is in /api
│   ├── components/
│   │   ├── sip/                    # SIP.js wrappers
│   │   ├── call/
│   │   └── ui/
│   ├── lib/
│   ├── test/                       # playwright + vitest
│   └── package.json
├── kamailio/                       # Phase 3.5
│   └── kamailio.cfg.tmpl
├── rtpengine/                      # Phase 2.5+
│   └── rtpengine.conf.tmpl
└── scripts/
    ├── dev-up.sh                   # docker compose up + migrations + seeds
    ├── seed-test-data.sh
    ├── reset.sh
    └── load-test/                  # k6 + sipp scenarios
```

**Rule:** No agent moves files outside their module's owned paths without an RFC. Cross-cutting changes go through a "platform" module (F01).

---

## 3. Repo conventions (mandatory)

### 3.1 Languages & versions
| Component | Language | Version | Linter | Formatter |
|---|---|---|---|---|
| dialer | Go | 1.22+ | `golangci-lint` (config in repo) | `gofmt` + `goimports` |
| api, workers | TypeScript | Node 20 LTS | `eslint` + `@typescript-eslint` | `prettier` |
| web | TypeScript | Node 20 LTS | `eslint` + `next` plugin | `prettier` |
| FreeSWITCH config | XML | FS 1.10.x | `xmllint --noout` in CI | — |
| Database | MySQL | 8.0 InnoDB | — | — |
| Cache/state | Redis | 7.x | — | — |

### 3.2 Branch & commit
- Branches: `feat/<module-id>-<short-slug>`, `fix/<short>`, `chore/<short>`, `docs/<short>`.
- Commits: Conventional Commits (`feat(F01): scaffold docker-compose`).
- One module = one PR (split if >800 LOC; smaller is better).
- PR title: `[<module-id>] <one-line summary>`.

### 3.3 PR template (enforced)
```markdown
## Module
<id> — <name>

## Summary
<3 bullets>

## Acceptance checklist (from spec)
- [ ] ...
- [ ] ...

## Test plan
- [ ] Unit tests pass: `<command>`
- [ ] Integration tests pass: `<command>`
- [ ] Manual verification recorded in spec/modules/<id>/VERIFY.md
- [ ] Coverage >= 70% on new code

## Handoff
- [ ] HANDOFF.md updated
- [ ] OpenAPI updated (if API surface changed)
- [ ] Event schema updated (if events added/changed)
- [ ] Migrations reversible

## Compliance impact
- [ ] No PII logged
- [ ] No secrets committed
- [ ] DNC / time-zone gates not weakened
```

### 3.4 Logging
- **Format:** structured JSON to stdout. Never `console.log`/`fmt.Println` in production code paths.
- **Required fields:** `ts`, `level`, `service`, `module`, `msg`. `call_uuid`/`lead_id`/`agent_id`/`campaign_id` when available.
- **Levels:** `debug` (dev only), `info` (default), `warn` (recoverable), `error` (caller should care), `fatal` (service exits).
- **Libraries:** Go = `slog`. Node = `pino`. **No** `winston`, `bunyan`, `zap`.
- **Never log:** SIP passwords, lead phone-number lists in bulk, recording binary content, JWT tokens.

### 3.5 Errors
- Go: typed errors with `errors.Is`/`As`. No bare `errors.New` for caller-visible errors.
- TS: discriminated-union error types; no throwing strings; never `catch (e: any)` without re-typing.
- API: every HTTP error returns JSON `{ error: { code, message, details? } }`. `code` is a stable string (e.g., `LEAD_NOT_DIALABLE`).
- A 5xx is a bug. A 4xx is a contract issue. Never use 5xx for user errors.

### 3.6 Metrics (Prometheus)
- Every long-running service exposes `/metrics` on a separate port.
- Naming: `vici2_<subsystem>_<unit>` (e.g., `vici2_dialer_originate_total`, `vici2_dialer_drop_rate_pct`).
- Required base metrics for any service: process up-time, memory, GC pauses, error counts by code.
- Required dialer metrics: `originates/sec`, `bridged/sec`, `drops_pct_30d`, `hopper_size`, `agents_ready`, `dial_level`, `esl_reconnects`.

### 3.7 Secrets
- `.env` for dev, never committed (`.env.example` is committed and is the source of truth for env-var naming).
- Production: secrets via host env or Docker secrets.
- DB passwords, SIP creds, carrier creds: encrypted at rest in MySQL via app-layer envelope encryption (key from env). Never plain-text in DB.

### 3.8 Database
- **Schema changes only via Prisma migrations.** No raw `ALTER TABLE` in app code.
- Every table has `created_at` / `updated_at`. Soft-delete via `deleted_at` only where lifecycle requires (leads, recordings); hard-delete is fine for transient tables.
- Foreign keys ON. `ON DELETE RESTRICT` by default; `CASCADE` only when explicitly required.
- Migrations must be **reversible** (every `up` has a `down`). PR-blocking.
- Long-running migrations on prod tables: write as online schema change scripts (gh-ost / pt-online-schema-change), not as Prisma migrations.

### 3.9 Inter-service contracts
- **REST (browser ↔ API):** OpenAPI 3.0 in `shared/openapi/openapi.yaml`. Generate types via `openapi-typescript` consumed by `web/`.
- **gRPC (API ↔ dialer):** `.proto` files in `shared/proto/`. Generate Go + TS stubs in CI.
- **Events (Redis Streams):** JSON Schema in `shared/events/`. Stream names follow `vici2.<domain>.<event>` (e.g., `vici2.call.answered`). Consumer groups isolate readers.

### 3.10 Testing
- **Unit:** mock all external systems (FS, MySQL, Redis, carriers). Run on every commit.
- **Integration:** spin up real MySQL + Redis + FreeSWITCH (docker compose), use SIPp for fake carrier and a fake browser SIP client. Run on PR + nightly.
- **End-to-end:** Playwright drives the agent UI, real FS, fake SIPp carrier. Run nightly.
- **Load:** k6 (HTTP) + SIPp (SIP). Run before each release.
- **Coverage:** new code >= 70%. Critical paths (compliance, dialer pacing, billing-relevant logging) >= 90%.

### 3.11 Definition of Done (per module)
1. PR merged to `main`.
2. All acceptance criteria checked.
3. HANDOFF.md committed under `spec/modules/<id>/HANDOFF.md`.
4. OpenAPI / event schemas / proto updated if applicable.
5. Migrations reversible and applied to dev DB.
6. Metrics emitted (if applicable) and visible in Grafana dashboard.
7. Runbook entry added under `spec/runbooks/` if module introduces ops procedures.
8. Downstream modules' specs updated if interface changed during impl (rare; PLAN should have caught it).

---

## 4. Cross-cutting design rules

### 4.1 Compliance is a hard floor
The following can NEVER be bypassed by any module without explicit RFC + legal review:
- 8am–9pm called-party-local-time gate (enforced in hopper filler, double-checked at originate)
- DNC scrub (federal + state + internal) before dial
- Drop-rate accounting; auto-throttle when 30-day rolling drop% > campaign target
- Recording consent prompt (in 2-party-consent states) before agent bridge
- Audit log on every dial, every disposition, every DNC change

If your module touches any of these, your PR description must explicitly state how each invariant is preserved.

### 4.2 Live state is in Redis. Persistent state is in MySQL.
- "Where is agent X right now?" → Redis.
- "What did agent X do at 14:32 yesterday?" → MySQL.
- Don't mix: never read agent state from MySQL in a hot path; never durably persist state to Redis.

### 4.3 The dialer engine is the only thing that originates calls.
- Manual dial from agent UI: API → dialer engine → ESL.
- Agent UI never talks to FreeSWITCH directly except via SIP.js (browser audio).
- Why: pacing, drop-rate accounting, time-zone gate, DNC final-check are all in one place.

### 4.4 The conference-per-agent primitive is sacred.
- Every agent who is logged in occupies `conference_${user_id}@default`.
- Every customer call is `uuid_transfer`'d into the agent's conference.
- Transfers/3-way/leave-3way are conference operations.
- Don't invent a different model. See `DESIGN.md` §1.3.

### 4.5 Tenant ID everywhere from day 1
- Every table gets `tenant_id BIGINT NOT NULL DEFAULT 1` (Phase 1: single-tenant, value always 1).
- Every Redis key is prefixed `t:{tenant_id}:`.
- Every API request carries `tenant_id` from JWT claims.
- Phase 4 multi-tenant doesn't require migrations; just remove the default.

### 4.6 No FreeSWITCH config is hand-edited in production.
- Static configs in `freeswitch/conf/` are committed.
- Dynamic configs (carriers, in-groups, IVRs) are templated by the API and rendered to disk + reloaded via ESL `sofia profile external rescan` / `reloadxml`.
- An admin UI change → DB write → renderer → FS reload, all via API.

### 4.7 Failure recovery
Every long-running service must:
- Survive its dependencies restarting (FS, MySQL, Redis).
- Reconcile state on startup (e.g., on dialer engine boot, sweep `call_log` for unfinished calls and decide to kill or recover).
- Emit a `vici2_<service>_recovered_total` counter when reconciliation runs.

---

## 5. Module dependency graph

(Read this before starting a module. Anything upstream must be `DONE` or have a stable mock available.)

```
─── PHASE 1: MVP (Manual dial center) ──────────────────────────────

F01 Repo skeleton + dev environment
F02 MySQL schema + migrations            ← F01
F03 FreeSWITCH base config (Docker)      ← F01
F04 Redis state schema                   ← F01
F05 Auth + RBAC + SIP creds              ← F02

T01 ESL bridge (Go + Node consumers)     ← F03, F04
T02 Carrier mgmt + Sofia gateway tmpl    ← F02, F03, F05
T03 Agent-conference dialplan            ← F03, T01
T04 Outbound originate primitive         ← T01, T02

D01 Lead CRUD service                    ← F02, F05
D02 CSV lead import worker               ← D01
D03 Phone code timezone resolver         ← F02
D04 Status/disposition definitions       ← F02
D05 DNC management (CRUD + federal sync) ← F02
D06 Callback scheduling                  ← D01

R01 record_session + naming convention   ← T03, T04
R02 Recording metadata + S3 upload       ← R01, F02
R03 Recording playback API + UI          ← R02, F05

A01 Next.js skeleton + auth              ← F05
A02 SIP.js softphone integration         ← A01, F03
A03 WebSocket control plane              ← A01, T01
A04 Manual dial flow + UI                ← A02, A03, T04, D01, D03, D05
A05 Live call panel + lead info          ← A04, D01
A06 Disposition + hotkeys + wrapup       ← A05, D04, D06
A07 Transfer modes (5 kinds)             ← A05, T03, T04
A08 Callback scheduling UI               ← A06, D06
A09 Pause codes UI                       ← A05

M01 Admin Next.js skeleton + RBAC        ← F05
M02 Campaign CRUD + dial-method config   ← M01, F02
M03 List + lead admin UI                 ← M01, D01, D02
M04 Carrier + DID admin                  ← M01, T02
M05 User + group management              ← M01, F05
M06 DNC admin + opt-out queue            ← M01, D05
M07 Pause codes + statuses + scripts     ← M01, D04
M08 Reports (call summary, drop% TCPA)   ← M01, F02

C01 Time-zone enforcement gate           ← E01 (used by); D03 (depends on)
C02 Recording consent handler            ← T04, R01
C03 Audit log immutability               ← F02
C04 4-year retention worker              ← C03

─── PHASE 2: Auto-dialer ────────────────────────────────────────────

E01 Hopper filler                        ← D01, D03, D04, D05, F04
E02 Dialer pacing loop                   ← E01, T04, F04
E03 Adaptive dial-level engine           ← E02
E04 Agent picker                         ← F04
E05 Drop-rate enforcement + safe-harbor  ← E02, T04
E06 Channel/conference janitor           ← T01

X01 rtpengine integration (SRTP offload) ← F03, T01

─── PHASE 3: Inbound + Supervisor ───────────────────────────────────

I01 In-groups (mod_callcenter)           ← F03, T01
I02 DID inbound routing                  ← I01, T02
I03 IVR / call-menu builder              ← I01, F03
I04 Closer / blended logic               ← I01, E02, E04
I05 Voicemail capture + drop             ← I01, R01

S01 Live wallboard                       ← A03, F04
S02 Eavesdrop / whisper / barge          ← T01, A02
S03 Force pause / kick                   ← A03, F05
S04 Recording playback browse + search   ← R03, M01

─── PHASE 3.5: Multi-FS scale ──────────────────────────────────────

X02 Kamailio dispatcher                  ← T03, T04
X03 Multi-FS campaign affinity           ← X02, E02
X04 Number pool + rotation               ← T02, E02
X05 Local-presence caller-ID             ← X04

─── PHASE 4: Integrations + premium ────────────────────────────────

N01 External REST API (add_lead, etc.)   ← D01, T04, A04
N02 Outbound webhook framework           ← N01, T01
N03 Salesforce Open CTI adapter          ← N01, N02, A02
N04 HubSpot integration                  ← N01, N02
N05 Branded calling integration          ← T02
N06 Reassigned Numbers DB scrub          ← D05, E01
N07 Whisper transcription pipeline       ← R02

─── OPS (cross-cutting; pick up early) ─────────────────────────────

O01 Observability (Prometheus + Grafana) ← F01
O02 Backup + restore                     ← F02
O03 Load testing (SIPp + k6) harness     ← F03
O04 CI/CD pipeline                       ← F01
O05 Security baseline (TLS, secrets, fail2ban) ← F03
```

### 5.1 Recommended parallel agent allocation (4-agent team, Phase 1)

| Week | Agent A (backend-go) | Agent B (backend-node) | Agent C (frontend) | Agent D (sre/fullstack) |
|---|---|---|---|---|
| 1 | — wait — | F01 Repo + Docker | — wait — | F01 (pair) |
| 2 | T01 ESL bridge | F02 Schema + F05 Auth | A01 Next.js skeleton | F03 FS base + F04 Redis |
| 3 | T01 cont + T04 originate | D01 + D03 + D04 | A01 cont + A02 SIP.js | F03 cont + T02 carriers |
| 4 | T04 cont + R01 recording | D02 + D05 + D06 | A03 WS + A04 manual dial | T03 agent conf + O01 metrics |
| 5 | E06 janitor (early start) | M01 + M02 + M07 | A05 + A06 dispo | R02 + O05 security |
| 6 | (idle / start E01) | M03 + M04 + M05 + M08 | A07 transfers + A09 pause | R03 + O02 backup |
| MVP demo end of W6 | | | | |

Adjust to taste — agents pick from `pending` queue ordered by ID, respecting `blockedBy`.

---

## 6. Module index

### Phase 1 — MVP (manual dial)

**Foundation (F)**
- [F01](spec/modules/F01.md) Repo skeleton + dev environment
- [F02](spec/modules/F02.md) MySQL schema + migrations
- [F03](spec/modules/F03.md) FreeSWITCH base config (Docker)
- [F04](spec/modules/F04.md) Redis state schema + helper lib
- [F05](spec/modules/F05.md) Auth + RBAC + SIP credential gen

**Telephony (T)**
- [T01](spec/modules/T01.md) ESL bridge (Go writer + Node consumer)
- [T02](spec/modules/T02.md) Carrier mgmt + Sofia gateway templating
- [T03](spec/modules/T03.md) Agent-conference dialplan
- [T04](spec/modules/T04.md) Outbound originate primitive

**Data (D)**
- [D01](spec/modules/D01.md) Lead CRUD service
- [D02](spec/modules/D02.md) CSV lead import worker
- [D03](spec/modules/D03.md) Phone-code timezone resolver
- [D04](spec/modules/D04.md) Status & disposition definitions
- [D05](spec/modules/D05.md) DNC management + federal sync
- [D06](spec/modules/D06.md) Callback scheduling

**Recording (R)**
- [R01](spec/modules/R01.md) record_session + naming convention
- [R02](spec/modules/R02.md) Recording metadata + S3 upload worker
- [R03](spec/modules/R03.md) Recording playback API + UI

**Agent UI (A)**
- [A01](spec/modules/A01.md) Next.js skeleton + auth
- [A02](spec/modules/A02.md) SIP.js softphone integration
- [A03](spec/modules/A03.md) WebSocket control plane
- [A04](spec/modules/A04.md) Manual dial flow
- [A05](spec/modules/A05.md) Live call panel + lead info
- [A06](spec/modules/A06.md) Disposition + hotkeys + wrapup
- [A07](spec/modules/A07.md) Transfer modes (blind, vm, closer, 3-way, leave-3way, park-dial)
- [A08](spec/modules/A08.md) Callback scheduling UI
- [A09](spec/modules/A09.md) Pause codes UI

**Admin UI (M)**
- [M01](spec/modules/M01.md) Admin Next.js skeleton + RBAC routing
- [M02](spec/modules/M02.md) Campaign CRUD
- [M03](spec/modules/M03.md) List + lead admin UI
- [M04](spec/modules/M04.md) Carrier + DID admin UI
- [M05](spec/modules/M05.md) User + group management
- [M06](spec/modules/M06.md) DNC admin + opt-out queue
- [M07](spec/modules/M07.md) Pause codes + statuses + scripts
- [M08](spec/modules/M08.md) Reports (call summary, agent productivity, drop%)

**Compliance (C) — cross-cutting**
- [C01](spec/modules/C01.md) Time-zone enforcement gate
- [C02](spec/modules/C02.md) Recording consent handler
- [C03](spec/modules/C03.md) Audit log immutability
- [C04](spec/modules/C04.md) 4-year retention worker

### Phase 2 — Auto-dialer
- [E01](spec/modules/E01.md) Hopper filler
- [E02](spec/modules/E02.md) Dialer pacing loop
- [E03](spec/modules/E03.md) Adaptive dial-level engine
- [E04](spec/modules/E04.md) Agent picker
- [E05](spec/modules/E05.md) Drop-rate enforcement + safe-harbor message
- [E06](spec/modules/E06.md) Channel + conference janitor
- [X01](spec/modules/X01.md) rtpengine integration

### Phase 3 — Inbound + Supervisor
- [I01](spec/modules/I01.md) In-groups (mod_callcenter)
- [I02](spec/modules/I02.md) DID inbound routing
- [I03](spec/modules/I03.md) IVR / call-menu builder
- [I04](spec/modules/I04.md) Closer / blended logic
- [I05](spec/modules/I05.md) Voicemail capture + drop
- [S01](spec/modules/S01.md) Live wallboard
- [S02](spec/modules/S02.md) Eavesdrop / whisper / barge
- [S03](spec/modules/S03.md) Force pause / kick
- [S04](spec/modules/S04.md) Recording playback browse + search

### Phase 3.5 — Scale-out
- [X02](spec/modules/X02.md) Kamailio dispatcher front-end
- [X03](spec/modules/X03.md) Multi-FS campaign affinity
- [X04](spec/modules/X04.md) Number pool + rotation
- [X05](spec/modules/X05.md) Local-presence caller-ID

### Phase 4 — Integrations + premium compliance
- [N01](spec/modules/N01.md) External REST API
- [N02](spec/modules/N02.md) Outbound webhook framework
- [N03](spec/modules/N03.md) Salesforce Open CTI adapter
- [N04](spec/modules/N04.md) HubSpot integration
- [N05](spec/modules/N05.md) Branded calling integration
- [N06](spec/modules/N06.md) Reassigned Numbers DB scrub
- [N07](spec/modules/N07.md) Whisper transcription pipeline

### Operations — pick up early, keep evolving
- [O01](spec/modules/O01.md) Observability (Prometheus + Grafana)
- [O02](spec/modules/O02.md) Backup + restore
- [O03](spec/modules/O03.md) Load testing harness (SIPp + k6)
- [O04](spec/modules/O04.md) CI/CD pipeline
- [O05](spec/modules/O05.md) Security baseline

---

## 7. Per-module spec depth conventions

Each `spec/modules/<id>.md` should be **roughly one page** (300–600 lines) of the module template. Resist the urge to write the implementation in the spec — that's the agent's job. The spec defines:
- **What** must be true after the module is done (acceptance criteria, public interface).
- **How to verify** that what is true.
- **Boundaries** (what this module does NOT do).
- **Non-obvious gotchas** the agent should know upfront (e.g., "Twilio terminates secure trunking at port 5061, NOT 5060").

The spec does NOT define:
- File-level code structure (the agent decides, within the repo's directory layout).
- Internal data structures within the module.
- Library-level API choices, when the spec only constrains the interface to the rest of the system.

---

## 8. Standard MCP-research recipe per module

Each module's RESEARCH phase calls some subset of:

| Tool | When to use |
|---|---|
| **Exa `deep_search_exa` (deep-reasoning)** | Multi-angle questions; "how do production X systems handle Y" |
| **Exa `web_search_exa`** | Specific known-good URLs; vendor docs |
| **Exa `crawling_exa`** | Read full content of identified pages |
| **Exa `deep_researcher_pro`** | Long-form synthesis of broad topic areas (use sparingly; takes 5-15 min) |
| **WebSearch / WebFetch** | Quick fact-finding; pricing pages; current-date docs |
| **Context7 `resolve-library-id` + `query-docs`** | Library-specific API details (Prisma, FreeSWITCH config syntax, SIP.js, Fastify) |
| **Ref `ref_search_documentation` + `ref_read_url`** | Authoritative docs lookup (Twilio, FreeSWITCH official) |
| **Grep `searchGitHub`** | Find production code patterns; use literal patterns, not keywords |

Each module spec lists *which* MCPs and *what literal queries* to run.

---

## 9. Definition of MVP (Phase 1 demo criteria)

When all Phase 1 modules are DONE, this scenario must work end-to-end:

```
0. Admin logs into web UI; creates a campaign in MANUAL mode.
1. Admin uploads a 1000-row CSV of leads to a new list assigned to that campaign.
2. Admin creates an agent user, assigns to campaign.
3. Admin adds a Twilio carrier with valid termination URI + credentials.
4. Agent logs in via web UI in Chrome.
5. Agent's browser registers a SIP.js endpoint; lands in conference_${id}.
6. Agent clicks "Manual Dial Next Lead"; UI POSTs to API; API checks DNC + time zone + creates call_log row + bgapi originates via Telnyx/Twilio gateway.
7. Customer's PSTN phone rings; on answer, FreeSWITCH bridges customer leg into agent's conference.
8. Agent and customer talk; recording is captured.
9. Agent clicks "Hangup"; UI shows disposition picker; agent selects "SALE"; click submit.
10. lead.status updates to SALE; agent_log row written; call_log row finalized; recording_log row created with S3 URL.
11. Admin opens Reports; sees agent's call in today's summary.
12. Admin opens Recordings; finds the recording; plays it in the browser.
13. Agent presses "Transfer → 3-way"; dials a third number; both customer + agent + 3rd are conferenced; agent presses "Leave 3-way"; customer + 3rd remain bridged; agent dispositions XFER and goes back to ready.
14. Federal DNC is synced weekly via cron; admin can see last-sync timestamp.
15. Time-zone gate prevents manual dial to a number in a state currently outside 8am–9pm window (UI shows error, no call placed).
```

If this scenario passes end-to-end with two real phones (or SIPp-simulated PSTN), Phase 1 is **done**.

---

## 10. Definition of Phase 2 demo

Phase 1 + with a new "AUTO" campaign in `RATIO=1.5` mode and 5 logged-in agents:
- Hopper filler keeps a ~50-lead buffer.
- Dialer pacing originates ~7-8 simultaneous calls.
- On answer, calls bridge to whichever agent is READY longest.
- Drop-rate stays under 2% over a 10-minute test.
- Switching the campaign to `ADAPT_TAPERED` adjusts the level dynamically; level visible in admin UI.
- mod_avmd detects voicemail beeps and drops the call; lead status auto-set to AVMA.
- AMD-detected machine plays voicemail-drop audio if `amd_action=vmdrop`.

---

## 11. Risk register (read before starting a high-risk module)

| Module | Top risk | Mitigation |
|---|---|---|
| F03 FreeSWITCH | WSS cert / NAT pain on dev laptops | Provide self-signed CA + a dev-only `host.docker.internal` config; document trust steps. |
| T01 ESL | Connection drops + missed events | Auto-reconnect with backoff + reconcile state on reconnect; tests must simulate dropped connection. |
| T04 Originate | Hard to test without real carrier | SIPp scenario simulates a Twilio answer; CI runs against it. |
| E02 Pacing | Predictive math edge cases | Mirror Vicidial's algorithm; do not invent. Heavy unit tests with seeded scenarios. |
| E05 Drop-rate | TCPA exposure if miscounted | Both Redis stream AND MySQL drop_log written before counted toward limit; reconciler checks. |
| A02 SIP.js | Browser audio device permission UX | Fall-back UI when mic denied; test on Chrome, Firefox, Safari, Edge. |
| C03 Audit log | "Lost" log breaks compliance | Write to MySQL inside the same transaction as the action; S3 archival is async but durable. |
| X01 rtpengine | Operational complexity | Defer to Phase 2; until then accept ~150 WebRTC concurrent ceiling. |

---

## 12. RFC process (when spec needs to change)

If during research/planning/implementation an agent finds a spec issue, they write `spec/rfc/RFC-NNN-short-title.md`:
```markdown
# RFC <NNN> — <Title>

**Status:** PROPOSED / ACCEPTED / REJECTED
**Modules affected:** <list>
**Author:** <agent>
**Date:** <YYYY-MM-DD>

## Problem
## Proposed change
## Alternatives considered
## Impact (interface, schema, downstream modules)
## Migration plan (if interface changes)
```
Lead agent or human reviews. Accepted RFCs trigger spec updates and are linked from affected modules' HANDOFF.md.

---

End of master spec. Per-module specs follow in `spec/modules/`.
