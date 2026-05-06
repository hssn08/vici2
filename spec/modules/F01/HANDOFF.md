# F01 — HANDOFF

**Module:** F01 — Repo Skeleton + Dev Environment
**Status:** DONE
**Date:** 2026-05-06

---

## 1. Overview

F01 ships the full monorepo skeleton: pnpm-workspace TS layer (api, web,
workers, shared/types), one Go workspace (dialer), Docker Compose dev stack
(MySQL 8 + Redis 7 + FreeSWITCH 1.10 + four service containers), Makefile
orchestrating every developer/CI command, lefthook + commitlint + ESLint v9
flat config + Prettier + golangci-lint v2 + .editorconfig conventions, GitHub
Actions stubs for ci + secrets-scan, and a smoke script that verifies all
service `/metrics` and `/health` endpoints. Nothing else exists yet — every
downstream module bootstraps off this scaffold.

## 2. File inventory

```
.dockerignore
.editorconfig
.env.example
.github/PULL_REQUEST_TEMPLATE.md
.github/workflows/ci.yml
.github/workflows/secrets-scan.yml
.gitignore
.golangci.yml
.prettierignore
.prettierrc
.tool-versions
CONTRIBUTING.md
DESIGN.md                                     (pre-existing)
Makefile
README.md
SPEC.md                                       (pre-existing)
api/Dockerfile
api/package.json
api/prisma/migrations/.gitkeep
api/prisma/schema.prisma
api/src/lib/env.ts
api/src/server.ts
api/test/.gitkeep
api/tsconfig.json
commitlint.config.js
dialer/.air.toml
dialer/Dockerfile
dialer/cmd/dialer/main.go
dialer/go.mod
dialer/go.sum
dialer/internal/{adapt,compliance,db,esl,hopper,janitor,pacing,picker,redis}/.gitkeep
dialer/internal/telemetry/metrics.go
dialer/internal/telemetry/metrics_test.go
dialer/test/.gitkeep
docker-compose.dev.yml
docker-compose.macos.yml
docker-compose.prod.yml.example
eslint.config.mjs
freeswitch/Dockerfile
freeswitch/conf/autoload_configs/event_socket.conf.xml
freeswitch/conf/autoload_configs/modules.conf.xml
freeswitch/conf/dialplan/{default,public}/.gitkeep
freeswitch/conf/freeswitch.xml
freeswitch/conf/sip_profiles/external/.gitkeep
freeswitch/conf/vars.xml
freeswitch/scripts/.gitkeep
freeswitch/tls/.gitkeep
go.work
kamailio/.gitkeep
lefthook.yml
package.json
pnpm-lock.yaml
pnpm-workspace.yaml
rtpengine/.gitkeep
scripts/dev-up.sh
scripts/load-test/.gitkeep
scripts/reset.sh
scripts/smoke.sh
shared/events/.gitkeep
shared/openapi/openapi.yaml
shared/proto/.gitkeep
shared/types/package.json
shared/types/src/index.ts
shared/types/tsconfig.json
spec/api-contract.md
spec/conventions.md
spec/event-contract.md
spec/rfc/RFC-001-pnpm-vs-npm-workspaces.md
tsconfig.base.json
web/Dockerfile
web/next-env.d.ts
web/next.config.mjs
web/package.json
web/src/app/api/health/route.ts
web/src/app/api/metrics/route.ts
web/src/app/layout.tsx
web/src/app/page.tsx
web/tsconfig.json
workers/Dockerfile
workers/package.json
workers/src/index.ts
workers/tsconfig.json
```

(Run `git ls-files` for the canonical list after the F01 commits land.)

## 3. Established conventions (binding for every downstream module)

### 3.1 Branch naming
- `feat/<module-id>-<slug>` — primary work branch (example: `feat/F02-mysql-schema`)
- `fix/<short>` / `chore/<short>` / `docs/<short>` — supporting work
- The agent never opens a PR off `main` directly; always a feat branch

