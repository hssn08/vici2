# M07 Plan — Admin: Pause Codes + Statuses + Scripts

> Generated 2026-05-13. Owner: frontend agent.
> Status: READY_FOR_IMPLEMENTATION

---

## 0. Overview

M07 delivers the admin UI for three inter-related taxonomies that drive core call-center behavior:

| Entity | Table | Primary key | Scope |
|---|---|---|---|
| Pause Codes | `pause_codes` | `id` (BigInt autoincrement) | Global (NULL) or per-campaign |
| Statuses | `statuses` | `(tenant_id, campaign_id, status)` | Global (`__SYS__`) or per-campaign |
| Scripts | `scripts` | `id` (BigInt autoincrement) | Global (NULL) or per-campaign |

RBAC verbs `status:read`, `status:edit`, `pause-code:read`, `pause-code:edit`, `script:read`, `script:edit` are already defined in `shared/types/src/rbac.ts` (lines 96–102) with correct role grants. No new verbs need to be added.

Audit actions `pause_code.*`, `status.*`, `script.*` are NOT yet in `api/src/auth/audit.ts` and must be added.

The scripts system already has partial S03 scaffolding (`ScriptList`, `ScriptForm`, `ScriptPreview` components; `/admin/scripts` page). M07 upgrades the editor to Tiptap and implements the missing API routes plus the pause-codes and statuses pages from scratch.

---

## 1. Dependency Installation

Add to `web/package.json` (root-level `dependencies`):

```json
"@tiptap/react": "^2.10.x",
"@tiptap/starter-kit": "^2.10.x",
"@tiptap/extension-placeholder": "^2.10.x"
```

Install with: `pnpm --filter @vici2/web add @tiptap/react @tiptap/starter-kit @tiptap/extension-placeholder`

All three packages are MIT-licensed. No server (api) packages needed.

---

## 2. RBAC

The verbs already exist in `shared/types/src/rbac.ts`. No changes required to the RBAC matrix. The verbs and grants are:

| Verb | super_admin | admin | supervisor | agent | viewer |
|---|---|---|---|---|---|
| `status:read` | tenant | tenant | tenant | tenant | tenant |
| `status:edit` | tenant | tenant | — | — | — |
| `pause-code:read` | tenant | tenant | tenant | tenant | tenant |
| `pause-code:edit` | tenant | tenant | — | — | — |
| `script:read` | tenant | tenant | tenant | group | tenant |
| `script:edit` | tenant | tenant | — | — | — |

All API endpoints for M07 use `requirePermission('status:edit')`, `requirePermission('pause-code:edit')`, or `requirePermission('script:edit')` for mutations; `requirePermission('status:read')`, etc. for GET.

---

## 3. Audit Actions

Add to `AuditAction` union type in `api/src/auth/audit.ts`:

```typescript
// M07 — Pause codes, statuses, scripts
| "pause_code.created"
| "pause_code.updated"
| "pause_code.deleted"
| "status.created"
| "status.updated"
| "status.deleted"
| "script.created"
| "script.updated"
| "script.deleted"
| "script.restored"     // version restore action
```

All audit calls use `entityType` set to `"pause_code"`, `"status"`, or `"script"` respectively, and `entityId` set to the record's string-encoded PK.

---

## 4. Token Syntax Decision

**Canonical syntax: `{{double_brace}}`** — double curly braces, matching the Handlebars convention used by the N02 email template system.

The existing S03 ScriptForm.tsx uses `{single_brace}`. M07 supersedes S03 on this point:
- The `ScriptEditor` component (Tiptap) reads and writes `{{double_brace}}` tokens.
- The render service must support `{{double_brace}}` tokens.
- A migration script (one-time SQL `UPDATE scripts SET body = REPLACE(body, '{', '{{') WHERE ...`) should be applied on deploy — see §13.

---

## 5. Pages

### 5.1 Pause Codes List Page

**Path:** `web/src/app/(admin)/admin/pause-codes/page.tsx`
**URL:** `/admin/pause-codes`
**Auth:** `requirePermission('pause-code:read')` (client-side: admin+ role check)

```tsx
export const metadata = { title: "Pause Codes · vici2 Admin" };
export default function PauseCodesPage() {
  return (
    <main>
      <PageHeader title="Pause Codes" description="..." actionHref="/admin/pause-codes/new" actionLabel="New pause code" />
      <Suspense fallback={<TableSkeleton rows={5} cols={5} />}>
        <PauseCodeList />
      </Suspense>
    </main>
  );
}
```

### 5.2 Pause Code New/Edit Modal or Sub-page

**Decision:** Use a dialog/modal (no sub-page) for create and edit. Rationale: pause codes are simple (4 fields), so a modal avoids navigation overhead. This matches patterns from M06 DID management.

**Dialog component:** `web/src/components/admin/pause-codes/PauseCodeDialog.tsx`
- Opens from "New pause code" button (create) or row "Edit" action (edit).
- Contains `PauseCodeForm` component.

**Alternative: sub-pages** `/admin/pause-codes/new` and `/admin/pause-codes/[id]` — use if the team prefers consistent routing. Decided: use modal for simplicity.

### 5.3 Statuses List Page

