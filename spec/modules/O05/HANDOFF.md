# O05 — Security Baseline — HANDOFF

**Module:** O05
**Status:** IMPLEMENT COMPLETE
**Date:** 2026-05-13
**Author:** O05 IMPLEMENT agent (Claude Sonnet 4.6)

---

## What Was Built

All files from PLAN §13 (frozen file inventory) have been created:

### Caddy Edge TLS
- `infra/caddy/Caddyfile.example` — full Caddy config: HTTPS:443, WSS:7443, CSP headers, JSON access logging, reverse proxy routes to api/web/FS
- `infra/caddy/install.sh` — builds Caddy 2.9 with `caddy-dns/route53` plugin via xcaddy; installs systemd unit
- `infra/caddy/README.md` — Phase 1 (host-installed) vs Phase 2 (compose service) layout

### Certbot / FS TLS
- `infra/certbot/render-fs-tls.sh` — `--deploy-hook` script: atomic write of `wss.pem`, symlinks `agent.pem`/`tls.pem`/`dtls-srtp.pem`, per-profile `sofia restart`
- `infra/certbot/install.sh` — Snap install + Route53 plugin + cert issuance

### fail2ban (5 jails)
- `infra/fail2ban/filter.d/freeswitch.conf` — FS 1.10.7+ regex, `mode=normal` and `mode=ddos`
- `infra/fail2ban/filter.d/caddy-auth.conf` — 401/403 on login/refresh/totp endpoints
- `infra/fail2ban/filter.d/caddy-4xx-flood.conf` — generic 4xx flood detection
- `infra/fail2ban/jails/sshd.local` — SSH aggressive mode (3/600s → 24h ban)
- `infra/fail2ban/jails/freeswitch.local` — mode=normal (5/3600s → 1h ban)
- `infra/fail2ban/jails/freeswitch-dos.local` — mode=ddos (50/60s → 24h ban)
- `infra/fail2ban/jails/caddy-auth.local` — login flood (10/300s → 30min ban)
- `infra/fail2ban/jails/caddy-4xx-flood.local` — 4xx flood (30/60s → 10min ban)
- `infra/fail2ban/jails/ignoreip.local` — ops jump-host allowlist template
- `infra/fail2ban/action.d/vici2-audit.local` — HTTP POST to `/admin/audit/fail2ban-ban`
- `infra/fail2ban/install.sh` — installs fail2ban + prometheus exporter + all jails

### iptables prefilter
- `infra/iptables/sip-prefilter.sh` — string-match drops (friendly-scanner, sipcli, VaxSIPUserAgent) + hashlimit REGISTER flood guard
- `infra/iptables/install.sh` — systemd drop-in for docker.service + iptables-persistent

### AWS Recordings Bucket
- `infra/aws/recordings-bucket.tf` — S3 Object Lock (COMPLIANCE, 4yr) + KMS CMK + SSE-KMS + IAM upload/presign policies

### CI Security Workflows
- `.github/workflows/security-scan.yml` — ZAP baseline (nightly + PR), ZAP full scan (dispatch), govulncheck (Go), pnpm audit (Node)
- `.zap/rules.tsv` — known FP allowlist for ZAP baseline
- `.zap/context.zap` — ZAP authentication context template
- `.gitleaks.toml` — custom rules for `VICI2_KEK_*`, high-entropy base64 secrets

### Documentation
- `docs/security/threat-model.md` — STRIDE × 6 components; trust boundary diagram; per-row F-module citations; open mitigations table
- `docs/security/incident-response.md` — P0/P1/P2 classification; roles; 5 containment playbooks; forensic checklist; post-mortem template
- `docs/security/stir-shaken.md` — Phase 2 doc-only
- `docs/security/scan-policy.md` — severity thresholds, waiver process, pen-test cadence
- `docs/security/csp.md` — CSP header policy, directive rationale, style-src roadmap

### Runbooks
- `spec/runbooks/kek-rotation.md` — 8-step rewrap-only procedure; dry-run, live sweep, verification, rollback paths
- `spec/runbooks/cert-renewal.md` — automated + manual override + emergency paths
- `spec/runbooks/security-incident.md` — terse operator checklist for active incidents

### Config Updates
- `.env.example` — added O05 env var block (ACME, KEK_PROVIDER, recordings bucket, service token)
- `docker-compose.prod.yml.example` — full rewrite with container hardening (`read_only`, `cap_drop: [ALL]`, `no-new-privileges`, `seccomp=default`) + 3-network layout (core/data) + Valkey replacing Redis

---

## Downstream Actions Required

### F03 Amendment (PLAN §17.2) — Required for freeswitch jail to fire on wss/external profiles

Add to `freeswitch/conf/sip_profiles/wss.xml` and `freeswitch/conf/sip_profiles/external.xml`:
```xml
<param name="log-auth-failures" value="true"/>
<param name="log-auth-failures-as-warnings" value="true"/>
```
`internal.xml` already has it. Without this, the `freeswitch` fail2ban jail cannot detect auth failures on those profiles. Effort: 2 lines × 2 files.

