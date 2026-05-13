# N02 — Email Template System — PLAN

| Field | Value |
|---|---|
| **Module** | N02 — Email Template System |
| **Author** | N02-PLAN agent (Claude Sonnet 4.6) |
| **Date** | 2026-05-13 |
| **Status** | PLAN |
| **Depends on (FROZEN)** | N01 (BullMQ queue `vici2:queue:email-delivery`, `notify()` signature, `NotifCategory` type), S03 (sanitize-html allowlist pattern, versioning pattern, ScriptVersion model shape), F05 (JWT/auth middleware, `requireAuth`, `requirePermission`), F02 schema (users, tenants, audit_log), C03 (audit chain via `AuditWriter`) |
| **Blocks** | N01-IMPLEMENT email-delivery worker (must call `renderEmail()` instead of passing raw body string), N05 (if it adds email categories) |

Once approved, the following are **FROZEN**: Prisma model names (`EmailTemplate`, `EmailTemplateVersion`), table names (`email_templates`, `email_template_versions`), the `renderEmail()` function signature, BullMQ queue name (inherited from N01: `vici2:queue:email-delivery`), REST endpoint paths under `/api/admin/email-templates`, and RBAC permission verbs (`email_templates:read`, `email_templates:edit`). Internal Handlebars helper list, HTML sanitize allowlist CSS properties, and UI component CSS may change without RFC.

---

## 0. TL;DR — 12-bullet decision summary

1. **Handlebars for interpolation, MJML-compiled HTML for seed templates.** Handlebars `{{variable}}` syntax at runtime; MJML used offline to author the 7 default HTML bodies, compiled once, stored as HTML in `email_templates.html_body`. No MJML runtime dependency.
2. **Frozen safe-helpers list.** Only 5 built-in helpers (`formatDate`, `phoneFormat`, `ifEq`, `upper`, `truncate`). No user-defined helpers. Helper code lives in `api/src/email-templates/helpers.ts`.
3. **Schema: `email_templates` + `email_template_versions`.** Compound key: `(tenant_id, category, lang)` unique active template. Version history: last 10 per `(tenant_id, category, lang)`, same prune-at-11 logic as S03 `script_versions`.
4. **`users.preferred_lang` column added.** N02 migration adds `preferred_lang VARCHAR(10) DEFAULT 'en'` to `users`. The N01 email-delivery worker passes `user.preferredLang` to `renderEmail()`.
5. **Auto-generate plain text on save.** `html-to-text` npm package runs at PATCH time; result stored in `text_body`. Admin can then manually override `text_body` without re-triggering auto-generation.
6. **Multi-language: category × lang compound key; fallback to `"en"`.** Phase 1 seeds English only. Schema supports arbitrary langs from Day 1.
7. **`renderEmail(tenantId, category, lang, vars)` is the single render path.** Returns `{ subject, html, text }`. Called by the N01 email-delivery worker (replacing the current pass-through of raw body strings).
8. **Sanitize-html reuses S03 allowlist with email extensions.** Adds `img` (src must be HTTPS, no `data:` URLs), legacy Outlook compat attributes on `table`/`td`/`th`, `center`, `font`.
9. **Seven API endpoints.** `GET /api/admin/email-templates`, `POST`, `GET /:id`, `PATCH /:id`, `DELETE /:id`, `POST /:id/preview`, `POST /:id/test-send`, `GET /:id/versions`.
10. **RBAC: `email_templates:read` (supervisor+) and `email_templates:edit` (admin+).** Same hierarchy pattern as `script:read` / `script:edit`.
11. **Audit on every write.** Every `POST`, `PATCH`, `DELETE` writes to `audit_log` via C03 `AuditWriter` with action `email_template.created` / `.updated` / `.deleted`.
12. **List-Unsubscribe headers shipped Phase 1.** One-click unsubscribe link via HMAC token; updates `notification_prefs`. Required for Gmail/Yahoo bulk sender compliance.

---

## 1. Goals and non-goals

### 1.1 Phase 1 Goals

- Schema: `email_templates` and `email_template_versions` Prisma models.
- `users.preferred_lang` column (migration).
- `renderEmail(tenantId, category, lang, vars)` service function.
- Seed: 7 default English templates (one per N01 category) with MJML-compiled HTML + auto-generated plain text.
- Frozen variable vocabulary per category.
- HTML sanitization via `sanitize-html` with email-safe allowlist.
- Auto-generate plain text via `html-to-text` on save.
- CRUD API under `/api/admin/email-templates`.
- Preview endpoint (test render with sample vars, no send).
- Test-send endpoint (renders + enqueues BullMQ job to real SMTP, rate-limited).
- N01 email-delivery worker updated to call `renderEmail()`.
- RBAC: `email_templates:read` + `email_templates:edit`.
- Audit log entries on every write.
- List-Unsubscribe header + one-click unsubscribe endpoint.
- Admin UI: list + edit (with preview iframe) + test-send modal.
- Unit tests: rendering golden fixtures, sanitize escape, plain-text generation.

### 1.2 Phase 2 (deferred)

- Additional language seed templates (Spanish `es`, French `fr`).
- Per-tenant `From` address / `notification_email_from` column.
- DKIM env var support (`VICI2_SMTP_DKIM_*`).
- HTML size limit warning in UI editor (90 KB soft cap).
- Attachment metadata in template (for PDF contracts etc.).

### 1.3 Phase 3 (marketing blast, deferred)

- `blast` category group with lead-field variable vocabulary.
- Opt-in tracking pixel support (per-tenant, with consent checkbox).
- Unsubscribe list management (separate `email_unsubscribes` table).
- Send scheduling / throttling (sending rate per domain).

### 1.4 Non-goals (Phase 1)

- Email open/click analytics.
- A/B testing of templates.
- Email sending provider (SES/Postmark/Mailgun) adapter — N01 uses nodemailer + SMTP; provider adapter is N01 Phase 2.
- DMARC monitoring / aggregate reporting ingestion.
- WYSIWYG drag-and-drop email builder (Phase 3 if needed).

