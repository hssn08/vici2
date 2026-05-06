## Module
<!-- Required. Format: <ID> — <Name>, e.g. F01 — Repo skeleton + dev environment -->

## Summary
<!-- 3 bullets max -->

-
-
-

## Acceptance checklist (from spec)
<!-- Copy from spec/modules/<id>.md -->

- [ ]
- [ ]

## Test plan
- [ ] Unit tests pass: `make test`
- [ ] Integration tests pass: `<command>`
- [ ] Manual verification recorded in `spec/modules/<id>/VERIFY.md`
- [ ] Coverage ≥ 70% on new code (≥ 90% for compliance / dialer pacing)

## Handoff
- [ ] `spec/modules/<id>/HANDOFF.md` updated
- [ ] OpenAPI updated (if API surface changed)
- [ ] Event schema updated (if events added/changed)
- [ ] Migrations reversible (every `up` has a `down`)

## Compliance impact
- [ ] No PII logged (no phone-number lists in bulk, no JWTs, no SIP passwords)
- [ ] No secrets committed
- [ ] DNC / time-zone gates not weakened
- [ ] Recording-consent path (if any) preserved
