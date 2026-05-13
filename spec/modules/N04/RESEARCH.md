# N04 — HubSpot Integration — RESEARCH

| Field | Value |
|---|---|
| **Module** | N04 — HubSpot Integration |
| **Author** | N04-PLAN agent (Claude Sonnet 4.6) |
| **Date** | 2026-05-13 |
| **Status** | RESEARCH |
| **Informs** | N04/PLAN.md |

---

## 0. Executive Summary

HubSpot is the dominant SMB CRM. Connecting vici2 to HubSpot closes the loop that call-center operators care most about: dial a HubSpot contact directly, write the call outcome back as an engagement, and watch the record stay current without manual CSV exports. The integration has three distinct faces:

1. **OAuth 2.0 app** — tenant connects their HubSpot portal once; vici2 stores encrypted tokens and uses them for all subsequent API calls.
2. **Contact sync** — incremental pull of HubSpot contacts (and optionally list members) into vici2 lead rows, keyed by `hs_object_id`; cursor-based so large portals (≥1 M contacts) are handled without a full re-fetch.
3. **Calling widget (CRM Calling SDK)** — HubSpot embeds a third-party telephony iframe inside its contact/company/deal records; our vici2 agent UI becomes that iframe, receiving click-to-call events and posting call state back.
4. **Engagement write-back** — when an agent dispositions a call, vici2 creates a HubSpot `CALL` engagement (v3 Engagements API) in the contact's timeline.

All four pieces are required to deliver a seamless "HubSpot-native" call-center experience.

---

## 1. HubSpot OAuth 2.0 App Flow

### 1.1 App Registration

HubSpot uses standard OAuth 2.0 Authorization Code flow. Developers register an app at `app.hubspot.com/developer`. The app receives:

- `client_id` — public identifier (UUID format), safe to expose in the authorization URL.
- `client_secret` — private secret used server-side for token exchange and refresh. Never sent to the browser.

Vici2 ships as a **public app** (not a private app), because multi-portal support (multiple tenants each connecting their own HubSpot portal) requires one centralized registered app. Private apps issue static access tokens scoped to one portal; they cannot support multi-tenant OAuth flows.

### 1.2 Authorization Endpoint

```
GET https://app.hubspot.com/oauth/authorize
  ?client_id={CLIENT_ID}
  &redirect_uri={REDIRECT_URI}
  &scope={SPACE_SEPARATED_SCOPES}
  &state={CSRF_STATE}
  &optional_scope={OPTIONAL_SCOPES}
```

Key parameters:
- `scope` — required scopes the user must grant (non-negotiable for the app to function).
- `optional_scope` — scopes presented to the user but not blocking if denied.
- `state` — CSRF protection token; vici2 stores a signed JWT (64-byte random + tenant_id + exp) in a short-lived Valkey key and verifies it in the callback.

### 1.3 Required OAuth Scopes

| Scope | Purpose |
|---|---|
| `crm.objects.contacts.read` | Read contacts for sync |
| `crm.objects.contacts.write` | Write back to contact properties (optional, Phase 2) |
| `crm.objects.companies.read` | Resolve company associations for screen pop |
| `crm.lists.read` | Enumerate contact lists for list-based lead import |
| `crm.objects.deals.read` | Optional: associate calls to deals |
| `timeline` | Create timeline events on contact records (v3 Engagements) |
| `crm.objects.owners.read` | Map HubSpot owner to vici2 agent (Phase 2) |
| `oauth` | Token introspection, required for refresh |
| `calling` | Embed the Calling SDK widget — required for click-to-call |

Scope `calling` is specifically required to register as a Calling Provider in HubSpot's Calling Extensions registry.

### 1.4 Token Exchange

After user authorization, HubSpot redirects to `redirect_uri?code={AUTH_CODE}&state={STATE}`. Vici2 backend:

1. Validates `state` against Valkey entry.
2. POSTs to `https://api.hubapi.com/oauth/v1/token`:
   ```
   POST /oauth/v1/token
   Content-Type: application/x-www-form-urlencoded

   grant_type=authorization_code
   &client_id={CLIENT_ID}
   &client_secret={CLIENT_SECRET}
   &redirect_uri={REDIRECT_URI}
   &code={AUTH_CODE}
   ```
