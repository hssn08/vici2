# N03 — Salesforce Open CTI Adapter — PLAN

| Field | Value |
|---|---|
| **Module** | N03 — Salesforce Open CTI Adapter |
| **Author** | N03-PLAN agent (Claude Sonnet 4.6) |
| **Date** | 2026-05-13 |
| **Status** | PLAN |
| **Depends on (FROZEN)** | N01 (BullMQ queue `vici2:queue:webhook-dispatch`, `notify()` signature), A02 (agent state machine, dispo flow), A03 (AgentShell, embed mode), F05 (JWT/auth middleware, `requireAuth`, `requirePermission`), F02 schema (users, tenants, Setting model), C03 (AuditWriter), M06 (carrier credential encryption pattern) |
| **Blocks** | nothing in Phase 1 |

Once approved, the following are **FROZEN**: adapter HTML path (`/static/sf-cti-adapter.html`), adapter JS path (`/static/sf-cti.js`), manifest XML path (`/static/sf-cti-manifest.xml`), postMessage event type strings (`sf:dial`, `sf:init`, `sf:navigate`, `vici2:callConnected`, `vici2:callEnded`, `vici2:dispoCommitted`, `vici2:agentState`, `vici2:screenPop`), REST endpoint paths under `/api/admin/sf-integration`, OAuth callback path (`/admin/sf-integration/oauth/callback`), RBAC verbs (`integration:sf:configure`, `integration:sf:click_to_dial`), BullMQ queue name (`vici2:queue:sf-writeback`), and Prisma model name (`SfIntegration`). Internal field-mapping schema and UI CSS may change without RFC.

---

## 0. TL;DR — 12-bullet decision summary

1. **Single-file adapter approach.** Salesforce loads `sf-cti-adapter.html` (served by Fastify `@fastify/static`). This HTML bootstraps `opencti_min.js` from the SF instance, then loads the vici2 agent UI in a nested `<iframe>`. No Salesforce managed package required for Phase 1.
2. **Three-layer postMessage protocol.** SF parent ↔ adapter iframe (via Open CTI library), adapter iframe ↔ vici2 inner iframe (our owned protocol, 8 message types). Origin validation enforced on both sides.
3. **`?embed=sf` flag in vici2 agent UI.** The Next.js agent shell detects `embed=sf` from the query string, suppresses TopNav and SideNav, sizes to the 300×600 px softphone panel, and renders a compact call-control layout.
4. **Click-to-dial auto-imports leads.** On `sf:dial`, the adapter passes the phone number and SF record metadata to the vici2 inner iframe; vici2 deduplicates by phone (E.164 normalized), auto-creates a lead if absent (setting `source='salesforce'` and `sf_record_id`), and immediately initiates the outbound call.
5. **Inbound screen-pop via WS push.** When vici2 assigns an inbound call to the agent, the WS push event reaches the vici2 inner iframe, which posts `vici2:screenPop` to the adapter; the adapter calls `sforce.opencti.searchAndScreenPop` with the caller's phone number. The screen pop fires only after the agent has accepted the call (race-condition guard).
6. **Dispo write-back: dual strategy.** Browser-side: adapter calls `sforce.opencti.saveLog(Task)` immediately on dispo commit (fast, best-effort). Server-side: BullMQ job on queue `vici2:queue:sf-writeback` (reliable, retry 3×). Backend job deduplicates via `Description` prefix `[vici2:callId:…]` in Phase 1; Phase 2 uses `Vici2_Call_Id__c` custom field.
7. **OAuth 2.0 Web Server Flow for SF credentials.** Per-tenant Connected App credentials (Client ID + Secret) stored encrypted in `Setting` table using tenant KEK (same pattern as M06 carrier credentials). Admin completes one-time OAuth authorization; `access_token` and `refresh_token` stored encrypted. Token auto-refresh before expiry.
8. **New `SfIntegration` Prisma model.** One row per tenant. Stores encrypted OAuth tokens, field-mapping JSON, enabled flag, and last-sync timestamps. Replaces the simpler `Setting` key-value approach to allow future multi-org support.
9. **Third-party cookie workaround.** Chrome 115+ blocks third-party cookies in cross-site iframes. The vici2 agent UI in the SF iframe cannot use the httpOnly refresh-token cookie. Phase 1: agent logs in within the iframe using credentials; access token stored in `sessionStorage` (15-min expiry). Phase 2: investigate CHIPS or a token-pass mechanism via the Open CTI identity API.
10. **RBAC: two new verbs.** `integration:sf:configure` (admin+ to manage SF integration settings) and `integration:sf:click_to_dial` (agent+ to use click-to-dial). Both additive to existing ROLE_VERBS matrix.
11. **Fastify `@fastify/static` serves static adapter files.** The adapter HTML, JS, and manifest XML are served from `api/src/static/`. No CDN in Phase 1; CSP headers set server-side.
12. **LOC target: ~900.** Adapter JS (~220 LOC), bridge module (~120 LOC), backend routes (~180 LOC), write-back worker (~120 LOC), migration (~60 LOC), admin UI component (~200 LOC).

---

## 1. Goals and non-goals

### 1.1 Phase 1 Goals

- Salesforce Open CTI adapter served from vici2 API (`/static/sf-cti-adapter.html`, `/static/sf-cti.js`).
- Call Center XML manifest (`/static/sf-cti-manifest.xml`) for admin download.
- postMessage bridge: 8 message types (5 directions: SF→vici2; 3 directions: vici2→SF).
- `?embed=sf` mode in Next.js agent shell: compact layout, no nav chrome.
- Click-to-dial: auto-import lead, auto-dial.
- Inbound screen-pop: normalized phone search via `searchAndScreenPop`.
- Dispo write-back: browser-side `saveLog` + server-side BullMQ job.
- OAuth 2.0 flow for SF credentials (admin setup UI).
- Encrypted credential storage via tenant KEK (reuse M06 pattern).
- `SfIntegration` Prisma model + migration.
- RBAC: `integration:sf:configure` (admin+), `integration:sf:click_to_dial` (agent+).
- Admin configuration UI: SF org credentials, field mappings, OAuth connect button.
- Unit tests: postMessage bridge, dispo mapping, token refresh logic.

### 1.2 Phase 2 (deferred)

- JWT Bearer Flow (server-to-server, no interactive OAuth).
- Managed Salesforce package (custom fields on Task, Lead; AppExchange listing).
- Multiple SF orgs per tenant (sandbox + production).
- SF Identity token pass-through for SSO into vici2 within the iframe (no re-login).
- CHIPS cookie support for persistent sessions in the SF iframe.
- Lead/Contact sync (bidirectional field sync, not just on-click-to-dial).
- `runApex` for custom Apex triggers on dispo (managed package only).
- Custom dispo code picklist field `Vici2_Dispo__c` on SF Task.
- Salesforce Flows launch on specific dispo outcomes.

### 1.3 Non-goals (Phase 1)

