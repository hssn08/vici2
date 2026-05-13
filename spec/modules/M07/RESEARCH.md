# M07 Research — Admin: Pause Codes + Statuses + Scripts

> Generated 2026-05-13 by PLAN agent (Claude Sonnet 4.6).

---

## 1. Prisma Schema Analysis

### 1.1 `Status` model (`api/prisma/schema.prisma` lines 590–618)

```
model Status {
  tenantId             BigInt   — tenant FK (default 1)
  campaignId           String   — VARCHAR(32); sentinel '__SYS__' for global rows
  status               String   — VARCHAR(24); the code itself (e.g. SALE, NI, DNC)
  description          String   — VARCHAR(128); human-readable label
  selectable           Boolean  — agent can pick this dispo (default true)
  humanAnswered        Boolean  — whether a human answered (affects metrics)
  sale                 Boolean  — marks as a sale outcome
  dnc                  Boolean  — triggers DNC insertion
  callback             Boolean  — triggers callback scheduling
  notInterested        Boolean  — NI flag
  hotkey               Char(1)  — keyboard shortcut in dispo picker (nullable)
  recycleDelaySeconds  Int?     — NULL=campaign default, 0=immediate, -1=terminal, >0=seconds
  category             String?  — VARCHAR(20); taxonomy category (D04 amendment)
  systemOwner          String?  — VARCHAR(8); which module owns this status (D04)
  createdAt / updatedAt

  @@id([tenantId, campaignId, status])
}
```

**Key design notes:**
- No FK to campaigns table because the `__SYS__` sentinel campaignId doesn't exist in `campaigns`.
- The composite PK `(tenantId, campaignId, status)` enforces code uniqueness per campaign scope.
- `systemOwner` non-null means the row is system-managed; the UI must prevent deletion.
- Globally applicable statuses use `campaignId = '__SYS__'`. Per-campaign rows have a real `campaign_id`.
- `recycleDelaySeconds = -1` is a terminal disposition (lead will not be recycled).
- `hotkey` must be unique within a campaignId scope to avoid picker conflicts.

**System-seeded statuses (per schema comments lines 79–80):**
`NEW`, `NA`, `B`, `CALLBK`, `SALE`, `NI`, `DNC`, `DROP`, `TCPA`, `CONSENT_NOT_OBTAINED`, `CARRIER_FAIL`, `GATEWAY_LIMIT_TRY_LATER` — all seeded under `__SYS__`.

**Default dial_statuses per campaign (E01.9):** `['NEW','NA','B','CALLBK']`.

### 1.2 `PauseCode` model (lines 624–641)

```
model PauseCode {
  id         BigInt   — autoincrement PK
  tenantId   BigInt   — tenant FK
  campaignId String?  — NULL = global; real campaign_id = per-campaign
  code       String   — VARCHAR(16); the short code (e.g. BREAK, LUNCH)
  name       String   — VARCHAR(64); display name
  billable   Boolean  — whether this pause counts as billable time (default true)
  createdAt / updatedAt

  @@index([tenantId, campaignId, code])
  -- DB has functional UNIQUE: UNIQUE (tenant_id, IFNULL(campaign_id,'__SYS__'), code)
}
```

**Key design notes:**
- `campaignId NULL` = global pause code visible to all campaigns.
- Code uniqueness is enforced at DB level using a functional UNIQUE on `IFNULL(campaign_id,'__SYS__')`.
- No `systemOwner` field — all rows are user-managed. There are no system-protected pause codes in the current schema.
- The `billable` flag integrates with agent metrics/reporting (workers/src/lib/metrics.ts).

### 1.3 `Script` model (lines 647–668)

```
model Script {
  id         BigInt   — autoincrement PK
  tenantId   BigInt   — tenant FK
  name       String   — VARCHAR(64)
  body       String   — MediumText; HTML + {token} placeholders
  campaignId String?  — NULL = global; real campaign_id = per-campaign
  active     Boolean  — default true (S03 addition)
  version    Int      — SmallInt, increments on each save (S03 addition)
  variables  Json     — declarative variable registry array (S03 addition)
  createdAt / updatedAt
}
```

**Key design notes:**
- `campaignId NULL` = script available to all campaigns.
- `active = false` is soft-delete; hard-delete removes history.
- `version` increments every time the body is saved (S03 semantics).
- `variables` JSON array stores auto-detected placeholders for quick reference.
- A campaign's `scriptId` FK references `scripts.id` (`campaigns.scriptId`); a script can be assigned to many campaigns via `campaigns.scriptId`.

