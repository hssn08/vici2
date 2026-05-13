# I05 — Voicemail Capture + Drop: Research

**Module:** I05  
**Track:** Inbound + Outbound  
**Date:** 2026-05-13  
**Status:** RESEARCH COMPLETE

---

## 1. I03 VoicemailBox Schema — What Exists, What Is Missing

### 1.1 Existing Schema (from `api/prisma/schema.prisma` lines 2333–2400 and `api/prisma/migrations/20260513260000_i03_voicemail/migration.sql`)

The I03 migration already created three tables:

**`voicemail_boxes`** — mailbox configuration:
| Column | Type | Notes |
|---|---|---|
| `id` | BIGINT AUTOINCREMENT | PK |
| `tenant_id` | BIGINT | FK→tenants |
| `name` | VARCHAR(128) | tenant-scoped unique |
| `ingroup_id` | VARCHAR(32) | optional FK→ingroups.id |
| `user_id` | BIGINT | optional FK→users.id (personal mailbox) |
| `did_id` | BIGINT | optional FK→did_numbers.id (DID-level mailbox) |
| `greeting_uri` | VARCHAR(512) | local path or S3 URI; NULL = system default |
| `max_duration_sec` | SMALLINT UNSIGNED | default 120 |
| `transcribe` | TINYINT(1) | if 1, emits transcription.requested event |
| `active` | TINYINT(1) | soft-delete flag |
| `created_at` / `updated_at` | DATETIME(6) | timestamps |

**`voicemail_box_users`** — ACL join table mapping users to mailboxes they can access.

**`voicemails`** — per-message records (monthly partitioned):
| Column | Type | Notes |
|---|---|---|
| `id` | BIGINT | PK (composite with created_at for partition) |
| `tenant_id` | BIGINT | |
| `mailbox_id` | BIGINT | app-layer FK (no DB FK due to partitioning) |
| `call_uuid` | VARCHAR(40) | FreeSWITCH channel UUID |
| `recording_uri` | VARCHAR(512) | local path or S3 URI |
| `duration_sec` | SMALLINT UNSIGNED | |
| `caller_number` | VARCHAR(20) | caller ID |
| `status` | ENUM(NEW, READ, ARCHIVED, DELETED) | |
| `transcribed` | TINYINT(1) | |
| `transcript_uri` | VARCHAR(512) | set by N07 |
| `created_at` / `updated_at` | DATETIME(6) | |

### 1.2 Fields Present — Good News

The I03 schema is already well-designed for inbound capture:
- `did_id` covers DID-to-mailbox routing (inbound caller → DID → mailbox)
- `ingroup_id` covers ingroup overflow routing (I02 IVR terminal_voicemail node → mailbox)
- `user_id` covers personal agent mailboxes
- `greeting_uri` stores per-box greeting WAV (already uploaded via `POST /api/admin/voicemail-boxes/:id/greeting`)
- `max_duration_sec` controls recording duration
- `voicemail_box_users` ACL allows multiple agents to monitor the same mailbox

### 1.3 What Is Missing for I05

**Missing from `voicemail_boxes`:**
1. **`notify_email`** (VARCHAR(255), nullable) — optional email address for new-voicemail notification. Currently `voicemail-hooks.ts` notifies via in-app notification to all `boxUsers`; email delivery requires wiring through N01's email queue. A per-box override email (e.g., a team alias) is more practical than requiring all recipients to have user accounts.
2. **`pin`** (VARCHAR(6), nullable, hashed) — future: per-mailbox PIN for web-based retrieval. Not strictly required for I05 scope but common in VM systems. Defer to I06.
3. **`source_type`** — the existing three nullable columns (`ingroup_id`, `user_id`, `did_id`) provide routing binding, but there is no single authoritative "source" discriminant. This is acceptable for I05; the dialplan extension name (`voicemail_{box_id}`) is the single routing key that IVR/inbound transfers resolve to.

**Missing from `voicemails`:**
1. **`source_type`** — e.g., `inbound_capture` vs. (hypothetically) `outbound_drop_echo` — not needed; VM drop is outbound and writes no `voicemails` row (see section 4).
2. **`partial`** (TINYINT(1)) — flag for caller-hung-up-before-recording-complete. Currently there is no partial flag; FreeSWITCH's `record` application writes a file regardless of whether the caller hung up mid-recording, and the webhook fires with whatever `${record_seconds}` has. This is adequate for I05 because the file is still playable — we just add a `partial` column to distinguish sub-3-second "accidental hangup" clips from genuine messages.

