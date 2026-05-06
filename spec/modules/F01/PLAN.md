# F01 — Repo Skeleton + Dev Environment — PLAN

**Module:** F01 (Foundation, Phase 1)
**Author:** F01 sub-agent
**Date:** 2026-05-06
**Status:** PROPOSED — awaiting human/orchestrator review.
**Companion:** [RESEARCH.md](./RESEARCH.md) — evidence behind every choice.

This plan turns the F01.md spec + RESEARCH findings into the exact set of
files, tool versions, and contracts the IMPLEMENT phase will deliver. Once
this plan is approved, the public interface is FROZEN.

---

## 0. TL;DR (10 bullets)

1. **Tool pins:** Go 1.22.5, Node 20.18.1 LTS, pnpm 9.15.0, FreeSWITCH
   1.10.12, MySQL 8.0.40, Redis 7.4.1, Docker Engine ≥ 24.0,
   docker-compose plugin ≥ 2.24 (Compose Watch).
2. **Monorepo layout:** matches SPEC.md §2 to the letter; one Go module
   under `dialer/` registered in a root `go.work`; pnpm workspaces for
   `api/`, `web/`, `workers/`, `shared/types/`.
3. **One-command dev:** `make dev` → `docker compose up --build -d` +
   `pnpm install` + `prisma migrate dev` + smoke checks. <120s on a
   warm cache.
4. **FreeSWITCH:** custom `freeswitch/Dockerfile` from
   `signalwire/freeswitch:v1.10.12 (debian-bookworm, vanilla meta)`,
   pulled with `SIGNALWIRE_TOKEN` build secret. Runs `network_mode:
   host` on Linux; `docker-compose.macos.yml` override for Mac with
   reduced RTP range.
5. **Live state services:** MySQL with named volume, healthcheck
   `mysqladmin ping`. Redis with `redis-cli ping`. Both gated by
   `service_healthy` for downstream services. Migrations run as a
   one-shot `api-migrate` container (`service_completed_successfully`).
6. **Hot reload:** `air` for Go (`dialer`), `tsx watch` for Node
   (`api`, `workers`), `next dev` for `web`. All driven by Compose
   `develop.watch` with `sync` actions. `WATCHPACK_POLLING=1` set on
   `web`.
7. **Linters:** `golangci-lint` v2 with curated linter list, ESLint 9
   flat config + `typescript-eslint` v8 + `eslint-config-prettier`,
   Prettier 3, `xmllint --noout` for FS XML. Lefthook orchestrates them
   in parallel on staged files; gitleaks blocks secret commits;
   commitlint enforces Conventional Commits.
8. **Metrics endpoints:** dialer `/metrics` :9102, api `/metrics`
   :9101, workers `/metrics` :9103. All emit base process metrics for
   O01 to scrape; service-specific metrics are added by downstream
   modules.
9. **Env convention:** `.env.example` is the single source of truth
   (committed); `.env` is gitignored and is what compose loads. Go
   uses `godotenv` (dev only); Node uses `dotenv-flow/config`; Next.js
   uses its native loader. Prisma reads root `.env` automatically.
10. **CI/CD stub:** `.github/workflows/ci.yml` runs `make lint`, `make
    test`, `make build-images`. Real CI work belongs to O04; F01 only
    ensures the workflow file exists and references Make targets so
    CI is always in sync with local.

---

## 1. Final tool/version matrix