### 1.4 `ScriptVersion` model (lines 674–690)

```
model ScriptVersion {
  id        BigInt   — autoincrement PK
  tenantId  BigInt
  scriptId  BigInt   — FK to scripts.id (Cascade delete)
  version   Int      — SmallInt
  name      String   — VARCHAR(64) snapshot
  body      String   — MediumText snapshot
  variables Json
  savedAt   DateTime

  @@unique([scriptId, version])
}
```

**Key design notes:**
- S03 keeps the last 10 versions per script (comment on line 671).
- Rotation/pruning of old versions must be implemented in the save service.
- ScriptVersion is already in the schema — script version history is **Phase 1**, not Phase 2. The M07 plan should include the version history panel in the script editor.

### 1.5 `CampaignStatusOverride` model (lines 513–538)

```
model CampaignStatusOverride {
  tenantId   BigInt
  campaignId String
  status     String   — references statuses.status (no FK, app enforces)
  ...
}
```

Status assignments to specific campaigns go through this join/override table. M07 must understand this for the "assign status to campaign" workflow.

---

## 2. Existing Frontend Patterns

### 2.1 Admin Shell (M01)

**File:** `web/src/components/admin/AdminShell.tsx`

- Sidebar nav already includes entries for `statuses`, `pause-codes`, and `scripts` (lines 45–47):
  ```
  { key: "statuses", label: "Statuses", href: "/admin/statuses", minRole: "admin" },
  { key: "pause-codes", label: "Pause Codes", href: "/admin/pause-codes", minRole: "admin" },
  { key: "scripts", label: "Scripts", href: "/admin/scripts", minRole: "admin" },
  ```
- These are placeholders waiting for M07 page implementations.
- Layout: AdminShell (fixed sidebar 256px) + sticky top bar + scrollable `<main>` with 24px padding.
- Pattern: server component page → `<Suspense>` fallback → client list/table component.

### 2.2 Existing Scripts Pages (S03 partial implementation)

**Files already present:**
- `web/src/app/(admin)/admin/scripts/page.tsx` — list page (S03)
- `web/src/components/admin/ScriptList.tsx` — table with search/pagination
- `web/src/components/admin/ScriptForm.tsx` — create/edit form with textarea + variable sidebar
- `web/src/components/admin/ScriptPreview.tsx` — preview with sample lead input fields

**Current state of ScriptForm.tsx:** Uses a plain `<textarea>` with mono font for script body, NOT a rich-text editor. The existing code works with plain HTML typed by hand. M07 should upgrade the `body` field to a proper rich-text editor (Tiptap).

**Variable token syntax in ScriptForm.tsx (line 37–48):** Uses single-brace syntax `{lead.first_name}` not double-brace `{{lead.first_name}}`. The M07 spec sketch says `{{lead.field}}` — **this is a discrepancy**. The existing code and ScriptPreview use single braces. M07 PLAN must resolve: standardize on `{{double}}` (Handlebars-compatible, matches email template system) and document the migration.

**ScriptPreview.tsx render endpoint:** Calls `POST /api/admin/scripts/:id/render` — this API route does NOT yet exist in the admin routes index. M07 must implement it.

### 2.3 M04 Audit Log Pattern

**File:** `web/src/app/(admin)/admin/audit/page.tsx`

- Server component page with `<Suspense>` + skeleton fallback.
- Delegates to `<AuditLogTable />` client component.
- Table pattern: border-radius container, thead with muted bg, hover rows, pagination.

### 2.4 M02 Campaign Form Pattern (reference for status/script assignment)

The campaign form (M02) includes `scriptId` and `dialStatuses` fields. M07's status/script assignment UI should be reflected in campaign config — admins can either:
1. Manage statuses/scripts from the dedicated pages (M07), OR
2. Assign scripts to campaigns from the campaign edit form (M02 territory).

M07 owns the creation/editing; M02 owns the assignment.

### 2.5 Email Templates Pattern (N02 — closest analog to Scripts)

**Files:** `web/src/components/email-templates/`

The email template system (N02) provides a rich pattern for M07 scripts:
- `EmailTemplateForm.tsx` — form with rich textarea + variable sidebar
- `EmailTemplateList.tsx` — filterable table
- `VersionHistoryPanel.tsx` — version history panel (side drawer)
- `EmailTemplatePreview.tsx` — preview with sample data

M07 should follow the same component decomposition for scripts. The `VersionHistoryPanel` pattern is directly reusable.

