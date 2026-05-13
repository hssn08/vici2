# N03 — Salesforce Open CTI Adapter — HANDOFF

| Field | Value |
|---|---|
| **Module** | N03 — Salesforce Open CTI Adapter |
| **Status** | IMPLEMENTED (2026-05-13) |
| **Commit** | feat(N03): Salesforce Open CTI adapter |

---

## What was implemented

### Backend (api/)

- `api/src/static/sf-cti-adapter.html` — adapter HTML entry point (loaded by SF softphone panel)
- `api/src/static/sf-cti.js` — vanilla JS bridge (220 LOC): detects SF origin, loads opencti_min.js, manages 3-state machine (IDLE/INCALL/DISPO_PENDING), forwards postMessages between SF Open CTI and vici2 inner iframe
- `api/src/static/sf-cti-manifest.xml` — Call Center XML for SF admin import
- `api/src/routes/adapters/sf-integration/` — Fastify route bundle:
  - `schema.ts` — Zod schemas + TypeScript types for all request/response shapes
  - `token-store.ts` — AES-256-GCM encrypt/decrypt for SF OAuth tokens (reuses F05 encryption.ts); injectable `SfHttpClient` interface for testing
  - `task-mapper.ts` — maps vici2 dispo commit payload → SF Task fields with custom field-mapping support
  - `service.ts` — OAuth CSRF-guarded flow (initiate + callback), config CRUD, token revocation
  - `index.ts` — Fastify route registration (5 admin routes + 1 sf-import lead endpoint)
- `api/src/workers/sf-writeback.worker.ts` — BullMQ worker on `vici2:queue:sf-writeback`, 3× exponential retry, SOQL dedup by `[vici2:callId:…]` in Description, injectable `SfRestClient` for testing, Prometheus metrics
- `api/prisma/migrations/20260513340000_n03_sf_integration/migration.sql` — creates `sf_integrations` table, adds `sf_record_id` + `sf_object_type` to `leads`
- `api/package.json` — added `@fastify/static: ^8.0.0`
- `api/src/server.ts` — static file serving under `/static/` with CSP headers for SF domain frame-ancestors
- `api/src/routes/admin/index.ts` — registered `registerSfIntegrationRoutes`
- `api/src/auth/audit.ts` — added 5 N03 audit action strings

### Shared types

- `shared/types/src/rbac.ts` — added `integration:sf:configure` (admin+) and `integration:sf:click_to_dial` (agent+) to VERBS and role matrix

### Frontend (web/)

- `web/src/app/(sf)/layout.tsx` — SF embed layout (no nav, fixed 300×600)
- `web/src/app/(sf)/page.tsx` — SF embed page entry point
- `web/src/components/sf-cti/openCtiBridge.ts` — TypeScript postMessage bridge (typed discriminated unions, origin validation, register/cleanup helpers)
- `web/src/components/sf-cti/useSfBridge.ts` — React hook wiring adapter ↔ call store ↔ agent state
- `web/src/components/sf-cti/SfEmbedShell.tsx` — compact agent shell for SF embed mode
- `web/src/components/sf-cti/useSfIntegration.ts` — React Query hooks for admin API
- `web/src/components/sf-cti/SfOAuthConnect.tsx` — OAuth setup form
- `web/src/components/sf-cti/SfFieldMappings.tsx` — dispo → Task Status mapping editor
- `web/src/components/sf-cti/SfInstallGuide.tsx` — Call Center XML download + step-by-step guide
- `web/src/components/sf-cti/SfIntegrationPanel.tsx` — tabbed admin panel (Status / Mappings / Installation)

### Tests

- `api/test/adapters/sf-cti/task-mapper.test.ts` — 15 tests (default mapping, custom overrides, CallType, WhoId, edge cases)
- `api/test/adapters/sf-cti/token-store.test.ts` — 7 tests (AES-256-GCM round-trip, AAD binding, tamper detection)
- `api/test/adapters/sf-cti/sf-writeback.worker.test.ts` — 6 tests (task shape, create vs update dedup, failure throw, disabled integration skip)
- **28 tests total, all passing**

