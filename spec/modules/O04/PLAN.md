# Module O04 — CI/CD Pipeline — PLAN

**Module:** O04 (Operations, Phase 1; cross-cutting)
**Author:** O04 PLAN sub-agent
**Date:** 2026-05-06
**Status:** PROPOSED — awaiting human/orchestrator review.
**Companion:** [RESEARCH.md](./RESEARCH.md) — 57 citations behind every choice here.
**Inputs honored:** SPEC.md §3.2 (branches/commits), §3.3 (PR template + module-id), §3.10 (test tiers), §3.11 (DoD); F01/PLAN.md (CI workflow stub + Make targets that CI must mirror).

This plan turns RESEARCH.md into the exact set of workflow files, composite
actions, scripts, AWS IAM roles, GitHub environments, branch-protection
rulesets, and PR-template content the IMPLEMENT phase will produce. **No YAML
is written here** — only the contract that IMPLEMENT executes against. Once
this plan is approved, the workflow + script + ruleset surface area is FROZEN
(O04 internals can still evolve without an RFC).

---

## 0. TL;DR (10 bullets)

1. **Stack: GitHub Actions + GHCR + OIDC-to-AWS.** No third-party CI vendor,
   no static AWS keys, no Docker Hub. Reusable workflows (`workflow_call`)
   for pipeline-level reuse; composite actions for step-level reuse.
2. **Pipeline shape:** `lint → unit → build → integration → docker → deploy`
   with security gates (gitleaks, dep-review, CodeQL, Trivy, license check)
   running in parallel where possible. Required-status checks gate `main`.
3. **Workflow inventory (7 files):** `ci.yml`, `deploy-staging.yml`,
   `deploy-prod.yml`, `load-nightly.yml`, `secrets-scan.yml`, `codeql.yml`,
   `dependency-review.yml`. Plus two reusable libraries (`_integration.yml`,
   `_docker.yml`) and four composite actions.
4. **Multi-arch images via native runners.** `ubuntu-latest` for amd64;
   `ubuntu-24.04-arm` for arm64; **no QEMU**. Split-build → digest export →
   manifest merge. SLSA L3 provenance attested on every push.
5. **Tag strategy:** `docker/metadata-action@v6` produces `sha-{short}`,
   branch, full semver set, `latest`. **Production deploys ALWAYS pin by
   `@sha256:<digest>`, never by tag** — tag rotation safety.
6. **OIDC roles (3):** `vici2-staging-deploy` (locked to push:main),
   `vici2-prod-deploy` (locked to v*.*.* tag pushes), `vici2-prod-migrate`
   (locked to tag pushes AND `environment:prod-migrate`, RDS-connect-only
   permissions). Workload secrets live in **AWS SSM Parameter Store**, not
   GitHub.
7. **GitHub Environments (3):** `staging` (auto, no approval, 0 wait),
   `production` (1 SRE reviewer required, 5-min wait timer),
   `production-migrate` (1 DBA reviewer, 0 wait, separate from `production`
   so DBA & SRE approvals are independent and auditable).
8. **Migrations:** staging auto-applies on every merge; **prod NEVER
   auto-applies**. `prisma migrate status` runs first as a drift check
   (fails the job on drift). Long-running ALTERs go through gh-ost via a
   manual `workflow_dispatch`, never in the deploy pipeline.
9. **Rollback:** every successful deploy appends
   `{ts, tag, digests}` JSON-line to `s3://vici2-deploy-log/<env>.jsonl`.
   `scripts/deploy/rollback.sh` reads the previous line, rewrites
   `docker-compose.prod.yml` digest pins, redeploys. Health-probe failure
   on a fresh deploy auto-triggers rollback.
10. **Branch protection** codified as a JSON ruleset (Terraform under
    `infra/github/`): 1 PR review, dismiss stale, last-push-by-other,
    linear history, 11 required status checks, no force-push, no deletion,
    enforce admins. Tag ruleset on `v*.*.*` makes release tags immutable
    and creatable only from `main`.

---

## 1. Stack decision (locked in this PLAN)

| Concern | Choice | Why (RESEARCH refs) |
|---|---|---|
| CI engine | GitHub Actions | Repo lives on GH; GHCR + Environments + OIDC are native [1][2][4] |
| Reuse model | Reusable workflows for pipelines + composite actions for steps | GH-recommended split [1][2][3] |
| Container registry | GHCR | OIDC via `GITHUB_TOKEN`, no Docker Hub rate limits, image visibility tracks repo [6][7][8] |
| Cloud target | **AWS** (Phase 1) — see §18 | OIDC + ECR/SSM mature; portability sketched [14][15][16] |
| OIDC trust | `aws-actions/configure-aws-credentials@v6` | Standard, short-lived STS [14][16] |
| Multi-arch builder | Native `ubuntu-24.04-arm` runners | Avoid QEMU [9][10][11] |
| Provenance | `actions/attest-build-provenance@v2` | SLSA L3 free on GH-hosted [12] |
| SBOM | `syft` (CycloneDX) → `actions/upload-artifact` | OWASP-aligned, supported by GH attestations |
| Secret scanning | gitleaks (blocking) + GH native (informational) | gitleaks catches non-OAuth tokens [50] |
| Code scanning | CodeQL (Go + JS/TS) | First-party, free on public [48][49] |
| Dep / license | `actions/dependency-review-action@v4` | Single action covers both gates [46][47] |
| Image vuln | Trivy on built images, fail HIGH/CRITICAL | Standard, fast [50] |
| PR title lint | `amannn/action-semantic-pull-request@v6` | Conventional Commits + module-ID type [34] |
| PR body lint | `scripts/ci/check-pr-body.sh` (grep) | Light, repo-local |
| Tag generation | `docker/metadata-action@v6` | The standard [12][13][41] |
| Build cache | `cache-from/to type=gha,scope=<svc>-<arch>` | Per-arch scope avoids invalidation [53] |

---

## 2. Workflow inventory

All paths under `.github/workflows/`. Reusable libraries are prefixed `_`
by convention (GH treats them like any other).

### 2.1 `ci.yml` (top-level; runs on `pull_request` + `push:*`)

**Triggers:** `pull_request`, `push` (any branch). Dependabot PRs go through
the same checks but skip deploy paths (gated on actor).

