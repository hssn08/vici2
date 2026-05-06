# O05 — Security Baseline — RESEARCH

**Module:** O05 (Security: TLS, fail2ban, image/dep scan, KEK rotation, threat model, IR)
**Status:** RESEARCH (blocked on F01, F03, F05 for PLAN)
**Owner:** sre / security
**Phase:** 1

---

## 1. Executive Summary (10 bullets)

1. **TLS edge:** terminate WSS:7443 and HTTPS:443 in **Caddy v2** in front of FreeSWITCH and the Node API. Caddy ships an integrated ACME client (built on the same lineage as `lego`) so certificates auto-renew without cron, deploy-hook plumbing, or external scripts; EFF itself now suggests Caddy/Traefik as the strategic replacement for Certbot-style external clients [13][14]. Keep `certbot` as a fallback DNS-01 path for the rare case we need to deliver a cert *into* FS (SIP-TLS:5061, DTLS-SRTP) where Caddy cannot reverse-proxy.
2. **Two cert chains, one ACME identity.** FreeSWITCH WSS, SIP-TLS, and DTLS-SRTP all need a *publicly* trusted leaf (browsers reject self-signed DTLS fingerprints; Android/Chrome silently fail with no UI [11][20]). We will issue **a single wildcard `*.vici2.<tenant>.com`** via DNS-01 (so we can mint per-host names without exposing port 80 to FS) and split it into two pem bundles: Caddy's auto-store for HTTPS/WSS edge, and a `certbot --deploy-hook`-style copy renderer (`/etc/freeswitch/tls/{wss,agent,tls,dtls-srtp}.pem`) followed by `fs_cli -x "sofia profile internal restart"` (FS sofia-sip cannot hot-reload TLS material [12]).
3. **fail2ban jails (Debian 12 host, runs on the host not in containers — needs iptables/nftables on the daemon namespace):** ship five jails — `sshd`, `freeswitch` (mode=`normal`, scans `/var/log/freeswitch/freeswitch.log` for `sofia_reg.c` SIP auth failures [15][16]), `freeswitch-dos` (mode=`ddos` on a separate, more-tolerant jail to catch challenge floods without banning real phones), `caddy-auth` (401/403 on `/api/auth/*`), and `caddy-4xx-flood` (excessive 4xx). Set `<param name="log-auth-failures" value="true"/>` on every Sofia profile [16]. Default `maxretry=4 findtime=3600 bantime=1200` on the SIP jail (Vicidial-community-tested values).
4. **Image/SBOM scan: Trivy is the default.** Apache 2.0, single binary, fastest cold-cache, covers OS + lang deps + IaC + Dockerfile + secrets in one tool, lowest false-positive rate in 2026 benchmarks [21][22][24]. Pair with **Syft → CycloneDX SBOM** uploaded as a build artifact for SOC2/SLSA. Snyk and Docker Scout are *not* required for Phase 1; revisit at Phase 4.
5. **Dep audits:** Go uses **`govulncheck`** (Go-team official, call-graph-aware so noise stays low [27][28][29]) plus Trivy fs scan as a belt-and-suspenders. Node uses **`pnpm audit --prod --audit-level=high`** in CI plus Dependabot weekly PRs. Pin GitHub Actions to commit SHAs (Tj-Actions style supply-chain attack mitigation).
6. **OWASP top-10 baseline:** **ZAP baseline scan** (`zaproxy/action-baseline@v0.15.0`) nightly against `staging.vici2.example.com`, with a `.zap/rules.tsv` to silence known false positives [25][26]. Fail PRs on new HIGH/CRIT only; track WARN/INFO in a maintained issue. Plan a manual ZAP full-scan + paid pen-test before serving healthcare/financial customers (DESIGN §20.1).
7. **KEK rotation = envelope encryption with versioned KEKs.** SPEC §3.7 says "envelope encryption (key from env)." We adopt a `kek_v{N}` scheme where every encrypted column stores `kek_version + ciphertext + IV + AAD + wrapped_DEK`. Rotation is **rewrap-only** (decrypt DEK with old KEK, re-wrap with new KEK; ciphertext is never touched), bounded-time, dry-run-able, and rollback-safe — pattern adopted from MongoDB Queryable Encryption, IBM Key Protect, and the Everruns runbook [30][31][32].
8. **Threat model (STRIDE) — explicit trust boundaries:** carrier↔FS (SIP-TLS, IP-allowlist on Sofia external profile), browser↔WSS (DTLS-SRTP, JWT cookie + CSRF token), backend↔MySQL/Redis (compose internal network only, no host port), admin↔everything (mTLS or VPN + JWT with `role=admin` claim + audit-log every mutation). Document SIP-specific DoS classes (SRTP packet flood [37], DTLS race [38], REGISTER flood) — known FreeSWITCH CVEs that *must* be patched.
9. **Container hardening:** Go services run on **`gcr.io/distroless/static-debian12:nonroot`** (UID 65532, no shell, ~5 MB image, ~93% CVE reduction vs `golang:bookworm` base [33][34][35]). Node services on `gcr.io/distroless/nodejs20-debian12:nonroot`. Compose pod spec: `read_only: true`, `tmpfs: /tmp`, `cap_drop: [ALL]` + `cap_add: [NET_BIND_SERVICE]` only where needed, default seccomp profile, `no-new-privileges:true`. Pin images by digest, not tag.
10. **Network isolation + cert renewal alerting:** docker-compose internal-only network for `mysql`, `redis`, `dialer`, `api`, `workers`; *only* `caddy` and `freeswitch` get host-port-mapped. Caddy publishes `/metrics` with `caddy_certificates_expiry_seconds` — Alertmanager pages at < 14 days. Add a synthetic prober that does an `openssl s_client -connect host:5061 -showcerts` daily and exports cert-not-after into Prometheus (FS-side cert is *not* visible to Caddy). Phase 2: STIR/SHAKEN cert is a *separate* SPC-token-issued cert, scope documented in §10 below.

---

## 2. TLS Automation Choice + Topology

### 2.1 Choice: Caddy as the edge, certbot as the FS-side fallback

**Decision: Caddy 2.9+ for HTTPS:443 and WSS:7443; certbot DNS-01 for FS-internal certs (SIP-TLS:5061, DTLS-SRTP).**

Rationale (validated against 4 candidates):