3. Response:
   ```json
   {
     "access_token": "...",
     "refresh_token": "...",
     "expires_in": 1800,
     "token_type": "bearer"
   }
   ```
   Access tokens have a 30-minute TTL. Refresh tokens do not expire unless revoked.

### 1.5 Token Refresh

```
POST https://api.hubapi.com/oauth/v1/token
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token
&client_id={CLIENT_ID}
&client_secret={CLIENT_SECRET}
&redirect_uri={REDIRECT_URI}
&refresh_token={REFRESH_TOKEN}
```

Vici2 implements proactive refresh: a BullMQ repeatable job checks `token_expires_at` and refreshes at `expires_at - 5min`. If refresh fails (e.g., user revoked access), the integration is flagged `status='ERROR'` and an admin notification is sent via N01.

### 1.6 Token Storage Security

Tokens are envelope-encrypted using the existing F05 KEK infrastructure (same pattern as SIP credentials):
- `access_token_enc` — `VARBINARY(512)` ciphertext.
- `refresh_token_enc` — `VARBINARY(512)` ciphertext.
- `kek_version` — `SMALLINT` for key rotation support.

Plaintext tokens never appear in logs or audit entries.

### 1.7 Multi-Portal Support

Each tenant can connect exactly one HubSpot portal. The `hubspot_integrations` table has a `UNIQUE KEY` on `(tenant_id)`. A second OAuth attempt for the same tenant replaces the existing integration (UPDATE, not INSERT) after user confirmation in the UI. Multiple tenants on the same vici2 instance can connect different HubSpot portals with no cross-contamination — each row is isolated by `tenant_id`.

Portal identity is established by `portal_id` (the `hub_id` returned in the token response metadata, accessible via `GET /oauth/v1/access-tokens/{ACCESS_TOKEN}`).

---

## 2. Contact Sync: Incremental Pull

### 2.1 HubSpot Contacts v3 API

HubSpot's CRM API v3 is the current stable version. The contacts search endpoint is:

```
GET https://api.hubapi.com/crm/v3/objects/contacts
  ?properties=firstname,lastname,phone,mobilephone,email,hs_lead_status,lifecyclestage,createdate,lastmodifieddate
  &filterGroups[0][filters][0][propertyName]=lastmodifieddate
  &filterGroups[0][filters][0][operator]=GTE
  &filterGroups[0][filters][0][value]={CURSOR_TIMESTAMP_MS}
  &sorts[0]=lastmodifieddate
  &sorts[0]=ASC
  &limit=100
  &after={PAGING_CURSOR}
```

Alternatively, the `POST /crm/v3/objects/contacts/search` endpoint supports the same filter pattern with a JSON body, which is cleaner for complex filters and avoids URL encoding issues.

### 2.2 Cursor Strategy

Two cursors are maintained per integration:

1. **Timestamp cursor** (`last_sync_cursor` in `hubspot_integrations`): ISO 8601 timestamp of the last `lastmodifieddate` seen in the most recent completed sync. On next sync, only contacts with `lastmodifieddate >= cursor` are fetched.
2. **Paging cursor** (`after` parameter): HubSpot returns `paging.next.after` in each page response. The sync worker saves this to `hubspot_sync_jobs.paging_cursor` and resumes from it if the job is interrupted (BullMQ retry on crash).

Full initial sync uses no timestamp filter; subsequent syncs filter by `lastmodifieddate`.

### 2.3 Sync Frequency

Default: every 15 minutes. Configurable per-tenant in `hubspot_integrations.sync_interval_minutes`. Minimum enforced: 5 minutes (to respect rate limits). Maximum: 24 hours.

### 2.4 Property Mapping

| HubSpot Property | Vici2 Lead Column |
|---|---|
| `hs_object_id` | `lead_external_refs.external_id` |
| `firstname` | `leads.first_name` |
| `lastname` | `leads.last_name` |
| `phone` | `leads.phone` (primary, E.164 normalized) |
| `mobilephone` | `leads.alt_phone` |
| `email` | `leads.email` |
| `hs_lead_status` | `leads.status` (mapped via `hubspot_integrations.status_map JSON`) |
| `lifecyclestage` | stored in `leads.custom_fields JSON` as `hs_lifecyclestage` |
| `createdate` | read-only; not mapped |
| `lastmodifieddate` | used for cursor only |