**Jobs (parallel where possible):**

| Job ID | Stage | Runner | When | Required-status? |
|---|---|---|---|---|
| `lint-go` | 1 lint | `ubuntu-latest` | always | yes |
| `lint-node` | 1 lint | `ubuntu-latest` | always | yes |
| `lint-xml` | 1 lint | `ubuntu-latest` | always | yes |
| `lint-pr-meta` | 1 lint | `ubuntu-latest` | `pull_request` | yes (PR only) |
| `unit-go` | 2 unit | `ubuntu-latest` | always | yes |
| `unit-node` | 2 unit | `ubuntu-latest` | always | yes |
| `build-go` | 3 build | `ubuntu-latest` | always | yes |
| `build-node` | 3 build | `ubuntu-latest` | always | yes |
| `integration` | 4 integration | `ubuntu-latest` | `pull_request` + `push:main` | yes |
| `docker` | 5 docker | matrix `[ubuntu-latest, ubuntu-24.04-arm]` | `push:main` + `push: tags v*` | yes (gates deploy) |
| `dep-review` | 6 sec | `ubuntu-latest` | `pull_request` | yes |
| `gitleaks` | 6 sec | `ubuntu-latest` | always | yes |
| `licenses` | 6 sec | `ubuntu-latest` | `pull_request` + nightly | informational (PR comment) |
| `trivy-image` | 6 sec | `ubuntu-latest` | `push:main` + tags (after `docker`) | yes (gates deploy) |

CodeQL and the dependency-review library list are split into their own
small workflows so they can be cron-scheduled independently. Lint-pr-meta
is PR-only; on `push` it's skipped (and its required-status entry is
auto-satisfied via the `if:` skip-as-success pattern).

### 2.2 `deploy-staging.yml` (auto on `push:main` after CI green)

**Trigger:** `workflow_run` with `workflows: [ci]`, `types: [completed]`,
filtered to `conclusion == 'success'` AND `event == 'push'` AND
`branch == 'main'`. (Pattern preferred over `needs:` across workflows.)

**Jobs:**

- `deploy`
  - environment: `staging` (no approval, no wait)
  - permissions: `id-token: write`, `contents: read`
  - calls composite action `aws-oidc` with role `vici2-staging-deploy`
  - resolves image digests for `sha-${{ github.sha }}` from GHCR
  - calls `scripts/deploy/staging.sh "$IMAGE_DIGESTS_JSON"`
  - on failure: auto-invoke `scripts/deploy/rollback.sh staging`
  - posts result to Slack via `notify-slack` composite action

Concurrency: `group: deploy-staging`, `cancel-in-progress: false` (never
interrupt a running deploy).

### 2.3 `deploy-prod.yml` (manual approval; triggered by `push: tags v*.*.*`)

**Trigger:** `push: { tags: ['v*.*.*'] }` plus `workflow_dispatch:` with
inputs `{ rollback: bool, target-tag: string, skip-migrate: bool }`.

**Jobs (sequential):**

1. `migrate-prod`
   - environment: `production-migrate` (1 DBA reviewer, 0 wait)
   - role: `vici2-prod-migrate` (RDS-connect only)
   - steps: `prisma migrate status` → fail-on-drift → `prisma migrate deploy` → notify Slack
   - skipped iff `inputs.skip-migrate == 'true'` (escape hatch for two-phase deploys)
2. `release-prod`
   - needs: `migrate-prod`
   - environment: `production` (1 SRE reviewer, 5-min wait)
   - role: `vici2-prod-deploy`
   - resolves image digests for the tag from GHCR (idempotent — `docker buildx imagetools inspect`)
   - calls `scripts/deploy/prod.sh "$IMAGE_DIGESTS_JSON"`
   - 90s health-probe loop; auto-rollback on failure
   - records digests to `s3://vici2-deploy-log/prod.jsonl`
   - creates GitHub deployment object (success); notifies Slack

Concurrency: `group: deploy-prod`, `cancel-in-progress: false`.

### 2.4 `load-nightly.yml` (cron 02:00 UTC + manual)

**Trigger:** `schedule: cron '0 2 * * *'`, `workflow_dispatch:`.

**Jobs:**

- `load`
  - runs against the **dedicated `load-staging` env** (see §9 + §18)
  - calls O03's scenario runners (`scripts/load-test/run.sh`):
    - `answer-only` 50 cps, 600s
    - `predictive` 100 cps, 600s
    - `mixed-inbound-outbound` 30 cps each, 300s
  - uploads HTML/CSV reports as artifacts (90-day retention)
  - compares p95 + drop% against baseline JSON committed at
    `spec/modules/O03/baseline.json` via `jq`
  - on **>10% regression** on any guarded metric: opens a GitHub issue
    labeled `load-regression, priority/high` via `actions/github-script`
    (pattern from open-telemetry/opentelemetry-operator [35])

### 2.5 `secrets-scan.yml` (every push)

Single job: gitleaks v8 with the `--redact --no-banner --exit-code 1`
flags. Uses `gitleaks-action@v2`. Runs on `push: *` and `pull_request`.
Blocking. Configuration committed at `.gitleaks.toml`.

### 2.6 `codeql.yml` (weekly + push:main)

**Trigger:** `schedule: cron '0 7 * * 1'` (Monday 07:00 UTC),
`push: { branches: [main] }`, `pull_request: { branches: [main] }`.

**Jobs (matrix):** `language: [go, javascript-typescript]`. Suite =
`security-and-quality`. Permissions: `security-events: write`. Findings
post to the GH Security tab; PR comments are informational, not blocking
(per RESEARCH.md §9 — too noisy to block PRs).

### 2.7 `dependency-review.yml` (PR)

Single job runs `actions/dependency-review-action@v4` configured via
`.github/dependency-review-config.yml`:

- `fail-on-severity: high`
- `allow-licenses: [MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, MPL-2.0, Unlicense, 0BSD, CC0-1.0]`
- `deny-licenses: [GPL-2.0, GPL-3.0, AGPL-3.0, LGPL-2.0, LGPL-3.0, SSPL-1.0, RSAL]`
- `comment-summary-in-pr: on-failure`

Blocking on PRs.

---

## 3. Reusable workflows (`.github/workflows/_*.yml`)

### 3.1 `_integration.yml`

