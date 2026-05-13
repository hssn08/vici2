# N02 — Email Template System — RESEARCH

| Field | Value |
|---|---|
| **Module** | N02 — Email Template System |
| **Author** | N02-PLAN agent (Claude Sonnet 4.6) |
| **Date** | 2026-05-13 |
| **Status** | RESEARCH |
| **Informs** | N02/PLAN.md |

---

## 0. Context and scope

N01 ships a plain-text email body to the `vici2:queue:email-delivery` BullMQ worker as a raw string. The worker calls nodemailer with that string as the text body. Phase 1 of N01 explicitly deferred "rich HTML email templates" to Phase 2. N02 is that Phase 2 work: a tenant-editable, per-category, multi-language email template system that the N01 email-delivery worker calls instead of passing raw strings.

Phase 1 scope for N02 is **7 system categories** (the same 7 as N01: `callback_due`, `callback_upcoming`, `import_complete`, `import_failed`, `recording_failed`, `agent_disconnected`, `drop_gate_engaged`). Marketing blast / outbound campaigns are Phase 3.

---

## 1. Email template engine options

### 1.1 Candidate summary

| Engine | Role | Size | Notes |
|---|---|---|---|
| **Handlebars** | Variable interpolation + layout logic | 56 KB minified | Widely known, stable, safe helper system, compiles templates |
| **Liquid (liquidjs)** | Interpolation + logic | 80 KB | Shopify-style; Liquid's tag isolation is strong but admin-users already know Handlebars from S03 patterns |
| **MJML** | Responsive HTML-to-email transpiler | 1.5 MB | Converts `<mj-*>` markup to table-based responsive HTML compatible with Outlook 2016+ |
| **Maizzle** | Tailwind-based email framework | Build-time only | Compile-time tool; not suitable for runtime rendering of user-edited templates |
| **Pug / EJS** | General HTML templating | Small | No email-specific responsive primitives; arbitrary JS execution risk with Pug |

### 1.2 Recommendation: Handlebars + MJML hybrid

**Decision: Handlebars for variable interpolation (syntax layer) applied to pre-compiled MJML HTML (layout layer).**

Rationale:

- **MJML at seed time.** The 7 default templates are authored in MJML and pre-compiled to table-based HTML once at seed time (or during a build step). The resulting HTML is stored in `html_body`. Tenant admins then edit the compiled HTML, not raw MJML — no MJML dependency at runtime.
- **Handlebars at render time.** When the email-delivery worker fetches a template, it calls `Handlebars.compile(template.html_body)(vars)` (and separately `Handlebars.compile(template.text_body)(vars)`) to interpolate variables. The worker never executes arbitrary MJML.
- **Why not Handlebars-only with baseline HTML?** MJML seed templates give the shipped defaults a professional, mobile-responsive appearance at no operational cost (one-time compile step). Baseline `<table>` HTML written by hand in the seed is unreliable across mail clients (Outlook, Apple Mail, Gmail webmail all disagree on CSS support).
- **Why not Liquid?** No material advantage over Handlebars for this use case; Handlebars aligns with patterns already established by S03 (call scripts), reducing cognitive load for the full-stack team.
- **Variable syntax.** Handlebars uses `{{variable}}` with double-curly braces. This is a **different syntax** from S03's `{variable}` single-curly (S03 uses a custom regex engine, not Handlebars). The interpolation engines coexist without conflict; N02 uses the npm `handlebars` package for correctness and precompilation benefits.

### 1.3 Helper freeze policy

Handlebars supports custom helpers (e.g., `{{formatDate callback.scheduled_at_local}}`). N02 ships a **frozen safe-helpers list** — only helpers defined in `api/src/email-templates/helpers.ts` are registered. No user-defined helpers are ever compiled. This eliminates the risk of calling `require`, `exec`, or other Node built-ins through a malicious helper name.

Frozen built-in helpers shipped with N02:

| Helper | Signature | Description |
|---|---|---|
| `formatDate` | `{{formatDate iso8601 "MMMM D, YYYY h:mm A z"}}` | Format a date string; uses `date-fns` (already in monorepo) |
| `phoneFormat` | `{{phoneFormat e164}}` | Format E.164 as National notation; uses `libphonenumber-js/min` (already in monorepo) |
| `ifEq` | `{{#ifEq a b}}...{{/ifEq}}` | Simple equality block helper |
| `upper` | `{{upper str}}` | Uppercase a string |
| `truncate` | `{{truncate str 100}}` | Truncate with ellipsis at n chars |

---

## 2. Plain text fallback

### 2.1 Options

| Approach | Pros | Cons |
|---|---|---|
| **Auto-generate via `html-to-text`** | Single source of truth; always in sync | Some rendering nuance lost (table-to-text is imperfect) |
| **Maintain separate text body** | Full control over tone and structure | Two bodies to keep in sync; admin must update both |
| **Auto-generate but allow override** | Best of both; sync by default, override when needed | Slight schema complexity (need `text_body_override` flag) |

### 2.2 Recommendation: auto-generate on save, stored as `text_body`

