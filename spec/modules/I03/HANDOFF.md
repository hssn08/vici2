# I03 — Voicemail + Greetings — HANDOFF

**Status:** DONE
**Date:** 2026-05-13
**Branch:** feat/I03-implement
**Tests:** 29 passed, 0 failed

---

## What was built

### Schema (migration `20260513260000_i03_voicemail`)

| Table | Purpose |
|---|---|
| `voicemail_boxes` | Per-tenant mailbox definitions; owner = ingroup_id / user_id / did_id |
| `voicemail_box_users` | ACL join: which users can read/manage a given mailbox |
| `voicemails` | Voicemail messages; monthly-partitioned by `created_at`; statuses NEW/READ/ARCHIVED/DELETED |

Prisma models added: `VoicemailBox`, `VoicemailBoxUser`, `Voicemail`, `VoicemailStatus` enum.

### VoicemailRenderer (`api/src/services/voicemail/VoicemailRenderer.ts`)

Generates FreeSWITCH dialplan XML for each active mailbox:
- File: `freeswitch/conf/dialplan/default/75_voicemail_{box_id}.xml`
- Extension name: `voicemail_{box_id}` (FROZEN — I02 transfers here)
- Call flow: answer → play greeting → beep → record → POST webhook → hangup
- On deactivation: removes XML file + reloadxml
- ESL client injectable via `setEslClient()` for testing

### FreeSWITCH dialplan

`freeswitch/conf/dialplan/default/75_voicemail_DEFAULT.xml` — seed extension for mailbox ID 1. VoicemailRenderer regenerates on admin saves.

### API routes

| Route | Auth | Purpose |
|---|---|---|
| `GET /api/admin/voicemail-boxes` | admin | List all tenant mailboxes |
| `POST /api/admin/voicemail-boxes` | admin | Create mailbox + render XML |
| `GET /api/admin/voicemail-boxes/:id` | admin | Get mailbox detail |
| `PATCH /api/admin/voicemail-boxes/:id` | admin | Update mailbox + re-render |
| `DELETE /api/admin/voicemail-boxes/:id` | admin | Soft-delete (active=false) |
| `POST /api/admin/voicemail-boxes/:id/greeting` | admin | Upload WAV/MP3 greeting |
| `DELETE /api/admin/voicemail-boxes/:id/greeting` | admin | Remove custom greeting |
| `POST /api/admin/voicemail-boxes/:id/users` | admin | Assign user to mailbox |
| `DELETE /api/admin/voicemail-boxes/:id/users/:userId` | admin | Remove user from mailbox |
| `GET /api/voicemails` | auth | List accessible voicemails |
| `GET /api/voicemails/:id/play` | auth | Get play URL |
| `PATCH /api/voicemails/:id` | auth | Status transition |
| `DELETE /api/voicemails/:id` | auth | Soft-delete (DELETED status) |
| `POST /api/internal/voicemail/recorded` | x-internal-secret | FS webhook post-recording |
| `GET /api/internal/voicemail/file` | dev-only | Serve local WAV file |

### RBAC verbs (`shared/types/src/rbac.ts`)

| Verb | super_admin | admin | supervisor | agent | viewer |
|---|---|---|---|---|---|
| `voicemail:read` | tenant | tenant | group | own | tenant |
| `voicemail:manage` | tenant | tenant | — | — | — |

### N01 category (`api/src/notifications/categories.ts`)

`voicemail_new` — severity: info, channels: in_app + email. Fired when a new voicemail is created; all users in `voicemail_box_users` for the mailbox receive it.

### N07 transcription handoff

When `voicemail_boxes.transcribe = true`, the internal hook publishes to Valkey stream `events:vici2.transcription.requested` with `{voicemail_id, file_uri, tenant_id, source: "voicemail"}`. N07 worker consumes and writes back `transcript_uri` + `transcribed=true`.

### Web UI

| Page | Route | Purpose |
|---|---|---|
| Agent voicemail | `/agent/voicemail` | List + playback + status actions |
| Supervisor voicemail | `/sup/voicemail` | Same as agent (server-side RBAC enforces scope) |
| Admin mailbox CRUD | `/admin/admin/voicemail-boxes` | CRUD + greeting upload + user assignment |

---

## Key contracts for downstream modules

### Extension namespace (FROZEN)

```
voicemail_{box_id}    in    freeswitch/conf/dialplan/default/75_voicemail_{box_id}.xml
```

I02 IVR `terminal_voicemail` node generates: `transfer voicemail_{action_target} XML default`
I01 overflow action `voicemail` must generate: `transfer voicemail_{target} XML default`

**Target = `voicemail_box_id` as a string.** Box ID is a BIGINT; the extension name uses the numeric ID.

### Post-record webhook

FreeSWITCH POSTs to `POST /api/internal/voicemail/recorded` with form body:
```
box_id={box_id}&call_uuid={uuid}&tenant_id={tenant_id}&caller_number={caller_id_number}&duration_sec={record_seconds}&file_path={record_name}
```
Auth: `X-Internal-Secret` header (env `INTERNAL_SECRET`).

### Transcription stream event

Stream: `events:vici2.transcription.requested`
Message field `data`: JSON string `{voicemail_id, file_uri, tenant_id, source: "voicemail"}`

N07 must write back via a direct DB update (PATCH not yet exposed as internal endpoint; N07 should call `prisma.voicemail.update`).

---

## Tests run

```
cd api && vitest run test/voicemail/
# PASS: 29 tests (8 VoicemailRenderer + 21 RBAC/category/contract)
```

---

## What I03 does NOT do

- Does NOT implement per-caller DTMF navigation within voicemail (retrieval IVR) — deferred Phase 4
- Does NOT implement S3 upload of voicemail recordings — R02 pattern reusable, deferred Phase 4
- Does NOT implement voicemail-to-email (audio attachment) — N02 email templates deferred
- Does NOT drop/rotate voicemail partitions — O02 retention worker owns this
- Does NOT enforce per-mailbox storage quotas — Phase 4