**Missing for VM Drop (new table):**
- **`voicemail_drop_assets`** — no table yet. The Campaign model has `vmdrop_audio VARCHAR(255)` which stores a local file path string. I05 must replace this with a proper DB-backed asset model (per-tenant + per-campaign, S3-backed, with format validation metadata).

### 1.4 Current `vmdrop_audio` Field on Campaign

`api/prisma/schema.prisma` line 411:
```
vmdropAudio  String?  @map("vmdrop_audio") @db.VarChar(255)
```

This is a simple VARCHAR storing a local path. The `AmdAction` enum already has `vmdrop` as a value (line 357). The `AMDHandler` in `dialer/internal/picker/amd_handler.go` handles `"message"` action (plays `/var/lib/vici2/audio/amd_msg.wav`) and `"park"` (Phase 3 stub). The enum value `vmdrop` in the DB does not yet map to a case in `AMDHandler.handle()`.

**Conclusion:** I05 must:
1. Create a `voicemail_drop_assets` table for proper asset management.
2. Extend `Campaign.vmdropAudio` to reference an asset ID (or keep the path and resolve at play time via the asset table).
3. Wire `AMDHandler` case `"vmdrop"` to resolve the campaign's asset path and play it via `UUIDBroadcast` then `UUIDKill`.

---

## 2. mod_voicemail vs. Custom `record_session` Pipeline

### 2.1 FreeSWITCH mod_voicemail — What It Provides

`mod_voicemail` is a full-featured voicemail system bundled with FreeSWITCH. It provides:
- File-based mailbox storage under `${voicemail_dir}/${profile_name}/${domain}/${mailbox_id}/`
- Per-mailbox PIN authentication
- MWI (Message Waiting Indicator) via SIP NOTIFY
- Email delivery of new messages (embedded SMTP)
- Web interface via optional `mod_voicemail_ivr`
- Auto-greet, record, and callback dialplan macros
- IMAP4-compatible storage (`mod_voicemail_ivr` + Dovecot gateway)

### 2.2 Why mod_voicemail Is Not Appropriate for vici2

| Concern | mod_voicemail | vici2 Custom Pipeline |
|---|---|---|
| Storage model | Flat files in FS host filesystem | DB row + S3/local path managed by app |
| Multi-tenant | Domain-scoped (one FS domain per tenant = extra SIP complexity) | Tenant ID on every DB row; native |
| Mailbox management | `mod_voicemail` XML or XML_CURL config | REST API + VoicemailRenderer writes dialplan XML |
| Admin UI | None (or third-party FS GUI) | vici2 admin panel (already built in I03) |
| Notification | SMTP config in mod_voicemail.conf | vici2 N01 email + in-app notification (already wired) |
| Transcription | Not built in | Events → N07 whisper worker (already wired in I03) |
| Recording lifecycle | FS-local forever | S3 upload via R01/R02 + lifecycle policy |
| Search / filter | Not supported | SQL queries on `voicemails` table |
| RBAC | None | vici2 voicemail:read / voicemail:manage verbs |
| Scaling | Single FS node (IMAP gateway needed for multi-node) | S3 URI in DB — any node reads |
| BYOC SIP compliance | Needs FS as B2BUA for mailbox | FS records; API stores |

**Recommendation: use the existing custom `record_session` pipeline (already in I03).**

The I03 VoicemailRenderer already generates FreeSWITCH dialplan XML with:
```
answer → playback(greeting) → playback(beep) → record(path, max_sec) → curl(webhook) → hangup
```
This pipeline is idiomatic FreeSWITCH and fully controllable from the API. I05 adds **no change** to the inbound capture dialplan pattern itself — it only extends which boxes receive traffic (DID routing, IVR routing) and adds new API surface.

The only reason to consider `mod_voicemail` would be MWI (lamp on desk phone). vici2's agents use WebRTC softphones (A01/A02) so MWI SIP NOTIFY is irrelevant. Decision: **custom pipeline, no mod_voicemail dependency.**

---

## 3. VM Drop File Storage

### 3.1 Current State

`Campaign.vmdropAudio` is a `VARCHAR(255)` local path. The `AMDHandler.handle()` case `"message"` hardcodes `/var/lib/vici2/audio/amd_msg.wav`. Neither approach is suitable for production multi-tenant operation.

### 3.2 Design for VM Drop Asset Storage

**Recommended: same S3 bucket as recordings, separate prefix.**

