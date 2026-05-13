# O04 — VERIFY

**Module:** O04 — CI/CD Pipelines
**Phase:** VERIFY (companion to IMPLEMENT)
**Date:** 2026-05-13
**Branch:** `worktree-agent-a83528cbf09fa826c` (mapped to `feat/O04-implement`
in the parent orchestrator's worktree manifest)

This document records the local-environment validation of the O04
implementation. Full end-to-end verification (steps §21.1–21.10 of PLAN) is
deferred until the workflows execute on an actual GitHub Actions runner with
real secrets/environments configured; those steps are tracked in
`HANDOFF.md §7 — Deferred work`.

---

## 1. Files delivered

```
.github/workflows/ci.yml                            (replaced F01 stub)
.github/workflows/build.yml                         (new)
.github/workflows/release.yml                       (new)
.github/workflows/security.yml                      (new)
.github/workflows/secrets-scan.yml                  (unchanged, F01-era stub)
.github/dependabot.yml                              (new)
.github/CODEOWNERS                                  (new)
.github/PULL_REQUEST_TEMPLATE.md                    (unchanged, F01-era)
scripts/ci/check-pr-body.sh                         (new, executable)
scripts/ci/check-migrations.sh                      (new, executable)
api/prisma/migrations/.no-down-sql-allowlist        (new — legacy grandfather list)
Makefile                                            (added: ci, ci-lint, ci-test,
                                                    ci-migrations, ci-actionlint,
                                                    ci-workflows targets)
spec/modules/O04/VERIFY.md                          (this file)
spec/modules/O04/HANDOFF.md                         (companion)
```

The PLAN.md inventory (§20) calls for ~30 files including AWS Terraform,
deploy scripts, runbooks, and Slack/SSM wiring. Those are explicitly
deferred — see HANDOFF.md §7. The IMPLEMENT here covers the
"per-PR/per-tag CI surface" the orchestrator briefed, plus the gate
infrastructure needed to enforce it.

---

## 2. Static validation

### 2.1 `actionlint`

```text
$ actionlint --version
1.7.7    (installed via: go install github.com/rhysd/actionlint/cmd/actionlint@latest)

$ actionlint -color
(no output — exit 0)
```

All five workflow YAML files (`ci.yml`, `build.yml`, `release.yml`,
`security.yml`, `secrets-scan.yml`) parse and pass shellcheck on every
inline `run:` block.

### 2.2 `make ci-actionlint` (Makefile wrapper)

```text
$ make ci-actionlint
(no output — exit 0)
```

The Makefile target prints a clear error if actionlint isn't installed.

### 2.3 Dependabot config syntax

The schema is validated by GitHub when the file is committed; no offline
validator is shipped with `gh` itself. The file uses only documented
v2 fields (`package-ecosystem`, `directories` array, `groups`,
`ignore.update-types`) and was cross-checked against
<https://docs.github.com/en/code-security/dependabot/dependabot-version-updates/configuration-options-for-the-dependabot.yml-file>.

---

## 3. CI helper-script validation

### 3.1 `scripts/ci/check-pr-body.sh`

Test matrix exercised locally:

| Scenario | Expected | Actual |
|---|---|---|
| Body with `## Module` + valid ID `O04` + all required headers | exit 0 | exit 0, "PR body OK — module=O04" |
| Body with `## Module` but non-conforming line `foo` | exit 1 | exit 1, clear error |
| (Untested locally — needs real GH event) missing header | exit 1 | covered by `grep -qE` |

Replay (success case):

```text
$ PR_BODY='## Module
O04 — CI/CD pipeline

## Summary
- foo

## Test plan
- [ ] make ci

## Compliance impact
- [ ] No PII logged' bash scripts/ci/check-pr-body.sh
PR body OK — module=O04
```

Replay (failure case):

```text
$ PR_BODY='## Module
foo
## Test plan
...
## Compliance impact
...' bash scripts/ci/check-pr-body.sh
::error::PR body 'Module' line must start with a module ID like 'F01', 'O04', 'T02'. Got: 'foo'
exit=1
```

### 3.2 `scripts/ci/check-migrations.sh`

```text
$ ./scripts/ci/check-migrations.sh
All 8 migrations have a down.sql.
exit=0
```

The 8 legacy migrations are grandfathered via
`api/prisma/migrations/.no-down-sql-allowlist`. Any NEW migration added
post-O04 must ship a `down.sql` or the check fails. Test that the rule
DOES fail for a hypothetical new migration was performed by temporarily
removing one allowlist entry and re-running — the script correctly
exited non-zero with a clear message and list.

---

## 4. Workflow logic walkthroughs

### 4.1 `ci.yml`

Triggers: `push: main` and `pull_request: main`. Concurrency cancels
in-flight PR runs on new pushes; main-push runs are NOT cancellable
(so a merge can't kill the gate that the next merge depends on).

Stages:

1. **Lint (parallel):** `lint-go` (matrix Go 1.22), `lint-node`
   (matrix Node 20.x), `lint-xml`, `lint-tenant-index`, `lint-commits`
   (PR only), `lint-pr-meta` (PR only), `migrations-reversible`.
2. **Unit (parallel):** `unit-go`, `unit-node` (each on a version
   matrix). Coverage uploaded as artifact.
3. **Build:** `build-images` runs after all of stage 1+2 succeed.
   FreeSWITCH image is only built when `SIGNALWIRE_TOKEN` is in repo
   secrets — otherwise the four non-FS images are built so the gate
   still works on forks/public PRs.
4. **Gate:** `ci-pass` is an aggregator job. Branch protection should
   require ONLY `ci-pass` (plus `lint-pr-meta` and `lint-commits` for
   PRs, since those are conditional). Renaming or splitting other jobs
   doesn't require updating the protection ruleset.

### 4.2 `build.yml`

Triggers: `push: main`, `push: tags v*.*.*`, `workflow_dispatch`.

Matrix: `[api, dialer, workers, web]` runs in parallel; `freeswitch`
runs as a separate job that early-skips when `SIGNALWIRE_TOKEN` is
absent (cannot gate via `if:` on `secrets` directly, so the
short-circuit is the first step).

For each service the workflow:

1. Logs in to GHCR using `GITHUB_TOKEN` (no PAT needed).
2. Uses `docker/metadata-action@v5` to compute tags per PLAN §6.
3. Builds + pushes via `docker/build-push-action@v6` with GHA cache
   scoped per service+arch (`scope=<svc>-amd64`).
4. Generates a CycloneDX SBOM via `anchore/sbom-action@v0`.
5. Attests SLSA L3 provenance via `actions/attest-build-provenance@v2`.
6. Attests the SBOM via `actions/attest-sbom@v2`.

Multi-arch (arm64) is documented in PLAN §5 but not enabled in this
IMPLEMENT — see HANDOFF §7.

### 4.3 `release.yml`

Trigger: `push: tags v*.*.*` (or manual dispatch with a tag input).
Resolves the published image digests via `docker buildx imagetools
inspect`, retries up to 30 minutes to allow `build.yml` to push
images first, then drafts a GitHub Release with the digest manifest
and an auto-generated changelog (`git log prev_tag..tag`).

### 4.4 `security.yml`

Triggers: `push: main`, `pull_request: main`, weekly cron (Mon 07:00
UTC), and manual.

Jobs:
- `gitleaks` — full history scan, every push + PR.
- `trivy-fs` — filesystem scan, SARIF → Security tab. Non-blocking
  initially (`exit-code: 0`) per PLAN §16; flip to blocking once
  baseline is clean.
- `trivy-config` — IaC/Dockerfile/compose scan, SARIF.
- `trivy-image` — scheduled-only; scans `latest` GHCR images.
- `sbom-repo` — scheduled-only; CycloneDX SBOM of the repository.
- `dependency-review` — PR-only; blocks high-severity vulns + the
  GPL/AGPL/SSPL deny-list per PLAN §16.

---

## 5. Local CI parity

The Makefile target `make ci` runs the equivalent of the CI lint+test
stages on a developer's machine:

```text
$ make -n ci
... golangci-lint / go vet ...
pnpm exec eslint .
pnpm exec prettier --check .
... xmllint ...
./scripts/ci/check-tenant-index-leadership.sh
(cd dialer && go test ./...)
pnpm -r --if-present run test
./scripts/ci/check-migrations.sh
echo "[ci] all local checks passed"
```

This matches the CI `ci.yml` job tree, satisfying the F01 → O04
contract that "CI is always in lock-step with local."

The container-build stage is NOT in `make ci` because it needs Docker
Buildx + (for FS) a SignalWire token; devs use `make build-images`
for that explicitly.

---

## 6. Things NOT verified in this session

(See HANDOFF.md §7 for the actionable list.)

- The workflows have not yet been executed on a real GHA runner.
  They will run on the first PR after this branch merges; if anything
  is wrong, fix in a follow-up `fix(O04): …` PR.
- Branch protection ruleset is documented in HANDOFF §6 but cannot be
  installed via committed code without repo-admin credentials.
- OIDC roles + AWS IAM trust policies (PLAN §8) are NOT shipped — they
  belong to a follow-on PR when an AWS account is allocated.
- The four GitHub Environments (PLAN §9) are not created — same
  rationale.
- Deploy workflows (`deploy-staging.yml`, `deploy-prod.yml`) are
  deferred — they depend on the AWS/SSM/EC2 surfaces above.
- Multi-arch (arm64) image builds are deferred — needs a follow-on PR
  once we have an arm64 GH-hosted runner allocated and FreeSWITCH ARM
  buildability confirmed.

---

## 7. Sign-off

The CI surface delivered here:

- Satisfies the orchestrator's IMPLEMENT brief (4 core workflows +
  dependabot + CODEOWNERS + Makefile + helper scripts).
- Passes `actionlint` with zero findings.
- Mirrors local-dev tooling, no version skew.
- Pins every action to a major-version tag (`@v4`, `@v5`, `@v6`); no
  `@main` references.
- Uses GHCR + `GITHUB_TOKEN` only (no static AWS keys); the OIDC
  surface needed for AWS is documented in HANDOFF §6 for the follow-on
  PR.

Ready for review and merge.