- Salesforce Classic support (`sforce.interaction.*` API).
- Salesforce Mobile (Salesforce1).
- Multi-channel routing (Salesforce Omni-Channel integration).
- SF Lead/Contact bidirectional sync (beyond auto-import on click-to-dial).
- SF Opportunity creation on SALE dispo (Phase 2 managed package).
- CTI analytics dashboard in SF (Salesforce reports — use vici2 native reports).

---

## 2. Schema

### 2.1 `sf_integrations` table

```sql
CREATE TABLE sf_integrations (
  id               BIGINT      NOT NULL AUTO_INCREMENT,
  tenant_id        BIGINT      NOT NULL,
  enabled          TINYINT(1)  NOT NULL DEFAULT 0,
  instance_url     VARCHAR(255) NULL    COMMENT 'e.g. https://myorg.salesforce.com',
  client_id        VARCHAR(512) NULL    COMMENT 'Connected App Consumer Key (plaintext)',
  client_secret    BLOB         NULL    COMMENT 'AES-256-GCM encrypted Consumer Secret',
  access_token     BLOB         NULL    COMMENT 'AES-256-GCM encrypted access token',
  refresh_token    BLOB         NULL    COMMENT 'AES-256-GCM encrypted refresh token',
  token_expiry     DATETIME(6)  NULL,
  field_mappings   JSON         NOT NULL DEFAULT (JSON_OBJECT()),
  last_writeback_at DATETIME(6) NULL,
  last_error       TEXT         NULL,
  created_at       DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at       DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uk_sf_tenant (tenant_id),
  CONSTRAINT fk_sf_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE
);
```

**Prisma model:**

```prisma
model SfIntegration {
  id              BigInt    @id @default(autoincrement())
  tenantId        BigInt    @unique @map("tenant_id")
  enabled         Boolean   @default(false)
  instanceUrl     String?   @db.VarChar(255) @map("instance_url")
  clientId        String?   @db.VarChar(512) @map("client_id")
  clientSecret    Bytes?    @map("client_secret")
  accessToken     Bytes?    @map("access_token")
  refreshToken    Bytes?    @map("refresh_token")
  tokenExpiry     DateTime? @db.DateTime(6) @map("token_expiry")
  fieldMappings   Json      @default("{}") @map("field_mappings")
  lastWritebackAt DateTime? @db.DateTime(6) @map("last_writeback_at")
  lastError       String?   @db.Text @map("last_error")
  createdAt       DateTime  @default(now()) @db.DateTime(6) @map("created_at")
  updatedAt       DateTime  @updatedAt @db.DateTime(6) @map("updated_at")

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@map("sf_integrations")
}
```

### 2.2 Lead model additions

Existing `Lead` model gains one field (migration appends column):

```prisma
// In model Lead — add:
sfRecordId      String?  @db.VarChar(32) @map("sf_record_id")
sfObjectType    String?  @db.VarChar(32) @map("sf_object_type")  // 'Contact' | 'Lead'
```

```sql
ALTER TABLE leads
  ADD COLUMN sf_record_id   VARCHAR(32) NULL AFTER source,
  ADD COLUMN sf_object_type VARCHAR(32) NULL AFTER sf_record_id,
  ADD INDEX idx_leads_sf_record (sf_record_id);
```

### 2.3 Field mappings JSON schema

`sf_integrations.field_mappings` is a JSON object with the following shape:

```typescript
interface SfFieldMappings {
  // Dispo code → SF Task Status mapping
  dispoToTaskStatus?: Record<string, string>;
  // e.g. { "SALE": "Completed", "NOANSWER": "Not Started", "DNC": "Deferred" }

  // Dispo code → SF Task CallType override
  dispoToCallType?: Record<string, 'Inbound' | 'Outbound'>;

  // Which lead fields to populate on auto-import from SF Contact
  sfContactToLead?: {
    firstName?: string;   // SF field name, default: 'FirstName'
    lastName?: string;    // default: 'LastName'
    email?: string;       // default: 'Email'
    company?: string;     // default: 'Account.Name'
  };

  // Which lead fields to populate on auto-import from SF Lead
  sfLeadToLead?: {
    firstName?: string;
    lastName?: string;
    email?: string;
    company?: string;
    status?: string;
  };
}
```

Default mapping (applied when `field_mappings` is empty `{}`):

```typescript
const DEFAULT_MAPPINGS: SfFieldMappings = {
  dispoToTaskStatus: {
    'SALE':     'Completed',
    'NOANSWER': 'Not Started',
    'BUSY':     'Not Started',
    'DNC':      'Deferred',
    'CBHOLD':   'In Progress',
    'CALLBACK': 'In Progress',
  },
};
```

---

## 3. postMessage protocol schema

All messages use a discriminated union on the `type` field. Both the adapter iframe and the vici2 inner iframe validate `event.origin` before processing.

### 3.1 SF → vici2 (via adapter → inner iframe)

The adapter receives these from the Open CTI library and forwards them to the vici2 inner iframe.

```typescript
// Fired when SF user clicks a click-to-dial phone link
interface SfDialMessage {
  type: 'sf:dial';
  number: string;           // Raw phone number from SF (not necessarily E.164)
  recordId: string;         // SF record ID (15 or 18 char)
  recordName: string;       // Display name of the record
  objectType: 'Lead' | 'Contact' | 'Account' | string;
}

// Fired on adapter initialization — passes SF context to vici2
interface SfInitMessage {
  type: 'sf:init';
  userId: string;           // SF User ID
  orgId: string;            // SF Org ID
  apiVersion: string;       // e.g. '58.0'
  tenantSlug: string;       // Extracted from adapter URL query param
}

// Fired when SF agent navigates to a different record
interface SfNavigateMessage {
  type: 'sf:navigate';
  recordId: string;
  objectType: string;
}

// Fired when the softphone panel is opened by the user
interface SfPanelOpenMessage {
  type: 'sf:panelOpen';
}

// Fired when the softphone panel is closed by the user
interface SfPanelCloseMessage {
  type: 'sf:panelClose';
}
```

### 3.2 vici2 → SF (via inner iframe → adapter → Open CTI)

The vici2 inner iframe posts these to `window.parent`; the adapter receives them and calls the appropriate Open CTI method.

```typescript
// Agent is now in a live call — adapter triggers screen pop
interface Vici2CallConnectedMessage {
  type: 'vici2:callConnected';
  callId: string;           // vici2 call_log UUID
  leadPhone: string;        // E.164 normalized phone
  leadName: string;         // Display name
  sfRecordId?: string;      // If known (from prior click-to-dial or lead.sf_record_id)
  direction: 'inbound' | 'outbound';
}

// Call has ended
interface Vici2CallEndedMessage {
  type: 'vici2:callEnded';
  callId: string;
  durationSeconds: number;
}

// Agent submitted a disposition
interface Vici2DispoCommittedMessage {
  type: 'vici2:dispoCommitted';
  callId: string;
  dispo: string;            // Dispo code e.g. 'SALE'
  dispoLabel: string;       // Human label e.g. 'Sale'
  notes: string;
  leadId: number;           // vici2 lead ID
  sfRecordId?: string;      // SF Contact/Lead record ID (if available)
  sfObjectType?: 'Lead' | 'Contact';
  callDurationSeconds: number;
  callStartAt: string;      // ISO 8601
  direction: 'inbound' | 'outbound';
}

// Agent state changed (READY, PAUSED, INCALL, etc.)
interface Vici2AgentStateMessage {
  type: 'vici2:agentState';
  state: string;            // e.g. 'READY', 'PAUSED', 'INCALL'
  pauseCode?: string;
}

// vici2 requests SF to screen-pop a specific record
interface Vici2ScreenPopMessage {
  type: 'vici2:screenPop';
  sfRecordId: string;
  objectType: 'Lead' | 'Contact' | 'Account';
}
```

