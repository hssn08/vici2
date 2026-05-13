# Module S03 — Agent Script Management — PLAN

**Module:** S03 (Script track, Phase 1)
**Author:** S03 IMPLEMENT agent (Claude Sonnet 4.6)
**Date:** 2026-05-13
**Status:** PROPOSED — implementation in progress.
**Companion:** This file — architecture + decision record.

**Depends on (modules already present in main):**
- F02 PLAN/IMPLEMENT — `scripts` table in schema.prisma (§4.11); `Script` model with `body`, `name`, `campaignId`, `tenantId`, `createdAt`, `updatedAt`
- F05 — JWT auth middleware, `requireAuth`, `requirePermission`, RBAC verbs `script:read` / `script:edit` already in `shared/types/src/rbac.ts`
- M01 — Admin Next.js skeleton; admin route conventions at `/api/admin/*`; `UserTable` / `UserForm` UI pattern
- D01 — Lead model fields: `firstName`, `lastName`, `phoneE164`, `email`, `city`, `state`, `customData` (JSON)
- A05 — Center panel "Script" tab; `GET /api/agent/script/:campaign_id?lead_id=...` contract declared in A05 PLAN §10

**Blocks:**
- A05 IMPLEMENT (Script tab needs real rendered HTML)

---

## 0. TL;DR — 12 decisions

1. **Schema amendment**: add `version SMALLINT DEFAULT 1` + `active BOOLEAN DEFAULT TRUE` + `variables JSON` to `scripts` table via Prisma migration; add new `script_versions` table to keep last 10 versions.
2. **Frozen variable vocabulary**: `{lead.first_name}`, `{lead.last_name}`, `{lead.phone_formatted}`, `{lead.email}`, `{lead.city}`, `{lead.state}`, `{lead.custom.X}`, `{agent.name}`, `{campaign.name}`, `{call.duration}`. Any unknown token is left as-is (safe default).
3. **Server-side interpolation**: regex-replace `{token}` → value; unknown tokens replaced with `""` in render endpoint, preserved in preview endpoint.
4. **XSS safety**: `sanitize-html` (server-only npm package) with an explicit allowed-tag + allowed-attribute safelist; DOMPurify not used server-side (browser-only).
5. **Versioning**: every PATCH that changes `body` or `name` bumps `version` and writes a `script_versions` row; oldest versions beyond 10 are pruned in the same transaction.
6. **API surface**: 8 endpoints under `/api/admin/scripts` (CRUD + render + versions) + 1 agent endpoint `/api/agent/script/:campaignId`.
7. **RBAC**: `script:read` → agents + supervisors + admin; `script:edit` → admin + super_admin only.
8. **Seed**: 3 starter templates seeded in `prisma/seed.ts` under tenant 1.
9. **Admin UI**: 3 pages — list (`/admin/scripts`), edit/create (`/admin/scripts/[id]`, `/admin/scripts/new`), preview (`/admin/scripts/[id]/preview`). Simple `<textarea>` with live sanitized preview iframe. No TipTap WYSIWYG in Phase 1.
10. **A05 integration**: `ScriptTab.tsx` calls `GET /api/agent/script/:campaignId?lead_id=...&call_uuid=...`; renders via `dangerouslySetInnerHTML` (server already sanitized); polls never — fires once on `call.bridged`.
11. **Tests**: vitest unit tests for interpolation engine (edge cases: unknown token, `{lead.custom.key}`, empty lead), XSS sanitization, RBAC check logic. No DB integration tests (no DB in CI).
12. **No push, no merge**: this plan is self-contained; no RFC needed per orchestrator.

---

## 1. Schema changes (Prisma migration)

### 1.1 `scripts` table additions

```prisma
model Script {
  id         BigInt   @id @default(autoincrement())
  tenantId   BigInt   @default(1) @map("tenant_id")
  name       String   @db.VarChar(64)
  body       String   @db.MediumText
  campaignId String?  @map("campaign_id") @db.VarChar(32)
  active     Boolean  @default(true)
  version    Int      @default(1) @db.SmallInt
  variables  Json     @default("[]") // declarative registry [{name,description}]
  createdAt  DateTime @default(now()) @map("created_at") @db.DateTime(6)
  updatedAt  DateTime @updatedAt @map("updated_at") @db.DateTime(6)

  tenant    Tenant          @relation(...)
  campaign  Campaign?       @relation(...)
  campaigns Campaign[]
  versions  ScriptVersion[]

  @@index([tenantId, campaignId], map: "idx_scripts_t_camp")
  @@index([tenantId, active], map: "idx_scripts_t_active")
  @@map("scripts")
}
```

### 1.2 `script_versions` table (new)