The R01/R02 recording infra uses an S3 bucket already. VM drop audio files are per-tenant, per-campaign, admin-uploaded assets — not session recordings. They should live at:
```
s3://{bucket}/{tenant_id}/vmdrop/{asset_id}_{filename}
```

Separate from recordings because:
- Different lifecycle (assets are permanent until admin deletes; recordings rotate)
- Different IAM policy (assets are readable by FreeSWITCH at call time; recordings are agent-playback-only)
- Different RBAC verb (`vmdrop:read/edit` vs `recording:list/download`)

**FreeSWITCH playback from S3:** FreeSWITCH natively cannot stream from S3. Two options:
1. **Pre-download on upload:** When admin uploads a VM drop asset, the API stores it to S3 and also writes a local FS-accessible copy to `/var/lib/vici2/vmdrop/{tenant_id}/{asset_id}.wav`. The AMDHandler plays the local copy.
2. **On-demand download:** AMDHandler retrieves a pre-signed URL and uses FreeSWITCH's `mod_http_cache` to play it. More complex, adds latency on first play.

**Recommendation: Option 1 (pre-download on upload).** The VM drop audio file is usually < 60 seconds (< 1 MB at 8 kHz WAV). Pre-placing it on the FS host at upload time is simple and has zero call-time latency. In multi-node FS deployments, a shared NFS mount or a startup sync script handles distribution. For Phase 1 (single FS host), local copy is sufficient.

**Format requirements:**
- Input: WAV (PCM 8 kHz or 16 kHz, mono, 16-bit) or MP3
- Server-side transcode: ffmpeg converts to WAV 8 kHz/mono before writing local copy
- Size limit: 10 MB upload; typically < 1 MB after transcode
- Duration limit: 120 seconds (enforced by ffprobe before accepting)

### 3.3 Asset Metadata

New `voicemail_drop_assets` table must store:
- `id`, `tenant_id`
- `campaign_id` (nullable — an asset can be campaign-specific or tenant-wide library)
- `name` — human label
- `s3_uri` — canonical S3 path
- `local_path` — local FS path for FS playback
- `duration_sec` — populated by ffprobe at upload
- `format` — 'wav' | 'mp3' (before transcode)
- `size_bytes` — original upload size
- `active` — soft-delete
- `created_by` — user FK
- timestamps

Campaign then references `vmdrop_asset_id BIGINT FK → voicemail_drop_assets.id` (replacing the bare `vmdrop_audio` VARCHAR). The VARCHAR column is left for backward compatibility until a migration drops it.

---

## 4. AMD Integration — Tracing Through the Dialer

### 4.1 Current AMD Event Flow

1. **Origination:** `dialer/internal/originate/originate.go` calls FreeSWITCH via ESL with `execute_on_answer=park` for PREDICTIVE mode. When the remote party answers, the call is parked.

2. **AMD detection (T03):** FreeSWITCH runs AMD on the parked call. When AMD resolves, it writes an event to Valkey stream `events:vici2.call.amd_detected` with fields: `call_uuid`, `campaign_id`, `tenant_id`, `lead_id`, `list_id`, `result` (HUMAN/MACHINE/UNSURE), `fs_host`.

3. **AMDHandler consumption:** `dialer/internal/picker/amd_handler.go` — `AMDHandler.Run()` — consumes via `XREADGROUP`. It filters to its own `campaignID` and calls `handle()`.

4. **Per-list action dispatch:** `handle()` calls `listAMDActionFn(ev.ListID)` to get the action string, then switches on:
   - `"drop"` → `UUIDKill(NORMAL_CLEARING)`
   - `"transfer"` → Phase 3 stub (logs WARN)
   - `"message"` → `UUIDBroadcast(audioPath="play_and_hangup,/var/lib/vici2/audio/amd_msg.wav", leg="aleg")`
   - `"park"` → Phase 3 stub (logs INFO as "voicemail-drop Phase 3 stub")

**Key finding:** The `"vmdrop"` enum value in the DB `AmdAction` enum maps to the `"park"` case in Go (which is the Phase 3 stub). The `configJSONSnapshot` struct (`config.go` line 67–75) does not include `amd_action` or `vmdrop_asset_id` — these are not propagated to the `CampaignConfig`. The `listAMDActionFn` is injected by the caller; in production it likely reads from the config snapshot or a separate list config. This is the gap I05 must bridge.

### 4.2 What I05 Must Add to AMD Integration