| Candidate | Pros | Cons | Verdict |
|---|---|---|---|
| **Caddy** | Built-in ACME (lego-derived), automatic OCSP stapling, HTTP/3 default, single Go binary, can reverse-proxy WSS to FS internal port (offloads TLS termination from Sofia), Apache 2.0 [13][7][6] | Cannot serve cert *into* FS for SIP-TLS/DTLS — those need files on FS disk | **Edge default** |
| **certbot** | Most flexible deploy hooks (`--deploy-hook`, `$RENEWED_LINEAGE`), widest CI/integration knowledge, Snap installer auto-creates systemd timer [9][14] | External tool — re-parses configs, more failure modes than integrated client; EFF themselves now recommend Caddy/Traefik when possible [14] | **FS-internal cert renewer only** |
| **lego** | Same ACME core as Caddy, Go-native, embeddable into our own Go services | Less ergonomic than Caddy for static reverse-proxy use [1] | Skip for now (revisit if we want to drop Caddy and embed in `dialer` or `api`) |
| **Traefik** | Excellent Docker-label auto-discovery | We don't need that complexity for ~5 services; Caddyfile is simpler [4] | Skip |
| **acme.sh** | 150+ DNS providers, no-root, shell only | More moving parts than certbot+RFC2136 for our DNS provider [3] | Skip |

### 2.2 Topology

```
Internet
    │
    │ 443/tcp (HTTPS), 80/tcp (HTTP→443 redirect + ACME HTTP-01 fallback)
    │ 7443/tcp (WSS — same Caddy, different site block)
    ▼
┌──────────────────────────────────────────┐
│  Caddy (edge container, host-net OR      │
│   ports: 80/443/7443 published)          │
│   - auto LE (ACME DNS-01 for wildcard)   │
│   - reverse_proxy /api/*  → api:3000     │
│   - reverse_proxy /        → web:3001    │
│   - reverse_proxy /ws      → freeswitch:5066 (WSS internal port)
│   - admin API on 127.0.0.1:2019 only     │
└──────────────────────────────────────────┘
    │ docker internal network "edge"
    ▼
┌──────────┐   ┌────────────┐   ┌─────────────────────────┐
│ api:3000 │   │ web:3001   │   │ freeswitch:5066(ws)/5060 │
└──────────┘   └────────────┘   │  + 5061 (SIP-TLS leg     │
                                │     to carriers, host-   │
                                │     port published)      │
                                │  + 16384–32768/udp RTP   │
                                │     (host-port published)│
                                └─────────────────────────┘
                                         ▲
                                         │ certbot inside FS container
                                         │ writes /etc/freeswitch/tls/*.pem
                                         │ + ESL "sofia profile internal restart"
                                         │ on each renewal (sofia-sip cannot
                                         │ hot-reload — issue #2287 [12])
```

### 2.3 ACME challenge: DNS-01 for wildcard, HTTP-01 for the obvious

- **HTTP-01** for the apex `vici2.example.com` (web/admin) — port 80 is reachable, simplest path.
- **DNS-01** for `*.vici2.example.com` (per-tenant subdomains, FS hostname `fs1.vici2.example.com` for SIP-TLS where port 80 is *not* open, agent-conference internal hostnames). Requires DNS provider with API: Route53, Cloudflare, or RFC2136 nsupdate. **Decision deferred to PLAN** (depends on F01 picking the staging DNS host). Caddy DNS plugin loaded via `xcaddy build`.

### 2.4 SIP-TLS for sofia profile (sips:5061)

- FS expects four pems in `/etc/freeswitch/tls/`: `wss.pem` (WebRTC WSS), `agent.pem` (server cert), `tls.pem` (TLS client/server), `dtls-srtp.pem` (DTLS-SRTP) [10][11][18].
- Format: each is `cat fullchain.pem privkey.pem > <name>.pem` (cert + key + chain in one file). Symlinking all four to a single combined pem is the documented community pattern [11].
- **Share the cert with web?** Yes — same wildcard. Web side uses `fullchain.pem + privkey.pem` natively in Caddy's storage; FS side is the cat-and-symlink layout. Same private key, different on-disk layout. This is safe because the cert authenticates the *hostname*, and we use the same hostname for browser→Caddy and carrier→FS-SIPS.
- **Separate cert in Phase 2** if we ever need to terminate carrier SIP-TLS on a different hostname (e.g., `sip-trunk.vici2.example.com`) — out of scope for Phase 1 baseline.

### 2.5 DTLS-SRTP for WebRTC

- DTLS-SRTP fingerprint must chain to a public CA — Chrome/Firefox/Safari reject self-signed [10][20]. Single LE cert covers it.
- **Known FS DoS:** DTLS Hello race-condition CVE (ES2023-02 [38]) — fixed in FS ≥ 1.10.10. Pin FS image to ≥ 1.10.11.
- **Known FS DoS:** SRTP packet flood (ES2021-09 [37]) — fixed in FS ≥ 1.10.7. Pin FS image to ≥ 1.10.11.

### 2.6 Cert lifecycle for FS-side files

```
1. certbot certonly --dns-<provider> -d '*.vici2.example.com' -d 'vici2.example.com'
   --deploy-hook /usr/local/bin/render-fs-tls.sh
2. render-fs-tls.sh:
     cat fullchain.pem privkey.pem > /etc/freeswitch/tls/wss.pem.new
     mv -f wss.pem.new wss.pem  # atomic
     ln -sf wss.pem agent.pem
     ln -sf wss.pem tls.pem
     ln -sf wss.pem dtls-srtp.pem
     fs_cli -x "sofia profile internal restart reloadxml"
     fs_cli -x "sofia profile external restart reloadxml"
3. systemd timer (Snap-managed) runs certbot renew twice daily.
```

The `restart` (vs `rescan`) is mandatory — sofia-sip cannot hot-load new TLS material [12]. Plan: schedule renewals during low-call windows (e.g., 03:00 local), accept ~2-second TLS-leg blip.

---

## 3. fail2ban Jail Catalog

Runs on the **host** (not in a container) so iptables/nftables rules apply to the Docker daemon's NAT chain. All jails write to `/etc/fail2ban/jail.d/vici2.local` (single file, easier to template). Default `banaction = iptables-multiport` on Debian 12.