**Inputs:** `{ fs-image-tag: string, run-load: bool (default false), services: csv-string }`.

**Job `integration`** runs on `ubuntu-latest`:

1. checkout
2. composite `setup-monorepo` (setup-go, setup-node+pnpm, restore caches)
3. `docker/setup-buildx-action@v4` with cache backend `type=gha,scope=integration-*`
4. **build all images locally** (`docker buildx build ... --load`) using
   `cache-from/cache-to type=gha,scope=integration-<service>` (per-service
   scope to avoid cache invalidation between services)
5. `docker compose -f docker-compose.yml -f docker-compose.test.yml up --wait -d`
   (the `--wait` flag blocks until each healthcheck passes; F01 PLAN
   commits to a healthcheck on every service — verified)
6. `pnpm -r test:integration && go test -tags=integration ./...`
7. on failure: `docker compose logs > tmp/<service>.log`; upload `tmp/`
8. always: `docker compose down --volumes --remove-orphans`

This expands the F01 stub `make test` invocation: integration tests in F01
were placeholder-only; O04 wires the real fixture stack here.

### 3.2 `_docker.yml`

**Inputs:** `{ service: string (api|dialer|workers|web|freeswitch), push: bool, tag-suffix: string (optional) }`.

**Job `build` (matrix):**

```
strategy:
  matrix:
    include:
      - { runner: ubuntu-latest,    platform: linux/amd64, suffix: amd64 }
      - { runner: ubuntu-24.04-arm, platform: linux/arm64, suffix: arm64 }
runs-on: ${{ matrix.runner }}
permissions: { contents: read, packages: write, id-token: write, attestations: write }
```

Steps:

1. checkout
2. `docker/setup-buildx-action@v4`
3. composite `login-ghcr`
4. `docker/metadata-action@v6` → tags computed from §4.3 below
5. `docker/build-push-action@v7` with `platforms=${{ matrix.platform }}`,
   `cache-from/to type=gha,scope=${{ inputs.service }}-${{ matrix.suffix }}`,
   `outputs=type=image,push-by-digest=true,name-canonical=true,name=ghcr.io/<org>/vici2-${{ inputs.service }}`
6. export digest to `/tmp/digests/${{ matrix.suffix }}/<digest>`
7. `actions/upload-artifact@v4` → `digests-${{ inputs.service }}-${{ matrix.suffix }}`

**Job `merge`** (needs `build`):

1. download all `digests-${{ inputs.service }}-*`
2. setup-buildx + login-ghcr
3. `docker buildx imagetools create` with the metadata-action tag list and
   the per-arch digests → manifest list
4. `actions/attest-build-provenance@v2` with `subject-name` and the
   manifest digest as `subject-digest`
5. **SBOM:** install `syft`, run `syft ghcr.io/<org>/vici2-<svc>@<digest> -o cyclonedx-json > sbom.json`,
   upload-artifact retention 90d, attach via `actions/attest-sbom@v2`

`_docker.yml` is invoked from `ci.yml`'s `docker` job, once per service via
`uses:` plus a top-level matrix of services.

---

## 4. Composite actions (`.github/actions/<name>/action.yml`)

### 4.1 `setup-monorepo`

Inputs: `{ go-version (default: ".tool-versions"), node-version (default: ".tool-versions") }`.

Steps:

1. `actions/checkout@v4` with `fetch-depth: 0` (needed by gitleaks + semantic-pr)
2. `actions/setup-go@v5` with `go-version-file: dialer/go.mod`, `cache: true`
3. `pnpm/action-setup@v4` (reads `packageManager` from root `package.json`)
4. `actions/setup-node@v6` with `node-version-file: .tool-versions`, `cache: pnpm`
5. `pnpm install --frozen-lockfile`

This action is the **single entry point** for every Go/Node job — it
guarantees CI uses exactly the versions F01 pinned in `.tool-versions`,
satisfying the F01 → O04 contract that "CI is always in lock-step with
local."

### 4.2 `login-ghcr`

Wraps `docker/login-action@v4` with:

```
registry: ghcr.io
username: ${{ github.actor }}
password: ${{ env.GITHUB_TOKEN }}    # passed in via env from caller
```

### 4.3 `aws-oidc`

Inputs: `{ role-to-assume: string, aws-region: string (default us-east-1), session-name: string (default github-actions) }`.

Wraps `aws-actions/configure-aws-credentials@v6` with `audience: sts.amazonaws.com`.
Caller declares `permissions: { id-token: write }`.

### 4.4 `notify-slack`

Inputs: `{ status: success|failure|cancelled, channel: string, text: string (optional) }`.

Posts to the Slack webhook stored at `secrets.SLACK_WEBHOOK_URL`. Includes
run URL, commit SHA, actor, branch/tag. Uses `slackapi/slack-github-action@v1`
with the `incoming-webhook` payload shape.

---

## 5. Multi-arch image strategy

**Native runner per arch — no QEMU.** Already locked in §3.2 above. Key
operational details:

- amd64 builds on `ubuntu-latest` (x86_64). Free for public repos.
- arm64 builds on `ubuntu-24.04-arm` (Graviton-class). Free for public repos
  since 2025-01 [10][11].
- Each build emits a **digest only** (`push-by-digest=true,name-canonical=true`).
  No tag is created at this stage.
- A final `merge` job creates the **manifest list** with `docker buildx
  imagetools create` and applies all `metadata-action` tags atomically.
  This is the only step that `latest`, `sha-*`, `main`, semver tags get
  written.
- **FreeSWITCH image arm64:** unknown buildability (RESEARCH §11 open
  question). PLAN decision: the `_docker.yml` matrix for service=freeswitch
  is **conditional** — if the arm64 build job sets a step output
  `freeswitch-arm64-supported: false`, the merge job creates an
  amd64-only manifest and continues green. We try ARM, document the
  failure mode in the FS Dockerfile comments, and revisit when SignalWire
  publishes an arm64 base or we adopt PatrickBaus's Alpine ARM build [23].

---

## 6. Image tagging strategy

`docker/metadata-action@v6` config:

