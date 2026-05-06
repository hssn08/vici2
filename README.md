# vici2

Open-source Vicidial alternative built on **FreeSWITCH 1.10 + MySQL 8 + BYOC SIP**.
See [`DESIGN.md`](./DESIGN.md) for architecture and [`SPEC.md`](./SPEC.md) for the
master implementation spec.

> **Status:** Foundation phase. Many modules still pending. See
> [`spec/modules/`](./spec/modules/) for per-module specs.

## Quick start (5 minutes)

Prereqs:

- Docker Engine 24+ with the compose plugin v2.24+
- (Optional but recommended) [`mise`](https://mise.jdx.dev/) or
  [`asdf`](https://asdf-vm.com/) — the repo ships a `.tool-versions` file
  pinning Go 1.22.5, Node 20.18.1, pnpm 9.15.0
- A `SIGNALWIRE_TOKEN` if you want to build the FreeSWITCH image
  (free signup at https://signalwire.com — required to pull
  `freeswitch-meta-vanilla` Debian packages)

```bash
git clone <repo> vici2
cd vici2

# 1. Copy env template; set SIGNALWIRE_TOKEN inside.
cp .env.example .env
$EDITOR .env

# 2. Install JS deps (uses pnpm 9 workspaces).
pnpm install

# 3. Bring up the dev stack.
make dev

# 4. Verify everything came up.
make smoke
```

What `make dev` starts:

| Service     | Container         | Host port(s)             |
| ----------- | ----------------- | ------------------------ |
| mysql       | vici2_mysql       | `3306`                   |
| redis       | vici2_redis       | `6379`                   |
| freeswitch  | vici2_freeswitch  | host network (Linux)     |
| api         | vici2_api         | `3000` (HTTP), `9101` (metrics) |
| dialer      | vici2_dialer      | `9102` (metrics), `7000` (gRPC) |
| workers     | vici2_workers     | `9103` (metrics)         |
| web         | vici2_web         | `4000` (Next.js)         |

Open <http://localhost:4000> for the web UI stub.

### macOS users

Docker Desktop on macOS does NOT support true `host` networking. The repo ships
a `docker-compose.macos.yml` overlay that switches FreeSWITCH to bridge mode +
explicit port maps. The Makefile auto-detects macOS. WebRTC media works at small
scale; for full-volume audio testing use a Linux dev box.

## Daily-driver commands

```bash
make help                    # list everything
make dev-watch               # foreground; hot reload via Compose Watch
make dev-down                # stop everything (preserves volumes)
make logs                    # tail all logs
make logs-fs                 # tail freeswitch only
make smoke                   # poke /metrics + /health endpoints
make lint                    # eslint + prettier + golangci-lint + xmllint
make test                    # all unit tests
make db-migrate              # prisma migrate dev (after F02 lands)
make fs-cli                  # drop into FreeSWITCH CLI
make redis-cli               # drop into redis-cli
make mysql-cli               # drop into mysql shell
make clean                   # nuke everything (including volumes)
```

## Repo layout

See [`SPEC.md` §2](./SPEC.md). Top level:

```
api/         — Fastify + Prisma (TypeScript, Node 20)
dialer/      — pacing engine (Go 1.22, single module)
workers/     — DNC sync, recording encode, transcribe (Node)
web/         — Next.js 14 App Router agent + admin UI
freeswitch/  — Dockerfile + XML configs
shared/      — proto, openapi, JSON-Schema events, TS types
spec/        — module specs and RFCs
scripts/     — dev-up, smoke, reset, load-test
```

## Conventions

Every change must follow `SPEC.md §3`:

- **Branches:** `feat/<module-id>-<slug>`, `fix/<short>`, etc.
- **Commits:** Conventional Commits — `feat(F01): scaffold compose stack`.
- **Logging:** structured JSON to stdout. Go uses `slog`, Node uses `pino`.
- **Metrics:** `/metrics` per service, names follow `vici2_<subsystem>_<unit>`.
- **Secrets:** `.env` is gitignored; production via host env or Docker secrets.
- **DB migrations:** Prisma only; reversible.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the per-module agent workflow
(READ → RESEARCH → PLAN → IMPLEMENT → VERIFY → TEST → HANDOFF → PR → DONE).

## License

TBD.
