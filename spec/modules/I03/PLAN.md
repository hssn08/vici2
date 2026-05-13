# I03 — Voicemail + Greetings — PLAN

| Field | Value |
|---|---|
| **Module** | I03 — Voicemail + Greetings (record/store/playback; IVR terminal action; I01 overflow sink) |
| **Phase** | 3 (Inbound/Blended) |
| **Author** | I03-IMPLEMENT agent (Claude Sonnet 4.6) |
| **Date** | 2026-05-13 |
| **Status** | IMPLEMENTING |
| **Depends on (FROZEN)** | I02 PLAN §4.3 (terminal_voicemail → `voicemail_{box_id}` extension in default context); I01 PLAN §9 (overflow chain actions: `voicemail`); R01 HANDOFF §1 (recording path, Valkey state key pattern); N01 HANDOFF (notify() signature, in_app+email channels); M02 PLAN §5 (RBAC matrix, voicemail verbs); F03 PLAN (dialplan slots); F02 schema conventions |
| **Blocks** | N07 (transcription: I03 emits events:vici2.transcription.requested stream; N07 consumes) |

---

## 0. TL;DR — 10-bullet decision summary

1. **Two new tables:** `voicemail_boxes` (per-tenant; one mailbox per in_group, per agent, or per DID) and `voicemails` (messages; monthly partitioned).
2. **FreeSWITCH dialplan extension `voicemail_{box_id}`** in `default` context (`75_voicemail_{box_id}.xml`). Plays mailbox greeting (WAV), records caller voice via `mod_native_file` / `record`, uploads file to local FS path following R01 conventions, then posts a webhook to the internal API.
3. **Greeting management:** per-mailbox WAV/MP3 uploaded via admin API; stored in `freeswitch/sounds/voicemail/{tenant_id}/{box_id}_greeting.wav` (dev) / S3 `vici2-media/voicemail/{tenant_id}/{box_id}_greeting.wav` (prod). System default greeting is `sys_voicemail_default.wav`.
4. **IVR wiring:** I02's `terminal_voicemail` node sets `action_target = box_id`; IvrRenderer emits `transfer voicemail_{box_id} XML default`. I03 owns the `voicemail_*` extension namespace (FROZEN for I02 compatibility).
5. **I01 overflow wiring:** I01's overflow action `voicemail` uses `ingroups.closed_target` / `no_agent_target` as the box ID; the dialplan for those actions transfers to `voicemail_{target} XML default`.
6. **Post-record webhook:** FS extension POSTs to `POST /api/internal/voicemail/recorded` (authenticated by FS_XMLCURL credentials) with `{box_id, call_uuid, file_path, caller_number, duration_sec, tenant_id}`. API creates the `voicemails` row, emits N01 notification to mailbox owners, and emits the transcription-requested stream event if N07 is enabled.
7. **Notification:** new voicemail → N01 `notify()` with category `voicemail_new` (in_app + email). All users assigned to the mailbox receive the notification.
8. **Transcription (optional):** on voicemail completion, publish `events:vici2.transcription.requested` Valkey stream message `{voicemail_id, file_uri, tenant_id}`. N07 worker consumes and writes back `transcript_uri` + `transcribed=true` via `PATCH /api/voicemails/:id` (internal) when done.
9. **Playback UI:** `/agent/voicemail/` (own mailboxes) + `/sup/voicemail/` (assigned mailboxes). API returns pre-signed URL (or local redirect) for playback.
10. **Admin UI:** `/admin/voicemail-boxes/` — CRUD for mailbox definitions, greeting upload, assignment to in_group / agent / DID.

---

## 1. Schema

### 1.1 Table: `voicemail_boxes`

```sql
CREATE TABLE voicemail_boxes (
  id                BIGINT PRIMARY KEY AUTO_INCREMENT,
  tenant_id         BIGINT NOT NULL DEFAULT 1,
  name              VARCHAR(128) NOT NULL,
  -- owner semantics: exactly one of ingroup_id, user_id, or did_id is set
  ingroup_id        VARCHAR(32) DEFAULT NULL
    COMMENT 'FK to ingroups.id (VARCHAR PK) — mailbox for this in-group overflow',
  user_id           BIGINT DEFAULT NULL
    COMMENT 'FK to users.id — personal agent mailbox',
  did_id            BIGINT DEFAULT NULL
    COMMENT 'FK to did_numbers.id — DID-level mailbox',
  greeting_uri      VARCHAR(512) DEFAULT NULL
    COMMENT 'Local or S3 URI for the custom greeting WAV; NULL = system default',
  max_duration_sec  SMALLINT UNSIGNED NOT NULL DEFAULT 120
    COMMENT 'Maximum recording length before auto-hangup',
  transcribe        BOOLEAN NOT NULL DEFAULT FALSE
    COMMENT 'When TRUE, emit transcription.requested event after recording',
  active            BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6),
  updated_at        DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  INDEX idx_vmb_tenant_active (tenant_id, active),
  UNIQUE KEY uk_vmb_tenant_name (tenant_id, name),
  CONSTRAINT fk_vmb_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT
);
```

