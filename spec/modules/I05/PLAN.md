# I05 — Voicemail Capture + Drop: Implementation Plan

**Module:** I05  
**Track:** Inbound + Outbound  
**Date:** 2026-05-13  
**Effort estimate:** 3–4 days  
**Status:** PLAN COMPLETE

---

## 1. Overview

I05 delivers two features that share the voicemail infrastructure:

**Feature A — Inbound Voicemail Capture:** An incoming caller is routed (by IVR leaf node or DID overflow) to a VoicemailBox. FreeSWITCH plays the box greeting, records the caller's message, POSTs a webhook to the API, and the API creates a `voicemails` row with the recording URI. Agents/supervisors browse their mailboxes in the existing voicemail UI (I03).

**Feature B — Voicemail Drop (Outbound):** When AMD (T03) detects an answering machine on a predictive-dialed call and the campaign has `amd_action=vmdrop`, the `AMDHandler` resolves the campaign's `VoicemailDropAsset` (a pre-uploaded audio file) and plays it via `uuid_broadcast play_and_hangup` then hangs up. Lead status becomes `AVMA`.

---

## 2. Schema Changes

### 2.1 Migration Filename

```
api/prisma/migrations/20260513270000_i05_voicemail_drop/migration.sql
```

### 2.2 New Table: `voicemail_drop_assets`

```sql
-- I05 — Voicemail drop audio asset library
CREATE TABLE voicemail_drop_assets (
  id              BIGINT        NOT NULL AUTO_INCREMENT,
  tenant_id       BIGINT        NOT NULL DEFAULT 1,
  name            VARCHAR(128)  NOT NULL
    COMMENT 'Human-readable label for this drop audio',
  s3_uri          VARCHAR(512)  DEFAULT NULL
    COMMENT 'S3 URI (canonical storage); NULL in Phase 1 local-only mode',
  local_path      VARCHAR(512)  NOT NULL
    COMMENT 'Absolute local FS path; used by FreeSWITCH uuid_broadcast at call time',
  duration_sec    SMALLINT UNSIGNED NOT NULL DEFAULT 0
    COMMENT 'Duration detected by ffprobe at upload time',
  size_bytes      INT UNSIGNED  NOT NULL DEFAULT 0,
  original_format VARCHAR(8)    NOT NULL DEFAULT 'wav'
    COMMENT 'Original upload format: wav | mp3',
  active          TINYINT(1)    NOT NULL DEFAULT 1,
  created_by      BIGINT        NOT NULL
    COMMENT 'FK → users.id — admin who uploaded',
  created_at      DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at      DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uk_vmda_tenant_name (tenant_id, name),
  INDEX idx_vmda_tenant_active (tenant_id, active),
  CONSTRAINT fk_vmda_tenant FOREIGN KEY (tenant_id)
    REFERENCES tenants(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT fk_vmda_created_by FOREIGN KEY (created_by)
    REFERENCES users(id) ON DELETE RESTRICT ON UPDATE NO ACTION
);
```

### 2.3 `voicemail_boxes` — Add `notify_email`

```sql
ALTER TABLE voicemail_boxes
  ADD COLUMN notify_email  VARCHAR(255) DEFAULT NULL
    COMMENT 'Optional team email; new-VM notification sent here in addition to boxUsers'
  AFTER max_duration_sec;
```

### 2.4 `voicemails` — Add `partial` Flag

```sql
-- NOTE: voicemails is partitioned; ALTER TABLE works but is non-trivial.
-- For partitioned tables in MySQL 8, ADD COLUMN is an in-place operation.
ALTER TABLE voicemails
  ADD COLUMN partial TINYINT(1) NOT NULL DEFAULT 0
    COMMENT '1 = caller hung up before recording completed (duration_sec < 3)'
  AFTER caller_number;
```

### 2.5 `campaigns` — Add `vmdrop_asset_id` FK

```sql
ALTER TABLE campaigns
  ADD COLUMN vmdrop_asset_id BIGINT DEFAULT NULL
    COMMENT 'FK → voicemail_drop_assets.id; used when amd_action=vmdrop'
  AFTER vmdrop_audio,
  ADD CONSTRAINT fk_camp_vmdrop_asset FOREIGN KEY (vmdrop_asset_id)
    REFERENCES voicemail_drop_assets(id) ON DELETE SET NULL ON UPDATE NO ACTION;
```