**Path:** `web/src/app/(admin)/admin/statuses/page.tsx`
**URL:** `/admin/statuses`
**Auth:** `requirePermission('status:read')`

```tsx
export const metadata = { title: "Statuses · vici2 Admin" };
export default function StatusesPage() {
  return (
    <main>
      <PageHeader title="Statuses" description="Call dispositions per campaign and system-wide defaults." actionHref="/admin/statuses/new" actionLabel="New status" />
      <Suspense fallback={<TableSkeleton rows={8} cols={7} />}>
        <StatusList />
      </Suspense>
    </main>
  );
}
```

**Sub-pages:** `/admin/statuses/new` and `/admin/statuses/[campaignId]/[code]` (composite key) — use sub-pages here because Status has 10+ fields. The composite PK requires both `campaignId` and `code` in the URL.

**URL encoding:** `__SYS__` in URL must be encoded as `__SYS__` (no URL encoding needed for underscores, but tests should verify). Alternative: use a query param `?campaign=__SYS__&code=SALE`.

**Recommended URL scheme:** `/admin/statuses?campaign=__SYS__&code=SALE` for edit (query params avoid composite path routing issues). For new: `/admin/statuses/new?campaign=<id>` to pre-fill campaign.

### 5.4 Status New/Edit Pages

**Paths:**
- `web/src/app/(admin)/admin/statuses/new/page.tsx`
- `web/src/app/(admin)/admin/statuses/edit/page.tsx` — reads `?campaign=&code=` query params

### 5.5 Scripts List Page

**Path:** `web/src/app/(admin)/admin/scripts/page.tsx` — **already exists** (S03). M07 updates it minimally (adds "New script" → `/admin/scripts/new`).

### 5.6 Script Editor Page

**Path:** `web/src/app/(admin)/admin/scripts/[id]/page.tsx` — server component loading shell.

The page loads script data server-side (or via Suspense client fetch) and renders:
- `ScriptEditorClient` — the full editor layout (left: metadata form; center: Tiptap editor; right: placeholder sidebar + version history).

**New page:** `web/src/app/(admin)/admin/scripts/new/page.tsx` — renders `ScriptEditorClient` in `mode="create"`.

### 5.7 Script Preview Page

**Path:** `web/src/app/(admin)/admin/scripts/[id]/preview/page.tsx`

Renders `ScriptPreview` component. Already referenced by ScriptForm and ScriptList but the page file doesn't exist yet.

---

## 6. API Routes

All routes registered in `api/src/routes/admin/index.ts` via new register functions added before `registerAdminVoicemailBoxRoutes`.

### 6.1 Pause Codes API

**File:** `api/src/routes/admin/pause-codes/index.ts`
**Schema file:** `api/src/routes/admin/pause-codes/schema.ts`
**Service file:** `api/src/routes/admin/pause-codes/service.ts`

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/api/admin/pause-codes` | `pause-code:read` | List all (with optional campaign filter) |
| POST | `/api/admin/pause-codes` | `pause-code:edit` | Create a new pause code |
| GET | `/api/admin/pause-codes/:id` | `pause-code:read` | Get single by ID |
| PATCH | `/api/admin/pause-codes/:id` | `pause-code:edit` | Update pause code |
| DELETE | `/api/admin/pause-codes/:id` | `pause-code:edit` | Delete pause code |

**Query parameters for GET list:**
```
page: coerce number, default 1
pageSize: coerce number, min 1, max 200, default 50
campaignId: string optional — filter by campaign; use '__GLOBAL__' to filter nulls
search: string optional — case-insensitive match on code or name
```

**Request body for POST/PATCH:**
```typescript
{
  code: string,       // max 16, alphanumeric + underscore + hyphen
  name: string,       // max 64
  billable: boolean,  // default true
  campaignId: string | null  // null = global
}
```

**Response shape:**
```typescript
{
  id: string,          // BigInt as string
  tenantId: string,
  campaignId: string | null,
  code: string,
  name: string,
  billable: boolean,
  createdAt: string,
  updatedAt: string
}
```

**Error cases:**
- `409 conflict` — code already exists in that campaign scope (P2002 from DB functional UNIQUE).
- `404 not_found` — ID not found or belongs to another tenant.

### 6.2 Statuses API

**File:** `api/src/routes/admin/statuses/index.ts`
**Schema file:** `api/src/routes/admin/statuses/schema.ts`
**Service file:** `api/src/routes/admin/statuses/service.ts`

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/api/admin/statuses` | `status:read` | List all (with campaign filter) |
| POST | `/api/admin/statuses` | `status:edit` | Create a new status |
| GET | `/api/admin/statuses/:campaignId/:code` | `status:read` | Get single by composite key |
| PATCH | `/api/admin/statuses/:campaignId/:code` | `status:edit` | Update status |
| DELETE | `/api/admin/statuses/:campaignId/:code` | `status:edit` | Delete status (system-owned blocked) |

**URL encoding:** `campaignId` in path should be URL-encoded; `__SYS__` is safe as-is.

**Query parameters for GET list:**
```
page, pageSize (same as pause-codes)
campaignId: string optional — '__SYS__' for global, a real campaign_id for scoped
search: optional text match on status code or description
category: optional match on category field
selectable: 'true'|'false'|'all' default 'all'
```

