# Module O04 — CI/CD Pipeline — RESEARCH

**Status:** RESEARCH complete (blocked on F01 for IMPLEMENT)
**Author:** O04 sub-agent
**Date:** 2026-05-06
**Inputs:** DESIGN.md, SPEC.md (§0.1, §3.2, §3.3, §3.10, §3.11, §4), spec/modules/O04.md, plus dependent module specs F01, O01, O03, O05.

---

## 1. Executive summary (10 bullets)

1. **Standardize on GitHub Actions** (not GitLab CI). The repo lives on GitHub; GHCR + Actions OIDC + environments + rulesets give a single-vendor, low-friction stack [1][2]. We adopt **reusable workflows** (`workflow_call`) for pipeline-level reuse (lint, build, deploy) and **composite actions** (`.github/actions/<name>`) for step-level reuse (setup-monorepo, login-ghcr, slack-notify) [1][3].
2. **Pipeline shape: lint → unit → build → integration → docker → staging → prod.** Each stage is a separate job with `needs:` dependencies. Lint+unit run on every push; build+docker run once we hit `main` or a release tag; integration runs on PRs and `main`; staging deploy auto-fires on merge to `main`; prod deploy fires only on a `v*.*.*` tag and is gated by a GitHub Environment with required reviewers [4][5].
3. **Registry: GHCR.** Free for public repos with unlimited bandwidth, native OIDC auth via `GITHUB_TOKEN`, no Docker Hub rate-limit pain, and image visibility tracks repo visibility. ECR is reserved as a future mirror target if we land on AWS for prod [6][7][8].
4. **Multi-arch images: `linux/amd64` primary, `linux/arm64` secondary.** Use **native ARM64 GitHub-hosted runners** (`ubuntu-24.04-arm`) per architecture in a matrix, then merge into a manifest list with `docker buildx imagetools create` — avoids slow QEMU emulation [9][10][11]. Tag strategy via `docker/metadata-action`: `type=sha`, `type=ref,event=branch`, `type=semver,pattern={{version}}|{{major}}.{{minor}}|{{major}}` [12][13].
5. **Secrets via GitHub Encrypted Secrets + OIDC to AWS** (no static `AWS_ACCESS_KEY_ID`/`SECRET` ever). Workflows assume an IAM role via `aws-actions/configure-aws-credentials` against an IAM OIDC provider whose trust policy is locked to our repo + branch claim. Short-lived STS credentials, no rotation burden [14][15][16][17]. For Phase 4 K8s, **Bitnami Sealed-Secrets** lets us commit encrypted Secret manifests to Git so GitOps stays cleanly declarative [18][19].
6. **Self-hosted runner only when needed.** Phase 1 runs all jobs on GitHub-hosted runners. FreeSWITCH integration tests run inside a docker-compose stack that GitHub-hosted Ubuntu runners can stand up (privileged docker is available) [20][21]. If RTP/SIP UDP traffic forces host-network mode and that proves brittle on GH-hosted, we add **one persistent self-hosted runner on a small Linux VM with `host`-network FreeSWITCH** (`SYS_NICE` cap, mounted config) — registered as `self-hosted, linux, freeswitch-host` and consumed only by the integration job [22][23]. K8s/ARC is **explicitly deferred** to Phase 4 — an operator + autoscaling layer is overkill for our concurrency.
7. **Deployment progression decoupled from CI.** Stage 1 = `docker compose -f docker-compose.prod.yml pull && up -d` over SSH on a single VM (MVP). Stage 2 = systemd-managed compose units for restart semantics. Stage 3 (Phase 4) = K8s with Helm/Kustomize + Sealed-Secrets. CI's only requirement: produce signed, multi-arch images with deterministic tags + provenance attestations (`actions/attest-build-provenance`) so any of the three deploy targets can pull [12]. Deploy scripts live under `scripts/deploy/{staging,prod,rollback}.sh`.
8. **Migrations are NEVER auto on prod deploy.** SPEC.md §3.8 + O04 risk register agree. We split `deploy-prod.yml` into two jobs in two environments: `migrate-prod` (runs `prisma migrate deploy` against prod DB, requires a separate manual approval gate, separate IAM role) and `release-prod` (rolls images). Default order is migrate→release; admin can flip with workflow_dispatch input for "expand-then-contract" two-phase migrations [24][25][26]. Staging auto-runs `prisma migrate deploy` on each merge so drift is caught early [27].
9. **Rollback = retag + redeploy previous image digest.** Each successful prod deploy writes the deployed image digest to a small "deployment log" (S3 object or GitHub deployment object). `scripts/deploy/rollback.sh` reads the previous digest, updates `docker-compose.prod.yml` to pin that digest (not tag — tags are mutable), and re-runs `docker compose up -d --no-deps <service>`. **Migration rollback is forward-fix only** (Prisma generates `down` SQL but we never auto-run it on prod — write a forward "fix" migration instead) [28][29][30].
10. **Branch protection + PR template enforced via rulesets + Actions.** `main` requires: 1 PR review, dismiss stale on push, linear history (rebase or squash merge only), required CI status checks (`lint`, `unit`, `build`, `integration-pr`), no direct push, no force push [31][32][33]. PR title validated to match `[<MODULE-ID>] ...` via `amannn/action-semantic-pull-request` (configured with our module-ID regex as a "type") [34]. PR body validated for the `## Module` header + Acceptance checklist via a small `scripts/ci/check-pr-body.sh` grep step. Security gates: `actions/dependency-review-action` (vuln + license), CodeQL (Go + TS), Gitleaks (secret scan), Trivy (image scan), `license-checker` for npm + `go-licenses` for Go (FOSSA-lite). Nightly `load-nightly.yml` (cron `0 2 * * *`) hands off to O03 scenarios, uploads HTML/CSV reports as artifacts, opens an issue on threshold regression [35][36][37].