1. **CampaignConfig**: add `AMDAction string` and `VMDropLocalPath string` fields.
2. **`configJSONSnapshot`**: add `amd_action` and `vmdrop_local_path` JSON fields.
3. **M02 config snapshot writer**: when campaign is saved with `amd_action=vmdrop`, write `vmdrop_local_path` from the resolved `voicemail_drop_assets.local_path`.
4. **AMDHandler.handle()**: add case `"vmdrop"`:
   ```go
   case "vmdrop":
       if h.vmDropPath == "" {
           h.logger.Warn("picker: vmdrop — no asset configured", "campaign_id", h.campaignID)
           h.t01.UUIDKill(ctx, ev.FSHost, ev.CallUUID, "NORMAL_CLEARING")
           return
       }
       if err := h.t01.UUIDBroadcast(ctx, ev.FSHost, ev.CallUUID,
           "play_and_hangup,"+h.vmDropPath, "aleg"); err != nil {
           h.logger.Error("picker: vmdrop UUIDBroadcast error", "call_uuid", ev.CallUUID, "err", err)
       }
       // Emit audit event via Valkey stream
       h.emitVMDropAudit(ctx, ev)
   ```
5. **Lead status update**: after VM drop, set lead `status = 'AVMA'` (answering machine voicemail left). Currently the AMD outcome maps to `OutcomeAMD` in `types.go`; the retry policy marks this terminal. I05 must ensure the lead status writer (D04 / answer_handler) correctly distinguishes `vmdrop` from plain `drop` for the AVMA status.

### 4.3 `listAMDActionFn` vs Campaign-Level Action

Currently `listAMDActionFn` resolves per list. The `vmdropAudio` is per-campaign in the schema. For I05, the VM drop asset is campaign-level (one audio file per campaign). This is consistent with Vicidial's model where `amd_action` and `vmdrop_audio` are campaign fields, not list fields. The per-list action override (`list.amd_action`) should fall back to campaign-level `amd_action` when not set at list level — this is the existing behavior since `listAMDActionFn` defaults to `"drop"`. I05 must ensure campaign-level `vmdrop` action is plumbed through.

---

## 5. Caller Hangs Up Mid-Greeting / Mid-Recording

### 5.1 FreeSWITCH Behavior

When the caller hangs up while FreeSWITCH is executing the dialplan:

- **During `playback` (greeting):** FreeSWITCH raises `CHANNEL_HANGUP`. If the dialplan is still executing synchronously, the `playback` application stops and subsequent actions are skipped — **the `record` application never starts**, so no file is written. No webhook fires. No orphaned row.

- **During `record`:** The `record` application writes the partial WAV file. When the channel hangs up, FreeSWITCH terminates `record` and fires `CHANNEL_HANGUP`. The `record` application sets `${record_seconds}` to however many seconds were captured. The `curl` action fires normally via `bgapi` (non-blocking — the dialplan continues through hangup in some FS versions). However, if the session dies before `curl` executes, the webhook may not fire.

### 5.2 Vicidial Behavior Reference

Vicidial uses `mod_voicemail` which saves the recording on hangup regardless. For inbound capture, Vicidial's AstRecording pattern saves files even if 0 seconds long — it uses an Asterisk AGI that runs post-hangup via the `h` extension. The equivalent in FreeSWITCH is the `hangup_hook` channel variable.

### 5.3 Recommended Approach

**For partial recordings (caller hangs up during record):**
1. Always fire the webhook — use `uuid_execute` in the hangup hook rather than relying on the dialplan cursor reaching the `curl` action.
2. Add a `partial TINYINT(1) DEFAULT 0` column to `voicemails`. The webhook sets `partial=1` if `duration_sec < 3` (configurable threshold).
3. Partial voicemails are shown in the admin inbox with a visual indicator but are not auto-deleted — admin may want to review them.
4. UI filter: default view hides partial; toggle to show.

**Implementation:** Modify the dialplan XML generated by `VoicemailRenderer` to:
```xml
<action application="set" data="api_hangup_hook=curl ${vm_notify_url} post ${vm_post_body}"/>
```
The `api_hangup_hook` fires on any hangup reason. This ensures the webhook always fires even if the caller drops mid-greeting (in which case `duration_sec=0` and `file_path` may point to an empty or non-existent file — add a guard in the hook handler).

**If file_path is empty or file doesn't exist:** The hook handler returns 200 OK but sets a `partial=1, duration_sec=0` row and a `recording_uri` of `null` or a sentinel value. These rows are visible to admins as "missed VM attempts" — useful for reporting (e.g., "caller tried to leave a message but hung up immediately").