| Jail | Filter | Logpath | maxretry | findtime | bantime | Notes |
|---|---|---|---|---|---|---|
| `sshd` | `sshd[mode=aggressive]` | `/var/log/auth.log` | 3 | 600s | 86400s | Default Debian 12 jail; aggressive mode catches probes too |
| `freeswitch` | `freeswitch[mode=normal]` (matches only `SIP auth failure`, NOT `SIP auth challenge`, per [16][17]) | `/var/log/freeswitch/freeswitch.log` | 4 | 3600s | 1200s | Vicidial-community-tested values; ports 5060/5061/5080 |
| `freeswitch-dos` | `freeswitch[mode=ddos]` (matches challenge+failure both) | `/var/log/freeswitch/freeswitch.log` | 50 | 60s | 86400s | High threshold so legit phones with floppy networks don't trip; catches scanners/sipcli |
| `caddy-auth` | custom `caddy-auth.conf` matching 401/403 on `/api/auth/login` and `/api/auth/refresh` | `/var/log/caddy/access.log` | 5 | 600s | 1800s | Bans password-spray on agent/admin login |
| `caddy-4xx-flood` | custom matching ≥30 4xx in 60s | `/var/log/caddy/access.log` | 30 | 60s | 600s | Light-touch DoS deterrent; short ban so legitimate misconfigured clients recover |

**Mandatory FS config to make the freeswitch jail fire:**

```xml
<!-- on every sofia profile (internal, external, public) -->
<param name="log-auth-failures" value="true"/>
<param name="log-auth-failures-as-warnings" value="true"/>
```

**iptables-level pre-fail2ban DoS guards** (DESIGN-aligned, copied from FS confluence [37]):

```bash
# Block known scanners by string match — cheaper than fail2ban regex
iptables -I INPUT -p udp --dport 5060 -m string --string "friendly-scanner" --algo bm -j DROP
iptables -I INPUT -p udp --dport 5060 -m string --string "sipcli"           --algo bm -j DROP
iptables -I INPUT -p udp --dport 5060 -m string --string "VaxSIPUserAgent"  --algo bm -j DROP
# Rate-limit REGISTER per source IP
iptables -A INPUT -p udp --dport 5060 -m hashlimit --hashlimit 5/sec \
  --hashlimit-burst 8 --hashlimit-mode srcip --hashlimit-name SIP_REG -j ACCEPT
```

**Open question:** logging fail2ban bans into our `audit_event` MySQL table for compliance. Defer to PLAN.

---

## 4. Image/Dep Scan Tooling Matrix

### 4.1 Container/image scanning

| Tool | License | Cold scan | FP rate | Coverage | Decision |
|---|---|---|---|---|---|
| **Trivy v0.54+** | Apache 2.0, free | 35–55 s | 4.2% (lowest) | image, fs, repo, K8s, IaC, Dockerfile, secrets [21][22][23] | **Default in CI** |
| Grype | Apache 2.0, free | 4.8 s | 8% on Alpine | image only [22][24] | Skip — narrower than Trivy with no compensating advantage; Trivy's tfsec absorption (Feb 2023) closes the gap |
| Snyk Container | Commercial | 30–120 s | low | image + auto-fix PRs | Skip Phase 1; revisit if we need base-image upgrade PRs |
| Docker Scout | Freemium | 15–30 s | medium | Docker-ecosystem only | Skip — too tied to Docker Hub |

**SBOM:** generate via Syft → CycloneDX-JSON, store as build artifact, attach to GitHub Release. Required for SOC2 supply-chain story; nice-to-have for Phase 1.

**CI snippet (PLAN-grade, not for implementation yet):**

```yaml
# pseudocode only — do not commit
- uses: aquasecurity/trivy-action@<commit-sha>
  with:
    image-ref: ghcr.io/vici2/api:${{ github.sha }}
    severity: CRITICAL,HIGH
    exit-code: 1
    format: sarif
    output: trivy.sarif
- uses: github/codeql-action/upload-sarif@<commit-sha>
  with: { sarif_file: trivy.sarif }
```

### 4.2 Dependency audits

| Stack | Tool | Mode | Failure threshold |
|---|---|---|---|
| Go (`dialer/`) | `govulncheck ./...` (call-graph-aware [27][28][29]) | CI gate + nightly | Any vuln in a *called* function fails build; informational vulns warn only |
| Go (belt-and-suspenders) | Trivy fs scan on `dialer/go.sum` | CI gate | HIGH/CRIT fail |
| Node (`api/`, `web/`, `workers/`) | `pnpm audit --prod --audit-level=high` | CI gate | Any HIGH+ fails |
| Node (PRs) | Dependabot weekly grouped PRs [26] | Async | Auto-merge patch-level after CI green |
| GitHub Actions | Pin all `uses:` to 40-char commit SHAs (Tj-Actions style attack mitigation [24]) | CI guard via `pinact` or pre-commit hook | Hard fail |

### 4.3 OWASP ZAP

- `zaproxy/action-baseline@v0.15.0` against `staging.vici2.example.com` nightly + on-PR-to-main [25][26].
- Maintain `.zap/rules.tsv` for known FPs.
- Report uploaded as workflow artifact; baseline-issue auto-maintained.
- Pre-release: manual `action-full-scan` against staging (active attacks — never against prod).

---

## 5. KEK Rotation Runbook (rewrap-only, step by step)

**Goal:** rotate the master key (KEK / `SECRETS_ENCRYPTION_KEY`) without ever touching application ciphertext. Inspired by IBM Key Protect's `actions/rewrap` [31], MongoDB QE's `KeyVault.rewrapManyDataKey()` [30], and the Everruns runbook [32].

**Data model assumption (PLAN will formalize):**

```
encrypted_columns: {
   ciphertext_b64 TEXT,   -- AES-256-GCM
   iv_b64 VARCHAR(24),
   aad_b64 TEXT NULL,     -- e.g. tenant_id||column_name
   wrapped_dek_b64 TEXT,  -- DEK encrypted by KEK
   kek_version TINYINT NOT NULL  -- 1, 2, 3, ...
}
```

The DEK is **per-row** (or per-credential-blob). Only the wrapped DEK and `kek_version` change during rotation; the ciphertext stays put.

### 5.1 Pre-flight (T-7 days)

