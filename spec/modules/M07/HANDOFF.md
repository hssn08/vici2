# M07 Handoff — Admin: Pause Codes + Statuses + Scripts

> Status: STUB — to be completed by implementation agent after code merge.

## Public Interfaces

### Token / Placeholder Syntax

- **Canonical:** `{{double_brace}}` (Handlebars-compatible, matches N02 email template system)
- **Legacy (S03):** `{single_brace}` — deprecated; migration SQL required on deploy

### Available Tokens

| Namespace | Example |
|---|---|
| Lead fields | `{{lead.first_name}}`, `{{lead.city}}`, `{{lead.custom.FIELD}}` |
| Agent fields | `{{agent.name}}`, `{{agent.username}}` |
| Campaign fields | `{{campaign.name}}` |
| Call fields | `{{call.uuid}}`, `{{call.duration}}`, `{{call.start_time}}` |
| Tenant fields | `{{tenant.name}}` |

Full token vocabulary: see `PLAN.md §4.2` and `PLAN.md §4.3`.

### API Surface

| Endpoint | Purpose |
|---|---|
| `GET /api/admin/pause-codes` | List pause codes |
| `POST /api/admin/pause-codes` | Create pause code |
| `PATCH /api/admin/pause-codes/:id` | Update pause code |
| `DELETE /api/admin/pause-codes/:id` | Delete pause code |
| `GET /api/admin/statuses` | List statuses |
| `POST /api/admin/statuses` | Create status |
| `PATCH /api/admin/statuses/:campaignId/:code` | Update status |
| `DELETE /api/admin/statuses/:campaignId/:code` | Delete status |
| `GET /api/admin/scripts` | List scripts |
| `POST /api/admin/scripts` | Create script |
| `PATCH /api/admin/scripts/:id` | Update script (bumps version) |
| `DELETE /api/admin/scripts/:id` | Soft-delete script |
| `GET /api/admin/scripts/:id/versions` | List version history (max 10) |
| `POST /api/admin/scripts/:id/restore/:version` | Restore to prior version |
| `POST /api/admin/scripts/:id/render` | Render script with sample data |

### Downstream Consumers

| Consumer | What it uses |
|---|---|
| A09 (Agent Pause UI) | Reads `GET /api/admin/pause-codes` filtered by `campaignId` |
| A06 (Dispo Screen) | Reads statuses for agent's current campaign |
| A05 (Agent Script Panel) | Reads `GET /api/admin/scripts/:id` and renders body via `POST /api/admin/scripts/:id/render` |
| M02 (Campaign Config) | Assigns `scripts.id` to `campaigns.scriptId` |

### RBAC Verbs

All verbs were pre-defined in `shared/types/src/rbac.ts` — no changes required:
- `status:read` / `status:edit`
- `pause-code:read` / `pause-code:edit`
- `script:read` / `script:edit`

### Audit Actions Added

Added to `api/src/auth/audit.ts`:
- `pause_code.created`, `pause_code.updated`, `pause_code.deleted`
- `status.created`, `status.updated`, `status.deleted`
- `script.created`, `script.updated`, `script.deleted`, `script.restored`

### Tiptap Integration

- Packages: `@tiptap/react`, `@tiptap/starter-kit`, `@tiptap/extension-placeholder` (all MIT)
- Custom extension: `PlaceholderToken` Mark — renders `{{token}}` as non-editable chip in editor
- HTML storage: `scripts.body` (MediumText) stores Tiptap `getHTML()` output
- Render pipeline: service strips token chip span wrappers, interpolates variables via Handlebars

## Known Limitations (Phase 1)

- `CampaignSelect` is limited to 200 campaigns per tenant (fixed `pageSize=200`).
- Version diff view not implemented (Phase 2).
- `CampaignStatusOverride` table (per-campaign recycle delay overrides) not surfaced in UI (Phase 2).
- Single-brace → double-brace script body migration must be run manually on deploy.
