# vici2 Incident Response Plan

**Version:** 1.0 (O05 Phase 1)
**Date:** 2026-05-13
**Owner:** Security / O05
**Terse operator checklist:** `spec/runbooks/security-incident.md`

---

## 1. Severity Classification

| Severity | Definition | SLA | Examples |
|---|---|---|---|
| **P0 — Active Breach** | Confirmed unauthorized access, active data exfiltration, or active system compromise | Incident commander engaged <15min; all hands | KEK/JWT key leak with active exploitation; unauthorized carrier usage; agent account takeover with active calls |
| **P1 — Suspected Breach** | Credible evidence of compromise but not confirmed | IC engaged <1h; initial assessment <4h | Anomalous API access pattern; unusual fail2ban surge; unexpected carrier CDR volume; threat intel tip |
| **P2 — Hardening Gap** | Vulnerability found, not actively exploited | Assessment within 1 business day | Trivy HIGH finding on prod image; ZAP CRIT in baseline; outdated dependency with known CVE |

---

## 2. Roles

| Role | Responsibility | Who |
|---|---|---|
| **Incident Commander (IC)** | Declares severity; coordinates response; owns communication; calls all-clear | On-call senior engineer (rotating schedule per O01) |
| **Scribe** | Real-time log of all actions, timestamps, and decisions in the incident channel | Second on-call or duty engineer |
| **SME — Security** | Technical investigation, forensics, patch | Security team lead or designated engineer |
| **SME — Telephony** | FS/SIP impact, carrier notification | F03 maintainer |
| **SME — Database** | MySQL forensics, KEK rotation | F02/F05 maintainer |
| **Communications lead** | Operator/customer notifications; status page updates | IC or designated comms |

---

## 3. Communication Channels

| Channel | Purpose |
|---|---|
| `#sec-ir-active` (Slack, private, invite-only) | Primary incident channel; restrict to responders + IC |
| `#sec-ir-log` (Slack) | Auto-forwarded timeline from Scribe; public post-mortem seed |
| PagerDuty escalation | IC rotation, on-call paging |
| Status page | Operator-visible incident updates (status.vici2.example.com) |
| Secure email | Regulatory notification if PII/PHI breach confirmed |

**Communication rule:** Do NOT discuss the active incident in public Slack channels, GitHub issues, or any channel that logs to external systems until IC declares all-clear and post-mortem scope is defined.

---

## 4. Containment Playbooks

### 4.1 JWT Key Compromise

**Symptoms:** Anomalous API access using valid JWTs; JWT issued after key compromise confirmed.

**Containment steps:**

1. **Preserve evidence first** — snapshot MySQL `audit_event` rows for the affected time window before any key rotation evicts them.
2. Rotate `VICI2_JWT_PRIVATE_KEY_JWK`: generate new EdDSA key pair per F05 `make gen-jwt-keys`.
3. Add new public key to `VICI2_JWT_PUBLIC_KEYS_JWKS` (multi-key JWKS for grace period).
4. Rolling restart API service to pick up new signing key.
5. Revoke all active refresh tokens: `valkey-cli FLUSHDB 0` (invalidates all refresh tokens — forces all users to re-login).
6. Remove old public key from JWKS after 15-minute grace period (access token TTL).
7. Emit `audit_event (kind='security.jwt.emergency_rotation', actor='ops', payload=...)`.
8. Investigate how key was leaked (log scrape, env dump, insider) — add to post-mortem.

**Rollback:** If new key causes auth failures, re-add old public key to JWKS temporarily; investigate root cause before re-rotating.

---

### 4.2 KEK Compromise

**Symptoms:** KEK env var suspected leaked (exposed in logs, CI secrets, insider access, contributor offboarding).

**Containment steps (emergency — skip the 30-day wait from the routine runbook):**

1. **Preserve evidence** — snapshot encrypted columns and `audit_event` before any rotation.
2. Notify all on-call SMEs; declare P0 if active exploitation is suspected.
3. Follow `spec/runbooks/kek-rotation.md` steps 1–8 with `EMERGENCY=true` flag (skip step 7 wait).
4. After rotation confirmed complete (step 6 verification), force-reset all agent SIP passwords (per-agent SIP creds were encrypted with the old KEK).
5. Rotate carrier credentials (encrypted as `carrier_gateways.password_ct` with old KEK).
6. Emit `audit_event (kind='security.kek.emergency_rotation')`.
7. Archive old KEK to vault cold storage even in emergency (forensic backup decrypt may need it).

**SLA:** All rows rewrapped within 24h of suspected leak.

---

### 4.3 SIP Credentials Compromise (Single Agent)

**Symptoms:** Unauthorized calls appearing in CDR for a specific agent; unexpected REGISTER from unknown IP.

**Containment steps:**