### 3.3 Adapter internal state machine

```
IDLE
  → on sf:dial: set pendingDial, post to vici2 inner iframe
  → on vici2:callConnected: fire screenPop, transition to INCALL
INCALL
  → on vici2:callEnded: transition to DISPO_PENDING
DISPO_PENDING
  → on vici2:dispoCommitted: call saveLog, transition to IDLE
```

---

## 4. File layout

```
api/src/
  static/
    sf-cti-adapter.html          # Entry point loaded by SF (bootstraps opencti_min.js)
    sf-cti.js                    # Adapter bridge logic (vanilla JS, no build step)
    sf-cti-manifest.xml          # Call Center XML for SF admin download
  routes/
    adapters/
      sf-integration/
        index.ts                 # Route registration
        schema.ts                # Zod schemas for request/response
        service.ts               # Business logic (token exchange, write-back dispatch)
        token-store.ts           # Encrypt/decrypt SF tokens via tenant KEK
        task-mapper.ts           # vici2 dispo → SF Task field mapping
  workers/
    sf-writeback.worker.ts       # BullMQ worker: POST/PATCH SF Task via REST API

web/src/
  app/
    (sf)/
      layout.tsx                 # Embed layout: no TopNav/SideNav, compact sizing
      page.tsx                   # SF embed agent shell entry point
  components/
    sf-cti/
      openCtiBridge.ts           # postMessage bridge: receives from adapter, posts back
      SfCallControls.tsx         # Compact call controls for SF embed mode
      SfDispoPanel.tsx           # Compact dispo panel for SF embed mode
      useSfBridge.ts             # React hook wiring up openCtiBridge

shared/types/src/
  rbac.ts                        # Add integration:sf:configure, integration:sf:click_to_dial
```

---

## 5. Adapter HTML and JS (`api/src/static/`)

### 5.1 `sf-cti-adapter.html`

The adapter HTML is the entry point. Salesforce loads this URL in the softphone panel iframe.

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Vici2 CTI Adapter</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { width: 300px; height: 600px; overflow: hidden; background: #1a1a2e; }
    #vici2-frame { width: 100%; height: 100%; border: none; }
    #sf-cti-loading {
      position: absolute; inset: 0; display: flex;
      align-items: center; justify-content: center;
      background: #1a1a2e; color: #94a3b8; font-family: system-ui;
      font-size: 13px;
    }
  </style>
</head>
<body>
  <div id="sf-cti-loading">Connecting to Vici2...</div>
  <iframe
    id="vici2-frame"
    style="display:none"
    allow="microphone; camera; autoplay"
    referrerpolicy="no-referrer-when-downgrade"
  ></iframe>

  <!--
    opencti_min.js is loaded dynamically in sf-cti.js after reading
    the SF instance URL from the Call Center definition / URL params.
    The script tag is injected at runtime because the SF instance URL
    varies per tenant.
  -->
  <script src="sf-cti.js"></script>