### 3.2 Commits — Conventional Commits
- `<type>(<scope>): <subject>` — `type` ∈
  `feat|fix|chore|docs|test|refactor|perf|build|ci|style|revert`
- `scope` SHOULD be the module ID (`F01`, `F02`, `T01`, …) when the change
  belongs to one module; use `deps`, `build`, `ci`, etc. for cross-cutting
  changes
- Header ≤ 100 chars (`commitlint.config.js`)
- `subject-case` rule is OFF (allows lowercase / uppercase freely)
- `scope-empty` is OFF (allows scope-less commits for repo-wide changes)
- commit-msg lefthook hook runs commitlint on every commit; CI re-runs in O04
- Co-author footer is required for AI-assisted commits; trailer format:
  `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`

### 3.3 Logging — SPEC §3.4
- Go services: `log/slog` JSON handler ONLY. No `fmt.Println`, no `log.Print`,
  no `zap`/`logrus`/`zerolog`.
- Node services: `pino` JSON ONLY. No `console.log`, no `winston`/`bunyan`.
- Required fields: `time`, `level`, `service`, `msg`. Add `module`,
  `call_uuid`, `lead_id`, `agent_id`, `campaign_id` when in scope.
- Levels: `debug` / `info` (default) / `warn` / `error` / `fatal`
- Never log: SIP passwords, JWTs, lead phone-number lists in bulk, recording
  binary
- Each service stub already wires up its logger; downstream code should
  receive the logger via DI rather than calling the global

### 3.4 Env loading
- `.env.example` is the **only** committed env file and is the source of truth
  for variable **names**. Real `.env` is gitignored.
- Go (`dialer/`): `github.com/joho/godotenv/autoload` (dev only; prod injects
  via container env)
- Node (`api/`, `workers/`): `dotenv-flow/config` imported at boot (already
  wired)
- Next.js (`web/`): native `.env` loader (file in repo root works as well as
  in `web/`; we use repo root)
- Prisma reads `DATABASE_URL` from the same `.env`; no extra config
- New env vars MUST be added to `.env.example` in the same PR that uses them

### 3.5 Metrics — SPEC §3.6
- Naming: `vici2_<subsystem>_<unit>` (lowercase snake_case).
  - Counters end in `_total`
  - Durations in `_seconds` / histograms with `_bucket`
  - Sizes in `_bytes`
- Port assignments (DO NOT overlap):
  - api: **`:9101`**
  - dialer: **`:9102`**
  - workers: **`:9103`**
  - web: served by Next.js route at `/api/metrics` on the web port (`:4000`)
  - freeswitch: TBD by F03 (likely `mod_prometheus` exporter on `:9282` or
    via `mod_event_socket`)
- Libraries already wired:
  - Go: `github.com/prometheus/client_golang` v1.20.5 — registry constructor
    in `dialer/internal/telemetry/metrics.go`
  - Node: `prom-client` v15 — `client.collectDefaultMetrics` with
    `prefix: "vici2_<subsystem>_"`
- Each service's stub already exposes a `vici2_<subsystem>_uptime_seconds`
  gauge and a `vici2_<subsystem>_heartbeats_total` counter so O01 sees a
  `vici2_*` series from day 1

### 3.6 Errors — SPEC §3.5
- Go: typed errors via `errors.Is`/`As`. No bare `errors.New` for caller-
  visible errors.
- TS: discriminated-union error types. Never `catch (e: any)` without
  re-typing. Never throw strings.
- API responses (api/web): `{ error: { code, message, details? } }` with
  stable string `code`. 5xx = bug; 4xx = contract issue.

### 3.7 Secrets
- `.env` is gitignored (`.gitignore` rules `.env`, `.env.*`, `!.env.example`)
- Production: host env vars or Docker secrets (see
  `docker-compose.prod.yml.example`)
- DB passwords / SIP creds / carrier creds: encrypted at rest in MySQL via
  app-layer envelope encryption; key from env. F05 owns the helper.