1. Identify affected agent via CDR / `audit_event` (extension, SIP username).
2. Via admin API: `POST /admin/agents/{id}/rotate-sip-credentials` (F05 admin endpoint) — generates new SIP password immediately.
3. Force FS re-registration: `fs_cli -x "sofia profile internal flush_inbound_reg <user>@<domain>"`.
4. Add compromised source IP to fail2ban ban list: `fail2ban-client set freeswitch banip <IP>`.
5. Review CDR for all calls by that agent in the compromise window; identify toll-fraud calls.
6. Notify carrier if fraudulent calls were placed; request call-stop on destination numbers if active.
7. Emit `audit_event (kind='security.sip.emergency_rotation', actor='ops', payload={agent_id, reason})`.

---

### 4.4 Carrier Credentials Compromise

**Symptoms:** Unexpected call volume to premium-rate numbers; carrier alert; unusual CDR geography.

**Containment steps (time-critical — toll fraud costs accumulate per-second):**

1. **Immediately** disable the affected carrier gateway row: `UPDATE carrier_gateways SET enabled=false WHERE id=<id>`.
2. Call carrier NOC directly to report fraud and request call-stop. Most carriers have a 24/7 fraud hotline.
3. Emit `audit_event (kind='security.carrier.emergency_disable')` + send Slack/PagerDuty webhook.
4. Investigate how carrier creds were accessed (admin UI audit_event, DB query log).
5. Rotate carrier credentials via admin UI once the carrier confirms fraud calls stopped.
6. Re-enable gateway after new credentials are verified working.
7. Review billing impact; document for carrier dispute.

---

### 4.5 Recording Bucket Leak (S3 Access)

**Symptoms:** Unexpected S3 access in CloudTrail; unauthorized presigned URLs shared; bucket policy misconfiguration detected.

**Containment steps:**

1. **Preserve evidence** — export CloudTrail events for the affected bucket + time window BEFORE key rotation.
2. If bucket is public (policy misconfiguration): immediately apply `aws s3api put-public-access-block --bucket <name> --public-access-block-configuration BlockPublicAcls=true,...`.
3. Rotate KMS CMK: `aws kms create-key` + update `VICI2_RECORDINGS_KMS_KEY_ID` env; old key kept for decrypt of existing objects.
4. Revoke any active presigned URLs by rotating the signing IAM credentials (if static key was compromised).
5. Review S3 server access logs / CloudTrail: identify which objects were accessed + by whom.
6. Assess PII/PHI exposure scope; if customer data accessed, trigger regulatory notification process.
7. Apply AWS Config rule to alert on bucket policy drift going forward.

---

## 5. Forensic Checklist

**CRITICAL: Preserve evidence BEFORE rotating any credentials.**

- [ ] Snapshot `audit_event` table for the affected time window (MySQL dump single-transaction)
- [ ] Export CloudTrail logs for the affected AWS resources
- [ ] Export Caddy access log and fail2ban ban log from incident window
- [ ] Export FreeSWITCH log for the incident window (`/var/log/freeswitch/freeswitch.log`)
- [ ] Capture container environment at time of incident (docker inspect, env snapshot)
- [ ] Document all timestamps with timezone (UTC throughout)
- [ ] Preserve container images (do NOT push new images until root-cause is understood)
- [ ] Capture Valkey state if session compromise is suspected (`valkey-cli DEBUG SLEEP 0` to pause, then dump)
- [ ] Note: rotating keys AFTER forensic capture — do NOT rotate before preserving evidence

---

## 6. Post-Incident

### 6.1 All-Clear

IC declares all-clear when:
1. Containment confirmed (no ongoing unauthorized access)
2. Root cause identified (not just "we rotated everything")
3. Immediate remediation applied
4. Monitoring confirms clean state for at least 1 hour

### 6.2 Blameless Retrospective Template

File a post-mortem issue within 5 business days using this template:

```markdown
## Incident Post-Mortem: [incident-id] [date]

**Severity:** P0/P1/P2
**Duration:** [start] → [end] (UTC)
**Impact:** [users/data affected]

### Timeline
[Chronological list with timestamps]

### Root Cause
[Single clear statement — not "human error" but the systemic cause]

### Contributing Factors
[What conditions made this possible]

### What Went Well
[Processes/tools that helped]

### What Went Poorly
[Detection gaps, slow response, missing tooling]

### Action Items
| Action | Owner | Due |
|---|---|---|
| ... | ... | ... |
```

### 6.3 Regulatory Notification

If personal data (PII/PHI/PCI) was accessed by unauthorized parties:
- Assess notification obligations under applicable regulations (GDPR 72h, CCPA, HIPAA 60d)
- Legal counsel must review before any external notification
- Document decision even if notification threshold not met

---

## 7. Contact List Template

Populate for each deployment. Store in vault, not in this file.

| Role | Name | Contact |
|---|---|---|
| Incident Commander (on-call) | See PagerDuty schedule | PagerDuty escalation |
| Security SME | | |
| Carrier NOC | Provider-specific | See `infra/carriers/contact-sheet.md` |
| Legal counsel | | |
| AWS Support (if AWS infra) | | support.console.aws.amazon.com (Business+ plan) |