The existing `vmdrop_audio VARCHAR(255)` column is retained for backward compatibility and deprecated. The implementation code reads `vmdrop_asset_id` when set and falls back to `vmdrop_audio` (legacy path string).

### 2.6 Prisma Schema Additions

**`VoicemailDropAsset` model** (new):
```prisma
model VoicemailDropAsset {
  id             BigInt   @id @default(autoincrement())
  tenantId       BigInt   @default(1) @map("tenant_id")
  name           String   @db.VarChar(128)
  s3Uri          String?  @map("s3_uri") @db.VarChar(512)
  localPath      String   @map("local_path") @db.VarChar(512)
  durationSec    Int      @default(0) @map("duration_sec") @db.UnsignedSmallInt
  sizeBytes      Int      @default(0) @map("size_bytes") @db.UnsignedInt
  originalFormat String   @default("wav") @map("original_format") @db.VarChar(8)
  active         Boolean  @default(true)
  createdBy      BigInt   @map("created_by")
  createdAt      DateTime @default(now()) @map("created_at") @db.DateTime(6)
  updatedAt      DateTime @updatedAt @map("updated_at") @db.DateTime(6)

  tenant     Tenant     @relation(fields: [tenantId], references: [id], ...)
  createdByUser User    @relation(fields: [createdBy], references: [id], ...)
  campaigns  Campaign[]

  @@unique([tenantId, name], map: "uk_vmda_tenant_name")
  @@index([tenantId, active], map: "idx_vmda_tenant_active")
  @@map("voicemail_drop_assets")
}
```

**`VoicemailBox`** — add `notifyEmail String?` field.

**`Voicemail`** — add `partial Boolean @default(false)` field.

**`Campaign`** — add `vmdropAssetId BigInt?` field + relation to `VoicemailDropAsset`.

---

## 3. FreeSWITCH Dialplan Changes

### 3.1 Inbound Capture — Hangup Hook (Partial Recording Fix)

**File:** `api/src/services/voicemail/VoicemailRenderer.ts`

Modify `generateXml()` to add `api_hangup_hook` so the webhook fires even when the caller drops mid-recording:

```xml
<!-- Set api_hangup_hook BEFORE answer so it fires on any hangup path -->
<action application="set" data="api_hangup_hook=curl ${vm_notify_url_hook} post ${vm_post_body_hook}"/>
<action application="set" data="vici2_role=voicemail"/>
<action application="set" data="vici2_vm_box_id=${boxId}"/>
<action application="set" data="vici2_tenant_id=${tenantId}"/>
<action application="set" data="vm_notify_url_hook=${API_URL}/api/internal/voicemail/recorded"/>
<action application="answer"/>
<action application="playback" data="${greetingPath}"/>
<action application="playback" data="tone_stream://%(500,0,440)"/>
<action application="record" data="${recordPath} ${maxDurationSec} 200 3"/>
<!-- Hangup hook fires separately; no need for explicit curl here -->
<action application="hangup" data="NORMAL_CLEARING"/>
```

The `vm_post_body_hook` is set before `answer` using channel vars available at hangup time: `${uuid}`, `${record_name}`, `${record_seconds}`, `${caller_id_number}`.

**Partial detection in the hook handler:** If `duration_sec < 3`, set `partial=true` in the `Voicemail` row.

### 3.2 VM Drop Dialplan — New File

**File:** `freeswitch/conf/dialplan/default/71_vmdrop.xml`

This extension is a **template reference only** — in practice the `AMDHandler` uses `UUIDBroadcast play_and_hangup` directly on the live channel, bypassing dialplan transfer. No new dialplan extension is needed for the drop itself.

However, a utility extension for testing VM drop audio in isolation is useful:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!--
  I05 — VM Drop test extension.
  Use: originate sofia/internal/test@{ip} &transfer(vmdrop_test XML default)
  Plays the configured drop audio then hangs up. Useful for admin audio verification.
