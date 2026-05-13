# N03 — Salesforce Open CTI Adapter — RESEARCH

| Field | Value |
|---|---|
| **Module** | N03 — Salesforce Open CTI Adapter |
| **Author** | N03-PLAN agent (Claude Sonnet 4.6) |
| **Date** | 2026-05-13 |
| **Status** | RESEARCH |
| **Informs** | N03/PLAN.md |

---

## 0. Scope and framing

This research covers the Salesforce Open CTI API (v1.x), its iframe-sandboxed softphone model, the postMessage bridge protocol, authentication patterns for the write-back path, multi-org considerations, and practical constraints that shape the N03 implementation.

The goal is a minimal-footprint adapter: a single JavaScript file served by vici2's Fastify API that Salesforce loads inside its softphone panel; no Salesforce managed package required for Phase 1.

---

## 1. Salesforce Open CTI architecture overview

### 1.1 What Open CTI is

Salesforce Open CTI (also called "Open CTI for Lightning Experience" since API v41.0) is a JavaScript library that Salesforce injects into the browser page when a Call Center definition points to an adapter URL. The adapter URL is an HTML page (or a JS file referenced from it) loaded in a sandboxed iframe inside the Salesforce Lightning console.

Open CTI exposes a JavaScript API (`sforce.opencti.*`) to the content loaded in the softphone iframe. The API is implemented by Salesforce via a cross-frame `window.postMessage` bridge: the adapter code calls `sforce.opencti.dial(...)` which internally posts a message to the Salesforce parent frame, which then performs the action in the Salesforce UI or CRM data layer.

### 1.2 The two-frame model

```
┌─────────────────────────────────────────────────────────────────┐
│  Salesforce Lightning Experience (parent frame, SF domain)      │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Softphone Panel iframe                                 │   │
│  │  src="https://api.vici2.example.com/adapter/sf-cti.js  │   │
│  │      (actually sf-cti.html that loads sforce lib)      │   │
│  │                                                         │   │
│  │  ┌──────────────────────────────────────────────────┐  │   │
│  │  │  vici2 agent UI (nested iframe or same frame)    │  │   │
│  │  │  src="https://web.vici2.example.com/sf?embed=sf" │  │   │
│  │  └──────────────────────────────────────────────────┘  │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

The outer adapter iframe communicates with the Salesforce parent via the `sforce.opencti` library (which uses postMessage). The inner vici2 frame communicates with the adapter iframe via a separate postMessage channel.

### 1.3 Open CTI versioning

- **Open CTI for Salesforce Classic** (pre-2016): uses `sforce.interaction.*` namespace. Legacy; not targeted.
- **Open CTI for Lightning Experience**: uses `sforce.opencti.*` namespace. Introduced with Salesforce API v37.0 (Spring '16). This is what N03 targets.
- The adapter loader URL is `https://[instance].lightning.force.com/support/api/[version]/lightning/opencti_min.js`. The version here refers to the Salesforce API version (e.g., `58.0`, `61.0`). As of 2025, v58+ is broadly supported.
- **Key rule**: the adapter HTML page must load `opencti_min.js` from the Salesforce domain, not host its own copy. The correct URL is embedded in the Call Center XML definition.

---

## 2. Open CTI postMessage protocol (SF ↔ adapter)

### 2.1 How the library works internally

`opencti_min.js` registers a `message` event listener on `window`. When the adapter calls `sforce.opencti.someMethod({ ...args, callback })`, the library:

1. Serializes the call as a JSON envelope and calls `window.parent.postMessage(envelope, '*')`.
2. Salesforce's parent frame receives the message, processes it (e.g., screen-pop, status change), and posts a response envelope back.
3. The library receives the response and invokes the registered callback.

The internal envelope format is not a public contract — adapters interact only through the `sforce.opencti.*` methods and callback pattern. This means the adapter code never directly calls `postMessage`; it calls the Open CTI JS methods.

### 2.2 The vici2 ↔ adapter postMessage layer

The vici2 agent UI runs in a nested iframe. It communicates with the adapter iframe (the Open CTI context) via `window.parent.postMessage`. This IS a contract we own and design.

### 2.3 SF → adapter events (calls initiated from Salesforce)