- gitleaks runs in lefthook pre-commit (skipped if not installed) and in
  `.github/workflows/secrets-scan.yml` on every push/PR
- TLS material in `freeswitch/tls/` is gitignored except `.gitkeep`

### 3.8 PR template — `.github/PULL_REQUEST_TEMPLATE.md`
- Module ID is **required** at the top (`<id> — <name>`)
- Acceptance checklist must be copied from `spec/modules/<id>.md`
- Test plan section lists exact commands run
- Handoff section ensures HANDOFF.md, OpenAPI, event schemas, migrations
  reversibility are addressed
- Compliance impact section is REQUIRED — DNC, time-zone, recording-consent,
  PII-logging, secret-commit invariants must be checked off

### 3.9 Lefthook
- `pnpm install` runs `lefthook install` automatically (root `prepare` script)
- pre-commit (parallel): go-lint (golangci-lint when available), ts-lint
  (eslint --fix), prettier, xmllint, gitleaks
- commit-msg: commitlint --edit
- pre-push: typecheck-go (go vet), typecheck-ts (tsc --noEmit per workspace)
- Every command has a graceful skip for tools that aren't installed locally

### 3.10 Tooling versions (`.tool-versions`)
- `golang 1.22.5`
- `nodejs 20.18.1`
- `pnpm 9.15.0`

CI uses `actions/setup-go@v5` (reads `dialer/go.mod`) and `actions/setup-node@v4`
(reads `.tool-versions`) so versions can be bumped in one place.

## 4. Downstream consumption guide

### F02 — MySQL schema + migrations
- Prisma schema lives at **`api/prisma/schema.prisma`** (already provisioned
  with `provider = "mysql"` + `url = env("DATABASE_URL")`)
- Migrations directory: **`api/prisma/migrations/`** (`.gitkeep` placeholder)
- F02's first migration should be named `0_init`
- `make db-migrate` → `docker compose run --rm api pnpm exec prisma migrate dev`
- `make db-deploy` → `prisma migrate deploy` (CI/prod)
- `make db-reset` → `prisma migrate reset --skip-seed --force`
- `make db-seed` → expects `api/prisma/seed.ts` (F02 adds it)
- Per SPEC §3.8: every table gets `tenant_id BIGINT NOT NULL DEFAULT 1`,
  `created_at`, `updated_at`. FK ON DELETE RESTRICT default. Soft-delete
  only where lifecycle requires.
- Migrations must be REVERSIBLE — each `up.sql` needs a `down.sql`. CI lint
  check belongs to O04.

### F03 — FreeSWITCH base config
- Image: built from `freeswitch/Dockerfile` using SignalWire APT repo (token
  required at build time, surfaced as the build-arg `SIGNALWIRE_TOKEN`)
- Container in compose runs `network_mode: host` on Linux; macOS overlay
  (`docker-compose.macos.yml`) flips to bridge with explicit port maps and
  reduced RTP range (16384-16484 = ~25 simultaneous calls).
- Config tree: `freeswitch/conf/` is bind-mounted read-only at
  `/etc/freeswitch`. Already in place:
  - `freeswitch.xml` — master loader (vanilla)
  - `vars.xml` — global vars (PCMU/PCMA codecs, RTP 16384–32768)
  - `autoload_configs/event_socket.conf.xml` — ESL bound 0.0.0.0:8021,
    password from `${FS_EVENT_SOCKET_PASSWORD}`
  - `autoload_configs/modules.conf.xml` — vanilla minimum + mod_callcenter,
    mod_conference, mod_voicemail, mod_curl, mod_db, mod_hash
  - `dialplan/{default,public}/.gitkeep` — F03 fills with
    `00_internal_dialer.xml` etc.
  - `sip_profiles/external/.gitkeep` — carrier XMLs rendered at runtime by
    T02
- To add a module to FS image: edit
  `freeswitch/conf/autoload_configs/modules.conf.xml` and the `apt install`
  list in `freeswitch/Dockerfile` (builder stage)
