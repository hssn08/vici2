# N05 — Branded Calling Integration: Handoff

## Status

IMPLEMENTED — commit `e023dee` on branch `feat/N05-implement`

## What Was Built

- **Migration** `api/prisma/migrations/20260513320000_n05_branded_calling/migration.sql`: tables `branded_calling_providers` + `branded_did_registrations`, column `did_numbers.brand_reputation_score`, extended `QuarantineReason` enum with `brand_reputation`.
- **Prisma schema** (`api/prisma/schema.prisma`): `BrandedCallingProvider`, `BrandedDidRegistration` models; `BrandedCallingProviderKind`, `BrandVertical`, `BrandStatus`, `BrandedDidStatus` enums; `DidNumber.brandReputationScore` field.
- **Provider interface** `api/src/integrations/branded-calling/types.ts`: `IBrandedCallingProvider`, `BrandedCallingReputationHook`, all payload types.
- **Clients**: `first-orion.ts` (OAuth2 client-credentials), `hiya.ts` (API key), `tns.ts` (HMAC-SHA256).
- **Vocab maps**: `vertical-map.ts`, `call-reason-map.ts` — canonical → provider enum translation.
- **Registry** `api/src/integrations/branded-calling/registry.ts`: 15-min credential cache with explicit `invalidate()`.
- **X04 hook** `api/src/services/number-pool/quarantine-hook.ts`: quarantines ALL pool memberships for a DID when `normalizedScore < BRAND_QUARANTINE_THRESHOLD` (default 30).
- **Admin routes** `api/src/routes/admin/branded-calling/`: 12 endpoints across `provider.ts`, `dids.ts`, `reputation.ts`, `index.ts`, `schemas.ts`.
- **Workers** `workers/src/jobs/branded-calling/`: `register-did.ts`, `bulk-register.ts`, `deregister-did.ts`, `poll-reputation.ts`, `scheduler.ts`.
- **Metrics** added to `workers/src/lib/metrics.ts`: `vici2_branded_did_reputation_score` gauge, `vici2_branded_did_count` gauge.
- **RBAC** `shared/types/src/rbac.ts`: `branded_calling:configure` and `branded_calling:register_did` verbs; both sensitive, granted to super_admin + admin.
- **Audit** `api/src/auth/audit.ts`: 9 new `AuditAction` values for all N05 write operations.
- **Tests** `api/test/branded-calling/`: 25 passing unit tests covering score normalization, registry caching, and quarantine hook threshold logic.

## What Is NOT Done (Phase 2 Deferred)

- Admin UI (`web/src/app/(admin)/integrations/branded-calling/`) — full React page with tabs, DID table, reputation badges, dispute modal, bulk-register modal. Not implemented; wire up when UI sprint begins.
- Workers not wired into `workers/src/index.ts` — add the `vici2:queue:branded-calling` queue + worker registrations + scheduler cron when deploying.
- `prisma generate` needed after migration before deploying API.

## Deployment Checklist

1. Run `pnpm --filter @vici2/api exec prisma migrate deploy` (stamps `20260513320000_n05_branded_calling`).
2. Run `pnpm --filter @vici2/api exec prisma generate` (regenerates Prisma client with new models).
3. Deploy API — new routes are registered; no existing routes changed.
4. Wire `vici2:queue:branded-calling` + `processRegisterDid/processBulkRegister/processDeregisterDid/processPollReputation` workers + `runBrandedCallingScheduler` cron into `workers/src/index.ts`.
5. Set `BRAND_QUARANTINE_THRESHOLD` env var (default 30) in workers process.
6. Admin configures provider credentials via API/UI; admin registers brand; admin registers DIDs.

## Per-Provider Configuration

### First Orion
- OAuth2 client-credentials; credentials JSON: `{ "client_id": "...", "client_secret": "..." }`
- Token: `https://auth.firstorion.com/oauth/token`
- API: `https://api.firstorion.com/engage/v2/`
- Score: 0–100 (as-is); A-attestation recommended for full T-Mobile display.

### Hiya
- API key only; credentials JSON: `{ "api_key": "..." }`
- API: `https://api.connect.hiya.com/v1/`
- Score: 0–10 → normalized ×10 → 0–100.
- 30-day cooling period for numbers with existing spam flags.

### TNS
- HMAC-SHA256; credentials JSON: `{ "api_key": "...", "api_secret": "..." }`
- API: `https://ecid-api.tnsi.com/v3/`
- Score: `overall_risk_score` 0–100 (0=lowest risk); inverted to 100–score.

## X04 Quarantine Integration

`BRAND_QUARANTINE_THRESHOLD` (default 30) controls auto-quarantine. When poll-reputation writes a score below threshold, `quarantineDidGlobally()` sets `number_pool_dids.quarantined = true` with `quarantine_reason = 'brand_reputation'` across **all** pool memberships for that DID. Manual unquarantine via X04 UI after dispute resolution (typically 48–72h).

## API Summary

| Method | Path | Permission |
|---|---|---|
| GET | /api/admin/branded-calling | branded_calling:configure |
| POST | /api/admin/branded-calling/:provider | branded_calling:configure |
| GET | /api/admin/branded-calling/:provider | branded_calling:configure |
| PATCH | /api/admin/branded-calling/:provider | branded_calling:configure |
| DELETE | /api/admin/branded-calling/:provider | branded_calling:configure |
| POST | /api/admin/branded-calling/:provider/test-connection | branded_calling:configure |
| GET | /api/admin/branded-calling/:provider/dids | branded_calling:register_did |
| POST | /api/admin/branded-calling/:provider/dids | branded_calling:register_did |
| DELETE | /api/admin/branded-calling/:provider/dids/:didId | branded_calling:register_did |
| POST | /api/admin/branded-calling/:provider/dids/bulk-register | branded_calling:register_did |
| POST | /api/admin/branded-calling/:provider/dids/:didId/dispute | branded_calling:register_did |
| GET | /api/admin/branded-calling/:provider/dids/:didId/reputation | branded_calling:register_did |