Phone normalization: HubSpot stores phones in inconsistent formats (national, international, formatted with dashes). Vici2 uses `libphonenumber-js` to parse and normalize to E.164. If normalization fails, the phone is stored as-is with a warning flag in `lead_external_refs.sync_warnings JSON`.

### 2.5 HubSpot Lists → Vici2 Lead Lists

HubSpot "Contact Lists" (static and active) can be imported as a vici2 lead list. The sync flow:

1. Admin selects a HubSpot list from a dropdown (populated via `GET /crm/v3/lists?objectTypeId=0-1&processingTypes=MANUAL,SNAPSHOT,DYNAMIC&limit=200`).
2. Vici2 creates a `lists` row with `source='hubspot'` and `hubspot_list_id` stored in `lists.meta JSON`.
3. Sync worker fetches list members via `POST /crm/v3/lists/{listId}/memberships/join-or-leave` or `GET /crm/v3/lists/{listId}/memberships` (paginated, `after` cursor, 250 records/page).
4. Each member contact is upserted into `leads` using `lead_external_refs` as the deduplication key.

Static lists are synced once on import. Dynamic/active lists are re-synced on every contact sync cycle (members may have changed). The sync worker evaluates whether a contact is still a member; removed members have their vici2 status set to `HS_REMOVED` unless they have a call history.

### 2.6 Deduplication

Before creating a new lead row, the sync worker checks:
1. `lead_external_refs` for `(tenant_id, source='hubspot', external_id=hs_object_id)`.
2. If not found: check `leads.phone` for an existing lead with matching E.164 phone (configurable duplicate detection policy: `strict` = only external_id; `fuzzy` = also phone match).

On match: update the existing lead row with fresh HubSpot data (respecting a `sync_overwrites_manual_edits` flag; if false, only blank fields are updated). On no match: insert a new `leads` row and `lead_external_refs` row.

---

## 3. HubSpot Calling Extensions SDK (Click-to-Call Widget)

### 3.1 Architecture Overview

HubSpot's CRM Calling SDK (also called "Calling Extensions") allows third-party telephony providers to embed their calling UI inside HubSpot's contact, company, and deal records. The mechanism is:

1. A HubSpot app with the `calling` scope is installed in a portal.
2. The app registers a "Calling Provider" with a name and settings URL.
3. When a user clicks the phone icon in HubSpot, HubSpot opens an iframe loading the settings URL.
4. Communication between HubSpot parent frame and the vici2 iframe uses `window.postMessage` via the Calling SDK library (`@hubspot/calling-extensions-sdk`).

### 3.2 CRM Calling SDK Library

The SDK is `@hubspot/calling-extensions-sdk` (npm). It wraps `window.postMessage` with typed events. The vici2 calling adapter page (`/api/static/hubspot-calling.js` or a dedicated Next.js page) loads this SDK.

Key SDK methods called by the vici2 adapter:

```javascript
// Initialize
const extensions = new CallingExtensions({
  debugMode: false,
  eventHandlers: {
    onReady: () => { /* HubSpot ready, send INITIALIZED event */ },
    onDialNumber: ({ phoneNumber, ownerId, objectId, objectType, portalId }) => {
      // User clicked call — trigger vici2 dial
    },
    onCreateEngagementSucceeded: ({ engagementId }) => { /* HubSpot confirmed engagement */ },
    onCreateEngagementFailed:    () => { /* retry or fallback */ },
    onUpdateEngagementSucceeded: ({ engagementId }) => { /* update confirmed */ },
    onNavigateToRecordFailed:    () => { /* screen-pop failed */ },
    onEndCall:                   () => { /* HubSpot-initiated hangup */ },
    onVisibilityChanged:         ({ isMinimized, isHidden }) => { /* UI state sync */ },
  }
});

// Events sent from vici2 iframe to HubSpot:
extensions.initialized({ isLoggedIn: true, engagementId });   // on load
extensions.userLoggedIn();     // agent logs in/out of vici2
extensions.userLoggedOut();
extensions.outgoingCall({ phoneNumber, createEngagement: true });  // call started
extensions.callAnswered({ externalCallId });     // remote answered
extensions.callEnded({ externalCallId, engagementId });          // call ended
extensions.callCompleted({ engagementId, hideWidget: false });    // dispo done
extensions.sendError({ message });              // error state
```