- `EXPOSE` already lists 5060/udp+tcp, 5080/udp+tcp, 7443/tcp (WSS),
  8021/tcp (ESL), 16384-32768/udp (RTP)

### F04 — Redis state schema
- **PLAN heads-up:** F01 ships `redis:7.4.1-alpine`; F04's PLAN swaps to
  Valkey. F04 IMPLEMENT should amend `docker-compose.dev.yml` to switch the
  service image (`valkey/valkey:8.0-alpine`) and update the `.env.example`
  / `README.md` references; the `redis_data` named volume can be reused.
  Application-level URL (`redis://redis:6379/0`) doesn't change.
- Compose service name `redis` is referenced from api, dialer, workers env;
  if F04 renames the service, all four envs must be updated atomically.

### F05 — Auth + RBAC + SIP creds
- API JWT secret: `API_JWT_SECRET` env var (already in `.env.example`)
- Refresh secret: `API_JWT_REFRESH_SECRET`
- `api/src/lib/env.ts` is the place to add env validation; F05 should swap
  the loose object for a Zod schema before any auth code runs

### T01 — ESL bridge
- Both `api/` (Node) and `dialer/` (Go) containers can reach FS via
  `host.docker.internal:8021` on Linux (compose declares
  `extra_hosts: host.docker.internal:host-gateway`)
- ESL password from `FS_EVENT_SOCKET_PASSWORD`
- T01 owns the actual Go ESL client (under `dialer/internal/esl/`) and Node
  consumer (under `api/src/esl/` per SPEC.md §2)
- Add Go cmd binaries beside `dialer/cmd/dialer/main.go`
  (e.g. `dialer/cmd/eslbridge/main.go`); each needs its own
  `metrics_port` env

### O01 — Observability
- Prometheus scrape config consumes:
  - api → `:9101`
  - dialer → `:9102`
  - workers → `:9103`
  - web → web container `:4000` at `/api/metrics`
- All series follow `vici2_<subsystem>_<unit>`; F01 already enforces this
  via the registry helpers.
- Libs wired: `prom-client` (Node), `client_golang` (Go).
- O01 just adds `monitoring` (Prometheus + Grafana) services to compose
  alongside the existing ones.

### O04 — CI/CD
- Stub workflows at `.github/workflows/ci.yml` and
  `.github/workflows/secrets-scan.yml`
- ci workflow shape: setup-go (reads `dialer/go.mod`), setup-node (reads
  `.tool-versions`), pnpm/action-setup, `pnpm install --frozen-lockfile`,
  `make lint`, `make typecheck`, `make test`, then a separate
  `build-images` job that runs `make build-images` with
  `${{ secrets.SIGNALWIRE_TOKEN }}` injected
- O04 should keep the contract that CI invokes the same Make targets
  developers run locally — never re-implement steps inline
- commitlint rules currently set `subject-case: 0` and `scope-empty: 0`;
  O04 may tighten to `scope-enum: error` listing all module IDs

### O05 — Security baseline
- TLS material under `freeswitch/tls/` (gitignored)
- gitleaks already wired in lefthook + secrets-scan.yml; O05 may add custom
  rules under `.gitleaks.toml` and SARIF upload
- `apt install` lists in service Dockerfiles use `--no-install-recommends`
  and clean `/var/lib/apt/lists` to keep image surface minimal

### Workspace add patterns
- **Add a Go service:** create `dialer/cmd/<svc>/main.go`. The binary inherits
  the existing `go.work` entry — no extra registration needed. Update
  `dialer/Dockerfile` only if the new binary needs different runtime deps;
  otherwise add a separate Dockerfile under the new svc dir and a compose
  service.
- **Add a Node package:** create `<pkg>/package.json`, append `<pkg>` to
  `pnpm-workspace.yaml`'s `packages` list. Internal packages are referenced
  via `"@vici2/<name>": "workspace:*"` (see `api/package.json` referencing
  `@vici2/types`). Run `pnpm install` to wire the symlinks.

## 5. Quick-start (3 commands)