### F05 Amendment (PLAN §17.4) — dryRun flag on rewrapAll

Add `dryRun?: boolean` to `encryption.rewrapAll()` in F05 PLAN §4.6:
```ts
encryption.rewrapAll({
  fromVersion, toVersion, batchSize, table,
  dryRun?: boolean,
}): Promise<{ rewrapped: number; failed: number; estimatedSeconds?: number }>;
```
KEK rotation runbook Step 4 calls `make rewrap-keks DRY_RUN=true`. Without this, operators can only do a `SELECT COUNT(*)` manually. Effort: ~10 lines TS, additive.

### O01 Amendment (PLAN §17.5) — Add 4 alert rules to PrometheusRule

Add to `monitoring/prometheus/rules/`:
```yaml
- alert: CertExpiresSoon
  expr: probe_ssl_earliest_cert_expiry - time() < 14 * 86400
  for: 1h
  labels: { severity: page }
  annotations:
    summary: "Cert {{ $labels.instance }} expires in <14d"

- alert: CertExpiresVerySoon
  expr: probe_ssl_earliest_cert_expiry - time() < 3 * 86400
  for: 5m
  labels: { severity: critical }

- alert: CaddyACMERenewalFailing
  expr: increase(caddy_acme_renew_failures_total[6h]) > 0
  for: 30m
  labels: { severity: warn }

- alert: Fail2banBannedSurge
  expr: increase(vici2_fail2ban_banned_total[10m]) > 50
  for: 5m
  labels: { severity: warn }
  annotations:
    summary: "fail2ban banned >50 IPs in 10m on {{ $labels.jail }}"
```
Also consume `vici2_api_auth_kek_age_days` gauge (F05 export) for KEK-age alerting (warn at >330d, page at >365d).

### R02/R03 Amendment (PLAN §17.6) — Consume recordings-bucket.tf

R02 PLAN: consume `infra/aws/recordings-bucket.tf` outputs for download presign endpoint.
R03 PLAN: upload recordings using `VICI2_RECORDINGS_BUCKET` + `VICI2_RECORDINGS_KMS_KEY_ID` env.

### F01 Amendment (PLAN §17.1) — Phase 2 Caddy in compose

When the next round of compose work happens, add `caddy` service to `docker-compose.prod.yml.example` on the `edge` network. The `Caddyfile.example` reverse-proxy upstreams switch from `127.0.0.1:PORT` to `api:3000`, `web:4000`, `freeswitch:5066`.

---

## Phase 4 Cleanup Notes (PLAN §17.7)

When migrating to Kubernetes in Phase 4:
- `infra/fail2ban/` → replaced by k8s NetworkPolicy + WAF (e.g., AWS WAFv2) + Falco for runtime detection
- `infra/iptables/` → replaced by cloud VPC security groups + NLB WAF
- `infra/caddy/` → replaced by k8s Ingress + cert-manager for ACME
- fail2ban-prometheus-exporter → replaced by Falco metrics + k8s network policy metrics

---

## Verification Commands

```bash
# Caddy config validation
caddy validate --config infra/caddy/Caddyfile.example

# fail2ban filter validation
fail2ban-client -t -c infra/fail2ban

# iptables rules syntax check (requires iptables-restore installed)
iptables-restore --test < <(bash infra/iptables/sip-prefilter.sh 2>/dev/null; iptables-save)

# Cert expiry check (on deployed host)
echo | openssl s_client -connect vici2.example.com:443 2>/dev/null | openssl x509 -noout -dates

# HSTS header check
curl -I https://vici2.example.com | grep -i strict-transport

# fail2ban jail status (on deployed host)
fail2ban-client status
fail2ban-client status freeswitch
```

---

## Known Limitations / TODOs

1. **Action SHA pinning in security-scan.yml**: the `zaproxy/action-baseline@v0.15.0`, `zaproxy/action-full-scan@v0.13.0`, and `golang/govulncheck-action@v1` refs use version tags, not commit SHAs. These should be pinned via `pinact` after the initial merge. The `pinact` pre-commit hook will enforce this on subsequent edits.

2. **`.zap/context.zap`**: ZAP authentication is currently commented out in `security-scan.yml`. Enable when a dedicated test agent account is created on staging. The XML context template is ready.

3. **`VICI2_API_SERVICE_TOKEN`**: the fail2ban audit action (`vici2-audit.local`) requires this token. The `/admin/audit/fail2ban-ban` endpoint must be implemented in the API (F05 PLAN integrator role). Phase 1 the action is installed but the endpoint is a stub.

4. **Distroless base image digests**: `docker-compose.prod.yml.example` includes comments for digest pinning but does not include actual SHA256 digests (they change frequently). Operators must run `docker pull <image>` and pin the current digest. Renovate/Dependabot will maintain these automatically once configured.