---

## 6. Notification — Email on New Voicemail

### 6.1 Current I03 Notification

`api/src/routes/internal/voicemail-hooks.ts` already notifies assigned users via `notify()` (in-app notification via Valkey publish). It passes `null` for the email queue parameter with a TODO comment referencing N01 BullMQ wiring.

### 6.2 I05 Extension

I05 should wire the email notification:
1. If `voicemail_boxes.notify_email` is set (new column), send email to that address.
2. For each `boxUsers` member who has an email address, send via N01's email queue.
3. Email template: `new-voicemail` template (delivered via N02's email template system). Template variables: `{{mailbox_name}}`, `{{caller_number}}`, `{{duration_sec}}`, `{{playback_link}}`.
4. `playback_link` is a pre-signed or authenticated URL to `/api/voicemails/:id/play`.

**N02 integration:** The email template system at `api/src/email-templates/` uses Handlebars. A `new-voicemail` template needs to be seeded in the DB (N02 module manages this). I05 should define the template structure and leave seeding to N02 or include a data migration.

---

## 7. TCPA Compliance for VM Drops

### 7.1 Regulatory Background

Under the Telephone Consumer Protection Act (TCPA) as interpreted by the FCC:
- **Ringless voicemail (RVM)** — delivering a pre-recorded message directly to a consumer's voicemail inbox without causing the phone to ring — was declared subject to TCPA consent requirements in a 2023 FCC ruling (Matter of Safe Telecommunications v. FCC). RVM requires prior express written consent for autodialed calls to cell phones.
- **VM drops via predictive dialing** — the pattern in I05 where a predictive dialer dials the consumer, AMD detects a machine, and plays a pre-recorded message — is **autodialed** and **pre-recorded**, triggering TCPA § 227(b)(1)(A)(iii) for cell numbers. Consent is required.

### 7.2 Consent Gate Integration

vici2 already has consent architecture:
- `dialer/internal/originate/gate.go` — Gate 5: `ErrConsentBlocked` enforces consent checks before origination.
- `dialer/internal/originate/chanvars.go` — `vici2_consent_required` and `vici2_consent_state` channel vars.
- `dialer/internal/originate/request.go` — `OriginateRequest.LeadState` carries consent state.

**For VM drop:** When `amd_action=vmdrop` and the lead is a cell phone number, vici2 must:
1. Verify the lead has `consent_state = 'OPTIN'` (or equivalent written consent) before allowing the VM drop.
2. If consent is absent: fall back to `"drop"` (hangup, no VM left) and flag the lead accordingly.
3. This check should occur **before** origination (add to Gate 5 logic) or at AMD callback time (check lead consent state from the `vici2_consent_state` channel var already set on the call).

**Option A (preferred): pre-origination gate.** When `amd_action=vmdrop`, treat the call as requiring consent (same as `vici2_consent_required=true`). Gate 5 already blocks if consent is absent. No AMD handler change needed — if the call is never placed, no VM drop occurs.

**Option B: AMD-time check.** AMDHandler reads `vici2_consent_state` from the live channel via ESL `uuid_getvar`. More complex and adds ESL round-trips on every AMD hit.

**Recommendation: Option A** — extend Gate 5 to also require consent when `amd_action=vmdrop` on a cell-phone lead. Add a campaign-level boolean `vmdrop_requires_consent TINYINT(1) DEFAULT 1` (default on = safe). Admins can disable for landline-only campaigns where TCPA cell-phone rules don't apply.

### 7.3 DNC Interaction

VM drops must respect DNC lists. This is already enforced at origination time (Gate 4: `ErrDNCHit`). No additional logic needed — if a number is DNC, the call never originates and no VM is dropped.

### 7.4 Time-of-Day

VM drops are restricted to the same calling windows as regular dials (Gate 1 / TCPA hours). Already enforced. No change needed.

### 7.5 Audit Trail

Every VM drop attempt must be audited:
- Success: `vmdrop_played` audit event with `call_uuid`, `campaign_id`, `lead_id`, `asset_id`, `fs_host`.
- Fallback (no consent): `vmdrop_blocked_consent` audit event.
- Fallback (no asset): `vmdrop_blocked_no_asset` audit event.

---

## 8. Inbound Routing — How I02 IVR Connects to I03/I05 Boxes

`api/src/routes/admin/voicemail-boxes.ts` — `BoxCreateSchema` shows the three binding columns: `ingroupId`, `userId`, `didId`. The `VoicemailRenderer` generates an extension named `voicemail_{box_id}` in `freeswitch/conf/dialplan/default/75_voicemail_{box_id}.xml`.

I02 IVR `terminal_voicemail` leaf nodes transfer to `voicemail_{box_id}` via `UUIDTransfer`. The existing `75_voicemail_DEFAULT.xml` shows the pattern. I05 does not change this flow — the inbound capture pipeline already works end-to-end from I03.

What I05 adds is ensuring that **DID-based routing** works without an IVR:
- Inbound DID with no IVR → I01 overflow action `closedAction=voicemail` already routes to the mailbox associated with the DID.
- `voicemail_boxes.did_id` is set when an inbound DID is configured to go straight to voicemail.
- The I01 overflow transfer command must resolve `did_id → box_id` and transfer to `voicemail_{box_id}`.

This DID resolution is not yet implemented end-to-end. I05 PLAN must include a lookup endpoint or a Valkey cache entry: `t:{tenant_id}:did:{did_id}:vm_box_id → {box_id}`.

---

## 9. Open Questions

1. **Multi-node FS and VM drop asset distribution:** In a cluster with N FreeSWITCH nodes, each node needs the VM drop WAV locally. Options: shared NFS, rsync on upload, S3 `mod_http_cache`. Phase 1: single-node. Phase 3: NFS or HTTP cache.

2. **VM drop and AVMA lead status:** The schema's `AmdAction` enum has `vmdrop`. Does the picker's answer_handler currently write `status='AVMA'` on AMD outcomes? Need to verify `dialer/internal/picker/answer_handler.go` — if not, I05 must add it.

3. **Partial recording recovery:** If the API process is down when FS fires the curl webhook, the recording is written to disk but no DB row is created. A "file reconciler" job could scan the voicemail recording directory for orphan files and create rows. Scope for Phase 3.

4. **S3 upload for inbound recordings:** Currently `VoicemailRenderer` writes to a local path. R01/R02 handles session recording S3 upload. Should voicemail recordings go through the same R01 pipeline? Recommended: yes — emit a `recording.finalized` event from the voicemail hook handler; R01 worker picks it up and uploads to S3, updating `recording_uri` to the S3 URI. I05 Phase 1 uses local paths; Phase 2 wires R01.

5. **Email notification template:** N02 module owns email templates. I05 should define the `new-voicemail` template schema and coordinate with N02 for seeding. Does I05 seed it directly or does N02's migration include it?

6. **VM drop audio format validation:** ffprobe dependency — is ffmpeg/ffprobe available in the API container? Currently `voicemail-boxes.ts` notes "Real prod: convert MP3 → WAV 8kHz via ffmpeg before writing" but the implementation just writes the raw buffer. I05 must add actual ffmpeg transcoding.

7. **Beep detection for VM drop:** Vicidial has a "wait for beep" mode where the dialer waits for the answering machine beep tone before playing the drop audio, for a more natural-sounding VM. FreeSWITCH can detect the beep via `${amd_result}` or a secondary beep detection pass. This is a quality improvement for Phase 3 — Phase 1 plays immediately after AMD detection.

8. **Per-list vs per-campaign `amd_action`:** The Go `listAMDActionFn` resolves per-list. The DB `Campaign.amdAction` is per-campaign. Currently there is no `list.amd_action` column in the schema. The discrepancy suggests the picker was designed for per-list overrides (future) but currently falls back to campaign-level. I05 should clarify and standardize on campaign-level for `vmdrop`.

---

## 10. Summary of Findings

| Decision | Choice | Rationale |
|---|---|---|
| VM capture engine | Custom `record_session` pipeline (I03 existing) | DB-backed, multi-tenant, S3-ready; mod_voicemail is file-based and single-domain |
| VM drop storage | S3 (same bucket, `vmdrop/` prefix) + local FS copy | Zero call-time latency; simple for single-node Phase 1 |
| Partial recording handling | Save with `partial=1` flag; show in admin with indicator | Admins may want to review; don't auto-delete |
| TCPA compliance | Pre-origination consent gate (Option A) | Simpler; no AMD-time ESL round-trips |
| Notification | In-app (existing) + N01 email (new wiring) | Extend existing `notify()` call with email queue |
| AMD action plumbing | Extend `CampaignConfig` + `configJSONSnapshot` + add `"vmdrop"` case to AMDHandler | Minimal change to existing handler structure |
| DID routing | Valkey cache `t:{tid}:did:{did_id}:vm_box_id` | Fast lookup at IVR time; invalidated on box update |