Salesforce invokes adapter callbacks when:
- **Click-to-dial**: `sforce.opencti.onClickToDial({ listener: fn })` — SF calls `fn({ number, recordId, recordName, objectType })`.
- **Navigation events**: In some setups, `sforce.opencti.onNavigationChange` fires when the agent navigates to a new record.
- The adapter receives these and must forward them to the vici2 inner iframe via postMessage.

### 2.4 Adapter → SF calls (adapter-initiated)

| Method | Purpose |
|---|---|
| `sforce.opencti.setSoftphonePanelVisibility({ visible })` | Show/hide the softphone panel |
| `sforce.opencti.setSoftphonePanelHeight({ heightPX })` | Resize panel |
| `sforce.opencti.setSoftphonePanelWidth({ widthPX })` | Resize panel |
| `sforce.opencti.screenPop({ type, params, callbackFunction })` | Navigate SF to a record |
| `sforce.opencti.searchAndScreenPop({ searchParams, queryParams, callbackFunction })` | Search SF and pop result |
| `sforce.opencti.getCallObjectReferences({ callbackFunction })` | Get IDs of records associated with current call |
| `sforce.opencti.saveLog({ value, callbackFunction })` | Create/update a Task in Salesforce |
| `sforce.opencti.getPhoneContacts({ callbackFunction })` | List contacts/leads from SF for directory |
| `sforce.opencti.enableClickToDial()` / `disableClickToDial()` | Enable/disable CTC links |
| `sforce.opencti.setCustomData({ value, callbackFunction })` | Attach arbitrary data to the call object |

### 2.5 Key API behaviors

- **Async/callback style**: every Open CTI method is async; results arrive in a callback. There are no Promises or async/await in the API itself; the adapter must wrap calls if Promises are desired.
- **`callbackFunction` signature**: `fn({ success: boolean, returnValue: any, errors: any[] })`.
- **`screenPop` types**: `SOBJECT` (pop a specific record), `FLOW` (launch a Flow), `URL` (navigate to URL), `SOBJECT_FROM_LOOKUP` (pop from search result).
- **`saveLog` `value` shape**: matches a Salesforce `Task` sObject. Minimum required fields: `WhatId` (related record ID) or `WhoId` (contact/lead ID), `Subject`, `Status`, `ActivityDate`, `Description`, `CallType` (Inbound/Outbound), `CallDurationInSeconds`.

---

## 3. Call Center XML definition (unmanaged package approach)

### 3.1 Call Center XML format

Salesforce requires an XML file defining the Call Center. This is imported via Setup → Call Centers → Import. Example:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<callCenter>
  <section name="reqGeneralInfo" label="General Info">
    <item name="reqInternalName" label="CTI Adapter Name">
      <value>Vici2CTIAdapter</value>
    </item>
    <item name="reqDisplayName" label="Display Name">
      <value>Vici2 Open CTI</value>
    </item>
    <item name="reqAdapterUrl" label="CTI Adapter URL">
      <value>https://api.example.com/static/sf-cti-adapter.html</value>
    </item>
    <item name="reqSoftphoneHeight" label="Softphone Height">
      <value>600</value>
    </item>
    <item name="reqSoftphoneWidth" label="Softphone Width">
      <value>300</value>
    </item>
    <item name="reqVersion" label="Version">
      <value>1.0</value>
    </item>
  </section>
  <section name="reqCustomInfo" label="Custom Settings">
    <item name="vici2TenantSlug" label="Vici2 Tenant Slug">
      <value>your-tenant</value>
    </item>
  </section>