---

## 2. Schema

### 2.1 `email_templates` table

```prisma
// N02 — Email template system
// Phase 1: system notification templates (7 categories, English).
// Phase 3: marketing/blast templates.

model EmailTemplate {
  id          BigInt   @id @default(autoincrement())
  tenantId    BigInt   @default(1) @map("tenant_id")
  category    String   @db.VarChar(64)
  lang        String   @default("en") @db.VarChar(10)
  subject     String   @db.VarChar(255)
  htmlBody    String   @map("html_body") @db.MediumText
  textBody    String   @map("text_body") @db.MediumText
  active      Boolean  @default(true)
  version     Int      @default(1) @db.SmallInt
  createdAt   DateTime @default(now()) @map("created_at") @db.DateTime(6)
  updatedAt   DateTime @updatedAt @map("updated_at") @db.DateTime(6)

  tenant   Tenant                 @relation(fields: [tenantId], references: [id], onDelete: Restrict, onUpdate: NoAction, map: "fk_email_tpl_tenant")
  versions EmailTemplateVersion[]

  @@unique([tenantId, category, lang], map: "uk_email_tpl_t_cat_lang")
  @@index([tenantId, active, category], map: "idx_email_tpl_t_active_cat")
  @@map("email_templates")
}
```

Design notes:

- The `@@unique([tenantId, category, lang])` constraint enforces at most one active template per category+lang combination per tenant. To provide language fallback, the service layer does a second lookup rather than enforcing it at the DB level.
- `version` is a monotonically incrementing integer per `(tenantId, category, lang)` triplet, bumped on every PATCH that changes `subject`, `htmlBody`, or `textBody`. Managed by the service layer (not a DB trigger) to stay consistent with S03.
- `active` allows soft-deletion without losing the version history. Deleting via the API sets `active = false`.

### 2.2 `email_template_versions` table

```prisma
// N02 — Version history for email templates.
// Keeps last 10 versions per (tenantId, category, lang); oldest pruned on version bump.

model EmailTemplateVersion {
  id         BigInt   @id @default(autoincrement())
  tenantId   BigInt   @map("tenant_id")
  templateId BigInt   @map("template_id")
  version    Int      @db.SmallInt
  subject    String   @db.VarChar(255)
  htmlBody   String   @map("html_body") @db.MediumText
  textBody   String   @map("text_body") @db.MediumText
  savedAt    DateTime @default(now()) @map("saved_at") @db.DateTime(6)

  tenant   Tenant        @relation(fields: [tenantId], references: [id], onDelete: Restrict, onUpdate: NoAction, map: "fk_email_tpl_ver_tenant")
  template EmailTemplate @relation(fields: [templateId], references: [id], onDelete: Cascade, onUpdate: NoAction, map: "fk_email_tpl_ver_tpl")

  @@unique([templateId, version], map: "uk_email_tpl_ver_id_v")
  @@index([tenantId, templateId], map: "idx_email_tpl_ver_t_tpl")
  @@map("email_template_versions")
}
```

### 2.3 `users` table amendment

N02 migration adds one column to `users`:

```sql
ALTER TABLE users
  ADD COLUMN preferred_lang VARCHAR(10) NOT NULL DEFAULT 'en'
    COMMENT 'BCP 47 language tag; used by email-delivery worker for template lookup';
```

Prisma model amendment in `User`:

```prisma
preferredLang String @default("en") @map("preferred_lang") @db.VarChar(10)
```

### 2.4 `Tenant` model relations amendment

Add to `Tenant` model:

```prisma
emailTemplates        EmailTemplate[]
emailTemplateVersions EmailTemplateVersion[]
```

---

## 3. Interpolation engine

### 3.1 Handlebars setup

File: `api/src/email-templates/handlebars.ts`

```typescript
import Handlebars from 'handlebars';
import { registerHelpers } from './helpers.js';

// Singleton compiled-environment; no prototype pollution.
const hbs = Handlebars.create();
registerHelpers(hbs);

// noEscape: false — Handlebars HTML-escapes {{var}} by default (safe).
// Use {{{var}}} triple-stash only for pre-sanitized HTML fragments.
export { hbs };
```

The environment is created with `Handlebars.create()` (isolated instance, not the global singleton) to prevent prototype pollution between requests.

### 3.2 Helper implementations

File: `api/src/email-templates/helpers.ts`

```typescript
import { format } from 'date-fns';
import { parsePhoneNumber } from 'libphonenumber-js/min';

export function registerHelpers(hbs: typeof Handlebars): void {
  hbs.registerHelper('formatDate', (iso8601: string, fmt: string) => {
    if (!iso8601) return '';
    return format(new Date(iso8601), fmt ?? 'MMMM d, yyyy h:mm a');
  });

  hbs.registerHelper('phoneFormat', (e164: string) => {
    if (!e164) return '';
    try { return parsePhoneNumber(e164, 'US').formatNational(); }
    catch { return e164; }
  });

  hbs.registerHelper('ifEq', function (a, b, opts) {
    return a === b ? opts.fn(this) : opts.inverse(this);
  });

  hbs.registerHelper('upper', (str: string) =>
    typeof str === 'string' ? str.toUpperCase() : '');

  hbs.registerHelper('truncate', (str: string, len: number) => {
    if (typeof str !== 'string') return '';
    return str.length <= len ? str : str.slice(0, len) + '…';
  });
}
```

### 3.3 Safety rules

- Template compilation is done inside a `try/catch`; a compilation error returns `{ error: 'template_compile_error', detail: string }` from the preview endpoint and triggers a Pino error log + Prometheus counter `vici2_n02_render_error_total`.
- Handlebars `strict: true` mode is **not used** because missing variables should silently resolve to `""` rather than throw (same behavior as S03 render mode for unknown tokens).
- The `noEscape` option is `false` — all `{{variable}}` expressions are HTML-escaped by Handlebars. Only the pre-sanitized HTML layout uses `{{{body}}}` triple-stash (this is only in seed templates, not user input).

