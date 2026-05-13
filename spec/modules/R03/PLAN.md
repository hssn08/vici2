# R03 — Recording Playback UI — PLAN

| Field | Value |
|---|---|
| Module | R03 — Recording playback UI (supervisor + auditor) |
| Phase | 1 |
| Status | PLAN |
| Date | 2026-05-13 |
| Depends-on | R01 (recording_log, path convention), R02 (getPlaybackUrl, setLegalHold, verifyIntegrity routes), M02 (RBAC), C03 (AuditWriter) |
| Blocks | nothing in Phase 1 |

---

## 0. TL;DR — 10-bullet decision summary

1. **Two new API endpoints only.** `GET /api/recordings` (list + search + cursor pagination) and `GET /api/recordings/:id` (detail with transcript ref). All mutation endpoints (URL, legal-hold, integrity) are already shipped by R02. R03 calls them from the UI; it does NOT duplicate them.
2. **RBAC verbs used.** `recording:list` (read list), `recording:download` (get pre-signed URL = listen), `recording:delete` is NOT used by R03 (out of scope Phase 1). Legal-hold toggle requires `super_admin` role (checked server-side by R02's route — R03 only shows the button). Integrity verify requires `super_admin` or `admin`.
3. **Audit on every playback URL fetch.** Each call to `GET /api/recordings/:id/url` already logs via R02's `RecordingService.getPlaybackUrl()`. R03's list and detail endpoints also write `recording.accessed` audit rows (IP + user-agent) via the shared `audit()` helper.
4. **Cursor pagination on list.** `after_id` (bigint, opaque cursor) + `limit` (default 50, max 200). Keyset on `(start_time DESC, id DESC)` — avoids OFFSET performance cliff at 7-year retention scale.
5. **Search filters.** date_from / date_to, campaign_id, agent_id (user_id), lead_phone_last4, call_uuid (exact), has_transcript (boolean), has_legal_hold (boolean), lifecycle_state enum, consent_status enum.
6. **Web: supervisor route `(sup)/recordings/`** — list page + detail page. **Admin route `(admin)/recordings/`** — thin redirect/wrapper (same component, wider RBAC). Both are Next.js server components with client sub-components.
7. **HTML5 audio player.** Native `<audio controls>` element; no heavy waveform library in Phase 1. Pre-signed URL fetched client-side on play-button click (lazy, 300 s TTL). Avoids embedding the URL in the server-rendered HTML (prevents CDN caching of sensitive URLs).
8. **Transcript viewer.** If `transcript_status === 'completed'`, fetch transcript JSON inline (≤5000 words) or via presigned URL. Display as scrollable word list with timestamp offsets. No real-time sync in Phase 1 (Phase 4 feature).
9. **Legal-hold toggle.** Visible only when `auth.role === 'super_admin'`. Calls `POST /api/recordings/:id/legal-hold` (R02). Optimistic UI with rollback on error.
10. **No new Prisma migrations.** R03 reads `recording_log` (R01/R02 schema) and `recordings` (R02 schema). No new tables. All fields already exist.

---

## 1. API — GET /api/recordings

### 1.1 Request

```
GET /api/recordings
  ?after_id=<bigint>          cursor (exclusive, last seen id)
  &limit=50                   1-200
  &date_from=YYYY-MM-DD
  &date_to=YYYY-MM-DD
  &campaign_id=<int>
  &agent_id=<int>
  &lead_phone_last4=<4digits>
  &call_uuid=<uuid>
  &has_transcript=true|false
  &has_legal_hold=true|false
  &lifecycle_state=uploaded|available|archived|deleted
  &consent_status=prompted_accepted|not_required|...
```

### 1.2 RBAC

- Requires `recording:list` verb (super_admin, admin, supervisor, viewer, agent have it — scope enforced per role).
- Scope enforcement: supervisor → group-scoped (filter to campaign_ids in their user_group); agent → own calls only (user_id = auth.uid).

### 1.3 Response

```jsonc
{
  "recordings": [
    {
      "id": "123456789",
      "call_uuid": "8a3e1c4f-...",
      "start_time": "2026-05-13T14:22:00.000Z",
      "duration_sec": 187,
      "campaign_id": 42,
      "campaign_name": "Summer Outbound",
      "agent_id": 7,
      "agent_name": "Jane Smith",
      "lead_phone": "***-***-1234",   // masked, last4 only
      "lifecycle_state": "available",
      "consent_status": "prompted_accepted",
      "has_transcript": true,
      "has_legal_hold": false,
      "size_bytes": "3145728"
    }
  ],
  "next_cursor": "123456700",   // null if no more rows
  "total_hint": 4821            // approximate COUNT for display
}
```

### 1.4 Audit

Write `recording.list` audit row with filter params in `after_json`, IP + user-agent. Happens on every request (not just first page).

---

## 2. API — GET /api/recordings/:id (detail)

### 2.1 RBAC

Requires `recording:list`. Scope checked same as list. Returns 404 (not 403) for cross-tenant or out-of-scope rows.

### 2.2 Response (extends R02's metadata + adds transcript ref + call context)

```jsonc
{
  "id": "123456789",
  "call_uuid": "8a3e1c4f-...",
  "start_time": "2026-05-13T14:22:00.000Z",
  "duration_sec": 187,
  "campaign_id": 42,
  "campaign_name": "Summer Outbound",
  "agent_id": 7,
  "agent_name": "Jane Smith",
  "lead_id": 55001,
  "lead_phone": "***-***-1234",
  "disposition": "CALLBK",
  "lifecycle_state": "available",
  "consent_status": "prompted_accepted",
  "has_legal_hold": false,
  "legal_hold_reason": null,
  "sha256": "abc123...",
  "size_bytes": "3145728",
  "storage_url_prefix": "s3://vici2-recordings-prod-us-east-1/tenants/1/calls/2026/05/13/",
  "transcript_status": "completed",
  "transcript_word_count": 423,
  "encoded_at": "2026-05-13T14:28:00.000Z"
}
```

### 2.3 Audit

Write `recording.accessed` audit row with `entity_id = recording_log.id`, IP + user-agent.

---

## 3. Web UI

### 3.1 Routes

| Path | Component | Role guard |
|---|---|---|
| `/sup/recordings` | RecordingsListPage (server) + RecordingsTable (client) | supervisor + |
| `/sup/recordings/[id]` | RecordingDetailPage (server) + RecordingDetail (client) | supervisor + |
| `/admin/recordings` | thin import of sup component | admin + |
| `/admin/recordings/[id]` | thin import of sup component | admin + |

### 3.2 RecordingsTable (client component)

- Filter bar: date range pickers, campaign dropdown, agent dropdown, search field (last4 phone or UUID), lifecycle_state pills, has_transcript toggle.
- Table columns: Start time | Duration | Campaign | Agent | Phone (last4) | Transcript | State | Actions.
- Actions column: "Listen" button → opens detail page. "Download" button → calls `GET /api/recordings/:id/url` → triggers browser download via anchor tag with `download` attr.
- Cursor pagination: "Load more" button appends next page (no full re-render).
- Empty state with clear-filters CTA.

### 3.3 RecordingDetailPage

Server component fetches detail row (no auth cookie forwarding needed — uses internal API URL). Falls back to loading skeleton on Suspense.

### 3.4 RecordingDetail (client component)

Sections:
1. **Call Metadata strip** — campaign, agent, lead phone (masked), start time, duration, disposition, consent decision badge, lifecycle_state badge.
2. **Audio Player** — "Load Audio" button (lazy fetch `GET /api/recordings/:id/url` on click). On success, render `<audio controls src={url} />`. If `lifecycle_state !== 'available'` show reason (e.g. "archived — request download via admin"). TTL countdown shown (300 s).
3. **Download** — calls same URL endpoint with `?ttl=3600` (max) → anchor `download`. Requires `recording:download` perm; button hidden if not.
4. **Transcript panel** — shown only when `transcript_status === 'completed'`. Fetches `GET /api/recordings/:id/transcript`. Renders scrollable word list grouped by speaker (Left/Right channel). Phase 1: no real-time highlight sync.
5. **Integrity section** — "Verify Integrity" button (admin+). Calls `GET /api/recordings/:id/integrity-check`. Shows SHA-256 match + legal hold date.
6. **Legal Hold toggle** (super_admin only) — POST/DELETE `/api/recordings/:id/legal-hold`. Reason textarea. Optimistic update.
7. **Back to list** breadcrumb.

---

## 4. File layout

### 4.1 API

```
api/src/routes/recordings/
  list.ts             ← NEW: GET /api/recordings
  detail.ts           ← NEW: GET /api/recordings/:id (richer than R02's metadata)
  index.ts            ← AMENDED: add registerRecordingListRoute + registerRecordingDetailRoute
```

### 4.2 Web

```
web/src/app/(sup)/recordings/
  page.tsx                    ← server component (list)
  [id]/page.tsx               ← server component (detail)
web/src/app/(admin)/recordings/
  page.tsx                    ← thin import/redirect to sup
  [id]/page.tsx               ← thin import/redirect to sup
web/src/components/recordings/
  RecordingsFilterBar.tsx     ← "use client"
  RecordingsTable.tsx         ← "use client"
  RecordingDetail.tsx         ← "use client"
  AudioPlayer.tsx             ← "use client"
  TranscriptPanel.tsx         ← "use client"
  LegalHoldToggle.tsx         ← "use client"
```

### 4.3 Tests

```
api/src/routes/recordings/list.test.ts
api/src/routes/recordings/detail.test.ts
```

---

## 5. Audit action strings

| Action | When |
|---|---|
| `recording.list` | Every `GET /api/recordings` request |
| `recording.accessed` | Every `GET /api/recordings/:id` detail fetch |
| `recording.url_fetched` | Every `GET /api/recordings/:id/url` (already logged by R02; R03 does NOT double-log) |

These strings are added to the `AuditAction` union in `api/src/auth/audit.ts`.

---

## 6. Security properties

- Pre-signed URLs are never stored in DB, never in SSR HTML, never in browser localStorage.
- Lead phone number is masked server-side (last4 only) for all roles except super_admin + admin.
- All list/detail endpoints are tenant-scoped: `WHERE tenant_id = $auth.tenantId`.
- Supervisor scope: list additionally filters `campaign_id IN (SELECT campaign_id FROM user_group_campaigns WHERE user_group_id = $auth.ugId)`.
- Agent scope: list additionally filters `user_id = $auth.uid`.

---

## 7. Tests plan

- `list.test.ts`: pagination cursor correctness, filter by date/campaign/agent, scope enforcement (supervisor sees only group, agent sees only own), audit row written, 401 without auth.
- `detail.test.ts`: tenant isolation (404 cross-tenant), scope enforcement, audit row written.
- Web components tested via TypeScript type-check only (no jsdom in Phase 1).

---

## 8. Non-goals

- Waveform visualization (Phase 4, wavesurfer.js).
- Real-time transcript sync during playback (Phase 4).
- Share-token for external parties (Phase 4).
- Download via R03 streaming proxy (R02 pre-signed URL is sufficient; no proxy needed).
- Recording deletion UI (out of scope Phase 1).
- Bulk operations (Phase 2).