---

## 2. Workflow stage list with jobs per stage

We implement four top-level workflow files plus reusable "library" workflows in `.github/workflows/_*.yml` (the underscore prefix is convention; GitHub treats them like any other but it signals "internal"). Composite actions live in `.github/actions/<name>/action.yml`.

### 2.1 `.github/workflows/ci.yml` — runs on `pull_request` and `push` to any branch

| Stage | Job (id) | Runner | Triggers | Key steps |
|---|---|---|---|---|
| 1 lint | `lint-go` | `ubuntu-latest` | always | `setup-go` → `golangci-lint run ./...` (cached via `setup-go` built-in) |
| 1 lint | `lint-node` | `ubuntu-latest` | always | `setup-node@v6` w/ `cache: pnpm` → `pnpm install --frozen-lockfile` → `pnpm -r lint` |
| 1 lint | `lint-xml` | `ubuntu-latest` | always | `xmllint --noout freeswitch/conf/**/*.xml` (per SPEC §3.1) |
| 1 lint | `lint-pr-meta` | `ubuntu-latest` | `pull_request` only | `amannn/action-semantic-pull-request@v6` for title; `scripts/ci/check-pr-body.sh` for module-ID + checklist |
| 2 unit | `unit-go` | `ubuntu-latest` | always | `go test -race -coverprofile=cov.out ./...` → upload coverage |
| 2 unit | `unit-node` | `ubuntu-latest` | always | `pnpm -r test:unit -- --coverage` (vitest) |
| 3 build | `build-go` | `ubuntu-latest` | always | `go build ./...`; produces dialer binary artifact |
| 3 build | `build-node` | `ubuntu-latest` | always | `pnpm -r build` (api, web, workers); upload dist artifacts |
| 4 integration | `integration` | `ubuntu-latest` | `pull_request` + `push:main` | reusable workflow `_integration.yml` — see §2.2 |
| 5 docker | `docker` | matrix `[ubuntu-latest, ubuntu-24.04-arm]` | `push:main` + tags | `_docker.yml` reusable workflow — see §2.3 |
| 6 security | `dep-review` | `ubuntu-latest` | `pull_request` | `actions/dependency-review-action@v4` |
| 6 security | `codeql` | `ubuntu-latest` | weekly schedule + `pull_request` | `github/codeql-action/init` for `go,javascript-typescript` → `analyze` |
| 6 security | `gitleaks` | `ubuntu-latest` | always | `gitleaks detect --redact --exit-code 1` |
| 6 security | `licenses` | `ubuntu-latest` | `pull_request` + nightly | `pnpm dlx license-checker-rseidelsohn` (TS) + `go run github.com/google/go-licenses@latest report ./...` |

**Required for branch protection** (must succeed against latest SHA): `lint-go`, `lint-node`, `lint-xml`, `lint-pr-meta`, `unit-go`, `unit-node`, `build-go`, `build-node`, `integration`, `dep-review`, `gitleaks`. CodeQL and license checks gate via PR comment, not block (informational).

### 2.2 `.github/workflows/_integration.yml` — reusable integration test

```
inputs: { fs-image-tag: string, run-load: bool }
jobs:
  integration:
    services: { } # we use docker-compose, NOT GH service containers, because FreeSWITCH needs host networking and dialplan files mounted
    steps:
      1. checkout
      2. setup-node, setup-go (cached)
      3. docker buildx setup (for layer cache via type=gha,scope=integration-* mode=max — pattern proven in somleng-switch [38])
      4. build all images locally (push:false, load:true) using cache-from/cache-to type=gha,scope=integration-<service>
      5. docker compose -f docker-compose.yml -f docker-compose.test.yml up --wait -d
      6. pnpm -r test:integration  &&  go test -tags=integration ./...
      7. on failure: docker compose logs > tmp/<service>.log; upload-artifact tmp/
      8. always: docker compose down --volumes --remove-orphans
```

The `--wait` flag (Compose v2.17+) blocks until each service's healthcheck passes. F01 must ensure every service has a `healthcheck:` block.

### 2.3 `.github/workflows/_docker.yml` — reusable multi-arch build & push

