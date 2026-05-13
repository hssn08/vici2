# Module O05 — Security Baseline (TLS, fail2ban, Image/Dep Scan, KEK Rotation, Threat Model, IR) — PLAN

**Module:** O05 (Operations, Phase 1)
**Author:** O05 PLAN sub-agent (Claude Opus 4.7, 1M ctx)
**Date:** 2026-05-06
**Status:** PROPOSED — awaiting orchestrator/lead review.
**Companion:** [RESEARCH.md](./RESEARCH.md) — 50 citations behind every choice.
**Depends on (PLANs FROZEN):** F01 (compose, env, gitleaks wiring), F03 (Sofia profiles, ports, FS image pin), F05 (KEK env-var contract, encryption.ts blob layout, JWT key envs), O04 (CI workflow surface — Trivy, gitleaks, CodeQL, dep-review, OIDC).
**Blocks:** O05 IMPLEMENT only. No downstream module depends on O05's interfaces (security baseline is cross-cutting and additive).

This plan resolves every open question from RESEARCH.md §11–12 and freezes the
file inventory, runbook procedures, threat-model artifacts, and CI-gate shape
the IMPLEMENT phase will execute against. **No Caddyfile, jail config, or
runbook prose is written here** — only the contract IMPLEMENT executes
against. Once approved, the public surface (file paths, secret env-var names,
runbook step numbers, alert thresholds, container hardening flags) is FROZEN.
Internal implementation (exact regex strings, exact CSP header value, ZAP
rules.tsv contents) may evolve during IMPLEMENT without an RFC.

---

## 0. TL;DR (10 bullets)

