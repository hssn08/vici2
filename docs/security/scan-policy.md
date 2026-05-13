# vici2 Security Scan Policy

**Version:** 1.0 (O05 Phase 1)
**Date:** 2026-05-13
**Owner:** Security / O05

---

## 1. Severity Thresholds

### Container / Image Scanning (Trivy)

| Severity | PR Action | Merge Action |
|---|---|---|
| CRITICAL | **Blocks PR** | Must be resolved before merge |
| HIGH | **Blocks PR** | Must be resolved or waived before merge |
| MEDIUM | Annotates PR (SARIF in Security tab) | Does not block |
| LOW | Informational | Tracked in maintained issue |

### Dependency Audits (govulncheck, pnpm audit)

| Finding type | Action |
|---|---|
| Go vuln in a **called** function | **Blocks PR** (govulncheck call-graph aware) |
| Go vuln in uncalled path | Warning comment; tracked in issue |
| Node HIGH+ in production deps | **Blocks PR** (`pnpm audit --prod --audit-level=high`) |
| Node HIGH+ in dev deps only | Warning; does not block |
| Node MODERATE and below | Tracked in Dependabot PRs; auto-merge patch |

### OWASP ZAP Baseline

| Severity | PR Action | Nightly Action |
|---|---|---|
| CRITICAL (new finding) | **Blocks PR** | Pages on-call |
| HIGH (new finding) | **Blocks PR** | Pages on-call |
| MEDIUM (new finding) | PR comment; does not block | Updates maintained issue |
| LOW / INFO (new finding) | Informational | Updates maintained issue |
| Known FP (in rules.tsv) | IGNORED | IGNORED |

---

## 2. Waiver Process

### Trivy Waivers (.trivyignore)

1. File a GitHub PR that adds an entry to `.trivyignore`
2. PR must include:
   - CVE ID
   - Affected package and version
   - Waived-until date (max 90 days without re-review)
   - Ticket link explaining why waiver is justified
   - Example: `# CVE-2026-1234 waived-until:2026-08-01 ticket:#456 reason:no fix available, not in call path`
3. **CODEOWNERS approval required**: security team member must approve
4. Waivers are time-limited; GitHub Actions will surface expired waivers in weekly Trivy run

### ZAP Waivers (.zap/rules.tsv)

Same process as Trivy waivers. Entry format:
```
<plugin-id>	IGNORE	CVE:<id> waived-until:<date> ticket:<url> reason:<text>
```

---

## 3. Maintained "Open Security Findings" Issue

A pinned GitHub issue (label: `security/open-findings`) tracks:
- CodeQL findings at WARN/INFO level
- Trivy MEDIUM/LOW findings (not yet waivers, not yet fixed)
- ZAP MEDIUM/LOW baseline findings

The issue is auto-updated by nightly CI runs. Security team reviews weekly.

---

## 4. Pen-Test Schedule

- **Cadence:** Annual + after any major release involving auth, encryption, or telephony changes
- **Vendor:** Operator-selected (Phase 1+); budget: $15,000–$30,000 per test (DESIGN §20.1)
- **Scope:** Full application stack (API, agent UI, admin UI, SIP surface)
- **Timing:** Before serving healthcare or financial customers (Phase 4 prerequisite)
- **Type:** Black-box baseline scan + grey-box authenticated test; active ZAP full-scan runs pre-release
- **Output:** Pentest report stored in private repo; findings tracked as P2 incidents

---

## 5. Dep Review / License Policy

Enforced by `actions/dependency-review-action` on every PR:

**Allowed licenses:** MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, MPL-2.0, Unlicense, 0BSD, CC0-1.0

**Denied licenses:** GPL-2.0, GPL-3.0, AGPL-3.0, LGPL-2.0, LGPL-3.0, SSPL-1.0

Any new dependency with a denied license blocks the PR.

---

## 6. Action SHA Pinning Policy

All GitHub Actions `uses:` directives must be pinned to a 40-character commit
SHA. Tag-only references (e.g., `@v4`, `@main`) are blocked by the CI guard.
`pinact` runs as a pre-commit hook to enforce this automatically.

Rationale: Prevents supply-chain attacks (Tj-Actions style) where a tag is
moved to malicious code after initial approval.