-->
<include>
  <extension name="vmdrop_test" continue="false">
    <condition field="destination_number" expression="^vmdrop_test_(\d+)$">
      <!-- $1 = VoicemailDropAsset id -->
      <action application="set" data="vici2_role=vmdrop_test"/>
      <action application="answer"/>
      <!-- Audio path is resolved by admin; this is a dev/test extension only -->
      <action application="playback" data="/var/lib/vici2/vmdrop/${tenant_id}/${destination_number:12}.wav"/>
      <action application="hangup" data="NORMAL_CLEARING"/>
    </condition>
  </extension>
</include>
```

### 3.3 No Change to `75_voicemail_{box_id}.xml` Pattern

The existing pattern (generated by `VoicemailRenderer`) is correct. Only the `api_hangup_hook` addition is required (covered in 3.1 above).

### 3.4 DID → VoicemailBox Routing Cache

For DID-direct-to-voicemail routing (no IVR), the I01 overflow handler needs to know which `voicemail_box_id` is associated with a DID. Add a Valkey cache entry:

```
Key: t:{tenant_id}:did:{did_id}:vm_box_id
Value: "{box_id}"  (string)
TTL: none (invalidated on box create/update/delete)
```

Written by the API on:
- `POST /api/admin/voicemail-boxes` if `didId` is set
- `PATCH /api/admin/voicemail-boxes/:id` if `didId` changes
- `DELETE /api/admin/voicemail-boxes/:id` (delete the key)

The I01 overflow handler (Go dialer or IVR bridge) reads this key to resolve the transfer target.

---

## 4. Dialer-Side Changes (Go)

### 4.1 Files to Modify

- `dialer/internal/picker/config.go` — extend `CampaignConfig` and `configJSONSnapshot`
- `dialer/internal/picker/amd_handler.go` — add `"vmdrop"` case; add `vmDropPath` field; add audit emit

### 4.2 `CampaignConfig` Extensions

```go
type CampaignConfig struct {
    // ... existing fields ...
    AMDAction      string  // "drop" | "vmdrop" | "agent" | "transfer"
    VMDropPath     string  // resolved local_path from voicemail_drop_assets
}
```

### 4.3 `configJSONSnapshot` Extensions

```go
type configJSONSnapshot struct {
    // ... existing fields ...
    AMDAction   string `json:"amd_action"`
    VMDropPath  string `json:"vmdrop_local_path"`
}
```

M02 config snapshot writer (TypeScript) must include these fields when serializing campaign config to Valkey.

### 4.4 `AMDHandler` Extensions

```go
type AMDHandler struct {
    // ... existing fields ...
    vmDropPath  string  // from CampaignConfig.VMDropPath
}
```

Add `"vmdrop"` case to `handle()`:

```go
case "vmdrop":
    if h.vmDropPath == "" {
        h.logger.Warn("picker: vmdrop — no asset configured, falling back to drop",
            "campaign_id", h.campaignID, "call_uuid", ev.CallUUID)
        h.metrics.VMDropFallback.WithLabelValues(
            fmt.Sprintf("%d", h.tenantID),
            fmt.Sprintf("%d", h.campaignID),
            "no_asset",
        ).Inc()
        if err := h.t01.UUIDKill(ctx, ev.FSHost, ev.CallUUID, "NORMAL_CLEARING"); err != nil {
            h.logger.Error("picker: vmdrop fallback UUIDKill error",
                "call_uuid", ev.CallUUID, "err", err)
        }
        return
    }
    audioArg := "play_and_hangup," + h.vmDropPath
    if err := h.t01.UUIDBroadcast(ctx, ev.FSHost, ev.CallUUID, audioArg, "aleg"); err != nil {
        h.logger.Error("picker: vmdrop UUIDBroadcast error",
            "call_uuid", ev.CallUUID, "err", err)
        // Best-effort hangup
        _ = h.t01.UUIDKill(ctx, ev.FSHost, ev.CallUUID, "NORMAL_CLEARING")
    }
    h.metrics.VMDropPlayed.WithLabelValues(
        fmt.Sprintf("%d", h.tenantID),
        fmt.Sprintf("%d", h.campaignID),
    ).Inc()
    h.emitVMDropAuditEvent(ctx, ev)