```
images: ghcr.io/<org>/vici2-<service>
tags: |
  type=sha,prefix=sha-                       # sha-abc1234 (immutable; deploy uses this)
  type=ref,event=branch                      # main (mutable; "tip of branch")
  type=ref,event=pr                          # pr-123 (PR build; pushed only with --push hint)
  type=semver,pattern={{version}}            # 1.2.3 (only on tag push)
  type=semver,pattern={{major}}.{{minor}}    # 1.2
  type=semver,pattern={{major}}              # 1
  type=raw,value=latest,enable={{is_default_branch}}
```

**Production deploy contract:** `scripts/deploy/prod.sh` resolves the tag
to a `sha256:` digest via `docker buildx imagetools inspect ghcr.io/<org>/vici2-<svc>:<tag> --format '{{ json .Manifest }}'`
and rewrites `docker-compose.prod.yml` to pin
`image: ghcr.io/<org>/vici2-<svc>@sha256:<digest>`. Tags are mutable;
digests are content-addressed [28][29][41]. **Never deploy by tag.**

**Retention:** GHCR repo packages settings keep all `v*` tags forever, keep
`main` tag forever, keep last 30 `sha-*` tags, prune everything else after
60 days. Configured via `actions/delete-package-versions` scheduled cron in
`.github/workflows/ghcr-retention.yml` (subordinate to O04, not in the
required list of 7 — created during IMPLEMENT alongside `ci.yml`).

---

## 7. Provenance, attestation, SBOM

- Every push to GHCR: `actions/attest-build-provenance@v2` runs in the
  `_docker.yml` `merge` job. SLSA Level 3 by default for GH-hosted
  runners. Subject = manifest digest. Stored on the package + visible via
  `gh attestation verify` [12].
- SBOM via `syft` produces CycloneDX JSON. Attached as workflow artifact
  (90-day retention) AND attested via `actions/attest-sbom@v2` so it's
  discoverable from the package page.
- We do NOT add `cosign sign --keyless` in Phase 1 (RESEARCH §11 — defer).
  Provenance attestation covers the verifiability use case for our consumer
  (our own deploy scripts).

---

## 8. OIDC + IAM mapping

One-time Terraform under `infra/aws/oidc.tf` (separate from O04's workflow
PRs; tracked by O05 security baseline if it ships first, otherwise by O04
IMPLEMENT).

### 8.1 IAM OIDC provider

Provider URL: `https://token.actions.githubusercontent.com`
Audience: `sts.amazonaws.com`
Thumbprint: managed by AWS (no manual list maintenance) [14].

### 8.2 Roles

| Role | `sub` claim allow | Permissions (least-privilege) | Used by |
|---|---|---|---|
| `vici2-staging-deploy` | `repo:<org>/vici2:ref:refs/heads/main` | SSM run-command on staging EC2 tag, S3 write to `vici2-deploy-log/staging.jsonl`, ECR pull (mirror target, future) | `deploy-staging.yml` |
| `vici2-prod-deploy` | `repo:<org>/vici2:ref:refs/tags/v*` | SSM run-command on prod EC2 tag, S3 write to `vici2-deploy-log/prod.jsonl` | `deploy-prod.yml` job `release-prod` |
| `vici2-prod-migrate` | `repo:<org>/vici2:ref:refs/tags/v*` AND `environment:production-migrate` | RDS-Data API connect to `vici2-prod`, **no** SSM/S3/EC2 | `deploy-prod.yml` job `migrate-prod` |

The `environment:production-migrate` claim is what GH adds when a workflow
job declares `environment: production-migrate` — locking the migrate role
to the gated job is what makes the DBA approval gate meaningful.

### 8.3 Workload-runtime secrets

**Never in GitHub.** Stored in AWS SSM Parameter Store (Standard tier;
free up to 10K params, plenty for us). Tree pattern (per §19 hand-off):

```
/vici2/<env>/<service>/<key>
  /vici2/staging/api/DATABASE_URL
  /vici2/staging/api/JWT_SECRET
  /vici2/staging/dialer/FS_EVENT_SOCKET_PASSWORD
  /vici2/prod/api/DATABASE_URL
  /vici2/prod/api/CARRIER_TWILIO_PASS              ← envelope-encrypted (KEK from /vici2/prod/_meta/KEK)
  /vici2/prod/_meta/KEK                            ← KMS-encrypted SecureString
```

App reads from SSM at boot via `aws-sdk` (Node) / `aws-sdk-go-v2` (Go).
CI **never** sees DB passwords, KEK, or carrier creds.

GitHub-side secrets are only the operational kind:

- `SLACK_WEBHOOK_URL` (org-level)
- `GHCR_RETENTION_TOKEN` (PAT for `delete-package-versions`, fine-grained,
  read+delete on packages only)

No `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` ever — OIDC handles all
AWS auth.

---

## 9. GitHub Environments

| Environment | Reviewers | Wait timer | Branch policy | Secrets | Used by |
|---|---|---|---|---|---|
| `staging` | none (auto) | 0 | `main` only | `STAGING_AWS_REGION`, deploy SSH key (if used) | `deploy-staging.yml` |
| `production` | 1 from `@vici2/sre` (prevent self-review) | 5 min | tag pattern `v*.*.*` | `PROD_AWS_REGION`, deploy SSH key | `deploy-prod.yml::release-prod` |
| `production-migrate` | 1 from `@vici2/dba` (prevent self-review) | 0 | tag pattern `v*.*.*` | (none — uses OIDC role only) | `deploy-prod.yml::migrate-prod` |
| `load-staging` | none | 0 | any branch | `LOAD_STAGING_AWS_REGION` | `load-nightly.yml` |

The `production` 5-min wait timer gives the SRE a chance to abort if a
deploy fires unexpectedly (e.g., off-hours tag push). The migrate gate
has 0 wait because the DBA already explicitly approved.

The `production` and `production-migrate` environments are **separate** so
the DBA approval and SRE approval are independent — neither person can
approve both halves of a release on their own. This is the core
risk-management point per the O04.md risk register.

---

## 10. Migration strategy

### 10.1 Hard rules (per SPEC §3.8 + O04.md risk register)

1. **Staging:** auto-apply on every merge to `main`. `deploy-staging.yml`
   runs `pnpm exec prisma migrate deploy` as a step inside the deploy
   composition (single step in the SSM command). No approval. Drift
   caught daily.
2. **Production:** **never** auto-apply. Two-job split (`migrate-prod` →
   `release-prod`) with two separate approvals.