### 3.3 Calling Provider Registration

The provider is registered via the HubSpot app's configuration (in the developer portal UI or via API):

```json
{
  "name": "Vici2",
  "url": "https://{TENANT_DOMAIN}/hubspot-calling",
  "width": 400,
  "height": 600,
  "supportsCustomObjects": true,
  "isReady": true,
  "supportsInboundCalling": false
}
```

This registration is per-app (not per-portal). The URL is the iframe source. In vici2's multi-tenant architecture, the URL is the shared public API base URL; tenant context is established via query parameter (`?tid={tenant_id}&token={short_lived_JWT}`).

### 3.4 Widget Flow

```
Agent in HubSpot UI
  → clicks phone icon on contact
  → HubSpot opens iframe: GET /hubspot-calling?tid=X&token=Y
  → vici2 Next.js page loads, authenticates via token
  → SDK initialized() event sent
  → Agent sees vici2 softphone UI (already-familiar)
  → HubSpot fires onDialNumber({ phoneNumber: '+15551234567', objectId: '123' })
  → vici2 iframe sends POST /api/calls/dial with phone + hs_object_id metadata
  → vici2 calls extensions.outgoingCall(...)
  → Call connects, agent talks
  → Agent clicks dispo → extensions.callEnded(...) + extensions.callCompleted(...)
  → vici2 pushes engagement write-back (§4)
```

### 3.5 Authentication Within the Widget

The iframe URL includes a short-lived token (`exp: 1h`) signed with the vici2 JWT secret, containing `{ tenant_id, user_id }`. The page uses this to establish a WebSocket session with the existing vici2 agent WS infrastructure. This avoids requiring the agent to log in separately within the iframe.

Token issuance: `POST /api/admin/integrations/hubspot/widget-token` (requires `integration:hs:click_to_dial` permission, returns a `{ token, url }` pair).

---

## 4. Call Engagement Write-Back

### 4.1 HubSpot Engagements API v3

HubSpot's v3 CRM introduces "Engagements" as a first-class object type. Call engagements are created via:

```
POST https://api.hubapi.com/crm/v3/objects/calls
Authorization: Bearer {ACCESS_TOKEN}
Content-Type: application/json

{
  "properties": {
    "hs_call_title": "Outbound call from vici2",
    "hs_call_direction": "OUTBOUND",
    "hs_call_status": "COMPLETED",
    "hs_call_duration": 125000,          // milliseconds
    "hs_call_from_number": "+15558675309",
    "hs_call_to_number": "+15551234567",
    "hs_call_body": "Disposition: SALE. Notes: customer agreed to plan A.",
    "hs_timestamp": "2026-05-13T21:10:00.000Z",
    "hs_call_recording_url": "https://vici2.example.com/recordings/abc.mp3"
  },
  "associations": [
    {
      "to": { "id": "123" },
      "types": [{ "associationCategory": "HUBSPOT_DEFINED", "associationTypeId": 194 }]
    }
  ]
}
```

`associationTypeId: 194` is the standard "call to contact" association type.

### 4.2 Engagement Status Mapping

| Vici2 Disposition | HubSpot `hs_call_status` |
|---|---|
| `SALE` | `COMPLETED` |
| `NI` (Not interested) | `COMPLETED` |
| `NA` (No answer) | `NO_ANSWER` |
| `B` (Busy) | `BUSY` |
| `AM` (Answering machine) | `VOICEMAIL_LEFT` |
| `CALLBK` | `COMPLETED` |
| `DNC` | `COMPLETED` |
| `XFER` | `COMPLETED` |
| Any other | `COMPLETED` |

The mapping is stored in `hubspot_integrations.disposition_map JSON` (editable by admin) so operators can customize without a code deploy.

### 4.3 Older Engagements API v1

The legacy `/engagements/v1/engagements` endpoint still works but HubSpot has indicated v3 (`/crm/v3/objects/calls`) is the current standard. Vici2 uses v3 exclusively. The v1 endpoint uses a different payload shape (`engagement`, `metadata`, `associations` top-level keys) and is not recommended for new integrations.