---

## 3. Rich-Text Editor Decision: Tiptap

### 3.1 Availability Check

Running `grep -i tiptap /root/vici2/web/package.json` — **Tiptap is NOT installed** in the current `web/package.json`. The dependency list (confirmed 2026-05-13) contains:

```
next, react, react-dom, tailwindcss, zustand, zod, sip.js, lucide-react,
clsx, jose, class-variance-authority, tailwind-merge
```

No `@tiptap/*` packages present.

### 3.2 Recommendation: Install Tiptap

**Why Tiptap:**
- **License:** MIT. No licensing risk.
- **Headless:** Tiptap is a headless extension of ProseMirror. It ships no CSS, giving us full control over styling via Tailwind — consistent with the existing design system.
- **Accessibility:** Tiptap's ProseMirror core produces contenteditable elements with proper ARIA roles. The editor element receives `role="textbox"` and `aria-multiline="true"` automatically.
- **Placeholder extension:** `@tiptap/extension-placeholder` provides native placeholder support.
- **React integration:** `@tiptap/react` ships a `useEditor` hook and `<EditorContent>` component.
- **Existing ecosystem:** StarterKit includes Bold, Italic, Bullet List, Ordered List, Heading, Code, BlockQuote, HorizontalRule — sufficient for call scripts.
- **Custom extensions:** We can write a `PlaceholderToken` extension (not to be confused with the built-in Placeholder extension for empty-state text) that renders `{{lead.first_name}}` as a non-editable chip/mark in the editor. This is the primary M07-specific extension.

**Packages to add:**
```
@tiptap/react          — React bindings (useEditor, EditorContent)
@tiptap/starter-kit    — Bold, Italic, Lists, Heading, Code, etc.
@tiptap/extension-placeholder  — empty-state placeholder text
```

All three are MIT-licensed. No server-side dependencies needed.

**Alternative considered:** Quill (LGPL), Slate.js (MIT but lower-level, requires more boilerplate), Lexical (Meta, MIT). Tiptap was chosen because it's specifically designed for React + headless Tailwind, has the widest extension ecosystem, and the placeholder token chip pattern is well-documented in the Tiptap community.

**Note on existing ScriptForm.tsx:** The current textarea implementation is a working fallback. M07 replaces it with a Tiptap-based `ScriptEditor` component. The `body` field value must remain valid HTML (MediumText column), so Tiptap's `getHTML()` method is used on submit.

---

## 4. Placeholder System

### 4.1 Token Syntax

**Decision: standardize on `{{double-brace}}`.**

Rationale:
- Email template system (N02 / Handlebars) already uses `{{variable}}`.
- Double-brace avoids ambiguity with single-brace CSS/template literals in JSX.
- The existing `ScriptForm.tsx` (S03) used single-brace `{lead.first_name}` — this is an inconsistency introduced before M07 spec was locked. M07 introduces the canonical syntax and the service layer must be updated to match.
- Migration path: a one-time regex replacement in existing script bodies on deploy.

### 4.2 Lead Fields Available

Derived from `Lead` model fields (`api/prisma/schema.prisma` lines 723–784):

| Token | Lead Field | Type |
|---|---|---|
| `{{lead.first_name}}` | `firstName` | VARCHAR(64) |
| `{{lead.last_name}}` | `lastName` | VARCHAR(64) |
| `{{lead.phone}}` | `phoneE164` | VARCHAR(16) — E.164 format |
| `{{lead.phone_alt}}` | `phoneAlt` | VARCHAR(16) |
| `{{lead.email}}` | `email` | VARCHAR(128) |
| `{{lead.address1}}` | `address1` | VARCHAR(128) |
| `{{lead.address2}}` | `address2` | VARCHAR(128) |
| `{{lead.city}}` | `city` | VARCHAR(64) |
| `{{lead.state}}` | `state` | CHAR(2) |
| `{{lead.postal_code}}` | `postalCode` | VARCHAR(16) |
| `{{lead.country_code}}` | `countryCode` | CHAR(2) |
| `{{lead.title}}` | `title` | VARCHAR(8) |
| `{{lead.middle_initial}}` | `middleInitial` | VARCHAR(4) |
| `{{lead.gender}}` | `gender` | Enum M/F/U |
| `{{lead.date_of_birth}}` | `dateOfBirth` | Date |
| `{{lead.vendor_lead_code}}` | `vendorLeadCode` | VARCHAR(64) |
| `{{lead.source_id}}` | `sourceId` | VARCHAR(64) |
| `{{lead.comments}}` | `comments` | Text |
| `{{lead.custom.FIELD}}` | `customData[FIELD]` | JSON dynamic |