```
inputs: { service: string (api|dialer|workers|web|freeswitch), push: bool }
jobs:
  build:
    strategy:
      matrix:
        include:
          - { runner: ubuntu-latest,    platform: linux/amd64, suffix: amd64 }
          - { runner: ubuntu-24.04-arm, platform: linux/arm64, suffix: arm64 }
    runs-on: ${{ matrix.runner }}
    permissions: { contents: read, packages: write, id-token: write, attestations: write }
    steps:
      1. checkout
      2. docker/setup-buildx-action@v4
      3. docker/login-action@v4 (registry: ghcr.io, password: GITHUB_TOKEN)
      4. docker/metadata-action@v6 → tags from {{sha}}, branch, semver
      5. docker/build-push-action@v7 with platforms=${{ matrix.platform }}, cache-from/to type=gha,scope=${{ inputs.service }}-${{ matrix.suffix }}, outputs=type=image,push-by-digest=true,name-canonical=true
      6. export digest to /tmp/digests/<arch>/<digest>
      7. upload-artifact digests-${{ matrix.suffix }}
  merge:
    needs: build
    runs-on: ubuntu-latest
    steps:
      1. download-artifact digests-*
      2. docker/setup-buildx-action
      3. docker/login-action ghcr
      4. docker buildx imagetools create $(jq -cr '.tags | map("-t " + .) | join(" ")' <<< "$DOCKER_METADATA_OUTPUT_JSON") $(printf 'ghcr.io/<org>/<service>@sha256:%s ' *)
      5. actions/attest-build-provenance@v2 with subject-name + subject-digest
```

This pattern (split-build → merge-manifest) is the 2025 standard from Docker docs and is already in production at AWS, FratelloBigio, and somleng-switch [9][10][11][38].

### 2.4 `.github/workflows/deploy-staging.yml` — runs on `push: main`

```
on: { push: { branches: [main] } }
concurrency: { group: deploy-staging, cancel-in-progress: false }
jobs:
  deploy:
    environment:
      name: staging
      url: https://staging.vici2.example
    runs-on: ubuntu-latest
    permissions: { id-token: write, contents: read }
    steps:
      1. configure-aws-credentials (OIDC, role: arn:aws:iam::ACCT:role/vici2-staging-deploy)
      2. SSM run-command OR ssh into staging VM:
           docker compose -f docker-compose.prod.yml pull
           pnpm exec prisma migrate deploy           # staging auto-migrates
           docker compose -f docker-compose.prod.yml up -d --remove-orphans
      3. smoke test: curl https://staging.vici2.example/health, /metrics, websocket handshake
      4. record deployed digests to S3 deploy-log
      5. on failure: auto-rollback (call rollback.sh with previous digest)
```

### 2.5 `.github/workflows/deploy-prod.yml` — runs on `push: tags: 'v*.*.*'`

```
on: { push: { tags: ['v*.*.*'] } }
concurrency: { group: deploy-prod, cancel-in-progress: false }
jobs:
  migrate-prod:
    environment:
      name: prod-migrate            # required reviewers: 1 from @vici2/dba
      url: https://vici2.example/admin/migrations
    if: ${{ inputs.skip-migrate != 'true' }}    # workflow_dispatch escape hatch
    steps:
      1. configure-aws-credentials (role: vici2-prod-migrate, scoped to RDS connect only)
      2. pnpm exec prisma migrate status     # show what will run, fail if drift
      3. pnpm exec prisma migrate deploy
      4. notify slack #releases
  release-prod:
    needs: migrate-prod
    environment:
      name: prod                    # required reviewers: 1 from @vici2/sre, prevent self-review, 5-min wait timer
      url: https://vici2.example
    steps:
      1. configure-aws-credentials (role: vici2-prod-deploy)
      2. resolve image digests for the tag
      3. update docker-compose.prod.yml to pin digests
      4. ssh + docker compose pull && up -d
      5. health probe loop (60s timeout; auto-rollback on fail)
      6. record digests to deploy-log; create GitHub deployment object (success)
      7. notify slack
```

### 2.6 `.github/workflows/load-nightly.yml` — `schedule: cron 0 2 * * *`

```
on:
  schedule: [{ cron: '0 2 * * *' }]    # 02:00 UTC
  workflow_dispatch: {}
jobs:
  load:
    runs-on: ubuntu-latest                 # may move to self-hosted if SIPp packet rates hurt
    steps:
      1. checkout
      2. docker compose up the staging-mirror stack
      3. scripts/load-test/run.sh answer 50 600   # O03 scenario: 50 cps, 600s
      4. scripts/load-test/run.sh predictive 100 600
      5. upload-artifact reports/*.html
      6. compare against baseline (jq); if regression > 10% on p95 or drop%: actions/github-script create issue tagged 'load-regression'
```

The "create issue on failure" pattern is borrowed from open-telemetry/opentelemetry-operator's `e2e-nightly.yaml` [35].

### 2.7 Composite actions catalog

- `.github/actions/setup-monorepo/action.yml` — checkout, setup-go (cached), setup-node@v6 with pnpm cache, restore Go module + build cache. Used by every TS/Go job.
- `.github/actions/login-ghcr/action.yml` — wraps docker/login-action@v4 with `registry: ghcr.io`, `username: ${{ github.actor }}`, `password: ${{ env.GITHUB_TOKEN }}`.
- `.github/actions/aws-oidc/action.yml` — wraps configure-aws-credentials with our `role-to-assume` input, audience locked to `sts.amazonaws.com`.
- `.github/actions/notify-slack/action.yml` — Slack webhook on success/failure, posts run URL + commit SHA.

---

## 3. Runner topology — GitHub-hosted vs self-hosted