```bash
cp .env.example .env             # fill in SIGNALWIRE_TOKEN at minimum
pnpm install                     # also installs lefthook hooks
make dev                         # docker compose up --build -d --wait
```

Verify: `make smoke` (exits 0 only if all 14 endpoints reply correctly).

## 6. Where things live

| Concern | Location |
|---|---|
| Service code | `api/src/`, `dialer/cmd/` + `dialer/internal/`, `workers/src/`, `web/src/` |
| Shared TS types | `shared/types/src/` (re-exported via `@vici2/types`) |
| OpenAPI doc | `shared/openapi/openapi.yaml` |
| Event schemas | `shared/events/` (JSON Schema files; F02+ adds them) |
| gRPC protos | `shared/proto/` (T01 adds the first .proto) |
| Prisma schema + migrations | `api/prisma/schema.prisma`, `api/prisma/migrations/` |
| FreeSWITCH XML | `freeswitch/conf/**` |
| Compose | `docker-compose.dev.yml` (default), `.macos.yml` (overlay), `.prod.yml.example` (reference) |
| Module specs | `spec/modules/<id>.md` + `spec/modules/<id>/{RESEARCH,PLAN,VERIFY,HANDOFF}.md` |
| Runbooks | `spec/runbooks/` (each ops module adds its own) |
| Convention cheat-sheet | `spec/conventions.md` |
| RFCs | `spec/rfc/RFC-NNN-<title>.md` |

## 7. Known limitations / deferred work

- **macOS dev experience is degraded.** `docker-compose.macos.yml` overlay
  switches FreeSWITCH to bridge networking with ~25 RTP slots. WebRTC works
  for small-scale testing; full audio load testing still requires Linux. (Per
  PLAN §6 and README.)
- **rtpengine** — placeholder `rtpengine/.gitkeep` only. X01 (Phase 2.5)
  introduces SRTP offload. Until then, accept ~150 WebRTC concurrent
  ceiling.
- **Kamailio** — placeholder `kamailio/.gitkeep` only. X02 (Phase 3.5) adds
  the dispatcher.
- **GitHub Actions** are minimal stubs. O04 owns: caching, parallelism, image
  push to GHCR, coverage upload, SARIF, release artifacts.
- **commitlint rules** are intentionally lax (`scope-empty: 0`,
  `subject-case: 0`). O04 may tighten with `scope-enum` listing every
  module ID once the module list stabilises.
- **No real unit tests yet** beyond `dialer/internal/telemetry`. Stubs exist
  so coverage tooling is wired; downstream modules add real tests.
- **`make db-seed`** assumes `api/prisma/seed.ts` exists (F02 adds it).
- **FreeSWITCH image build was not exercised in this sandbox** — requires
  `SIGNALWIRE_TOKEN`. The Dockerfile fails fast with a clear error if the
  token is absent. F03 first-class verification will exercise this path.
- **Web uses Next.js 14.2** per PLAN. Tailwind v4 + shadcn/ui were considered
  in the orchestrator brief but the F01 PLAN explicitly stays on the
  bare-minimum Next stub; A01 adds Tailwind/shadcn when the agent UI work
  begins.
- **`docker compose up --wait` end-to-end** was not run in the F01
  verification sandbox because the host already binds 3306, 6379, 8021,
  3000. Acceptance criterion #1 (`make dev` < 120 s on warm cache) defers to
  a clean Linux dev box / CI runner.

## 8. Pointers

- [PLAN.md](./PLAN.md) — full architectural choices behind the scaffold
- [RESEARCH.md](./RESEARCH.md) — evidence behind every tool/version pin
- [VERIFY.md](./VERIFY.md) — verification command transcripts
- [F01.md](../F01.md) — original module spec
- [RFC-001](../../rfc/RFC-001-pnpm-vs-npm-workspaces.md) — pnpm vs npm
  workspaces decision
- [SPEC.md §3](../../../SPEC.md) — repo conventions (canonical)
- [DESIGN.md](../../../DESIGN.md) — system architecture