3. **Drift detection:** `prisma migrate status` is the **first** step in
   `migrate-prod`. If it reports drift OR pending-but-modified migrations,
   the job exits non-zero **before** `migrate deploy` runs. Forces
   investigation rather than silent reapply [24][25].
4. **Order:** default migrate-first, release-second. Workflow input
   `inputs.skip-migrate: bool` lets the team ship a release that doesn't
   need a migration (skips the migrate gate entirely). For two-phase
   "expand-then-contract" deploys, the team ships release N (code tolerant
   of both schemas), then a follow-on tag with migration only.
5. **Long-running ALTERs:** any migration touching a table > 1M rows or
   altering a hot column MUST be authored as a `gh-ost` invocation in
   `scripts/migrations/<n>-<slug>.gh-ost.sh`, NOT a Prisma migration. A
   manual `workflow_dispatch` ("ops/gh-ost-run.yml" — subordinate
   workflow created during IMPLEMENT alongside the main 7) executes it
   with explicit review. **Never in the deploy pipeline.**
6. **Reversibility:** SPEC §3.8 mandates every Prisma migration ship a
   hand-written `down.sql`. CI enforces via `scripts/ci/check-migrations.sh`
   added as a step in `lint-node`: any new file under
   `api/prisma/migrations/*/migration.sql` must have a sibling `down.sql`.

### 10.2 Rollback of migration

**Forward-fix only.** No automated `prisma migrate reset` or down.sql
execution against prod. If a migration goes wrong: DBA writes a new
migration that undoes the bad change, runs through the normal gate.
Documented in `spec/runbooks/migration-incident.md` (created during O04
IMPLEMENT).

---

## 11. Rollback strategy

### 11.1 Image rollback

Mechanism (covers ~95% of bad-deploy cases):

1. On every successful `deploy-staging.yml` and `deploy-prod.yml::release-prod`
   run, the deploy script appends a JSON line to
   `s3://vici2-deploy-log/<env>.jsonl`:
   ```json
   {"ts":"2026-05-06T14:32:11Z","tag":"v1.2.3","commit":"abc123","actor":"sre-bob","digests":{"api":"sha256:...","dialer":"sha256:...","workers":"sha256:...","web":"sha256:...","freeswitch":"sha256:..."}}
   ```
2. `scripts/deploy/rollback.sh <env> [target-tag-or-empty]`:
   - reads `s3://vici2-deploy-log/<env>.jsonl`
   - if `target-tag` is empty, picks the second-to-last line (last good)
   - if `target-tag` provided, picks the line matching that tag
   - rewrites `docker-compose.prod.yml` digest pins via `sed -i`
   - `docker compose pull` (digests are immutable; idempotent)
   - `docker compose up -d --no-deps <each-service>` (recreate without
     touching deps)
   - 90s health-probe loop; if not green, alert and **abort** (don't
     attempt a recursive rollback)
3. **Auto-trigger:** `deploy-prod.yml::release-prod` invokes
   `rollback.sh prod` automatically when the post-deploy health check
   fails. Same for staging.
4. **Manual trigger:** `gh workflow run deploy-prod.yml -f rollback=true -f target-tag=v1.2.2`.
   The `rollback` input short-circuits the workflow to skip the build
   stages and call `rollback.sh prod v1.2.2`.

### 11.2 Why digest, not tag

