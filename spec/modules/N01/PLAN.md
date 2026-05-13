# N01 — Notifications Hub — PLAN

| Field | Value |
|---|---|
| **Module** | N01 — In-app + email notifications hub |
| **Author** | N01-IMPLEMENT agent (Claude Sonnet 4.6) |
| **Date** | 2026-05-13 |
| **Status** | IMPLEMENTING |
| **Depends on (FROZEN)** | F02 schema (users.email, tenant_id pattern), F05 (JWT/auth middleware), D06 (WS push infra via `t:{tid}:ws:user:{uid}` channel), W01 (BullMQ queue topology), F04 (Valkey client) |
| **Blocks** | D06-IMPLEMENT (unifies its WS notify), D02 (import_complete/failed events), R02 (recording_failed event), E05 (drop_gate_engaged event) |

Once approved the following are **FROZEN**: REST endpoint paths, request/response shapes, WebSocket event name (`notifications.new`), Prisma model name (`Notification`), table name (`notifications`), prefs table name (`notification_prefs`), the `notify()` helper signature, BullMQ queue name (`vici2:queue:email-delivery`), SMTP env var names, and Prometheus metric names. Internal SMTP implementation, retention logic details, and UI CSS may change without RFC.

---

## 0. TL;DR — 10-bullet decision summary

1. **N01 = DB rows + WS push + email queue.** Every notification creates a `notifications` DB row for offline catch-up; simultaneously publishes to the WS channel for online users; and optionally enqueues a BullMQ email job.
2. **`notify()` helper is the single write path.** All producers (D06, D02, R02, E05) call `notify({ tenantId, userId, category, subject, body, link, severity, channels? })`. N01 handles fan-out.
3. **Six categories ship Phase 1.** `callback_due`, `callback_upcoming`, `import_complete`, `import_failed`, `recording_failed`, `agent_disconnected`, `drop_gate_engaged`. Each has a default channel list (in_app only or in_app+email) and severity.
4. **Per-user delivery preferences.** `notification_prefs` table (user_id, category, channels[]). User can opt-out of email per category. Defaults are baked in; only overrides are stored.
5. **Email is Phase 1 plain SMTP via nodemailer.** Env: `VICI2_SMTP_HOST`, `VICI2_SMTP_PORT`, `VICI2_SMTP_USER`, `VICI2_SMTP_PASS`, `VICI2_SMTP_FROM`, `VICI2_SMTP_TLS` (default true). SES/Postmark Phase 2.
6. **BullMQ queue `vici2:queue:email-delivery`.** W01 topology slot for N01. Retry 3× with exponential back-off. DLQ = Valkey stream `events:vici2.dlq.email-delivery`.
7. **Retention: 7-day read, 30-day unread.** A nightly BullMQ repeatable job (`vici2:queue:notif-cleanup`) prunes old rows. Partitioning deferred Phase 2 (low row volume expected).
8. **WS event: `notifications.new`.** Published on `t:{tid}:ws:user:{uid}` channel after DB insert. Payload: `{ type:'notifications.new', notification: NotificationDto }`.
9. **Five REST endpoints.** `GET /api/notifications`, `PATCH /api/notifications/:id/read`, `POST /api/notifications/read-all`, `DELETE /api/notifications/:id`, `GET|PATCH /api/notifications/prefs`.
10. **Bell icon in TopBar (UI).** Unread badge + dropdown panel with "Mark all read" + click-to-navigate. Extends A03 AgentShell `TopBar` component.

---

## 1. Goals and Non-Goals

### 1.1 Phase 1 Goals

- Schema: `notifications` and `notification_prefs` tables with Prisma models.
- `notify()` helper for all producers.
- In-app delivery: DB row + WS push on `t:{tid}:ws:user:{uid}`.
- Email delivery: BullMQ job → nodemailer SMTP.
- Six notification categories with severity + default channels.
- Per-user delivery preferences API.
- REST CRUD endpoints (list, read, dismiss).
- Retention cleanup worker.
- Bell icon UI with badge + dropdown.
- Unit tests + integration tests.

### 1.2 Phase 2 (Deferred)

