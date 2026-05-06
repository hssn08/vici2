# F01 — Repo Skeleton + Dev Environment — RESEARCH

**Module:** F01 (Foundation, Phase 1)
**Author:** F01 sub-agent
**Date:** 2026-05-06
**Sources:** Exa web search, Ref docs, Context7, GitHub code search.

This document collects the evidence behind F01's PLAN. Citations are inline.
PLAN.md turns these findings into concrete tool/version/layout decisions.

---

## 1. Goal of F01 (recap)

`make dev` from a clean clone brings up MySQL 8 + Redis 7 + FreeSWITCH 1.10 +
stub `api`, `dialer`, `workers`, `web` services together. F01 produces zero
business logic — only the platform every other module sits on. Every other
module is blocked on F01 (per SPEC.md §5).

The repo layout is **immutable** per SPEC.md §2: F01 must match it exactly
(the spec dictates `api/`, `dialer/`, `workers/`, `web/`, `freeswitch/`,
`shared/{proto,events,openapi}`, `kamailio/`, `rtpengine/`, `scripts/`,
`spec/`, `db/`-equivalent under `api/prisma/`, `.github/workflows/`).

---

## 2. Go workspaces (`go.work`) for the dialer

We have one Go service today (`dialer/`) but plan for a second (E06 janitor
could be split, the ESL bridge in T01 ships shared Go code). The decision is
whether the dialer should be a single module, or whether to plan for a
multi-module workspace from day 1.