### 4.4 Recording URL Inclusion

Call recordings hosted at vici2 (module R02) can be linked in the engagement's `hs_call_recording_url` property. HubSpot will display a play button in the contact timeline if the URL is publicly accessible. For privacy-sensitive environments, this field can be omitted via `hubspot_integrations.include_recording_url BOOLEAN DEFAULT true`.

### 4.5 Note Engagements vs. Call Engagements

Some older HubSpot integrations created "Note" engagements (`/crm/v3/objects/notes`) to log call outcomes. This approach is deprecated for calling integrations — "Call" engagements appear in the dedicated "Calls" tab on the contact record and integrate with HubSpot's call analytics. Vici2 uses Call engagements exclusively.

---

## 5. HubSpot Webhooks API (Inbound Events)

### 5.1 HubSpot → Vici2 Webhooks

HubSpot can push events to vici2 when contacts change. This is complementary to the polling-based sync: webhooks provide near-real-time updates between polling cycles.

Configuration: In the HubSpot app settings, subscribe to `contact.propertyChange` events for properties: `phone`, `mobilephone`, `firstname`, `lastname`, `email`, `hs_lead_status`.

HubSpot POSTs batched event arrays to the vici2 webhook URL:

```
POST https://api.vici2.example.com/api/webhooks/hubspot
X-HubSpot-Signature: {SHA256_HMAC}
Content-Type: application/json

[
  {
    "eventId": 1,
    "subscriptionId": 12345,
    "portalId": 98765,
    "appId": 11111,
    "occurredAt": 1715000000000,
    "eventType": "contact.propertyChange",
    "propertyName": "phone",
    "propertyValue": "+15551234567",
    "objectId": 123456
  }
]
```

### 5.2 Signature Verification

HubSpot signs with `SHA-256 HMAC` using the app's `client_secret`. Vici2 verifies:

```
hash = SHA256(client_secret + request_body_raw)
```

The signature is compared against the `X-HubSpot-Signature` header value. If verification fails, vici2 returns `403` immediately.

### 5.3 Webhook Subscription Management

Subscriptions are created programmatically via:

```
POST https://api.hubapi.com/webhooks/v3/{appId}/subscriptions
Authorization: Bearer {APP_TOKEN}  ← developer app token, not portal access token
```

These are global (app-level) subscriptions, not per-portal. HubSpot delivers events for all portals where the app is installed to the same webhook URL. Vici2 dispatches events to the correct tenant by looking up `portalId` in `hubspot_integrations.portal_id`.

### 5.4 Webhook Delivery Guarantees

HubSpot delivers webhooks at-least-once with retry on non-2xx. Vici2 must return `200` quickly (within 5 seconds) and process events asynchronously. Receive-and-enqueue pattern: vici2 webhook endpoint validates signature, enqueues a BullMQ job (`hubspot-webhook-process`), and returns `200` immediately.

---

## 6. Rate Limits and Retry Strategy

### 6.1 HubSpot API Rate Limits

| Plan | API Calls/Day | API Calls/10s |
|---|---|---|
| Free / Starter | 250,000 / day | 100 / 10s |
| Professional | 500,000 / day | 150 / 10s |
| Enterprise | 1,000,000 / day | 200 / 10s |

The 10-second burst limit is the most practically binding constraint. For contact sync, a portal with 500,000 contacts requires ~5,000 paginated requests (100 contacts/page). At 100 requests/10s, this takes ~500s (~8 minutes) minimum — acceptable for a background sync.

### 6.2 Retry Strategy

All HubSpot API calls use the following retry policy:

```
Retryable status codes: 429, 500, 502, 503, 504
Max attempts: 5
Backoff: exponential with jitter
  attempt 1: base 1s  + jitter [0, 0.5s]
  attempt 2: base 2s  + jitter [0, 1s]
  attempt 3: base 4s  + jitter [0, 2s]
  attempt 4: base 8s  + jitter [0, 4s]
  attempt 5: base 16s + jitter [0, 8s]
```

For `429` responses, the `Retry-After` header is respected when present (takes precedence over backoff schedule).

### 6.3 Rate Limit Tracking