- SMS delivery (Twilio).
- SES/Postmark provider (configurable adapter).
- Monthly partitioning of `notifications` table.
- Rich HTML email templates.
- Webhook delivery (N01.5 per N01.md spec).
- Mobile push (FCM/APNs).
- Digest batching (daily/weekly).

### 1.3 Non-Goals

- Email unsubscribe link tracking.
- Email open/click analytics.
- Push notification service worker registration.

---

## 2. Schema

### 2.1 `notifications` table

```sql
CREATE TABLE notifications (
  id            BIGINT      NOT NULL AUTO_INCREMENT,
  tenant_id     BIGINT      NOT NULL DEFAULT 1,
  user_id       BIGINT      NOT NULL,
  channel       ENUM('in_app','email') NOT NULL,
  category      VARCHAR(64)  NOT NULL,
  subject       VARCHAR(255) NOT NULL,
  body          TEXT         NOT NULL,
  severity      ENUM('info','warning','error') NOT NULL DEFAULT 'info',
  link          VARCHAR(512) NULL,
  read_at       DATETIME(6)  NULL,
  created_at    DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  INDEX idx_notif_t_user_read (tenant_id, user_id, read_at, created_at),
  INDEX idx_notif_t_user_unread (tenant_id, user_id, created_at)
);
```

**Prisma model:**

```prisma
enum NotifChannel {
  in_app
  email
}

enum NotifSeverity {
  info
  warning
  error
}

model Notification {
  id        BigInt        @id @default(autoincrement())
  tenantId  BigInt        @default(1) @map("tenant_id")
  userId    BigInt        @map("user_id")
  channel   NotifChannel
  category  String        @db.VarChar(64)
  subject   String        @db.VarChar(255)
  body      String        @db.Text
  severity  NotifSeverity @default(info)
  link      String?       @db.VarChar(512)
  readAt    DateTime?     @map("read_at") @db.DateTime(6)
  createdAt DateTime      @default(now()) @map("created_at") @db.DateTime(6)

  user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)
  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@index([tenantId, userId, readAt, createdAt], map: "idx_notif_t_user_read")
  @@index([tenantId, userId, createdAt], map: "idx_notif_t_user_unread")
  @@map("notifications")
}
```

### 2.2 `notification_prefs` table

Stores per-user overrides. Absence = use category default.

```prisma
model NotificationPref {
  id        BigInt   @id @default(autoincrement())
  tenantId  BigInt   @default(1) @map("tenant_id")
  userId    BigInt   @map("user_id")
  category  String   @db.VarChar(64)
  channels  Json     // string[] e.g. ["in_app","email"]
  createdAt DateTime @default(now()) @map("created_at") @db.DateTime(6)
  updatedAt DateTime @updatedAt @map("updated_at") @db.DateTime(6)

  user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)
  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@unique([tenantId, userId, category], map: "uk_notif_prefs_t_user_cat")
  @@map("notification_prefs")
}
```

---

## 3. Categories and Defaults

| Category | Severity | Default Channels | Produced By |
|---|---|---|---|
| `callback_due` | warning | in_app | D06 worker |
| `callback_upcoming` | info | in_app | D06 worker |
| `import_complete` | info | in_app, email | D02 service |
| `import_failed` | error | in_app, email | D02 service |
| `recording_failed` | error | in_app | R02 service |
| `agent_disconnected` | warning | in_app | operator event |
| `drop_gate_engaged` | error | in_app | E05 service |

---

## 4. `notify()` Helper

```typescript
// api/src/notifications/service.ts

export interface NotifyParams {
  tenantId: number | bigint;
  userId: number | bigint;
  category: NotifCategory;
  subject: string;
  body: string;
  link?: string;
  severity?: 'info' | 'warning' | 'error';
  channels?: NotifChannel[];  // override category defaults
}

export async function notify(params: NotifyParams): Promise<void>
```

Internals:
1. Resolve effective channels: `params.channels ?? getUserPref(userId, category) ?? CATEGORY_DEFAULTS[category]`.
2. For each channel:
   - `in_app`: INSERT `notifications` row + `redis.publish(wsChannel, JSON.stringify({ type:'notifications.new', notification }))`.
   - `email`: INSERT `notifications` row + `emailQueue.add(...)` BullMQ job.
3. All non-blocking on failure (try/catch + pino error log).

---

## 5. API Endpoints