| Job | Runner | Why |
|---|---|---|
| lint, unit, build | `ubuntu-latest` (GH-hosted) | Cheap, parallel, ephemeral. SPEC §3.1 has no syscalls that need a real kernel. |
| integration | `ubuntu-latest` (GH-hosted) | GH-hosted Ubuntu runners support Docker-in-docker / privileged containers and host-network containers; the somleng-switch project [38] proves a full FreeSWITCH+Postgres+OpenSIPS integration suite runs fine on stock `ubuntu-latest`. Risk: WebRTC/SIP UDP into FS may fail under nested-container NAT. **Mitigation:** if integration job becomes flaky, fall back to one self-hosted Linux VM (see below). |
| docker (amd64) | `ubuntu-latest` | native |
| docker (arm64) | `ubuntu-24.04-arm` | native ARM64 GH-hosted runner — public since 2025-01, free for public repos [10][11]. Avoid QEMU. |
| codeql | `ubuntu-latest` | per CodeQL action defaults |
| deploy-staging, deploy-prod | `ubuntu-latest` | only runs SSH/SSM commands |
| load-nightly | `ubuntu-latest` initially; **move to self-hosted** if SIPp packet rates exceed runner NIC capacity | tail behavior |

### 3.1 Self-hosted fallback design

If integration tests prove unreliable on GH-hosted, we provision **one persistent self-hosted runner** on a small Hetzner CCX13 / AWS t3.medium VM:

- OS: Ubuntu 24.04 LTS, kernel ≥ 6.8.
- Docker + docker compose; FS image from `freeswitch/conf/Dockerfile` pre-pulled.
- Runner registered at the **repo** level (Phase 1 single-tenant) via `actions/runner` token; labels: `self-hosted, linux, x64, freeswitch-host`.
- Run as systemd service (`actions.runner.<repo>.service`) with `Restart=always` per Red Hat Developer guide [22].
- Auto-update opt-in (default).
- Network: outbound 443 only; firewall blocks all inbound except SSH from admin CIDR.
- Job consumes via `runs-on: [self-hosted, freeswitch-host]`.
- **NOT used for arbitrary builds** — explicitly scoped to integration + load.

**Why not ARC on K8s?** ARC is excellent for fleets >10 runners with bursty workflows [2][39][40]. Our workload is one nightly load test + occasional integration. Operating a K8s control plane just for runners is negative ROI until Phase 4. We can adopt ARC later without changing any workflow YAML — only the `runs-on` label set.

---

## 4. Registry + image tagging strategy

### 4.1 Registry: GHCR

Choice based on a multi-axis comparison [6][7][8]:

| Axis | GHCR | Docker Hub | ECR |
|---|---|---|---|
| Free for public OSS | unlimited | rate-limited (100 pulls/6hr unauth) | 50 GB then $0.10/GB |
| GH Actions auth | automatic via `GITHUB_TOKEN` | requires PAT secret | requires OIDC role |
| Image visibility | tracks repo | manual | IAM |
| OIDC support | yes | no | yes |
| Lifecycle policies | retention via repo packages UI | none on free | yes (built-in) |

Phase 1 winner = GHCR. Phase 4 if we land on EKS we can mirror selected tags to ECR via a scheduled `docker buildx imagetools create --tag <ecr>...` job — no rebuild, just retag.

### 4.2 Image namespace

`ghcr.io/<github-org>/vici2-<service>:<tag>` where `<service>` ∈ `{api, dialer, workers, web, freeswitch}`. Names lowercased per OCI spec.

### 4.3 Tag set (via `docker/metadata-action@v6`) [12][13][41]

For every successful build on `main` and tags:

```yaml
tags: |
  type=sha                                  # sha-abc1234 (immutable, used by deploy)
  type=ref,event=branch                     # main  (mutable, latest-on-branch)
  type=ref,event=pr                         # pr-123 (PR preview, not pushed unless flagged)
  type=semver,pattern={{version}}           # 1.2.3 (only on tag push)
  type=semver,pattern={{major}}.{{minor}}   # 1.2
  type=semver,pattern={{major}}             # 1
  type=raw,value=latest,enable={{is_default_branch}}
```

PR builds: `push: false`, only built locally (validates Dockerfile). `main` builds: pushed with `sha-*` and `main` tags. Tag pushes (`v1.2.3`): pushed with full semver set + `latest`.

### 4.4 Immutability + provenance

- Production deploy **always pins by digest** (`@sha256:...`), never tag, per cr0x.net [28] and Flux sortable-tag guidance [41]. Tags are mutable; digests aren't.
- Each push builds a **provenance attestation** with `actions/attest-build-provenance@v2` so consumers can verify the image came from this repo at this SHA [12]. SLSA Level 3 by default for GH-hosted runners.
- We do NOT enable GHCR's "immutable tags" flag (not supported on GHCR as of 2026-05); discipline + digest pinning achieves the same outcome.

### 4.5 Retention

GHCR retention via repo Packages settings: keep all `v*` tags forever, keep `main` tag forever, keep last 30 `sha-*` tags, prune everything else after 60 days. Configured via GitHub UI or `actions/delete-package-versions` scheduled cron.

---

## 5. Secrets + OIDC strategy

### 5.1 Three secret tiers

