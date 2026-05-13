# O04 — HANDOFF

**Module:** O04 — CI/CD Pipelines
**Status:** PARTIAL — per-PR + per-tag CI surface DONE; deploy + AWS/OIDC
surface DEFERRED to a follow-on PR (see §7).
**Date:** 2026-05-13
**Companions:** [PLAN.md](./PLAN.md), [RESEARCH.md](./RESEARCH.md),
[VERIFY.md](./VERIFY.md)

---

## 1. What was built

Five GitHub Actions workflows, one dependabot config, one CODEOWNERS file,
two CI helper scripts, six new `make` targets, one migration grandfather
list, plus this and the VERIFY doc:

| File | Purpose |
|---|---|
| `.github/workflows/ci.yml` | Per-PR + per-main-push lint/typecheck/test/build matrix. Replaces the F01 stub. |
| `.github/workflows/build.yml` | Per-main-push + per-tag image build → GHCR with SBOM + SLSA provenance. |
| `.github/workflows/release.yml` | Per-tag GitHub Release assembly (digest manifest, changelog). |
| `.github/workflows/security.yml` | gitleaks + Trivy fs/config/image + dep-review + scheduled SBOM. |
| `.github/workflows/secrets-scan.yml` | (Unchanged from F01) standalone gitleaks; security.yml runs the same scan but on a wider trigger surface. |
| `.github/dependabot.yml` | Weekly updates for pnpm, gomod, GH Actions, Docker base images. |
| `.github/CODEOWNERS` | Auto-review-requests for CI/Docker/Prisma/FS areas. |
| `scripts/ci/check-pr-body.sh` | Verifies PR description has `## Module <id>`, `## Test plan`, `## Compliance impact`. |
| `scripts/ci/check-migrations.sh` | Verifies every Prisma migration has a sibling `down.sql` (grandfather list for legacy F02 migrations). |
| `api/prisma/migrations/.no-down-sql-allowlist` | Grandfather list — backfill or replace each entry over time. |
| `Makefile` (+6 targets) | `ci`, `ci-lint`, `ci-test`, `ci-migrations`, `ci-actionlint`, `ci-workflows`. |
| `spec/modules/O04/VERIFY.md` | Local validation transcript + workflow logic walkthroughs. |
| `spec/modules/O04/HANDOFF.md` | This file. |

---

## 2. Workflow inventory — triggers, jobs, required-status names

### `ci.yml`

- **Triggers:** `push: main`, `pull_request: main`.
- **Concurrency:** `ci-${{ github.workflow }}-${{ github.ref }}`, cancel-in-progress on PRs only.
- **Jobs (parallel):** `lint-go`, `lint-node`, `lint-xml`, `lint-tenant-index`, `lint-commits`*, `lint-pr-meta`*, `migrations-reversible`, `unit-go`, `unit-node`, `build-images`, `ci-pass` (aggregator).
- (\* = PR-only)
- **Required-status to set in branch protection:** `ci-pass` alone is sufficient (it aggregates all hard-required jobs). Optionally add `lint-pr-meta` and `lint-commits` if you want them surfaced individually.

### `build.yml`

- **Triggers:** `push: main`, `push: tags v*.*.*`, `workflow_dispatch`.
- **Jobs:** `build-service` (matrix `[api, dialer, workers, web]`), `build-freeswitch` (skipped without `SIGNALWIRE_TOKEN`).
- **Pushes to:** `ghcr.io/<owner>/vici2-<service>:{sha-<short>, <branch>, <semver>, latest}`
- **Permissions:** `contents: read, packages: write, id-token: write, attestations: write`.
- **NOT a branch-protection requirement** — runs after merge.

### `release.yml`

- **Trigger:** `push: tags v*.*.*` (+ `workflow_dispatch` with `tag` input).
- **Jobs:** `collect` — resolves GHCR digests, generates release notes, creates GitHub Release.
- **Permissions:** `contents: write, packages: read, id-token: write, attestations: write`.
- **Concurrency:** never cancels in-progress release runs.

### `security.yml`

