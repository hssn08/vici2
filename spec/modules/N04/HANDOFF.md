# N04 — HubSpot Integration — HANDOFF

| Field | Value |
|---|---|
| **Module** | N04 — HubSpot Integration |
| **Author** | N04-IMPLEMENT agent (Claude Sonnet 4.6) |
| **Date** | 2026-05-13 |
| **Status** | IMPLEMENTED |

---

## Implementation Summary

### Key files

| Area | Path |
|---|---|
| Migration | `api/prisma/migrations/20260513350000_n04_hubspot/migration.sql` |
| HubSpot client | `api/src/integrations/hubspot/hubspot-client.ts` |
| OAuth helpers | `api/src/integrations/hubspot/oauth.ts` |
| Contact sync | `api/src/integrations/hubspot/sync-contacts.ts` |
| Engagement push | `api/src/integrations/hubspot/push-activity.ts` |
| Webhook verify | `api/src/integrations/hubspot/webhook-verify.ts` |
| Property map | `api/src/integrations/hubspot/property-map.ts` |
| List import | `api/src/integrations/hubspot/list-import.ts` |
| API routes | `api/src/routes/admin/integrations/hubspot/index.ts` |
| Public webhook | `api/src/routes/webhooks/hubspot.ts` |
| Sync worker | `workers/src/jobs/hubspot-sync/index.ts` |
| Push worker | `workers/src/jobs/hubspot-push/index.ts` |
| Webhook worker | `workers/src/jobs/hubspot-webhook/index.ts` |
| Admin UI | `web/src/app/(admin)/admin/integrations/hubspot/` |
| Widget page | `web/src/app/(public)/hubspot-calling/page.tsx` |
| SDK adapter | `web/src/lib/hubspot-calling-adapter.ts` |
| RBAC | `shared/types/src/rbac.ts` |
| Unit tests | `api/test/integrations/hubspot/` (29 tests, all passing) |

### Required environment variables

```
HUBSPOT_CLIENT_ID       # Public app client ID from app.hubspot.com/developer
HUBSPOT_CLIENT_SECRET   # App client secret (never in DB or code)
HUBSPOT_REDIRECT_URI    # Must match app registration exactly
HUBSPOT_APP_TOKEN       # Developer app token for webhook subscription mgmt
```

### New RBAC verbs

| Verb | super_admin | admin | supervisor | agent |
|---|---|---|---|---|
| `integration:hs:configure` | tenant | tenant | — | — |
| `integration:hs:click_to_dial` | tenant | tenant | tenant | tenant |

### Audit actions

`hs_integration.connected`, `.disconnected`, `.token_refreshed`, `.settings_updated`,
`.sync_started`, `.sync_completed`, `.sync_failed`, `.engagement_pushed`, `.engagement_failed`,
`.list_imported`

### BullMQ queues

- `vici2:queue:hubspot-sync` — concurrency 2
- `vici2:queue:hubspot-push` — concurrency 10
- `vici2:queue:hubspot-webhook` — concurrency 5

### How to connect

1. Admin navigates to `/admin/integrations/hubspot`
2. Clicks "Connect HubSpot" → redirected to HubSpot OAuth flow
3. After authorization, tokens are stored AES-GCM encrypted (F05 KEK pattern)
4. Initial full sync enqueued immediately

### Calling widget

Register in HubSpot app settings:
- URL: `https://{your-domain}/hubspot-calling`
- Width: 400, Height: 600
- `supportsInboundCalling: false` (Phase 2)

### Phase 2 deferred

- `supportsInboundCalling: true`
- HubSpot contact property write-back (`vici2_last_dispo` etc.)
- Deal association on engagements
- GDPR erasure propagation

---

*29 unit tests passing. 0 lint errors. Workers stub live API calls — provide credentials for production.*