### 2.1 Findings
- Go 1.22 added stable workspace tooling; `go work init`, `go work use`,
  `go work sync`, `go work vendor` all GA. `go.work` files declare which
  module directories form the workspace and replaces tedious `replace`
  directives in individual `go.mod` files.
  [go.dev/doc/go1.22](https://go.dev/doc/go1.22),
  [pkg.go.dev/cmd/go/internal/workcmd](https://pkg.go.dev/cmd/go/internal/workcmd@go1.26.0).
- Real-world experience: Kubernetes adopted workspaces to replace its
  symlink-and-fake-GOPATH hacks; the migration produced a simpler, faster
  build. The lesson is that workspaces are now the default for any Go
  monorepo that ships >1 module.
  [kubernetes.dev/blog/2024/03/19/go-workspaces-in-kubernetes](https://kubernetes.dev/blog/2024/03/19/go-workspaces-in-kubernetes).
- Practical primer: workspaces let you edit `lib` and have those changes
  immediately reflected in `api` without bumping versions or pushing to a
  registry.
  [andrefelizardo.dev — Optimizing Monorepo development with Go Workspaces](https://andrefelizardo.dev/optimizing-monorepo-development-with-go-workspaces).
- Go 1.23 added the `godebug` directive to `go.work`, useful for forcing
  back-compat behaviour across the workspace.
  [go.dev/doc/go1.23](https://go.dev/doc/go1.23).

### 2.2 Decision shape (deferred to PLAN)
Use `go.work` from day 1 with one `use ./dialer` entry; this is free
insurance for when T01/E06 split out a `dialer/internal/eslshared` module
or a `dialer/cmd/janitor` companion binary later. `go.work` is committed,
`go.work.sum` follows the stdlib recommendation and is committed too.
Single `go.mod` lives at `dialer/go.mod`.

---

## 3. Workspace manager for the TS services (api, web, workers, shared)

We have three TypeScript services (`api`, `web`, `workers`) plus a fourth
`shared/` directory that holds OpenAPI types, JSON-Schema event contracts,
and probably a small TS package for shared error types. Picking the right
workspace tool is a load-bearing decision.

### 3.1 Findings
- pnpm workspaces is the 2026 default for JS monorepos. Strict isolation
  (no phantom dependencies), `workspace:*` protocol, fast installs (~3×
  npm), and content-addressable global store. Turborepo, Nx, Vite, Vue,
  Nuxt, Next.js templates all default to it.
  [pkgpulse.com — Best npm Workspaces Alternatives 2026](https://www.pkgpulse.com/blog/best-npm-workspaces-alternatives-2026),
  [pkgpulse.com — How to Choose Between npm, pnpm, and Yarn in 2026](https://www.pkgpulse.com/blog/how-to-choose-npm-pnpm-yarn-2026),
  [palakorn.com — Monorepo Strategy in 2026](https://palakorn.com/blog/monorepo-strategy-pnpm-turbo-nx/).
- Turborepo: a task runner layered on top of pnpm. Adds local + remote
  cache, affected-only runs, dependency-graph orchestration. Recommended
  for "small to medium" repos (under ~20 packages). `pnpm + Turborepo` is
  the most common 2026 pairing for Next.js projects.
  [pkgpulse.com — How to Set Up a Monorepo with Turborepo in 2026](https://www.pkgpulse.com/blog/how-to-set-up-monorepo-turborepo-2026),
  [hunchbite.com — Setting Up a Next.js Monorepo with Turborepo](https://hunchbite.com/guides/turborepo-nextjs-monorepo-setup).
- Nx: a heavier alternative — generators, project tags, enforced module
  boundaries. "Teams that adopt Nx halfway often wish they'd stuck with
  Turborepo."
  [palakorn.com](https://palakorn.com/blog/monorepo-strategy-pnpm-turbo-nx/).
- Moon: a polyglot alternative with first-class support for Go, Rust,
  Python alongside JS. Worth knowing about; less mature ecosystem.
  [palakorn.com](https://palakorn.com/blog/monorepo-strategy-pnpm-turbo-nx/).
- npm workspaces: works for tiny repos but has no graph filtering,
  permits phantom dependencies, ~3× slower installs.
  [pkgpulse.com](https://www.pkgpulse.com/blog/best-npm-workspaces-alternatives-2026).
- The F01.md spec mentions "npm workspaces" in the implementation phase.
  This is the spec ambiguity to flag — the field has moved to pnpm since
  the spec was drafted, and the SPEC.md proper does not pin npm. RFC may
  be needed.

### 3.2 Decision shape (deferred to PLAN)
**pnpm workspaces** for the JS layer; **no Turborepo in F01** (start
without a task runner per palakorn.com guidance — "you can always add
Turborepo or Nx later; you can't easily undo a ten-package Nx setup you
didn't need"). Turbo can be added in O04 (CI/CD) when CI build times
warrant it. The Makefile is the orchestrator for now.

If the orchestrator prefers npm workspaces strictly per F01.md text, that
is acceptable; the cost is slower installs and a phantom-dep risk. PLAN
flags this as RFC-worthy.

---

## 4. Tool version pinning

We need every dev to have the same Go, Node, pnpm versions. Three options.

### 4.1 Findings
- **mise** (formerly rtx). Rust-based, asdf-plugin-compatible, reads
  `.tool-versions` (asdf-style) or `mise.toml`. PATH-based activation
  (no shim overhead, unlike asdf). 10–100× faster than asdf. Supports
  fuzzy versions (`node = "22"` → latest 22.x), parallel installs,
  per-directory env vars, built-in tasks.
  [mise.jdx.dev](https://mise.jdx.dev/dev-tools/),
  [devtoolsguide.com — Runtime Version Managers](https://www.devtoolsguide.com/version-managers-guide),
  [logrocket.com — mise vs asdf](https://blog.logrocket.com/mise-vs-asdf-javascript-project-environment-management/).
- **asdf**. The original. Bash-shim based (~30–50ms overhead per command,
  noticeable in tight loops). Mature plugin ecosystem.
  [logrocket.com](https://blog.logrocket.com/mise-vs-asdf-javascript-project-environment-management/).
- **`.tool-versions`** alone (no manager): just a file convention. Both
  asdf and mise read it. We can ship `.tool-versions` and let the dev
  pick mise or asdf. This is the lowest-friction path.
- **Nix devshell / devenv**. Maximal reproducibility but high learning
  curve, painful on macOS/Windows for telephony stacks. NixOS forum
  reports that mise + Nix interact poorly because mise's compile path
  expects build deps the dev shell may not provide.
  [discourse.nixos.org — Soft-migrating off mise](https://discourse.nixos.org/t/soft-migrating-off-mise-tool-versions/46859),
  [cecg.io — mise vs nix-shell](https://www.cecg.io/blog/nix-shell-vs-mise).

### 4.2 Decision shape (deferred to PLAN)
Ship a checked-in `.tool-versions` file (asdf format). Document mise as
the recommended runner. Don't require it — anyone can install Go/Node by
hand and the file is just a reference. Pin: `golang 1.22.5`,
`nodejs 20.18.1`, `pnpm 9.15.0` (latest stable at time of writing the
plan; PLAN.md confirms exact patch versions).

---

## 5. FreeSWITCH 1.10 in Docker for dev

### 5.1 Findings
- Official SignalWire image: `signalwire/freeswitch`. Built from
  `docker/master/Dockerfile` in the public repo. Requires a SignalWire
  personal access token to pull from `freeswitch.signalwire.com` (free,
  but requires login). Health-checks via `fs_cli -x status`. Designed
  for `--network host`. Exposes 5060/5061/5066/5080/5081/7443/8021 + RTP
  16384–32768 + 64535–65535. Default UID/GID 499.
  [github.com/signalwire/freeswitch/tree/master/docker](https://github.com/signalwire/freeswitch/tree/master/docker),
  [github.com/signalwire/freeswitch v1.10.12](https://github.com/signalwire/freeswitch/releases/tag/v1.10.12),
  [signalwire/freeswitch/docker/master/Dockerfile](https://github.com/signalwire/freeswitch/blob/master/docker/master/Dockerfile).
- Latest official tag (Aug 2024): **v1.10.12**.
- Community image `dheaps/freeswitch` on Docker Hub follows the same
  Dockerfile and is auto-built; uses the same SignalWire token mechanism
  but adds CI/CD niceties and bumps Busybox.
  [signalwire/freeswitch PR #2378](https://github.com/signalwire/freeswitch/pull/2378).
- Drachtio's `drachtio/drachtio-freeswitch-mrf` image is a heavily
  customized build for jambonz/voice-bot workloads — has many extra
  modules (gRPC, AWS SDK, Houndify, ONNX). **Out of scope for vici2** —
  too heavy and pinned to v1.10.10/v1.10.11. We only want `mod_avmd`,
  `mod_callcenter`, etc., which the vanilla meta-package already
  includes.
  [github.com/drachtio/docker-drachtio-freeswitch-mrf](https://github.com/drachtio/docker-drachtio-freeswitch-mrf).
- Compose patterns from real telephony repos confirm
  `network_mode: host` is the recommended dev setup and `cap_add:
  SYS_NICE` (and sometimes `IPC_LOCK`, `NET_ADMIN`) is common to allow
  RT scheduling:
  - `Otoru/Genesis` uses `network_mode: host` + `cap_add: IPC_LOCK,
    NET_ADMIN, NET_RAW` + `ulimits.rtprio: 99`.
  - `os11k/freeswitch-docker-compose` uses `network_mode: host` +
    `restart: always` + volume mount of conf.
  - `PatrickBaus/freeswitch-docker` uses `network_mode: host` +
    `cap_add: SYS_NICE`.
- WebRTC in docker requires correct `ext-rtp-ip` / `ext-sip-ip` so SDP
  advertises the host's reachable IP, not a docker bridge IP. Without
  host networking, RTP fails because container ports 16384–32768 aren't
  routable.
  [developer.signalwire.com — WebRTC](https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Configuration/WebRTC_3375381/),
  [developer.signalwire.com — NAT Traversal](https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Networking/NAT-Traversal_3375417/).
- macOS gotcha: Docker Desktop's "host network" mode is a beta with
  limitations (no IPv6, only TCP/UDP). RTP works only in recent
  versions and only after enabling the experimental flag. F01.md
  already calls this out as a known risk.

### 5.2 Decision shape (deferred to PLAN)
- Build our own `freeswitch/Dockerfile` based on the
  signalwire/freeswitch master Dockerfile, **pinned to v1.10.12** and
  the `freeswitch-meta-vanilla` package (we don't need the full
  ~600 MB sound packs in dev). The token is a build secret read from
  `SIGNALWIRE_TOKEN` env var; documented in `.env.example`.
- `network_mode: host` for FS service in compose. `cap_add: [SYS_NICE]`.
- macOS: document a fallback compose override that uses bridge mode
  with explicit port maps for SIP UDP/TCP and a reduced RTP range
  (16384–16484 = 100 ports — enough for ≤25 concurrent dev calls).
  Document the audio-quality caveat.
- Healthcheck: `fs_cli -x status | grep -q ^UP`.

---

## 6. docker-compose.dev.yml patterns

### 6.1 Findings
- `depends_on` with `condition: service_healthy` is the right way to
  enforce ordered startup. Use `service_started` only when the
  dependency has no meaningful health probe.
  [docs.docker.com — Control startup and shutdown order](https://docs.docker.com/compose/how-tos/startup-order),
  [last9.io — Docker Compose Health Checks](https://last9.io/blog/docker-compose-health-checks),
  [lours.me — Compose Tip #3](https://lours.me/posts/compose-tip-003-depends-on-healthcheck).
- Standard healthcheck commands (verified across multiple sources):
  - MySQL 8: `mysqladmin ping -h localhost -u$MYSQL_USER -p$MYSQL_PASSWORD`
  - Redis 7: `redis-cli ping`
  - FS 1.10: `fs_cli -x status | grep -q ^UP`
  - HTTP: `curl -fsS http://localhost:PORT/health`
- `start_period` (10–30s) is essential for slow starters like MySQL and
  FreeSWITCH so initial flaky checks don't trip the retry counter.
- `condition: service_completed_successfully` is the right choice for
  one-shot migration containers. We'll use this for an `api-migrate`
  service that runs `prisma migrate deploy` then exits 0, blocking the
  long-running `api` and `workers` services.
- `develop.watch` (Compose v2.22+) gives `sync` (instant) +
  `sync+restart` + `rebuild` actions for hot-reload without bind-mount
  weirdness. `WATCHPACK_POLLING=true` is required for Next.js in
  Docker Desktop. `CHOKIDAR_USEPOLLING=true` is required for Vite/Webpack
  watchers.
  [docs.docker.com — Use containers for Next.js development](https://docs.docker.com/guides/nextjs/develop/),
  [antlatt.com — Docker Compose Watch](https://www.antlatt.com/blog/docker-compose-watch-development).
- Air for Go hot-reload pairs naturally with Compose Watch: Watch syncs
  `.go` files, Air rebuilds & restarts the binary inside the container.
  [orxanahmedov.com — Go + Docker Compose + Air](https://www.orxanahmedov.com/blog/go-development-environment-with-docker-compose-and-air),
  [antlatt.com](https://www.antlatt.com/blog/docker-compose-watch-development).

### 6.2 Decision shape (deferred to PLAN)
- One `docker-compose.yml` (default = dev) with a `develop.watch` block
  on each app service.
- A `docker-compose.macos.yml` override that switches FS to bridge mode
  for Mac users.
- A `docker-compose.prod.yml.example` with the same services minus
  `watch`/bind-mounts/dev volumes; production-deployment is O04's
  problem, but we ship the example.
- Networks: a single `vici2_default` bridge for app services; FS uses
  `network_mode: host`. We will need `extra_hosts:
  ["host.docker.internal:host-gateway"]` on api/dialer to talk to FS via
  ESL on host.

---

## 7. Linters

### 7.1 Go
- `golangci-lint` v2 (current line) is the de facto Go meta-linter.
  Config: `.golangci.yml` at repo root. Migration command (`migrate`)
  exists for v1→v2. The `run.go: '1.22'` field pins the language
  version assumption. `tests: false` excluded by default; we'll override
  to lint tests too.
  [golangci-lint.run/docs/configuration/file](https://golangci-lint.run/docs/configuration/file),
  [golangci-lint.run/docs/product/migration-guide](https://golangci-lint.run/docs/product/migration-guide).
- Default linter set (`linters.default: standard`) is a good baseline.
  We'll add: `errcheck`, `govet`, `staticcheck`, `gosimple`, `ineffassign`,
  `unused`, `goimports` (formatter), `gofumpt` (stricter gofmt),
  `bodyclose`, `gosec`, `gocritic`. Avoid: `gomnd` (too noisy in
  telephony numeric constants), `wsl`/`wrapcheck` (style debates).

### 7.2 TypeScript
- ESLint 9 flat config (`eslint.config.mjs`) is mandatory; `.eslintrc.*`
  is deprecated and ignored. Use `typescript-eslint` v8 (single package,
  flat-config-aware). Place `eslint-config-prettier` last.
  [knowledgelib.io — ESLint + Prettier Configuration Reference](https://knowledgelib.io/software/devops/eslint-prettier-config/2026),
  [codewithseb.com — Advanced Linting & Type Safety](https://codewithseb.com/blog/advanced-linting-type-safety-eslint-typescript-guide).
- Biome (Rust, 50× faster) is increasingly viable but its
  `react-hooks/exhaustive-deps` equivalent is missing as of v2.4 and
  Next.js / testing-library plugins aren't supported. Recommendation:
  start with ESLint + Prettier; consider swapping Prettier for Biome's
  formatter only as a future micro-optimization.
  [pkgpulse.com — Biome vs ESLint + Prettier 2026](https://www.pkgpulse.com/blog/biome-vs-eslint-prettier-2026),
  [devtoolsguide.com — Linting and Formatting](https://www.devtoolsguide.com/linting-and-formatting/).
- Prettier 3.x for formatting; one root `.prettierrc` shared across
  api/web/workers via the workspace.

### 7.3 Other
- `xmllint --noout` for FreeSWITCH XML configs (called from CI; cheap
  enough to also be a pre-commit step).
- `prettier` covers JSON, YAML, Markdown.

---

## 8. Pre-commit hooks

### 8.1 Findings
- **lefthook** is a Go binary, single config (`lefthook.yml`),
  parallel-by-default, supports per-language `root` directories with
  glob filters, has built-in `{staged_files}` (no separate lint-staged),
  `stage_fixed: true` re-stages auto-fixed files, ~2× faster than
  Husky+lint-staged.
  [devtoolsguide.com — Git Hooks and Pre-commit Tools](https://devtoolsguide.com/git-hooks-and-precommit/),
  [andymadge.com — Git Hook Frameworks Comparison](https://www.andymadge.com/2026/03/10/git-hooks-comparison/),
  [0xdc.me — pre-commit and lefthook](https://0xdc.me/blog/git-hooks-management-with-pre-commit-and-lefthook/).
- **pre-commit framework** (Python) has the largest community-hook
  catalogue (gitleaks, shellcheck, terraform-fmt, etc. all packaged) and
  isolates env per hook. Slower (sequential by default) but its
  ecosystem is unmatched.
  [andymadge.com](https://www.andymadge.com/2026/03/10/git-hooks-comparison/).
- **husky+lint-staged** is the JS-native default but contaminates a
  polyglot repo with npm infra and is slower than lefthook.
  [andymadge.com](https://www.andymadge.com/2026/03/10/git-hooks-comparison/).
- gitleaks integrates with both pre-commit (`zricethezav/gitleaks`) and
  lefthook (call binary directly). 700+ regex rules; detects AWS keys,
  Stripe keys, GitHub tokens, etc. Recommended on every commit.
  [github.com/gitleaks/gitleaks/.pre-commit-hooks.yaml](https://github.com/gitleaks/gitleaks/blob/master/.pre-commit-hooks.yaml),
  [rafter.so — Pre-Commit Hooks for Secret Detection](https://rafter.so/blog/secrets/pre-commit-hooks-secret-detection),
  [securecodehq.com — Prevent Secret Leaks](https://securecodehq.com/en/blog/git-secrets-prevent-leaks).

### 8.2 Decision shape (deferred to PLAN)
**lefthook** for the polyglot reality of vici2 (Go + TS + XML + SQL).
Run in parallel:
- `golangci-lint run {staged_files}` for `*.go`
- `eslint --fix {staged_files}` for `*.{ts,tsx,js}`
- `prettier --write {staged_files}` for `*.{json,yaml,yml,md}`
- `xmllint --noout {staged_files}` for `*.xml`
- `gitleaks protect --staged --redact` for everything
- `commitlint` (commit-msg hook) to enforce Conventional Commits per
  SPEC.md §3.2

---

## 9. Build / orchestration: Make vs justfile vs Taskfile

### 9.1 Findings
- F01.md spec says `Makefile`. SPEC.md §2 also says `Makefile`. So this
  is decided — but I researched alternatives anyway because justfile
  and Taskfile are tempting.
- **Make** pros: ubiquitous on Linux/macOS, zero install, every senior
  dev knows it. Cons: tab/space gotchas, BSD-vs-GNU portability quirks,
  `$$` confusion.
- **just**: prettier syntax, cross-platform, but requires install.
- **Taskfile.dev**: YAML, cross-platform, has parallel + checksum
  dependency tracking. The most modern.
  [makerstack.co/reviews/task-runner-review](https://makerstack.co/reviews/task-runner-review/),
  [appliedgo.net/spotlight/just-make-a-task](https://appliedgo.net/spotlight/just-make-a-task/),
  [blog.bariskode.com — Makefile vs Justfile vs Taskfile](https://blog.bariskode.com/blog/makefile-vs-justfile-vs-taskfile-linux-shell-automation-comparison/),
  [sachith.co.uk — Makefiles/Taskfiles for common workflows](https://www.sachith.co.uk/makefiles-taskfiles-for-common-workflows-architecture-trade%E2%80%91offs-practical-guide-feb-24-2026/).

### 9.2 Decision
Stay with **Make** per spec. It's the lowest-friction baseline and the
zero-install benefit matters in CI. The Makefile delegates real work to
small bash scripts in `scripts/` so portability bugs are confined.

---

## 10. Hot reload per language

### 10.1 Findings
- Go: **air** (now `air-verse/air`). Watches files, rebuilds, restarts.
  Standard pairing with Compose Watch.
  [orxanahmedov.com](https://www.orxanahmedov.com/blog/go-development-environment-with-docker-compose-and-air),
  [antlatt.com](https://www.antlatt.com/blog/docker-compose-watch-development).
- Node (api, workers): **tsx watch** (which uses esbuild under the hood,
  fast cold start, type-checking off — `tsc --noEmit` in CI catches type
  errors). Avoid the experimental Node 22 `--watch` flag for now per
  antlatt.com — unreliable with Compose sync.
- Web: Next.js dev server has built-in HMR; needs `WATCHPACK_POLLING=1`
  inside Docker.

### 10.2 Decision shape
- `dialer/.air.toml` checked in.
- `api/`, `workers/` use `tsx watch src/server.ts` / `src/index.ts`.
- `web/` uses `next dev`.

---

## 11. Metrics + observability hooks (for O01)

### 11.1 Findings
- Go: `prometheus/client_golang` is the standard. Expose `/metrics` via
  `promhttp.HandlerFor(reg, ...)` on a separate port from app traffic.
  Default Go collector + custom counters.
  [prometheus.io/docs/guides/go-application](https://prometheus.io/docs/guides/go-application/),
  [github.com/prometheus/client_golang](https://github.com/prometheus/client_golang).
- Node Fastify: `fastify-metrics` plugin (wraps `prom-client`) exposes
  `/metrics` with default Node + per-route timing histograms.
  [github.com/SkeLLLa/fastify-metrics](https://github.com/SkeLLLa/fastify-metrics/blob/master/README.md).

### 11.2 Decision shape
F01 wires the **plumbing** so O01 can drop in Grafana + dashboards
without touching service code:
- dialer stub exposes `/metrics` on `:9102`, gRPC stays on `:7000`.
- api stub exposes `/metrics` on `:9101` via `fastify-metrics`.
- workers stub exposes `/metrics` on `:9103` via `prom-client` HTTP
  handler.
- Each service emits the SPEC.md §3.6 base metrics: process up-time,
  memory, GC pauses, error counts.

Names follow `vici2_<subsystem>_<unit>` (e.g.
`vici2_dialer_originate_total`). F01 doesn't define dialer metrics yet
(that's E02/E03/E05), but the registry is in place.

---

## 12. Env-file convention

### 12.1 Findings
- **Go**: `godotenv.Load()` reads `.env` into `os.Getenv`. Supports
  multi-file precedence (`.env.${ENV}.local` → `.env.local` →
  `.env.${ENV}` → `.env`). `godotenv/autoload` for a one-line import.
  [github.com/godotenv/godotenv](https://github.com/godotenv/godotenv).
- **Node**: `dotenv-flow` mirrors the same cascade (`.env.local` →
  `.env.${NODE_ENV}` → `.env.${NODE_ENV}.local`). Built into Next.js
  natively (no package needed).
  [github.com/kerimdzhanov/dotenv-flow](https://github.com/kerimdzhanov/dotenv-flow),
  [unblockdevs.com — Manage Multiple .env Files](https://unblockdevs.com/blog/manage-multiple-env-files-nodejs-development-staging-production).
- **Prisma**: reads `./.env` and `./prisma/.env` automatically. Multiple
  envs via `dotenv-cli -e .env.test -- prisma migrate dev`.
  [prisma.io/docs — Managing Prisma ORM environment variables](https://www.prisma.io/docs/guides/development-environment/environment-variables).

### 12.2 Decision shape
- One `.env.example` at repo root, exhaustively documented (every var
  has a comment, units, default).
- `.env` is git-ignored and is what `make dev` reads.
- Per SPEC.md §3.7: dev uses `.env`; prod uses host env or Docker
  secrets; DB-stored creds are app-encrypted.
- Compose loads `.env` automatically (Compose's native behaviour).
- Inside services: Go uses `godotenv.Load()` only if `os.Getenv("ENV")
  != "prod"`; Node uses `dotenv-flow/config` preload in dev only;
  Next.js handles its own.

---

## 13. EditorConfig + .gitignore

### 13.1 Findings
- `.editorconfig` with `root = true` at repo root. Sections by glob
  override defaults. Closer files take precedence.
  [editorconfig.org](https://editorconfig.org/),
  [docs.editorconfig.org](https://docs.editorconfig.org/en/master/editorconfig-format.html).
- Standard sections we'll ship: `[*]` (utf-8, lf, trim trailing
  whitespace, final newline, indent 2 spaces); `[*.go]` (tabs);
  `[*.{md,xml}]` (no trim trailing for md, indent 2 for xml).

### 13.2 Decision shape
Single root `.editorconfig`. No per-package overrides. `.gitignore`
covers Go (`bin/`, `*.test`, `coverage.*`), Node (`node_modules/`,
`.next/`, `dist/`, `coverage/`, `.turbo/`), IDE (`.idea/`, `.vscode/`
except shared settings), env (`.env`, `.env.*` minus `.env.example`),
docker volumes, FS recordings (`freeswitch/recordings/`,
`freeswitch/log/`, `freeswitch/db/`).

---

## 14. Real-world example monorepos checked via grep search

`mcp__grep__searchGitHub` queries:
- `freeswitch` in `docker-compose.yml`: returns `custompbx/custompbx`,
  `somleng/somleng-switch`, `theNetworkChuck/claude-phone`,
  `Otoru/Genesis`, `OpenSIPS/opensips-softswitch-ce`,
  `os11k/freeswitch-docker-compose`, `PatrickBaus/freeswitch-docker`,
  `rts-cn/xswitch-free`, `ywst-cc/ywcc`. Common patterns: `network_mode:
  host`, `cap_add: SYS_NICE`, mount `./conf` to `/etc/freeswitch`,
  separate volume for recordings, separate logs volume.
- `go.work pnpm-workspace.yaml docker-compose.yml`: no exact matches —
  this combination is rare enough in public OSS that we will be
  pioneering the layout. The closest comparator is the somleng-switch
  repo (Rails + FS) and custompbx (Go + FS, but no JS workspace).

Implication: vici2's **Go + Node + Next.js + FS** monorepo doesn't have
a published reference. We will create the reference. Each tool choice
above has independent, well-supported precedent; the combination is
novel.

---

## 15. Open questions for PLAN / RFC

1. **pnpm vs npm workspaces**: F01.md text says npm; SPEC.md §2 doesn't
   pin. Recommendation: pnpm. Needs RFC if F01.md text is
   binding — see RFC-001 stub in spec/rfc/.
2. **Turborepo now or later**: not in F01. Add when CI builds slow
   down. Not RFC-worthy; a future O04 decision.
3. **mise required or optional**: optional; `.tool-versions` is the
   contract.
4. **FreeSWITCH meta package**: `freeswitch-meta-vanilla` (smaller) vs
   `freeswitch-meta-all` (everything). Recommend vanilla; T03/F03 add
   any missing modules via `modules.conf.xml`.
5. **macOS support depth**: F01 ships a documented degraded-mode
   compose override; we don't claim full WebRTC parity on Mac.
6. **Go version**: SPEC.md says 1.22+. Pin 1.22.5 (the latest 1.22
   patch with security fixes) and let mise manage upgrades to 1.23+
   later via separate decision.

---

## 16. Citations index (count: 30+)

1. https://go.dev/doc/go1.22
2. https://go.dev/doc/go1.23
3. https://pkg.go.dev/cmd/go/internal/workcmd@go1.26.0
4. https://kubernetes.dev/blog/2024/03/19/go-workspaces-in-kubernetes
5. https://andrefelizardo.dev/optimizing-monorepo-development-with-go-workspaces
6. https://www.pkgpulse.com/blog/best-npm-workspaces-alternatives-2026
7. https://www.pkgpulse.com/blog/how-to-choose-npm-pnpm-yarn-2026
8. https://palakorn.com/blog/monorepo-strategy-pnpm-turbo-nx/
9. https://www.pkgpulse.com/blog/how-to-set-up-monorepo-turborepo-2026
10. https://hunchbite.com/guides/turborepo-nextjs-monorepo-setup
11. https://www.devtoolsguide.com/monorepo-tools/
12. https://mise.jdx.dev/dev-tools/
13. https://www.devtoolsguide.com/version-managers-guide
14. https://blog.logrocket.com/mise-vs-asdf-javascript-project-environment-management/
15. https://www.cecg.io/blog/nix-shell-vs-mise
16. https://github.com/signalwire/freeswitch/tree/master/docker
17. https://github.com/signalwire/freeswitch/blob/master/docker/master/Dockerfile
18. https://github.com/signalwire/freeswitch/releases/tag/v1.10.12
19. https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Configuration/WebRTC_3375381/
20. https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Networking/NAT-Traversal_3375417/
21. https://docs.docker.com/compose/how-tos/startup-order
22. https://docs.docker.com/guides/nextjs/develop/
23. https://www.antlatt.com/blog/docker-compose-watch-development
24. https://www.orxanahmedov.com/blog/go-development-environment-with-docker-compose-and-air
25. https://golangci-lint.run/docs/configuration/file
26. https://golangci-lint.run/docs/product/migration-guide
27. https://www.pkgpulse.com/blog/biome-vs-eslint-prettier-2026
28. https://knowledgelib.io/software/devops/eslint-prettier-config/2026
29. https://devtoolsguide.com/git-hooks-and-precommit/
30. https://www.andymadge.com/2026/03/10/git-hooks-comparison/
31. https://0xdc.me/blog/git-hooks-management-with-pre-commit-and-lefthook/
32. https://github.com/gitleaks/gitleaks/blob/master/.pre-commit-hooks.yaml
33. https://rafter.so/blog/secrets/pre-commit-hooks-secret-detection
34. https://prometheus.io/docs/guides/go-application/
35. https://github.com/SkeLLLa/fastify-metrics/blob/master/README.md
36. https://github.com/godotenv/godotenv
37. https://github.com/kerimdzhanov/dotenv-flow
38. https://www.prisma.io/docs/guides/development-environment/environment-variables
39. https://editorconfig.org/
40. https://lours.me/posts/compose-tip-003-depends-on-healthcheck
41. https://last9.io/blog/docker-compose-health-checks
42. (grep search) github code search across freeswitch docker-compose files
43. https://makerstack.co/reviews/task-runner-review/
44. https://blog.bariskode.com/blog/makefile-vs-justfile-vs-taskfile-linux-shell-automation-comparison/

End of RESEARCH.md.