### 1.2 Table: `voicemail_box_users` (ACL join)

```sql
CREATE TABLE voicemail_box_users (
  voicemail_box_id  BIGINT NOT NULL,
  user_id           BIGINT NOT NULL,
  tenant_id         BIGINT NOT NULL DEFAULT 1,
  created_at        DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (voicemail_box_id, user_id),
  INDEX idx_vmbu_tenant_user (tenant_id, user_id),
  CONSTRAINT fk_vmbu_box    FOREIGN KEY (voicemail_box_id) REFERENCES voicemail_boxes(id) ON DELETE CASCADE,
  CONSTRAINT fk_vmbu_user   FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_vmbu_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT
);
```

### 1.3 Table: `voicemails` (monthly partitioned)

```sql
CREATE TABLE voicemails (
  id              BIGINT NOT NULL AUTO_INCREMENT,
  tenant_id       BIGINT NOT NULL DEFAULT 1,
  mailbox_id      BIGINT NOT NULL,
  call_uuid       VARCHAR(40) NOT NULL,
  recording_uri   VARCHAR(512) NOT NULL
    COMMENT 'Local path or S3 URI of the WAV recording',
  duration_sec    SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  caller_number   VARCHAR(20) DEFAULT NULL,
  status          ENUM('NEW','READ','ARCHIVED','DELETED') NOT NULL DEFAULT 'NEW',
  transcribed     BOOLEAN NOT NULL DEFAULT FALSE,
  transcript_uri  VARCHAR(512) DEFAULT NULL,
  created_at      DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at      DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id, created_at),
  INDEX idx_vm_tenant_mailbox_status (tenant_id, mailbox_id, status, created_at),
  INDEX idx_vm_tenant_created (tenant_id, created_at),
  INDEX idx_vm_call_uuid (tenant_id, call_uuid),
  CONSTRAINT fk_vm_mailbox FOREIGN KEY (mailbox_id) REFERENCES voicemail_boxes(id) ON DELETE RESTRICT
) PARTITION BY RANGE (TO_DAYS(created_at)) (
  PARTITION p_2026_05 VALUES LESS THAN (TO_DAYS('2026-06-01')),
  PARTITION p_2026_06 VALUES LESS THAN (TO_DAYS('2026-07-01')),
  PARTITION p_2026_07 VALUES LESS THAN (TO_DAYS('2026-08-01')),
  PARTITION p_max     VALUES LESS THAN MAXVALUE
);
```

### 1.4 Prisma models