### 5.1 GET /api/notifications

```
Query: ?status=unread|read|all (default=all), ?cursor=<last_id>, ?limit=20
Auth: requireAuth
Response: { items: NotificationDto[], nextCursor: string | null, unreadCount: number }
```

Cursor is the `id` of the last returned row. Index `idx_notif_t_user_read` covers unread queries.

### 5.2 PATCH /api/notifications/:id/read

Marks a single notification read (sets `read_at = NOW()`). 404 if not found or wrong tenant/user. 200 `{ ok: true }`.

### 5.3 POST /api/notifications/read-all

Bulk-updates `read_at = NOW()` for all unread notifications for the calling user. 200 `{ marked: number }`.

### 5.4 DELETE /api/notifications/:id

Hard-deletes the row. User can only delete their own; admin can delete any within tenant. 204.

### 5.5 GET /api/notifications/prefs

Returns per-category preferences merged with defaults.
```json
{ "prefs": [{ "category": "callback_due", "channels": ["in_app"], "isDefault": true }, ...] }
```

### 5.6 PATCH /api/notifications/prefs

```json
{ "category": "import_complete", "channels": ["in_app"] }
```

Upserts `notification_prefs` row. 200 `{ ok: true }`.

---

## 6. WebSocket Integration

WS channel: `t:{tid}:ws:user:{uid}` (existing D06 pattern, already in keys.ts).
Event payload:
```json
{
  "type": "notifications.new",
  "notification": {
    "id": "1",
    "category": "callback_due",
    "subject": "Callback due in 5 minutes",
    "body": "...",
    "severity": "warning",
    "link": "/callbacks",
    "createdAt": "2026-05-13T10:00:00.000Z"
  }
}
```

The API subscribes to this channel via ioredis and forwards to the WebSocket connection (existing A03 WS pattern).

---

## 7. Email Delivery Worker

Location: `workers/src/jobs/email-delivery/`

BullMQ processor:
- Queue name: `vici2:queue:email-delivery`
- Concurrency: 5
- Attempts: 3, backoff: exponential(2000ms)
- removeOnComplete: 100 (keep last 100)
- removeOnFail: 500

Job payload:
```typescript
interface EmailJob {
  notificationId: string;  // bigint as string
  tenantId: string;
  userId: string;
  to: string;   // user.email
  subject: string;
  body: string;
  idempotencyKey: string;  // ULID
}
```

SMTP transport: nodemailer `createTransport` with env config. Phase 1: only text/plain body. Phase 2: mjml HTML templates.

Audit: on successful delivery, write `action: 'notification.email.sent'` to audit log.

---

## 8. Retention Cleanup Worker

BullMQ repeatable job in `vici2:queue:notif-cleanup`, schedule `0 3 * * *` (3 AM UTC daily).

```sql
DELETE FROM notifications
WHERE (read_at IS NOT NULL AND created_at < NOW() - INTERVAL 7 DAY)
   OR (read_at IS NULL AND created_at < NOW() - INTERVAL 30 DAY)
LIMIT 1000;  -- batch cap to avoid long lock
```

Repeat until affected = 0 within a single cron run.

---

## 9. Prometheus Metrics

| Metric | Labels | Owner |
|---|---|---|
| `vici2_n01_notify_total` | `category, channel` | notify() |
| `vici2_n01_email_delivery_total` | `outcome={sent,failed}` | email worker |
| `vici2_n01_email_queue_depth` | — | metrics scrape |
| `vici2_n01_ws_push_total` | `category` | notify() |
| `vici2_n01_cleanup_deleted_total` | — | cleanup worker |

---

## 10. Frontend — Bell Icon

Files:
- `web/src/components/notifications/NotificationBell.tsx` — bell icon with badge
- `web/src/components/notifications/NotificationPanel.tsx` — dropdown panel
- `web/src/hooks/useNotifications.ts` — state + API calls + WS listener

Bell state management:
- On mount: `GET /api/notifications?status=unread&limit=20`.
- WS message `type='notifications.new'`: prepend to list, increment badge.
- "Mark all read": `POST /api/notifications/read-all`.
- Click notification: navigate to `notification.link`, call `PATCH /api/notifications/:id/read`.

TopBar integration: import `NotificationBell` into the existing `TopBar` component.

