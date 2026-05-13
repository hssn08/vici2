# M05 — Unified Settings Panel — PLAN

**Module:** M05 (Admin UI track, Phase 1)
**Author:** M05-IMPLEMENT agent
**Date:** 2026-05-13
**Status:** IMPLEMENTED
**Depends on:** F02, F05, M01, C02, D05, O03

---

## 0. TL;DR

M05 replaces the single-form `/admin/settings` page (M01) with a multi-tab
settings panel covering all per-tenant config in one unified surface. The
existing `GET /api/admin/settings` + `PATCH /api/admin/settings` API is
**extended** (additive — no breaking changes to M01 contracts). A new tab
component drives the UI; each tab maps to a logical category of settings.

---

## 1. Goal

Unify all scattered per-tenant config into one admin page at
`/admin/settings`. Phase 1 delivers six tabs:

| Tab key | Settings surfaced |
|---------|------------------|
| **general** | tenant name, timezone, locale, support email, brand label |
| **auth** | session TTLs, lockout thresholds, password min length, MFA toggle |
| **compliance** | recording consent mode (C02), DNC retention years (D05), TCPA unknown_tz_policy default, caller state |
| **telephony** | default caller_id, max concurrent calls placeholder |
| **observability** | link shortcut to /admin/alert-receivers (O03) |
| **pacing** | campaign dial_method default, drop_target_max default |

Notifications (SMTP display) and Recordings (storage backend) are deferred to
Phase 2 — the tabs are designed to be addable without touching the API shape.

---

## 2. API changes (additive)

### 2.1 Extended GET /api/admin/settings response

New fields added to `TenantSettingsResponse`:

```ts
// General
timezone: string;           // IANA tz (stored in settings.reportTimezone)
supportEmail: string | null;

// Auth (from auth_config row — ID=1; Phase 1 reads defaults from DB if row exists)
auth: {
  passwordMinLength: number;
  lockoutAfterFailures: number;
  lockoutWindowSeconds: number;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  totpGracePeriodDays: number;
};

// Compliance
consentMinimumMode: ConsentMode;       // C02 tenants column
defaultCallerState: string | null;    // C02 tenants column
internalDncRetentionYears: number;    // D05 tenants column (already in M01)
unknownTzPolicyDefault: UnknownTzPolicy;   // stored in settings JSON

// Pacing defaults
pacingDefaults: {
  dialMethod: DialMethod;     // stored in settings JSON
  dropTargetMax: number;      // stored in settings JSON
};
```

### 2.2 Extended PATCH /api/admin/settings body

New optional fields in `TenantSettingsUpdateSchema`:

```ts
settings?: {
  brandLabel?: string;
  reportTimezone?: string;         // kept for backward compat
  supportEmail?: string;
  unknownTzPolicyDefault?: 'deny' | 'warn_pass';
  pacingDefaults?: { dialMethod?: string; dropTargetMax?: number };
};
auth?: {                           // only super_admin can patch auth fields
  passwordMinLength?: number;      // min 8, max 128
  lockoutAfterFailures?: number;   // min 3, max 20
  lockoutWindowSeconds?: number;   // min 60, max 86400
  accessTokenTtlSeconds?: number;  // min 60, max 3600
  refreshTokenTtlSeconds?: number; // min 3600, max 7776000
  totpGracePeriodDays?: number;    // min 0, max 30
};
consentMinimumMode?: ConsentMode;
defaultCallerState?: string | null;
// internalDncRetentionYears kept at top-level (M01 compat)
```

### 2.3 Audit action

New action string `"tenant.settings.updated"` added to `AuditAction` union.

### 2.4 RBAC split

- `GET /api/admin/settings` — requires `tenant:read` (admin + super_admin)
- `PATCH /api/admin/settings` — requires `tenant:edit` (super_admin only per
  SENSITIVE_VERBS); auth sub-object additionally gated by role check (only
  super_admin may touch auth_config row)

---

## 3. Schema (no migration needed)

M05 reads/writes:
- `tenants.name`, `tenants.settings` (JSON), `tenants.internalDncRetentionYears`
- `tenants.consentMinimumMode`, `tenants.defaultCallerState` (C02 columns — already present)
- `auth_config` row ID=1 (A3 amendment — already present; M05 reads/writes it)

No new columns. The `auth_config` row is upserted on first write if absent.

---

## 4. File map

### 4.1 API (extend existing files)

```
api/src/routes/admin/settings/schema.ts     — extend Zod schemas
api/src/routes/admin/settings/index.ts      — extend GET + PATCH handlers
api/src/auth/audit.ts                       — add tenant.settings.updated action
```

### 4.2 Web UI (new files)

```
web/src/app/(admin)/admin/settings/page.tsx         — replace with tabbed shell
web/src/components/admin/settings/                  — new directory
  SettingsTabs.tsx                                  — tab switcher (WCAG 2.2 AA)
  GeneralTab.tsx                                    — general settings form
  AuthTab.tsx                                       — auth/session settings form
  ComplianceTab.tsx                                 — compliance settings form
  TelephonyTab.tsx                                  — telephony settings form
  ObservabilityTab.tsx                              — observability (link card)
  PacingTab.tsx                                     — pacing defaults form
  shared.tsx                                        — shared FieldGroup, SectionHeading
```

---

## 5. Validation rules (Zod refinements)

- `auth.lockoutWindowSeconds < auth.accessTokenTtlSeconds` — lockout window
  must be shorter than access token TTL or the check is meaningless.
- `auth.accessTokenTtlSeconds <= auth.refreshTokenTtlSeconds` — access token
  cannot outlive refresh token.
- `internalDncRetentionYears >= 5` — FCC floor (47 C.F.R. §64.1200(d)(6)).
- `dropTargetMax <= 3.00` — FCC TCPA abandoned call ceiling.
- `defaultCallerState` must be null or a valid 2-letter US state code (if set).

---

## 6. A11y

- Tab panel uses `role="tablist"` + `role="tab"` + `role="tabpanel"` per
  ARIA Authoring Practices Guide §3.22.
- Each tab panel is labelled with `aria-labelledby`.
- Keyboard: Arrow keys navigate tabs; Enter/Space activate.
- All form fields have explicit `<label>` with `htmlFor` or `aria-label`.
- Error messages wired via `aria-describedby`.
- Sensitive masked fields show `aria-label="Masked value — click to reveal"`.

---

## 7. Sensitive fields (Phase 1)

`auth_config` values are displayed normally (they are policy numbers, not
secrets). The "masked" display treatment (*** + rotate button) is reserved for
Phase 2 KEK rotation UI (`kek_version`, `signing_key_id`). This simplifies
Phase 1 without compromising security.

---

## 8. Test coverage

```
api/test/admin/settings.schema.test.ts   — extend existing (new fields)
api/test/admin/settings.m05.test.ts      — new: auth sub-object, compliance fields,
                                           cross-field refinements
```

---

## 9. Non-goals (Phase 2)

- SMTP config display (env-only, no edit)
- Recordings storage backend (s3/r2/b2/minio selector)
- KEK rotate button
- Per-tab save (single "Save" per tab is Phase 1)
- Dark-mode preview inside settings panel