| Tier | Storage | Examples | Access |
|---|---|---|---|
| **Repo secrets** | GitHub Encrypted Secrets (org level when possible) | Slack webhook, Sentry DSN, Snyk token | All workflows |
| **Environment secrets** | GitHub Environments (`staging`, `prod`, `prod-migrate`) | Deploy SSH key, SSM region | Only jobs declaring `environment:` |
| **Workload-runtime secrets** | NEVER in GitHub. AWS SSM Parameter Store / Secrets Manager (resolved at container start) | DB password, JWT signing key, carrier creds, KEK | App reads from env at boot |

Per SPEC §3.7, app envelope-encrypts DB-resident secrets (carrier creds) using a KEK from env; KEK itself comes from SSM at boot. CI never sees the KEK.

### 5.2 OIDC trust to AWS [14][15][16][17]

One-time setup (Terraform module under `infra/aws/oidc.tf`):

1. Create IAM OIDC provider for `https://token.actions.githubusercontent.com` with audience `sts.amazonaws.com`.
2. Create three IAM roles, each with a trust policy locked by `sub` claim:
   - `vici2-staging-deploy` — trusts `repo:<org>/vici2:ref:refs/heads/main` (only main branch).
   - `vici2-prod-deploy` — trusts `repo:<org>/vici2:ref:refs/tags/v*` (only tag pushes).
   - `vici2-prod-migrate` — trusts the same as `prod-deploy` AND `environment:prod-migrate` (so it only fires from the gated job).
3. Attach least-privilege policies (RDS connect for migrate; ECR push, SSM run-command, S3 deploy-log write for deploy).

Workflow side (5 lines) [16]:

```yaml
permissions:
  id-token: write
  contents: read
- uses: aws-actions/configure-aws-credentials@v6
  with:
    role-to-assume: arn:aws:iam::ACCT:role/vici2-prod-deploy
    aws-region: us-east-1
```

No long-lived AWS credentials anywhere in the repo or in GitHub. OIDC tokens are 15-min-1hr STS, gone after the job.

### 5.3 Sealed-Secrets for K8s (Phase 4)

When (if) we land on K8s, encrypted Secret manifests live in `infra/k8s/secrets/*.sealed.yaml`. CI pipeline applies via Argo CD or Flux. Sealing key lives only in cluster; CI uses `kubeseal --fetch-cert` to encrypt new secrets [18][19][42]. **Zero plaintext secrets in Git, ever.**

### 5.4 Dependabot quirk

Dependabot PRs run with read-only `GITHUB_TOKEN` and use a **separate** secret store (`Dependabot secrets`) — repo Actions secrets are NOT visible [43]. Our deploy workflows must therefore not be triggered by Dependabot's `pull_request` events; we already gate them on `push: main` / `push: tags`.

---

## 6. Deployment targets — keep portable

We optimize CI to produce **artifacts**, not deployments. Three target shapes share one image set:

| Target | When | Mechanism |
|---|---|---|
| **Compose-on-VM** (MVP, Phase 1) | now | `docker compose pull && up -d` over SSH. `docker-compose.prod.yml` references digests written into the file by deploy script. Works on Hetzner CX22 / AWS t3.small. |
| **systemd + compose** (Phase 1.5) | post-MVP | Replace `nohup`/restart loops with `systemd` unit `vici2.service` that runs `docker compose up`. Restart-on-failure built in. Same image set. |
| **Kubernetes** (Phase 4) | future | Helm chart consumes the same digests via values.yaml. Sealed-Secrets for runtime secrets. ARC for runners. |

CI itself **only** speaks to "the deploy script". Swapping target = rewriting `scripts/deploy/{staging,prod,rollback}.sh`, not the workflows. Specifically:

- No K8s manifests in `.github/workflows/`.
- No compose-specific assumptions in `_docker.yml` (multi-arch images run anywhere).
- `deploy-prod.yml` calls `scripts/deploy/prod.sh "$IMAGE_DIGEST"`; the script's internals are the only thing that changes.

---

## 7. Migration handling on deploy

### 7.1 Hard rules (per SPEC §3.8 + O04 risk register)

- Migrations are **separate jobs** with a **separate environment** (`prod-migrate`) and **separate IAM role** (only RDS-connect, no ECR/SSM).
- Migrations have a **separate manual approval gate** distinct from the deploy approval. The DBA approves migrate; SRE approves release.
- **Default order: migrate first, then release** — but the workflow exposes `inputs.migrate-first: bool` for the rare "expand-then-contract" two-phase migration where you ship code that supports both schemas, run the migration that drops the old column later.
- Migrations on prod are **NEVER auto-rolled-back**. If `prisma migrate deploy` fails partway, alert the on-call DBA and write a forward fix [25][27]. Long-running migrations on big tables must be online-schema-change scripts (gh-ost / pt-osc) per SPEC §3.8 — those are `workflow_dispatch` only, not part of the deploy pipeline.
- Staging migrations **DO auto-run** on every merge to `main` (so drift is caught daily), no approval gate. Prisma's advisory locking [25] prevents concurrent runs from racing.

### 7.2 Drift detection

Before every prod migrate, run `prisma migrate status`. If output reports drift or unapplied-but-modified migrations, fail the job before applying [24][25]. Forces an investigation rather than a silent reapply.

### 7.3 Reversibility

SPEC §3.8 already mandates every Prisma migration ship a hand-written `down.sql`. PR linter (`scripts/ci/check-migrations.sh`) enforces that any new file under `api/prisma/migrations/*/migration.sql` has a sibling `down.sql`.