</body>
</html>
```

### 5.2 `sf-cti.js` structure (vanilla JS, ~220 LOC)

```javascript
/**
 * sf-cti.js — Vici2 Open CTI Adapter
 * Served from: https://api.vici2.example.com/static/sf-cti.js
 *
 * Execution context: Salesforce Lightning softphone panel iframe.
 * No bundler — vanilla ES2020 (supported by all modern browsers).
 * No external dependencies beyond opencti_min.js (injected from SF instance).
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // 1. Configuration: read tenant slug from query params
  // ---------------------------------------------------------------------------
  const params = new URLSearchParams(location.search);
  const TENANT_SLUG = params.get('tenant') || '';
  const VICI2_WEB_ORIGIN = params.get('web_origin') || 'https://web.vici2.example.com';
  const VICI2_ADAPTER_ORIGIN = location.origin;

  if (!TENANT_SLUG) {
    console.error('[vici2-cti] Missing ?tenant= parameter');
  }

  // ---------------------------------------------------------------------------
  // 2. Load opencti_min.js from the Salesforce instance
  // ---------------------------------------------------------------------------
  // The SF instance URL is not known at adapter author time.
  // Salesforce passes the instance URL to the iframe via the URL hash or
  // via the calling frame's origin. We read the SF origin from postMessage.
  let sfOriginResolved = false;
  let openCtiReady = false;

  function loadOpenCtiLib(sfInstanceUrl) {
    if (sfOriginResolved) return;
    sfOriginResolved = true;
    const sfVersion = params.get('api_version') || '58.0';
    const script = document.createElement('script');
    script.src = `${sfInstanceUrl}/support/api/${sfVersion}/lightning/opencti_min.js`;
    script.onload = onOpenCtiLoaded;
    document.head.appendChild(script);
  }

  // Salesforce always posts the first message from the instance domain;
  // we use it to detect the SF origin and load the lib.
  window.addEventListener('message', function (e) {
    if (!sfOriginResolved && e.data && typeof e.data === 'object') {
      const origin = e.origin;
      if (origin.includes('.salesforce.com') ||
          origin.includes('.lightning.force.com') ||
          origin.includes('.visualforce.com')) {
        loadOpenCtiLib(origin);
      }
    }
  }, false);

  // Fallback: try to detect from document.referrer
  if (document.referrer) {
    try {
      const ref = new URL(document.referrer);
      if (ref.hostname.includes('salesforce.com') ||
          ref.hostname.includes('force.com')) {
        loadOpenCtiLib(ref.origin);
      }
    } catch (_) {}
  }

  // ---------------------------------------------------------------------------
  // 3. State machine
  // ---------------------------------------------------------------------------
  const State = { IDLE: 'IDLE', INCALL: 'INCALL', DISPO_PENDING: 'DISPO_PENDING' };
  let currentState = State.IDLE;
  let pendingCallId = null;
  let pendingSfRecordId = null;

  // ---------------------------------------------------------------------------
  // 4. vici2 inner iframe
  // ---------------------------------------------------------------------------
  const frame = document.getElementById('vici2-frame');
  const loadingEl = document.getElementById('sf-cti-loading');

  function getVici2Url() {
    const base = VICI2_WEB_ORIGIN;
    return `${base}/sf?embed=sf&tenant=${encodeURIComponent(TENANT_SLUG)}`;
  }

  function mountVici2Frame() {
    frame.src = getVici2Url();
    frame.style.display = 'block';
    loadingEl.style.display = 'none';
  }

  // Post a message to the vici2 inner iframe
  function postToVici2(msg) {
    if (frame.contentWindow) {
      frame.contentWindow.postMessage(msg, VICI2_WEB_ORIGIN);
    }
  }

  // ---------------------------------------------------------------------------
  // 5. Open CTI event handlers
  // ---------------------------------------------------------------------------
  function onOpenCtiLoaded() {
    openCtiReady = true;

    // Register click-to-dial listener
    sforce.opencti.onClickToDial({
      listener: function (payload) {
        // payload: { number, recordId, recordName, objectType }
        handleSfDial(payload);
      }
    });

    // Register navigation listener
    sforce.opencti.onNavigationChange({
      listener: function (payload) {
        postToVici2({ type: 'sf:navigate', recordId: payload.recordId, objectType: payload.objectType });
      }
    });

    // Panel open/close listeners
    sforce.opencti.onSoftphoneOpen({ listener: function () {
      postToVici2({ type: 'sf:panelOpen' });
    }});
    sforce.opencti.onSoftphoneClose({ listener: function () {
      postToVici2({ type: 'sf:panelClose' });
    }});

    // Get app info for init
    sforce.opencti.getAppViewInfo({ callbackFunction: function (res) {
      if (res.success) {
        postToVici2({
          type: 'sf:init',
          userId: res.returnValue.userId,
          orgId: res.returnValue.orgId,
          apiVersion: res.returnValue.apiVersion,
          tenantSlug: TENANT_SLUG,
        });
      }
    }});

    // Enable click-to-dial
    sforce.opencti.enableClickToDial();

    // Mount the vici2 agent UI frame
    mountVici2Frame();
  }

  function handleSfDial(payload) {
    pendingSfRecordId = payload.recordId;
    postToVici2({
      type: 'sf:dial',
      number: payload.number,
      recordId: payload.recordId,
      recordName: payload.recordName,
      objectType: payload.objectType,
    });
  }

  // ---------------------------------------------------------------------------
  // 6. Handle messages from vici2 inner iframe
  // ---------------------------------------------------------------------------
  window.addEventListener('message', function (e) {
    if (e.origin !== VICI2_WEB_ORIGIN) return;
    const msg = e.data;
    if (!msg || typeof msg.type !== 'string') return;
    handleVici2Message(msg);
  }, false);

  function handleVici2Message(msg) {
    switch (msg.type) {
      case 'vici2:callConnected':
        handleCallConnected(msg);
        break;
      case 'vici2:callEnded':
        handleCallEnded(msg);
        break;
      case 'vici2:dispoCommitted':
        handleDispoCommitted(msg);
        break;
      case 'vici2:agentState':
        // Could drive custom data or panel visibility; Phase 1: no-op
        break;
      case 'vici2:screenPop':
        if (openCtiReady) {
          sforce.opencti.screenPop({
            type: 'SOBJECT',
            params: { recordId: msg.sfRecordId },
            callbackFunction: noop,
          });
        }
        break;
    }
  }

  function handleCallConnected(msg) {
    currentState = State.INCALL;
    pendingCallId = msg.callId;

    if (!openCtiReady) return;

    // Show the panel
    sforce.opencti.setSoftphonePanelVisibility({ visible: true, callbackFunction: noop });

    // Screen pop: prefer known SF record ID, fallback to phone search
    if (msg.sfRecordId) {
      sforce.opencti.screenPop({
        type: 'SOBJECT',
        params: { recordId: msg.sfRecordId },
        callbackFunction: noop,
      });
    } else if (msg.leadPhone) {
      sforce.opencti.searchAndScreenPop({
        searchParams: msg.leadPhone,
        queryParams: { search: msg.leadPhone },
        callbackFunction: noop,
      });
    }
  }

  function handleCallEnded(msg) {
    currentState = State.DISPO_PENDING;
  }

  function handleDispoCommitted(msg) {
    currentState = State.IDLE;
    pendingCallId = null;

    if (!openCtiReady) return;

    // Best-effort browser-side Task save
    const taskValue = buildSfTask(msg);
    sforce.opencti.saveLog({
      value: taskValue,
      callbackFunction: function (res) {
        if (!res.success) {
          console.warn('[vici2-cti] saveLog failed', res.errors);
        }
      }
    });
  }

  function buildSfTask(msg) {
    // Phase 1: map dispo to Task fields (configurable in Phase 2)
    const DEFAULT_STATUS_MAP = {
      SALE: 'Completed', NOANSWER: 'Not Started',
      BUSY: 'Not Started', DNC: 'Deferred',
      CBHOLD: 'In Progress', CALLBACK: 'In Progress',
    };
    const taskStatus = DEFAULT_STATUS_MAP[msg.dispo] || 'Completed';
    const callDate = msg.callStartAt ? msg.callStartAt.substring(0, 10) : new Date().toISOString().substring(0, 10);

    const task = {
      Subject: `Call: ${msg.dispoLabel}`,
      Status: taskStatus,
      ActivityDate: callDate,
      CallDurationInSeconds: msg.callDurationSeconds || 0,
      CallType: msg.direction === 'inbound' ? 'Inbound' : 'Outbound',
      Description:
        `[vici2:callId:${msg.callId}]\n` +
        (msg.notes ? `Notes: ${msg.notes}\n` : ''),
    };

    if (msg.sfRecordId && msg.sfObjectType === 'Contact') {
      task.WhoId = msg.sfRecordId;
    } else if (msg.sfRecordId && msg.sfObjectType === 'Lead') {
      task.WhoId = msg.sfRecordId;
    }

    return task;
  }

  function noop() {}
})();
```

### 5.3 `sf-cti-manifest.xml`

Served at `/static/sf-cti-manifest.xml`. Admins download and import this via SF Setup → Call Centers → Import.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<callCenter>
  <section name="reqGeneralInfo" label="General Information">
    <item name="reqInternalName" label="CTI Adapter Internal Name">
      <value>Vici2CTIAdapter</value>
    </item>
    <item name="reqDisplayName" label="Display Name in Salesforce">
      <value>Vici2 Open CTI</value>
    </item>
    <item name="reqAdapterUrl" label="Adapter URL">
      <!-- REPLACE: set your vici2 API domain and tenant slug -->
      <value>https://api.YOUR-DOMAIN.com/static/sf-cti-adapter.html?tenant=YOUR-TENANT-SLUG</value>
    </item>
    <item name="reqSoftphoneHeight" label="Softphone Height (px)">
      <value>600</value>
    </item>
    <item name="reqSoftphoneWidth" label="Softphone Width (px)">
      <value>300</value>
    </item>
    <item name="reqVersion" label="Adapter Version">
      <value>1.0</value>
    </item>
  </section>
</callCenter>
```

---

## 6. Fastify route structure (`api/src/routes/adapters/sf-integration/`)

### 6.1 Route registration (`index.ts`)

```typescript
// Registers all SF integration admin routes under /api/admin/sf-integration
// and the OAuth callback under /admin/sf-integration/oauth/callback (no auth).

import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../../auth/middleware.js';
import { requirePermission } from '../../../auth/rbac.js';
import { SfIntegrationService } from './service.js';
import { sfIntegrationSchemas } from './schema.js';

export async function registerSfIntegrationRoutes(app: FastifyInstance): Promise<void> {
  const svc = new SfIntegrationService(app);

  // GET /api/admin/sf-integration — get integration status and config
  app.get('/api/admin/sf-integration',
    { preHandler: [requireAuth, requirePermission('integration:sf:configure')],
      schema: sfIntegrationSchemas.getConfig },
    svc.getConfig.bind(svc)
  );

  // PATCH /api/admin/sf-integration — update field mappings, enable/disable
  app.patch('/api/admin/sf-integration',
    { preHandler: [requireAuth, requirePermission('integration:sf:configure')],
      schema: sfIntegrationSchemas.patchConfig },
    svc.patchConfig.bind(svc)
  );

  // POST /api/admin/sf-integration/connect — store Client ID+Secret, return OAuth URL
  app.post('/api/admin/sf-integration/connect',
    { preHandler: [requireAuth, requirePermission('integration:sf:configure')],
      schema: sfIntegrationSchemas.connect },
    svc.initiateOAuth.bind(svc)
  );

  // GET /admin/sf-integration/oauth/callback — OAuth authorization code callback
  // Note: not under /api/admin — no auth middleware (handled by state param CSRF check)
  app.get('/admin/sf-integration/oauth/callback',
    { schema: sfIntegrationSchemas.oauthCallback },
    svc.oauthCallback.bind(svc)
  );

  // DELETE /api/admin/sf-integration/disconnect — revoke and clear tokens
  app.delete('/api/admin/sf-integration/disconnect',
    { preHandler: [requireAuth, requirePermission('integration:sf:configure')],
      schema: sfIntegrationSchemas.disconnect },
    svc.disconnect.bind(svc)
  );

  // GET /static/sf-cti-manifest.xml — download Call Center XML
  // Served by @fastify/static; registered separately in server.ts
}
```

### 6.2 Service (`service.ts`) — key methods

```typescript
// SfIntegrationService — business logic for SF integration admin routes

export class SfIntegrationService {
  // getConfig: returns SfIntegration row (masked tokens)
  async getConfig(req, reply) { /* ... */ }

  // patchConfig: update fieldMappings, enabled
  async patchConfig(req, reply) { /* ... */ }

  // initiateOAuth: validates clientId+clientSecret, builds SF OAuth URL with state param
  // Stores clientId+encryptedSecret in sf_integrations, returns { authUrl }
  async initiateOAuth(req, reply) { /* ... */ }

  // oauthCallback: validates state, exchanges code for tokens, stores encrypted
  // Redirects to admin UI with success/error query param
  async oauthCallback(req, reply) { /* ... */ }

  // disconnect: revokes SF access_token via SF revocation endpoint, clears tokens
  async disconnect(req, reply) { /* ... */ }
}
```

### 6.3 Token store (`token-store.ts`)

Reuses the M06 carrier credential AES-256-GCM pattern:

```typescript
// token-store.ts — encrypt/decrypt SF OAuth tokens via tenant KEK