The sync worker tracks remaining quota by reading response headers:
- `X-HubSpot-RateLimit-Daily-Remaining`
- `X-HubSpot-RateLimit-Secondly-Remaining`

If `Daily-Remaining < 1000`, the sync job sets `hubspot_integrations.rate_limit_backoff_until = NOW() + 1h` and skips subsequent syncs until the window passes. An admin notification is sent via N01.

### 6.4 Engagement Push Concurrency

Engagement write-backs triggered by call dispositions are bounded to 10 concurrent HubSpot API calls per tenant (BullMQ concurrency setting on the `hubspot-push-engagement` queue). This prevents burst writes from exhausting the 10-second rate limit.

---

## 7. Multi-Portal Architecture

### 7.1 One App, Many Portals

Vici2 operates as a single HubSpot public app. The same `client_id` and `client_secret` are used across all tenants. Each tenant's portal connects independently, and the resulting `access_token` and `refresh_token` are scoped to that specific portal by HubSpot.

### 7.2 Portal Isolation

`hubspot_integrations` has a unique constraint on `tenant_id`. All API calls from the sync worker are scoped by the `access_token` for that tenant's portal. A bug in one tenant's sync cannot leak data into another tenant's records because:
- The HubSpot access token only authorizes access to that portal's data.
- The BullMQ job carries `tenant_id` in its data and all DB writes include `WHERE tenant_id = ?`.

### 7.3 App-Level vs. Portal-Level Tokens

| Token Type | Scope | Used For |
|---|---|---|
| App token (developer-issued) | Global; all portals | Webhook subscription management (one-time setup) |
| Portal access token | Single portal | All CRM data reads/writes for that tenant |

The app token is stored as an env var (`HUBSPOT_APP_TOKEN`); it is never stored in the database.

### 7.4 Portal Discovery

