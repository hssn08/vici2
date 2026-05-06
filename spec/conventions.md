# vici2 — repo conventions (quick reference)

This file is a developer-friendly extract of [`SPEC.md` §3](../SPEC.md). The
spec is authoritative; this is a cheat-sheet.

## Languages & versions

| Component | Language | Version | Linter | Formatter |
|---|---|---|---|---|
| `dialer/` | Go | 1.22+ | `golangci-lint` | `gofumpt`, `goimports` |
| `api/`, `workers/` | TypeScript | Node 20 LTS | `eslint` + `@typescript-eslint` | `prettier` |
| `web/` | TypeScript | Node 20 LTS | `eslint` + `next` plugin | `prettier` |
| `freeswitch/conf/*.xml` | XML | FS 1.10.x | `xmllint --noout` | — |
| MySQL | — | 8.0 InnoDB | — | — |
| Redis | — | 7.x | — | — |

## Branch & commit

- Branches: `feat/<module-id>-<short-slug>`, `fix/<short>`, `chore/<short>`,
  `docs/<short>`.
- Commits: [Conventional Commits](https://www.conventionalcommits.org).
  Example: `feat(F01): scaffold docker-compose`.
- One module = one PR. Split if > 800 LOC; smaller is better.
- PR title format: `[<module-id>] <one-line summary>`.

## Logging

- Format: structured JSON to stdout. Never `console.log` / `fmt.Println` in
  production code paths.
- Required fields: `ts`, `level`, `service`, `module`, `msg`. Add
  `call_uuid` / `lead_id` / `agent_id` / `campaign_id` when in scope.
- Levels: `debug` (dev only) / `info` (default) / `warn` / `error` / `fatal`.
- Libraries: Go = `slog`. Node = `pino`. **No** `winston`, `bunyan`, `zap`.
- Never log: SIP passwords, lead phone-number lists in bulk, recording binary,
  JWTs.

## Errors

- Go: typed errors with `errors.Is` / `errors.As`. No bare `errors.New` for
  caller-visible errors.
- TS: discriminated-union error types. Never `catch (e: any)` without
  re-typing. Never throw strings.
- API responses: every HTTP error returns
  `{ error: { code, message, details? } }`. `code` is a stable string.
- A 5xx is a bug. A 4xx is a contract issue. Never use 5xx for user errors.

## Metrics (Prometheus)

- Every long-running service exposes `/metrics` on a separate port.
- Naming convention: `vici2_<subsystem>_<unit>` (e.g.
  `vici2_dialer_originate_total`, `vici2_dialer_drop_rate_pct`).
- Required base metrics: process up-time, memory, GC pauses, error counts.
- Required dialer metrics: `originates/sec`, `bridged/sec`, `drops_pct_30d`,
  `hopper_size`, `agents_ready`, `dial_level`, `esl_reconnects`.

## Secrets

- `.env` for dev (gitignored); `.env.example` is committed and is the source
  of truth for env-var **names**.
- Production: secrets via host env vars or Docker secrets.
- DB passwords / SIP creds / carrier creds: encrypted at rest in MySQL via
  app-layer envelope encryption. Key from env. Never plain-text in DB.

## Database

- Schema changes only via Prisma migrations. No raw `ALTER TABLE` in app
  code.
- Every table has `created_at` / `updated_at`. Soft-delete (`deleted_at`)
  only where lifecycle requires.
- Foreign keys ON. `ON DELETE RESTRICT` default; `CASCADE` only when
  required.
- Migrations must be reversible (every `up` has a `down`). PR-blocking.

## Inter-service contracts

- REST: OpenAPI 3.0 in `shared/openapi/openapi.yaml`. Web consumes via
  `openapi-typescript`-generated types.
- gRPC: `.proto` in `shared/proto/`. Stubs generated in CI.
- Events: JSON-Schema in `shared/events/`. Stream names follow
  `vici2.<domain>.<event>` (e.g. `vici2.call.answered`). Consumer groups
  isolate readers.

## Testing

- Unit: mock all external systems. Run on every commit.
- Integration: real MySQL + Redis + FreeSWITCH (docker compose) + SIPp +
  fake SIP.js client. PR + nightly.
- E2E: Playwright agent UI + real FS + fake SIPp carrier. Nightly.
- Load: k6 (HTTP) + SIPp (SIP). Pre-release.
- Coverage: new code ≥ 70 %. Critical paths ≥ 90 %.