```prisma
model VoicemailBox {
  id             BigInt   @id @default(autoincrement())
  tenantId       BigInt   @default(1) @map("tenant_id")
  name           String   @db.VarChar(128)
  ingroupId      String?  @map("ingroup_id") @db.VarChar(32)
  userId         BigInt?  @map("user_id")
  didId          BigInt?  @map("did_id")
  greetingUri    String?  @map("greeting_uri") @db.VarChar(512)
  maxDurationSec Int      @default(120) @map("max_duration_sec") @db.UnsignedSmallInt
  transcribe     Boolean  @default(false)
  active         Boolean  @default(true)
  createdAt      DateTime @default(now()) @map("created_at") @db.DateTime(6)
  updatedAt      DateTime @updatedAt @map("updated_at") @db.DateTime(6)

  tenant    Tenant              @relation(fields: [tenantId], references: [id], onDelete: Restrict)
  voicemails Voicemail[]
  boxUsers  VoicemailBoxUser[]

  @@unique([tenantId, name], map: "uk_vmb_tenant_name")
  @@index([tenantId, active], map: "idx_vmb_tenant_active")
  @@map("voicemail_boxes")
}

model VoicemailBoxUser {
  voicemailBoxId BigInt   @map("voicemail_box_id")
  userId         BigInt   @map("user_id")
  tenantId       BigInt   @default(1) @map("tenant_id")
  createdAt      DateTime @default(now()) @map("created_at") @db.DateTime(6)

  box    VoicemailBox @relation(fields: [voicemailBoxId], references: [id], onDelete: Cascade)
  user   User         @relation(fields: [userId], references: [id], onDelete: Cascade)
  tenant Tenant       @relation(fields: [tenantId], references: [id], onDelete: Restrict)

  @@id([voicemailBoxId, userId])
  @@index([tenantId, userId], map: "idx_vmbu_tenant_user")
  @@map("voicemail_box_users")
}

enum VoicemailStatus {
  NEW
  READ
  ARCHIVED
  DELETED
}

model Voicemail {
  id            BigInt          @id @default(autoincrement())
  tenantId      BigInt          @default(1) @map("tenant_id")
  mailboxId     BigInt          @map("mailbox_id")
  callUuid      String          @map("call_uuid") @db.VarChar(40)
  recordingUri  String          @map("recording_uri") @db.VarChar(512)
  durationSec   Int             @default(0) @map("duration_sec") @db.UnsignedSmallInt
  callerNumber  String?         @map("caller_number") @db.VarChar(20)
  status        VoicemailStatus @default(NEW)
  transcribed   Boolean         @default(false)
  transcriptUri String?         @map("transcript_uri") @db.VarChar(512)
  createdAt     DateTime        @default(now()) @map("created_at") @db.DateTime(6)
  updatedAt     DateTime        @updatedAt @map("updated_at") @db.DateTime(6)

  mailbox VoicemailBox @relation(fields: [mailboxId], references: [id], onDelete: Restrict)

  @@index([tenantId, mailboxId, status, createdAt], map: "idx_vm_tenant_mailbox_status")
  @@index([tenantId, createdAt], map: "idx_vm_tenant_created")
  @@index([tenantId, callUuid], map: "idx_vm_call_uuid")
  @@map("voicemails")
}
```

---

## 2. FreeSWITCH Dialplan

### 2.1 Extension namespace (FROZEN)

- File: `freeswitch/conf/dialplan/default/75_voicemail_{box_id}.xml`
- Extension name: `voicemail_{box_id}`
- Generated by `VoicemailRenderer` service (parallel to IvrRenderer)

### 2.2 Generated XML template

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!-- Auto-generated by I03 VoicemailRenderer — DO NOT EDIT. -->
<!-- Mailbox: {box_id} | Tenant: {tenant_id} -->
<include>
  <extension name="voicemail_{box_id}" continue="false">
    <condition field="destination_number" expression="^voicemail_{box_id}$">
      <!-- Tag call -->
      <action application="set" data="vici2_role=voicemail"/>
      <action application="set" data="vici2_vm_box_id={box_id}"/>
      <action application="set" data="vici2_tenant_id={tenant_id}"/>
      <action application="answer"/>
      <!-- Play greeting -->
      <action application="playback" data="{greeting_path}"/>
      <!-- Beep -->
      <action application="playback" data="tone_stream://%(500,0,440)"/>
      <!-- Record -->
      <action application="record" data="{record_path} {max_duration_sec} 200 3"/>
      <!-- Post-record: notify API -->
      <action application="curl" data="${api_url}/api/internal/voicemail/recorded post box_id={box_id}&amp;call_uuid=${uuid}&amp;tenant_id={tenant_id}&amp;caller_number=${caller_id_number}&amp;duration_sec=${record_seconds}"/>
      <action application="hangup" data="NORMAL_CLEARING"/>
    </condition>
  </extension>