---

## 11. Files to Create

```
api/src/notifications/
  categories.ts         — category registry (defaults, subjects, severity)
  service.ts            — notify() + getPrefs() + resolveChannels()
  retention.ts          — cleanup query helper
  index.ts              — Fastify plugin: route registration
  handlers/
    list.ts             — GET /api/notifications
    read.ts             — PATCH /api/notifications/:id/read
    read-all.ts         — POST /api/notifications/read-all
    dismiss.ts          — DELETE /api/notifications/:id
    prefs.ts            — GET|PATCH /api/notifications/prefs

workers/src/jobs/email-delivery/
  index.ts              — BullMQ worker entry + SIGTERM
  processor.ts          — job handler (nodemailer send)
  mailer.ts             — nodemailer transport singleton

api/prisma/migrations/<ts>_n01_notifications/
  migration.sql

web/src/components/notifications/
  NotificationBell.tsx
  NotificationPanel.tsx

web/src/hooks/
  useNotifications.ts

api/test/notifications/
  notify.test.ts        — unit: notify() helper
  api.test.ts           — integration: list/read/dismiss endpoints
  email-queue.test.ts   — unit: email job enqueue
  ws.test.ts            — unit: WS broadcast on notify
```

---

## 12. Test Plan

### 12.1 Unit tests (vitest)

- `notify()` with `channels=['in_app']` → inserts 1 DB row + publishes WS, no BullMQ job.
- `notify()` with `channels=['email']` → inserts 1 DB row + BullMQ job, no WS publish.
- `notify()` with `channels=['in_app','email']` → 2 DB rows + WS + BullMQ.
- `resolveChannels()` — user pref overrides default; absent pref uses default.
- `GET /api/notifications?status=unread` → returns only unread rows.
- `PATCH /api/notifications/:id/read` → sets read_at; 404 for wrong user.
- `POST /api/notifications/read-all` → bulk updates; returns count.
- `DELETE /api/notifications/:id` → 204; 404 for wrong tenant.
- WS: `notify()` publishes `notifications.new` JSON on correct channel.
- Email processor: nodemailer sendMail called with correct to/subject/body.
- Prefs: PATCH upserts; GET merges with defaults.

### 12.2 Integration tests

- End-to-end: call `notify()` → GET → assert row returned.
- Retention: insert old rows → run cleanup → assert deleted.

---

## 13. Env Vars Added

```bash
# N01 SMTP (Phase 1)
VICI2_SMTP_HOST=smtp.example.com
VICI2_SMTP_PORT=587
VICI2_SMTP_USER=vici2@example.com
VICI2_SMTP_PASS=<password>
VICI2_SMTP_FROM="Vici2 <noreply@example.com>"
VICI2_SMTP_TLS=true
```

---

## 14. Acceptance Criteria

- [ ] `notify({ tenantId, userId, category:'callback_due', subject, body })` creates a `notifications` row with `channel='in_app'` and publishes WS event.
- [ ] `notify({ ..., channels:['email'] })` enqueues a BullMQ job; `user.email` is the recipient.
- [ ] `GET /api/notifications?status=unread` returns only rows with `read_at IS NULL` for the calling user.
- [ ] `PATCH /api/notifications/:id/read` sets `read_at`; subsequent GET excludes it from unread count.
- [ ] `POST /api/notifications/read-all` marks all unread; returns correct count.
- [ ] `DELETE /api/notifications/:id` hard-deletes; 404 on second call.
- [ ] `GET /api/notifications/prefs` merges user overrides with defaults for all 7 categories.
- [ ] `PATCH /api/notifications/prefs` upserts; subsequent GET reflects change.
- [ ] WS event `notifications.new` received by online user within 100 ms of `notify()`.
- [ ] Email BullMQ job retries 3× on failure; reaches DLQ on exhaustion.
- [ ] Cleanup job deletes 7-day-old read rows and 30-day-old unread rows.
- [ ] Bell icon shows unread count badge; dropdown lists latest 20.
- [ ] "Mark all read" clears badge.
- [ ] `pnpm test` passes in api/ and workers/.
- [ ] `pnpm typecheck` clean in api/, workers/, web/.

---

*End of N01 PLAN — spec/modules/N01/PLAN.md*
