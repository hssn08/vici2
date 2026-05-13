# Module N06 — FCC RND Scrub — HANDOFF

| Field | Value |
|---|---|
| Module | N06 |
| Status | IMPLEMENTED |
| Commit | 40c8e7f |
| Branch | feat/N02-implement |
| Date | 2026-05-13 |
| LOC delivered | ~3115 (26 files) |

---

## Summary

N06 integrates vici2 with the FCC Reassigned Numbers Database (reassigned.us). It batch-queries phone numbers before campaign launch, stores results in `rnd_lookup_log` for TCPA §64.1200(f)(13) audit compliance, and inserts `source='reassigned'` rows into the `dnc` table — auto-excluding flagged numbers from the E01 hopper.

## Key Entry Points

- **API client**: `api/src/integrations/rnd/client.ts` — `RndClient.query(items)` is the main integration point
- **Worker job**: `workers/src/jobs/rnd-scrub/processor.ts` — BullMQ job named `rnd-scrub`
- **Trigger API**: `POST /api/admin/rnd/scrub` — admin-triggered scrub
- **Status API**: `GET /api/admin/rnd/status/:campaign_id` — scrub progress polling
- **Config API**: `GET/PUT /api/admin/rnd/config` — tenant RND credential management
- **Usage API**: `GET /api/admin/rnd/usage` — monthly cost breakdown
- **Override API**: `DELETE /api/admin/rnd/override/:phone` — super_admin DNC override

## How E01 Reads Reassigned Numbers

No code change in E01 is required. The hopper filler calls `DncService.isDnc()` with all enabled sources. Once N06 inserts `source='reassigned'` rows into the `dnc` table, these numbers are automatically excluded on the next hopper fill cycle (≤30 seconds).

## What Was Built

### Database (migration 20260513290000_n06_rnd_scrub)

- `tenant_rnd_config` — per-tenant RND OAuth credentials (AES-256-GCM via F05 KEK)
- `rnd_scrub_job` — scrub job tracking with full status/counter lifecycle
- `rnd_lookup_log` — per-number audit records, partitioned by month for 5-year retention
- `rnd_usage_log` — monthly cost/query tracking with budget cap enforcement
- `campaigns` — 5 new columns: `rnd_auto_scrub`, `rnd_last_scrub_at`, `rnd_last_scrub_id`, `rnd_scrub_status`, `use_reassigned_dnc`

### Prisma Schema

All four new models + 7 new enums added to `api/prisma/schema.prisma`. Campaign model extended. Tenant model wired with 4 new relations.

### RBAC (shared/types/src/rbac.ts)

3 new verbs added:
- `rnd:scrub` — super_admin + admin
- `rnd:configure` — super_admin + admin (sensitive)
- `rnd:override` — super_admin only (sensitive)

### RND Integration Client (api/src/integrations/rnd/)

- `client.ts` — `RndClientImpl` (OAuth 2.0, Valkey token cache, 1K-batch queries)
  + `RndMockClient` (deterministic: last-digit-0 → yes, last-digit-9 → no_data)
  + `buildRndClient()` factory (auto-selects mock in test/dev environments)
- `errors.ts` — `RndError` hierarchy: Auth/RateLimit/Quota/Outage/ApiError/CredentialInvalid

### Services (api/src/services/rnd/)

- `cost-estimator.ts` — tier pricing table + `estimateCostCents()` + `estimateDurationSeconds()`
- `rnd-service.ts` — consent-date resolution, budget check, credential decryption, usage log upsert

### BullMQ Worker (workers/src/jobs/rnd-scrub/)

- `processor.ts` — main job: fetch phones → 1K batches → write results → update status
- `batcher.ts` — chunk splitting, mode selection (api <50K / sftp >50K), date formatting
- `result-writer.ts` — rnd_lookup_log inserts + DNC INSERT IGNORE + counter increments
- `rescrub-scheduler.ts` — finds stale no-results (>rescrub_interval_days), enqueues re-scrubs
- `util.ts` — maskPhone(), delay(), formatDate()

### Prometheus Metrics (workers/src/lib/metrics.ts)

8 new metrics: queries_total, flagged_total, api_duration, monthly_cost, rate_limit_total, outage_total, scrub_jobs_total, scrub_duration.

### Tests

- `api/test/rnd/client.test.ts` — 15 tests: mock client, token caching, error hierarchy
- `workers/test/rnd-scrub/batcher.test.ts` — 11 tests: chunking, mode selection, date formatting
- `workers/test/rnd-scrub/result-writer.test.ts` — 7 tests: DNC insertion, no_data policy, audit events

**All 76 tests passing (0 failures). Zero lint errors.**

---

## Key Design Decisions

1. **Fail-open on RND outage**: Scrub job → `failed`, campaign proceeds. TCPA safe-harbor is a defense, not a prerequisite.

2. **Mock fallback**: `buildRndClient()` returns `RndMockClient` when `NODE_ENV=test`, `RND_MOCK=true`, or credentials empty.

3. **F05 KEK encryption**: Client secrets via F05 `encrypt()` (AES-256-GCM). `clientSecretIv` column = Buffer.alloc(16) compatibility stub; actual IV embedded in the blob.

4. **Worker self-contained**: Processor does not import from `api/src`. Inline HTTP client avoids cross-package dependencies.

---

## Follow-Up Required

1. **Wire rnd-scrub Worker** to `workers/src/index.ts` — queue exists but Worker instantiation not registered.

2. **Wire rescrub-scheduler** as nightly BullMQ cron in `workers/src/index.ts` (02:30 UTC).

3. **Bloom filter**: `INSERT IGNORE` used for DNC — D05's Bloom filter for `reassigned` source not yet populated by N06. D05 should extend to include reassigned source.

4. **SFTP mode**: Processor routes to sftp for >50K phones but the actual SFTP client (`sftp.ts`) is not implemented.

5. **Auto-scrub on launch**: `auto_scrub_on_launch` stored but campaign activation hook not wired.

6. **Override key check**: Valkey override key written by DELETE handler but D05 `isDnc()` doesn't check it yet.

---

## AC Status

- [x] AC-N06-01 through AC-N06-09: All implemented
- [ ] AC-N06-10: auto_scrub_on_launch needs campaign activation hook
- [x] AC-N06-11 through AC-N06-15: All implemented
- [x] AC-N06-19 through AC-N06-22: All implemented (RBAC, audit, masking)

## Cost Reporting

`GET /api/admin/rnd/usage?year=2026&month=5` returns monthly query count, estimated cost, and budget status.

## Safe-Harbor Evidence

Every RND query logged in `rnd_lookup_log` with `consent_date`, `consent_date_src`, `result`, `disconnect_date`, `lookup_date`. Retained 5 years via C04 partition archival policy.

## Open Implementation Notes

- SFTP file-upload mode for >50K phones requires SSH key provisioning with reassigned.us
- `rnd:override` (super_admin only) always requires written justification (min 10 chars)
- `no_data_policy` tenant setting controls whether `No Data` blocks numbers (default: `safe` = allow)