```prisma
model ScriptVersion {
  id        BigInt   @id @default(autoincrement())
  tenantId  BigInt   @map("tenant_id")
  scriptId  BigInt   @map("script_id")
  version   Int      @db.SmallInt
  name      String   @db.VarChar(64)
  body      String   @db.MediumText
  variables Json     @default("[]")
  savedAt   DateTime @default(now()) @map("saved_at") @db.DateTime(6)

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Restrict)
  script Script @relation(fields: [scriptId], references: [id], onDelete: Cascade)

  @@unique([scriptId, version], map: "uk_script_versions_id_v")
  @@index([tenantId, scriptId], map: "idx_script_versions_t_s")
  @@map("script_versions")
}
```

---

## 2. Variable interpolation engine

File: `api/src/scripts/interpolate.ts`

**Token format**: `{namespace.key}` or `{namespace.key.subkey}` for custom fields.

**Supported tokens** (frozen vocabulary):

| Token | Source |
|---|---|
| `{lead.first_name}` | `lead.firstName` |
| `{lead.last_name}` | `lead.lastName` |
| `{lead.phone_formatted}` | `lead.phoneE164` (E.164 formatted as `+1 (555) 123-4567`) |
| `{lead.email}` | `lead.email` |
| `{lead.city}` | `lead.city` |
| `{lead.state}` | `lead.state` |
| `{lead.custom.X}` | `lead.customData[X]` (JSON field) |
| `{agent.name}` | `user.fullName ?? user.username` |
| `{campaign.name}` | `campaign.name` |
| `{call.duration}` | derived from call start time, formatted `MM:SS` |

**Algorithm**:
```
regex = /\{([a-z][a-z0-9_.]*)\}/gi
for each match token:
  if token in knownTokens → replace with value (HTML-escaped)
  else → replace with "" (safe default for render; preserve for preview)
```

**Phone formatter**: `parsePhoneNumber(e164, 'US').formatNational()` using `libphonenumber-js/min` (already in monorepo via D01).

---

## 3. XSS sanitization

File: `api/src/scripts/sanitize.ts`

Uses `sanitize-html` npm package (server-side, ESM-compatible).

**Allowed tags** (script-safe subset for call-center scripts):
```
p, br, strong, em, u, s, ul, ol, li, h1, h2, h3, h4,
blockquote, a, span, div, table, thead, tbody, tr, th, td, hr
```

**Allowed attributes**:
- All elements: `class`, `id`, `style` (CSS property allowlist)
- `a`: `href` (must be `http://` or `https://`), `target`, `rel`

**Disallowed**: `script`, `iframe`, `object`, `embed`, `form`, `input`, `style` (tag-level), `on*` event handlers, `javascript:` href.

**When sanitization runs**: on `POST /api/admin/scripts` body save, on `PATCH /api/admin/scripts/:id`, and on render endpoint output. Body is stored sanitized; render adds only interpolation on top.

---

## 4. API surface (FROZEN)

All routes under `/api/admin/scripts` require `requireAuth`.

| Method | Path | RBAC | Description |
|---|---|---|---|
| `GET` | `/api/admin/scripts` | `script:read` | List all scripts (paginated, offset) |
| `POST` | `/api/admin/scripts` | `script:edit` | Create script |
| `GET` | `/api/admin/scripts/:id` | `script:read` | Get one script |
| `PATCH` | `/api/admin/scripts/:id` | `script:edit` | Update (bumps version, saves history) |
| `DELETE` | `/api/admin/scripts/:id` | `script:edit` | Soft-delete (`active = false`) |
| `POST` | `/api/admin/scripts/:id/render` | `script:read` | Render with lead_id + call context |
| `GET` | `/api/admin/scripts/:id/versions` | `script:read` | List versions (max 10) |
| `GET` | `/api/admin/scripts/:id/versions/:v` | `script:read` | Get specific version body |

**Agent endpoint** (separate plugin, `script:read` scope `group`):

| Method | Path | RBAC | Description |
|---|---|---|---|
| `GET` | `/api/agent/script/:campaignId` | `script:read` | Render active script for campaign + lead |

Query params: `?lead_id=<bigint>&call_uuid=<uuid>&call_started_at=<iso8601>`

Response: `{ html: string, scriptId: string, version: number }`

---

## 5. Render flow

```
POST /api/admin/scripts/:id/render
Body: { lead_id?: string, call_uuid?: string, call_started_at?: string }

1. Fetch Script by (tenantId, id); 404 if not found / inactive
2. If lead_id provided → fetch Lead fields (firstName, lastName, phoneE164, email, city, state, customData)
3. If call_uuid provided → fetch user (agent.name) from call_log or req.auth
4. Build token map
5. interpolate(script.body, tokenMap) → rawHtml
6. sanitize(rawHtml) → safeHtml  (double safety; body already sanitized at save time)
7. Return { html: safeHtml, scriptId, version }
```

---

## 6. Admin UI pages