The `html-to-text` npm package (v9, ESM-compatible, actively maintained) converts HTML to well-formed plain text with configurable table rendering, link annotation, and word-wrap. N02 runs it server-side at template save time and stores the result in `text_body`. Admins can then edit `text_body` independently after save if they wish — there is no `override` flag because the column is always editable directly.

Re-generation trigger: any PATCH to `html_body` regenerates `text_body` unless the PATCH body also includes an explicit `text_body` field.

`html-to-text` configuration for email:
```ts
convert(html, {
  wordwrap: 76,
  selectors: [
    { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
    { selector: 'img', format: 'skip' },
    { selector: 'table', options: { uppercaseHeaderCells: false } },
  ],
})
```

---

## 3. Internationalization (i18n)

### 3.1 Problem

A single tenant may serve multiple languages (e.g., US Spanish-speaking leads, French-Canadian agents). System email notifications go to staff users (not leads), so the relevant locale is the **user's preferred language**, not the lead's.

### 3.2 Approach: compound key (category × lang)

Each template row has a `lang` column (BCP 47 language tag, default `"en"`). The render lookup is:

```
SELECT * FROM email_templates
WHERE tenant_id = ? AND category = ? AND lang = ? AND active = TRUE
```

Fallback chain: requested lang → `"en"` → hard-coded fallback string. Missing translations silently fall back to English. N01's `notify()` call does not currently carry a user locale; N02 adds a `lang` parameter to `renderEmail()` which N01 passes via `user.preferredLang ?? "en"`. The `users` table does not currently have `preferred_lang`; N02 adds that column in its migration (VARCHAR(10), default `"en"`).

### 3.3 Phase 1 scope

Phase 1 seeds English-only templates. The schema supports multiple languages from Day 1 to avoid a breaking migration when Phase 2 adds Spanish (`es`) templates.

---

## 4. Preview and test-send UX

### 4.1 Preview

The admin UI includes a live preview panel that calls `POST /api/admin/email-templates/:id/preview` with a `sample_vars` JSON body containing placeholder variable values. The server renders the template with those vars and returns `{ subject: string, html: string, text: string }`. The UI renders the `html` in a sandboxed `<iframe srcdoc="...">` (no JavaScript execution, no external resource loads via CSP sandbox attribute).

Template variables not present in `sample_vars` are replaced by a highlighted `[MISSING: {{var}}]` span in preview mode (distinct from render mode which replaces unknowns with `""`).

### 4.2 Test-send

`POST /api/admin/email-templates/:id/test-send` accepts `{ to: string, sample_vars: Record<string, unknown> }`. The server renders the template with `sample_vars`, then enqueues a high-priority BullMQ job on `vici2:queue:email-delivery` with `isTestSend: true`. The worker sends to the `to` address. Test-sends bypass user pref lookup and do not create a `notifications` row. Rate-limited to 5 test-sends per admin per hour (Valkey counter, same pattern as N01 rate limits).

---

## 5. Spam safety: SPF / DKIM / DMARC

### 5.1 Infrastructure recommendations

N02 does not configure DNS records itself — that is the operator's responsibility. The PLAN documents the **required setup** in an Operator Checklist section.

**SPF:** The tenant's `notifications@<tenant-domain>` sender domain must publish an SPF TXT record including the MTA's IP. N01 uses `VICI2_SMTP_FROM` which the operator controls. Phase 2 recommendation: lock `From` to `notifications@<tenant-domain>` derived from a `tenant.notification_domain` column (added Phase 2).

**DKIM:** Phase 1 recommends operators use a sending provider (Mailgun, SES, Postmark) that handles DKIM signing automatically. If using raw SMTP (`nodemailer`), the operator must configure DKIM signing keys in `VICI2_SMTP_DKIM_*` env vars (nodemailer supports DKIM via `dkim` transport option). N02 adds `VICI2_SMTP_DKIM_DOMAIN`, `VICI2_SMTP_DKIM_SELECTOR`, `VICI2_SMTP_DKIM_PRIVATE_KEY` to `.env.example`.

**DMARC:** Operator publishes a `_dmarc.<tenant-domain>` TXT record. Recommended policy for Phase 1: `v=DMARC1; p=none; rua=mailto:dmarc-rua@<tenant-domain>` (monitoring mode). Tighten to `p=quarantine` or `p=reject` once volume is established and alignment verified.

**From address:** `VICI2_SMTP_FROM` defaults to `"Vici2 Notifications <notifications@example.com>"`. Per-category override is Phase 2.

**List-Unsubscribe header:** System notification emails MUST include `List-Unsubscribe` and `List-Unsubscribe-Post` headers (RFC 8058, required by Gmail/Yahoo bulk sender policy as of Feb 2024). Phase 1 implementation: a one-click unsubscribe link to `GET /api/notifications/unsubscribe?token=<hmac-token>&category=<cat>` which updates `notification_prefs` to `channels: ["in_app"]` for that category. The token is `HMAC-SHA256(userId + ":" + category + ":" + expiresAt, VICI2_NOTIFICATION_UNSUBSCRIBE_SECRET)` and is valid for 90 days.