</callCenter>
```

### 3.2 Unmanaged vs managed package

**Unmanaged package approach (Phase 1 — chosen)**:
- The CTI adapter is simply a hosted HTML+JS file at a known URL.
- Salesforce admins import the Call Center XML definition manually.
- No Salesforce AppExchange listing, no package versioning, no namespace.
- Easier to iterate. The adapter file is updated server-side; SF reloads on next login.
- Limitation: no automatic SF org configuration; admin must manually assign users to the Call Center.

**Managed package approach (Phase 2+)**:
- A Salesforce managed package bundles the Call Center definition, custom fields on Task/Lead/Contact, custom metadata types, and permission sets.
- Installed from AppExchange or a direct install URL.
- Enables automatic custom field creation (e.g., `Vici2_Lead_Id__c` on Contact, `Vici2_Dispo__c` on Task).
- Required for Salesforce ISV distribution. Phase 2+ scope.

---

## 4. Authentication flows

### 4.1 SF → vici2 (agent authentication)

The agent accesses vici2 inside the Salesforce iframe. The vici2 inner iframe at `https://web.vici2.example.com/sf?embed=sf` goes through vici2's standard JWT login flow. The agent authenticates with their vici2 credentials inside the iframe.

**Enhancement (Phase 2): SF Identity token pass-through**
Open CTI provides `sforce.opencti.getAppViewInfo({ callbackFunction })` which returns the current SF user's information. This can be used to pre-fill the login form or enable SSO (if the vici2 tenant configures SF OAuth as an identity provider). Phase 1 uses plain credential login inside the iframe.

### 4.2 vici2 → SF (write-back authentication)

For the dispo write-back (creating Tasks in SF after call disposition), vici2 must authenticate against the Salesforce REST API. Two flows are viable:

**Option A: OAuth 2.0 Web Server Flow (per-user token)**
- Tenant admin completes an OAuth flow: SF redirects to `https://api.vici2.example.com/admin/sf-integration/oauth/callback`.
- vici2 receives and stores an access_token + refresh_token per tenant (encrypted at rest).
- All write-backs use the admin user's token (or a dedicated Integration User's token).
- **Chosen for Phase 1**: simpler to implement, no SF package required. Admin does a one-time OAuth authorization.

**Option B: JWT Bearer Flow (server-to-server)**
- Requires a Connected App in SF with a certificate uploaded.
- vici2 signs a JWT with the private key; SF validates with the uploaded certificate.
- No interactive OAuth redirect; suitable for automated/headless scenarios.
- Phase 2 enhancement; better for multi-org where each tenant has their own cert.

**Token storage**: per-tenant `Setting` rows with keys:
- `sf.oauth.access_token` — encrypted via tenant KEK (same pattern as carrier credentials).
- `sf.oauth.refresh_token` — encrypted.
- `sf.oauth.instance_url` — the SF instance URL (e.g., `https://myorg.salesforce.com`).
- `sf.oauth.token_expiry` — ISO timestamp.

The write-back service refreshes the token automatically before expiry (using the refresh_token grant).

### 4.3 Salesforce Connected App setup (required for both flows)

The SF admin must create a Connected App in their org:
- Enable OAuth Settings.
- Callback URL: `https://api.vici2.example.com/admin/sf-integration/oauth/callback`.
- OAuth Scopes: `api`, `refresh_token`, `offline_access`.
- Consumer Key (Client ID) + Consumer Secret → stored in vici2 tenant settings.

---

## 5. iframe sandbox model and its constraints

### 5.1 Salesforce Content Security Policy