---

## 4. Variable vocabulary (FROZEN per category)

The variable context object passed to `renderEmail()` is typed. Unknown properties are ignored. Each category has a specific context type. Any addition to a category's vocabulary requires an RFC against N02.

### 4.1 Context types

```typescript
// api/src/email-templates/variables.ts

export interface BaseEmailContext {
  user: {
    name: string;           // user.fullName ?? user.username
    email: string;          // user.email
    role: string;           // user.role
  };
  tenant: {
    name: string;           // tenant.name
  };
}

export interface CallbackDueContext extends BaseEmailContext {
  callback: {
    leadName: string;       // lead.firstName + ' ' + lead.lastName
    leadPhone: string;      // lead.phoneE164 (use {{phoneFormat callback.leadPhone}})
    scheduledAtLocal: string; // ISO 8601 with tz offset (use {{formatDate ...}})
    link: string;           // absolute URL to /callbacks?id=<id>
    notes: string;          // callback.notes ?? ''
  };
}

export interface CallbackUpcomingContext extends BaseEmailContext {
  callback: {
    leadName: string;
    leadPhone: string;
    scheduledAtLocal: string;
    minutesUntilDue: number; // e.g. 15
    link: string;
  };
}

export interface ImportCompleteContext extends BaseEmailContext {
  import: {
    fileName: string;
    listName: string;
    rowsImported: number;
    rowsSkipped: number;
    rowsFailed: number;
    completedAt: string;    // ISO 8601
    link: string;           // absolute URL to /admin/lists/<id>
  };
}

export interface ImportFailedContext extends BaseEmailContext {
  import: {
    fileName: string;
    listName: string;
    errorSummary: string;   // first 500 chars of error message
    failedAt: string;
    link: string;
  };
}

export interface RecordingFailedContext extends BaseEmailContext {
  recording: {
    callUuid: string;
    failedAt: string;
    reason: string;
  };
}

export interface AgentDisconnectedContext extends BaseEmailContext {
  agent: {
    name: string;           // the disconnected agent's name
    disconnectedAt: string;
    callUuid: string | null;
  };
}

export interface DropGateEngagedContext extends BaseEmailContext {
  dropGate: {
    campaignName: string;
    engagedAt: string;
    dropRate: number;       // percentage e.g. 4.2
    threshold: number;      // configured threshold e.g. 3.0
  };
}

export type EmailContext =
  | CallbackDueContext
  | CallbackUpcomingContext
  | ImportCompleteContext
  | ImportFailedContext
  | RecordingFailedContext
  | AgentDisconnectedContext
  | DropGateEngagedContext;
```

### 4.2 Context by category (quick reference)

| Category | Top-level keys | Notable variables |
|---|---|---|
| `callback_due` | `user`, `tenant`, `callback` | `{{callback.leadName}}`, `{{callback.link}}`, `{{formatDate callback.scheduledAtLocal "PPpp"}}` |
| `callback_upcoming` | `user`, `tenant`, `callback` | `{{callback.minutesUntilDue}}`, `{{callback.link}}` |
| `import_complete` | `user`, `tenant`, `import` | `{{import.rowsImported}}`, `{{import.rowsSkipped}}`, `{{import.link}}` |
| `import_failed` | `user`, `tenant`, `import` | `{{import.errorSummary}}`, `{{import.link}}` |
| `recording_failed` | `user`, `tenant`, `recording` | `{{recording.callUuid}}`, `{{recording.reason}}` |
| `agent_disconnected` | `user`, `tenant`, `agent` | `{{agent.name}}`, `{{agent.callUuid}}` |
| `drop_gate_engaged` | `user`, `tenant`, `dropGate` | `{{dropGate.campaignName}}`, `{{dropGate.dropRate}}`, `{{dropGate.threshold}}` |

---

## 5. HTML sanitization

File: `api/src/email-templates/sanitize.ts`

Reuses and extends S03's sanitize-html configuration. The extension adds email-specific tags.

```typescript
import sanitizeHtml from 'sanitize-html';

const EMAIL_ALLOWED_TAGS = [
  // S03 base
  'p', 'br', 'strong', 'em', 'u', 's', 'ul', 'ol', 'li',
  'h1', 'h2', 'h3', 'h4', 'blockquote', 'a', 'span', 'div',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr',
  // N02 email extensions
  'img', 'center', 'font',
];

const EMAIL_ALLOWED_ATTRIBUTES: sanitizeHtml.IOptions['allowedAttributes'] = {
  // S03 base
  '*': ['class', 'id'],
  'a': ['href', 'target', 'rel'],
  // N02 email extensions
  'img': ['src', 'alt', 'width', 'height', 'border', 'style'],
  'table': ['align', 'valign', 'cellpadding', 'cellspacing', 'border', 'bgcolor', 'width', 'height'],
  'td': ['align', 'valign', 'bgcolor', 'width', 'height', 'colspan', 'rowspan'],
  'th': ['align', 'valign', 'bgcolor', 'width', 'height', 'colspan', 'rowspan'],
  'font': ['color', 'face', 'size'],
};

const EMAIL_ALLOWED_SCHEMES = ['http', 'https', 'mailto'];

export function sanitizeEmailHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: EMAIL_ALLOWED_TAGS,
    allowedAttributes: EMAIL_ALLOWED_ATTRIBUTES,
    allowedSchemes: EMAIL_ALLOWED_SCHEMES,
    // Block data: URLs in img src
    allowedSchemesByTag: { img: ['https'] },
    // Block on* event handlers
    disallowedTagsMode: 'discard',
    allowVulnerableTags: false,
  });
}
```

Sanitization runs:

1. On `POST` (create) — `htmlBody` is sanitized before storage.
2. On `PATCH` (update) — `htmlBody` is sanitized before storage.
3. On `renderEmail()` — sanitization runs again on the rendered output (defense-in-depth, in case a template stored before a sanitize-rule tightening is fetched).

---

## 6. Plain text auto-generation

File: `api/src/email-templates/to-text.ts`

```typescript
import { convert } from 'html-to-text';

export function htmlToText(html: string): string {
  return convert(html, {
    wordwrap: 76,
    selectors: [
      { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
      { selector: 'img', format: 'skip' },
      {
        selector: 'table',
        options: { uppercaseHeaderCells: false, maxColumnWidth: 40 }
      },
    ],
  });
}
```

Trigger logic in the service layer:

```typescript
// In service.ts patchTemplate()
if (body.htmlBody !== undefined && body.textBody === undefined) {
  // Admin changed HTML but did not provide explicit text — auto-regenerate
  data.textBody = htmlToText(sanitizeEmailHtml(body.htmlBody));
}
```

If the admin provides both `htmlBody` and `textBody` in the PATCH body, the explicit `textBody` is stored as-is (no auto-generation override).

---

## 7. `renderEmail()` service function

File: `api/src/email-templates/service.ts`

```typescript
export interface RenderEmailResult {
  subject: string;
  html: string;
  text: string;
}

export async function renderEmail(
  prisma: PrismaClient,
  tenantId: bigint,
  category: string,
  lang: string,
  vars: Record<string, unknown>,
): Promise<RenderEmailResult>
```

Implementation steps:

1. Look up `email_templates` WHERE `tenant_id = tenantId AND category = category AND lang = lang AND active = true`. If not found and `lang !== 'en'`, retry with `lang = 'en'`. If still not found, throw `TemplateNotFoundError` (which causes the email-delivery worker to use a hard-coded fallback).
2. Compile `subject` template: `hbs.compile(template.subject)(vars)`.
3. Compile `htmlBody` template: `const rendered = hbs.compile(template.htmlBody)(vars)`.
4. Sanitize rendered HTML: `const html = sanitizeEmailHtml(rendered)`.
5. Compile `textBody` template: `const text = hbs.compile(template.textBody)(vars)`.
6. Return `{ subject, html, text }`.

Hard-coded fallback (used when `TemplateNotFoundError` is thrown by the worker):

```typescript
// workers/src/jobs/email-delivery/processor.ts
try {
  const { subject, html, text } = await renderEmail(...);
  await mailer.send({ to, subject, html, text });
} catch (err) {
  if (err instanceof TemplateNotFoundError) {
    // Fall back to plain-text body from notification row
    await mailer.send({ to, subject: job.data.subject, text: job.data.body });
  } else {
    throw err; // let BullMQ retry
  }
}
```

---

## 8. Seed: 7 default templates

File: `api/prisma/seed.ts` (append after existing seeds)

One template per category for `lang: 'en'`, `tenant_id: 1`.

### 8.1 Template: `callback_due`

**Subject:** `Action required: Callback due — {{callback.leadName}}`

**HTML body** (MJML-compiled, abbreviated):
```html
<!-- Mobile-responsive table layout compiled from MJML -->
<table cellpadding="0" cellspacing="0" width="100%">
  <tr><td>
    <h2>Callback Due Now</h2>
    <p>Hi {{user.name}},</p>
    <p>Your scheduled callback with <strong>{{callback.leadName}}</strong>
       ({{phoneFormat callback.leadPhone}}) is due.</p>
    <p>Scheduled: {{formatDate callback.scheduledAtLocal "MMMM d, yyyy 'at' h:mm a"}}</p>
    {{#if callback.notes}}<p>Notes: {{callback.notes}}</p>{{/if}}
    <p><a href="{{callback.link}}">View Callback</a></p>
    <hr>
    <p style="font-size:12px;color:#666;">
      {{tenant.name}} — To manage your notification preferences,
      <a href="{{{unsubscribeUrl}}}">click here</a>.
    </p>
  </td></tr>
</table>
```

**Text body** (auto-generated from HTML, then stored):
```
CALLBACK DUE NOW
================

Hi {{user.name}},

Your scheduled callback with {{callback.leadName}}
({{phoneFormat callback.leadPhone}}) is due.

Scheduled: {{formatDate callback.scheduledAtLocal "MMMM d, yyyy 'at' h:mm a"}}

{{#if callback.notes}}Notes: {{callback.notes}}{{/if}}

View Callback: {{callback.link}}

--
{{tenant.name}}
To manage your notification preferences: {{{unsubscribeUrl}}}
```

### 8.2 Template subjects by category (abbreviated)

| Category | Subject line |
|---|---|
| `callback_due` | `Action required: Callback due — {{callback.leadName}}` |
| `callback_upcoming` | `Reminder: Callback in {{callback.minutesUntilDue}} minutes — {{callback.leadName}}` |
| `import_complete` | `Import complete: {{import.fileName}} — {{import.rowsImported}} rows` |
| `import_failed` | `Import failed: {{import.fileName}} — action required` |
| `recording_failed` | `Recording failed for call {{recording.callUuid}}` |
| `agent_disconnected` | `Agent disconnected: {{agent.name}} at {{formatDate agent.disconnectedAt "h:mm a"}}` |
| `drop_gate_engaged` | `Drop gate engaged: {{dropGate.campaignName}} ({{dropGate.dropRate}}% drop rate)` |

Full HTML + text bodies for all 7 categories are in `api/prisma/email-template-seeds/` as individual `.html` and `.txt` files, imported by `seed.ts`.

---

## 9. API endpoints

All endpoints under `/api/admin/email-templates`. All require `requireAuth`.

### 9.1 GET /api/admin/email-templates

```
Query: ?category=<string>, ?lang=<string>, ?active=true|false|all (default=true)
RBAC: email_templates:read
Response: {
  items: EmailTemplateDto[],
  total: number
}
```