```

### 4.5 Audit Event Emission from AMDHandler

`emitVMDropAuditEvent` writes to `events:vici2.audit.requested` Valkey stream (or directly writes to DB audit table via an API internal endpoint):

```go
func (h *AMDHandler) emitVMDropAuditEvent(ctx context.Context, ev AMDEvent) {
    payload := map[string]string{
        "action":      "vmdrop_played",
        "entity_type": "campaign",
        "entity_id":   fmt.Sprintf("%d", ev.CampaignID),
        "tenant_id":   fmt.Sprintf("%d", ev.TenantID),
        "call_uuid":   ev.CallUUID,
        "lead_id":     fmt.Sprintf("%d", ev.LeadID),
        "vm_drop_path": h.vmDropPath,
    }
    data, _ := json.Marshal(payload)
    _ = h.vc.State.XAdd(ctx, &redis.XAddArgs{
        Stream: "events:vici2.audit.vmdrop",
        Values: map[string]interface{}{"data": string(data)},
    })
}
```

A lightweight worker (or the API's internal audit writer) consumes `events:vici2.audit.vmdrop` and writes to `audit_log`.

### 4.6 Lead Status — AVMA

The `answer_handler.go` in `dialer/internal/picker/` handles post-call lead status updates. When AMD outcome resolves and action was `vmdrop`:
- Lead `status` → `'AVMA'` (Answering Machine Voicemail Left)
- Lead `call_count` incremented
- `last_call_time` updated

Verify that `answer_handler.go` has a case for the AMD outcome with vmdrop action. If not, add it. This may require passing the resolved action back from `AMDHandler` to the answer handler — use a Valkey publish or a shared state map keyed by `call_uuid`.

### 4.7 Consent Gate Extension

**File:** `dialer/internal/originate/gate.go`

Add Gate 5 extension: when `OriginateRequest.AMDAction == "vmdrop"` and `ConsentDecision != "OPTIN"` and the destination is a cell phone number (determined by carrier lookup or lead metadata), block origination with `ErrConsentBlocked` and increment a `vmdrop_consent_blocked` metric.

Campaign config must include `VMDropRequiresConsent bool` (default `true`). If the admin explicitly sets it to `false` (landline-only campaign), the gate passes without consent check.

---

## 5. API Changes

### 5.1 VM Drop Asset Routes

**New file:** `api/src/routes/admin/vm-drops/index.ts`

Route map:
```
GET    /api/admin/vm-drops                     list assets for tenant (paginated)
POST   /api/admin/vm-drops                     upload new asset (multipart)
GET    /api/admin/vm-drops/:id                 get asset detail
PATCH  /api/admin/vm-drops/:id                 rename / deactivate
DELETE /api/admin/vm-drops/:id                 soft-delete (active=false)
GET    /api/admin/vm-drops/:id/play            get play URL (pre-signed or local)
```

RBAC: all routes require `vmdrop:read` (GET) or `vmdrop:edit` (POST/PATCH/DELETE). Role minimum: `admin`.

**Multipart upload handler (`POST /api/admin/vm-drops`):**

1. Parse `multipart/form-data`: fields `name` (string), `file` (audio).
2. Validate: content-type must be `audio/wav` or `audio/mpeg`. Size limit: 10 MB.
3. Write temp file to `/tmp/vmdrop_upload_{uuid}.{ext}`.
4. Run ffprobe: `ffprobe -v quiet -print_format json -show_format {tempFile}` → extract `duration` and validate ≤ 120s.
5. Run ffmpeg transcode: `ffmpeg -i {tempFile} -ar 8000 -ac 1 -f wav {outputPath}` where `outputPath = /var/lib/vici2/vmdrop/{tenant_id}/{assetId}.wav`.
6. Upload original to S3 at `{tenant_id}/vmdrop/{assetId}_{filename}` (async; Phase 2 R02 integration).
7. Create `VoicemailDropAsset` DB row.
8. Return 201 with asset DTO.
9. Cleanup temp file.

**Error responses:**
- 400 `invalid_audio_format` — wrong content-type
- 413 `file_too_large` — > 10 MB
- 422 `duration_too_long` — > 120s
- 422 `transcode_failed` — ffmpeg error

### 5.2 Internal Hook Extension — Partial Recording Support

**File:** `api/src/routes/internal/voicemail-hooks.ts`

Extend `RecordedSchema` to accept optional `partial` field:
```typescript
const RecordedSchema = z.object({
  box_id: z.coerce.bigint(),
  call_uuid: z.string().min(1).max(40),
  tenant_id: z.coerce.bigint().default(BigInt(1)),
  caller_number: z.string().max(20).optional().nullable(),
  duration_sec: z.coerce.number().int().min(0).default(0),
  file_path: z.string().max(512).optional().default(""),  // empty = file not written
  partial: z.coerce.boolean().default(false),
});
```

Add logic: if `duration_sec < 3` or `file_path === ""`, set `partial = true` on the created `Voicemail` row.

### 5.3 Voicemail Box Routes — Email Notification Field

**File:** `api/src/routes/admin/voicemail-boxes.ts`

Add `notifyEmail` to `BoxCreateSchema`:
```typescript
const BoxCreateSchema = z.object({
  // ... existing fields ...
  notifyEmail: z.string().email().max(255).optional().nullable(),
});
```

### 5.4 Campaign Routes — VM Drop Asset Assignment

**File:** `api/src/routes/admin/campaigns/` (existing campaign CRUD)

Add `vmdropAssetId` to the campaign create/update schemas. When set, validate that the `VoicemailDropAsset` exists, belongs to the same tenant, and is `active`.

On campaign save, include `vmdrop_local_path` in the M02 config snapshot written to Valkey:
```json
{
  "amd_action": "vmdrop",
  "vmdrop_local_path": "/var/lib/vici2/vmdrop/1/42.wav"
}
```

### 5.5 VM Drop Audit Consumer

**New file:** `api/src/workers/vmdrop-audit-consumer.ts` (or add to existing workers)

Reads `events:vici2.audit.vmdrop` stream via XREADGROUP and writes to `audit_log` table:
```typescript
await prisma.auditLog.create({
  data: {
    tenantId: BigInt(payload.tenant_id),
    actorUserId: null,       // system action
    actorKind: 'system',
    action: payload.action,  // 'vmdrop_played' | 'vmdrop_blocked_consent' | etc.
    entityType: 'campaign',
    entityId: payload.entity_id,
    afterJson: { call_uuid: payload.call_uuid, lead_id: payload.lead_id, vm_drop_path: payload.vm_drop_path },
    ts: new Date(),
  }
});
```

### 5.6 Email Notification Wiring

**File:** `api/src/routes/internal/voicemail-hooks.ts`

After creating the `Voicemail` row, if `box.notifyEmail` is set, enqueue an N01 email job:
```typescript
if (box.notifyEmail) {
  await enqueueEmail({
    to: box.notifyEmail,
    templateSlug: 'new-voicemail',
    variables: {
      mailbox_name: box.name,
      caller_number: caller_number ?? 'unknown',
      duration_sec: String(duration_sec),
      playback_link: `${process.env.APP_BASE_URL}/voicemail?id=${vm.id}`,
    },
  });
}
```

---

## 6. New API Routes — `voicemail/box/:id/messages`

Per the module spec's public interface, add:

```
GET /api/voicemails/box/:id/messages   — list messages for a specific box (paginated)
```

This is a convenience alias for `GET /api/voicemails?mailboxId=:id` but with box-ownership auth (user must be assigned to the box or be admin). Add to `api/src/routes/voicemails.ts`:

```typescript
app.get<{ Params: { id: string }; Querystring: Record<string, string> }>(
  '/api/voicemails/box/:id/messages',
  { preHandler },
  handleListByBox,
);
```

---

## 7. Web UI Changes

### 7.1 VM Drop Asset Upload Page

**New file:** `web/src/app/(admin)/admin/voicemail-drops/page.tsx`

A simple admin page with:
- List of `VoicemailDropAsset` records (name, duration, created date, campaign assignments)
- Upload button → opens a dialog with file input (WAV/MP3) and a name field
- Delete/deactivate action per row
- Preview audio player (uses `/api/admin/vm-drops/:id/play`)

RBAC guard: requires `vmdrop:read`; upload/delete requires `vmdrop:edit`.

### 7.2 Campaign Edit — VM Drop Section

**Existing file:** campaign edit page (whereabouts in `web/src/app/(admin)/admin/` — to be located)

Add a "Voicemail Drop" section that:
- Shows current `amd_action` value
- When `amd_action === 'vmdrop'`, shows a dropdown/select for `vmdropAssetId` (list from `GET /api/admin/vm-drops`)
- When `amd_action === 'vmdrop'` and `vmdropRequiresConsent`, shows a warning badge

### 7.3 Voicemail Inbox — Partial Indicator

**Existing files:** `web/src/app/(agent)/voicemail/` and `web/src/app/(sup)/voicemail/`

Add a visual badge ("Partial" or truncated icon) on `voicemail` rows where `partial === true`. The API's `GET /api/voicemails` already returns the full row — just surface the field in the UI.

---

## 8. RBAC Additions

**File:** `shared/types/src/rbac.ts`

Add new verbs to the `VERBS` array:
```typescript
  // voicemail drop assets (I05)
  'vmdrop:read',
  'vmdrop:edit',