---

## Salesforce setup guide

### Step 1 — Create a Salesforce Connected App

1. In Salesforce Setup, search **App Manager** → New Connected App.
2. Enable **OAuth Settings**. Set the callback URL to:
   `https://api.YOUR-DOMAIN.com/admin/sf-integration/oauth/callback`
3. Add scopes: `full`, `refresh_token`, `offline_access`.
4. Save and note the **Consumer Key** and **Consumer Secret**.

### Step 2 — Connect in vici2 admin

1. Go to `/admin/settings/sf-integration`.
2. Enter the Instance URL, Consumer Key, and Consumer Secret.
3. Click **Connect to Salesforce** → complete OAuth flow in SF.
4. The panel will show "Connected" status.

### Step 3 — Import the Call Center XML

1. Download `sf-cti-manifest.xml` from the Installation tab in the admin panel.
2. Edit the file to set your actual API domain and tenant slug in `reqAdapterUrl`.
3. SF Setup → Call Centers → **Import** → upload the XML.
4. Open the new Call Center → **Manage Call Center Users** → add agents.

### Step 4 — Enable in Console App

1. App Manager → edit your Service Cloud or Sales Cloud Console app.
2. Utility Items → Add **Open CTI Softphone**.
3. Save and reload. The Vici2 softphone panel will appear.

### Step 5 — Configure field mappings (optional)

In the admin panel **Mappings** tab, configure which SF Task Status each vici2 dispo code maps to.

---

## postMessage schema reference (FROZEN)

### SF → vici2
| Type | Payload fields |
|---|---|
| `sf:dial` | `number, recordId, recordName, objectType` |
| `sf:init` | `userId, orgId, apiVersion, tenantSlug` |
| `sf:navigate` | `recordId, objectType` |
| `sf:panelOpen` | — |
| `sf:panelClose` | — |

### vici2 → SF
| Type | Payload fields |
|---|---|
| `vici2:callConnected` | `callId, leadPhone, leadName, sfRecordId?, direction` |
| `vici2:callEnded` | `callId, durationSeconds` |
| `vici2:dispoCommitted` | `callId, dispo, dispoLabel, notes, leadId, sfRecordId?, sfObjectType?, callDurationSeconds, callStartAt, direction` |
| `vici2:agentState` | `state, pauseCode?` |
| `vici2:screenPop` | `sfRecordId, objectType` |

---

## Extending

### Adding new postMessage types

- Add type to `openCtiBridge.ts` discriminated unions
- Handle in `sf-cti.js` switch statement (adapter side)
- Handle in `useSfBridge.ts` or `SfEmbedShell.tsx` (vici2 side)

### Adding custom dispo → Task field mappings

POST to `PATCH /api/admin/sf-integration` with `fieldMappings.dispoToTaskStatus` record.

### Phase 2 deferred work

- JWT Bearer Flow (server-to-server)
- Managed Salesforce package (`Vici2_Call_Id__c` custom field, `Vici2_Dispo__c` picklist)
- Multiple SF orgs per tenant
- CHIPS cookie support for persistent agent sessions
- `sforce.opencti.runApex` integration
- Salesforce Flows on specific dispo outcomes

---

## Environment variables

| Variable | Description |
|---|---|
| `API_BASE_URL` | Used to build OAuth callback URL (default: `https://api.vici2.example.com`) |
| `WEB_BASE_URL` | Used for post-OAuth redirect (default: `https://app.vici2.example.com`) |
| `SF_OAUTH_STATE_SECRET` | HMAC secret for OAuth CSRF state (default: `vici2-sf-state-secret` — **must set in prod**) |
| `NEXT_PUBLIC_API_ORIGIN` | Web: adapter origin for postMessage validation |