1. **Caddy 2.9 fronts HTTPS:443 + WSS:7443**, terminates TLS at the edge,
   reverse-proxies to api/web/dialer, uses its built-in (lego-derived) ACME
   client for auto-renew. **DNS-01 via Route53** for the wildcard (matches
   O04's AWS target); Cloudflare alt documented. Caddyfile lives at
   `infra/caddy/Caddyfile.example`. **Phase 1 caddy runs OUTSIDE compose**
   on the host; F01 amendment adds the compose service in Phase 2 once the
   prod compose surface is touched again.
2. **FreeSWITCH-side TLS (SIP-TLS:5061 + DTLS-SRTP:WSS:7443) uses certbot
   DNS-01** (sofia-sip cannot hot-reload TLS; Caddy can't write into FS
   disk). `--deploy-hook /usr/local/bin/render-fs-tls.sh` writes
   `wss.pem`/`agent.pem`/`tls.pem`/`dtls-srtp.pem` and runs
   `fs_cli -x 'sofia profile <name> restart reloadxml'` per-profile. Pin
   `signalwire/freeswitch:1.10.12` (CVE mitigations from RESEARCH §2.5).
3. **fail2ban catalog: 5 jails on the host (not in containers).** `sshd`
   (default), `freeswitch` (mode=normal, FS 1.10.7+ regex), `freeswitch-dos`
   (mode=ddos, high threshold), `caddy-auth` (login flood), `caddy-4xx-flood`
   (DoS deterrent). Pre-fail2ban: iptables hashlimit + string-match drops
   for friendly-scanner/sipcli/VaxSIPUserAgent at the host firewall.
   **F03 amendment**: every Sofia profile must carry
   `<param name="log-auth-failures" value="true"/>`.
4. **Image scanning: Trivy is the default** (already wired in O04
   `ci.yml::trivy-image`). O05 adds `Syft → CycloneDX SBOM` upload as a
   build artifact on every `docker` job (also already in O04 §7). No new
   workflow required for image scan; O05 contributes the threshold
   policy + `.trivyignore` review process.
5. **Dep audits already wired by O04**: `govulncheck` (Go), `pnpm audit`
   (Node), Dependabot weekly grouped PRs, `actions/dependency-review-action`,
   GitHub Actions pinned to 40-char SHAs (via `pinact` pre-commit). O05
   contributes the **policy** doc (severity thresholds, waiver process,
   maintained-issues-list pattern).
6. **OWASP top-10 baseline**: NEW workflow `.github/workflows/security-scan.yml`
   wires `zaproxy/action-baseline@v0.15.0` nightly + on PR-to-main against
   `https://staging.vici2.example.com`. `.zap/rules.tsv` for known FPs.
   Fails PRs on new HIGH/CRIT only; WARN/INFO tracked in a maintained
   GH issue. Manual `action-full-scan` belongs in pre-release runbook only.
7. **KEK rotation runbook** (`spec/runbooks/kek-rotation.md`) formalizes
   F05 PLAN §4.7: phased dual-key deploy (`VICI2_KEK_V1` + `VICI2_KEK_V2`
   both present during sweep), rewrap-only (ciphertext untouched),
   idempotent (`WHERE kek_version < N`), dry-run mode + estimated row count,
   rollback paths, audit-event emission, archive-old-key-to-cold-storage step.
   Routine cadence: 12 months. Emergency: <24h. Calls F05's
   `encryption.ts::rewrapAll()` API (frozen in F05 PLAN §4.6).
8. **STRIDE threat model** (`docs/security/threat-model.md`) per RESEARCH §6:
   six components (FS, api, agent UI, admin UI, MySQL, Valkey) × six STRIDE
   classes; trust boundaries diagrammed in ASCII; carrier↔FS untrusted,
   browser↔WSS semi-trusted (JWT-auth), backend↔DB trusted (network-isolated),
   admin↔all privileged (MFA hooks from F05/F06). Each row cites mitigations
   that already exist in F03/F04/F05 PLANs.
9. **Container hardening defaults**: distroless base for Go services
   (`gcr.io/distroless/static-debian12:nonroot`) and Node services
   (`gcr.io/distroless/nodejs20-debian12:nonroot`). `read_only: true` +
   `tmpfs:/tmp`, `cap_drop:[ALL]`, `no-new-privileges:true`, default seccomp,
   `user: 65532:65532`. Pin by digest (per O04 §5). FreeSWITCH stays on the
   debian-based `signalwire/freeswitch:1.10.12` image (distroless not viable —
   F03 PLAN §3.7 of RESEARCH).
10. **Network isolation + cert-renewal alerting**: 3 docker networks (`edge`,
    `core`, `data`); MySQL/Valkey have **no host port maps in prod**;
    `caddy_certificates_expiry_seconds` Prometheus metric (Caddy admin :2019);
    blackbox_exporter probes FS:5061 daily; pages at <14d (`severity=page`),
    critical at <3d (`severity=critical`). Alert rules land in O01's
    PrometheusRule via this PLAN's hand-off.

---

## 1. Edge TLS — Caddy 2.9 (frozen)

### 1.1 Decision

**Caddy 2.9.x at the host edge** terminates HTTPS:443 and WSS:7443 in front
of api (`:3000`), web (`:4000`), and FreeSWITCH WSS (proxied to `freeswitch:5066`
in dev, direct WSS:7443 binding to FS in prod — see §1.5). Built-in ACME
client (lego-derived); auto-renew with no cron, no shell-script glue, no
`--deploy-hook` for the *web* surface. Caddy admin API bound to `127.0.0.1:2019`
only; metrics exposed there for O01.

### 1.2 ACME challenges + DNS provider

| Surface | Challenge | Why |
|---|---|---|
| Apex (`vici2.example.com`) | HTTP-01 | Port 80 reachable; simplest |
| Wildcard (`*.vici2.example.com`) | DNS-01 | Per-tenant subdomains, FS hostnames where port 80 isn't open |

**DNS provider: Route53** (Phase 1 default, matches O04's AWS target).
Cloudflare documented as alternative in `infra/caddy/Caddyfile.example`
header comment. Caddy DNS plugin loaded via `xcaddy build` — IMPLEMENT
ships a Dockerfile (Phase 2) and a host-install script (Phase 1).

Required envs (added to `.env.example` by O05 IMPLEMENT):

```
VICI2_ACME_EMAIL=                         # account email for Let's Encrypt
VICI2_ACME_DNS_PROVIDER=route53           # route53 | cloudflare
AWS_ACCESS_KEY_ID=                        # only if route53 + not using IAM-role
AWS_SECRET_ACCESS_KEY=                    # ditto
AWS_REGION=us-east-1
CADDY_HOSTNAMES=vici2.example.com,*.vici2.example.com
```

In prod (AWS-deployed), prefer instance profile / IRSA over static AWS
keys; the env vars are dev/laptop fallback only.

### 1.3 Reverse-proxy routes (Caddyfile shape — content in IMPLEMENT)

```
{$CADDY_HOSTNAMES} {
    tls {$VICI2_ACME_EMAIL} { dns route53 }
    encode zstd gzip
    log { output file /var/log/caddy/access.log }

    # API
    handle /api/* { reverse_proxy api:3000 }
    handle /auth/* { reverse_proxy api:3000 }

    # WebSocket gateway (A03)
    handle /ws/* { reverse_proxy api:3000 }

    # WSS to FS (browser SIP.js)
    handle /sip-ws/* { reverse_proxy freeswitch:5066 }

    # SPA / agent UI (A01) and admin UI
    handle { reverse_proxy web:4000 }
}
```

Strict CSP, HSTS, X-Frame-Options, Permissions-Policy headers via Caddy
`header` directive — content frozen in §6.3 (Threat model: agent UI XSS row).

### 1.4 Phase-1 vs Phase-2 deployment shape

- **Phase 1** (this PLAN's IMPLEMENT): Caddy runs **on the host** (systemd
  unit installed by `infra/caddy/install.sh`). The compose stack exposes
  api/web/freeswitch on local-only ports; Caddy proxies via host loopback.
  This avoids touching the F01 compose surface mid-track.
- **Phase 2** (deferred to a future O05/F01 amendment): Caddy moves into
  compose as a service on the `edge` docker network. F01 amendment request
  filed (§17).

### 1.5 SIP-TLS:5061 and DTLS-SRTP:WSS:7443 — certbot, not Caddy

Caddy cannot write certs onto the FS container's disk, and sofia-sip cannot
hot-reload TLS material (RESEARCH §2.4 [12]). So **certbot DNS-01** runs
either on the host (Phase 1) or in a sidecar container (Phase 2) and:

1. Issues the same wildcard cert as Caddy (separate ACME account, same
   hostnames).
2. Calls `--deploy-hook /usr/local/bin/render-fs-tls.sh` on each renewal.

`render-fs-tls.sh` (frozen path; content shipped by IMPLEMENT):

```
1. cat fullchain.pem privkey.pem > /etc/freeswitch/tls/wss.pem.new
2. mv -f /etc/freeswitch/tls/wss.pem.new /etc/freeswitch/tls/wss.pem  # atomic
3. ln -sf wss.pem /etc/freeswitch/tls/agent.pem
4. ln -sf wss.pem /etc/freeswitch/tls/tls.pem
5. ln -sf wss.pem /etc/freeswitch/tls/dtls-srtp.pem
6. fs_cli -H 127.0.0.1 -P 8021 -p "$FS_EVENT_SOCKET_PASSWORD" -x 'sofia profile wss restart reloadxml'
7. fs_cli -... -x 'sofia profile internal restart reloadxml'
8. fs_cli -... -x 'sofia profile external restart reloadxml'
```

Per-profile restart **per F03 PLAN §1.2** (3-profile design isolates blast
radius). Schedule renewals during low-traffic window (`certbot renew`
systemd timer at 03:00 local + jitter; renewal only happens at <30d so this
fires ~1×/60d).

### 1.6 Cert-share between Caddy and FS

Single LE wildcard cert covers both. Caddy stores in its native dir
(`/var/lib/caddy/.local/share/caddy/`); certbot stores at
`/etc/letsencrypt/live/`. To avoid two ACME accounts hammering Let's Encrypt,
**Phase 1 IMPLEMENT decision**: certbot owns the cert and Caddy is configured
to load from disk via `tls /etc/letsencrypt/live/.../fullchain.pem
/etc/letsencrypt/live/.../privkey.pem`, disabling Caddy's auto-renew. **Phase
2 alternative**: switch to Caddy auto-renew + a small file-watcher that
mirrors Caddy's storage into FS disk + triggers `sofia profile restart`.

This single-cert / dual-loader layout is documented in
`infra/caddy/README.md` (created by IMPLEMENT) and in §1.4 of the cert
runbook.

### 1.7 Pinned versions

| Component | Pinned version | Rationale |
|---|---|---|
| Caddy | `caddy:2.9-alpine` (built with `xcaddy` for route53 plugin) | Latest stable; ACME-ARI support; HTTP/3 default |
| certbot | Snap-managed (Debian 12 host) | EFF-recommended distribution path; auto-updating |
| FreeSWITCH | `signalwire/freeswitch:1.10.12` | Already F03-pinned; covers ES2021-09 (SRTP DoS, fixed in 1.10.7) and ES2023-02 (DTLS race, fixed in later 1.10.x). Must NOT downgrade below 1.10.11. |

---

## 2. fail2ban catalog (5 jails on host)

### 2.1 Placement decision

**fail2ban runs on the host**, not in a container. Rationale (RESEARCH §3):
fail2ban needs iptables/nftables on the **Docker daemon's NAT chain** to
block traffic before it reaches container netns. A containerized fail2ban
either (a) fights iptables namespacing (fragile), or (b) is moved into the
host network namespace anyway (defeats the container).

In Phase 4 (k8s), this whole layer is replaced by NetworkPolicy + WAF +
per-pod runtime armor (out of scope for O05 PLAN; noted in §17.7).

### 2.2 Jail inventory (FROZEN)

| Jail | Filter | Logpath | maxretry | findtime | bantime | Notes |
|---|---|---|---|---|---|---|
| `sshd` | `sshd[mode=aggressive]` (Debian 12 default) | `/var/log/auth.log` | 3 | 600 | 86400 | OS default; aggressive catches probes |
| `freeswitch` | `freeswitch[mode=normal]` | `/var/log/freeswitch/freeswitch.log` | 5 | 3600 | 3600 | Matches `[INFO] sofia_reg.c:NNN SIP auth failure` pattern; FS 1.10.7+ regex (RESEARCH §3 [16]) |
| `freeswitch-dos` | `freeswitch[mode=ddos]` | `/var/log/freeswitch/freeswitch.log` | 50 | 60 | 86400 | Catches challenge floods (sipcli, sipvicious); high threshold avoids legit-phone trips |
| `caddy-auth` | `caddy-auth.conf` (custom) | `/var/log/caddy/access.log` | 10 | 300 | 1800 | 401/403 on `/api/auth/login` and `/auth/refresh` and `/api/auth/totp/verify` |
| `caddy-4xx-flood` | `caddy-4xx-flood.conf` (custom) | `/var/log/caddy/access.log` | 30 | 60 | 600 | ≥30 4xx in 60s; short ban so legit misconfigured clients recover |

`ignoreip = 127.0.0.0/8 ::1 <ops_jump_host_cidrs>` configured per-host via
`infra/fail2ban/jails/ignoreip.local` (template in repo, populated at
deploy). Mitigates the legitimate-IP false-positive risk (§16).

### 2.3 Filter regex (FS 1.10.7+ format)

`infra/fail2ban/filter.d/freeswitch.conf` ships the **modern** filter regex.
RESEARCH §3 + F03 PLAN §17 risk row note that FS 1.10.6 → 1.10.7 changed
log format and broke fail2ban regexes < 3143. We're on 1.10.12, so we ship
the post-1.10.7 regex with both `mode=normal` and `mode=ddos` failregex
families in the same file (use jail.conf `mode=` selector to pick one).

Exact regex content frozen in IMPLEMENT — derived directly from upstream
fail2ban master `config/filter.d/freeswitch.conf` [15][16][17] with no
deviation.

### 2.4 F03 amendment — `log-auth-failures`

For the `freeswitch` jail to fire, every Sofia profile must include:

```xml
<param name="log-auth-failures" value="true"/>
<param name="log-auth-failures-as-warnings" value="true"/>
```

F03 PLAN §2.1 already includes `<param name="log-auth-failures" value="true"/>`
on the `internal` profile XML (line 159). The `wss` and `external` profile
XMLs need the same param added during F03 IMPLEMENT. **F03 amendment
request filed (§17.2)** — single line per profile, no interface change.

### 2.5 Pre-fail2ban host firewall hardening

Cheaper than fail2ban regex; applied at host iptables INPUT chain via a
systemd-managed script `infra/iptables/sip-prefilter.sh`:

```
# String-match drops (BM = Boyer-Moore)
iptables -I INPUT -p udp --dport 5060 -m string --string "friendly-scanner" --algo bm -j DROP
iptables -I INPUT -p udp --dport 5060 -m string --string "sipcli"           --algo bm -j DROP
iptables -I INPUT -p udp --dport 5060 -m string --string "VaxSIPUserAgent"  --algo bm -j DROP
iptables -I INPUT -p udp --dport 5061 -m string --string "friendly-scanner" --algo bm -j DROP
iptables -I INPUT -p udp --dport 5080 -m string --string "friendly-scanner" --algo bm -j DROP

# Per-source REGISTER rate-limit
iptables -A INPUT -p udp --dport 5060 -m hashlimit \
  --hashlimit 5/sec --hashlimit-burst 8 --hashlimit-mode srcip \
  --hashlimit-name SIP_REG -j ACCEPT
```

5060/5061/5080 mirror the F03 port surface (RESEARCH §3 [37]). Integrated
into the host bring-up script `infra/iptables/install.sh` so the rules
survive reboot.

### 2.6 Audit event integration

When fail2ban bans an IP, write the event to MySQL `audit_event` table.
Mechanism: fail2ban `action.d/vici2-audit.local` shell action calls a small
HTTP POST to `https://api.internal.vici2/admin/audit/fail2ban-ban` with
service-token auth (F05 integrator role). Schema: `kind='fail2ban_ban'`,
`payload={jail, ip, attempts, bantime}`. Phase-1 IMPLEMENT ships this; Phase
2 may switch to a direct MySQL `mysql --batch -e INSERT` if HTTP coupling is
brittle. **Resolves RESEARCH §3 open question** (fail2ban → audit_event).

---

## 3. Image scanning + dep audits + OWASP ZAP (CI gates)

### 3.1 Already wired by O04

The following gates already live in O04's `ci.yml` (PLAN §2.1 + §16):

| Gate | Tool | Where in O04 | Threshold |
|---|---|---|---|
| Container vuln scan | Trivy | `ci.yml::trivy-image` | HIGH, CRITICAL fail |
| Secret scan | gitleaks v8 | `secrets-scan.yml` | any finding fails |
| Static code | CodeQL `security-and-quality` | `codeql.yml` | informational PR comments |
| Dep / license review | `actions/dependency-review-action@v4` | `dependency-review.yml` | high-severity vuln + GPL fails |
| Provenance | `actions/attest-build-provenance@v2` | `_docker.yml::merge` | always attached |
| SBOM | `syft` (CycloneDX) | `_docker.yml::merge` | uploaded artifact |
| Action SHA pinning | `pinact` | pre-commit + CI guard | hard fail |

**O05 contributes**:

1. **Severity policy** doc: which finding severities block PRs vs annotate
   only; lives in `docs/security/scan-policy.md` (Phase 1).
2. **Waiver process**: `.trivyignore` PRs require security-team review (CODEOWNERS
   rule); `.zap/rules.tsv` same. Each waiver line carries a comment with CVE
   ID + waived-until date + ticket link.
3. **Maintained "open security findings" issue** template — pinned issue per
   repo, CodeQL/Trivy/ZAP WARN findings tracked here.

### 3.2 NEW: govulncheck + pnpm audit dedicated jobs

O04's `_docker.yml` runs Trivy on built images, but Go and Node source-tree
audits per RESEARCH §4.2 are not yet wired. O05 adds (via PR against O04's
`ci.yml` — see amendment §17.3):

| Job ID | Stage | Tool | Threshold |
|---|---|---|---|
| `govulncheck-go` | 6 sec | `golang/govulncheck-action` (call-graph-aware) | any vuln in *called* function fails |
| `pnpm-audit-node` | 6 sec | `pnpm audit --prod --audit-level=high` | any HIGH+ fails |

Both run on every PR. Govulncheck's call-graph filter keeps noise low
(RESEARCH §4.2 [27][28][29]).

### 3.3 NEW workflow: `.github/workflows/security-scan.yml`

Single new workflow O05 adds. Two jobs:

| Job | Trigger | Tool | Target |
|---|---|---|---|
| `zap-baseline` | nightly cron `0 3 * * *` + `pull_request` to main | `zaproxy/action-baseline@v0.15.0` | `https://staging.vici2.example.com` |
| `zap-full-scan` | `workflow_dispatch` only | `zaproxy/action-full-scan@v0.13.0` | staging | (manual pre-release pen-test, never against prod) |

Inputs:

- `.zap/rules.tsv` (committed) — silence known FPs.
- `.zap/context.zap` (committed) — sets `auth.method=httpAuthentication`
  with a dedicated test agent account so the scanner sees authenticated
  surfaces.

Outputs:

- HTML + JSON report uploaded as workflow artifact (90-day retention).
- New HIGH/CRIT in baseline → PR fails. New WARN → PR comment, no block.
- Baseline issue (singleton, label `security/zap-baseline`) auto-maintained
  by the action.

Why a separate workflow (not absorbed into `ci.yml`): nightly cron is the
primary cadence; PR-trigger is secondary. Decoupling avoids re-running ZAP
every commit on hot branches.

---

## 4. KEK rotation runbook

### 4.1 Path

`spec/runbooks/kek-rotation.md` (created by O05 IMPLEMENT).

### 4.2 Procedure type

**Rewrap-only**. Decrypt the per-row DEK with the old KEK, re-wrap with
the new KEK, write back. **Application ciphertext (`payload_ct` in F05 PLAN
§4.5 blob layout) is never read or written.** Pattern from MongoDB QE
[30], IBM Key Protect [31], Everruns [32].

### 4.3 Phased dual-key contract (calls F05's encryption.ts)

The runbook calls F05's frozen API (F05 PLAN §4.6):

```ts
encryption.rewrapAll({
  fromVersion: 1,
  toVersion: 2,
  batchSize: 500,
  table: 'sip_credentials' | 'integrators' | 'totp_secrets',
}): Promise<{ rewrapped: number; failed: number }>;
```

Plus a NEW method requested by O05 (F05 amendment §17.4):

```ts
encryption.rewrapAll({ ..., dryRun: true }): { wouldRewrap: number; estimatedSeconds: number };
```

(Estimate at ~5k rows/sec measured on dev — RESEARCH §5.1.) F05 PLAN's
`encryption.ts::rewrapAll` already supports `batchSize`; adding `dryRun:
boolean` is additive, no contract break.

### 4.4 Step-by-step (frozen — runbook IMPLEMENT writes prose)

| Step | Action | Idempotency / rollback |
|---|---|---|
| 1 | Pre-flight: snapshot MySQL + Valkey; estimate row count; notify on-call | No state change |
| 2 | Generate `VICI2_KEK_V{N+1}` = base64(32 random bytes) | Stored in vault before env update |
| 3 | Set BOTH `VICI2_KEK_V{N}` and `VICI2_KEK_V{N+1}` in env; `VICI2_KEK_CURRENT_VERSION={N+1}` | Rolling restart; both keys decrypt-capable |
| 4 | `make rewrap-keks DRY-RUN=true FROM={N} TO={N+1}` | Reports `wouldRewrap`, `estimatedSeconds`. No DB writes. |
| 5 | `make rewrap-keks FROM={N} TO={N+1}` | Idempotent on `WHERE kek_version < {N+1}`; resumable on crash |
| 6 | `SELECT kek_version, COUNT(*) FROM sip_credentials GROUP BY 1` — must be `{N+1}` only | If non-zero `< N+1` rows, re-run step 5 |
| 7 | After 30d compliance hold, drop `VICI2_KEK_V{N}` from env; rolling restart | Old key archived to vault `secret/vici2/kek_archive/v{N}` for backup decryption |
| 8 | `INSERT INTO audit_event (kind, actor, payload) VALUES ('auth.kek.rotation_completed', ...)` | Fires `auth.kek.rotation_completed` event (already in F05 audit catalog) |

### 4.5 Cadence

| Trigger | SLA | Notes |
|---|---|---|
| Routine | every 12 months | Industry default for symmetric KEKs not in HSM |
| Emergency (suspected leak / contributor offboarding with KEK exposure) | within 24h | Skip step 7 wait; rotate immediately + force agent password reset |
| Phase 4 (Vault Transit) | as above | Procedure unchanged; `VICI2_KEK_PROVIDER=vault` swaps backend, encryption.ts API stable |

### 4.6 Rollback paths

- **Step 4 dry-run errors**: investigate flagged rows; no state change.
- **Step 5 partial failure**: re-run; sweep is idempotent (`WHERE kek_version < N+1`).
- **Step 7 done, then unrewrapped row found** (e.g., backup restored): re-add
  old KEK env, redeploy, re-run sweep.
- **New KEK suspected compromised mid-rotation**: stop sweep; generate
  `KEK_V{N+2}`; restart from step 3 with `{N+2}`.

### 4.7 JWT key rotation

**Separate runbook** (filed as a TODO for O05 IMPLEMENT or as a follow-up
ticket; out of scope for this PLAN). F05 PLAN §1.2 already documents the
3-step JWT rotation procedure (add public, swap private, drop old public);
O05 records it in `spec/runbooks/jwt-key-rotation.md` if IMPLEMENT bandwidth
allows. Cadence: quarterly (more frequent than KEK).

---

## 5. Threat model (STRIDE per component)

### 5.1 Path

`docs/security/threat-model.md` (created by O05 IMPLEMENT).

### 5.2 Trust-boundary diagram (ASCII — IMPLEMENT renders prose)

```
┌────────────────────────────────────────────────────────────────────────────┐
│  UNTRUSTED                                                                  │
│  ┌────────────┐         SIPS:5061 + SRTP                                    │
│  │  Carrier   │─────────────────────────────────►┌──────────────────────┐  │
│  └────────────┘                                  │  FreeSWITCH external │  │
│                                                  │  profile (IP-ACL +   │  │
│                                                  │  per-gw register)    │  │
│                                                  └──────────┬───────────┘  │
│                                                             │              │
│  ┌────────────┐  WSS:7443 + DTLS-SRTP    ┌─────────┐        │              │
│  │  Browser   │─────────────────────────►│  Caddy  │────────┤              │
│  │ (agent UI) │  HTTPS:443 + JWT cookie  └────┬────┘        │              │
│  └────────────┘                               │             │              │
│                                               │             │              │
└───────────────────────────────────────────────┼─────────────┼──────────────┘
   SEMI-TRUSTED (JWT-authenticated)             │             │
                                                │             │
┌───────────────────────────────────────────────┼─────────────┼──────────────┐
│  TRUSTED (docker internal networks)           ▼             ▼              │
│                                          ┌────────┐    ┌──────────────┐    │
│                                          │  api   │    │  FS internal │    │
│                                          │ :3000  │    │  + WSS       │    │
│                                          └───┬────┘    └──────┬───────┘    │
│                                              │                │            │
│                                              ▼                ▼            │
│  ┌─────────┐                            ┌────────┐      ┌──────────┐       │
│  │ dialer  │◄───────ESL:8021────────────│ valkey │◄─────│ workers  │       │
│  └────┬────┘                            └────────┘      └──────────┘       │
│       │                                      ▲                             │
│       └──────────► mysql (no host port) ◄────┘                             │
│                                                                            │
│  PRIVILEGED (admin)                                                        │
│  ┌────────────┐  HTTPS:443 + JWT(role=admin) + TOTP (F06)                  │
│  │  Admin UI  │──────────────────────────────────────────► api / mysql     │
│  └────────────┘  (every mutation → audit_event row)                        │
└────────────────────────────────────────────────────────────────────────────┘
```

### 5.3 Per-component STRIDE matrices (FROZEN — IMPLEMENT writes prose)

The IMPLEMENT-phase `docs/security/threat-model.md` reproduces RESEARCH
§6.1–6.6 verbatim, with one addition per component:

- **Cite the F-module PLAN** that owns the mitigation (so the doc stays
  cross-checkable).
  - FS row → "F03 PLAN §2 (3-profile design), §10 (recording template)"
  - api row → "F05 PLAN §1 (JWT), §2 (refresh-rotation), §6 (RBAC)"
  - agent UI row → "A01 PLAN (CSP), F05 PLAN §5.4 (one-time SIP creds)"
  - admin UI row → "A04 PLAN (admin), F06 PLAN (MFA — Phase 2)"
  - MySQL row → "F02 PLAN (per-service users), R03 PLAN (encrypted backups)"
  - Valkey row → "F04 PLAN (ACL per-service users), F05 PLAN §2 (refresh tokens)"
- **Open mitigations table** at the bottom: each STRIDE row that does NOT
  yet have a F-module PLAN owning it spawns a TODO with a target phase.

### 5.4 Incident response plan

Companion doc: `docs/security/incident-response.md`. Sections:

1. **Severity classification** (P0 active breach / P1 suspected / P2 hardening gap).
2. **Roles** (incident commander, scribe, SME — bench rotates).
3. **Comms channels** (private Slack channel `#sec-ir-active`; status page).
4. **Containment playbooks** (one per credible scenario):
   - JWT key compromise → run §17 from RESEARCH (rotate + revoke all jti).
   - KEK compromise → emergency rotation (§4.5 row 2).
   - SIP creds compromise (single agent) → rotate via F05 admin endpoint, force re-register.
   - Carrier creds compromise → immediate disable of carrier_gateway row + audit_event + admin pager.
   - Recording bucket leak → S3 SSE-KMS rotate + audit CloudTrail; signed-URL audit log review.
5. **Forensic checklist** (preserve container logs, MySQL audit_event rows,
   FS recordings BEFORE rotation evicts; rotate keys AFTER capture).
6. **Post-incident**: blameless retrospective template; remediation tickets.

Companion runbook `spec/runbooks/security-incident.md` is the operational
checklist version (terse, copy-pasteable commands).

---

## 6. Container hardening (frozen defaults)

### 6.1 Base images per service

| Service | Base | UID | Notes |
|---|---|---|---|
| `dialer` (Go) | `gcr.io/distroless/static-debian12:nonroot@sha256:<digest>` | 65532 | CGO_ENABLED=0; ~5 MB final |
| `api` (Node 20) | `gcr.io/distroless/nodejs20-debian12:nonroot@sha256:<digest>` | 65532 | ~89 MB final |
| `web` (Next.js standalone) | `gcr.io/distroless/nodejs20-debian12:nonroot@sha256:<digest>` | 65532 | reuse |
| `workers` (Node) | `gcr.io/distroless/nodejs20-debian12:nonroot@sha256:<digest>` | 65532 | reuse |
| `freeswitch` | `signalwire/freeswitch:1.10.12@sha256:<digest>` | freeswitch (in-image) | distroless not viable; F03-pinned |
| `mysql` | `mysql:8.4@sha256:<digest>` | mysql (in-image, 999) | upstream image; cap_drop + read-only volume except `/var/lib/mysql` |
| `valkey` | `valkey/valkey:8.0-alpine@sha256:<digest>` | valkey (in-image) | F04-decided; non-root by default |
| `caddy` | `caddy:2.9-alpine@sha256:<digest>` (or xcaddy-built variant) | caddy | Phase 1 host install; Phase 2 compose service |

Digests pinned in compose; **Renovate/Dependabot weekly digest-bump PRs**
(O04 PLAN §13). Multi-stage Dockerfiles: build stage uses `*-dev` images
(golang:1.22, node:20-bookworm); runtime stage is distroless.

### 6.2 Per-service compose security flags (frozen template)

```yaml
read_only: true
tmpfs:
  - /tmp:size=64M,mode=1777
  - /var/run:size=8M
cap_drop: [ALL]
cap_add: []                       # FS gets [NET_BIND_SERVICE] only if binding <1024
security_opt:
  - no-new-privileges:true
  - seccomp=default
user: "65532:65532"
restart: unless-stopped
```

Per-service overrides:
- `freeswitch`: `cap_add: [NET_BIND_SERVICE]` (5060/5061), `read_only: false`
  (FS writes to `/etc/freeswitch/tls`, recordings vol; vol mounts pin write
  surface).
- `mysql`: `read_only: false`; named volume `mysql_data` is the only writable.
- `valkey`: `read_only: true` + tmpfs for AOF if persistence enabled
  (F04-decided).

### 6.3 CSP / HSTS / security headers (Caddy-injected)

Frozen header bundle (Caddy `header` directive, per-route):

```
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), geolocation=(), microphone=(self), payment=()
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
                         img-src 'self' data: https:; connect-src 'self' wss://*.vici2.example.com;
                         media-src 'self' blob:; frame-ancestors 'none'; base-uri 'self';
                         form-action 'self'; upgrade-insecure-requests
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

`microphone=(self)` is mandatory for the WebRTC agent UI (A02).
`connect-src` allows WSS to FS hostname per tenant. A01 PLAN must validate
no `unsafe-eval` is needed (Next.js 14 standalone is compatible).

### 6.4 Image policy (already in O04 PLAN §5)

- Pin by `@sha256:<digest>`, never tag, in compose.
- `latest`/`dev`/`edge` forbidden.
- `.dockerignore` bounds build context (no `.git`, `node_modules`, `.env*`).

---

## 7. Network isolation (compose)

### 7.1 Three docker networks (FROZEN)

| Network | Members | Host port maps |
|---|---|---|
| `edge` | caddy, api, web | caddy: 443, 7443, 80 (ACME) |
| `core` | api, dialer, workers, freeswitch | freeswitch: 5060/5061/5080/5066 + 16384–32768/udp; ESL :8021 NOT exposed (loopback only) |
| `data` | api, dialer, workers, mysql, valkey | NONE (mysql 3306 + valkey 6379 internal only) |

`freeswitch` joins both `edge` (for caddy proxy to WSS) and `core` (for ESL
+ dialer); it is the only edge-facing telephony surface.

### 7.2 Caddy admin API

Bound to `127.0.0.1:2019` only (not on any docker network). Prometheus
scrape from O01 happens via host loopback (Phase 1) or a dedicated
`monitoring` network bridge (Phase 2 once O01 lands compose updates).

### 7.3 MySQL / Valkey port-mapping policy

In `docker-compose.dev.yml`: `ports:` maps to `127.0.0.1:3306` and
`127.0.0.1:6379` for developer ergonomics.
In `docker-compose.prod.yml.example`: `expose:` only — no `ports:`. Phase 1
prod compose **must inherit this**. F01's `docker-compose.prod.yml.example`
already follows the pattern; O05 IMPLEMENT verifies.

### 7.4 FS host vs container network — RESOLVED

**Container network with explicit port maps in prod.** F01 already uses
`network_mode: host` on Linux dev for RTP-port-mapping ergonomics; prod
should use bridged with `ports:` mapping for 5060–5081 + 7443 +
16384–32768/udp. Trade-off accepted: prod needs explicit
`16384-32768:16384-32768/udp` map (one line). Mac dev keeps the existing
`docker-compose.macos.yml` overlay (F01 PLAN §6).

---

## 8. Cert renewal alerting

### 8.1 Sources of cert truth (FROZEN)

| Cert | Owner | Expiry exposure |
|---|---|---|
| LE wildcard (HTTPS, WSS) | Caddy (Phase 1: certbot) | Caddy `caddy_certificates_expiry_seconds` on admin :2019/metrics |
| FS-side `wss.pem` / `agent.pem` / `tls.pem` / `dtls-srtp.pem` | certbot + render-fs-tls.sh | blackbox_exporter `probe_ssl_earliest_cert_expiry` from daily probe of `fs:5061` and `:7443` |
| STIR/SHAKEN cert | (Phase 2) STI-CA-issued | Phase 2 |

### 8.2 Alert rules (handed to O01 for landing)

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

The last rule needs a metric exporter (`fail2ban-prometheus-exporter`
package on host). O05 IMPLEMENT installs it via the same systemd-managed
script that installs fail2ban.

### 8.3 Rationale for thresholds

- LE renews at 30d remaining; if auto-renew is broken, 14d gives 2-week
  fix window.
- 3d "very soon" alarm catches missed 14d page (vacation/holiday).
- ACME renewal-failure alert catches the silent-failure pattern (RESEARCH
  §16).

### 8.4 Hand-off to O01

O05 PLAN does NOT write the PrometheusRule YAML — that lives in O01's
`monitoring/prometheus/rules/` tree. O05 IMPLEMENT adds an entry to
**O05/HANDOFF.md** asking O01's PLAN/IMPLEMENT to consume the four rules
above.

---

## 9. STIR/SHAKEN scope (Phase 2 doc-only)

### 9.1 Phase 1 = no signing

Per FCC's Eighth Report and Order (2025-09-18 [40][41]):

- vici2 is **not** a Voice Service Provider; carriers (Twilio, Telnyx,
  Bandwidth, RingCentral, SignalWire, Flowroute) sign with their own SPC
  certs at A-attestation for owned numbers.
- Phase 1 has **zero STIR/SHAKEN cert handling**.

### 9.2 Phase 2 deliverable (doc only in O05 IMPLEMENT)

`docs/security/stir-shaken.md` records:

1. When Phase 2 kicks in (we become CLEC, OR offer Hosted Signing as a
   feature for VSP-customers).
2. Ingredients needed: SPC token from STI-PA (apply at
   authenticate.iconectiv.com), STI-CA digital cert, public-cert-host S3
   bucket, PASSporT signing in FS dialplan (mod_signal_wire's
   `stirshaken_sign_da` API or custom Lua + sti-go).
3. Cert lifecycle is **separate** from LE — STI-CA certs are short-lived
   and SP-KME-distributed; needs a different automation path.
4. Per-call attestation logic (A/B/C decision tree) is owned by us, not
   by Hosted Signing vendors.
5. ASN.1 OID `1.3.6.1.5.5.7.1.26` MUST be present in cert.
6. RMD recertification deadline 2026-03-01 [43] noted for operators.

---

## 10. Recording handling at rest

### 10.1 Property matrix (FROZEN — R02/R03 own the implementation)

| Property | Mechanism | Owner |
|---|---|---|
| Encryption at rest | S3 SSE-KMS, customer-managed CMK | O05 (KMS key + IAM policy) + R03 (worker upload code) |
| Immutability | S3 Object Lock **compliance mode**, 4-year retention | O05 (bucket policy) |
| Access | Signed URLs only, max 15-min TTL, signature v4 | R02 (download endpoint) |
| Audit | Every signed-URL mint → `audit_event`; CloudTrail for direct S3 ops | F02 (audit_event) + O05 (CloudTrail config) |
| Transport | Bucket policy `aws:SecureTransport=true` denies HTTP | O05 |
| Versioning | Mandatory (Object Lock requires) | O05 |

O05 IMPLEMENT's contribution: **`infra/aws/recordings-bucket.tf`** Terraform
module skeleton (or CloudFormation equivalent) for the bucket + KMS key +
IAM policy. R02/R03 consume it.

### 10.2 Data-flow

```
freeswitch  ──record_session──> /var/lib/freeswitch/recordings (volume)
worker      ──reads──> encodes (opus / mp3) ──puts to S3 SSE-KMS+ObjectLock──> vici2-recordings-prod
                                              │
                                              └─ writes recording_index row in MySQL
After successful S3 PUT + index row, FS-local file unlinked.
Retention is in S3 only.
```

(Path matches F03 PLAN §0 #8 frozen template:
`/var/lib/freeswitch/recordings/<tenant_id>/<YYYY>/<MM>/<DD>/<campaign_id>_<lead_id>_<call_uuid>.wav`.)

---

## 11. MFA scope

### 11.1 Phase split (FROZEN)

| Phase | Method | Owner |
|---|---|---|
| 1 | Schema hooks only (`users.totp_required`, `session.totp_verified`, `requireTotp` middleware stub) — F05 PLAN §0 #10 already frozen | F05 |
| 2 | TOTP RFC 6238 (admin role required, agent role optional) | F06 |
| 3 | WebAuthn (FIDO2) for super_admin + admin | F07 |

O05 PLAN does NOT introduce new MFA work; it consumes F05's hooks and
escalates to F06 in HANDOFF.

### 11.2 Admin-UI MFA enforcement (Phase 2 binding)

Documented in `docs/security/threat-model.md` (admin row): MFA mandatory
for `role=admin` + `role=super_admin`. Phase-1 workaround = ops-jump-host
allowlist + JWT short-TTL (15min) + audit_event-everything pattern.

---

## 12. Secrets inventory (FROZEN)

### 12.1 Catalog

| Secret | Where lives (Phase 1) | Where lives (Phase 4) | Rotation cadence | Owner |
|---|---|---|---|---|
| `VICI2_KEK_V1`, `..._V2`, ... | env (`.env`, host env, SSM Parameter Store in prod) | Hashicorp Vault Transit | 12 mo routine, <24h emergency | O05 (this runbook) |
| `VICI2_KEK_CURRENT_VERSION` | env | env (still) | follows KEK rotation | O05 |
| `VICI2_KEK_PROVIDER` | env (`env`) | env (`vault` or `kms`) | static | O05 |
| `VICI2_JWT_PRIVATE_KEY_JWK` | env (base64 JSON) | Vault | quarterly | F05 (rotation runbook) |
| `VICI2_JWT_PUBLIC_KEYS_JWKS` | env (JWKS array) | Vault | quarterly (rolls with private) | F05 |
| `VICI2_PASSWORD_PEPPER` | env (32 bytes) | Vault | rarely (rotation requires user re-login) | F05 |
| `SIGNALWIRE_TOKEN` | **build-arg only** (CI secret); never runtime env | unchanged | when SignalWire issues new PAT | F03 |
| `DATABASE_URL` (incl. password) | env (per-service user creds) | Vault dynamic creds | quarterly | F02 |
| `VALKEY_URL` (incl. password) | env (per-service ACL user) | Vault dynamic creds | quarterly | F04 |
| `FS_EVENT_SOCKET_PASSWORD` | env | Vault | quarterly | F03 |
| `API_JWT_SECRET` (legacy from F01) | env — superseded by `VICI2_JWT_PRIVATE_KEY_JWK` once F05 IMPLEMENT lands | n/a | n/a | F05 |
| `API_JWT_REFRESH_SECRET` (legacy from F01) | env — superseded by F05 refresh-token Valkey storage | n/a | n/a | F05 |
| Carrier creds (per gateway) | encrypted in DB column (`carrier_gateways.password_ct`) via F05 envelope encryption | unchanged | per-carrier policy | T02 |
| `VICI2_ACME_EMAIL` | env | env | rare | O05 |
| `AWS_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` (Route53 ACME) | env (dev) / IAM instance role (prod) | IAM only | n/a (instance role) | O05 |
| TURN credentials (`TURN_URL`, `_USERNAME`, `_PASSWORD`) | env | Vault | per coturn policy | F03 |
| Slack/PagerDuty webhook URLs | env | Vault | per-incident | O01 |

### 12.2 Storage tiers (FROZEN)

- **Phase 1 dev**: `.env` (gitignored; `.env.example` committed for names).
- **Phase 1 prod**: AWS SSM Parameter Store with `SecureString` type; pulled
  by container entrypoint via `aws ssm get-parameter` (envconsul-style).
  O04 PLAN §6 already commits to this.
- **Phase 4**: Hashicorp Vault (Transit for KEKs, KV for everything else,
  dynamic creds for DB/Valkey).

### 12.3 Build-arg vs runtime env

`SIGNALWIRE_TOKEN` is a build-arg (Dockerfile `ARG`), passed via
`docker buildx build --build-arg`. It is **never** in the running container's
env. Pattern documented in F01 PLAN and inherited by F03 Dockerfile.

### 12.4 Secret-leak detection

- gitleaks pre-commit + CI (already wired by F01 + O04).
- Supplemental: `.gitleaks.toml` adds custom rules for the vici2-specific
  prefixes (`VICI2_KEK_`, `vici2-kek:`, base64-32-byte high-entropy strings).
  Rules added by O05 IMPLEMENT.

---

## 13. File outputs (FROZEN — IMPLEMENT writes these)

```
infra/caddy/Caddyfile.example                       — Caddy reverse proxy + ACME config (DNS-01 Route53)
infra/caddy/install.sh                              — host-side install script (xcaddy + systemd unit)
infra/caddy/README.md                               — Phase 1 host install vs Phase 2 compose
infra/certbot/render-fs-tls.sh                      — --deploy-hook for FS cert distribution
infra/certbot/install.sh                            — host-side certbot setup (snap + DNS plugin)
infra/fail2ban/jails/sshd.local                     — sshd jail
infra/fail2ban/jails/freeswitch.local               — FS auth-failure jail (mode=normal)
infra/fail2ban/jails/freeswitch-dos.local           — FS DDoS jail (mode=ddos)
infra/fail2ban/jails/caddy-auth.local               — Caddy login flood
infra/fail2ban/jails/caddy-4xx-flood.local          — Caddy 4xx flood
infra/fail2ban/jails/ignoreip.local                 — ops-jump-host allowlist template
infra/fail2ban/filter.d/freeswitch.conf             — FS 1.10.7+ regex
infra/fail2ban/filter.d/caddy-auth.conf             — Caddy 401/403 regex
infra/fail2ban/filter.d/caddy-4xx-flood.conf        — Caddy 4xx regex
infra/fail2ban/action.d/vici2-audit.local           — POST to api audit endpoint on ban
infra/fail2ban/install.sh                           — install + enable jails on host
infra/iptables/sip-prefilter.sh                     — string-match + hashlimit for SIP
infra/iptables/install.sh                           — systemd-managed iptables-restore
infra/aws/recordings-bucket.tf                      — S3 + KMS + Object Lock module skeleton
.github/workflows/security-scan.yml                 — ZAP baseline + (manual) full scan
.gitleaks.toml                                      — augment with VICI2_KEK_ rules
.zap/rules.tsv                                      — known FP allowlist for ZAP
.zap/context.zap                                    — auth context for scanner
docs/security/threat-model.md                       — STRIDE per component, per RESEARCH §6
docs/security/incident-response.md                  — IR plan with playbooks
docs/security/stir-shaken.md                        — Phase 2 doc-only
docs/security/scan-policy.md                        — severity thresholds + waiver process
spec/runbooks/security-incident.md                  — terse operator checklist
spec/runbooks/kek-rotation.md                       — phased dual-key procedure
spec/runbooks/cert-renewal.md                       — manual override / troubleshoot
.env.example (amend)                                — VICI2_ACME_*, VICI2_KEK_PROVIDER, etc.
```

**Constraint reminder**: PLAN does NOT write any of these files. IMPLEMENT does.

---

## 14. Verification phase (acceptance criteria — what VERIFY runs)

Each acceptance criterion in O05.md maps to a concrete check:

| Criterion | VERIFY check |
|---|---|
| TLS everywhere | `openssl s_client -connect staging.vici2.example.com:443` returns valid LE cert; `:7443` (WSS) returns same wildcard; `:5061` (FS SIP-TLS) returns LE cert; `curl -k -I https://staging` shows HSTS header |
| fail2ban active | `fail2ban-client status` lists 5 jails; `fail2ban-client status freeswitch` shows non-zero `Total failed`; staged SSH brute-force triggers ban (script in VERIFY) |
| CI security gates | `gh run list --workflow=ci.yml --limit=5` shows trivy-image, govulncheck, gitleaks all green on latest main; `gh run list --workflow=security-scan.yml` shows ZAP baseline pass |
| Threat model + IR doc | `docs/security/threat-model.md` exists, has 6 component matrices, each row links to a F-module PLAN; `docs/security/incident-response.md` has 5 playbooks |
| KEK rotation runbook | `spec/runbooks/kek-rotation.md` exists; dry-run command actually runs in CI integration test against fixture data |
| Pen-test scheduled | `docs/security/scan-policy.md` notes pen-test cadence (annual + post-major-release, Phase 2+); README has section pointing operators to the schedule |

Plus per-implementation checks:
- `caddy validate` parses Caddyfile.example clean.
- `fail2ban-client -t -c <repo>/infra/fail2ban` validates filter regex.
- `iptables-restore -t < infra/iptables/sip-prefilter.rules` parses clean.
- ZAP baseline run against staging completes <10 min.
- Trivy run on a built `api` image shows no HIGH/CRIT (or annotated `.trivyignore`).

---

## 15. Out of scope (Phase 2+, explicit defer)

| Item | Where it lands |
|---|---|
| Caddy as compose service | F01 amendment Phase 2 |
| Hashicorp Vault Transit as KEK backend | Phase 4 (M03 likely owner) |
| AWS KMS as KEK backend (alternative to Vault) | Phase 4 |
| WebAuthn (FIDO2) for admins | F07 (Phase 3) |
| TOTP for agents/admins | F06 (Phase 2) |
| STIR/SHAKEN signing | Phase 2 if we become VSP / Phase 4 if Hosted Signing feature |
| SOC 2 Type II | Phase 4 (regulated-customer prerequisite) |
| Pen-test execution | Per-customer; vendor selection deferred to operator |
| HSM-backed signing keys | Phase 4 (separate runbook) |
| Per-pod NetworkPolicy + WAF | Phase 4 (k8s migration) |
| append-only audit-log hash chain | F02 hardening Phase 2 |
| TLS on Valkey (internal docker net) | Phase 2 (multi-host migration) |

---

## 16. Risks

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| LE auto-renew silently fails (DNS provider creds expire, RFC2136 keychange, etc.) | Medium | High | `caddy_acme_renew_failures_total > 0 for 30m` page; cert-expiry-<14d page; manual `certbot renew --force-renewal` fallback in cert-renewal runbook |
| fail2ban legitimate-IP false-positive (ops jump host shared with NAT pool) | Medium | Medium | `ignoreip.local` allowlist for ops jump hosts; `caddy-4xx-flood` short bantime (600s); admin endpoint to unban via api (Phase 2) |
| SignalWire PAT requirement permanent (blocks fully-public CI builds) | High | Low | Build-arg pattern (already F01); CI repo secret; document self-build alternative (~30 min build cost, deferred) |
| sofia-sip per-profile-restart drops WSS regs every 60d | High | Low | F03's 3-profile design isolates blast radius to wss-only; SIP.js auto-reconnects in <5s; schedule renewal at 03:00 local |
| Distroless Node missing libs at runtime (e.g., gRPC native bindings) | Medium | Medium | CI smoke test boots the distroless image and runs `/health` before push; fallback to `node:20-bookworm-slim` if a service hits a hard wall |
| Trivy false-positive blocks deploy | Medium | Low | `.trivyignore` with security-team-reviewed waivers (CODEOWNERS gate); each waiver carries CVE + waived-until + ticket |
| ZAP baseline noise vs PR throughput | High | Low | Threshold = HIGH/CRIT only blocks PR; WARN/INFO tracked in maintained issue; nightly run is the primary signal |
| Operator skips KEK rotation (>12mo without rotate) | Medium | Medium | `vici2_api_auth_kek_age_days` Prometheus gauge; alert at >330d (warn), >365d (page) — owned by O01 |
| AWS SSM Parameter Store quota exceeded | Low | Low | Standard Parameter Store default 10k params; we'll use ~30; document upgrade path |
| Recording S3 bucket misconfigured (public ACL) | Low | Critical | Bucket policy `aws:SecureTransport=true` + Block-Public-Access enforced; AWS Config rule alarms on drift; per-tenant Object Lock retention |
| Cloudflare/Route53 API rate-limit on rapid cert issuance (test envs) | Low | Medium | Use Let's Encrypt staging endpoint for non-prod; `infra/caddy/Caddyfile.example` env-flag `VICI2_ACME_DIRECTORY` defaults to staging in dev |

---

## 17. Hand-off requests

### 17.1 F01 amendment — Phase 2

When the next round of compose work happens, F01 PLAN should add `caddy`
service on `edge` network (Phase-1 caddy is host-installed; Phase 2 brings
it inside compose). No PLAN-time change to F01 — handled at next F01-touch
opportunity. **Phase 1 IMPLEMENT does not block on this.**

### 17.2 F03 amendment — `log-auth-failures` on all profiles

**Action requested**: F03 IMPLEMENT (or follow-up) adds:

```xml
<param name="log-auth-failures" value="true"/>
<param name="log-auth-failures-as-warnings" value="true"/>
```

to `freeswitch/conf/sip_profiles/wss.xml` and
`freeswitch/conf/sip_profiles/external.xml`. F03 PLAN's `internal.xml`
(line 159) already has it.

**Impact**: Without this, the `freeswitch` fail2ban jail cannot fire on
the `wss` and `external` profiles' auth failures.

**Effort**: 2 lines × 2 files. No interface change.

### 17.3 O04 amendment — add 2 jobs to ci.yml

**Action requested**: O04 IMPLEMENT adds two jobs to `ci.yml::sec` stage:

- `govulncheck-go` (Go source-tree vuln scan, call-graph-aware)
- `pnpm-audit-node` (Node source-tree vuln scan, audit-level=high)

**Effort**: ~20 lines YAML each. Consistent with O04 PLAN §3.2 contract
that O05 may add jobs through the existing pipeline.

**Alternative**: O05 IMPLEMENT ships these inside its own
`security-scan.yml`. Decision deferred to IMPLEMENT (lean is in `ci.yml`
so they gate every PR alongside lint/unit; security-scan.yml stays
ZAP-only).

### 17.4 F05 amendment — `dryRun` flag on `rewrapAll`

**Action requested**: F05 IMPLEMENT adds `dryRun?: boolean` parameter to
`encryption.rewrapAll()`:

```ts
encryption.rewrapAll({
  fromVersion, toVersion, batchSize, table,
  dryRun?: boolean,   // NEW
}): Promise<{ rewrapped: number; failed: number; estimatedSeconds?: number }>;
```

Returns row count + estimated runtime when `dryRun=true`; never writes.

**Impact**: KEK rotation runbook (§4) calls this in step 4. Without it,
the runbook can only `SELECT COUNT(*)` and operator has to estimate
runtime manually.

**Effort**: ~10 lines TS, additive — no breaking change to existing
callers.

### 17.5 O01 hand-off — alert rules

**Action requested**: O01 PLAN/IMPLEMENT adds the four alert rules from
§8.2 to its PrometheusRule manifest:

- `CertExpiresSoon` (page at <14d)
- `CertExpiresVerySoon` (critical at <3d)
- `CaddyACMERenewalFailing` (warn on renewal-failures)
- `Fail2banBannedSurge` (warn on >50 bans/10min)

Plus consume the `vici2_api_auth_kek_age_days` gauge (which F05 IMPLEMENT
exports per F05 PLAN §11) for KEK-age alerting (§16 row 8).

### 17.6 R02/R03 hand-off — recordings bucket

**Action requested**: R02 PLAN's IMPLEMENT consumes the Terraform module
at `infra/aws/recordings-bucket.tf` (skeleton shipped by O05 IMPLEMENT).
R03 PLAN's worker code uploads to that bucket using the SSE-KMS key
referenced by env `VICI2_RECORDINGS_BUCKET` + `VICI2_RECORDINGS_KMS_KEY_ID`.

### 17.7 Phase-4 carve-out

The Phase-4 migration to k8s + Vault deletes most of `infra/fail2ban/`
and `infra/iptables/` (replaced by NetworkPolicy + WAF + Falco). O05
HANDOFF.md should record this so the Phase-4 owner knows the cleanup
scope.

---

## 18. Open questions resolved at PLAN

| RESEARCH §11/12 question | Resolution |
|---|---|
| 1. DNS provider for ACME | **Route53** (matches O04 AWS target); Cloudflare alt documented |
| 2. FS host vs container network | **Container network with explicit port maps** in prod; host-net stays in `docker-compose.macos.yml` for dev |
| 3. fail2ban placement | **Host-level**, not in container (needs iptables on Docker daemon NAT) |
| 4. Per-service MySQL users | **YES** — F02 PLAN already commits to per-service users; O05 confirms `vici2_app`, `vici2_app_audit_writer` (likely absorbed into `vici2_app` per F02 grant pattern), `vici2_backup`, `vici2_root` |
| 5. MFA flavor (admin UI) | **TOTP Phase 2 (F06), WebAuthn Phase 3 (F07)** |
| 6. JWT key rotation | **Separate runbook** (different cadence — quarterly), filed for IMPLEMENT bandwidth permitting |
| 7. Cert expiry pager | **Same on-call rotation** as DB/FS pages; coordinate with O01 |
| 8. Pen-test vendor + timing | **Operator-deferred for vendor**; cadence annual + post-major-release Phase 2+ |
| 9. Container registry | **GHCR** (per O04 PLAN); Trivy registry-scan compatible |
| 10. Backup encryption KEK | **Separate** from app KEK (different threat model: backup KEK lives offline) — owned by R03/M-track |
| 11. STIR/SHAKEN Hosted Signing as a feature | **Phase 4+ revenue lever**; not Phase 1 |
| 12. SOC 2 Type II | **Out of scope Phase 1**; document path Phase 4 (target before regulated-customer GA) |

---

## 19. No RFCs raised

O05's choices either (a) match RESEARCH §1 executive summary, (b) match O04
PLAN's already-frozen security-gate surface, or (c) consume F03/F05 PLAN
interfaces without changing them. The four hand-off requests (§17.1–17.4)
are additive, non-breaking, and tracked as amendments rather than RFCs per
SPEC §12 (RFCs required only when an interface change affects downstream
consumers — these expand capability without breaking).

---

End of PLAN.md.