**Request body for POST/PATCH:**
```typescript
{
  status: string,             // max 24, UPPER_SNAKE recommended
  description: string,        // max 128
  selectable: boolean,        // default true
  humanAnswered: boolean,     // default false
  sale: boolean,              // default false
  dnc: boolean,               // default false
  callback: boolean,          // default false
  notInterested: boolean,     // default false
  hotkey: string | null,      // single char or null
  recycleDelaySeconds: number | null,  // null|-1|0|>0
  category: string | null,    // enum: sale|not_interested|dnc|callback|machine|system|other
  campaignId: string,         // '__SYS__' for global, real id for campaign-scoped
}
```

**Response shape:**
```typescript
{
  tenantId: string,
  campaignId: string,
  status: string,
  description: string,
  selectable: boolean,
  humanAnswered: boolean,
  sale: boolean,
  dnc: boolean,
  callback: boolean,
  notInterested: boolean,
  hotkey: string | null,
  recycleDelaySeconds: number | null,
  category: string | null,
  systemOwner: string | null,  // non-null = protected, cannot delete
  createdAt: string,
  updatedAt: string
}
```

**Error cases:**
- `409 conflict` — `(tenantId, campaignId, status)` already exists.
- `403 forbidden` — attempting to delete a status with `systemOwner IS NOT NULL`.
- `409 hotkey_conflict` — hotkey already used within the same `(tenantId, campaignId)` scope.

**System protection check (DELETE handler):**
```typescript
if (existing.systemOwner !== null) {
  return reply.code(403).send({
    code: "system_protected",
    message: `Status ${code} is owned by system module '${existing.systemOwner}' and cannot be deleted.`
  });
}
```

### 6.3 Scripts API

**Files:** `api/src/routes/admin/scripts/index.ts`, `schema.ts`, `service.ts`

**Note:** ScriptPreview.tsx already references `POST /api/admin/scripts/:id/render` — this endpoint must be implemented.

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/api/admin/scripts` | `script:read` | List scripts (paginated) |
| POST | `/api/admin/scripts` | `script:edit` | Create new script |
| GET | `/api/admin/scripts/:id` | `script:read` | Get script with current body |
| PATCH | `/api/admin/scripts/:id` | `script:edit` | Update script (bumps version, saves ScriptVersion) |
| DELETE | `/api/admin/scripts/:id` | `script:edit` | Soft-delete (sets active=false) |
| GET | `/api/admin/scripts/:id/versions` | `script:read` | List version history (max 10) |
| POST | `/api/admin/scripts/:id/restore/:version` | `script:edit` | Restore a version (creates new version) |
| POST | `/api/admin/scripts/:id/render` | `script:read` | Render script with sample/lead data |

**Request body for POST/PATCH:**
```typescript
{
  name: string,         // max 64, required
  body: string,         // MediumText HTML with {{token}} placeholders
  campaignId: string | null,  // null = global
  active: boolean,      // default true
  variables: Array<{ name: string; description?: string }>  // auto-detected; can be overridden
}
```

**Script response shape:**
```typescript
{
  id: string,
  tenantId: string,
  name: string,
  body: string,
  campaignId: string | null,
  active: boolean,
  version: number,
  variables: Array<{ name: string; description?: string }>,
  usedByCampaignCount: number,  // computed: count of campaigns where scriptId = this.id
  createdAt: string,
  updatedAt: string
}
```

**Render endpoint (`POST /api/admin/scripts/:id/render`):**

Request:
```typescript
{
  mode: "preview" | "live",
  sampleData?: {           // used in preview mode
    first_name?: string,
    last_name?: string,
    phone?: string,
    email?: string,
    city?: string,
    state?: string,
    custom?: Record<string, string>
  },
  leadId?: string,         // used in live mode (agent UI — not M07 primary use case)
  agentName?: string,
  campaignName?: string
}
```

Response:
```typescript
{
  scriptId: string,
  version: number,
  html: string            // sanitized rendered HTML
}
```

**Service layer for PATCH (version bump + prune):**
```typescript
async function updateScript(tenantId, id, data, actorUserId):
  1. Read existing script (404 if not found)
  2. In a Prisma transaction:
     a. Create ScriptVersion with current { name, body, variables, version }
     b. Update Script with new data + version++
     c. Count versions for scriptId → delete oldest beyond 10
     d. Audit log: script.updated
  3. Return updated script
```

---

## 7. Component Architecture

### 7.1 Pause Code Components

```
web/src/components/admin/pause-codes/
  PauseCodeList.tsx         — client component; table + search + pagination
  PauseCodeDialog.tsx       — dialog shell with open/close state
  PauseCodeForm.tsx         — controlled form; used inside dialog for create/edit