Tags are mutable. `vici2-api:v1.2.2` could in principle have been
overwritten (it shouldn't, but defense-in-depth). Digests are
content-addressed. Patterns from cr0x.net [28], FluxCD sortable-tag guide
[41], patternhelloworld/docker-blue-green-runner [30].

### 11.3 Schema rollback

Forward-fix only (see §10.2).

### 11.4 Blue/green

**Deferred to Phase 4.** Phase 1 single-replace is acceptable: deploys
scheduled in low-volume windows, agents tolerate a 30s blip. Phase 4
introduces Traefik blue/green per [44][45].

---

## 12. Branch protection rules

Codified as a **JSON ruleset** (preferred over legacy "branch protection
rules") under `infra/github/rulesets.tf` (Terraform `github_repository_ruleset`
resource). Source of truth lives in version control; UI is read-only.

### 12.1 `main` branch ruleset

```
target: branch
include: ["~DEFAULT_BRANCH"]   # i.e. main
rules:
  pull_request:
    required_approving_review_count: 1
    dismiss_stale_reviews_on_push: true
    require_code_owner_review: false           # team too small for codeowners pain
    require_last_push_approval: true            # someone-other-than-last-pusher must approve
    required_review_thread_resolution: true
  required_status_checks:
    strict_required_status_checks_policy: true # branch must be up-to-date with main
    required_status_checks:
      - lint-go
      - lint-node
      - lint-xml
      - lint-pr-meta
      - unit-go
      - unit-node
      - build-go
      - build-node
      - integration
      - dep-review
      - gitleaks
  required_linear_history: true                # squash or rebase merge only — clean bisect
  required_signatures: false                   # Phase 4 turn on (SSH-signed commits)
  non_fast_forward: true                        # blocks force-push
  deletion: false
  enforce_admins: true                          # admins can't bypass
```

`docker` and `trivy-image` are NOT in the required list because they only
run on `push:main` (after merge) — they gate **deployment**, not merge.

### 12.2 Tag ruleset for `v*.*.*`

```
target: tag
include: ["v*.*.*"]
rules:
  creation:
    bypass_actors: [{ actor: role:maintainer, mode: always }]   # only maintainers create
  deletion: false
  update: false                                                  # immutable tags
  required_signatures: false                                     # Phase 4
```

This means once `v1.2.3` is created, nobody can delete or move it. Combined
with our digest-pinning deploy script, that gives release immutability.

---

## 13. PR template + module-id enforcement (per SPEC §3.3)

### 13.1 `.github/PULL_REQUEST_TEMPLATE.md`

Content (committed during IMPLEMENT, faithful expansion of SPEC §3.3):

```markdown
## Module
<id> — <name>

<!-- Module ID format: F01, F02, T01, T02, ..., O04, etc. CI requires this header to match the regex ^[A-Z][0-9]{2}$ -->

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
- [ ] Migrations reversible (every up has a down)

## Compliance impact
<TCPA / DNC / recording-consent / time-zone-gate impact, or "N/A">
- [ ] No PII logged
- [ ] No secrets committed
- [ ] DNC / time-zone gates not weakened

## Metrics added
<list new vici2_* metric names introduced, or "none">

## Migration impact
- [ ] Yes — see `api/prisma/migrations/<n>-<slug>/`
- [ ] No

## Breaking change
- [ ] Yes — describe migration path:
- [ ] No
```

### 13.2 `scripts/ci/check-pr-body.sh` (called by `lint-pr-meta` job)

Bash script that:

1. Reads `${{ github.event.pull_request.body }}` from `$PR_BODY` env.
2. Asserts `## Module` header exists and the next non-empty line begins
   with a module-ID matching `^[A-Z][0-9]{2}\b` and that ID exists in
   `spec/modules/<id>.md`.
3. Asserts `## Test plan` and `## Compliance impact` headers exist.
4. Exits non-zero with a clear message on failure (e.g.,
   `ERROR: PR body must reference a valid module ID. Got: 'Foo'`).

### 13.3 PR title enforcement

`amannn/action-semantic-pull-request@v6` configured with:

```yaml
types: [feat, fix, chore, docs, refactor, test, perf, build, ci, revert]
scopes: <auto-generated from spec/modules/*.md filenames, lowercased>
requireScope: true
subjectPattern: '^[A-Z].+$'      # capitalized first letter
wip: true                         # allow "WIP: ..." for drafts
```

This enforces SPEC §3.2's `[<module-id>] <one-line summary>` shape via the
`scope` requirement (e.g., `feat(F01): scaffold docker-compose`).

---

## 14. Caching strategy

| Cache | Backend | Scope | Owner |
|---|---|---|---|
| Go module + build cache | `actions/setup-go@v5` (built-in) | `go.sum` hash | per job |
| pnpm store | `actions/setup-node@v6` (`cache: pnpm`) | `pnpm-lock.yaml` hash | per job |
| Docker layer cache | `type=gha,scope=<service>-<arch>` | per service+arch | `_docker.yml`, `_integration.yml` (separate scopes) |
| Prisma generate cache | `actions/cache@v4` keyed on `schema.prisma` hash | per job | `unit-node`, `build-node` |

The `scope=<service>-<arch>` pattern matters: a single shared scope
forces invalidation on every arch+service pair, defeating the cache.
Per-pair scope means each is independent.

GitHub's `gha` cache backend has a 10 GB per-repo limit. Our 5 services ×
2 arches = 10 scopes, each ~500 MB max → fits comfortably. Eviction is
LRU-managed by GH.

---

## 15. Self-hosted runner topology

### 15.1 Phase 1 default: GH-hosted only

All jobs run on `ubuntu-latest` or `ubuntu-24.04-arm`. No self-hosted
infra to operate. This includes the `integration` job — somleng-switch
proves a full FreeSWITCH+MySQL+OpenSIPS suite runs fine on stock
`ubuntu-latest` [38].

### 15.2 Trigger to escalate to self-hosted

Add **one** persistent self-hosted runner if **either** of:

- The `integration` job sees >5% flake rate over 50 runs (tracked via a
  small `actions/github-script` step that posts to a metrics webhook), OR
- SIP/RTP UDP traffic into the FS test container fails reproducibly under
  GH-hosted nested-container NAT.

### 15.3 Self-hosted runner shape (when triggered)

- 1 VM. AWS t3.medium (`x86_64`, 4 vCPU, 4 GB) or Hetzner CCX13 equivalent.
- Ubuntu 24.04 LTS. Docker + compose plugin pre-installed.
- Runner labels: `[self-hosted, linux, x64, freeswitch-host]`.
- systemd unit `actions.runner.<repo>.service` with `Restart=always` per
  Red Hat Developer guide [22]. Auto-update opt-in.
- Network: outbound 443 only; firewall blocks all inbound except SSH from
  admin CIDR.
- Job opt-in: `runs-on: [self-hosted, freeswitch-host]` on the
  `integration` and `load` jobs only. Other jobs unchanged.

### 15.4 ARC on K8s

**Deferred to Phase 4.** Operating a K8s control plane just for runners is
negative ROI for our concurrency. Migration path is `runs-on` label change
only — no workflow restructuring.

---

## 16. Security gates

| Gate | Tool | Workflow | Trigger | Block? | Severity |
|---|---|---|---|---|---|
| Vulnerable deps (PR diff) | `dependency-review-action@v4` | `dependency-review.yml` | PR | yes | `fail-on-severity: high` |
| Vulnerable deps (full inventory) | Dependabot alerts + auto-PRs | (GH native) | continuous | informational | n/a |
| Static code analysis | CodeQL `security-and-quality` | `codeql.yml` | weekly + push:main + PR | informational (PR comment) | high |
| Secret scan (history) | gitleaks v8 | `secrets-scan.yml` | every push + PR | yes | any |
| Secret scan (push event) | GH native | (GH native) | continuous | yes (push protection) | any |
| Container vuln scan | Trivy | `ci.yml::trivy-image` (after `docker` merge) | push:main + tags | yes | HIGH, CRITICAL |
| License compliance (deps) | `dependency-review-action` allow/deny lists | `dependency-review.yml` | PR | yes | denied license |
| License compliance (full tree) | `license-checker-rseidelsohn` (npm) + `go-licenses report` (Go) | `ci.yml::licenses` | nightly | informational (issue) | denied license |
| SBOM | `syft` (CycloneDX) | `_docker.yml::merge` | push:main + tags | informational | n/a |
| Provenance | `actions/attest-build-provenance@v2` | `_docker.yml::merge` | push:main + tags | n/a | n/a |

Configuration files committed during IMPLEMENT:

- `.github/dependency-review-config.yml`
- `.github/codeql/codeql-config.yml` (custom paths-ignored if needed)
- `.gitleaks.toml`
- `.trivyignore` (only if a CVE has a verified mitigation; PR-reviewed)
- `.licenserc.json` (deny list; mirrors §18 below)

---

## 17. Hand-off interfaces (to other modules)

### 17.1 To F01 (Repo Skeleton — already DONE/IN_PLAN)

- `.github/workflows/ci.yml` is the **same file** F01 stubbed; O04 expands
  it. The CI invokes the same Make targets F01 committed (`make lint`,
  `make test`, `make build-images`) so local + CI never drift. New
  composite actions and reusable workflows are additive.
- Versions read from `.tool-versions` (F01-owned) via
  `actions/setup-go@v5` (`go-version-file`) and `actions/setup-node@v6`
  (`node-version-file`). O04 never hardcodes a version.

### 17.2 To O01 (Observability)

- `_integration.yml` and `_docker.yml` push container metrics for build
  durations to a Pushgateway only IF O01 has shipped one. Optional, gated
  by env var presence. No hard dependency.

### 17.3 To O03 (Load Testing)

- `load-nightly.yml` calls `scripts/load-test/run.sh` (O03-owned) and
  reads `spec/modules/O03/baseline.json` for regression thresholds.
- O04 publishes the contract: O03's runner script must accept
  `<scenario> <cps> <duration>` positional args and emit
  `reports/<scenario>-<ts>.{html,csv,json}`. The JSON file must contain
  `{ "p95_ms": ..., "drop_pct": ..., "answered": ..., ...}` for the
  comparison step.

### 17.4 To O05 (Security Baseline)

- O05 owns the actual TLS certs, fail2ban rules, host hardening. O04
  consumes O05's outputs (e.g., bastion SSH key in
  `secrets.STAGING_DEPLOY_SSH_KEY`).