```

**Matrix additions** (in the RBAC matrix file):
- `super_admin`, `admin`: `vmdrop:read` + `vmdrop:edit` (scope: tenant)
- `supervisor`: `vmdrop:read` (scope: tenant), no edit
- `agent`, `viewer`: no access

The existing `voicemail:read` and `voicemail:manage` verbs (I03) cover the `voicemails` message browsing — no change needed.

After editing `rbac.ts`, run `make gen-rbac` to regenerate `dialer/internal/auth/rbac/matrix_gen.go`.

---

## 9. Audit Actions

All audit events use `AuditLog.action` (VARCHAR(64)) and `AuditLog.entityType`:

| Action | Entity Type | Description |
|---|---|---|
| `vmdrop_asset_created` | `vmdrop_asset` | Admin uploaded new VM drop audio |
| `vmdrop_asset_updated` | `vmdrop_asset` | Admin renamed or deactivated asset |
| `vmdrop_asset_deleted` | `vmdrop_asset` | Admin soft-deleted asset |
| `vmdrop_played` | `campaign` | AMD detected machine; VM drop audio played successfully |
| `vmdrop_blocked_no_asset` | `campaign` | AMD detected machine; vmdrop configured but no asset set; fell back to drop |
| `vmdrop_blocked_consent` | `campaign` | AMD detected machine; consent gate blocked VM drop |
| `voicemail_captured` | `voicemail_box` | Inbound caller left a voicemail message |
| `voicemail_partial` | `voicemail_box` | Caller hung up before recording completed |

The `voicemail_captured` / `voicemail_partial` events are emitted by the internal voicemail hook handler. The `vmdrop_*` events are emitted by the Go dialer via the `events:vici2.audit.vmdrop` Valkey stream → consumed by the API audit worker.

---

## 10. Phase Plan

### Phase 1 (Core — 2 days)

**Day 1 — Schema + Asset Management**
1. Write migration `20260513270000_i05_voicemail_drop/migration.sql`
2. Update `api/prisma/schema.prisma` with `VoicemailDropAsset`, `VoicemailBox.notifyEmail`, `Voicemail.partial`, `Campaign.vmdropAssetId`
3. Add `vmdrop:read` and `vmdrop:edit` RBAC verbs; run `make gen-rbac`
4. Implement `api/src/routes/admin/vm-drops/index.ts` (list, upload, get, patch, delete)
   - ffprobe validation
   - ffmpeg transcode to WAV 8 kHz
   - Local file write to `/var/lib/vici2/vmdrop/{tenant_id}/{id}.wav`
5. Write unit tests: `api/test/vm-drops/`

**Day 2 — Dialplan + Hook Extension**
1. Modify `VoicemailRenderer.ts` to add `api_hangup_hook` for partial recording
2. Extend `voicemail-hooks.ts` to accept `partial` field; detect duration < 3s
3. Wire `box.notifyEmail` email notification via N01 queue
4. Add Valkey DID→box cache write/invalidate in `voicemail-boxes.ts`
5. Add `GET /api/voicemails/box/:id/messages` route
6. Add `partial` badge to voicemail inbox UI

### Phase 2 (Dialer Integration — 1.5 days)

**Day 3**
1. Extend `CampaignConfig` and `configJSONSnapshot` in Go with `AMDAction` and `VMDropPath`
2. Add `"vmdrop"` case to `AMDHandler.handle()` with `UUIDBroadcast play_and_hangup`
3. Add fallback logic (no asset → `UUIDKill`)
4. Emit `events:vici2.audit.vmdrop` on play
5. Implement `api/src/workers/vmdrop-audit-consumer.ts`
6. Update M02 config snapshot writer to include `amd_action` + `vmdrop_local_path`
7. Verify `answer_handler.go` writes `status='AVMA'` on vmdrop AMD outcome

**Day 3.5**
1. Extend Gate 5 in `originate/gate.go` for consent check when `amd_action=vmdrop`
2. Add `vmdrop_requires_consent` to campaign config + UI
3. Go unit tests: `amd_handler_test.go` vmdrop cases

### Phase 3 (UI Polish + S3 — 0.5 days)

1. `web/src/app/(admin)/admin/voicemail-drops/page.tsx` — full upload UI
2. Campaign edit page — VM drop section with asset selector
3. S3 upload for VM drop assets via R02 mechanism (async; update `s3_uri` after upload)
4. Integration test: SIPp → inbound call → voicemail capture → row in DB
5. Integration test: AMD event → vmdrop → `UUIDBroadcast` called → lead AVMA

---

## 11. Acceptance Criteria

### Feature A — Inbound Voicemail Capture

- [ ] Inbound call routed by I02 IVR leaf node `terminal_voicemail → voicemail_1` reaches the FS extension `voicemail_1`, plays greeting, records message.
- [ ] On recording completion (or caller hangup), `POST /api/internal/voicemail/recorded` is called and a `voicemails` row is created with `status=NEW`, correct `recording_uri`, `duration_sec`, `caller_number`.
- [ ] If caller hangs up before 3 seconds of audio, `voicemails.partial=1`.
- [ ] Assigned `boxUsers` receive in-app notification "New voicemail in mailbox X from Y".
- [ ] If `voicemail_boxes.notify_email` is set, email notification is enqueued via N01.
- [ ] Admin or assigned agent can browse `/api/voicemails?mailboxId=X` and see the message.
- [ ] `GET /api/voicemails/:id/play` returns a play URL for the recording.
- [ ] `PATCH /api/voicemails/:id` transitions status to READ/ARCHIVED/DELETED.
- [ ] `voicemail_captured` and `voicemail_partial` audit events appear in audit log.

### Feature B — Voicemail Drop

- [ ] Admin can upload a WAV or MP3 file via `POST /api/admin/vm-drops`. File is transcoded to 8 kHz WAV and stored at `/var/lib/vici2/vmdrop/{tenant_id}/{id}.wav`.
- [ ] Upload is rejected if > 10 MB, > 120s, or invalid format.
- [ ] Campaign can be configured with `amd_action=vmdrop` and `vmdropAssetId` pointing to the uploaded asset.
- [ ] When AMD detects MACHINE on a predictive call with `amd_action=vmdrop`, the `AMDHandler` calls `UUIDBroadcast play_and_hangup,{localPath}` on the call.
- [ ] The call ends after the audio plays. Lead `status` is updated to `AVMA`.
- [ ] `vmdrop_played` audit event appears in audit log with `call_uuid`, `lead_id`, `campaign_id`.
- [ ] If campaign has `vmdrop` but no asset configured: falls back to plain `drop` (hangup); `vmdrop_blocked_no_asset` audit event.
- [ ] If campaign has `vmdrop_requires_consent=true` and lead lacks OPTIN consent: call is blocked at origination; `vmdrop_blocked_consent` audit event.
- [ ] Admin can list, preview, and delete VM drop assets via the admin UI.

---

## 12. File Manifest

### New Files
| Path | Purpose |
|---|---|
| `api/prisma/migrations/20260513270000_i05_voicemail_drop/migration.sql` | DB migration |
| `api/src/routes/admin/vm-drops/index.ts` | VM drop asset CRUD + upload |
| `api/test/vm-drops/upload.test.ts` | Upload validation unit tests |
| `api/test/vm-drops/crud.test.ts` | Asset CRUD unit tests |
| `api/src/workers/vmdrop-audit-consumer.ts` | Valkey stream → audit_log writer |
| `web/src/app/(admin)/admin/voicemail-drops/page.tsx` | VM drop asset management UI |
| `freeswitch/conf/dialplan/default/71_vmdrop.xml` | Test-only vmdrop extension |

### Modified Files
| Path | Change |
|---|---|
| `api/prisma/schema.prisma` | Add VoicemailDropAsset, VoicemailBox.notifyEmail, Voicemail.partial, Campaign.vmdropAssetId |
| `shared/types/src/rbac.ts` | Add vmdrop:read, vmdrop:edit verbs |
| `api/src/routes/admin/voicemail-boxes.ts` | Add notifyEmail to BoxCreateSchema; write DID→box Valkey cache |
| `api/src/routes/internal/voicemail-hooks.ts` | Accept partial field; wire email notification |
| `api/src/routes/voicemails.ts` | Add GET /api/voicemails/box/:id/messages |
| `api/src/services/voicemail/VoicemailRenderer.ts` | Add api_hangup_hook to generated XML |
| `dialer/internal/picker/config.go` | Add AMDAction, VMDropPath to CampaignConfig + snapshot |
| `dialer/internal/picker/amd_handler.go` | Add "vmdrop" case; vmDropPath field; audit emit |
| `dialer/internal/originate/gate.go` | Extend Gate 5 for vmdrop consent check |
| `dialer/internal/picker/amd_handler_test.go` | Add vmdrop test cases |

---

## 13. LOC Estimate

| Component | Estimated LOC |
|---|---|
| `migration.sql` | ~60 |
| `api/src/routes/admin/vm-drops/index.ts` | ~300 |
| `api/src/workers/vmdrop-audit-consumer.ts` | ~80 |
| Prisma schema additions | ~40 |
| `voicemail-hooks.ts` extensions | ~50 |
| `voicemail-boxes.ts` extensions (notifyEmail + cache) | ~40 |
| `voicemails.ts` (new box/:id/messages route) | ~40 |
| `VoicemailRenderer.ts` (hangup hook) | ~20 |
| RBAC additions + gen | ~10 |
| `config.go` extensions | ~30 |
| `amd_handler.go` extensions | ~80 |
| `gate.go` extensions | ~40 |
| `web/voicemail-drops/page.tsx` | ~200 |
| Campaign edit UI additions | ~80 |
| Voicemail inbox partial badge | ~20 |
| Unit tests (TS) | ~200 |
| Unit tests (Go) | ~100 |
| **Total** | **~1,390 LOC** |

---

## 14. Risks and Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| ffmpeg not in API container | Medium | Add `ffmpeg` to `api/Dockerfile`; verify with `ffmpeg -version` in health check |
| AMD false-positive drops real human | Medium | Log AMD result + confidence score in audit; admin can listen to recording |
| Caller hangs up before curl webhook fires | Low | `api_hangup_hook` mitigates; add FS error logging for failed curl |
| Multi-node FS — vmdrop file not present | Low (Phase 1 single-node) | Document NFS requirement for Phase 3; add startup check |
| Partitioned `voicemails` `ALTER TABLE ADD COLUMN` slow | Low (table is new, low row count) | Run in maintenance window; MySQL 8 in-place DDL is fast for new columns |
| TCPA consent gate blocks all vmdrop calls | Low (admin sets requires_consent=false for landline campaigns) | Default to requires_consent=true; admin override with warning |
| S3 upload fails for VM drop asset | Low | Phase 1 is local-only; Phase 2 S3 upload is async and non-blocking |