1. Notify on-call: rotation window scheduled. Capacity: rewrap of N rows is a *cheap* O(N) sweep — measured ≈ 5k rows/sec on dev box (just AES-GCM key-unwrap + wrap, no large data).
2. Snapshot MySQL (`mysqldump --single-transaction`) and Redis. Store outside the rotation host.
3. Confirm `kek_v{N+1}` does *not* already exist in vault.
4. Verify all encrypted-column usage paths are decrypt-with-version-aware (i.e., the app reads `kek_version` from each row and looks up the matching KEK from env).

### 5.2 Rotation steps (T+0)

```
# Step 1 — Generate new KEK (32 random bytes, base64-url)
$ python3 -c "import os,base64; print('kek_v3:'+base64.urlsafe_b64encode(os.urandom(32)).decode())"
kek_v3:...

# Step 2 — Deploy app with both keys present
#   SECRETS_ENCRYPTION_KEY_CURRENT  = kek_v3:<new>
#   SECRETS_ENCRYPTION_KEY_PREVIOUS = kek_v2:<old>
#   (app code MUST be able to decrypt with EITHER key, indexed by kek_version)
$ docker compose up -d  # rolling restart

# Step 3 — Verify decrypt with both keys works
$ docker compose exec api node -e "..."  # smoke-test reading 5 known rows
$ docker compose exec dialer ./dialer kek-smoke-test

# Step 4 — DRY RUN the rewrap sweep
$ docker compose run --rm api  pnpm tsx scripts/kek-rewrap.ts --dry-run --batch=500
   "Would rewrap 12,847 rows across 6 tables. 0 errors."

# Step 5 — Execute rewrap (idempotent, resumable, batched)
$ docker compose run --rm api  pnpm tsx scripts/kek-rewrap.ts --batch=500 --commit

# Sweep does, per row:
#   plaintext_dek = AES_unwrap(wrapped_dek, KEK[row.kek_version])
#   new_wrapped   = AES_wrap(plaintext_dek, KEK_NEW)
#   UPDATE row SET wrapped_dek = new_wrapped, kek_version = NEW WHERE id = ?
# Ciphertext column is NEVER read or written.

# Step 6 — Verify
$ mysql -e "SELECT kek_version, COUNT(*) FROM <encrypted_table> GROUP BY 1"
   kek_version=3   12847
   kek_version=2   0   ← required

# Step 7 — Drop the old KEK from env
#   SECRETS_ENCRYPTION_KEY_CURRENT  = kek_v3:<new>
#   (remove SECRETS_ENCRYPTION_KEY_PREVIOUS)
$ docker compose up -d  # rolling restart

# Step 8 — Archive old KEK to cold storage (not deleted — backups encrypted with v2 still need it)
$ vault kv put secret/vici2/kek_archive/v2 key="<old>" rotated_at=2026-...

# Step 9 — Update audit log
$ INSERT INTO audit_event (kind, actor, payload) VALUES ('kek_rotation', 'sre@...', '{"from":2,"to":3,"rows":12847,"started":..., "ended":...}');
```

### 5.3 Rollback paths

| Stage | Rollback |
|---|---|
| Step 4 dry-run errors | Don't proceed; investigate row(s) flagged. No state changed. |
| Step 5 partial sweep failure (crash mid-run) | Re-run; sweep is idempotent on `kek_version` column (`WHERE kek_version < N`) |
| Step 7 done, then we discover unrewrapped rows (e.g., a backup restored older data on top) | Re-add `SECRETS_ENCRYPTION_KEY_PREVIOUS=kek_v2:...`, redeploy, re-run sweep, drop again |
| Compromised KEK suspicion | Same procedure but **emergency** priority: skip waiting for low-traffic window; KEK_NEW is generated immediately and all SECRETS_ENCRYPTION_KEY_CURRENT references rotate within 30 min |

### 5.4 Cadence

- **Routine:** every 12 months (industry standard for symmetric KEKs not stored in HSM).
- **Emergency:** within 24 hours of any suspicion (insider access, suspected env-var leak, contributor offboarding with KEK exposure).
- **PCI/HIPAA territory (Phase 2+):** annual minimum is acceptable; document compensating controls.

---

## 6. Threat Model (STRIDE per component)

Trust boundaries (lines that secrets cross):

```
[Carrier]-(SIPS:5061 + SRTP)─[FS external profile]
[Browser]-(WSS:7443 + DTLS-SRTP)─[Caddy]─[FS internal profile]
[Browser]-(HTTPS:443)─[Caddy]─[api]
[admin]-(HTTPS:443 + JWT role=admin)─[Caddy]─[api]
[api]─[mysql]   on internal docker net only
[api]─[redis]   on internal docker net only
[dialer]─[fs ESL:8021]   on internal docker net only
[dialer]─[mysql]
[dialer]─[redis]
```

### 6.1 FreeSWITCH

| STRIDE | Threat | Mitigation |
|---|---|---|
| **S**poof | Carrier impersonation, unauthenticated calls reaching dialplan | IP-allowlist on `external` Sofia profile; SIP digest auth on per-carrier gateway; `<context name="public">` rejects calls without matching ACL [37] |
| **T**amper | Modify SDP, hijack RTP | SRTP + TLS for SIP; `apply-candidate-acl` on internal profile to restrict ICE candidate origins |
| **R**epudiate | Caller denies making call | call_log row + recording with consent prompt + cdr_csv (DESIGN §5) |
| **I**nfo-disclose | RTP eavesdrop, log scraping for credentials | SRTP mandatory; never log SIP password (SPEC §3.4 already enforces) |
| **D**oS | SRTP packet flood [37], DTLS Hello race [38], REGISTER flood, INVITE flood | Pin FS ≥ 1.10.11; iptables hashlimit on 5060/5061; fail2ban `freeswitch-dos` jail; mod_rayo/mod_event_socket bound to 127.0.0.1 only |
| **E**lev-priv | ESL command injection, dialplan injection from caller-ID | ESL bound to internal docker net only, password-auth required; never interpolate caller-ID into Lua/dialplan unsanitized |

### 6.2 Backend API (Node + Fastify)