- The OIDC provider + IAM roles in §8 are jointly authored: O04 declares
  the trust policy claims it needs; O05 reviews the IAM permission scope.
  Either module can ship the Terraform first; whoever ships first creates
  `infra/aws/oidc.tf`, the other amends.

### 17.5 To every future module

- Adding a new service (`<svc>`) to CI requires:
  1. New entry in root `docker-compose.yml` with a `healthcheck:` block
     (F01 contract).
  2. New `Dockerfile` under `<svc>/` with `dev`, `builder`, `prod`
     targets.
  3. New entry in the `services` matrix at the top of `ci.yml`'s `docker`
     job.
  4. New entry in `_integration.yml`'s `services` input list.
  5. (Optional) new metrics port wired into Prometheus scrape (O01).

  No workflow internals change. Documented in `spec/runbooks/add-new-service.md`.

---

## 18. Resolutions to RESEARCH §11 open questions

| # | Question | Resolution |
|---|---|---|
| 1 | AWS vs Hetzner | **AWS for Phase 1.** OIDC story is mature, ECR/SSM/RDS are ready. Hetzner remains a future migration target if AWS cost becomes painful (~$200/month threshold). All deploy logic is wrapped in `scripts/deploy/{staging,prod,rollback}.sh` so swapping target = rewrite scripts only, not workflows. **Portability sketch:** the only AWS-specific surfaces are (a) OIDC role assumption, (b) SSM Parameter Store, (c) S3 deploy log. For Hetzner: replace OIDC with Hetzner Cloud token (in GH secrets), replace SSM with HashiCorp Vault or Doppler, replace S3 with Hetzner Object Storage (S3-compatible — same SDK calls). No workflow restructuring. |
| 2 | GitHub org name + GHCR namespace | Placeholder `<org>` used throughout this PLAN. IMPLEMENT phase resolves to actual org name on day 1; mechanical sed-replace. |
| 3 | Slack workspace + channels | Two channels: `#vici2-releases` (deploy success/failure), `#vici2-alerts` (load regression, CI failures on main). Webhook URLs in org-level secret `SLACK_WEBHOOK_URL`. Created during IMPLEMENT once Slack workspace exists. |
| 4 | DBA approver group identity | GH team `@vici2/dba` (currently single member: project lead, until a real DBA joins). SRE team `@vici2/sre` similarly. Both teams created during IMPLEMENT. |
| 5 | Self-hosted runner: provision now or wait? | **Wait.** Phase 1 default = GH-hosted only. Provision only on first integration flake (see §15.2). |
| 6 | FreeSWITCH arm64 buildability | **Try, document if it fails.** `_docker.yml` for FS conditionally produces amd64-only manifest if arm64 build fails (see §5). Decision is visible in the workflow YAML; no hidden fallback. |
| 7 | License denylist scope | **Hard deny: GPL-2.0, GPL-3.0, AGPL-3.0, LGPL-2.0, LGPL-3.0, SSPL-1.0, RSAL.** These are incompatible with our intended OSS+commercial-friendly distribution model. **Allow:** MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, MPL-2.0, Unlicense, 0BSD, CC0-1.0. mod_av (FFmpeg, GPL-tainted) is shipped in the FS image but **dynamically linked at runtime** — this is the standard FreeSWITCH approach and matches the MPL-1.1 license intent. We document this in `spec/legal/freeswitch-licenses.md` (created during IMPLEMENT). Legal sign-off pending; if denied, drop mod_av and rely on g711-only. |
| 8 | CI cost ceiling | Public repo assumed (free GH Actions). If repo is made private: budget cap of $200/month on Actions, with weekly review. Self-hosted ARC migration triggered if we exceed. |
| 9 | Nightly load test environment | **Dedicated `load-staging` env.** Same shape as prod (single small EC2 + RDS), gets fresh deploys before each nightly run. Carrier dummy = SIPp scenario (no real Twilio). Baselines stored in Git. |
| 10 | Merge queue (`merge_group` event) | **Defer.** Small team, low contention. Revisit when we have >3 active contributors. Adding `merge_group` later is a 3-line workflow change. |
| 11 | cosign signing beyond provenance | **Defer.** Provenance attestation covers our verifiability needs. Add cosign in Phase 4 if external consumers need it. |
| 12 | Renovate vs Dependabot | **Stick with Dependabot.** Native GH integration, separate secret store handles supply-chain attack vector cleanly. Switch to Renovate if grouping/scheduling pain shows up (none expected Phase 1). |

---

## 19. Hand-off documentation outline (`HANDOFF.md` produced after IMPLEMENT)

The IMPLEMENT phase will produce `spec/modules/O04/HANDOFF.md` with these
sections (PLAN locks the table of contents now):

1. **What was built** — 1 paragraph summary (7 workflows, 2 reusable, 4
   composites, 3 deploy scripts, 1 PR template, 2 rulesets, 3 IAM roles).
2. **Public interface** — list of workflow file paths, their triggers,
   their required-status names, the env-var contract for SSM Parameter
   Store.