---

## 6. Tracking pixels / open-tracking (Phase 2)

### 6.1 Privacy concerns

Email open tracking via a 1×1 tracking pixel is blocked by default by Apple Mail Privacy Protection (iOS 15+, macOS Monterey+), Gmail (proxies images), and most privacy-focused clients. The open rate metric is therefore **unreliable** even when implemented.

More importantly:

- GDPR Art. 13/14 requires disclosure of tracking in privacy notice.
- CASL (Canada) treats tracking pixels as electronic address "harvesting" for IP geolocation.
- TCPA class actions have cited tracking pixels in claims about consent scope.

**Decision: tracking pixels deferred to Phase 2 (marketing blast templates) and will be opt-in per tenant with explicit consent checkbox in the UI.**

Phase 1 system emails: no tracking pixel, no click-through redirector. Plain href links in templates point directly to the destination.

---

## 7. Reuse patterns from S03

S03 (call script management) establishes patterns N02 reuses:

| Pattern | S03 source | N02 reuse |
|---|---|---|
| Versioned body with `version` + `_versions` table | `scripts` + `script_versions` | `email_templates` + `email_template_versions` (identical shape) |
| Sanitize-html allowlist | `api/src/scripts/sanitize.ts` | Extended for email-safe HTML (adds `img` with allow-listed hosts, `table`/`tr`/`td` already there) |
| `active` boolean soft-delete | `Script.active` | `EmailTemplate.active` |
| Admin UI edit page with live preview | `ScriptPreview.tsx` | `EmailTemplatePreview.tsx` (uses iframe instead of div, sandboxed) |
| `script:read` / `script:edit` RBAC verb pattern | `shared/types/src/rbac.ts` | New `email_templates:read` + `email_templates:edit` verbs, same hierarchy |
| Seed in `prisma/seed.ts` | 3 script starters | 7 email templates (one per category, English) |

Key **differences** from S03:

- Token syntax: N02 uses `{{variable}}` (Handlebars) vs S03's `{variable}` (custom regex). They coexist; both are server-side.
- N02 templates have two renderable bodies (`html_body` + `text_body`); scripts have one (`body`).
- N02 has a `lang` column; scripts are language-agnostic.
- N02 templates are per-tenant per-category (not per-campaign).
- N02 sanitize allowlist adds `img` (for logos in HTML email) with an `src` pattern allowlist.

---

## 8. Sanitize-html allowlist extension for email

Base: the S03 allowlist (from `api/src/scripts/sanitize.ts`).

Extensions for email HTML:

```
Added allowed tags:
  img         — for tenant logo / branding
  center      — legacy email centering
  font        — legacy email font control (Outlook compat)
  table, thead, tbody, tr, th, td — already in S03 base

Added allowed attributes:
  img:
    src       — must match /^https?:\/\/[a-zA-Z0-9._-]+\// (no data: URLs)
    alt       — any string
    width, height, border — numeric
    style     — restricted CSS property list (only: display, max-width)
  table, td, th:
    align, valign, cellpadding, cellspacing, border — Outlook compat
    bgcolor   — legacy background color
    width, height — numeric
  center:    (no attributes)
  font:
    color, face, size — legacy
```

`javascript:` URLs and `data:` URLs are still blocked for all attributes. `on*` event handlers blocked globally.

---

## 9. Open questions

1. **`users.preferred_lang` column:** N02's migration adds this. Does any other module need it first? (No current dependency found — safe to add here.)
2. **Tenant notification domain:** Phase 1 uses `VICI2_SMTP_FROM` globally. Is per-tenant `From` address needed before Phase 3 marketing blast? Recommendation: add `tenant.notification_email_from` (nullable, fallback to env var) in Phase 2 alongside DKIM support.
3. **Template category extension:** When a new notification category is added (e.g., N05 SMS module adds `sms_opt_out_confirmed` email notice), does that require an RFC? Recommendation: yes, because a new category requires a new frozen variable vocabulary entry.
4. **HTML email size limit:** Gmail clips emails > 102 KB rendered. MJML-compiled templates for the 7 system categories are all well under 30 KB. Admin-edited templates have no enforced size limit in Phase 1; consider a 90 KB soft warning in the UI editor (Phase 2).
5. **Attachment support:** Out of scope Phase 1. Phase 3 (blast) may need PDF attachments (e.g., contract documents). N01's nodemailer transport supports `attachments`; N02 template schema has no attachment metadata yet.
6. **Unsubscribe secret env var:** `VICI2_NOTIFICATION_UNSUBSCRIBE_SECRET` — needs to be added to `.env.example` and documented in the operator checklist. If this key is rotated, all outstanding unsubscribe links become invalid (by design: links expire after 90 days anyway).
7. **Integration with Phase 3 marketing blast:** Phase 3 will add `blast` as a new category group with different variable vocabularies (lead fields, not user fields). N02 schema should be forward-compatible (no structural changes needed; new categories + new lang seeds).