```

#### `PauseCodeList` Table Columns

| Column | Source | Notes |
|---|---|---|
| Code | `code` | Monospace badge |
| Name | `name` | |
| Scope | `campaignId` | "Global" or campaign ID |
| Billable | `billable` | Boolean badge: Yes/No |
| Updated | `updatedAt` | Formatted date |
| Actions | — | Edit, Delete |

**Filters:**
- Text search (code or name), debounced 300ms.
- Scope dropdown: All / Global / Per-campaign (shows campaign input when selected).
- Billable filter: All / Billable / Non-billable.

#### `PauseCodeForm` Fields

```
Code *       <Input> max 16, pattern [A-Z0-9_-]+, uppercase enforced on input
Name *       <Input> max 64
Billable     <Checkbox> default checked
Campaign     <CampaignSelect> (combobox) — optional; empty = global
```

**Validation (client + server):**
- `code` required, `^[A-Z0-9_\-]{1,16}$`, auto-uppercased on blur.
- `name` required, 1–64 chars.
- `billable` required boolean.
- `campaignId` optional; if set must be a valid campaign id for the tenant.

### 7.2 Status Components

```
web/src/components/admin/statuses/
  StatusList.tsx            — client component; table + filters
  StatusForm.tsx            — full form for create/edit (sub-page based)
  StatusHotkeyInput.tsx     — single-char input with live conflict detection
  StatusBadge.tsx           — pill showing SALE/DNC/CB/NI flags
```

#### `StatusList` Table Columns

| Column | Source | Notes |
|---|---|---|
| Code | `status` | Monospace; system-owned shows lock icon |
| Description | `description` | |
| Scope | `campaignId` | "Global" badge or campaign ID |
| Flags | computed | Compact flag pills: SALE, DNC, CB, NI, HA |
| Hotkey | `hotkey` | `kbd` element or dash |
| Recycle | `recycleDelaySeconds` | "Terminal" / "Immediate" / "600s" / "Campaign default" |
| Updated | `updatedAt` | |
| Actions | — | Edit; Delete hidden for system-owned rows |

**Filters:**
- Text search (code or description), debounced.
- Scope dropdown: All / Global (`__SYS__`) / Campaign (campaign selector).
- Category filter (multi-select): sale, not_interested, dnc, callback, machine, system, other.
- Selectable filter: All / Selectable / Non-selectable.

#### `StatusForm` Fields

```
Status Code *     <Input> max 24, UPPER_SNAKE; locked in edit mode (PK)
Description       <Input> max 128
Campaign *        <CampaignSelect> or '__SYS__' for global; locked in edit mode (PK)
Category          <Select> options: sale|not_interested|dnc|callback|machine|system|other
Selectable        <Checkbox> default true
Human Answered    <Checkbox>
Sale              <Checkbox>
DNC               <Checkbox>
Callback          <Checkbox>
Not Interested    <Checkbox>
Hotkey            <StatusHotkeyInput> optional single char, live conflict check
Recycle Delay     <RecycleDelayInput> — see below
```

**`RecycleDelayInput`** — custom compound input:
- Radio group: "Campaign default (NULL)" | "Immediate (0)" | "Terminal (-1)" | "Custom (seconds)"
- When "Custom" selected: numeric input appears.

**System-owned status display:**
- Code and Campaign fields show lock icon.
- All checkboxes readonly.
- Recycle delay readable but not editable.
- "Status owned by system module. Cannot be deleted." banner.

### 7.3 Script Components

```
web/src/components/admin/scripts/
  ScriptList.tsx              — ALREADY EXISTS (S03), minor updates
  ScriptEditor.tsx            — NEW; Tiptap-based editor + sidebar layout
  ScriptEditorClient.tsx      — client wrapper for the editor page
  PlaceholderMenu.tsx         — NEW; variable reference sidebar with insert buttons
  VersionHistoryPanel.tsx     — NEW; collapsible side panel with version list
  ScriptPreview.tsx           — ALREADY EXISTS (S03), update sample data handling
```

#### `ScriptEditor` Component

```tsx
interface ScriptEditorProps {
  mode: 'create' | 'edit';
  scriptId?: string;
}
```

**Layout:**
```
┌─────────────────────────────────────────────────────────────────┐
│  Name [input]    Campaign [select]    Active [toggle]           │
├───────────────────────────────┬─────────────────────────────────┤
│  Tiptap Toolbar               │  Variable Reference Sidebar     │
│  [B] [I] [ul] [ol] [H2] [<>] │  ──────────────────             │
├───────────────────────────────│  Lead fields                    │
│                               │  {{lead.first_name}} Insert     │
│  <Tiptap Editor>              │  {{lead.last_name}}  Insert     │
│  (contenteditable, 400px min) │  ...                            │
│                               │  Agent fields                   │
│                               │  {{agent.name}}      Insert     │
│                               │  Campaign fields                │
│                               │  {{campaign.name}}   Insert     │
│                               │  ──────────────────             │
│                               │  Detected tokens (N)            │
│                               │  {{lead.first_name}} ✓          │
├───────────────────────────────┴─────────────────────────────────┤
│  [Save changes]  Cancel   v5 · Updated 5 min ago               │
│                                                                 │
│  ▼ Version History (10 versions)                                │
│    v5 — 2026-05-13 14:20  [Restore]                            │
│    v4 — 2026-05-12 09:11  [Restore]                            │
└─────────────────────────────────────────────────────────────────┘
```

**Tiptap Extensions Used:**
- `StarterKit` — Bold, Italic, Heading (H1–H3), BulletList, OrderedList, CodeBlock, Blockquote, HorizontalRule.
- `Placeholder` — empty-state text: "Start writing your script...".
- `PlaceholderToken` — custom Mark extension (see §7.4).

**`getHTML()` output** is stored in `scripts.body`. On load, `editor.commands.setContent(body)` parses the stored HTML.

**Toolbar buttons** (using lucide-react icons):
- Bold, Italic, H1, H2, BulletList, OrderedList, CodeBlock — all toggle buttons with `aria-pressed`.
- Undo, Redo.

#### `PlaceholderMenu` Component

```tsx
interface PlaceholderMenuProps {
  onInsert: (token: string) => void;
  detectedTokens: string[];
}
```

**Variable groups:**

```
Lead fields (19 tokens)
  {{lead.first_name}}        Lead's first name
  {{lead.last_name}}         Lead's last name
  {{lead.phone}}             Phone (E.164)
  {{lead.phone_alt}}         Alt phone
  {{lead.email}}             Email address
  {{lead.address1}}          Street address line 1
  {{lead.address2}}          Street address line 2
  {{lead.city}}              City
  {{lead.state}}             State (2-letter)
  {{lead.postal_code}}       Postal/ZIP code
  {{lead.country_code}}      Country code (US, CA...)
  {{lead.title}}             Title (Mr, Dr, etc.)
  {{lead.middle_initial}}    Middle initial
  {{lead.gender}}            Gender (M/F/U)
  {{lead.date_of_birth}}     Date of birth
  {{lead.vendor_lead_code}}  Vendor lead code
  {{lead.source_id}}         Source ID
  {{lead.comments}}          Comments/notes
  {{lead.custom.FIELD}}      Custom data field (replace FIELD)