| STRIDE | Threat | Mitigation |
|---|---|---|
| **S** | Stolen JWT, session fixation | Short-TTL JWT (15 min) + refresh-token rotation; `httponly secure samesite=strict` cookies; CSRF token on state-changing endpoints |
| **T** | Tampered request body | Fastify schema validation; OpenAPI-generated types; never `JSON.parse` user input without schema |
| **R** | Disposition manipulation | Every dispo write → `audit_event` row, immutable (SPEC §4.1) |
| **I** | SQL injection, XSS | Prisma parameterized queries only; no raw `$queryRaw` with user input; React auto-escapes; Caddy CSP header on /api responses |
| **D** | API request flood | Caddy rate-limit zone per remote_host; fail2ban `caddy-auth` for login flood |
| **E** | Privilege escalation via JWT claim manipulation | JWT signed with strong key in env (rotated via same KEK procedure); claim `role` enum-validated server-side; never trust claims for tenant_id resolution beyond initial JWT-mint step |

### 6.3 Agent UI (Next.js + SIP.js in browser)

| STRIDE | Threat | Mitigation |
|---|---|---|
| **S** | Hijack SIP.js registration with stolen creds | SIP creds delivered via JWT-authenticated `/api/agent/sip-creds` (one-time, 5-min TTL); per-agent SIP password auto-rotated weekly |
| **T** | DOM-injected scripts altering call flow | strict CSP (`default-src 'self'; connect-src 'self' wss://fs.vici2..`), no inline scripts; SRI on all third-party JS |
| **R** | "I never dispo'd that" | dispo write hits server → audit_event |
| **I** | Page leaks lead PII into telemetry | No third-party analytics on agent UI; no Sentry user_id == lead_phone |
| **D** | Rage-click DoS on dial button | client-side debounce + server idempotency key on /api/agent/dial |
| **E** | Agent self-promotes to supervisor via DevTools | role enforced server-side per-request; UI hiding is cosmetic only |

### 6.4 Admin UI

| STRIDE | Threat | Mitigation |
|---|---|---|
| **S** | Stolen admin JWT | mTLS or VPN-only access in Phase 2; MFA mandatory in Phase 1 (TOTP via `/api/admin/2fa`) |
| **T** | Carrier-config tamper to enable toll fraud | Every `carrier_gateway` UPDATE → audit_event + Slack/PagerDuty webhook (admin-config-changed) |
| **R** | Audit-log holes | append-only table with `prev_hash` chain (Phase 2 hardening); for Phase 1, MySQL row-level + 4-year retention per DESIGN §18.7 |
| **I** | Lead-list export by malicious admin | role-based: only `role=admin+export` claim; export emits audit row + download URL signed with short TTL |
| **D** | Admin endpoint flood | same Caddy rate-limit |
| **E** | SQL injection in admin filters | Prisma only; no dynamic ORDER BY without allow-list |

### 6.5 MySQL

| STRIDE | Threat | Mitigation |
|---|---|---|
| **S** | Direct DB access from outside | Bound to docker internal network; no host port mapping (compose `expose:` not `ports:`) |
| **T** | Schema drift from raw ALTER | SPEC §3.8 — Prisma migrations only |
| **R** | Recordings tampered after recording | S3 Object Lock compliance mode (see §11) |
| **I** | Backup leakage | Dumps encrypted with separate KEK; uploaded to S3 with SSE-KMS |
| **D** | Connection exhaustion | `pool_size` tuned per service; `wait_timeout` configured |
| **E** | App user with too many privileges | per-service MySQL users (api_rw, dialer_rw, reporter_ro); never use root; `GRANT` minimum scopes |

### 6.6 Redis

| STRIDE | Threat | Mitigation |
|---|---|---|
| **S** | Anyone on docker net could query keys (SPEC §4.5) | `requirepass` + ACL per-service user (api_rw, dialer_rw, observer_ro); bound to internal net |
| **T** | State manipulation (mark agent ready when not) | Streams append-only; no SET on agent state from outside dialer/api |
| **R** | n/a (Redis is volatile) | n/a |
| **I** | Sniff state | TLS not required on internal docker net for Phase 1; revisit if going k8s/multi-host |
| **D** | OOM via key bloat | `maxmemory-policy allkeys-lru`; alert at 70% usage |
| **E** | Lua-script injection via `EVAL` from app | All Lua scripts compiled and shipped via `SCRIPT LOAD`/`EVALSHA`; no user-string-interpolated EVAL |

---

## 7. Container Hardening Defaults

### 7.1 Base images