`EmailTemplateDto`: `{ id, tenantId, category, lang, subject, htmlBody, textBody, active, version, createdAt, updatedAt }` — all fields except the body may be requested without the body via `?fields=no-body` for list views (bodies can be large).

### 9.2 POST /api/admin/email-templates

```
RBAC: email_templates:edit
Body: { category, lang?, subject, htmlBody, textBody? }
Response: EmailTemplateDto (201)
```

- `lang` defaults to `"en"`.
- `textBody` optional: if absent, auto-generated from `htmlBody` via `htmlToText()`.
- Rejects if `(tenantId, category, lang)` unique constraint would be violated (409 Conflict).
- Runs HTML sanitize before storage.
- Writes `audit_log` row: action `email_template.created`.

### 9.3 GET /api/admin/email-templates/:id

```
RBAC: email_templates:read
Response: EmailTemplateDto (200) or 404
```

Tenant-scoped: `WHERE tenant_id = req.auth.tenantId AND id = :id`.

### 9.4 PATCH /api/admin/email-templates/:id

```
RBAC: email_templates:edit
Body: { subject?, htmlBody?, textBody?, active? } (partial update)
Response: EmailTemplateDto (200)
```

Version bump: if `subject`, `htmlBody`, or `textBody` changes, the current row is snapshotted into `email_template_versions`, then `version` is incremented. Version history is pruned to the latest 10 in the same transaction (delete WHERE `templateId = id ORDER BY version ASC LIMIT MAX(0, count - 10)`).

Auto-generate `textBody` if `htmlBody` is present in the PATCH body and `textBody` is absent.

Writes `audit_log` row: action `email_template.updated`.

### 9.5 DELETE /api/admin/email-templates/:id

```
RBAC: email_templates:edit
Response: 204
```

Soft-delete: sets `active = false`. Does not destroy version history. A subsequent `POST` with the same `(category, lang)` will fail because the unique constraint includes the inactive row — the admin must first PATCH `active: true` or hard-delete via a separate endpoint (not in Phase 1 API). Hard-delete is admin-only and is deferred to Phase 2.

Writes `audit_log` row: action `email_template.deleted`.

### 9.6 POST /api/admin/email-templates/:id/preview

```
RBAC: email_templates:read
Body: { sample_vars: Record<string, unknown> }
Response: { subject: string, html: string, text: string, missingVars: string[] }
```

Preview mode: unknown `{{var}}` tokens are **not replaced with `""`** but instead replaced with a highlighted placeholder `<span class="n02-missing-var">[MISSING: var]</span>` in the HTML and `[MISSING: var]` in the text. The response includes a `missingVars` array listing all detected missing variable paths.

The preview endpoint does **not** send any email. It is safe to call repeatedly. Not rate-limited (admin usage only).

### 9.7 POST /api/admin/email-templates/:id/test-send

```
RBAC: email_templates:edit
Body: { to: string, sample_vars: Record<string, unknown> }
Response: { queued: true, jobId: string } (202)
```

- Validates `to` as a valid email address (Zod `z.string().email()`).
- Rate-limited: 5 test-sends per `(tenantId, userId)` per hour via Valkey counter key `t:{tid}:n02:test_send_rate:{uid}` (TTL 3600 s).
- Enqueues a BullMQ job on `vici2:queue:email-delivery` with `isTestSend: true`. Worker ignores notification_prefs check for test-sends and does not create a `notifications` row.
- Uses the template's rendered output (preview mode: missing vars become `[MISSING: var]`).
- Writes `audit_log` row: action `email_template.test_sent` (for tracking who is test-sending to which address).

### 9.8 GET /api/admin/email-templates/:id/versions

```
RBAC: email_templates:read
Response: { versions: EmailTemplateVersionDto[] } — max 10
```

`EmailTemplateVersionDto`: `{ id, version, subject, htmlBody, textBody, savedAt }`.

---

## 10. N01 email-delivery worker integration

File: `workers/src/jobs/email-delivery/processor.ts`

Current behavior (N01 Phase 1):
```typescript
await mailer.send({ to: job.data.to, subject: job.data.subject, text: job.data.body });
```

N02 behavior (replace the above):
```typescript
import { renderEmail, TemplateNotFoundError } from '../../../api/email-templates/service.js';

const lang = job.data.userPreferredLang ?? 'en';
let subject: string, html: string, text: string;

try {
  ({ subject, html, text } = await renderEmail(
    prisma, BigInt(job.data.tenantId), job.data.category, lang, job.data.vars
  ));
} catch (err) {
  if (err instanceof TemplateNotFoundError) {
    // Hard-coded fallback: plain text from notification row
    subject = job.data.subject;
    html = undefined;
    text = job.data.body;
  } else {
    throw err; // let BullMQ retry
  }
}

await mailer.send({ to: job.data.to, subject, html, text });
```

The BullMQ job payload is **extended** (backwards-compatible; old fields remain):

```typescript
interface EmailJob {
  // Existing N01 fields (unchanged)
  notificationId: string;
  tenantId: string;
  userId: string;
  to: string;
  subject: string;    // kept as fallback if template not found
  body: string;       // kept as fallback plain text
  idempotencyKey: string;
  // New N02 fields
  category: string;
  vars: Record<string, unknown>;
  userPreferredLang: string;
  isTestSend?: boolean;
}
```

The N01 `service.ts` `enqueueEmail()` function is updated to include `category`, `vars`, and `userPreferredLang`. The `vars` object is built from the `notify()` params by a new helper `buildEmailVars(category, notifyParams, user, tenant)`.

---

## 11. List-Unsubscribe implementation

File: `api/src/email-templates/unsubscribe.ts`

### 11.1 Token generation