| Layer / tool | Pinned version | Where pinned | Why |
|---|---|---|---|
| Go (dialer) | **1.22.5** | `.tool-versions`, `dialer/go.mod` `go 1.22`, CI matrix | SPEC.md §3.1 says 1.22+; 1.22.5 is the latest 1.22 patch with security fixes. Allows future 1.23 bump via single PR. |
| Node | **20.18.1** (LTS "Iron") | `.tool-versions`, `package.json` `engines.node`, all Dockerfiles | SPEC.md §3.1 says Node 20 LTS. 20.18.1 is current LTS patch (Oct 2024 line). |
| pnpm | **9.15.0** | `.tool-versions`, root `package.json` `packageManager` field, all Dockerfiles | Stable pnpm 9 line; supports `corepack`. |
| TypeScript | **5.6.x** | `package.json` of each TS service | Matches Next.js 14 + typescript-eslint v8 requirements. |
| Next.js | **14.2.x** | `web/package.json` | Per DESIGN.md §3 (Next.js 14). App Router. |
| Fastify | **5.x** | `api/package.json` | Latest stable; matches DESIGN.md. |
| Prisma | **6.x** | `api/package.json` (devDep), Dockerfile | Current major; supports MySQL 8 fully. |
| MySQL | **8.0.40** (`mysql:8.0.40` image) | `docker-compose.yml` | LTS line; SPEC.md §3.1. |
| Redis | **7.4.1** (`redis:7.4.1-alpine`) | `docker-compose.yml` | Stable 7.4 line. |
| FreeSWITCH | **1.10.12** | `freeswitch/Dockerfile` ARG + `.env.example` | Latest official tag (Aug 2024). [release notes](https://github.com/signalwire/freeswitch/releases/tag/v1.10.12) |
| Docker Engine | ≥ 24.0 | `README.md` system requirements | Compose Watch needs v2.22+; healthcheck conditions need 2.1+. |
| docker-compose plugin | ≥ 2.24 | README + `make dev` runtime check | `develop.watch` GA. |
| golangci-lint | **v2.0.x** | `Dockerfile.tools` (CI), `.tool-versions`, `Makefile` lint target | v2 flat-config + tested migration story. |
| ESLint | **9.x** | `package.json` devDep at root and per-package | Flat config required; `.eslintrc` deprecated. |
| typescript-eslint | **8.x** | `package.json` | v8 is the only line that supports ESLint 9 flat config. |
| Prettier | **3.x** | `package.json` | Stable. |
| Lefthook | **1.7.x** | `lefthook.yml`, `package.json` `prepare` script | Single binary, parallel hooks. |
| gitleaks | **v8.21+** | `lefthook.yml` (calls binary), CI workflow uses `gitleaks-action@v2` | 700+ regex rules. |
| Air (Go reload) | **v1.52.x** | `dialer/Dockerfile` `go install` step | Standard. |
| tsx | **4.x** | `package.json` devDep (api, workers) | esbuild-backed; reliable in compose `watch`. |
| commitlint + @commitlint/config-conventional | **19.x** | `package.json` devDep, `commitlint.config.js`, `lefthook.yml` commit-msg | Enforces SPEC.md §3.2 commit format. |

---

## 2. Final repo layout

Matches SPEC.md §2 exactly. F01 creates the directory structure plus the
files listed in §4 below. Items in **bold** are added by F01; the rest
are placeholder `.gitkeep` or deferred to other modules.

```
vici2/
├── DESIGN.md                          (already exists)
├── SPEC.md                            (already exists)
├── README.md                          ← F01
├── CONTRIBUTING.md                    ← F01
├── docker-compose.yml                 ← F01  (default = dev)
├── docker-compose.macos.yml           ← F01  (override for Mac)
├── docker-compose.prod.yml.example    ← F01
├── .env.example                       ← F01
├── .gitignore                         ← F01
├── .dockerignore                      ← F01
├── .editorconfig                      ← F01
├── .tool-versions                     ← F01
├── Makefile                           ← F01
├── lefthook.yml                       ← F01
├── commitlint.config.js               ← F01
├── package.json                       ← F01  (root, pnpm workspace)
├── pnpm-workspace.yaml                ← F01
├── tsconfig.base.json                 ← F01
├── eslint.config.mjs                  ← F01
├── .prettierrc                        ← F01
├── .prettierignore                    ← F01
├── .golangci.yml                      ← F01
├── go.work                            ← F01
├── .github/
│   └── workflows/
│       ├── ci.yml                     ← F01 (stub; O04 fills)
│       └── secrets-scan.yml           ← F01 (gitleaks-action)
├── spec/
│   ├── conventions.md                 ← F01 (extracts SPEC.md §3)
│   ├── api-contract.md                ← F01 (placeholder header)
│   ├── event-contract.md              ← F01 (placeholder header)
│   ├── modules/                       (already exists)
│   ├── runbooks/                      (already exists)
│   └── rfc/
│       └── RFC-001-pnpm-vs-npm-workspaces.md  ← F01
├── shared/
│   ├── proto/.gitkeep                 ← F01
│   ├── events/.gitkeep                ← F01
│   ├── openapi/openapi.yaml           ← F01 (empty 3.0.3 stub)
│   └── types/                         ← F01 (TS package for shared types)
│       ├── package.json
│       ├── tsconfig.json
│       └── src/index.ts               (re-exports placeholder)
├── freeswitch/
│   ├── Dockerfile                     ← F01
│   ├── conf/
│   │   ├── vars.xml                   ← F01 (minimal; F03 expands)
│   │   ├── freeswitch.xml             ← F01 (default loader)
│   │   ├── autoload_configs/
│   │   │   ├── event_socket.conf.xml  ← F01 (binds 0.0.0.0:8021)
│   │   │   ├── modules.conf.xml       ← F01 (vanilla; F03 prunes)
│   │   │   ├── conference.conf.xml    (placeholder; F03)
│   │   │   └── callcenter.conf.xml.tmpl   (.gitkeep; T02)
│   │   ├── sip_profiles/
│   │   │   ├── internal.xml           (placeholder; F03)
│   │   │   ├── external.xml           (placeholder; F03)
│   │   │   └── external/.gitkeep
│   │   ├── dialplan/
│   │   │   ├── default/.gitkeep
│   │   │   └── public/.gitkeep
│   │   └── acl.conf.xml               (placeholder; F03)
│   ├── tls/.gitkeep                   (gitignored content)
│   └── scripts/.gitkeep               (carrier renderer; T02)
├── api/
│   ├── package.json                   ← F01 (stub Fastify "hello")
│   ├── tsconfig.json                  ← F01
│   ├── Dockerfile                     ← F01 (multi-stage, dev target)
│   ├── src/
│   │   ├── server.ts                  ← F01 (stub; /health, /metrics)
│   │   └── lib/
│   │       └── env.ts                 ← F01 (dotenv-flow loader)
│   ├── prisma/
│   │   ├── schema.prisma              ← F01 (provider + datasource only)
│   │   └── migrations/.gitkeep
│   └── test/.gitkeep
├── dialer/
│   ├── go.mod                         ← F01
│   ├── go.sum                         (generated; committed)
│   ├── cmd/
│   │   └── dialer/
│   │       └── main.go                ← F01 (stub; /health, /metrics, gRPC :7000)
│   ├── internal/
│   │   ├── telemetry/metrics.go       ← F01 (prom registry)
│   │   ├── esl/.gitkeep
│   │   ├── hopper/.gitkeep
│   │   ├── pacing/.gitkeep
│   │   ├── adapt/.gitkeep
│   │   ├── picker/.gitkeep
│   │   ├── compliance/.gitkeep
│   │   ├── janitor/.gitkeep
│   │   ├── db/.gitkeep
│   │   └── redis/.gitkeep
│   ├── .air.toml                      ← F01
│   ├── Dockerfile                     ← F01
│   └── test/.gitkeep
├── workers/
│   ├── package.json                   ← F01 (stub)
│   ├── tsconfig.json                  ← F01
│   ├── Dockerfile                     ← F01
│   └── src/
│       └── index.ts                   ← F01 (stub; /metrics on :9103)
├── web/
│   ├── package.json                   ← F01 (stub Next.js)
│   ├── tsconfig.json                  ← F01
│   ├── next.config.mjs                ← F01
│   ├── Dockerfile                     ← F01
│   └── src/
│       └── app/
│           ├── layout.tsx             ← F01
│           └── page.tsx               ← F01 ("hello")
├── kamailio/.gitkeep                  (Phase 3.5)
├── rtpengine/.gitkeep                 (Phase 2.5+)
└── scripts/
    ├── dev-up.sh                      ← F01
    ├── reset.sh                       ← F01
    ├── smoke.sh                       ← F01 (runs the 10 verification checks)
    └── load-test/.gitkeep             (O03)
```

The orchestrator's instruction was "do NOT initialize a git repo, do NOT
create directories outside spec/modules/F01/" — the layout above is what
IMPLEMENT will create later. PLAN.md only describes it; nothing here is
written to disk except the `spec/modules/F01/*` and `spec/rfc/RFC-001…`
files.

---

## 3. docker-compose.yml outline

Single compose file. Services and their key fields:

```yaml
name: vici2

x-common-env: &common-env
  TZ: UTC
  LOG_LEVEL: info

services:

  mysql:
    image: mysql:8.0.40
    container_name: vici2_mysql
    restart: unless-stopped
    command: ["--default-authentication-plugin=caching_sha2_password",
              "--character-set-server=utf8mb4",
              "--collation-server=utf8mb4_unicode_ci",
              "--max-connections=500",
              "--innodb-buffer-pool-size=512M"]
    environment:
      MYSQL_ROOT_PASSWORD: ${VICI2_DB_ROOT_PASSWORD}
      MYSQL_DATABASE: ${VICI2_DB_NAME}
      MYSQL_USER: ${VICI2_DB_USER}
      MYSQL_PASSWORD: ${VICI2_DB_PASSWORD}
    volumes:
      - mysql_data:/var/lib/mysql
    ports:
      - "3306:3306"
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost",
             "-u", "${VICI2_DB_USER}", "-p${VICI2_DB_PASSWORD}"]
      interval: 5s
      timeout: 5s
      retries: 10
      start_period: 30s
    networks: [vici2_default]

  redis:
    image: redis:7.4.1-alpine
    container_name: vici2_redis
    restart: unless-stopped
    command: ["redis-server", "--appendonly", "yes",
              "--maxmemory-policy", "allkeys-lru"]
    volumes:
      - redis_data:/data
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 3s
      timeout: 2s
      retries: 5
      start_period: 5s
    networks: [vici2_default]

  freeswitch:
    build:
      context: ./freeswitch
      args:
        FREESWITCH_VERSION: 1.10.12
        SIGNALWIRE_TOKEN: ${SIGNALWIRE_TOKEN}
    image: vici2/freeswitch:1.10.12
    container_name: vici2_freeswitch
    restart: unless-stopped
    network_mode: host        # Linux dev. Mac override flips to bridge.
    cap_add: [SYS_NICE, IPC_LOCK]
    ulimits:
      rtprio: 99
      memlock: -1
    volumes:
      - ./freeswitch/conf:/etc/freeswitch:ro
      - freeswitch_recordings:/var/lib/freeswitch/recordings
      - freeswitch_log:/var/log/freeswitch
    environment:
      <<: *common-env
      FS_EVENT_SOCKET_PASSWORD: ${FS_EVENT_SOCKET_PASSWORD}
    healthcheck:
      test: ["CMD-SHELL", "fs_cli -p ${FS_EVENT_SOCKET_PASSWORD} -x status | grep -q ^UP || exit 1"]
      interval: 15s
      timeout: 5s
      retries: 5
      start_period: 60s

  api-migrate:
    image: vici2/api:dev
    build:
      context: ./api
      target: builder           # has prisma + node_modules
    container_name: vici2_api_migrate
    command: ["pnpm", "exec", "prisma", "migrate", "deploy"]
    environment:
      <<: *common-env
      DATABASE_URL: mysql://${VICI2_DB_USER}:${VICI2_DB_PASSWORD}@mysql:3306/${VICI2_DB_NAME}
    depends_on:
      mysql: { condition: service_healthy }
    networks: [vici2_default]
    restart: "no"

  api:
    build:
      context: ./api
      target: dev
    image: vici2/api:dev
    container_name: vici2_api
    restart: unless-stopped
    environment:
      <<: *common-env
      PORT: 3000
      METRICS_PORT: 9101
      DATABASE_URL: mysql://${VICI2_DB_USER}:${VICI2_DB_PASSWORD}@mysql:3306/${VICI2_DB_NAME}
      REDIS_URL: redis://redis:6379/0
      FS_ESL_HOST: host.docker.internal
      FS_ESL_PORT: 8021
      FS_EVENT_SOCKET_PASSWORD: ${FS_EVENT_SOCKET_PASSWORD}
    ports:
      - "3000:3000"
      - "9101:9101"
    extra_hosts:
      - "host.docker.internal:host-gateway"
    depends_on:
      mysql:           { condition: service_healthy }
      redis:           { condition: service_healthy }
      api-migrate:     { condition: service_completed_successfully }
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://localhost:3000/health"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 15s
    develop:
      watch:
        - { action: sync, path: ./api/src,    target: /app/src,    ignore: [node_modules/, .next/] }
        - { action: sync, path: ./shared,     target: /shared }
        - { action: rebuild, path: ./api/package.json }
        - { action: rebuild, path: ./api/prisma/schema.prisma }
    networks: [vici2_default]

  dialer:
    build:
      context: ./dialer
      target: dev
    image: vici2/dialer:dev
    container_name: vici2_dialer
    restart: unless-stopped
    environment:
      <<: *common-env
      METRICS_PORT: 9102
      GRPC_PORT: 7000
      DATABASE_DSN: ${VICI2_DB_USER}:${VICI2_DB_PASSWORD}@tcp(mysql:3306)/${VICI2_DB_NAME}?parseTime=true
      REDIS_URL: redis://redis:6379/0
      FS_ESL_HOST: host.docker.internal
      FS_ESL_PORT: 8021
      FS_EVENT_SOCKET_PASSWORD: ${FS_EVENT_SOCKET_PASSWORD}
    ports:
      - "9102:9102"
      - "7000:7000"
    extra_hosts:
      - "host.docker.internal:host-gateway"
    depends_on:
      mysql:       { condition: service_healthy }
      redis:       { condition: service_healthy }
      api-migrate: { condition: service_completed_successfully }
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:9102/health"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 10s
    develop:
      watch:
        - { action: sync,    path: ./dialer, target: /app, ignore: [tmp/, bin/] }
        - { action: rebuild, path: ./dialer/go.mod }
    networks: [vici2_default]

  workers:
    build:
      context: ./workers
      target: dev
    image: vici2/workers:dev
    container_name: vici2_workers
    restart: unless-stopped
    environment:
      <<: *common-env
      METRICS_PORT: 9103
      DATABASE_URL: mysql://${VICI2_DB_USER}:${VICI2_DB_PASSWORD}@mysql:3306/${VICI2_DB_NAME}
      REDIS_URL: redis://redis:6379/0
    ports:
      - "9103:9103"
    depends_on:
      mysql:       { condition: service_healthy }
      redis:       { condition: service_healthy }
      api-migrate: { condition: service_completed_successfully }
    develop:
      watch:
        - { action: sync, path: ./workers/src, target: /app/src }
        - { action: sync, path: ./shared,      target: /shared }
        - { action: rebuild, path: ./workers/package.json }
    networks: [vici2_default]

  web:
    build:
      context: ./web
      target: dev
    image: vici2/web:dev
    container_name: vici2_web
    restart: unless-stopped
    environment:
      <<: *common-env
      PORT: 4000
      WATCHPACK_POLLING: "true"
      NEXT_PUBLIC_API_URL: http://localhost:3000
    ports:
      - "4000:4000"
    depends_on:
      api: { condition: service_healthy }
    develop:
      watch:
        - { action: sync, path: ./web/src,  target: /app/src }
        - { action: sync, path: ./shared,   target: /shared }
        - { action: rebuild, path: ./web/package.json }
    networks: [vici2_default]

volumes:
  mysql_data:
  redis_data:
  freeswitch_recordings:
  freeswitch_log:

networks:
  vici2_default:
    driver: bridge
```

`docker-compose.macos.yml` overrides:
- removes `network_mode: host` from `freeswitch`,
- adds explicit port maps: `5060:5060/udp`, `5060:5060/tcp`,
  `5080:5080/udp`, `5080:5080/tcp`, `7443:7443/tcp`, `8021:8021/tcp`,
  `16384-16484:16384-16484/udp` (100 RTP slots = ~25 calls),
- adds `extra_hosts` so FS can reach the bridge.

`docker-compose.prod.yml.example` strips `develop.watch`, removes
bind-mounts, swaps `target: dev` for `target: prod`, removes exposed
metrics ports (Prometheus scrapes within the network), and gates with
`secrets:` instead of env. It is not used by any F01 target — it's
documentation for O04.

---

## 4. Root files content sketch

### 4.1 `.env.example`
Every var commented; values are non-secret defaults. Includes:
```
# Database
VICI2_DB_HOST=mysql
VICI2_DB_PORT=3306
VICI2_DB_NAME=vici2
VICI2_DB_USER=vici2
VICI2_DB_PASSWORD=change-me-vici2-pw         # 16+ chars; never commit real
VICI2_DB_ROOT_PASSWORD=change-me-root-pw

# Redis
VICI2_REDIS_URL=redis://redis:6379/0

# FreeSWITCH
SIGNALWIRE_TOKEN=                            # required to build FS image
FS_EVENT_SOCKET_PASSWORD=ClueCon             # change in any non-dev env
FS_HOST=localhost                            # what the browser hits for SIP.js (see DESIGN.md §7.2)
FS_WSS_PORT=7443
FS_ESL_HOST=host.docker.internal
FS_ESL_PORT=8021

# API
API_HTTP_PORT=3000
API_METRICS_PORT=9101
API_JWT_SECRET=change-me-jwt-secret          # 32+ random bytes base64
API_JWT_REFRESH_SECRET=change-me-refresh-secret

# Dialer
DIALER_METRICS_PORT=9102
DIALER_GRPC_PORT=7000

# Workers
WORKERS_METRICS_PORT=9103

# Web
WEB_PORT=4000
NEXT_PUBLIC_API_URL=http://localhost:3000

# Tenant (Phase 1 single-tenant; SPEC.md §4.5)
VICI2_DEFAULT_TENANT_ID=1

# Carriers (placeholders; T02 owns)
TWILIO_TERMINATION_USER=
TWILIO_TERMINATION_PASS=

# Misc
NODE_ENV=development
GO_ENV=development
LOG_LEVEL=info
```

`.env` is gitignored. `make dev` copies `.env.example` → `.env` on first
run if `.env` is absent, then prints a warning telling the dev to set
`SIGNALWIRE_TOKEN`.

### 4.2 `Makefile` (target list)

```
make help              # prints available targets (default)
make dev               # docker compose up --build -d --wait + pnpm i + smoke
make dev-watch         # docker compose up --watch (foreground, interactive)
make dev-down          # docker compose down (keeps volumes)
make reset             # docker compose down -v && rm -rf node_modules dialer/bin
make logs              # docker compose logs -f --tail=200
make logs-fs           # docker compose logs -f freeswitch
make ps                # docker compose ps
make build             # build all docker images (parallel)
make build-images      # alias of build (matches SPEC §3.11)
make test              # make test-go && make test-node && scripts/smoke.sh
make test-go           # cd dialer && go test ./...
make test-node         # pnpm -r run test
make lint              # make lint-go && make lint-node && make lint-xml
make lint-fix          # auto-fix where possible
make lint-go           # golangci-lint run ./...
make lint-node         # eslint . && prettier --check .
make lint-xml          # find freeswitch/conf -name '*.xml' | xargs xmllint --noout
make typecheck         # cd dialer && go vet ./...; pnpm -r exec tsc --noEmit
make db-migrate        # docker compose run --rm api pnpm exec prisma migrate dev
make db-deploy         # prisma migrate deploy (CI/prod use)
make db-reset          # prisma migrate reset --skip-seed
make db-seed           # docker compose run --rm api pnpm exec ts-node prisma/seed.ts
make fs-up             # docker compose up -d freeswitch
make fs-down           # docker compose stop freeswitch
make fs-reload         # fs_cli -x reloadxml + sofia rescan
make fs-cli            # docker compose exec freeswitch fs_cli
make redis-cli         # docker compose exec redis redis-cli
make mysql-cli         # docker compose exec mysql mysql -u$VICI2_DB_USER -p…
make smoke             # scripts/smoke.sh (10 checks)
make hooks             # lefthook install
make clean             # docker compose down -v && remove generated artifacts
```

Each target is one bash invocation; complex logic lives in `scripts/*.sh`.

### 4.3 `pnpm-workspace.yaml`
```yaml
packages:
  - "api"
  - "web"
  - "workers"
  - "shared/types"
```

### 4.4 Root `package.json`
```json
{
  "name": "vici2",
  "private": true,
  "version": "0.0.0",
  "packageManager": "pnpm@9.15.0",
  "engines": { "node": ">=20.18.1 <21" },
  "scripts": {
    "prepare": "lefthook install",
    "lint": "eslint .",
    "format": "prettier --write .",
    "format:check": "prettier --check ."
  },
  "devDependencies": {
    "@types/node": "^20.16.0",
    "eslint": "^9.16.0",
    "@eslint/js": "^9.16.0",
    "typescript-eslint": "^8.18.0",
    "eslint-config-prettier": "^9.1.0",
    "globals": "^15.13.0",
    "prettier": "^3.4.2",
    "typescript": "^5.6.3",
    "lefthook": "^1.7.22",
    "@commitlint/cli": "^19.6.0",
    "@commitlint/config-conventional": "^19.6.0"
  }
}
```

### 4.5 `go.work`
```
go 1.22

use ./dialer
```

### 4.6 `.tool-versions`
```
golang 1.22.5
nodejs 20.18.1
pnpm   9.15.0
```

### 4.7 `eslint.config.mjs` (skeleton)
Per-package files extend this via `import baseConfig from "../eslint.config.mjs"`. Includes:
- `@eslint/js` recommended
- `typescript-eslint` recommended
- `eslint-config-prettier` last
- per-package `files` overrides (e.g., web's `*.tsx` allows JSX)

### 4.8 `.prettierrc`
```json
{
  "semi": true,
  "singleQuote": false,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2,
  "useTabs": false,
  "endOfLine": "lf"
}
```

### 4.9 `.golangci.yml` (v2 schema)
- `version: "2"`
- `run.go: "1.22"`, `tests: true`, `timeout: 5m`
- `linters.default: standard` plus `enable: [bodyclose, gosec, gocritic,
  gofumpt, errcheck, govet, staticcheck, unused, ineffassign,
  misspell, nilerr, errorlint]`
- `formatters.enable: [gofumpt, goimports]`
- `issues.exclude-rules` exempts `_test.go` from `gosec` G404 (math/rand
  is fine in tests)

### 4.10 `lefthook.yml`
```yaml
pre-commit:
  parallel: true
  commands:
    go-lint:
      glob: "*.go"
      run: golangci-lint run --new-from-rev HEAD {staged_files}
      stage_fixed: true
    ts-lint:
      glob: "{api,web,workers,shared}/**/*.{ts,tsx,js,mjs}"
      run: pnpm exec eslint --fix {staged_files}
      stage_fixed: true
    prettier:
      glob: "*.{json,yaml,yml,md,prisma}"
      run: pnpm exec prettier --write {staged_files}
      stage_fixed: true
    xmllint:
      glob: "freeswitch/conf/**/*.xml"
      run: xmllint --noout {staged_files}
    gitleaks:
      run: gitleaks protect --staged --redact --no-banner

commit-msg:
  commands:
    commitlint:
      run: pnpm exec commitlint --edit {1}

pre-push:
  commands:
    typecheck-go:
      run: cd dialer && go vet ./...
    typecheck-ts:
      run: pnpm -r exec tsc --noEmit
```

### 4.11 `.editorconfig`
```ini
root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
trim_trailing_whitespace = true
indent_style = space
indent_size = 2

[*.go]
indent_style = tab
indent_size = 4

[Makefile]
indent_style = tab

[*.md]
trim_trailing_whitespace = false
```

### 4.12 `.github/workflows/ci.yml` (stub, O04 owns)
Minimal: matrix Linux runner, `make lint`, `make test`, upload coverage.
Placeholder so downstream doesn't have to wait for O04 to merge to test
their code in CI. `secrets-scan.yml` runs `gitleaks-action@v2` on push +
PR.

### 4.13 `freeswitch/Dockerfile`
Multi-stage. Stage 1 = `FROM debian:bookworm`, install signalwire repo
key with `${SIGNALWIRE_TOKEN}`, `apt install freeswitch-meta-vanilla`.
Stage 2 = `FROM debian:bookworm-slim`, copy `/usr/share/freeswitch`,
`/etc/freeswitch`, `/usr/bin/fs_cli`, `/usr/bin/freeswitch`, plus
runtime deps (`libssl3`, `libsqlite3-0`, etc.). Default UID/GID 499.
`HEALTHCHECK CMD fs_cli -x status | grep -q ^UP`. `EXPOSE` documents
the SPEC.md ports list.

### 4.14 Service Dockerfiles
Each service has a multi-stage Dockerfile with `dev`, `builder`,
`prod` targets:
- `dev`: includes hot-reloader (air for Go, tsx for Node, next for
  web). Mounts source via Compose Watch sync.
- `builder`: full build environment (used by `api-migrate` for `pnpm
  exec prisma migrate deploy`).
- `prod`: distroless or alpine slim with compiled binary / built next
  output. Used by `docker-compose.prod.yml.example`.

---

## 5. Hand-off interfaces (to other modules)

### 5.1 To O01 (Observability)
- Every long-running service exposes `/metrics` on a documented port:
  - api: `:9101`
  - dialer: `:9102`
  - workers: `:9103`
  - freeswitch: TBD (F03 will enable `mod_prometheus` or
    `mod_event_socket` exporter)
- Naming convention `vici2_<subsystem>_<unit>` enforced from F01 by
  base metrics in each service's stub.
- O01 just needs to add a Prometheus scrape config; F01 already opens
  the ports in compose.

### 5.2 To O04 (CI/CD)
- `.github/workflows/ci.yml` stub references `make lint`, `make test`,
  `make build-images` so CI is always in lock-step with local. O04
  evolves the workflow without changing the surface area.
- Versions in `.tool-versions` are the authoritative source — CI's
  `setup-go` / `setup-node` reads them via `actions/setup-go@v5` and
  `pnpm/action-setup@v4` configured to read `.tool-versions` and
  `package.json` `packageManager`.

### 5.3 To F02 (DB schema)
- `api/prisma/schema.prisma` is provisioned with provider + datasource
  only:
  ```
  datasource db { provider = "mysql"; url = env("DATABASE_URL") }
  generator client { provider = "prisma-client-js" }
  ```
- F02 fills models. F02's first migration is `0_init`.
- `make db-migrate`, `db-reset`, `db-seed`, `db-deploy` already wired.

### 5.4 To F03 (FreeSWITCH config)
- Container exists, `network_mode: host` works on Linux, ESL listens on
  :8021, vars.xml minimal stub. F03 writes the full Sofia profiles,
  dialplans, and ACL.
- Volume contract: `./freeswitch/conf:/etc/freeswitch:ro` (templates),
  `freeswitch_recordings:/var/lib/freeswitch/recordings`.

### 5.5 To F04 (Redis schema)
- Redis container running, `redis://redis:6379/0`. F04 writes the
  helper lib and key conventions.

### 5.6 To T01 (ESL bridge)
- ESL host/port + password are in env. Both api (Node) and dialer (Go)
  containers can resolve `host.docker.internal` to reach FS. T01 owns
  the actual ESL client code.

---

## 6. Risks and known gaps

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| Mac WebRTC dev-experience degraded | High | Medium | Document explicitly. Ship `docker-compose.macos.yml`. Recommend Linux for full audio testing. |
| FreeSWITCH 60s start-up lengthens `make dev` | High | Low | `start_period: 60s` in healthcheck. `--wait` flag in `make dev`. Print "FreeSWITCH boots slowly, ~45s" in dev-up.sh. |
| SignalWire token leak | Low | High | `SIGNALWIRE_TOKEN` is build-arg only; not baked into image. gitleaks scans block accidental commit. README warns. |
| pnpm-vs-npm spec drift | Medium | Low | RFC-001 makes the choice explicit. If declined, swap is mechanical. |
| Compose `develop.watch` immature on some Docker installs | Low | Medium | Fallback `make dev-watch-legacy` uses bind-mounts + `nodemon`/`air` only. |
| FS health probe needs ESL password | Low | Low | We pass the same password into healthcheck via `${FS_EVENT_SOCKET_PASSWORD}`. Documented. |
| `host.docker.internal` not resolving on Linux | Medium | Medium | `extra_hosts: ["host.docker.internal:host-gateway"]` is on every service that needs it. Linux Docker 20.10+ supports `host-gateway`. |
| Prisma migrate dev needs interactive shell | Low | Low | `make db-migrate` runs it via `docker compose run --rm api …` which preserves TTY. CI uses `migrate deploy` instead. |
| Volumes orphaned after `make down` | Low | Low | `make down` keeps volumes by design; `make reset` (or `make clean`) calls `down -v`. Clearly distinct in `make help`. |

---

## 7. Test plan

### 7.1 Smoke (`scripts/smoke.sh`, also called by `make test`)
Implements F01.md verification §1–10 in one script. Each step exits
non-zero on failure. Also runs in CI as a job.

```
1. docker compose ps | grep vici2_mysql        | grep healthy
2. docker compose ps | grep vici2_redis        | grep healthy
3. docker compose ps | grep vici2_freeswitch   | grep healthy
4. curl -fsS http://localhost:3000/health      | jq -e '.status=="ok"'
5. curl -fsS http://localhost:9101/metrics     | grep -q vici2_api_
6. curl -fsS http://localhost:9102/metrics     | grep -q vici2_dialer_
7. curl -fsS http://localhost:9103/metrics     | grep -q vici2_workers_
8. mysql -h 127.0.0.1 -uvici2 -p$… -e 'SELECT 1' vici2
9. redis-cli -h 127.0.0.1 -p 6379 PING
10. fs_cli -H 127.0.0.1 -P 8021 -p $FS_EVENT_SOCKET_PASSWORD -x status | grep ^UP
```

### 7.2 Hot-reload manual check
- Edit `api/src/server.ts`'s health response body, save, watch logs.
  Container should sync + restart in <3s.
- Same for `dialer/cmd/dialer/main.go` (Air rebuild).
- Same for `web/src/app/page.tsx` (Next HMR).

### 7.3 Unit tests
N/A in F01 (no business logic). The stub services have one trivial
test each (`/health` returns 200) so coverage tooling is wired.

### 7.4 Tear-down checks
- `make down` → no containers running (`docker ps -aq | wc -l == 0`).
- `make reset` → no volumes (`docker volume ls -q | grep vici2 | wc -l
  == 0`).

---

## 8. Acceptance criteria (from F01.md, restated)

- [ ] `make dev` from a clean clone brings up all services in <120s
      (warm Docker cache).
- [ ] All 10 verification steps pass via `make smoke`.
- [ ] Each Dockerfile produces an image <500 MB except `freeswitch`
      (vanilla meta + sounds = ~800 MB; documented).
- [ ] `.env.example` has zero secrets, every var commented.
- [ ] README has a 5-minute quick-start.
- [ ] `.github/workflows/ci.yml` stub exists.
- [ ] `make down` leaves zero dangling containers; `make reset` leaves
      zero volumes.

---

## 9. RFC-worthy ambiguities

### 9.1 RFC-001 — pnpm vs npm workspaces
F01.md lists "package.json # workspace root, npm workspaces" in its
Implementation phase file list. SPEC.md §2 doesn't pin npm. Industry
2026 default is pnpm; performance and isolation gains are real.
**This PLAN proposes pnpm.** RFC-001 stub is created at
`spec/rfc/RFC-001-pnpm-vs-npm-workspaces.md`. Awaiting decision.

### 9.2 Other ambiguities flagged but not RFC-worthy
- **Turborepo introduction**: deferred to a future O04 decision when
  CI build time crosses a threshold. No RFC needed now.
- **Biome adoption**: same as above; defer.
- **FS image build via Docker secret vs build-arg**: build-arg is
  simpler and the token is per-developer; Docker secrets add ceremony
  for negligible win in dev. PLAN goes with build-arg. If
  security-baseline (O05) disagrees later, RFC-002 will follow.
- **macOS as a first-class dev target**: PLAN treats it as
  "best-effort, document the gaps." If the team decides Mac must
  reach Linux parity, that's a multi-week rework (rtpengine + bridge
  network + STUN) — out of F01 scope.

---

## 10. File list to be created in IMPLEMENT

The full list under §2 above. To summarize, ~60 files, mostly small
(<200 lines each). The Makefile and docker-compose.yml are the two
load-bearing files; everything else is convention plumbing.

End of PLAN.md.