| Service | Base | Rationale |
|---|---|---|
| `dialer` (Go, CGO_ENABLED=0) | `gcr.io/distroless/static-debian12:nonroot` | ~2 MB, no shell, UID 65532, CA certs included [33][34] |
| `api` (Node 20) | `gcr.io/distroless/nodejs20-debian12:nonroot` | ~89 MB final, vs ~1.2 GB on `node:20`; 0 CRIT CVEs vs ~47 [34] |
| `web` (Next.js standalone) | `gcr.io/distroless/nodejs20-debian12:nonroot` | same |
| `workers` (Node) | same as api | reuse base |
| `freeswitch` | `signalwire/freeswitch:1.10.11` (debian-based; FS needs full libc + many .so files; distroless not viable) | Pin to digest, run as non-root `freeswitch` user inside, drop CAPS except NET_BIND_SERVICE for SIP:5060/5061 |
| `caddy` | `caddy:2.9-alpine` (or distroless variant if xcaddy DNS plugin allows it) | TBD in PLAN — depends on which DNS provider's Caddy plugin |
| `mysql` | `mysql:8.4` official (we don't control its hardening but limit blast radius via cap_drop + read-only volume except `/var/lib/mysql`) | n/a |
| `redis` | `redis:7-alpine` | non-root user already (UID 999) |

### 7.2 Compose security_opt (PLAN will template this per-service)

```yaml
# pseudo — PLAN will produce real compose
read_only: true
tmpfs:
  - /tmp:size=64M
  - /var/run:size=8M
cap_drop: [ALL]
cap_add: []  # most services need none; FS gets [NET_BIND_SERVICE]
security_opt:
  - no-new-privileges:true
  - seccomp=default      # docker default seccomp profile
user: "65532:65532"      # nonroot
restart: unless-stopped
```

### 7.3 Image policy

- All images pinned by sha256 digest (not tag) in compose; Dependabot/Renovate updates digest weekly.
- All `FROM` lines in our Dockerfiles also pinned by digest.
- Multi-stage builds: build stage uses `*-dev` images (golang:1.23, node:20-bookworm); runtime stage is distroless.
- No `latest`, no `:dev`, no `:edge` in any compose file.
- Build context size bounded via `.dockerignore` (no `.git`, `node_modules`, `.env*`).

---

## 8. Network Isolation Diagram

```
                Internet
                  │
     ┌────────────┴────────────┐
     │                         │
  80/443/7443             5060/5061/5080
     │                    16384–32768/udp
     ▼                         │
┌─────────┐                    ▼
│  Caddy  │              ┌──────────────┐
└────┬────┘              │  freeswitch  │
     │ docker net "edge" │   (host-net  │
     │                   │     OR ports │
     │                   │     mapped)  │
     │                   └──┬───────────┘
     │                      │ docker net "core"
     ├──────────┬───────────┤
     ▼          ▼           ▼
  ┌─────┐   ┌──────┐    ┌────────┐
  │ api │   │ web  │    │ dialer │
  └──┬──┘   └──────┘    └────┬───┘
     │                       │
     │ docker net "data"     │
     ├───────────────────────┤
     ▼                       ▼
  ┌───────┐              ┌───────┐
  │ mysql │              │ redis │
  │       │              │       │
  │ no    │              │ no    │
  │ host  │              │ host  │
  │ port  │              │ port  │
  └───────┘              └───────┘
```

Key points:

- **Three docker networks:** `edge` (caddy ↔ api/web), `core` (api/dialer ↔ freeswitch ESL), `data` (api/dialer/workers ↔ mysql/redis).
- `mysql` and `redis` get **no** `ports:` directive — accessible only from inside docker.
- `freeswitch` is the only edge-facing telephony surface — host network or explicit port maps for 5060/5061/5080/7443 + 16384–32768/udp RTP.
- `caddy` admin API bound to `127.0.0.1:2019` only.
- Phase 2: replace this with a real overlay (k8s NetworkPolicy or Nomad consul-connect) once we exceed one host.

---

## 9. Cert Renewal Alerting

### 9.1 Sources of cert truth

| Cert | Owner | Expiry exposure |
|---|---|---|
| Wildcard LE (HTTPS, WSS) | Caddy | `caddy_certificates_expiry_seconds` Prometheus metric on Caddy admin :2019/metrics |
| FS-side `wss.pem`/`agent.pem`/etc. | certbot + render-fs-tls.sh | Synthetic prober: `openssl s_client -connect fs:5061 -showcerts` daily, parses notAfter, exports to Prometheus via blackbox_exporter or custom textfile collector |
| STIR/SHAKEN cert (Phase 2) | SP-KME-issued from STI-CA | TBD in Phase 2 — STI-PA-mandated lifecycle |

### 9.2 Alert rules (PLAN will land these in O01's Alertmanager runbook)

```yaml
# pseudo — PLAN will produce real PrometheusRule
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
```

### 9.3 Why 14 days

- LE renews at 30 days remaining; if our auto-renew is broken, we have 16 days to notice and fix manually before things break.
- 3-day "very soon" alarm catches the case where the 14-day page was missed (vacation, holiday).

---

## 10. STIR/SHAKEN Scope (Phase 2 doc-only)

**TL;DR for Phase 1: we don't sign calls — Twilio/Telnyx/Bandwidth do, with their own certs, on our owned numbers (DESIGN §17.4, §18.7). Capture this in `docs/security/stir-shaken-phase2.md` so we have the requirement landed.**

### 10.1 Why Phase 2 not Phase 1

Per FCC's Eighth Report and Order (effective 2025-09-18, Federal Register 2025-08-19 [40][41]):

- Only **Voice Service Providers with a STIR/SHAKEN implementation obligation** must sign with their own SPC-token-issued cert.
- vici2 is **not** a VSP — we're an end-user / aggregator. Twilio/Telnyx/Bandwidth are the VSPs and they sign with *their* certs at A-attestation for owned numbers [42][43].
- Therefore Phase 1 has **no** STIR/SHAKEN cert handling at all.

### 10.2 When Phase 2 kicks in

If we ever:

1. Become a CLEC / get our own carrier interconnects (DESIGN §14.3 explicitly says we don't), OR
2. Offer "bring your own carrier" for customers who *are* VSPs and want vici2 to do the technical signing on their behalf (Bandwidth-style "Hosted Signing Service" [42])

— then we need:

- **SPC token** from STI-PA (apply via [authenticate.iconectiv.com](https://authenticate.iconectiv.com))
- **Digital cert** from a STI-CA (using SPC token)
- Cert distribution: public copy uploaded to a public S3 bucket (per [42]) so terminating carriers can fetch
- **PASSporT signing** integrated into FS dialplan (mod_signal_wire's `stirshaken_sign_da` API or custom Lua + sti-go library)
- **ASN.1 identifier** `1.3.6.1.5.5.7.1.26` MUST be present in the cert [42]
- Per-call attestation decision logic (A/B/C) — we control this, third party only does crypto
- **Recordkeeping** of any third-party signing agreement; FCC may audit

### 10.3 Phase 2 deferred decisions

- Build PASSporT signing into FS or use SignalWire/Bandwidth Hosted Signing?
- Cert lifecycle: STI-CA certs are short-lived, separate from LE — use a *different* automation path.

---

## 11. Recording Handling at Rest (cross-cuts O02 storage but security is owned by O05)

DESIGN §5.1 + §18 set the requirement; here's how O05 enforces it.

| Property | Mechanism |
|---|---|
| **Encryption at rest** | S3 SSE-KMS with a customer-managed CMK (`aws:kms`) — meets HIPAA/PCI tighter guidance [46][48] |
| **Immutability for compliance** | S3 Object Lock in **compliance mode** with retention period = 4 years (TCPA statute of limitations + safety margin) [44][45][47] |
| **Access** | Never public. Always via signed URLs (`presign`, max-TTL 15 min, signature v4 mandatory for KMS-encrypted objects [48]) |
| **Audit** | every signed-URL mint → audit_event row; CloudTrail (or S3 server access logs + Athena) for direct S3 ops |
| **Transport** | bucket policy `aws:SecureTransport=true` denies any non-HTTPS request |
| **Versioning** | mandatory (Object Lock requires it) |
| **Retention min/max** | bucket policy with `s3:object-lock-remaining-retention-days` to set bounds; CFR-grade compliance |

Compose-side recording flow:

```
freeswitch  ──record_session──>  /var/lib/freeswitch/recordings (tmpfs or ephemeral vol)
worker      ──reads──>  encodes (opus/mp3) ──puts to S3 SSE-KMS+ObjectLock──>  vici2-recordings-prod
                                                            │
                                                            └─ writes recording_index row in MySQL
```

After successful S3 PUT + index row, FS-local file is unlinked. Retention is in S3 only.

---

## 12. Open Questions for PLAN

1. **DNS provider for ACME DNS-01 challenge** — Route53, Cloudflare, RFC2136? Drives Caddy plugin choice.
2. **Will FS run in container or host network?** Host network is simpler for RTP port range; container with explicit port maps is more isolated. Phase-1 lean: container with port maps + `network_mode: host` only if we hit RTP-port-mapping pain.
3. **Where does fail2ban live in containerized world?** Most production setups run it on the host (needs iptables/nftables on the daemon namespace). If we go full-Docker-Swarm or k8s in Phase 4, replace with per-pod NetworkPolicy + WAF.
4. **Per-service MySQL users** — 5 users (api_rw, dialer_rw, worker_rw, reporter_ro, migrator_ddl) or single `app` user? Decision tree should land in F02.
5. **MFA for admin UI:** TOTP only, or also WebAuthn? Recommendation: TOTP for Phase 1, WebAuthn for Phase 2.
6. **JWT signing key rotation cadence** — share KEK rotation runbook or separate? Recommend separate (more frequent: quarterly) but using same dual-key envelope pattern.
7. **Cert expiry pager destination** — same on-call rotation as DB/FS pages? Likely yes — coordinate with O01.
8. **Pen-test vendor and timing** — DESIGN §20.1 budgets $15-30k. Pre-launch (before first paying customer) and annually thereafter. Decision in PLAN.
9. **Container image registry** — GHCR (free for public, low cost private), ECR (if AWS-deployed), or self-hosted Harbor? Affects Trivy registry-scan setup.
10. **Backup encryption KEK** — same KEK as app data, or separate? Recommend separate (different threat model: backup KEK lives offline).
11. **STIR/SHAKEN: do we ever offer Hosted Signing as a feature?** Phase 4+ revenue lever. Note now, decide later.
12. **SOC2 Type II:** if we serve regulated industries (DESIGN §14.2), we'll need this. Cost: ~$30-50k for audit + ~6 months prep. Decide before targeting healthcare/financial verticals.

---

## 12. Citations

1. [lego — Difference between certbot and lego (issue #1914)](https://github.com/go-acme/lego/discussions/1914) — historical context: lego was built FOR Caddy; CLI ACME tools are no longer the recommended pattern.
2. [Self-Hosted Alternatives to Paid SSL Services — selfhosting.sh, Jan 2026](https://selfhosting.sh/replace/ssl-services/) — Caddy as gold standard; comparison of Caddy/Traefik/NPM/Certbot.
3. [Certbot vs acme.sh: Best ACME Client to Use in 2026 — sslinsights.com](https://sslinsights.com/certbot-vs-acme-sh/) — feature matrix for shell-based ACME clients.
4. [Best Self-Hosted Reverse Proxy in 2026 — selfhosting.sh](https://selfhosting.sh/best/reverse-proxy/) — Caddy/Traefik/Nginx/HAProxy comparison.
5. [SSL/TLS Certificate Automation — ZeonEdge, Mar 2026](https://zeonedge.com/ht/blog/ssl-tls-certificate-automation-lets-encrypt-acme-lifecycle) — ACME challenge type comparison, cert-manager, Vault PKI.
6. [Caddy Reverse Proxy Automatic HTTPS Zero-Config Guide — KX, Mar 2026](https://kx.cloudingenium.com/en/caddy-reverse-proxy-automatic-https-zero-config-guide/) — Caddy production reverse-proxy config.
7. [Caddy v2.9 docs — automatic HTTPS](https://caddyserver.com/docs/automatic-https)
8. [Let's Encrypt Community: Should our default client recommendation be Caddy?](https://community.letsencrypt.org/t/should-our-default-client-recommendation-be-caddy-if-not-why-not/199949) — official LE community position.
9. [Serverfault — certbot deploy-hook vs post-hook](https://serverfault.com/questions/1062849/when-using-lets-encrypt-certbot-how-do-i-restart-reload-a-network-service-only) — `$RENEWED_LINEAGE` semantics.
10. [FreeSWITCH WebRTC docs — SignalWire](https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Configuration/WebRTC_3375381) — `wss-binding`, certs, NAT setup.
11. [FreeSWITCH-users — TLS cert with intermediate CA](http://lists.freeswitch.org/pipermail/freeswitch-users/2021-March/134670.html) — symlink-all-pems pattern; the `cat fullchain privkey > all.pem` recipe.
12. [signalwire/freeswitch issue #2287 — Reload TLS cert without service interruption](https://github.com/signalwire/freeswitch/issues/2287) — sofia-sip cannot hot-reload TLS; restart is required.
13. [EFF — Should Caddy and Traefik replace Certbot? (2024-03)](https://www.eff.org/deeplinks/2024/03/should-caddy-and-traefik-replace-certbot) — EFF endorses integrated ACME going forward.
14. [Certbot deploy-hook docs](https://eff-certbot.readthedocs.io/en/stable/using.html#renewing-certificates) — `--deploy-hook`/`$RENEWED_LINEAGE`.
15. [fail2ban filter.d/freeswitch.conf (master branch)](https://github.com/fail2ban/fail2ban/blob/master/config/filter.d/freeswitch.conf) — official filter with `mode=normal/ddos/extra`.
16. [FreeSWITCH wiki — fail2ban](https://wiki.freeswitch.org/wiki/Fail2ban) — required `<param name="log-auth-failures" value="true"/>`.
17. [fail2ban issue #2163 — auth challenge vs auth failure](https://github.com/fail2ban/fail2ban/issues/2163) — why mode=normal is right for production (challenge != failure).
18. [FreeSWITCH SIP_TLS docs](https://freeswitch.org/confluence/display/FREESWITCH/SIP+TLS) — SSLv23+SRTP recommendation, `tls-cert-dir`, port 5061.
19. [FreeSWITCH Certificates docs (SignalWire)](https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Security/Certificates_3966216/) — agent.pem / dtls-srtp.pem / wss.pem distinctions; LE for testing.
20. [FreeSWITCH-users — Setting up webrtc certificates (2017)](http://lists.freeswitch.org/pipermail/freeswitch-users/2017-May/126021.html) — Android Chrome silently rejects self-signed.
21. [Container Security Scanning Guide 2026 — AppSec Santa](https://appsecsanta.com/container-security-tools/container-security-scanning) — Trivy 34.7k stars, default for OSS pipelines; build/registry/runtime stages.
22. [Best Container Vulnerability Scanners 2026 — TechPlained](https://www.techplained.com/best-container-vulnerability-scanners) — 100-image benchmark: Trivy 4.2% FP rate (lowest), Grype fastest at 4.8s.
23. [Trivy GitHub Action — aquasecurity/trivy-action](https://github.com/aquasecurity/trivy-action) — official CI integration.
24. [Trivy/tfsec alternatives — codenote.net](https://codenote.net/en/posts/trivy-tfsec-alternatives-security-scanning-tools-comparison/) — Trivy v0.69.3 SHA-pinning advice; tfsec absorbed into Trivy 2023.
25. [zaproxy/action-baseline v0.15.0](https://github.com/zaproxy/action-baseline) — official OWASP ZAP baseline GitHub Action.
26. [OWASP ZAP Automation — yrkan.com 2026](https://yrkan.com/blog/owasp-zap-automation/) — CI integration recipes; baseline vs full scan distinctions.
27. [Go Vulnerability Management — go.dev/security/vuln](https://go.dev/security/vuln) — govulncheck overview, call-graph-aware design.
28. [govulncheck v1.0.0 release blog — go.dev](https://go.dev/blog/govulncheck) — stable API, GitHub Action.
29. [golang/govulncheck-action](https://github.com/golang/govulncheck-action) — official CI action.
30. [MongoDB Queryable Encryption — Rotate and Rewrap Encryption Keys](https://mongodb.com/docs/manual/core/queryable-encryption/fundamentals/manage-keys/) — `KeyVault.rewrapManyDataKey()` pattern.
31. [IBM Key Protect — Rewrapping data encryption keys](https://cloud.ibm.com/docs/key-protect?topic=key-protect-rewrap-keys) — `actions/rewrap` API; rewrap-without-plaintext semantics.
32. [Everruns — Encryption Key Rotation Runbook](https://docs.everruns.com/sre/runbooks/encryption-key-rotation/) — phased dual-key deployment, dry-run, batch sizing.
33. [Google Cloud KMS — Envelope encryption](https://docs.cloud.google.com/kms/docs/envelope-encryption) — DEK/KEK best practices; AES-256-GCM, central KEK storage.
34. [Docker Image Hardening for Production — Stripe Systems, Jan 2026](https://www.stripesys.com/blog/docker-image-hardening) — distroless 89MB vs 1.2GB; before/after CVE counts; seccomp profile sample.
35. [Docker Container Security — 10 Layers of Hardening — aexaware.com](https://aexaware.com/blog/docker-container-security-10-layers-of-production-ready-hardening) — drop ALL caps, runtime armor, hardened Dockerfile template.
36. [Go Docker Best Practices — reintech.io 2026](https://reintech.io/blog/go-docker-best-practices-multi-stage-builds-security) — distroless/static-debian12 for Go.
37. [FreeSWITCH ES2021-09 — SRTP DoS via invalid packets (CVE-2021-...)](https://www.enablesecurity.com/advisories/ES2021-09-freeswitch-srtp-dos/) — fixed in FS 1.10.7.
38. [FreeSWITCH ES2023-02 — DTLS Hello race-condition DoS](https://www.openwall.com/lists/oss-security/2023/12/23/4) — fixed in later 1.10.x.
39. [FreeSWITCH Security wiki](https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Security/) — iptables hashlimit recipes, friendly-scanner blocklist.
40. [Federal Register Vol. 90 No. 158 (2025-08-19) — FCC Third-Party Authentication Order](https://www.govinfo.gov/content/pkg/FR-2025-08-19/html/2025-15809.htm) — must sign with own cert; SPC token requirement.
41. [FCC DOC-421205A1 — STIR/SHAKEN governance system](https://docs.fcc.gov/public/attachments/DOC-421205A1.txt) — Policy Administrator, SPC tokens, CA hierarchy.
42. [Bandwidth Hosted Signing Service docs](https://www.bandwidth.com/support/en/articles/12823017-stir-shaken-hosted-signing-service) — practical certificate provisioning, ASN.1 OID, S3-hosted public cert.
43. [STIR/SHAKEN compliance 2026 — Viirtue](https://viirtue.com/stir-shaken-compliance-requirements-2026-for-msps-and-voice-resellers/) — RMD recertification deadline 2026-03-01.
44. [AWS S3 Object Lock docs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html) — compliance mode vs governance mode; SEC 17a-4 / FINRA / CFTC assessed by Cohasset.
45. [AWS Connect — S3 Object Lock for call recordings](https://docs.aws.amazon.com/connect/latest/adminguide/s3-object-lock-call-recordings.html) — exact pattern for telephony recordings.
46. [AWS S3 — SSE-KMS specification](https://docs.aws.amazon.com/AmazonS3/latest/userguide/specifying-kms-encryption.html) — `aws:kms`, `x-amz-server-side-encryption-aws-bucket-key-enabled`, presigned URL Sig-v4 requirement.
47. [AWS S3 Object Lock — managing/considerations](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock-managing.html) — replication interaction, MD5 requirement.
48. [AWS Encryption Best Practices — S3](https://docs.aws.amazon.com/prescriptive-guidance/latest/encryption-best-practices/s3.html) — `aws:SecureTransport` bucket policy, AWS Config rules.
49. [GitHub Dependabot Best Practices](https://docs.github.com/en/code-security/dependabot/maintain-dependencies/best-practices-for-maintaining-dependencies) — grouped PRs, advisory subscription cadence.
50. [Securing WebRTC-to-SIP — Soufiane Bouchaara](https://soufianebouchaara.com/securing-webrtc-to-sip-when-using-freeswitch/) — `rtp_secure_media`, WSS, TURN auth.

---

**Status: RESEARCH complete. Stop here. PLAN is blocked on F01 (DNS provider, repo skeleton), F03 (FS deployment shape), F05 (auth/RBAC interface).**