---

## 8. Rollback procedure

### 8.1 Image rollback (covers ~95% of bad-deploy cases)

1. `scripts/deploy/staging.sh` and `prod.sh`, on success, append a JSON line to `s3://vici2-deploy-log/<env>.jsonl`:
   ```json
   {"ts":"2026-05-06T14:32:11Z","tag":"v1.2.3","digests":{"api":"sha256:abc...","dialer":"sha256:def..."}}
   ```
2. `scripts/deploy/rollback.sh <env>`:
   - Reads the **second-to-last** line (last good = previous deploy).
   - Updates `docker-compose.prod.yml` to pin those digests via `sed`-replace (per cr0x.net pattern [28]).
   - `docker compose pull` (digests are immutable, pull is idempotent).
   - `docker compose up -d --no-deps <each-service>` to recreate without touching deps.
   - Health probe loop; if not green in 90s, alert and abort.
3. `deploy-prod.yml` invokes `rollback.sh` automatically on health-check failure of the new deploy. Manual invocation: `gh workflow run deploy-prod.yml -f rollback=true -f target-tag=v1.2.2`.

### 8.2 Why digest-pin not tag-revert

Tags are mutable. `vici2-api:v1.2.2` could have been overwritten (it shouldn't, but safety in depth). Digest is content-addressed [28][29][30][41].

### 8.3 Schema rollback

**Forward fix only** for prod. DBA writes a new migration that undoes the bad change, runs through normal `prod-migrate` gate. Document this in `spec/runbooks/migration-incident.md`.

### 8.4 Blue/green optional

Phase 2 if we hit revenue-impacting downtime: introduce Traefik-fronted blue/green via two compose services (`api-blue`, `api-green`) [44][45]. Deploy script flips the upstream label and waits drain. Phase 1 single-replace is fine — agents can tolerate a 30s blip during deploy if scheduled in low-volume window.

---

## 9. Security gates (deps, code scan, secret scan)

| Gate | Tool | Trigger | Block-PR? | Notes |
|---|---|---|---|---|
| Vulnerable dependencies (PR diff) | `actions/dependency-review-action@v4` | `pull_request` | **yes**, `fail-on-severity: high` | Free on public; uses GH advisory DB [46][47] |
| Vulnerable dependencies (full inventory) | Dependabot alerts + Dependabot security PRs | continuous | informational | Auto-PR, runs CI; merge after green [43] |
| Static code analysis | CodeQL (`security-and-quality` suite) | weekly + pull_request | informational | Languages: `go`, `javascript-typescript` [48][49] |
| Secret scan | GH native secret scanning + `gitleaks` step | always | **yes** on gitleaks | Catches non-OAuth secrets GH misses [50] |
| Container vuln scan | Trivy (after image build) | `push:main`, tags | **yes**, `fail-on: HIGH,CRITICAL` | Run as part of `_docker.yml` after merge step |
| License compliance | `dependency-review-action` allow-list + `license-checker` (npm) + `go-licenses` (Go) | PR + nightly | **yes** | Allowed: MIT, Apache-2.0, BSD-2/3, ISC, MPL-2.0. Denied: AGPL, GPL-3.0, LGPL-2.0 (anything copyleft for our binaries). Per [46][51][52]. |
| SBOM | `actions/attest-sbom` + `cyclonedx` | on tag | informational | Attached to release artifacts |

Configuration lives in `.github/workflows/security.yml` (CodeQL + Trivy + nightly licenses) and `.github/dependency-review-config.yml`.

---

## 10. Branch protection rules

Implemented as **rulesets** (preferred over legacy "branch protection rules" since 2024) [31][32][33] targeting `main`:

```yaml
target: main
rules:
  pull_request:
    required_approvals: 1
    dismiss_stale_reviews_on_push: true
    require_code_owner_review: false        # too small a team for codeowners pain
    require_last_push_approval: true         # someone-other-than-last-pusher must approve
    require_review_thread_resolution: true
  required_status_checks:
    strict: true                             # branch must be up-to-date with main
    checks:
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
  required_linear_history: true             # squash or rebase merge only — clean bisect
  required_signatures: false                # Phase 4 turn on (SSH-signed commits)
  non_fast_forward: true                    # blocks force-push
  deletion: false
  enforce_admins: true                      # admins can't bypass without ruleset edit
```

Tag protection ruleset on `v*.*.*`:

```yaml
target_tags: 'v*.*.*'
rules:
  creation: bypass=[role:maintainer]
  deletion: false
  update: false                              # immutable tags
```

---

## 11. Open questions for PLAN

1. **Where does prod live?** Hetzner / AWS EC2 / DigitalOcean droplet. Affects whether OIDC→AWS or OIDC→Hashicorp Vault. Default assumption: AWS. Confirm before writing IAM role Terraform.
2. **GitHub org name + ownership of GHCR namespace.** Name affects workflow image strings.
3. **Slack workspace + channel for #releases / #alerts.** Need webhook URLs in repo secrets.
4. **DBA approver group identity.** Who is on `@vici2/dba` for prod-migrate environment?
5. **Self-hosted runner: provision now or wait?** Rec: wait until first integration flake. F03/T01/T04 must merge first to know.
6. **Multi-arch for FreeSWITCH image:** does FS 1.10 build cleanly on `linux/arm64`? `signalwire/freeswitch` images are amd64-only; we may need a custom Alpine-based ARM build (PatrickBaus does this) [53]. **Decision needed before docker matrix is defined.**
7. **License denylist scope.** Strictly deny AGPL? FreeSWITCH itself is MPL-1.1 (allowed) but mod_av (ffmpeg) drags GPL transitively. Need legal sign-off on what we ship in the FreeSWITCH image vs link to.
8. **CI cost ceiling for public repo:** GH Actions on public repos is free but ARM64 minutes count for self-hosted-equivalent. Confirm OSS or private repo.
9. **Nightly load test environment:** dedicated "load-staging" with same shape as prod, or run against staging itself? Affects Carrier dummy config.
10. **Do we want merge queues** (`merge_group` event)? Worth the complexity once we have >2 contributors. Defer to PLAN.
11. **Image signing beyond provenance:** add `cosign sign --keyless` for public verifiability? Provenance attestations cover most use cases; cosign adds signature-on-pull. Defer.
12. **Renovate vs Dependabot.** Dependabot handles npm + go modules + GitHub Actions versions cleanly; Renovate is more flexible (e.g., grouping). Stick with Dependabot for Phase 1 simplicity unless a sharp pain shows up.

---

## 12. Citations

[1] GitHub Docs — Reusing workflow configurations: <https://docs.github.com/en/actions/concepts/workflows-and-actions/reusing-workflow-configurations>
[2] GitHub Docs — Avoiding duplication / reusable workflows vs composite actions: <https://docs.github.com/en/actions/concepts/workflows-and-actions/avoiding-duplication>
[3] GitHub Docs — Creating a composite action: <https://docs.github.com/actions/tutorials/creating-a-composite-action>
[4] GitHub Docs — Deployments and environments (protection rules): <https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments>
[5] GitHub Docs — Reviewing deployments / required reviewers: <https://docs.github.com/en/actions/how-tos/managing-workflow-runs-and-deployments/managing-deployments/reviewing-deployments>
[6] DevOpsBoys — GHCR vs Docker Hub vs ECR (2026): <https://devopsboys.com/blog/ghcr-vs-docker-hub-vs-ecr-comparison-2026>
[7] JFrog — Comparing Docker Hub and GitHub Container Registry: <https://jfrog.com/devops-tools/article/comparing-docker-hub-and-github-container-registry>
[8] Deckrun — Container registry comparison and rate-limit pain: <https://deckrun.com/blog/where-my-container-images-live-and-why>
[9] Docker Docs — Multi-platform image with GitHub Actions: <https://docs.docker.com/build/ci/github-actions/multi-platform/>
[10] sredevops.org — Native GitHub Runners for multi-arch (no QEMU): <https://www.sredevops.org/en/kiss-goodbye-to-qemu-unleash-the-power-of-native-github-runners-for-multi-arch-docker-images/>
[11] OneUptime — Multi-platform Docker builds in GitHub Actions, native ARM64 runners: <https://oneuptime.com/blog/post/2025-12-20-multi-platform-docker-builds-github-actions/view>
[12] Medium / Jared Hatfield — Semantic versioned Docker images to GHCR with attestations: <https://medium.com/@jaredhatfield/publishing-semantic-versioned-docker-images-to-github-packages-using-github-actions-ebe88fa74522>
[13] docker/metadata-action README: <https://github.com/docker/metadata-action/>
[14] GitHub Docs — Configuring OpenID Connect in AWS: <https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws>
[15] habibiops.com — GitHub Actions AWS Deploy using OIDC: <https://habibiops.com/p/github-actions-aws-deploy-using-oidc/>
[16] marzouk.io — Keyless AWS deployments from GitHub Actions with OIDC: <https://marzouk.io/posts/github-aws-oidc>
[17] freecodecamp — How to set up OIDC in GitHub Actions for AWS: <https://www.freecodecamp.org/news/how-to-set-up-openid-connect-oidc-in-github-actions-for-aws/>
[18] bitnami-labs/sealed-secrets README: <https://github.com/bitnami-labs/sealed-secrets>
[19] FluxCD — Sealed Secrets guide: <https://fluxcd.io/flux/guides/sealed-secrets>
[20] adambirds/docker-compose-action README: <https://github.com/adambirds/docker-compose-action>
[21] Kashif Soofi — Integration test Postgres using docker-compose and GitHub Actions: <https://kashifsoofi.github.io/integrationtest/postgres/ci/integration-test-postgres-using-docker-compose-and-github-actions/>
[22] Red Hat Developer — End-to-end testing with self-hosted runners: <https://developers.redhat.com/articles/2023/07/25/end-end-testing-self-hosted-runners-github-actions>
[23] PatrickBaus/freeswitch-docker — host-network FS Docker example: <https://github.com/PatrickBaus/freeswitch-docker>
[24] Prisma Docs — `prisma migrate deploy`: <https://www.prisma.io/docs/cli/migrate/deploy>
[25] Prisma Docs — Development and production / advisory locking: <https://www.prisma.io/docs/orm/prisma-migrate/workflows/development-and-production>
[26] Prisma Docs — Mental model for Prisma Migrate: <http://prisma.io/docs/orm/prisma-migrate/understanding-prisma-migrate/mental-model>
[27] Basedash — How to automate Prisma migrations in CI/CD: <https://www.basedash.com/blog/how-to-automate-prisma-migrations-in-a-ci-cd-pipeline>
[28] cr0x.net — Docker Compose Rollback: the fastest path back: <https://cr0x.net/en/docker-compose-rollback-fast-path/>
[29] Simplified.guide — Roll back a Docker Compose update: <https://www.simplified.guide/docker/compose-rollback-update>
[30] patternhelloworld/docker-blue-green-runner rollback.sh: <https://github.com/patternhelloworld/docker-blue-green-runner/blob/main/rollback.sh>
[31] GitHub Docs — Available rules for rulesets: <https://docs.github.com/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets>
[32] GitHub Docs — Managing branch protection rules: <https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/managing-a-branch-protection-rule>
[33] McGinnis — Practical guide to GitHub branch protection rules (2026): <https://mcginniscommawill.com/posts/2026-03-24-github-branch-protection-deep-dive/>
[34] amannn/action-semantic-pull-request: <https://github.com/amannn/action-semantic-pull-request>
[35] open-telemetry/opentelemetry-operator e2e-nightly.yaml — auto-issue on regression: <https://github.com/open-telemetry/opentelemetry-operator/blob/main/.github/workflows/e2e-nightly.yaml>
[36] Artillery docs — scheduled load tests on GitHub Actions: <https://artillery.io/docs/cicd/github-actions>
[37] ta4ilka69/locust-github-action — load test thresholds + artifact upload: <https://github.com/ta4ilka69/locust-github-action>
[38] somleng/somleng-switch — production FreeSWITCH integration_tests.yml: <https://github.com/somleng/somleng-switch/blob/develop/.github/workflows/integration_tests.yml>
[39] actions/actions-runner-controller (ARC): <https://github.com/actions/actions-runner-controller>
[40] ARC — Autoscaling Runner Scale Sets mode: <https://github.com/actions/actions-runner-controller/blob/master/docs/gha-runner-scale-set-controller/README.md>
[41] FluxCD — Sortable image tags for automation: <https://fluxcd.io/flux/guides/sortable-image-tags>
[42] KodeKloud — Bitnami Sealed Secrets with ArgoCD: <https://notes.kodekloud.com/docs/GitOps-with-ArgoCD/ArgoCD-AdvancedAdmin/Bitnami-Sealed-Secrets>
[43] GitHub Docs — Dependabot on GitHub Actions (read-only token, separate secrets): <https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-on-actions>
[44] OneUptime — Update running containers without downtime (blue/green w/ Traefik): <https://oneuptime.com/blog/post/2026-01-06-docker-update-without-downtime/view>
[45] Ritesh Rana — Blue/green deployments with Docker Compose: <https://blog.riteshrana.engineer/posts/unlocking-seamless-rollbacks-bluegreen-deployments-with-docker-compose/>
[46] GitHub Docs — Configuring the dependency review action (license + severity): <https://docs.github.com/en/code-security/supply-chain-security/understanding-your-software-supply-chain/configuring-the-dependency-review-action>
[47] GitHub Docs — About dependency review: <https://docs.github.com/en/code-security/concepts/supply-chain-security/about-dependency-review>
[48] github/codeql-action: <https://github.com/github/codeql-action/>
[49] GitHub Docs — Workflow configuration for code scanning (CodeQL): <https://docs.github.com/en/code-security/how-tos/scan-code-for-vulnerabilities/configure-code-scanning/customizing-your-advanced-setup-for-code-scanning>
[50] Cyber-security-in-plain-english — Scanning code for vulnerabilities with GitHub Actions (gitleaks, Trivy, CodeQL): <https://cyber-security-in-plain-english.com/post/developers/tools/how-to-scan-your-codebase-for-vulnerabilities-with-github-actions>
[51] erisu/license-checker-action (npm SPDX audit): <https://github.com/erisu/license-checker-action>
[52] Go License Checker action: <https://github.com/marketplace/actions/go-license-checker>
[53] Docker Docs — GitHub Actions cache (`type=gha`, mode/scope semantics): <https://docs.docker.com/build/cache/backends/gha/>
[54] GitHub actions/cache — dependency caching reference: <https://github.com/actions/cache>
[55] FratelloBigio — Docker multi-arch builds on GitHub Actions (split runners + manifest merge): <https://fratellobigio.com/posts/docker-multi-arch-builds-on-github-actions/>
[56] Stephan Meijer — Manual approvals in GitHub Actions: <https://meijer.works/articles/manual-approvals-in-github-actions>
[57] GitHub Docs — Managing environments for deployment: <https://aka.ms/manage-deployment>

---

**End RESEARCH.md.** Next phase = PLAN (blocked on F01 done, plus answers to §11 open questions). PLAN will produce concrete YAML for `ci.yml`, `deploy-staging.yml`, `deploy-prod.yml`, `load-nightly.yml`, plus `scripts/deploy/*.sh`, `.github/PULL_REQUEST_TEMPLATE.md`, `.github/dependabot.yml`, `.github/dependency-review-config.yml`, and the rulesets-as-code Terraform under `infra/github/rulesets.tf`.