Agent fields (2 tokens)
  {{agent.name}}             Agent full name
  {{agent.username}}         Agent login username

Campaign fields (1 token)
  {{campaign.name}}          Campaign name

Call fields (3 tokens)
  {{call.uuid}}              Unique call identifier
  {{call.duration}}          Call duration (MM:SS)
  {{call.start_time}}        Call start time (ISO 8601)

Tenant fields (1 token)
  {{tenant.name}}            Tenant/company name
```

Each item is a `<button>` that calls `onInsert(token)`. The token is inserted at the Tiptap cursor position using `editor.chain().focus().insertContent(...)`.

#### `PlaceholderToken` Tiptap Extension

```typescript
// Custom Mark extension
const PlaceholderToken = Mark.create({
  name: 'placeholderToken',
  atom: true,  // prevents partial selection

  parseHTML() {
    return [{ tag: 'span[data-token]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, {
      'data-token': true,
      class: 'placeholder-token',  // styled as chip
      contenteditable: 'false',
      'aria-label': `token: ${HTMLAttributes['data-value']}`,
    }), 0];
  },

  addAttributes() {
    return {
      value: { default: null, parseHTML: el => el.getAttribute('data-value') },
    };
  },
});
```

**Serialization contract:** When `getHTML()` is called, tokens are serialized as `<span data-token data-value="{{lead.first_name}}" contenteditable="false" ...>{{lead.first_name}}</span>`. The stored HTML must be normalized: the render service strips the span wrapper and replaces it with the raw token string for interpolation.

**Alternative approach:** Store the body as plain text (not HTML) with `{{token}}` syntax, and render through a markdown/Handlebars processor. This avoids the serialization complexity but loses rich text formatting (bold, lists). Decision: keep HTML storage to support call script formatting (headings, lists for scripted responses).

#### `VersionHistoryPanel` Component

```tsx
interface VersionHistoryPanelProps {
  scriptId: string;
  currentVersion: number;
  onRestored: (newVersion: number) => void;
}
```

**Behavior:**
- Collapsible section below the editor form (not a drawer for Phase 1).
- Shows max 10 entries: version number, date, first 80 chars of `body` text content (not HTML).
- "Restore" button: calls `POST /api/admin/scripts/:id/restore/:version` → updates editor with restored content and shows "Restored to v{N}. Saved as v{M}." toast.

---

## 8. Validation Rules

### 8.1 Pause Code Validation

| Field | Rule | Error message |
|---|---|---|
| `code` | Required; 1–16 chars; `^[A-Z0-9_\-]+$` | "Code must be 1–16 uppercase alphanumeric/underscore/hyphen characters" |
| `name` | Required; 1–64 chars | "Name must be 1–64 characters" |
| `billable` | Required boolean | — |
| `campaignId` | If provided, must exist in tenant's campaigns | "Campaign not found" |
| Code uniqueness | Unique within `(tenantId, IFNULL(campaignId, '__SYS__'))` | "A pause code with this code already exists in this scope" |

### 8.2 Status Validation

| Field | Rule | Error message |
|---|---|---|
| `status` | Required; 1–24 chars; recommended UPPER_SNAKE; not blank | "Status code is required (max 24 chars)" |
| `description` | Optional; max 128 chars | "Description must be max 128 characters" |
| `campaignId` | Required; must be `'__SYS__'` or a valid campaign id | "Campaign is required" |
| `hotkey` | If provided: exactly 1 char; unique within `(tenantId, campaignId)` | "Hotkey must be a single character" / "Hotkey already used by status X in this campaign" |
| `recycleDelaySeconds` | If provided: -1 (terminal), 0, or ≥1; max 86400 (24h) | "Recycle delay must be -1 (terminal), 0 (immediate), or 1–86400 seconds" |
| `category` | If provided: one of `sale|not_interested|dnc|callback|machine|system|other` | "Invalid category" |
| Code uniqueness | Unique within `(tenantId, campaignId, status)` (PK) | "A status with this code already exists in this campaign scope" |
| System protection | `systemOwner IS NOT NULL` → delete blocked | "This status is protected and cannot be deleted" |

### 8.3 Script Validation

| Field | Rule | Error message |
|---|---|---|
| `name` | Required; 1–64 chars | "Script name is required (max 64 chars)" |
| `body` | Optional; max 65535 chars (MediumText practical limit for UI) | "Script body cannot exceed 65,535 characters" |
| `campaignId` | If provided, must exist in tenant's campaigns | "Campaign not found" |
| `variables` | Array of `{ name: string }` where `name` matches `^[a-z][a-z0-9_.]*$` | "Invalid variable name format" |

---

## 9. Frontend State Management

All three list pages use local React state (no Zustand store needed):
- `useState` for items, loading, error, pagination, search, filters.
- Debounce (300ms) on search inputs.
- Optimistic UI: for delete, immediately remove from list then rollback on error.
- Toast notifications for create/update/delete success (use `useToast` from existing `ui/toast.tsx`).

---

## 10. Shared Components to Create

The three sections share some UI patterns that should be extracted:

```
web/src/components/admin/shared/
  CampaignSelect.tsx        — combobox/select populated from GET /api/admin/campaigns
  PageHeader.tsx            — standardized title + description + action button
  TableSkeleton.tsx         — animated skeleton rows/cols (already in some pages inline)
  ConfirmDeleteDialog.tsx   — reusable confirmation dialog for destructive actions
  SystemProtectedBadge.tsx  — lock icon badge for system-owned rows
