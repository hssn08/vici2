# Contributing to vici2

Welcome. This repo is built by parallel coding agents per the workflow defined in
[`SPEC.md` §0.1](./SPEC.md#01-per-module-agent-workflow-the-loop-every-agent-runs).
Human contributors follow the same process.

## TL;DR

1. Pick a module from `spec/modules/` whose dependencies are `DONE`.
2. Read `DESIGN.md`, `SPEC.md`, `spec/modules/<id>.md`, and the
   `HANDOFF.md` of every dependency.
3. Run the prescribed RESEARCH phase (MCP queries, doc dives) and write
   `spec/modules/<id>/RESEARCH.md`.
4. Plan: write `spec/modules/<id>/PLAN.md` with API contracts, schemas,
   sequence diagrams, file list. Get checkpoint review.
5. Implement on `feat/<module-id>-<slug>`. Conventional Commits.
6. Verify (`spec/modules/<id>/VERIFY.md`).
7. Test (≥ 70% coverage on new code; 90% for compliance / dialer pacing).
8. Hand off (`spec/modules/<id>/HANDOFF.md`).
9. Open PR using `.github/PULL_REQUEST_TEMPLATE.md`. Reference module ID.

## Repo conventions

All in [`SPEC.md` §3](./SPEC.md). Highlights:

- **Languages:** Go 1.22 (dialer), Node 20 LTS + TypeScript (api, web, workers).
- **Linters:** `golangci-lint`, `eslint` (flat config), `prettier`, `xmllint`.
- **Logging:** structured JSON to stdout. `slog` (Go) or `pino` (Node) only.
- **Errors:** typed errors (`errors.Is/As` in Go; discriminated unions in TS).
  HTTP responses always `{ error: { code, message, details? } }`.
- **Metrics:** `vici2_<subsystem>_<unit>` naming. `/metrics` per service.
- **Secrets:** `.env` (gitignored) for dev; host env or Docker secrets in prod.
  Never commit a real secret.
- **DB:** Prisma migrations only; every migration must be reversible.
- **Branch naming:** `feat/<module-id>-<slug>`, `fix/<short>`, `chore/<short>`,
  `docs/<short>`.
- **Commits:** [Conventional Commits](https://www.conventionalcommits.org)
  — `feat(F01): scaffold compose stack`.

## Local hooks

```bash
pnpm install          # also installs lefthook hooks
make hooks            # explicit hook install if needed
```

Pre-commit runs ESLint + Prettier + golangci-lint + xmllint + gitleaks on staged
files. Pre-push runs `tsc --noEmit` and `go vet ./...`. Commit-msg runs
commitlint.

## RFC process

If during research/plan/impl you find that the spec is wrong, ambiguous, or
incomplete, open an RFC under `spec/rfc/RFC-NNN-short-title.md` per
[`SPEC.md` §12](./SPEC.md#12-rfc-process-when-spec-needs-to-change). Don't just
deviate silently.

## What to escalate

- Spec ambiguity that affects the public interface
- A dependency that turned out wrong
- Research that invalidates the design
- Untestable acceptance criteria
- Security concerns not anticipated

What NOT to escalate: code style, internal naming, file organization within your
module.