### 4.3 Agent / Call / Campaign Tokens

| Token | Source | Description |
|---|---|---|
| `{{agent.name}}` | `User.displayName` or `firstName + lastName` | Agent's display name |
| `{{agent.username}}` | `User.username` | Agent login ID |
| `{{campaign.name}}` | `Campaign.name` | Campaign display name |
| `{{call.uuid}}` | Active call UUID from FreeSWITCH channel | Unique call identifier |
| `{{call.duration}}` | Computed at render time | MM:SS elapsed |
| `{{call.start_time}}` | Call start ISO string | When the call began |
| `{{tenant.name}}` | `Tenant.name` | Tenant/company name |

### 4.4 Token Rendering / Substitution

The render endpoint (`POST /api/admin/scripts/:id/render`) substitutes tokens at call-time or preview-time:
- **Live call mode:** Receives `lead_id`, agent context, campaign context. Substitutes all known tokens.
- **Preview mode:** Receives an arbitrary JSON `sample` object. Unknown tokens are rendered as `[FIELD]` (bracketed, visually distinct).
- **Server-side sanitization:** DOMPurify or similar runs after Handlebars rendering to prevent XSS from lead data being injected into script HTML.

### 4.5 Tiptap PlaceholderToken Extension

A custom Tiptap `Mark` extension renders `{{lead.first_name}}` inside the editor as a non-editable styled chip:

```
Background: var(--color-brand-100)
Text: var(--color-brand-700)
Border-radius: 4px
Padding: 1px 4px
Font: monospace
```

The chip is atomic (not editable character by character). Clicking a token in the sidebar inserts it. Backspace removes the entire chip.

---

## 5. Per-Campaign vs. Global Scoping

### 5.1 Statuses

- **Global (system):** `campaignId = '__SYS__'`. Visible and selectable in all campaigns by default.
- **Per-campaign:** `campaignId = <real campaign_id>`. Visible only in that campaign's disposition picker.
- **Effective set for a campaign:** Global statuses + that campaign's own statuses.
- **`systemOwner` protection:** Any row with `systemOwner IS NOT NULL` cannot be deleted via admin UI (404-equivalent behavior). The API must enforce this.
- **Hotkey uniqueness:** Within `(tenantId, campaignId)` scope. The UI must validate hotkey conflicts on the client and the API must enforce with a unique constraint or pre-save check.
- **UI filter:** The list page should offer a "Scope" dropdown: `All | Global (__SYS__) | Campaign: <selector>`.

### 5.2 Pause Codes

- **Global:** `campaignId IS NULL`. Available to agents in all campaigns.
- **Per-campaign:** `campaignId = <real campaign_id>`. Visible only during that campaign.
- **Effective set:** Global codes + campaign-specific codes (union at call time).
- **No system protection:** All rows are user-managed; deletion is allowed (with confirmation).
- **Code uniqueness:** DB-level functional UNIQUE `(tenant_id, IFNULL(campaign_id, '__SYS__'), code)`. API must catch P2002.
- **`billable` flag:** Reported in metrics. Changing `billable` on an active code has immediate effect on subsequent pause sessions.

### 5.3 Scripts

- **Global:** `campaignId IS NULL`. Assignable to any campaign via `campaigns.scriptId`.
- **Per-campaign:** `campaignId = <real campaign_id>`. Logically scoped but can still be assigned via the campaigns.scriptId FK.
- **Active flag:** `active = false` hides from agent UI (A05). The list should show inactive scripts with a visual dimming (opacity-60, per ScriptList pattern).
- **Assignment:** M07 manages the script content. M02 (campaign form) manages which campaign has `scriptId` pointing to which script. M07's script list shows "Used by N campaigns" count.

---

## 6. Script Version History

### 6.1 Current Schema State

`ScriptVersion` table already exists (`api/prisma/schema.prisma` lines 674–690). S03 introduced it with a note to keep the last 10 versions per script. This means version history is a **Phase 1 feature**, not Phase 2. The N02 module provides a `VersionHistoryPanel` component pattern that M07 can directly follow.

### 6.2 Version History UI

The script editor page (`/admin/scripts/[id]`) should include a collapsible "Version History" panel (right sidebar or drawer):
- Lists up to 10 versions: version number, `savedAt` timestamp, body preview (first 120 chars).
- "Restore" button for each version: creates a new version with the old body (does not overwrite `version`).
- "Diff" view is Phase 2 (requires a diff library).