```
web/src/app/(admin)/admin/scripts/
  page.tsx                     — ScriptList: table of scripts, New button
  new/
    page.tsx                   — ScriptEdit (create mode)
  [id]/
    page.tsx                   — ScriptEdit (edit mode)
    preview/
      page.tsx                 — ScriptPreview (live interpolation sandbox)

web/src/components/admin/
  ScriptList.tsx               — client component: fetch + table + pagination
  ScriptForm.tsx               — client component: create/edit form
  ScriptPreview.tsx            — client component: sample lead inputs + rendered HTML
```

**ScriptForm fields**:
- `name` (text, required, max 64)
- `campaignId` (select from campaigns list, optional)
- `active` (checkbox, default true)
- `body` (textarea, monospace, min-height 400px, max 65535 chars)
- `variables` (JSON array display-only, auto-detected from body scan)
- Variable reference panel (sidebar listing frozen vocabulary)

**ScriptPreview**:
- Sample lead inputs: first_name, last_name, phone, email, city, state, custom fields (key=value pairs)
- Calls `POST /api/admin/scripts/:id/render` on change (debounced 500ms)
- Renders result in a sandboxed `<div>` via `dangerouslySetInnerHTML`

---

## 7. A05 integration

File: `web/src/app/(agent)/call/components/ScriptTab.tsx` (new)

```tsx
// Fires once when call.bridged; no polling.
// Calls GET /api/agent/script/:campaignId?lead_id=...&call_uuid=...&call_started_at=...
// Renders via dangerouslySetInnerHTML (server-sanitized).
// Shows skeleton loader while fetching; error state if 404/network.
```

The existing call page `page.tsx` imports this component in the center panel Script tab slot.

---

## 8. Seed templates

File: `api/prisma/seed.ts` — append 3 entries under tenant 1:

1. **Default Outbound** — generic greeting script with `{lead.first_name}`, `{campaign.name}`, agent name
2. **Survey Script** — structured questions with `{lead.first_name}`, bullet points, response prompts
3. **Compliance Disclosure** — TCPA/TSR boilerplate with date/time references, `{lead.state}`

---

## 9. Tests

File: `api/src/scripts/__tests__/interpolate.test.ts`
- Token replacement: known tokens → values
- Unknown token → `""` in render mode, preserved in preview mode
- `{lead.custom.fieldName}` → JSON extraction
- HTML-escape in values (e.g. `<` in name → `&lt;`)
- Empty lead (null fields) → empty strings
- `{call.duration}` → `MM:SS` format

File: `api/src/scripts/__tests__/sanitize.test.ts`
- `<script>alert(1)</script>` → stripped
- `<img onerror="...">` → attribute stripped
- `<a href="javascript:...">` → href stripped
- Allowed tags preserved: `<strong>`, `<p>`, `<ul><li>`
- `<iframe>` → stripped

File: `api/src/scripts/__tests__/service.test.ts`
- RBAC: agent can call read, cannot call edit
- Version bump on update
- Version pruning at 11 versions → keeps 10

---

## 10. File map

```
api/
  prisma/
    migrations/
      <timestamp>_s03_scripts_versioning/
        migration.sql
    schema.prisma                        ← amend Script model + add ScriptVersion
  src/
    scripts/
      interpolate.ts                     ← interpolation engine
      sanitize.ts                        ← sanitize-html wrapper + allowed-tag safelist
      service.ts                         ← CRUD + render + version logic
      routes.ts                          ← Fastify route registration
      agent-route.ts                     ← /api/agent/script/:campaignId
      __tests__/
        interpolate.test.ts
        sanitize.test.ts
        service.test.ts
    server.ts                            ← add registerScriptRoutes import

web/
  src/
    app/
      (admin)/admin/scripts/
        page.tsx
        new/page.tsx
        [id]/page.tsx
        [id]/preview/page.tsx
    components/admin/
      ScriptList.tsx
      ScriptForm.tsx
      ScriptPreview.tsx
    app/
      (agent)/call/components/
        ScriptTab.tsx
```

---

## 11. Dependency additions

- `api/`: `sanitize-html` + `@types/sanitize-html` (server-side HTML sanitization)
- No new web dependencies (uses existing fetch + dangerouslySetInnerHTML pattern)

---

## 12. Acceptance criteria

- [ ] `pnpm typecheck` passes in `api/` and `web/`
- [ ] `pnpm lint` clean
- [ ] `pnpm test` in `api/` — all 3 test files pass (interpolate, sanitize, service)
- [ ] `GET /api/admin/scripts` returns 200 with seeded templates
- [ ] `POST /api/admin/scripts/:id/render` returns sanitized HTML with interpolated values
- [ ] Agent with `script:read` can call render; 403 on `script:edit` attempt
- [ ] ScriptTab in call page renders script body on `call.bridged`
- [ ] No `<script>` or `onerror` survives in rendered output