import { getTenantKek } from '../../../lib/kek.js';
import { encrypt, decrypt } from '../../../lib/crypto.js';  // AES-256-GCM helpers

export async function encryptToken(tenantId: bigint, plaintext: string): Promise<Buffer> {
  const kek = await getTenantKek(tenantId);
  return encrypt(kek, Buffer.from(plaintext, 'utf8'));
}

export async function decryptToken(tenantId: bigint, ciphertext: Buffer): Promise<string> {
  const kek = await getTenantKek(tenantId);
  return decrypt(kek, ciphertext).toString('utf8');
}

// getAccessToken: auto-refreshes if expiry < 5 min away
export async function getAccessToken(tenantId: bigint): Promise<{ token: string; instanceUrl: string }> {
  const db = getPrisma();
  const row = await db.sfIntegration.findUnique({ where: { tenantId } });
  if (!row || !row.accessToken || !row.refreshToken) {
    throw new Error('SF integration not configured or not authorized');
  }
  const now = new Date();
  const expiry = row.tokenExpiry;
  if (expiry && expiry.getTime() - now.getTime() < 5 * 60 * 1000) {
    // Refresh
    return refreshAccessToken(tenantId, row);
  }
  const token = await decryptToken(tenantId, row.accessToken);
  return { token, instanceUrl: row.instanceUrl! };
}