```

**`CampaignSelect`:** Fetches campaigns via `GET /api/admin/campaigns?active=true&pageSize=200` (assumes <200 campaigns per tenant for Phase 1). Renders as `<select>` with an "All campaigns (global)" option at top.

---

## 11. API Route Registration

Update `api/src/routes/admin/index.ts` to register M07 routes:

```typescript
// M07 — Pause codes, statuses, scripts
import { registerAdminPauseCodeRoutes } from "./pause-codes/index.js";
import { registerAdminStatusRoutes } from "./statuses/index.js";
import { registerAdminScriptRoutes } from "./scripts/index.js";
```

Add inside `registerAdminRoutes()`:
```typescript
await registerAdminPauseCodeRoutes(app);
await registerAdminStatusRoutes(app);
await registerAdminScriptRoutes(app);
```

---

## 12. Acceptance Criteria

### 12.1 Pause Codes

- [ ] Can create a global pause code (`campaignId=null`) with code, name, billable=true.
- [ ] Can create a per-campaign pause code.
- [ ] Can edit code, name, billable, scope.
- [ ] Cannot create duplicate code within the same scope (409 error shown).
- [ ] Can delete a pause code with confirmation dialog.
- [ ] Code is auto-uppercased on input.
- [ ] List supports search by code or name.
- [ ] List supports filtering by scope (global/campaign).
- [ ] Audit log shows `pause_code.created`, `pause_code.updated`, `pause_code.deleted`.

### 12.2 Statuses

- [ ] Can create a global status (`campaignId='__SYS__'`) with all fields.
- [ ] Can create a per-campaign status.
- [ ] Cannot delete system-owned statuses (lock badge + delete action hidden + API returns 403).
- [ ] Hotkey conflict is detected client-side and server-side.
- [ ] `recycleDelaySeconds=-1` is labeled "Terminal" in the list.
- [ ] `dnc=true` statuses show a DNC badge.
- [ ] List supports scope filter: All / Global / Campaign.
- [ ] Audit log shows `status.created`, `status.updated`, `status.deleted`.
- [ ] Creating "QUOTE_SENT" for campaign OUTBOUND1 causes it to appear in A06 dispo picker.

### 12.3 Scripts

- [ ] Can create a new script with Tiptap editor.
- [ ] Bold, italic, heading, list formatting is preserved in stored HTML.
- [ ] Can insert `{{lead.first_name}}` from sidebar; appears as styled chip in editor.
- [ ] `{{token}}` chips serialize correctly to stored HTML and render back after reload.
- [ ] On save, `version` increments by 1.
- [ ] Version history panel shows up to 10 versions.
- [ ] Can restore a prior version — creates new version, editor shows restored content.
- [ ] Preview page renders script with sample lead data; unknown tokens shown as `[field]`.
- [ ] Deactivating a script (soft-delete) hides it from A05 agent UI.
- [ ] Audit log shows `script.created`, `script.updated`, `script.deleted`, `script.restored`.
- [ ] Create TRAINING script with `Hello {{lead.first_name}}`; preview shows substituted sample.

### 12.4 General

- [ ] All pages require `admin` role minimum.
- [ ] All API mutations require appropriate `:edit` permission via `requirePermission`.
- [ ] All API reads accept `:read` permission.
- [ ] All table pages are keyboard-navigable (Tab order correct, `aria-current` on active items).
- [ ] Loading state shows skeleton rows (not blank page).
- [ ] Error state shows `role="alert"` banner.
- [ ] Tiptap editor is accessible: `aria-label`, toolbar `aria-pressed`, `aria-label` on chip tokens.

---

## 13. Edge Cases

1. **Deleting a pause code in use:** If agents are currently paused on a code being deleted, the deletion succeeds (no FK prevents it — `pause_events` records reference the code string, not a FK). Active pause sessions continue until the agent unpauses. Warn: "Agents currently using this code will complete their pause normally."

2. **Deleting a status in use:** Lead `status` field is a VARCHAR, not a FK. Leads with a deleted status remain set to that value. Warn: "N leads currently have this status. They will retain it until their status is changed."

3. **Deleting a script assigned to campaigns:** The `campaigns.scriptId` FK has `onDelete: SetNull`. When script is soft-deleted (`active=false`), FK is not touched; when hard-deleted (if we allow it), Prisma sets `campaigns.scriptId = NULL`. For M07 Phase 1, only soft-delete is exposed. Hard-delete is blocked if the script has any campaign assignments.

4. **Token syntax migration (single → double brace):** Existing script bodies from S03 may use `{single}`. The render service must handle both during the transition. A migration SQL or startup script normalizes bodies. After migration, only `{{double}}` is supported.

5. **Campaign ID uniqueness check for statuses:** The `(tenantId, campaignId, status)` composite PK is enforced at DB. If a POST fails with P2002, the service should return 409 with `code: "status_exists"`.

6. **`__SYS__` sentinel in URL routing:** If using path params `/api/admin/statuses/__SYS__/SALE`, the double underscore may conflict with Next.js `(group)` or dynamic segments. Use query params `?campaign=__SYS__&code=SALE` for the edit page URL instead.

7. **Large campaign list in `CampaignSelect`:** If a tenant has >200 campaigns, the fixed `pageSize=200` approach breaks. Phase 1 limitation: document as known. Phase 2: implement autocomplete with server-side search.

8. **Tiptap PlaceholderToken chip on paste:** If an agent copies text containing `{{lead.first_name}}` and pastes into the Tiptap editor, the raw string should be parsed into a chip. Implement via the `parseHTML` rule in the extension. Text nodes matching `{{...}}` should be converted by a PasteRule.

9. **Empty body script:** Allow saving with empty body (empty string). Agents will see a blank script panel — acceptable behavior.

10. **Billable flag change on active pause codes:** Real-time effect on running pause sessions is only in metrics aggregation. The current value at `pause_end` determines billing. Changing billable during an active session affects the ending record only.

---

## 14. Phase Plan

### Phase 1 (M07 — this module)

**Week 1: API layer**
- Day 1: `api/src/routes/admin/pause-codes/` — schema, service, index, register.
- Day 2: `api/src/routes/admin/statuses/` — schema, service, index, register.
- Day 3: `api/src/routes/admin/scripts/` — schema, service, index (including render + versions endpoints), register.
- Day 3 (partial): Audit action strings in `api/src/auth/audit.ts`.

**Week 2: Frontend layer**
- Day 1: Tiptap install + `PlaceholderToken` extension + `ScriptEditor` component.
- Day 2: `PlaceholderMenu`, `VersionHistoryPanel`, `ScriptEditorClient` — script editor page.
- Day 3: `PauseCodeList`, `PauseCodeDialog`, `PauseCodeForm` — pause codes page.
- Day 4: `StatusList`, `StatusForm`, `StatusHotkeyInput` — statuses pages.
- Day 5: Shared components (`CampaignSelect`, `PageHeader`, `ConfirmDeleteDialog`), integration polish, Playwright tests.

### Phase 2 (future)

- `CampaignStatusOverride` editor (per-campaign recycle delay overrides).
- Diff view for script version history.
- Autocomplete `CampaignSelect` for large tenants.
- Export pause codes / statuses to CSV.
- Import/bulk-create statuses from CSV.
- Script validation lint (detects unknown tokens, warns before save).

---

## 15. Estimated LOC

| File | Est. LOC |
|---|---|
| `api/src/routes/admin/pause-codes/schema.ts` | ~60 |
| `api/src/routes/admin/pause-codes/service.ts` | ~120 |
| `api/src/routes/admin/pause-codes/index.ts` | ~100 |
| `api/src/routes/admin/statuses/schema.ts` | ~90 |
| `api/src/routes/admin/statuses/service.ts` | ~150 |
| `api/src/routes/admin/statuses/index.ts` | ~120 |
| `api/src/routes/admin/scripts/schema.ts` | ~80 |
| `api/src/routes/admin/scripts/service.ts` | ~200 |
| `api/src/routes/admin/scripts/index.ts` | ~180 |
| `api/src/auth/audit.ts` (addition) | ~10 |
| `api/src/routes/admin/index.ts` (addition) | ~10 |
| `web/app/(admin)/admin/pause-codes/page.tsx` | ~40 |
| `web/app/(admin)/admin/statuses/page.tsx` | ~40 |
| `web/app/(admin)/admin/statuses/new/page.tsx` | ~30 |
| `web/app/(admin)/admin/statuses/edit/page.tsx` | ~30 |
| `web/app/(admin)/admin/scripts/new/page.tsx` | ~30 |
| `web/app/(admin)/admin/scripts/[id]/page.tsx` | ~40 |
| `web/app/(admin)/admin/scripts/[id]/preview/page.tsx` | ~30 |
| `web/components/admin/pause-codes/PauseCodeList.tsx` | ~220 |
| `web/components/admin/pause-codes/PauseCodeDialog.tsx` | ~80 |
| `web/components/admin/pause-codes/PauseCodeForm.tsx` | ~160 |
| `web/components/admin/statuses/StatusList.tsx` | ~280 |
| `web/components/admin/statuses/StatusForm.tsx` | ~300 |
| `web/components/admin/statuses/StatusHotkeyInput.tsx` | ~80 |
| `web/components/admin/statuses/StatusBadge.tsx` | ~50 |
| `web/components/admin/scripts/ScriptEditor.tsx` | ~200 |
| `web/components/admin/scripts/ScriptEditorClient.tsx` | ~80 |
| `web/components/admin/scripts/PlaceholderMenu.tsx` | ~150 |
| `web/components/admin/scripts/VersionHistoryPanel.tsx` | ~140 |
| `web/components/admin/scripts/PlaceholderToken.ts` | ~80 |
| `web/components/admin/shared/CampaignSelect.tsx` | ~100 |
| `web/components/admin/shared/PageHeader.tsx` | ~50 |
| `web/components/admin/shared/ConfirmDeleteDialog.tsx` | ~80 |
| `web/components/admin/shared/SystemProtectedBadge.tsx` | ~30 |
| Playwright test files (~4) | ~400 |
| **Total** | **~3,820** |

---

## 16. File Manifest

### New API files

- `/root/vici2/api/src/routes/admin/pause-codes/schema.ts`
- `/root/vici2/api/src/routes/admin/pause-codes/service.ts`
- `/root/vici2/api/src/routes/admin/pause-codes/index.ts`
- `/root/vici2/api/src/routes/admin/statuses/schema.ts`
- `/root/vici2/api/src/routes/admin/statuses/service.ts`
- `/root/vici2/api/src/routes/admin/statuses/index.ts`
- `/root/vici2/api/src/routes/admin/scripts/schema.ts`
- `/root/vici2/api/src/routes/admin/scripts/service.ts`
- `/root/vici2/api/src/routes/admin/scripts/index.ts`

### Modified API files

- `/root/vici2/api/src/auth/audit.ts` — add M07 audit action strings
- `/root/vici2/api/src/routes/admin/index.ts` — register M07 routes

### New web pages

- `/root/vici2/web/src/app/(admin)/admin/pause-codes/page.tsx`
- `/root/vici2/web/src/app/(admin)/admin/statuses/page.tsx`
- `/root/vici2/web/src/app/(admin)/admin/statuses/new/page.tsx`
- `/root/vici2/web/src/app/(admin)/admin/statuses/edit/page.tsx`
- `/root/vici2/web/src/app/(admin)/admin/scripts/new/page.tsx`
- `/root/vici2/web/src/app/(admin)/admin/scripts/[id]/page.tsx`
- `/root/vici2/web/src/app/(admin)/admin/scripts/[id]/preview/page.tsx`

### Modified web pages

- `/root/vici2/web/src/app/(admin)/admin/scripts/page.tsx` — minor updates (token syntax, new script button target)

### New web components

- `/root/vici2/web/src/components/admin/pause-codes/PauseCodeList.tsx`
- `/root/vici2/web/src/components/admin/pause-codes/PauseCodeDialog.tsx`
- `/root/vici2/web/src/components/admin/pause-codes/PauseCodeForm.tsx`
- `/root/vici2/web/src/components/admin/statuses/StatusList.tsx`
- `/root/vici2/web/src/components/admin/statuses/StatusForm.tsx`
- `/root/vici2/web/src/components/admin/statuses/StatusHotkeyInput.tsx`
- `/root/vici2/web/src/components/admin/statuses/StatusBadge.tsx`
- `/root/vici2/web/src/components/admin/scripts/ScriptEditor.tsx`
- `/root/vici2/web/src/components/admin/scripts/ScriptEditorClient.tsx`
- `/root/vici2/web/src/components/admin/scripts/PlaceholderMenu.tsx`
- `/root/vici2/web/src/components/admin/scripts/VersionHistoryPanel.tsx`
- `/root/vici2/web/src/components/admin/scripts/PlaceholderToken.ts`
- `/root/vici2/web/src/components/admin/shared/CampaignSelect.tsx`
- `/root/vici2/web/src/components/admin/shared/PageHeader.tsx`
- `/root/vici2/web/src/components/admin/shared/ConfirmDeleteDialog.tsx`
- `/root/vici2/web/src/components/admin/shared/SystemProtectedBadge.tsx`

### Modified web components

- `/root/vici2/web/src/components/admin/ScriptForm.tsx` — superseded by ScriptEditor; kept for backward compat reference
- `/root/vici2/web/src/components/admin/ScriptPreview.tsx` — update sample data to pass to render endpoint

### Package installation

- `pnpm --filter @vici2/web add @tiptap/react @tiptap/starter-kit @tiptap/extension-placeholder`
- Updates: `/root/vici2/web/package.json`, `/root/vici2/pnpm-lock.yaml`