Salesforce Lightning Experience enforces a CSP that restricts what the adapter iframe can do:
- `frame-src` on the Salesforce parent allows the adapter URL (because it's the `reqAdapterUrl`).
- The adapter page's own CSP must allow the nested vici2 frame.
- **The adapter must set**: `Content-Security-Policy: frame-ancestors https://*.salesforce.com https://*.lightning.force.com https://*.visualforce.com`.

### 5.2 Cookies and localStorage in the adapter iframe

- **Third-party cookies**: Chrome's Privacy Sandbox (Phase 3, shipped 2024-2025) blocks third-party cookies by default. The adapter iframe at `api.vici2.example.com` inside `lightning.force.com` is a cross-site iframe — **third-party cookies are blocked by default**.
- **Impact on vici2 session**: vici2 uses an httpOnly cookie for the refresh token. Inside the SF iframe, this cookie will not be sent, which means the standard silent-refresh flow will fail.
- **Mitigation**: use `sessionStorage` inside the iframe for the access token (short-lived JWT, valid 15 min). On expiry inside the SF embed, the agent must re-enter credentials (or the adapter implements a token-passing postMessage from the outer SF page using the Open CTI identity API). Phase 1 accepts re-login; Phase 2 investigates CHIPS (Cookies Having Independent Partitioned State) or a dedicated `/embed-login` SSO endpoint.
- **localStorage**: also partitioned in cross-site iframes in Chrome 115+. The adapter must use `sessionStorage` or in-memory state.

### 5.3 WebSocket connections from the iframe

WebSocket connections from within a cross-site iframe are **not** blocked by default — WSS connections are allowed regardless of the third-party cookie policy. The vici2 inner frame can maintain a WSS connection to `api.vici2.example.com` for real-time events. SIP.js WebRTC for the softphone also works from within the iframe (mic permission may require user gesture within the iframe context).

### 5.4 Microphone permissions in iframes

Chrome 64+ requires explicit `allow="microphone"` attribute on the `<iframe>` tag for microphone access. Since the softphone panel iframe `<iframe>` is inserted by Salesforce's own code, **we cannot add `allow="microphone"` ourselves**.

**Finding**: Salesforce Open CTI documentation (developer.salesforce.com) states that the softphone iframe is rendered with `allow="microphone camera"` in Lightning Experience. This is a known accommodation by Salesforce for CTI adapters. Confirmed behavior: mic access works inside the adapter iframe as of API v55+.

However, WebRTC in a nested iframe (vici2 agent UI nested inside the adapter iframe) requires `allow="microphone"` to propagate. The adapter's HTML must include `allow="microphone"` on the inner `<iframe>` it creates for the vici2 UI.

### 5.5 Cross-Origin restrictions summary

| Feature | Status in SF iframe | Mitigation |
|---|---|---|
| Third-party cookies | Blocked (Chrome 115+) | Use short-lived JWT in sessionStorage |
| Refresh token cookie | Blocked | Implement token-pass via postMessage or re-login |
| localStorage | Partitioned | Use sessionStorage or in-memory only |
| WebSocket | Allowed | No change needed |
| WebRTC/mic | Allowed (SF adds `allow="microphone"`) | Propagate to inner iframe |
| `window.opener` | null (sandboxed) | No impact |
| `document.domain` | Blocked | Use postMessage only |

### 5.6 iframe `sandbox` attribute

Salesforce does NOT apply `sandbox` attribute to the CTI adapter iframe (as of 2025). This was a concern in earlier Open CTI implementations but is not the current behavior. The adapter iframe is treated as a regular cross-origin frame. However, our nested vici2 iframe inside the adapter should be given `allow-scripts allow-same-origin allow-microphone` if needed.

---

## 6. Two-way bridge design: SF ↔ vici2

### 6.1 SF → vici2 data flows

| Trigger | SF mechanism | Bridge step | vici2 action |
|---|---|---|---|
| Click-to-dial from Contact | `onClickToDial` callback | adapter posts `{type:"sf:dial", number, recordId, recordName, objectType}` to inner iframe | vici2 agent UI initiates outbound call, imports lead if not found |
| Agent views Contact record | `onNavigationChange` (where available) | adapter posts `{type:"sf:navigate", recordId, objectType}` | vici2 UI optionally highlights matching lead |
| Adapter iframe loads | Open CTI init | adapter posts `{type:"sf:init", userId, orgId}` | vici2 stores SF context for write-back |

### 6.2 vici2 → SF data flows

| vici2 event | postMessage to adapter | SF action |
|---|---|---|
| Call connected (agent in INCALL) | `{type:"vici2:callConnected", callId, leadPhone, leadName}` | `sforce.opencti.screenPop` to matching Contact/Lead, `setSoftphonePanelVisibility(true)` |
| Call ended (hangup) | `{type:"vici2:callEnded", callId, duration}` | adapter updates internal state |
| Dispo submitted | `{type:"vici2:dispoCommitted", callId, dispo, notes, leadId, sfRecordId}` | `sforce.opencti.saveLog(Task)` |
| Agent state change | `{type:"vici2:agentState", state}` | (optional) `setCustomData` for custom wallboard |
| Request screen-pop | `{type:"vici2:screenPop", sfRecordId}` | `sforce.opencti.screenPop` |

### 6.3 Lead deduplication on click-to-dial

When SF fires click-to-dial with a `number`, vici2 must:
1. Normalize the phone number to E.164.
2. Query `GET /api/leads?phone=<e164>&limit=1` to find an existing lead.
3. If found: proceed with that lead as the current lead context.
4. If not found: auto-create a lead via `POST /api/leads` with `first_name` from `recordName`, `phone` from `number`, `source='salesforce'`, and `sf_record_id` from `recordId`.
5. Store `sf_record_id` on the lead for the write-back path.

This dedup logic runs in the vici2 inner iframe (it has API access via the agent's JWT session).

---

## 7. Dispo write-back via N01 webhook pattern

### 7.1 Write-back mechanism

N01 defines a webhook outbound dispatch system. N03 reuses the webhook infrastructure to POST call disposition data to Salesforce's REST API rather than to a generic HTTP endpoint.

**Write-back flow**:
1. Agent submits dispo in vici2 agent UI.
2. vici2 agent UI posts `{type:"vici2:dispoCommitted", ...}` to adapter iframe.
3. Adapter iframe calls `sforce.opencti.saveLog({ value: taskPayload, callbackFunction })`.
4. **Concurrently**: vici2 backend (via BullMQ job) calls `PATCH /services/data/v58.0/sobjects/Task/{taskId}` on the SF instance if a prior Task was already created (e.g., on call start), OR `POST /services/data/v58.0/sobjects/Task` if no prior Task exists.

The backend write-back (step 4) is more reliable than relying on `saveLog` in the browser (step 3) because:
- The agent may close the browser tab before dispo is saved.
- `saveLog` requires the adapter iframe to still be alive.
- Backend write-back runs asynchronously via BullMQ and survives browser disconnects.

**Dual write strategy**: both `saveLog` (fast, browser-side, best-effort) and backend BullMQ job (reliable, server-side, retry 3×) run. Duplicate Task prevention: the backend job checks for an existing Task with `Vici2_Call_Id__c = callId` before creating a new one. Phase 1 uses a standard `Description` field to embed `callId`; Phase 2 adds the custom field via managed package.

### 7.2 Salesforce Task payload mapping

| vici2 field | SF Task field | Notes |
|---|---|---|
| `callId` | `Description` (prefix: `[vici2:callId:${callId}]`) | Phase 1 dedup key |
| `leadId` via `sf_record_id` | `WhoId` (Lead) or `WhatId` | SF record type determines which |
| `dispo.label` | `Subject` | e.g., "Call: SALE" |
| `dispo.status_category` | `Status` | Mapped: SALE→Completed, NOANSWER→Not Started, etc. |
| call `start_at` | `ActivityDate` | Date portion only |
| `callDuration` seconds | `CallDurationInSeconds` | Integer |
| call direction | `CallType` | `"Inbound"` or `"Outbound"` |
| agent notes | `Description` (appended) | After callId prefix |
| vici2 lead URL | `Description` (appended) | Deep link to vici2 lead |

---

## 8. Multi-org support

### 8.1 Tenant isolation

Each vici2 tenant corresponds to exactly one Salesforce org (in Phase 1). Multi-org per vici2 tenant is out of scope.

The adapter URL contains the tenant slug as a query parameter: `https://api.vici2.example.com/static/sf-cti-adapter.html?tenant=acme`. The adapter HTML reads this from `location.search` and passes it through to the vici2 inner iframe URL.

### 8.2 Per-tenant Connected App credentials

Each tenant must configure their own Salesforce Connected App (Client ID + Secret). These are stored encrypted in the `Setting` table:
- `sf.oauth.client_id`
- `sf.oauth.client_secret`
- `sf.oauth.instance_url`
- `sf.oauth.access_token` (encrypted)
- `sf.oauth.refresh_token` (encrypted)

### 8.3 Multiple SF orgs per tenant (Phase 2)

Some enterprise tenants operate multiple SF orgs (sandbox + production). Phase 2 would introduce an `sf_integrations` table with multiple rows per tenant and a UI to switch active org.

---

## 9. Open CTI limitations discovered

### 9.1 No native answer/reject support

Open CTI does not provide a method for the adapter to "answer" or "reject" a call triggered by Salesforce. The adapter can only listen for click-to-dial and initiate calls from the vici2 side. Inbound calls are entirely managed by vici2; the adapter can do a `screenPop` but cannot hook into SF's telephony state machine.

### 9.2 `screenPop` requires an existing SF record

`sforce.opencti.screenPop({ type: 'SOBJECT', params: { recordId } })` requires a valid SF record ID. If the inbound caller has no matching SF Contact/Lead, `searchAndScreenPop` can be used to do a search-based pop. If no match is found, SF shows a "no record found" result — the adapter cannot programmatically create a new record via Open CTI (write operations go through the REST API, not Open CTI).

### 9.3 `saveLog` creates a Task, not a Call record

Salesforce has both `Task` and `CallLog` concepts. `sforce.opencti.saveLog` creates or updates a `Task` object. Salesforce's own dialer (Sales Dialer) uses a different internal call object. For most CRM use cases, Task is the correct object for completed call records.

### 9.4 Lightning console app requirement

Open CTI for Lightning Experience works only in Salesforce Lightning Experience with a Console App (Service Cloud Console or Sales Console). It does NOT work in:
- Salesforce Classic (uses different `sforce.interaction.*` API).
- Standard Lightning pages (non-console). Open CTI requires the console app navigation model.
- Mobile (Salesforce1) — different SDK applies.

### 9.5 URL scheme for adapter

Salesforce requires the adapter URL to be HTTPS with a valid TLS certificate. `localhost` is allowed only in certain sandbox configurations via a special `reqAdapterUrl` that includes `localhost`. Production must use a publicly reachable HTTPS URL.

### 9.6 Popup windows

The adapter cannot open new browser windows or tabs (`window.open`) in a meaningful way from inside the Salesforce iframe — Salesforce's CSP and browser popup blockers prevent this. All UI interactions must stay within the softphone panel iframe.

### 9.7 Event payload size

`sforce.opencti.setCustomData` is limited to approximately 10 KB of JSON data. Do not use it to pass large lead records — use only IDs and minimal state.

### 9.8 Open CTI version pinning

The `opencti_min.js` URL contains the API version. Newer SF releases introduce new methods but do not remove existing ones (backward compatible). We target v58.0+ which covers most active SF orgs as of 2025-2026. The Call Center XML should reference a version that is available on the tenant's SF release.

---

## 10. Security considerations

### 10.1 postMessage origin validation

The adapter iframe receives postMessage events from two sources:
- The Salesforce parent frame (via the Open CTI library). The library handles origin validation internally.
- The inner vici2 iframe (`web.vici2.example.com`). The adapter must validate `event.origin === 'https://web.vici2.example.com'` before processing messages.

Similarly, the vici2 inner iframe must validate `event.origin === 'https://api.vici2.example.com'` for messages from the adapter.

### 10.2 Click-to-dial number validation

SF sends the phone number as a string. The adapter must normalize and validate it (must be a dialable phone number) before forwarding to vici2. Reject non-phone payloads to prevent injection.

### 10.3 Token exposure

The vici2 JWT access token in sessionStorage inside the SF iframe is accessible to the adapter JavaScript. Since the adapter is served from `api.vici2.example.com`, this is same-origin with the API — acceptable. However, the adapter JS file must be served with correct caching headers (no public CDN caching of user-session content) and the token must be short-lived (15 min).

### 10.4 Salesforce Connected App secret handling

The OAuth Client Secret for the SF Connected App is stored encrypted via the tenant KEK (same pattern as carrier SIP credentials in M06). The decrypted secret is never exposed via any API endpoint; it is used only server-side for the OAuth token exchange.

### 10.5 CSRF for the OAuth callback

The OAuth callback endpoint at `/admin/sf-integration/oauth/callback` must validate the `state` parameter (opaque random value stored in the admin's session) to prevent CSRF on the OAuth authorization code exchange.

---

## 11. Reference: Salesforce Open CTI API methods (v58.0)

### 11.1 Panel management
- `setSoftphonePanelVisibility({ visible: boolean, callback })`
- `setSoftphonePanelHeight({ heightPX: number, callback })`
- `setSoftphonePanelWidth({ widthPX: number, callback })`
- `isSoftphonePanelVisible({ callback })`

### 11.2 Record navigation (screen pop)
- `screenPop({ type: 'SOBJECT'|'URL'|'FLOW'|'NEW_RECORD_MODAL', params: {...}, callback })`
- `searchAndScreenPop({ searchParams: string, queryParams: {...}, callback })`
- `getCallObjectReferences({ callback })` — returns `[{ objectId, objectName }]`

### 11.3 Call logging
- `saveLog({ value: Partial<Task>, callbackFunction })` — upsert Task
- `refreshView()` — reload current SF page view

### 11.4 Event listeners
- `onClickToDial({ listener: fn })` — fires on CTD link click
- `onNavigationChange({ listener: fn })` — fires on record navigation
- `onSoftphoneOpen({ listener: fn })` — fires when panel opens
- `onSoftphoneClose({ listener: fn })` — fires when panel closes

### 11.5 Utility
- `enableClickToDial()` / `disableClickToDial()`
- `runApex({ apexClass, methodName, methodParams, callback })` — invoke Apex class (managed package use only)
- `getAppViewInfo({ callback })` — returns `{ apiVersion, appName, entityId, orgId, userId, userProfileId }`
- `setCustomData({ value: Record<string, unknown>, callback })` — attach data to call

---

## 12. Open questions

1. **Mic permission propagation**: does Salesforce's `allow="microphone"` on the adapter iframe automatically propagate to a nested `<iframe>` inside the adapter? Need to verify with Feature Policy / Permissions Policy inheritance rules in Chrome. Mitigation if not: host the vici2 UI in the adapter iframe directly (not nested).

2. **Token persistence across tab switches**: SF Lightning tabs can suspend/resume iframes. When the agent switches away and back, the sessionStorage is preserved but the WSS connection may have been dropped. Does vici2's existing reconnect logic handle this gracefully for the embed mode?

3. **Screen-pop race condition**: inbound calls arrive via vici2 WS push. The adapter must fire `screenPop` only after the agent has answered (or is presented the call). If `screenPop` fires during ringing, the SF UI context shifts before the agent has decided to accept. Design must sequence: ring notification → agent accepts → screen pop fires.

4. **Multi-tenant adapter URL**: using `?tenant=` in the adapter URL means one Call Center definition per vici2 tenant. This is correct for Phase 1. For partners hosting vici2, they will configure multiple Call Center definitions.

5. **Salesforce API version compatibility**: some customers may be on older Salesforce orgs (pre-v58). Should the adapter detect and degrade gracefully? Phase 1: document minimum requirement (API v55+). Phase 2: runtime version detection via `getAppViewInfo`.

6. **`saveLog` vs backend Task creation**: if the agent completes dispo while the SF session has expired (token revocation), the backend write-back job will fail on the first attempt and retry. Does the retry logic surface a meaningful error to the agent? Need to implement a notification path (N01 `notify()`) for Task write-back failures.

7. **Custom SF fields for dispo codes**: without a managed package, vici2 dispo codes map to Task `Description` freeform text. Is this sufficient for customers who want to report on dispo codes via SOQL? Phase 2: managed package installs `Vici2_Dispo__c` (picklist) on Task.

8. **Sandbox vs production SF orgs**: should the integration UI allow configuring separate sandbox and production instances? Phase 1: one instance URL per tenant. Phase 2: add `sf.sandbox_instance_url` alongside `sf.instance_url`.

---

## 13. References and sources

- Salesforce Developer Documentation: "Open CTI for Lightning Experience" (developer.salesforce.com/docs/atlas.en-us.api_cti.meta)
- Salesforce API reference: `sforce.opencti.*` method signatures (v58.0)
- Chrome Privacy Sandbox: third-party cookie deprecation timeline (chromium.org/privacy-sandbox)
- Chrome Permissions Policy: feature delegation to iframes (chromium.org)
- CHIPS (Cookies Having Independent Partitioned State): RFC proposal and Chrome implementation
- Salesforce Task sObject fields reference (developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/sforce_api_objects_task.htm)
- Salesforce Connected Apps OAuth flows (developer.salesforce.com)
- N01/PLAN.md: webhook/notification infrastructure (vici2 internal)
- N02/PLAN.md: OAuth app pattern reference (vici2 internal)