async function refreshAccessToken(tenantId: bigint, row: SfIntegration) {
  const refreshToken = await decryptToken(tenantId, row.refreshToken!);
  const clientId = row.clientId!;
  const clientSecret = await decryptToken(tenantId, row.clientSecret!);
  // POST to SF token endpoint
  const res = await fetch(`${row.instanceUrl}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('SF token refresh failed');
  const newExpiry = new Date(Date.now() + (data.expires_in || 7200) * 1000);
  const encryptedToken = await encryptToken(tenantId, data.access_token);
  await db.sfIntegration.update({
    where: { tenantId },
    data: { accessToken: encryptedToken, tokenExpiry: newExpiry },
  });
  return { token: data.access_token, instanceUrl: row.instanceUrl! };
}
```

### 6.4 Task mapper (`task-mapper.ts`)

```typescript
// task-mapper.ts — maps vici2 dispo commit data to SF Task fields

export interface DispoCommitPayload {
  callId: string;
  dispo: string;
  dispoLabel: string;
  notes: string;
  sfRecordId?: string;
  sfObjectType?: 'Lead' | 'Contact';
  callDurationSeconds: number;
  callStartAt: string;
  direction: 'inbound' | 'outbound';
}

export interface SfTaskPayload {
  Subject: string;
  Status: string;
  ActivityDate: string;         // YYYY-MM-DD
  CallDurationInSeconds: number;
  CallType: 'Inbound' | 'Outbound';
  Description: string;
  WhoId?: string;               // Contact or Lead ID
  WhatId?: string;              // Account or Opportunity ID (Phase 2)
}

export function mapDispoToSfTask(
  payload: DispoCommitPayload,
  fieldMappings: SfFieldMappings
): SfTaskPayload {
  const statusMap = { ...DEFAULT_STATUS_MAP, ...(fieldMappings.dispoToTaskStatus || {}) };
  const taskStatus = statusMap[payload.dispo] || 'Completed';
  const callDate = payload.callStartAt?.substring(0, 10) ?? new Date().toISOString().substring(0, 10);

  const task: SfTaskPayload = {
    Subject: `Call: ${payload.dispoLabel}`,
    Status: taskStatus,
    ActivityDate: callDate,
    CallDurationInSeconds: payload.callDurationSeconds,
    CallType: payload.direction === 'inbound' ? 'Inbound' : 'Outbound',
    Description:
      `[vici2:callId:${payload.callId}]\n` +
      (payload.notes ? `Notes: ${payload.notes}\n` : ''),
  };

  if (payload.sfRecordId) {
    // Both Lead and Contact use WhoId
    task.WhoId = payload.sfRecordId;
  }

  return task;
}
```

---

## 7. BullMQ write-back worker (`api/src/workers/sf-writeback.worker.ts`)

```typescript
// sf-writeback.worker.ts — BullMQ worker for reliable SF Task write-back
// Queue: vici2:queue:sf-writeback
// Retry: 3× with exponential back-off (2s, 4s, 8s)
// DLQ: Valkey stream events:vici2.dlq.sf-writeback

import { Worker, Job } from 'bullmq';
import { getRedis } from '../lib/redis.js';
import { getPrisma } from '../lib/prisma.js';
import { getAccessToken } from '../routes/adapters/sf-integration/token-store.js';
import { mapDispoToSfTask } from '../routes/adapters/sf-integration/task-mapper.js';
import { notify } from '../notifications/service.js';

export interface SfWritebackJob {
  tenantId: number;
  payload: DispoCommitPayload;   // same shape as postMessage payload
}

export function startSfWritebackWorker() {
  const worker = new Worker<SfWritebackJob>(
    'vici2:queue:sf-writeback',
    async (job: Job<SfWritebackJob>) => {
      const { tenantId, payload } = job.data;
      const db = getPrisma();

      // 1. Get integration config and field mappings
      const integration = await db.sfIntegration.findUnique({
        where: { tenantId: BigInt(tenantId) },
      });
      if (!integration || !integration.enabled) {
        return; // Integration disabled; skip silently
      }

      // 2. Get (and potentially refresh) the access token
      const { token, instanceUrl } = await getAccessToken(BigInt(tenantId));

      // 3. Map dispo → SF Task fields
      const fieldMappings = (integration.fieldMappings as SfFieldMappings) || {};
      const taskPayload = mapDispoToSfTask(payload, fieldMappings);

      // 4. Check for existing Task (dedup by callId in Description)
      //    In Phase 1 we use a SOQL query; Phase 2 uses Vici2_Call_Id__c custom field
      const existingTaskId = await findExistingTask(token, instanceUrl, payload.callId);

      // 5. Create or update Task
      if (existingTaskId) {
        await updateSfTask(token, instanceUrl, existingTaskId, taskPayload);
      } else {
        await createSfTask(token, instanceUrl, taskPayload);
      }

      // 6. Update last_writeback_at
      await db.sfIntegration.update({
        where: { tenantId: BigInt(tenantId) },
        data: { lastWritebackAt: new Date(), lastError: null },
      });
    },
    {
      connection: getRedis(),
      concurrency: 5,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 200 },
      },
    }
  );

  worker.on('failed', async (job, err) => {
    if (!job || job.attemptsMade < 3) return;
    // Final failure — record error, notify agent
    const { tenantId, payload } = job!.data;
    const db = getPrisma();
    await db.sfIntegration.update({
      where: { tenantId: BigInt(tenantId) },
      data: { lastError: err.message },
    });
    // TODO Phase 2: notify() the agent that write-back failed
  });

  return worker;
}

async function createSfTask(token: string, instanceUrl: string, task: SfTaskPayload) {
  const res = await fetch(`${instanceUrl}/services/data/v58.0/sobjects/Task`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(task),
  });
  if (!res.ok) throw new Error(`SF Task create failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function updateSfTask(token: string, instanceUrl: string, taskId: string, task: SfTaskPayload) {
  const res = await fetch(`${instanceUrl}/services/data/v58.0/sobjects/Task/${taskId}`, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(task),
  });
  if (!res.ok && res.status !== 204) throw new Error(`SF Task update failed: ${res.status}`);
}

async function findExistingTask(token: string, instanceUrl: string, callId: string): Promise<string | null> {
  const soql = encodeURIComponent(
    `SELECT Id FROM Task WHERE Description LIKE '[vici2:callId:${callId}]%' LIMIT 1`
  );
  const res = await fetch(`${instanceUrl}/services/data/v58.0/query?q=${soql}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.records?.[0]?.Id ?? null;
}
```

---

## 8. Next.js embed mode (`web/src/app/(sf)/`)

### 8.1 Layout (`(sf)/layout.tsx`)

```typescript
// Minimal layout for SF embed mode — no nav chrome, fixed 300×600
export default function SfEmbedLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-gray-950 text-white" style={{ width: 300, height: 600, overflow: 'hidden' }}>
        {children}
      </body>
    </html>
  );
}
```

### 8.2 Page (`(sf)/page.tsx`)

```typescript
'use client';
// SF embed agent shell — connects SipProvider, wires useSfBridge hook
export default function SfEmbedPage() {
  const searchParams = useSearchParams();
  const embed = searchParams.get('embed');

  return (
    <SipProvider>
      <SfEmbedShell />
    </SipProvider>
  );
}

function SfEmbedShell() {
  useSfBridge();          // Connects to adapter iframe via postMessage
  useAgentStateSync();    // Existing WS sync from A03

  const agentState = useAgentStore(s => s.state);
  const callState = useCallStore(s => s.activeCall);

  return (
    <div className="flex flex-col h-full">
      <SfCallControls />
      {callState ? <SfCallControls /> : <SfReadyPanel />}
    </div>
  );
}
```

### 8.3 Bridge hook (`useSfBridge.ts`)

```typescript
// useSfBridge.ts — wires vici2 events → postMessage to adapter iframe
// and adapter postMessages → vici2 store actions

export function useSfBridge() {
  const dialLead = useCallStore(s => s.dialLead);
  const activeCall = useCallStore(s => s.activeCall);
  const agentState = useAgentStore(s => s.state);

  // 1. Listen for messages from the adapter (parent frame)
  useEffect(() => {
    function handleMessage(e: MessageEvent) {
      const adapterOrigin = process.env.NEXT_PUBLIC_API_ORIGIN ?? 'https://api.vici2.example.com';
      if (e.origin !== adapterOrigin) return;
      const msg = e.data;
      if (!msg?.type) return;

      switch (msg.type) {
        case 'sf:dial':
          handleClickToDial(msg);
          break;
        case 'sf:init':
          // Store SF context in session (userId, orgId)
          sessionStorage.setItem('sf:orgId', msg.orgId);
          sessionStorage.setItem('sf:userId', msg.userId);
          break;
        case 'sf:navigate':
          // Optional: highlight matching lead
          break;
      }
    }

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  // 2. Send vici2 events to adapter when call state changes
  useEffect(() => {
    if (!activeCall) return;
    if (activeCall.status === 'connected') {
      window.parent.postMessage({
        type: 'vici2:callConnected',
        callId: activeCall.callId,
        leadPhone: activeCall.leadPhone,
        leadName: activeCall.leadName,
        sfRecordId: activeCall.sfRecordId,
        direction: activeCall.direction,
      }, adapterOrigin);
    } else if (activeCall.status === 'ended') {
      window.parent.postMessage({
        type: 'vici2:callEnded',
        callId: activeCall.callId,
        durationSeconds: activeCall.duration,
      }, adapterOrigin);
    }
  }, [activeCall?.status]);

  // 3. Respond to agent state changes
  useEffect(() => {
    window.parent.postMessage({
      type: 'vici2:agentState',
      state: agentState,
    }, adapterOrigin);
  }, [agentState]);

  async function handleClickToDial(msg: SfDialMessage) {
    // Normalize phone, deduplicate lead, then dial
    const e164 = normalizePhone(msg.number);
    if (!e164) return;

    // Find or create lead
    const lead = await findOrCreateLeadBySfRecord({
      phone: e164,
      sfRecordId: msg.recordId,
      sfObjectType: msg.objectType,
      recordName: msg.recordName,
    });

    // Initiate outbound call
    dialLead({ leadId: lead.id, phone: e164, sfRecordId: msg.recordId });
  }
}
```

---

## 9. Lead import / deduplication service (api-side)

### 9.1 `POST /api/leads/sf-import` endpoint

A lightweight internal endpoint (called by the vici2 web frontend from within the SF embed) to find or create a lead based on a Salesforce record.

```typescript
// Routes: POST /api/leads/sf-import
// Auth: requireAuth + requirePermission('integration:sf:click_to_dial')
// Body: { phone, sfRecordId, sfObjectType, firstName?, lastName?, email?, company? }
// Returns: { lead: LeadDto, created: boolean }

async function sfImportHandler(req, reply) {
  const { phone, sfRecordId, sfObjectType, firstName, lastName, email, company } = req.body;
  const tenantId = req.authCtx.tenantId;
  const e164 = normalizeToE164(phone);
  if (!e164) return reply.code(422).send({ error: 'Invalid phone number' });

  // Dedup: check by sf_record_id first, then by phone
  let lead = await db.lead.findFirst({
    where: { tenantId, OR: [{ sfRecordId }, { phone: e164 }] },
  });

  if (lead) {
    // Update sf_record_id if not already set
    if (!lead.sfRecordId && sfRecordId) {
      lead = await db.lead.update({
        where: { id: lead.id },
        data: { sfRecordId, sfObjectType },
      });
    }
    return reply.send({ lead: toLeadDto(lead), created: false });
  }

  // Create new lead
  lead = await db.lead.create({
    data: {
      tenantId,
      phone: e164,
      firstName: firstName ?? '',
      lastName: lastName ?? '',
      email: email ?? null,
      company: company ?? null,
      source: 'salesforce',
      sfRecordId,
      sfObjectType,
      status: 'NEW',
    },
  });

  // Audit log
  await auditWriter.write({ tenantId, userId: req.authCtx.userId, action: 'lead.sf_import', resourceId: String(lead.id) });

  return reply.code(201).send({ lead: toLeadDto(lead), created: true });
}
```

---

## 10. RBAC additions

Two new verbs appended to `shared/types/src/rbac.ts`:

```typescript
// In VERBS array, append after voicemail drop assets block:
// --- SF integration (N03) ---
'integration:sf:configure',    // admin+ — manage SF org credentials, field mappings
'integration:sf:click_to_dial', // agent+ — use click-to-dial, sf-import endpoint
```

Role matrix additions (additive — does not change existing grants):

| Verb | super_admin | admin | supervisor | agent | viewer | integrator |
|---|---|---|---|---|---|---|
| `integration:sf:configure` | tenant | tenant | — | — | — | — |
| `integration:sf:click_to_dial` | tenant | tenant | group | own | — | — |

---

## 11. Admin configuration UI (`web/src/components/sf-cti/`)

### 11.1 Route

The SF integration config panel lives at `/admin/settings/sf-integration` (added as a tab in the M05 settings panel, or as a standalone admin page).

### 11.2 UI sections

**Section 1: Connection status**
- Shows: Connected / Not connected badge.
- Connected state shows: SF org instance URL, connected-at date, token expiry countdown.
- "Disconnect" button (calls `DELETE /api/admin/sf-integration/disconnect`).

**Section 2: OAuth setup (shown when not connected)**
- Input: Salesforce Instance URL (e.g., `https://myorg.salesforce.com`).
- Input: Connected App Consumer Key (Client ID).
- Input: Connected App Consumer Secret (masked, write-only).
- "Connect to Salesforce" button → calls `POST /api/admin/sf-integration/connect` → redirects admin to SF OAuth consent page → SF redirects back → success toast.

**Section 3: Field mappings**
- Table editor: Dispo Code → SF Task Status.
- Rows: one per active dispo code (loaded from existing `statuses` endpoint).
- Default values pre-populated from `DEFAULT_STATUS_MAP`.
- "Save mappings" button (calls `PATCH /api/admin/sf-integration`).

**Section 4: Installation guide**
- Download button for `sf-cti-manifest.xml` (with tenant slug pre-filled).
- Step-by-step instructions:
  1. Download the Call Center XML.
  2. In SF: Setup → Call Centers → Import.
  3. Assign users to the Call Center.
  4. Ensure users have a Lightning console app (Service Cloud or Sales Cloud console).

### 11.3 Component structure

```
web/src/components/sf-cti/
  SfIntegrationPanel.tsx        # Main container (tabs: Status, Mappings, Install)
  SfOAuthConnect.tsx            # OAuth setup form
  SfFieldMappings.tsx           # Dispo→Task status mapping table
  SfInstallGuide.tsx            # Install instructions + manifest download
  useSfIntegration.ts           # React Query hooks for the admin API
```

---

## 12. Fastify static file serving

Registered in `api/src/server.ts`:

```typescript
import fastifyStatic from '@fastify/static';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await app.register(fastifyStatic, {
  root: path.join(__dirname, 'static'),
  prefix: '/static/',
  decorateReply: false,
  // CSP headers for CTI adapter
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('sf-cti-adapter.html') || filePath.endsWith('sf-cti.js')) {
      res.setHeader(
        'Content-Security-Policy',
        "frame-ancestors 'self' https://*.salesforce.com https://*.lightning.force.com https://*.visualforce.com https://*.force.com"
      );
      res.setHeader('Cache-Control', 'no-store, must-revalidate');
    }
  },
});
```

The `@fastify/static` package must be added to `api/package.json`:
```json
"@fastify/static": "^8.0.0"
```

(Check if already present; if so, no addition needed.)

---

## 13. Database migration

Migration file: `api/prisma/migrations/20260514000000_n03_sf_integration/migration.sql`

```sql
-- N03 — Salesforce Open CTI Adapter schema

-- sf_integrations table
CREATE TABLE sf_integrations (
  id               BIGINT      NOT NULL AUTO_INCREMENT,
  tenant_id        BIGINT      NOT NULL,
  enabled          TINYINT(1)  NOT NULL DEFAULT 0,
  instance_url     VARCHAR(255) NULL,
  client_id        VARCHAR(512) NULL,
  client_secret    BLOB         NULL,
  access_token     BLOB         NULL,
  refresh_token    BLOB         NULL,
  token_expiry     DATETIME(6)  NULL,
  field_mappings   JSON         NOT NULL DEFAULT (JSON_OBJECT()),
  last_writeback_at DATETIME(6) NULL,
  last_error       TEXT         NULL,
  created_at       DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at       DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uk_sf_tenant (tenant_id),
  CONSTRAINT fk_sf_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE
);

-- Lead model additions
ALTER TABLE leads
  ADD COLUMN sf_record_id   VARCHAR(32) NULL AFTER source,
  ADD COLUMN sf_object_type VARCHAR(32) NULL AFTER sf_record_id,
  ADD INDEX idx_leads_sf_record (sf_record_id);
```

---

## 14. Security checklist

| Concern | Mitigation |
|---|---|
| postMessage origin injection | Both adapter and vici2 inner frame validate `event.origin` before processing any message |
| Click-to-dial phone injection | E.164 normalization + rejection of non-phone strings before forwarding to vici2 dial |
| OAuth CSRF on callback | `state` param = HMAC(random, adminSessionId); validated server-side before code exchange |
| SF token exposure | Tokens stored as AES-256-GCM encrypted BLOB; decrypted only in-process; never returned via API |
| CSP for adapter HTML | `frame-ancestors` restricts embedding to SF domains only |
| Third-party cookie absence | Short-lived JWT in sessionStorage; 15-min expiry; no refresh token in iframe |
| Adapter JS cache poisoning | `Cache-Control: no-store` on static adapter files |
| SF `saveLog` payload injection | Task field values constructed server-side or from validated postMessage payload; no direct SF API call from browser with user-controlled payloads |
| BullMQ job data sanitization | All fields validated via Zod schema before enqueue |

---

## 15. Prometheus metrics

New metric prefix: `vici2_sf_`

| Metric | Type | Labels | Description |
|---|---|---|---|
| `vici2_sf_writeback_total` | counter | `tenant_id`, `result` (success/failure) | SF Task write-back attempts |
| `vici2_sf_writeback_duration_seconds` | histogram | `tenant_id` | SF REST API call duration |
| `vici2_sf_token_refresh_total` | counter | `tenant_id`, `result` | OAuth token refresh attempts |
| `vici2_sf_click_to_dial_total` | counter | `tenant_id` | Click-to-dial events received from SF |
| `vici2_sf_screen_pop_total` | counter | `tenant_id`, `result` (found/not_found) | Screen pop attempts |

---

## 16. Test plan

### 16.1 Unit tests (`api/test/adapters/sf-cti/`)

| Test file | Coverage |
|---|---|
| `task-mapper.test.ts` | Dispo code → SF Task Status mapping; default + custom mappings; missing dispo fallback |
| `token-store.test.ts` | Encrypt/decrypt round-trip; auto-refresh triggers before expiry; refresh failure throws |
| `oauth.test.ts` | OAuth URL construction; state param validation; token exchange success + failure paths |
| `sf-writeback.worker.test.ts` | Job processing; dedup (existing Task found); SF API call shape; retry on 5xx |

### 16.2 Unit tests (`web/src/test/unit/sf-cti/`)

| Test file | Coverage |
|---|---|
| `openCtiBridge.test.ts` | postMessage origin validation; sf:dial triggers dialLead; vici2:callConnected triggers screenPop message; unknown type ignored |
| `sfImport.test.ts` | Phone normalization; dedup by sfRecordId; dedup by phone; auto-create on miss |

### 16.3 Manual acceptance tests (SF sandbox)

1. Install Call Center XML in a Salesforce sandbox.
2. Assign test user to the Call Center.
3. Open Lightning console app → softphone panel appears → vici2 login screen loads.
4. Log in as vici2 agent → agent shell renders in compact mode (no nav chrome).
5. Navigate to a Contact → click the phone number (click-to-dial link) → vici2 dials → call connects → SF screen-pops the Contact.
6. End call → submit dispo "SALE" → Task appears on the Contact in SF with correct Subject, Status, Duration.
7. Simulate inbound call from a known Contact number → SF screen-pops the Contact after agent accepts.
8. Verify BullMQ write-back job in Valkey; confirm Task created in SF within 10s of dispo.
9. Verify token auto-refresh: set token expiry to 4 minutes in future; wait for expiry; dispo → write-back succeeds (fresh token used).

---

## 17. LOC estimate

| File | Estimated LOC |
|---|---|
| `api/src/static/sf-cti-adapter.html` | 30 |
| `api/src/static/sf-cti.js` | 220 |
| `api/src/static/sf-cti-manifest.xml` | 30 |
| `api/src/routes/adapters/sf-integration/index.ts` | 60 |
| `api/src/routes/adapters/sf-integration/schema.ts` | 60 |
| `api/src/routes/adapters/sf-integration/service.ts` | 100 |
| `api/src/routes/adapters/sf-integration/token-store.ts` | 80 |
| `api/src/routes/adapters/sf-integration/task-mapper.ts` | 60 |
| `api/src/workers/sf-writeback.worker.ts` | 120 |
| `api/prisma/migrations/*/migration.sql` | 40 |
| `web/src/app/(sf)/layout.tsx` | 15 |
| `web/src/app/(sf)/page.tsx` | 40 |
| `web/src/components/sf-cti/openCtiBridge.ts` | 60 |
| `web/src/components/sf-cti/useSfBridge.ts` | 80 |
| `web/src/components/sf-cti/SfCallControls.tsx` | 60 |
| `web/src/components/sf-cti/SfDispoPanel.tsx` | 60 |
| `web/src/components/sf-cti/SfIntegrationPanel.tsx` | 80 |
| `web/src/components/sf-cti/SfOAuthConnect.tsx` | 50 |
| `web/src/components/sf-cti/SfFieldMappings.tsx` | 50 |
| `web/src/components/sf-cti/SfInstallGuide.tsx` | 30 |
| `web/src/components/sf-cti/useSfIntegration.ts` | 40 |
| `shared/types/src/rbac.ts` additions | 15 |
| Test files (combined) | ~300 |
| **Total** | **~930** |

---

## 18. Open questions (from RESEARCH.md, resolution notes)

| # | Question | Resolution for Phase 1 |
|---|---|---|
| 1 | Mic permission propagation to nested iframe | Add `allow="microphone; camera; autoplay"` to the inner `<iframe>` in adapter HTML. If nested iframe mic fails in testing, flatten to single frame (serve vici2 embed directly in the adapter frame). |
| 2 | Token persistence across tab switches | Existing vici2 WS reconnect logic handles WSS drops. Access token in sessionStorage survives tab suspension. Agent must re-auth only if SF reloads the adapter iframe (rare). Accept Phase 1. |
| 3 | Screen-pop race condition | Guard: `handleCallConnected` sends screen pop only when `callState.status === 'connected'`; the connected event fires only after FreeSWITCH confirms bridge. |
| 4 | Multi-tenant adapter URL | `?tenant=SLUG` in adapter URL; one Call Center XML per tenant. Document clearly. |
| 5 | Salesforce API version compatibility | Document minimum: API v55+ required. Runtime detection deferred to Phase 2. |
| 6 | `saveLog` failure notification | Phase 1: log to console + `lastError` field. Phase 2: add N01 `notify()` call on persistent write-back failure. |
| 7 | Custom dispo field on SF Task | Phase 1: encode in `Description`. Phase 2: managed package + `Vici2_Dispo__c`. |
| 8 | Sandbox vs production SF orgs | Phase 1: one `instance_url` per tenant. Phase 2: `sf_integrations` table extended with `sandbox_instance_url`. |