After OAuth, vici2 resolves the `portal_id` (HubSpot's internal hub ID):

```
GET https://api.hubapi.com/oauth/v1/access-tokens/{access_token}
→ { "hub_id": 98765, "hub_domain": "mycompany.hubspot.com", "user_id": 1234, ... }
```

The `hub_id` is stored as `hubspot_integrations.portal_id` and used to route inbound webhook events.

---

## 8. HubSpot Contact Properties for Vici2

### 8.1 Custom Properties

Vici2 creates custom HubSpot contact properties to store vici2-specific data. This allows HubSpot users to see vici2 disposition history in the contact record without needing to look at the engagement timeline.

Custom properties created on app install:

| Property Name | Type | Label |
|---|---|---|
| `vici2_last_dispo` | `enumeration` | Vici2 Last Disposition |
| `vici2_last_call_at` | `datetime` | Vici2 Last Call At |
| `vici2_call_count` | `number` | Vici2 Call Count |
| `vici2_lead_id` | `string` | Vici2 Lead ID |

These properties are written via `PATCH /crm/v3/objects/contacts/{objectId}` after each call engagement. Custom property creation uses:

```
POST https://api.hubapi.com/crm/v3/properties/contacts
Authorization: Bearer {PORTAL_ACCESS_TOKEN}
```

### 8.2 Property Groups

Custom properties are grouped under a `vici2` property group for clean display in the HubSpot contact record sidebar.

---

## 9. HubSpot Calling SDK — Detailed Message Protocol

### 9.1 SDK Initialization Sequence

```
1. HubSpot loads iframe: GET /hubspot-calling?tid=X&token=Y
2. Vici2 page loads @hubspot/calling-extensions-sdk
3. SDK detects parent frame via window.parent
4. HubSpot sends SYNC event (from parent to iframe)
5. Vici2 responds with INITIALIZED event:
   extensions.initialized({ isLoggedIn: true, sizeInfo: { width: 400, height: 600 } })
6. HubSpot stores provider readiness state
```

### 9.2 Engagement Pre-creation (CRM Calling SDK v3+)

The SDK supports a `createEngagement: true` flag in `outgoingCall()`:

```javascript
extensions.outgoingCall({
  phoneNumber: '+15551234567',
  createEngagement: true,   // HubSpot pre-creates a CALL engagement
  toNumber: '+15551234567',
  fromNumber: '+15558675309'
});
```

When `createEngagement: true`, HubSpot creates a placeholder engagement immediately and fires `onCreateEngagementSucceeded({ engagementId })`. Vici2 stores this `engagementId` and later calls:

```javascript
extensions.callEnded({
  externalCallId: 'vici2-call-uuid',
  engagementId: hubspotEngagementId
});
```

This approach allows HubSpot to show "call in progress" in the contact timeline during the call. After dispo, vici2 uses the Engagements API to update the pre-created engagement (`PATCH /crm/v3/objects/calls/{engagementId}`) rather than creating a new one.

### 9.3 Error Handling in Widget

If the agent's vici2 session token expires during a call:
1. SDK sends `extensions.sendError({ message: 'Session expired. Please refresh.' })`.
2. HubSpot displays an error state in the widget.
3. The ongoing call (FreeSWITCH leg) continues; only the widget UI loses state.
4. The engagement is written by the server-side push worker (not dependent on widget state).

---

## 10. Scope Analysis: What N01/N02 Patterns N04 Reuses

### 10.1 OAuth Token Storage (N02 Pattern)

N02 established the pattern of using `VARBINARY(512)` + `kek_version` for credential storage. N04 uses the identical pattern for HubSpot tokens. The F05 `encryptField()` / `decryptField()` helpers are already in the monorepo.

### 10.2 BullMQ Worker Pattern (N01 Pattern)

N01 established the `vici2:queue:*` naming convention and the W01 BullMQ topology. N04 adds three new queues to the W01 topology:
- `vici2:queue:hubspot-sync` — contact pull worker (repeatable, per-tenant)
- `vici2:queue:hubspot-push` — engagement write-back (triggered on call dispo)
- `vici2:queue:hubspot-webhook` — inbound webhook event processor

### 10.3 N01 Notification Integration

When the HubSpot OAuth token expires/revokes or a sync fails repeatedly, N04 calls `notify()` (N01 helper) with category `integration_error` (new category registered by N04) to alert admins in-app and via email.

---

## 11. Open Questions

| # | Question | Impact | Proposed Default |
|---|---|---|---|
| OQ-1 | Should vici2 support HubSpot **inbound** calling (HubSpot → vici2 when an inbound call arrives)? The SDK supports `supportsInboundCalling: true`, but this requires vici2 to push inbound call events to the widget. | Medium | Phase 2 — omit from N04 |
| OQ-2 | How should **field conflict** be resolved when a vici2 agent edits a lead's phone and HubSpot sync subsequently overwrites it? | High | `sync_overwrites_manual_edits = false` by default; last-HubSpot-write wins only for blank fields |
| OQ-3 | Should N04 support **HubSpot deal associations** on call engagements (linking a call to a deal, not just a contact)? | Medium | Phase 2 |
| OQ-4 | What happens when a HubSpot contact is **deleted** after being imported as a vici2 lead? | Medium | Set `leads.status = 'HS_DELETED'`; do not hard-delete vici2 lead (call history must be preserved) |
| OQ-5 | Should the sync support **all contacts** in the portal or only contacts that are members of specific HubSpot lists? | Medium | Admin choice per integration: `sync_mode = 'ALL_CONTACTS' | 'LIST_ONLY'` |
| OQ-6 | Multi-install: what if the same HubSpot portal is connected to two different vici2 tenants? | Low | Block: `portal_id` uniqueness check across all tenants at OAuth callback time |
| OQ-7 | Does the calling widget need to support **Safari iOS** (HubSpot mobile app)? | Low | Out of scope — vici2 agent UI requires a desktop browser; HubSpot mobile calling widget is separate product |
| OQ-8 | Should `vici2_last_dispo` be an enumeration property with fixed values or a plain text property? | Low | Start with plain text (no enumeration management needed); Phase 2 enumeration if HubSpot asks for Marketplace compliance |

---

## 12. Security Considerations

### 12.1 Token Leakage Prevention

- Access tokens are never returned in API responses (only connection status).
- Refresh tokens are never logged (log calls replace token values with `[REDACTED]`).
- Audit log actions `hs_integration.connected` / `.disconnected` record the portal_id, not the tokens.

### 12.2 SSRF Prevention in Webhook Endpoint

The inbound HubSpot webhook endpoint (`POST /api/webhooks/hubspot`) is public (no auth required — HubSpot can't send an auth header we issue). SSRF is not directly applicable, but the endpoint:
- Validates `X-HubSpot-Signature` before processing any payload.
- Enforces a 1 MB body size limit.
- Enqueues events for async processing (no synchronous DB reads in the handler).

### 12.3 Calling Widget Token Security

Widget tokens are short-lived JWTs (1-hour TTL) issued separately from session cookies. They are single-use from the iframe context; attempting to use the same token from a different origin fails because CORS disallows cross-origin cookie reads, and the JWT is not a cookie.

### 12.4 HubSpot App Secret Rotation

If `HUBSPOT_CLIENT_SECRET` must be rotated:
1. Generate new secret in HubSpot developer portal.
2. Update the vici2 env var.
3. Existing portal tokens remain valid (they are OAuth tokens, not signed with the client secret directly).
4. Webhook signature verification will fail temporarily until the new secret is deployed.
5. Planned rotation should be done during a maintenance window; unplanned (incident) rotation requires immediate redeploy.

---

## 13. Comparable Integration Reference

The vici2 N03 Salesforce CTI adapter serves as a useful comparison:

| Aspect | N03 (Salesforce) | N04 (HubSpot) |
|---|---|---|
| Auth | OAuth 2.0 (similar flow) | OAuth 2.0 |
| Widget SDK | Open CTI (Salesforce proprietary) | Calling Extensions SDK (HubSpot, npm) |
| Contact model | Leads + Contacts (two objects) | Contacts only (single object) |
| Activity write-back | Task + Event objects | Call engagements (crm/v3/objects/calls) |
| Rate limits | API Edition-based; Governor limits | Plan-based; 10s burst window |
| Webhook delivery | Streaming API / Pub/Sub | Webhooks v3 (HTTP POST) |
| Multi-org | OAuth scopes per org | OAuth per portal |

N04 is simpler than N03 in some respects (HubSpot has a single Contact object vs. Salesforce's Lead+Contact duality) but introduces the widget SDK requirement that N03 does not have in the same form.

---

## 14. Data Retention and GDPR Considerations

When a tenant disconnects their HubSpot integration (DELETE `/api/admin/integrations/hubspot`):
1. OAuth tokens are immediately deleted from `hubspot_integrations` (no soft-delete for tokens — this is a security requirement, not an auditing choice).
2. The `hubspot_integrations` row is soft-deleted (`deleted_at` timestamp) for audit continuity.
3. Lead data already synced remains in `leads` / `lead_external_refs` — it is the tenant's data and the tenant is responsible for its retention.
4. Future sync jobs for that tenant are cancelled (BullMQ `removeRepeatableByKey`).

If a HubSpot contact's personal data deletion request propagates to vici2 (via a custom workflow or operator action): vici2 has no automatic GDPR erasure path from HubSpot in Phase 1. This is a known gap (OQ-9 deferred).

---

## 15. Dependencies and Blockers

| Dependency | Type | Notes |
|---|---|---|
| N01 | Hard | `notify()` helper for integration error alerts; `integration_error` category added by N04 |
| N02 | Hard (OAuth token pattern) | `encryptField()` / `decryptField()` from F05; envelope encryption KEK pattern established |
| W01 | Hard | BullMQ topology — N04 adds 3 new queue slots |
| F05 | Hard | JWT middleware, `requirePermission()`, `encryptField()` |
| F02 schema | Hard | `leads`, `lists`, `audit_log` tables must exist |
| C03 | Hard | `AuditWriter` for audit chain entries |
| R02 | Soft | Recording URL on engagement; absent if R02 not deployed |
| D07 | Soft | Lead list CRUD; N04 creates lists via D07 service layer |
| HUBSPOT_CLIENT_ID env | Deploy | Public app client ID |
| HUBSPOT_CLIENT_SECRET env | Deploy | Must be env var; never in DB or code |
| HUBSPOT_APP_TOKEN env | Deploy | Developer app token for webhook subscription management |
| HUBSPOT_REDIRECT_URI env | Deploy | Must match app registration exactly |

---

*Research complete. See N04/PLAN.md for implementation decisions and schema definitions.*