```typescript
import { createHmac } from 'crypto';

const EXPIRY_DAYS = 90;

export function generateUnsubscribeToken(
  userId: bigint,
  category: string,
): string {
  const expiresAt = Math.floor(Date.now() / 1000) + EXPIRY_DAYS * 86400;
  const message = `${userId}:${category}:${expiresAt}`;
  const sig = createHmac('sha256', process.env.VICI2_NOTIFICATION_UNSUBSCRIBE_SECRET!)
    .update(message).digest('hex');
  return Buffer.from(JSON.stringify({ userId: String(userId), category, expiresAt, sig }))
    .toString('base64url');
}

export function verifyUnsubscribeToken(token: string): {
  userId: bigint; category: string;
} | null {
  // decode + verify HMAC + check expiry
}
```

### 11.2 Unsubscribe endpoint

`GET /api/notifications/unsubscribe?token=<base64url>`

- Public route (no auth required — the token carries identity).
- Verifies HMAC and expiry.
- Upserts `notification_prefs` for `(userId, category)` to `channels: ["in_app"]` (removes email).
- Returns a simple HTML confirmation page (`200 text/html`): "You have been unsubscribed from [category] email notifications."
- Writes `audit_log` row: action `notification_prefs.email_unsubscribed`.

### 11.3 Headers added by mailer

```typescript
// workers/src/jobs/email-delivery/mailer.ts
const unsubscribeUrl = `${BASE_URL}/api/notifications/unsubscribe?token=${token}`;
mailOptions.headers = {
  'List-Unsubscribe': `<${unsubscribeUrl}>`,
  'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
};
```

`BASE_URL` comes from env var `VICI2_APP_BASE_URL` (already in `.env.example` from other modules). `VICI2_NOTIFICATION_UNSUBSCRIBE_SECRET` is a new env var (32 random bytes, base64).

---

## 12. RBAC

New permission verbs added to `shared/types/src/rbac.ts`:

```typescript
'email_templates:read',   // view templates + versions; preview
'email_templates:edit',   // create, update, delete, test-send
```

Role matrix:

| Role | `email_templates:read` | `email_templates:edit` |
|---|---|---|
| `super_admin` | Yes | Yes |
| `admin` | Yes | Yes |
| `supervisor` | Yes | No |
| `agent` | No | No |
| `viewer` | No | No |
| `integrator` | No | No |

---

## 13. Audit log entries

Every write action calls C03's `AuditWriter` via the existing `audit()` helper (same pattern as S03 uses).

| Action string | Trigger | `entity_type` | `entity_id` | Includes `before_json` / `after_json` |
|---|---|---|---|---|
| `email_template.created` | POST /api/admin/email-templates | `email_template` | new template id | after_json = {category, lang, subject, version} |
| `email_template.updated` | PATCH /api/admin/email-templates/:id | `email_template` | template id | before = old {subject, version}, after = new |
| `email_template.deleted` | DELETE /api/admin/email-templates/:id | `email_template` | template id | before = {category, lang, active: true} |
| `email_template.test_sent` | POST /api/admin/email-templates/:id/test-send | `email_template` | template id | after_json = {to, category, lang} |
| `notification_prefs.email_unsubscribed` | GET /api/notifications/unsubscribe | `notification_pref` | userId | after_json = {category, channels: ["in_app"]} |

---

## 14. Admin UI

### 14.1 Route structure

```
web/src/app/(admin)/email-templates/
  page.tsx                         — EmailTemplateList
  new/
    page.tsx                       — EmailTemplateEdit (create mode)
  [id]/
    page.tsx                       — EmailTemplateEdit (edit mode)
```

### 14.2 EmailTemplateList page

Table columns: Category, Language, Subject (truncated), Active, Version, Last Updated, Actions (Edit, Test-send modal shortcut).

Filter controls: Category dropdown (all 7 + All), Language dropdown, Active toggle.

"New template" button → navigates to `/email-templates/new`.

### 14.3 EmailTemplateEdit page

Form fields:

| Field | Input | Constraints |
|---|---|---|
| Category | Select (enum from N01 `ALL_CATEGORIES`) | Required on create; locked on edit |
| Language | Text (BCP 47) | Default "en"; locked on edit |
| Subject | Text | Required, max 255 chars; Handlebars syntax highlighted |
| HTML body | Textarea (monospace) or split-pane with preview | MediumText; live preview |
| Text body | Textarea | Auto-populated from HTML on save; admin can override |
| Active | Checkbox | Default true |

**Variable reference sidebar**: lists the frozen vocabulary for the selected category (table: variable path → description). Clicking a variable inserts it at the cursor position in the active textarea.

**Live preview pane**: debounced 500 ms after any change to the HTML body, calls `POST /api/admin/email-templates/:id/preview` (or a stateless preview endpoint for the create flow) and renders the result in a sandboxed `<iframe srcdoc="...">` with `sandbox="allow-same-origin"` (no scripts).

**Missing vars indicator**: if the preview response includes `missingVars`, a yellow warning banner lists them.

### 14.4 Test-send modal

Opened from the Edit page or the List page "Test send" button.

Fields:
- `to` — email address input (required, validated)
- Sample vars — one text field per variable in the category's vocabulary, pre-filled with placeholder values

On submit: `POST /api/admin/email-templates/:id/test-send`. Shows a success toast with the BullMQ job ID or an error message.

### 14.5 Version history panel