</include>
```

Recording path: `/var/lib/freeswitch/recordings/{tenant_id}/voicemail/{YYYY}/{MM}/{DD}/vm_{box_id}_{call_uuid}.wav`

---

## 3. API Endpoints

### 3.1 Admin routes (admin+)

```
GET    /api/admin/voicemail-boxes                     list mailboxes
POST   /api/admin/voicemail-boxes                     create mailbox
GET    /api/admin/voicemail-boxes/:id                 get mailbox
PATCH  /api/admin/voicemail-boxes/:id                 update mailbox
DELETE /api/admin/voicemail-boxes/:id                 soft-delete (active=false)
POST   /api/admin/voicemail-boxes/:id/greeting        upload greeting WAV/MP3
DELETE /api/admin/voicemail-boxes/:id/greeting        remove custom greeting
POST   /api/admin/voicemail-boxes/:id/users           assign user to mailbox
DELETE /api/admin/voicemail-boxes/:id/users/:userId   remove user from mailbox
```

### 3.2 Agent / supervisor voicemail routes

```
GET    /api/voicemails                                list voicemails for accessible mailboxes
GET    /api/voicemails/:id/play                       get play URL (redirect to local or pre-signed S3)
PATCH  /api/voicemails/:id                            status transitions (READ, ARCHIVED, DELETED)
DELETE /api/voicemails/:id                            soft-delete (sets status=DELETED)
```

### 3.3 Internal route (FS webhook)

```
POST   /api/internal/voicemail/recorded               called by FS after recording completes
```

Auth: HTTP Basic `FS_XMLCURL_USER` / `FS_XMLCURL_PASS` (same as IVR internal hooks).

---

## 4. Service: VoicemailRenderer

Location: `api/src/services/voicemail/VoicemailRenderer.ts`

Responsibilities:
- On mailbox create/update/delete: render `75_voicemail_{box_id}.xml` + `bgapi reloadxml`
- Resolve greeting path: custom greeting file or system default `sys_voicemail_default.wav`
- Atomic file write (tmp rename pattern, same as IvrRenderer)

---

## 5. RBAC

Two new verbs added to `shared/types/src/rbac.ts`:

| Verb | Description |
|---|---|
| `voicemail:read` | Read voicemail messages for accessible mailboxes |
| `voicemail:manage` | Admin CRUD on mailbox definitions |

Matrix additions:
- `super_admin`: both verbs, scope tenant
- `admin`: both verbs, scope tenant
- `supervisor`: `voicemail:read`, scope group
- `agent`: `voicemail:read`, scope own

---

## 6. Notification

N01 category `voicemail_new` (in_app + email). On new voicemail: all users in `voicemail_box_users` for the mailbox receive the notification. `notify()` called once per user.

---

## 7. Transcription (N07 handoff)

When `voicemail_boxes.transcribe = true` and N07 is available, publish to Valkey stream `events:vici2.transcription.requested`:
```json
{
  "voicemail_id": "123",
  "file_uri": "/var/lib/freeswitch/recordings/1/voicemail/2026/05/13/vm_1_abc.wav",
  "tenant_id": "1",
  "source": "voicemail"
}
```

N07 worker writes back `transcript_uri` and sets `transcribed=true` on the voicemail row.

---

## 8. Web UI

### 8.1 Agent voicemail page: `web/src/app/(agent)/voicemail/page.tsx`
- Table of voicemails: caller number, duration, date, status, mailbox name
- HTML5 audio playback inline
- Mark read / archive / delete actions

### 8.2 Supervisor voicemail page: `web/src/app/(sup)/voicemail/page.tsx`
- Same as agent but shows mailboxes from all assigned groups

### 8.3 Admin: `web/src/app/(admin)/admin/voicemail-boxes/page.tsx`
- Mailbox list with owner assignment, greeting upload, user assignment

---

## 9. Files to create

```
# Migration
api/prisma/migrations/20260513260000_i03_voicemail/migration.sql

# Prisma schema additions (in-place edit)
api/prisma/schema.prisma

# VoicemailRenderer service
api/src/services/voicemail/VoicemailRenderer.ts

# API routes
api/src/routes/admin/voicemail-boxes.ts
api/src/routes/voicemails.ts
api/src/routes/internal/voicemail-hooks.ts

# Admin route index (add voicemail registration)
api/src/routes/admin/index.ts  (amended)
api/src/server.ts              (amended — register voicemail + internal vm routes)

# RBAC (in-place edit)
shared/types/src/rbac.ts

# N01 category (in-place edit)
api/src/notifications/categories.ts

# FS dialplan
freeswitch/conf/dialplan/default/75_voicemail_DEFAULT.xml

# Web UI
web/src/app/(agent)/voicemail/page.tsx
web/src/app/(sup)/voicemail/page.tsx
web/src/app/(admin)/admin/voicemail-boxes/page.tsx

# Tests
api/test/voicemail/voicemail-renderer.test.ts
api/test/voicemail/voicemail-routes.test.ts
```

---

## 10. Acceptance criteria

- AC1: IVR `terminal_voicemail` node transfers to `voicemail_{box_id}` extension; caller hears greeting + records.
- AC2: I01 overflow action `voicemail` routes to `voicemail_{target}` extension.
- AC3: Voicemail recording saved to disk and `voicemails` row created via webhook.
- AC4: All users assigned to a mailbox receive `voicemail_new` in_app notification.
- AC5: Voicemail list API returns only messages for mailboxes accessible to caller's role.
- AC6: Status transitions (READ/ARCHIVED/DELETED) update correctly with 200.
- AC7: Greeting upload stores WAV and triggers dialplan regeneration.
- AC8: `transcribe=true` boxes emit transcription.requested stream event.
- AC9: RBAC: agents cannot access mailboxes they are not assigned to.
- AC10: Admin can CRUD mailboxes and manage user assignments.
