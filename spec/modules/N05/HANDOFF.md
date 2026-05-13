# N05 — Branded Calling Integration: Handoff

## Status

NOT_STARTED (spec complete; awaiting implementation agent)

## Key Deliverables for Implementer

- Migration: `api/prisma/migrations/20260513320000_n05_branded_calling/migration.sql`
- Provider clients: `api/src/integrations/branded-calling/{first-orion,hiya,tns}.ts`
- Provider interface + types: `api/src/integrations/branded-calling/types.ts`
- Provider registry: `api/src/integrations/branded-calling/registry.ts`
- Admin routes: `api/src/routes/admin/branded-calling/`
- Workers: `workers/src/jobs/branded-calling/`
- Admin UI: `web/src/app/(admin)/integrations/branded-calling/`
- RBAC: `shared/types/src/rbac.ts` — add `branded_calling:configure`, `branded_calling:register_did`

## Per-Provider Configuration (Operator Reference)

### First Orion
- OAuth2 client-credentials flow; credentials: `client_id` + `client_secret`.
- Token endpoint: `https://auth.firstorion.com/oauth/token`.
- API base: `https://api.firstorion.com/engage/v2/`.
- Requires enterprise contract; contact First Orion sales for credentials.
- STIR/SHAKEN A-attestation preferred for full T-Mobile display.

### Hiya
- API key only; credentials: `api_key`.
- Header: `X-API-Key`.
- API base: `https://api.connect.hiya.com/v1/`.
- Self-serve portal available for smaller brands; enterprise API access via sales.
- 30-day cooling period for numbers with existing spam flags.

### TNS
- HMAC-SHA256 signed requests; credentials: `api_key` + `api_secret`.
- Signature over `METHOD\nPATH\nTIMESTAMP\nBODY_HASH`.
- API base: `https://ecid-api.tnsi.com/v3/`.
- Requires enterprise contract + DUNS number.

## Cost Reporting

`vici2_branded_did_count` Prometheus gauge (labeled by provider + status) shows active registered DID counts. Multiply by provider cost-per-DID-per-month for cost estimates. Actual billing is via direct provider contracts.

## X04 Quarantine Integration

`BRAND_QUARANTINE_THRESHOLD` env var (default: `30`) controls the normalized score below which a DID is auto-quarantined. The hook fires from `workers/src/jobs/branded-calling/poll-reputation.ts` after every reputation poll. X04's `quarantineDidGlobally()` sets `number_pool_dids.quarantined = true` with `quarantine_reason = 'BRAND_REPUTATION'` across all pool memberships. Admin must manually unquarantine via X04 UI after remediation (dispute resolution with provider typically takes 48–72 hours).

## How "Branded" Status Surfaces on DID Detail

The T02 DID detail page (admin UI) reads `did_numbers.brand_reputation_score` and displays it as a badge:
- Score ≥ 60: green "Branded Active"
- Score 30–59: yellow "At Risk"
- Score < 30: red "Flagged"
- Score NULL: gray "Not Registered"

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