3. **How to add a new service to CI** — 5-step recipe (mirrored in
   `spec/runbooks/add-new-service.md`):
   1. Add service block to `docker-compose.yml` with `healthcheck:`.
   2. Add `Dockerfile` with `dev`/`builder`/`prod` targets.
   3. Add `<svc>` to the `services` matrix in `ci.yml::docker`.
   4. Add `<svc>` to `_integration.yml`'s service list input.
   5. (If exposes metrics) add scrape target to O01's Prometheus config.
4. **Where secrets go** — SSM tree pattern (per §8.3), the 2-line lookup
   helper, link to `spec/runbooks/secrets-rotation.md`.
5. **Rollback log location** — `s3://vici2-deploy-log/<env>.jsonl`,
   schema, retention (forever — small files, audit trail).
6. **Approver group memberships** — `@vici2/sre`, `@vici2/dba`, how to add
   members.
7. **Open issues** — anything discovered during IMPLEMENT but not blocking
   sign-off.
8. **Pointers** — links back to `RESEARCH.md`, this `PLAN.md`,
   `spec/runbooks/{migration-incident, add-new-service, secrets-rotation,
   ci-cost-review}.md`.

---

## 20. File list to be created in IMPLEMENT

**Workflows (top-level):**
- `.github/workflows/ci.yml` (expands the F01 stub)
- `.github/workflows/deploy-staging.yml`
- `.github/workflows/deploy-prod.yml`
- `.github/workflows/load-nightly.yml`
- `.github/workflows/secrets-scan.yml` (replaces F01 stub)
- `.github/workflows/codeql.yml`
- `.github/workflows/dependency-review.yml`
- `.github/workflows/ghcr-retention.yml` (subordinate)
- `.github/workflows/ops-gh-ost-run.yml` (subordinate, manual)

**Reusable workflows:**
- `.github/workflows/_integration.yml`
- `.github/workflows/_docker.yml`

**Composite actions:**
- `.github/actions/setup-monorepo/action.yml`
- `.github/actions/login-ghcr/action.yml`
- `.github/actions/aws-oidc/action.yml`
- `.github/actions/notify-slack/action.yml`

**Configuration:**
- `.github/PULL_REQUEST_TEMPLATE.md`
- `.github/dependency-review-config.yml`
- `.github/codeql/codeql-config.yml`
- `.github/dependabot.yml` (expanded from F01 if present)
- `.gitleaks.toml`
- `.licenserc.json`

**Deploy + ops scripts:**
- `scripts/deploy/staging.sh`
- `scripts/deploy/prod.sh`
- `scripts/deploy/rollback.sh`
- `scripts/ci/check-pr-body.sh`
- `scripts/ci/check-migrations.sh` (referenced by F01's `lint-node`)

**Infra-as-code:**
- `infra/aws/oidc.tf` (OIDC provider + 3 roles + trust policies)
- `infra/aws/ssm.tf` (parameter tree skeleton)
- `infra/aws/s3-deploy-log.tf`
- `infra/github/rulesets.tf` (main + tag rulesets)
- `infra/github/environments.tf` (staging, production, production-migrate, load-staging)
- `infra/github/teams.tf` (sre, dba teams + memberships placeholder)

**Runbooks:**
- `spec/runbooks/add-new-service.md`
- `spec/runbooks/secrets-rotation.md`
- `spec/runbooks/migration-incident.md`
- `spec/runbooks/ci-cost-review.md`
- `spec/runbooks/rollback-procedure.md`

**Legal:**
- `spec/legal/freeswitch-licenses.md`

Total: ~30 new files, mostly small. The two heaviest are `ci.yml`
(~250 lines) and `_docker.yml` (~150 lines).

---

## 21. Test plan (verification of O04 itself)

Per SPEC §3.10 and O04.md's "Verification phase":

1. **CI on PR:** open a no-op PR; all 11 required-status checks must
   complete green within 8 minutes. Merge blocked until green.
2. **Staging deploy:** merge to `main`; `deploy-staging.yml` must fire
   automatically, complete green, smoke-test the staging URL, append to
   the deploy log.
3. **Prod deploy:** push tag `v0.1.0`; `migrate-prod` waits for DBA
   approval; `release-prod` waits for SRE approval (with 5-min wait);
   both complete green; tag is immutable post-creation.
4. **Rollback:** push `v0.1.1` (intentionally broken); after auto-rollback
   triggers, verify deploy-log shows the previous digest re-deployed and
   health-probe returned green within 90s.
5. **Multi-arch:** verify GHCR shows manifest list for `vici2-api:v0.1.0`
   with both `linux/amd64` and `linux/arm64` entries; `gh attestation
   verify` returns success.
6. **PR template:** open a PR with malformed body (no module ID); CI
   `lint-pr-meta` fails with a clear message.
7. **Branch protection:** attempt force-push to `main` from a maintainer
   account; rejected by ruleset.
8. **OIDC:** verify CloudTrail shows STS `AssumeRoleWithWebIdentity` calls
   from the workflow IDs, no static credentials anywhere.
9. **Load nightly:** trigger manually via `gh workflow run load-nightly.yml`;
   verify report artifact uploaded; verify regression issue NOT created
   when no regression; intentionally bump baseline to force a regression
   and verify issue IS created.
10. **License denylist:** open a PR adding a GPL-3 dep; `dep-review` job
    blocks the PR with the denied-license message.

All verification recorded in `spec/modules/O04/VERIFY.md` post-IMPLEMENT.

---

## 22. Acceptance criteria (from O04.md, restated)

- [ ] All CI stages pass on a clean PR.
- [ ] Secrets via OIDC + SSM (never in code, never in GitHub workload secrets).
- [ ] Staging + production environments configured with the right
      reviewers, wait timers, and OIDC role bindings.
- [ ] Rollback works (verified per §21.4).
- [ ] PR template enforces module-id reference (verified per §21.6).
- [ ] Branch protection blocks force-push and unreviewed merges (per §21.7).
- [ ] Multi-arch images built natively, no QEMU (per §21.5).
- [ ] Load-nightly opens issue on regression (per §21.9).
- [ ] License denylist blocks GPL/AGPL/SSPL (per §21.10).

---

End of PLAN.md.