- **Triggers:** `push: main`, `pull_request: main`, `schedule: '0 7 * * 1'`, `workflow_dispatch`.
- **Jobs:** `gitleaks`, `trivy-fs`, `trivy-config`, `trivy-image` (sched/manual), `sbom-repo` (sched/manual), `dependency-review` (PR-only).
- **SARIF uploads** land in GitHub Security tab.
- **Required-status:** `dependency-review` is recommended in branch protection (license deny + high-severity vuln gate).

### `secrets-scan.yml`

- F01 stub; runs gitleaks on push:main + PR. `security.yml::gitleaks` covers the same surface — kept for backwards-compat with whatever wiring O05 expects. Safe to delete once O05 lands.

---

## 3. Secrets required (and NOT required)

### Required in repo settings → secrets

| Secret | Used by | Notes |
|---|---|---|
| `SIGNALWIRE_TOKEN` | `ci.yml::build-images` (optional), `build.yml::build-freeswitch` | If absent, FS images aren't built; non-FS images still build. |

### NOT required — explicitly avoided

- `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` — OIDC will be used when deploy workflows are added (see §7).
- `GHCR_PAT` — `GITHUB_TOKEN` has `packages: write` and is sufficient.
- `NPM_TOKEN` — we don't publish npm packages from CI (yet).

### Reserved names (used by deferred deploy workflows in §7)

`SLACK_WEBHOOK_URL`, `STAGING_AWS_REGION`, `PROD_AWS_REGION`, `LOAD_STAGING_AWS_REGION`.

---

## 4. Make targets for local CI parity

```bash
make ci             # lint + typecheck + test + migration-down-check
make ci-lint        # all linters (alias for `make lint`)
make ci-test        # all unit tests (alias for `make test`)
make ci-migrations  # check-migrations.sh standalone
make ci-actionlint  # workflow YAML lint (requires actionlint binary)
make ci-workflows   # alias for ci-actionlint
```

Install actionlint:

```bash
go install github.com/rhysd/actionlint/cmd/actionlint@latest
```

---

## 5. How to add a new service to CI

1. Add the service block to `docker-compose.dev.yml` with a `healthcheck:`.
2. Add a `Dockerfile` (`dev`/`builder`/`prod` targets recommended).
3. Append the service name to `build.yml::build-service` matrix:

   ```yaml
   strategy:
     matrix:
       service: [api, dialer, workers, web, <new>]
   ```

4. (Optional) Wire `<new>/test:unit` and `<new>/typecheck` scripts into the workspace; `unit-node` and `unit-go` auto-discover.
5. If the service exposes metrics, add the scrape target to O01's Prometheus config (separate module).

No changes to `ci.yml` itself are needed — its lint/test stages auto-discover via `pnpm -r` and `go ./...`.

---

## 6. Branch protection — recommended ruleset

(Cannot be set via committed code without repo-admin rights. Configure via
GitHub UI → Settings → Rules → Rulesets. PLAN §12 specifies the Terraform
form for when `infra/github/` is added.)

```jsonc
{
  "name": "main protection",
  "target": "branch",
  "include": ["~DEFAULT_BRANCH"],
  "rules": {
    "pull_request": {
      "required_approving_review_count": 1,
      "dismiss_stale_reviews_on_push": true,
      "require_last_push_approval": true,
      "required_review_thread_resolution": true
    },
    "required_status_checks": {
      "strict_required_status_checks_policy": true,
      "required_status_checks": [
        "ci-pass",
        "lint-pr-meta",
        "lint-commits",
        "dependency-review (PR)"
      ]
    },
    "required_linear_history": true,
    "non_fast_forward": true,
    "deletion": false,
    "enforce_admins": true
  }
}
```

Tag ruleset for `v*.*.*` (per PLAN §12.2):

```jsonc
{
  "name": "release tags immutable",
  "target": "tag",
  "include": ["v*.*.*"],
  "rules": { "deletion": false, "update": false, "creation": { /* maintainers only */ } }
}
```

---

## 7. Deferred work (explicit, with owners + triggers)

Per the orchestrator brief — IMPLEMENT covers the per-PR CI surface and
image publishing. The remaining PLAN surface depends on cloud-account
setup and is deferred to a follow-on `feat(O04): deploy + OIDC` PR:

| Item | PLAN ref | Blocked by | Owner |
|---|---|---|---|
| `deploy-staging.yml` | §2.2 | AWS account allocated; SSM tree seeded | O04 follow-on PR |
| `deploy-prod.yml` (migrate-prod + release-prod) | §2.3 | AWS + GH Environments `production` & `production-migrate` configured with reviewers | O04 follow-on PR |
| `load-nightly.yml` | §2.4 | O03 ships `scripts/load-test/run.sh` + `baseline.json` | O03 + O04 |
| `codeql.yml` | §2.6 | Decision: enable on public repo or wait for private | O04 follow-on |
| `dependency-review.yml` standalone | §2.7 | Folded into `security.yml::dependency-review` for now | n/a (folded) |
| `_integration.yml` (reusable) + `_docker.yml` (reusable) | §3 | Multi-arch ARM runner allocation; FS arm64 buildability check | O04 follow-on |
| Composite actions (`setup-monorepo`, `aws-oidc`, `login-ghcr`, `notify-slack`) | §4 | First consumer needed | O04 follow-on |
| Multi-arch arm64 image builds | §5 | `ubuntu-24.04-arm` runner availability + FS image arm64 test | O04 follow-on |
| OIDC provider + IAM roles + SSM tree | §8 | AWS account | O04 + O05 joint |
| GitHub Environments (staging, production, production-migrate, load-staging) | §9 | Repo-admin action | Manual |
| Branch protection ruleset (Terraform under `infra/github/`) | §12 | Repo-admin action | Manual or follow-on PR |
| Deploy scripts (`scripts/deploy/{staging,prod,rollback}.sh`) | §11 | Target infra known | O04 follow-on |
| Runbooks (add-new-service, secrets-rotation, migration-incident, ci-cost-review, rollback-procedure) | §17.5, §19 | Operational experience | rolling |
| Legal note `spec/legal/freeswitch-licenses.md` | §18 item 7 | Legal sign-off | Manual |
| PR title enforcement (`amannn/action-semantic-pull-request`) | §13.3 | Repo-admin or stand-alone PR | O04 follow-on |
| GHCR retention workflow (`ghcr-retention.yml`) | §6 | GHCR PAT secret | O04 follow-on |
| Long-running migration runner (`ops-gh-ost-run.yml`) | §10.1.5 | First gh-ost migration authored | F02-followup or O04 |

### 7.1 What is NOT deferred (i.e., what already works today)

- Every PR runs lint + typecheck + unit tests + migration-down-check.
- Every PR runs gitleaks + Trivy fs/config + dependency-review.
- Every push to main builds + publishes images to GHCR with SBOM + SLSA provenance.
- Every `v*.*.*` tag builds + publishes images AND drafts a GitHub Release.
- Weekly security scans (Trivy image + SBOM) run on a schedule.
- Dependabot keeps deps current weekly.
- CODEOWNERS auto-routes reviews to the maintainers placeholder.

---

## 8. Migration-down-sql allowlist

`api/prisma/migrations/.no-down-sql-allowlist` grandfathers the 8 existing
F02 migrations (they predate this rule and don't have hand-written
`down.sql` files). The list is intentionally explicit so new migrations
can't silently slip in without one. As F02 owns reversibility per
SPEC §3.8, the orchestrator should track backfilling these via
`spec/modules/F02/HANDOFF.md` open items.

To remove an entry: write the `down.sql` (it should reverse the `up`
migration logically; for `CREATE TABLE` use `DROP TABLE`, etc.), commit
both, delete the entry from the allowlist.

---

## 9. Pointers

- [PLAN.md](./PLAN.md) — authoritative spec (much broader than this
  IMPLEMENT scope; the §7 deferred list maps back to PLAN sections)
- [RESEARCH.md](./RESEARCH.md) — 57 citations behind PLAN decisions
- [VERIFY.md](./VERIFY.md) — local validation transcript
- [F01 HANDOFF §O04](../F01/HANDOFF.md) — the original handoff into this module
- [SPEC.md §3.10](../../../SPEC.md) — CI/test tier requirements