Collapsible panel at the bottom of the Edit page. Lists the 10 most recent versions (version number, saved date). Clicking a version opens a modal showing `diff` between that version and the current (Phase 2; Phase 1 shows the version's subject + HTML body read-only).

### 14.6 Components

```
web/src/components/email-templates/
  EmailTemplateList.tsx      — client component: fetch + table + filters + pagination
  EmailTemplateForm.tsx      — client component: create/edit form + variable sidebar
  EmailTemplatePreview.tsx   — client component: sandboxed iframe preview
  TestSendModal.tsx          — client component: test-send dialog
  VersionHistoryPanel.tsx    — client component: version list (Phase 1: read-only)
```

---

## 15. Files to create

```
api/
  prisma/
    migrations/
      <timestamp>_n02_email_templates/
        migration.sql         — email_templates, email_template_versions tables +
                                users.preferred_lang column
    email-template-seeds/
      callback_due.html
      callback_due.txt
      callback_upcoming.html
      callback_upcoming.txt
      import_complete.html
      import_complete.txt
      import_failed.html
      import_failed.txt
      recording_failed.html
      recording_failed.txt
      agent_disconnected.html
      agent_disconnected.txt
      drop_gate_engaged.html
      drop_gate_engaged.txt
    seed.ts                   — append N02 seed section

  src/
    email-templates/
      handlebars.ts           — isolated Handlebars environment
      helpers.ts              — 5 registered safe helpers
      sanitize.ts             — sanitize-html wrapper (email allowlist)
      to-text.ts              — html-to-text wrapper
      variables.ts            — EmailContext types + category vocabulary
      service.ts              — renderEmail(), CRUD service functions
      unsubscribe.ts          — token generate/verify
      index.ts                — Fastify plugin: route registration
      handlers/
        list.ts
        get.ts
        create.ts
        update.ts
        delete.ts
        preview.ts
        test-send.ts
        versions.ts
        unsubscribe.ts        — GET /api/notifications/unsubscribe
      __tests__/
        render.test.ts        — golden fixture rendering per category
        sanitize.test.ts      — XSS + email-specific tag tests
        to-text.test.ts       — HTML-to-text conversion tests
        unsubscribe.test.ts   — token generate + verify tests

  shared/types/src/
    rbac.ts                   — append email_templates:read + email_templates:edit

workers/
  src/
    jobs/
      email-delivery/
        processor.ts          — update to call renderEmail() + fallback
        mailer.ts             — add List-Unsubscribe headers

web/
  src/
    app/
      (admin)/email-templates/
        page.tsx
        new/page.tsx
        [id]/page.tsx
    components/email-templates/
      EmailTemplateList.tsx
      EmailTemplateForm.tsx
      EmailTemplatePreview.tsx
      TestSendModal.tsx
      VersionHistoryPanel.tsx
```

### 15.1 Files modified (not created)

- `api/prisma/schema.prisma` — add `EmailTemplate`, `EmailTemplateVersion` models; add `preferredLang` to `User`; add relations to `Tenant`.
- `api/prisma/seed.ts` — append 7 template seed entries.
- `api/src/server.ts` — register `emailTemplatesPlugin`.
- `workers/src/jobs/email-delivery/processor.ts` — update job payload handling + call `renderEmail()`.
- `workers/src/jobs/email-delivery/mailer.ts` — add List-Unsubscribe headers.
- `shared/types/src/rbac.ts` — add 2 new permission verbs.
- `.env.example` — add `VICI2_NOTIFICATION_UNSUBSCRIBE_SECRET`.

---

## 16. Dependencies added

```
api/:
  handlebars            — ^4.7.8  (Handlebars templating engine)
  html-to-text          — ^9.0.5  (HTML to plain text conversion)
  # sanitize-html already added by S03

api/ devDependencies:
  @types/handlebars     — (if needed; Handlebars ships its own types in v4.7+)
```

No new web dependencies: the preview iframe uses `srcdoc` with no additional libraries.

---

## 17. Env vars added

```bash
# N02 — Email template system
# HMAC secret for one-click unsubscribe tokens (32 random bytes, base64)
VICI2_NOTIFICATION_UNSUBSCRIBE_SECRET=<openssl rand -base64 32>
```

Already-present env vars consumed by N02:

- `VICI2_APP_BASE_URL` — used to build absolute unsubscribe URLs.
- `VICI2_SMTP_*` — owned by N01; N02 worker extension uses them unchanged.

---

## 18. Test plan

### 18.1 Unit tests (vitest)

File: `api/src/email-templates/__tests__/render.test.ts` — golden fixture tests.

- `renderEmail('callback_due', 'en', callbackDueVars)` → subject matches golden, HTML contains `"Callback Due Now"`, text contains `"callback"`.
- `renderEmail('import_complete', 'en', importVars)` → `import.rowsImported` appears in output.
- Unknown `lang` `"de"` with no German template → falls back to `"en"` template without error.
- `lang = "en"` missing entirely from DB (simulated) → throws `TemplateNotFoundError`.
- Handlebars missing var → resolves to `""` (non-strict mode).
- `formatDate` helper: ISO 8601 → correctly formatted local date string.
- `phoneFormat` helper: `+15551234567` → `"(555) 123-4567"`.
- `ifEq` helper: renders truthy branch when values equal, falsy branch otherwise.
- `truncate` helper: string > `n` chars gets ellipsis.

File: `api/src/email-templates/__tests__/sanitize.test.ts`

- `<script>alert(1)</script>` → empty string.
- `<img onerror="alert(1)" src="https://example.com/logo.png">` → `onerror` stripped, `src` retained.
- `<img src="data:image/png;base64,...">` → `src` stripped entirely (data: scheme not allowed for img).
- `<a href="javascript:void(0)">` → `href` stripped.
- `<table bgcolor="#fff" cellpadding="8">` → both attributes retained.
- `<font color="red">text</font>` → retained (Outlook compat).
- `<iframe src="...">` → stripped.
- `<center>` → retained.

File: `api/src/email-templates/__tests__/to-text.test.ts`

- `<p>Hello <strong>World</strong></p>` → `"Hello World"` (bold stripped, text preserved).
- `<a href="https://example.com">Click here</a>` → `"Click here [https://example.com]"` (link appended since text ≠ href).
- `<a href="https://example.com">https://example.com</a>` → `"https://example.com"` (hideLinkHrefIfSameAsText).
- `<img src="https://example.com/logo.png" alt="Logo">` → skipped (not in output).
- Long paragraph wraps at 76 chars.

File: `api/src/email-templates/__tests__/unsubscribe.test.ts`

- `generateUnsubscribeToken(1n, 'callback_due')` produces a decodable base64url token.
- `verifyUnsubscribeToken(validToken)` returns `{ userId: 1n, category: 'callback_due' }`.
- `verifyUnsubscribeToken(expiredToken)` returns `null`.
- `verifyUnsubscribeToken(tamperedSig)` returns `null`.

### 18.2 Integration tests (vitest + test DB)

- `POST /api/admin/email-templates` → 201, row exists in DB.
- `PATCH /api/admin/email-templates/:id` (change htmlBody) → version bumped, `email_template_versions` row created.
- `PATCH` with 11 saves → exactly 10 versions retained (oldest pruned).
- `GET /api/admin/email-templates/:id/versions` → returns max 10 items.
- `DELETE /api/admin/email-templates/:id` → sets `active = false`; subsequent GET returns 404.
- `POST /api/admin/email-templates/:id/preview` with `sample_vars` → HTML contains interpolated values; `missingVars` array is empty when all vars provided.
- RBAC: `supervisor` can call `GET` but gets 403 on `POST`; `admin` can call both.
- Audit log: `POST` creates `email_template.created` row in `audit_log`.
- `GET /api/notifications/unsubscribe?token=<valid>` → `notification_prefs` row updated; 200 HTML response.
- `GET /api/notifications/unsubscribe?token=<expired>` → 400.

### 18.3 Worker integration test

- Email-delivery processor with N02: mock `renderEmail()` returning `{ subject, html, text }` → nodemailer `sendMail` called with `html` and `text` parts.
- Email-delivery processor when `TemplateNotFoundError` thrown → falls back to `job.data.body` (plain text), nodemailer called without `html`.
- Test-send job with `isTestSend: true` → no `notifications` row created, email sent to `job.data.to`.

---

## 19. Acceptance criteria

- [ ] `pnpm typecheck` passes in `api/`, `workers/`, `web/`.
- [ ] `pnpm lint` clean.
- [ ] `pnpm test` in `api/` — all N02 test files pass (render, sanitize, to-text, unsubscribe, integration).
- [ ] `pnpm test` in `workers/` — email-delivery processor tests pass with N02 integration.
- [ ] `GET /api/admin/email-templates` returns 200 with 7 seeded templates.
- [ ] `POST /api/admin/email-templates/:id/preview` returns rendered HTML with interpolated `callback.leadName`.
- [ ] `PATCH /api/admin/email-templates/:id` bumps version; `GET /:id/versions` shows new entry.
- [ ] 11 PATCHes to the same template → `GET /:id/versions` returns exactly 10.
- [ ] `POST /api/admin/email-templates/:id/test-send` enqueues a BullMQ job; SMTP sendMail is called in the test environment.
- [ ] 6th test-send within 1 hour returns 429 Too Many Requests.
- [ ] `<script>alert(1)</script>` in `htmlBody` is stripped before storage.
- [ ] `<img src="data:...">` is stripped; `<img src="https://...">` is retained.
- [ ] Email-delivery worker calls `renderEmail()` for N01 categories; on `TemplateNotFoundError` falls back to plain text.
- [ ] N01 notify() for `import_complete` enqueues email job with `category='import_complete'` and `vars` including `import.rowsImported`.
- [ ] Supervisor: `GET /api/admin/email-templates` → 200; `POST` → 403.
- [ ] Every `POST`/`PATCH`/`DELETE` creates an `audit_log` entry with correct action string.
- [ ] `GET /api/notifications/unsubscribe?token=<valid>` updates `notification_prefs`; confirmation page rendered.
- [ ] Nodemailer `sendMail` includes `List-Unsubscribe` and `List-Unsubscribe-Post` headers.
- [ ] Admin UI: email-templates list page loads; edit page shows live preview iframe; test-send modal sends successfully.

---

## 20. Dependencies and risks

### 20.1 Hard dependencies

| Module | What N02 needs | Status |
|---|---|---|
| N01 | `vici2:queue:email-delivery` BullMQ queue exists; `EmailJob` type extended | N01 is IMPLEMENTING; N02 extends its worker payload (backwards-compatible) |
| S03 | `sanitize-html` already installed in `api/`; sanitize pattern established | IMPLEMENTING |
| F05 | `requireAuth`, `requirePermission` middlewares; User model with `email` field | IMPLEMENTED |
| F02 | `audit_log`, `users`, `tenants` tables; C03 `audit()` helper pattern | DONE |
| C03 | `AuditWriter` / `audit()` helper signature | PLAN-stable |

### 20.2 Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **N01 email-delivery worker payload change breaks existing jobs** | Low | Medium | New fields are optional; old job payloads without `category`/`vars` fall back to `body` string. Backwards-compatible. |
| **Handlebars compile errors from malformed admin-authored templates** | Medium | Low | Compile errors caught in `try/catch`; preview endpoint returns error detail; render path falls back to plain-text body. |
| **`html-to-text` produces unreadable plain text for complex MJML-compiled HTML** | Medium | Low | Seed templates verified manually; admin can always override `textBody` explicitly. |
| **List-Unsubscribe HMAC secret rotation invalidates outstanding links** | Low | Low | Links are 90-day TTL; rotation procedure documented in operator runbook. |
| **`users.preferred_lang` column migration requires downtime** | Low | Medium | Column is `NOT NULL DEFAULT 'en'`; MySQL can add it with instant algorithm on InnoDB (no table rebuild). |
| **Gmail 102 KB clip for large HTML templates** | Low | Low | Seed templates are < 30 KB. Add UI warning (Phase 2) if admin-edited body exceeds 90 KB. |
| **Test-send rate limit (5/hour) too restrictive during initial setup** | Low | Low | Rate limit is per-user-per-hour; during setup multiple admins can test. Limit configurable via env var `VICI2_N02_TEST_SEND_RATE_LIMIT` (default 5). |

---

*End of N02 PLAN — spec/modules/N02/PLAN.md*