### 6.3 Version Pruning

On each script save, the service:
1. Creates a new `ScriptVersion` row.
2. Queries versions for this script ordered by version desc.
3. Deletes any version rows beyond the 10th.
All within a Prisma transaction.

---

## 7. Accessibility for Rich-Text Editor

### 7.1 Tiptap / ProseMirror Accessibility

- The ProseMirror editor div receives `role="textbox"`, `aria-multiline="true"`, and `contenteditable="true"` automatically.
- An associated `<label>` element must use `aria-labelledby` pointing to the editor div's `id` (Tiptap does not set `id` by default — must be set via `editorProps.attributes`).
- Toolbar buttons must have `aria-label`, `aria-pressed` (for toggles), and be keyboard-reachable (Tab sequence).
- The PlaceholderToken chips must be announced correctly: the extension's `renderHTML` method should include `aria-label="token: {{lead.first_name}}"`.

### 7.2 Placeholder Sidebar

- The variable sidebar is an `<aside>` with `aria-label="Variable reference"`.
- Each insert button: `aria-label="Insert {{lead.first_name}} — Lead's first name"`.
- Grouped by category (Lead fields, Agent fields, Campaign fields, Call fields) using `<h3>` headings within the aside.

### 7.3 Keyboard Navigation

- Tab into editor → full ProseMirror keyboard navigation (arrow keys, Home/End, etc.).
- Toolbar shortcuts: `Ctrl+B` bold, `Ctrl+I` italic, `Ctrl+Z` undo (all handled by StarterKit).
- Escape from token chip selection returns focus to surrounding text.

---

## 8. Open Questions

1. **Token syntax migration:** ScriptForm.tsx (S03) uses `{single_brace}` tokens. The M07 spec mandates `{{double_brace}}`. Who migrates existing script body data? Answer: M07 implementation should include a migration helper that runs once on startup (or a DB migration SQL UPDATE). Needs to be coordinated with the agent-side consumer (A05).

2. **Status category values:** `category` is `VARCHAR(20)` with no enum constraint. What are the valid values? The D04 amendment added it but didn't enumerate the allowed values in the schema. Suggested enum: `sale`, `not_interested`, `dnc`, `callback`, `machine`, `system`, `other`. The admin UI should present a dropdown.

3. **Hotkey conflict resolution across campaigns:** If campaign A has status X with hotkey `S` and global `__SYS__` also has hotkey `S`, which wins in the dispo picker? The current schema allows this. M07 should warn on save but not hard-block.

4. **Pause code "billable" definition:** What exactly is "billable" for agent pause time? Is it billable to the client (SLA), or billable to payroll? The metrics worker references it but the semantics aren't documented. Clarify before implementing reports.

5. **Script render endpoint:** Does `POST /api/admin/scripts/:id/render` exist yet? Based on the routes index (`api/src/routes/admin/index.ts`), no script routes are registered. The ScriptPreview component calls it but it's unimplemented. M07 must add this.

6. **Tiptap PlaceholderToken and HTML serialization:** When Tiptap serializes to HTML for storage in `body` (MediumText), the token chips must serialize back to the raw `{{lead.first_name}}` string, not as HTML `<span>` elements. The extension's `parseHTML` and `renderHTML` must handle this correctly so the stored body is clean for the Go render engine.

7. **Screen-reader announcement of PlaceholderToken chips:** contenteditable chip nodes are tricky for AT. Consider using `aria-label` on the chip element and ensuring the chip is not inside an `aria-hidden` container.

8. **Campaign ID selector for scoped records:** The "Campaign ID" field in the current ScriptForm.tsx is a free-text input. M07 should replace this with a `<select>` populated from `GET /api/admin/campaigns` (or an autocomplete combobox if tenant has many campaigns). Same applies to pause code and status campaign selectors.

9. **System-required status protection:** The API should refuse to delete rows where `systemOwner IS NOT NULL`. Should the UI show a lock icon on those rows? Yes — the table should render a lock badge and hide the delete action for system-owned rows.

10. **`CampaignStatusOverride` table and M07:** The M07 scope sketch does not mention this table. Per-campaign status configuration overrides (recycleDelay per campaign) are stored here. Should M07 surface this as an "Advanced" section on the status edit page? Recommend: Phase 2 — show the override table only in campaign-specific status context.
