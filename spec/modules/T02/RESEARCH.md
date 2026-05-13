# T02 — Carrier Mgmt + Sofia Gateway Templating — RESEARCH

**Module:** T02
**Phase:** RESEARCH (PLAN/IMPL blocked on F02, F03, F05)
**Date:** 2026-05-06
**Status:** Research only — no code, no PLAN
**Owner:** backend-node (with FS configuration overlap)

---

## 1. Executive summary (10 bullets)

1. **Seven first-class `kind`s, one catchall.** Phase-1 carrier `kind` enum locks to `twilio | telnyx | signalwire | ringcentral | bandwidth | flowroute | byoc`. Anything not in the first six gets `byoc` (every Sofia knob exposed via `template_overrides JSON`). Per-`kind` Handlebars template renders `freeswitch/conf/sip_profiles/external/<gateway-name>.xml`. F02 already split `carriers` (logical record + creds) from `gateways` (Sofia gateway name + proxy + register/transport/priority); T02 owns the renderer, ESL rescan flow, status cache, and admin REST surface.
2. **Authentication is a 2×2 matrix per carrier:** {register=true|false} × {ip-auth|digest-auth|both}. Twilio Elastic Trunking and Bandwidth are **IP+digest, no register** (termination URI + credential list, peer-IP allowlist for inbound) [1][6][8][14][15]. RingCentral BYOC is **register=true via SBC**, RingEX uses certified AudioCodes/Ribbon SBCs [9][10]. Telnyx exposes **all five auth methods** — credentials, IP+token, IP+tech-prefix, IP+P-Charge-Info, FQDN [4][5][13]. SignalWire is **register=true** with username/password (or SIP-credential resource) against `<space>.sip.signalwire.com` [11][12][16]. Flowroute supports **digest register OR IP+8-digit tech-prefix** (`sip:12345678*+1206...@sip.flowroute.com`) — IP-based recommended [7][17][18]. We model "auth_mode" as a derived field on `gateways` from `(carriers.kind, register, username_ct present?)`.
3. **Termination URI is per-tenant and regional for Twilio.** Each Twilio trunk has a unique FQDN like `<example>.pstn.twilio.com`, with localized ingress URIs `<example>.pstn.<edge>.twilio.com` (`ashburn`, `dublin`, `frankfurt`, `singapore`, `tokyo`, `sydney`, `sao-paulo`, `umatilla` — Oregon — etc.) [1][2][3]. Our `gateways.proxy` stores the customer-chosen FQDN; the renderer never hard-codes Twilio IPs (those are firewall/ACL data only — Twilio explicitly says "do not send traffic to these IPs"; use the FQDN [1]). For inbound, Twilio publishes `54.172.60.0/30` (Virginia), `54.244.51.0/30` (Oregon), Frankfurt/Dublin/Tokyo/Singapore/Sydney/São Paulo CIDR blocks — all of these go in `acl.conf.xml` ACL named `carriers` [1][2].
4. **Sofia rescan is graceful; restart drops calls.** `sofia profile external rescan` adds new gateways and reloads modified ones **without dropping live calls**; new gateways take ~3s to come up and OPTIONS-ping the peer [19][20][21][22]. To remove a gateway use `sofia profile external killgw <name>` (also non-disruptive); to update parameters of an existing gateway, **killgw + rescan** is the safest sequence (rescan alone is ignored by an already-loaded gateway with the same name) [19][22]. `sofia profile external restart` is "more intrusive — all profile calls dropped" per the FreeSWITCH reload table [19] — never our default. `reloadxml` only re-parses XML; mod_sofia must be told separately to re-act.
5. **Live status from `sofia status gateway`.** A single `api sofia status gateway` returns one tab-separated row per gateway with columns `Profile::Gateway-Name | Data | State | Ping Time | IB Calls(F/T) | OB Calls(F/T)`. State values relevant to us: `REGED` (registered), `NOREG` (no registration attempted — IP-auth gateways), `UNREG` (registration failed/in-progress), `FAILED`, `FAIL_WAIT`, `EXPIRED` [23][27]. For IP-auth gateways `NOREG` is the **healthy** steady state; we additionally read `Status` field (`UP (ping)` / `DOWN`) from `sofia status gateway <name>` (verbose form) which reflects OPTIONS keepalive results [23][24]. Polling every 30s into Redis cache (key `t:{tid}:carrier:status:{gateway_id}`, 90s TTL) is sufficient; UI reads the cache.
6. **OPTIONS keepalive via `ping=N`.** Each gateway can declare `<param name="ping" value="25"/>` (seconds between OPTIONS pings) and `<param name="ping-max" value="3"/>` (consecutive failures before marking down). Sofia maintains a `PingState X/Y/Z` counter and flips `Status` between `UP (ping)` and `DOWN` accordingly [23][24]. There is a known TLS-gateway bug where ping state can lock up (#2489) — we monitor for stuck `pinging=1` and reissue `sofia profile external killgw + rescan` as a watchdog [25]. Carriers that cap free OPTIONS rate: Telnyx OK, Twilio OK at 25-60s; Bandwidth requires hostname/IP for OPTIONS not the realm SRV [14].
7. **OPTIONS-ping smoke test on create.** `POST /api/admin/carriers/:id/test` runs: (a) render gateway XML to a temp file, (b) ESL `api sofia profile external killgw <name>` (no-op if absent), (c) ESL `api sofia profile external rescan`, (d) wait 3s, (e) parse `sofia status gateway <name>` for `State` + `Ping Time`. Returns `{ state, ping_ms, status, raw }`. For credential trunks (`register=true`) we additionally accept `REGED` within 8s as success. `sofia profile external siptrace on` can be temporarily flipped per-test to capture the OPTIONS exchange for debugging — but produces large logs; off by default [24].
8. **Caller-ID handling is a four-knob policy.** (i) `caller-id-in-from=true` on the gateway makes mod_sofia put `effective_caller_id_number` in the SIP `From` header — required by Twilio, Telnyx, Bandwidth, SignalWire, Flowroute, RingCentral [1][6][9][13][14]. (ii) `sip_cid_type=pid` (set as channel var on the originate) emits `P-Asserted-Identity` instead of/in addition to From; only one PAI header should be sent — duplicate-PAI-header bug [29] is fixed by setting `sip_cid_type=none` then `sip_h_P-Asserted-Identity=<sip:...>` manually for full control [29][30][31]. (iii) `origination_privacy=hide_name+hide_number` for anonymous calls (RFC 3325 Privacy header) [29]. (iv) `origination_caller_id_number` overrides for per-campaign/per-DID CID. Default Phase-1 policy: PAI **only** when `carriers.send_pai=true`; otherwise From-only. Phase-2 work covers RFC 7044 (History-Info) and RFC 8224 (STIR/SHAKEN Identity header) for outbound caller-ID validation tokens.
9. **Failover: Phase 1 = bridge dial-string fallback; Phase 2 = mod_distributor; Phase 3.5 = Kamailio dispatcher.** For Phase 1 each `gateways` row has a `priority SMALLINT`; T04's originate string assembles `sofia/gateway/<gw-priority-1>/<num>|sofia/gateway/<gw-priority-2>/<num>` (comma-list = simultaneous; pipe-list = sequential failover) per the FreeSWITCH community pattern [33][34][35][36]. Phase 2 swaps to mod_distributor for weighted round-robin (`sofia profile gwlist up | distributor` integration, dead-gateway exclusion via `${distributor(name+up_gws)}`) [37]. Phase 3.5 X02 module promotes Kamailio dispatcher (algorithm 8 priority + algorithm 9 weight, OPTIONS probing every 10s, automatic exclusion via `ds_probing_mode=1`, `ds_probing_threshold`, failure_route + `ds_next_dst`) [38][39][40][41]. T02 keeps `priority`, `weight`, `active` on `gateways` so all three phases consume the same data.
10. **Credential rotation is an envelope-encrypted, audited, atomic flow.** F05 (RESEARCH §4) defines the AES-GCM-256 + per-row DEK envelope wrapped by env/Vault KEK; F02 puts ciphertext in `carriers.username_ct/password_ct VARBINARY(512)` plus `kek_version SMALLINT`. T02 rotation: (1) decrypt old creds (audit `carrier.cred_read`), (2) accept new creds, (3) re-encrypt under current KEK, (4) write `(username_ct, password_ct, kek_version, updated_at)` in single TX with `audit_events` row, (5) re-render XML, (6) `killgw + rescan`, (7) confirm status flip back to `REGED`/`UP (ping)`, (8) on failure restore from in-memory backup. Cleartext password lives **only** on disk inside the rendered XML (Phase-1 compromise per F05 §4.6 Path A — file-mode 0640 freeswitch:freeswitch). Phase-2 mod_xml_curl directory binding is the hardening path.

---

## 2. Carrier matrix (per-provider auth + Sofia config)

| Carrier | `kind` | Register? | Outbound auth | Inbound auth | Proxy / realm | Notes / quirks |
|---|---|---|---|---|---|---|
| **Twilio Elastic SIP** | `twilio` | **No** | digest (cred-list) + IP-allowed | IP-ACL (Twilio edge IPs per region) | `<example>.pstn.<edge>.twilio.com` (e.g. `acme.pstn.dfw.twilio.com`) | E.164 with `+`, port 5060/5061; secure trunking = TLS/SRTP `AES_CM_128_HMAC_SHA1_80`; do **not** dial Twilio IPs directly — always FQDN [1][3][8] |
| **Telnyx** (creds) | `telnyx` | **Yes** | digest user/pass | IP-ACL or FQDN+creds | `sip.telnyx.com` | Anchorsite controls media PoP; supports IP+token, IP+tech-prefix, IP+P-Charge-Info, FQDN auth modes [4][5] |
| **Telnyx** (IP) | `telnyx` | **No** | IP allowlist + tech-prefix prepend | IP-ACL | `sip.telnyx.com` | `username/password=not-used` placeholder per Telnyx FreeSWITCH doc [13]; outbound profile + connection link |
| **SignalWire** | `signalwire` | **Yes** | digest (project_id user / API token pass) **or** SIP-endpoint user/pass | IP allowlist or domain-app | `<space>.sip.signalwire.com` | Phase 4 cheaper SIP-to-SIP @ $0.003/min [DESIGN §17.1]; FreeSWITCH-native (made by FS originators); register-transport=tls preferred [11][12][16] |
| **RingCentral BYOC** | `ringcentral` | **Yes** | digest via SBC (AudioCodes/Ribbon certified) | SBC-mediated | `sip.ringcentral.com` | Per-DID register; only certified SBCs are supported officially — for our use-case, FS plays the SBC role with `register=true` + per-DID gateway [9][10][32]. JWT/OAuth applies to *RingEX APIs*, **not** SIP signaling. |
| **Bandwidth** | `bandwidth` | **No** (registration not supported) | IP allowlist (mated SBC pair, signaling redundancy) | IP-ACL on **both** mated SBCs | `<acct-hex>.auth.bandwidth.com` (realm) | Optional digest "SIP Authentication / network bridge" via realm + creds [6][14]; UDP only, max packet 1350 B; supports From / RPID / PAI / Privacy headers [14][15]. 911 traffic uses a **separate** SIP peer with `X-Account-Id` header or trunk-ID URI prefix [15]. |
| **Flowroute** | `flowroute` | **No** (preferred) | IP-allowlist + 8-digit tech-prefix prepended (`sip:12345678*+1206...@sip.flowroute.com`) | IP-ACL | `us-west-or.sip.flowroute.com`, `us-east-va.sip.flowroute.com`, `eu-central-fra...`, `eu-west-ldn...`, `ap-east-hk...`, `ap-southeast-sin...`, `sa-east-sp...` | NAPTR/SRV preferred when supported; can also do digest register [7][17][18] |
| **Generic BYOC** | `byoc` | configurable | configurable (digest, IP, none) | configurable | operator-supplied | Catchall — every Sofia gateway param overridable via `template_overrides JSON` |

**E911:** universal pattern is a **separate carrier row** (e.g. `kind=byoc`, `name=bandwidth-e911`) pointing at the carrier's 911-specific SBC pool, with its own caller-ID/routing rules. Bandwidth requires `X-Account-Id` header [15]; Twilio uses `Emergency Calling` configured per Trunk; Telnyx uses dedicated emergency numbers + address-on-file. T02 surface treats E911 as just-another-carrier; M04 admin UI tags them so the dialplan (T03/I02) can route `911`/`933` to the e911 carrier.

---

## 3. Gateway template strategy (one .xml.tmpl per carrier kind)

### 3.1 Template inventory (all live under `api/src/services/templates/`)

```
carrier-twilio.xml.hbs         — IP-auth, no register, optional cred-list
carrier-telnyx-cred.xml.hbs    — register=true, sip.telnyx.com
carrier-telnyx-ip.xml.hbs      — register=false, IP+tech-prefix, sip.telnyx.com
carrier-signalwire.xml.hbs     — register=true, <space>.sip.signalwire.com, TLS
carrier-ringcentral.xml.hbs    — register=true, per-DID, TLS
carrier-bandwidth.xml.hbs      — register=false, dual-SBC IP, optional digest realm
carrier-flowroute.xml.hbs      — register=false, IP+tech-prefix, regional NAPTR
carrier-byoc.xml.hbs           — catchall; every param interpolated
```

F03 PLAN already ships the **`.tmpl` versions** (env-substituted at FS bootstrap so the operator can have a working trunk without T02). T02's Handlebars `.hbs` replaces those at runtime — same XML shape but with carrier-row interpolation, escaping, and conditional sections.

### 3.2 Common shape (Twilio example, distilled from F03 PLAN §3.1 + Twilio docs [1][8])

```xml
<include>
  <gateway name="{{name}}">
    {{#if username}}<param name="username" value="{{username}}"/>{{/if}}
    {{#if password}}<param name="password" value="{{password}}"/>{{/if}}
    {{#if realm}}<param name="realm" value="{{realm}}"/>{{/if}}
    <param name="proxy" value="{{proxy}}"/>
    <param name="register" value="{{register}}"/>
    <param name="register-transport" value="{{transport}}"/>
    <param name="caller-id-in-from" value="true"/>
    <param name="codec-prefs" value="{{codecs}}"/>
    <param name="dtmf-type" value="rfc2833"/>
    <param name="ping" value="{{ping_seconds}}"/>
    <param name="ping-max" value="{{ping_max}}"/>
    <param name="retry-seconds" value="{{retry_seconds}}"/>
    <param name="expire-seconds" value="{{expire_seconds}}"/>
    {{#if from_user}}<param name="from-user" value="{{from_user}}"/>{{/if}}
    {{#if from_domain}}<param name="from-domain" value="{{from_domain}}"/>{{/if}}
    {{#if extension}}<param name="extension" value="{{extension}}"/>{{/if}}
    <param name="context" value="public"/>
    {{#each extra_params}}
      <param name="{{name}}" value="{{value}}"/>
    {{/each}}
  </gateway>
</include>
```

### 3.3 Knobs we expose vs. hardcode

| Knob | Source | Phase-1 |
|---|---|---|
| `username`, `password`, `proxy`, `realm`, `from-user`, `from-domain`, `register`, `register-transport`, `expire-seconds`, `retry-seconds`, `extension` | DB columns (`carriers.*`, `gateways.*`) | exposed |
| `caller-id-in-from`, `dtmf-type`, `context` | hard-coded per template | hardcoded (see §6 if override needed via `template_overrides`) |
| `codec-prefs` | per-`kind` default; overridable via `template_overrides` | exposed |
| `ping`, `ping-max` | `gateways.template_overrides.ping_seconds` (default 25 / 3) | exposed |
| `contact-params`, `outbound-proxy`, `register-proxy` | `template_overrides` JSON | overridable |
| `rtp-secure-media`, `srtp-crypto-suites` | per-kind preset (Twilio Secure Trunking yes; others off) | preset, overridable |

### 3.4 XML escaping + injection defense

Handlebars `{{ }}` HTML-escapes by default — covers `<`, `>`, `&`, `"`. We **additionally** validate every interpolation through a Zod schema:
- `name`: `^[a-z][a-z0-9-]{0,62}$`
- `proxy`: `^[a-zA-Z0-9.\-]{1,255}$`
- `username`, `password`: deny `<`, `>`, `&`, newline (any of these → 400 with `CARRIER_INVALID_FIELD`)
- `from_user`, `realm`: same as username
- numeric fields: integer ranges (e.g., `expire_seconds in [60..86400]`)

Test fixture: `name="<gateway"/><param name="evil" value="x"/>"` round-trips to escaped `&lt;gateway&quot;...` — XML still parses identically and FS rejects the gateway name as invalid.

### 3.5 Atomic file writes

Renderer writes to `<name>.xml.tmp` (same directory, FS sees only `*.xml`), `fsync()`, then `rename()` to `<name>.xml`. POSIX rename is atomic on the same filesystem — FS will never `<X-PRE-PROCESS include>` a half-written file. On rescan failure (parsed below), restore from `<name>.xml.bak` (kept for one rotation).

---

## 4. API surface for admin (M04 carriers admin)

All routes under `/api/admin/carriers`, RBAC `admin+` (super_admin can target `tenant_id=NULL` global carriers).

| Method | Path | Body / Query | Returns | Notes |
|---|---|---|---|---|
| `GET` | `/carriers` | `?active=true&kind=twilio` | `[{ id, name, kind, proxy, register, active, gateway_count, live_state }]` | Live state from Redis cache |
| `POST` | `/carriers` | full carrier object | `{ id, ... }` | Triggers render + rescan; rolls back on failure |
| `GET` | `/carriers/:id` | — | full carrier (passwords masked `***`) | |
| `PATCH` | `/carriers/:id` | partial | `{ id, ... }` | Optimistic concurrency via `version` column; re-render + rescan on changed fields; if only `active`/`weight` changes, `sofia profile external killgw + rescan` |
| `DELETE` | `/carriers/:id` | — | `{ id, deleted_at }` | Soft delete; refuse with 409 `CARRIER_IN_USE` if any campaign or DID references it; remove XML + rescan |
| `POST` | `/carriers/:id/test` | `{ to: "+14155551212"? }` | `{ ok, state, ping_ms, raw, options_response_code? }` | OPTIONS smoke test (see §5) |
| `GET` | `/carriers/:id/status` | — | `{ state, status, ping_ms, ib_active, ob_active, last_polled_at }` | Reads Redis cache |
| `POST` | `/carriers/:id/rotate-creds` | `{ username?, password? }` | `{ id, kek_version }` | Discrete rotation endpoint (audit_log entry tagged `auth.carrier.rotate_creds`); same XML+rescan flow |
| `POST` | `/carriers/:id/health/refresh` | — | `{ state, ... }` | Forces immediate `sofia status gateway <name>` poll (skips cache) |
| `GET` | `/gateways` | `?carrier_id=` | per-gateway list | gateways are 1:N under a carrier |
| `POST` | `/carriers/:id/gateways` | full gateway object | `{ id, ... }` | Renders one XML per gateway under same carrier |
| `PATCH` | `/gateways/:gid` | partial | `{ id, ... }` | |
| `DELETE` | `/gateways/:gid` | — | `{ id }` | |

OpenAPI lives in `shared/openapi/openapi.yaml` (T02 PR adds the `Carrier`, `Gateway`, `CarrierStatus` schemas).

---

## 5. Health-check design

### 5.1 Two information sources

1. **`sofia status gateway`** (one-line per gateway, suitable for batch poll every 30s).
2. **`sofia status gateway <name>`** (verbose per-gateway report — used on test endpoint and on alarm).

### 5.2 Parser rules (TypeScript service `carrier-status.ts`)

`api sofia status gateway` returns lines like:
```
external::twilio   sip:user@acme.pstn.twilio.com   NOREG  0.00  0/0  0/2
external::rc-prod  sip:9876@sip.ringcentral.com   REGED  18.40 0/3  1/41
external::flowroute sip:5067xxxx@sip.flowroute.com NOREG 25.10 0/0  0/0
```

Parse columns by tab/whitespace, key on `Profile::Gateway-Name` after `external::`. State semantics:
- `NOREG` for `register=false` rows → look at verbose output's `Status` (`UP (ping)` vs `DOWN`) → derive **healthy iff** `Status=UP`.
- `REGED` for `register=true` → healthy.
- `UNREG`, `FAILED`, `FAIL_WAIT`, `EXPIRED`, `NOAVAIL` → unhealthy.
- Cache shape in Redis: `t:{tid}:carrier:status:{gateway_id}` → `{ state, status, ping_ms, ib_calls, ob_calls, polled_at, healthy }`, TTL 90s.

### 5.3 Polling loop (background job)

- Runs in Node API server (single instance with Redis lock to avoid double-poll in HA).
- Every **30s** issues `api sofia status gateway` once per FS instance via ESL.
- For each gateway with `active=true`, parse the row, write Redis, emit Prometheus `vici2_carrier_health{name,state}` gauge.
- On state change (was healthy → now down or vice versa), publish to `vici2.carrier.state_changed` event stream + write `audit_events` row.
- On 3 consecutive `DOWN` polls → alert (slack/PagerDuty webhook configurable in Phase 2; Phase 1 just stores + logs).

### 5.4 Test endpoint (`POST /carriers/:id/test`)

Sequence:
1. Validate carrier exists + admin perms.
2. ESL `api sofia profile external rescan` (idempotent).
3. Sleep 3000ms.
4. ESL `api sofia status gateway <name>` (verbose).
5. Parse `State`, `Ping Time`, `Status`, `Failed-Calls-In/Out`.
6. If `register=true` and `State != REGED` after 8s, return `{ ok:false, reason:"REGISTRATION_FAILED" }`.
7. If `register=false` and `Status != UP (ping)` after 5s, return `{ ok:false, reason:"NO_OPTIONS_REPLY" }`.
8. Otherwise `{ ok:true, state, ping_ms, status }`.

Optional `to` parameter: if supplied, additionally `bgapi originate {origination_uuid=<u>,hangup_after_bridge=true,leg_timeout=10}sofia/gateway/<name>/<to> &echo()`; reports the bridge/hangup cause without billing a long call. Disabled by default (operator opts in per request).

### 5.5 OPTIONS keepalive caveats

- TLS gateway pinging-stuck bug `signalwire/freeswitch#2489` [25] — watchdog: if `PingState x/y/z` and `Status=UP (ping)` but `last-ping-ts` (computed from current time minus `PingFreq`) > 3 × `PingFreq`, run `killgw + rescan`. Track in metric `vici2_carrier_ping_stuck_total`.
- Don't OPTIONS-ping aggressively (some peers will rate-limit). Default 25s for normal trunks, 10s for "VIP" gateways the admin marks priority=1.
- For `register=true` gateways, `unregister-on-options-fail=true` is **off** by default in our profile (per F03 PLAN §2.3) to prevent flap during transient OPTIONS loss.

---

## 6. Failover / load-balance approach (phased)

### Phase 1 — bridge dial-string fallback

T04 builds the originate destination by joining gateways for the carrier ordered by `(active=true, priority ASC, weight DESC)`:
```
sofia/gateway/<gw1>/+1NPANXXXXXX|sofia/gateway/<gw2>/+1NPANXXXXXX
```
- `|` = sequential (try gw1, on failure try gw2). [33][35]
- Comma `,` = simultaneous (all rings; first answer wins). Use only with `[leg_delay_start=Ns]` per-leg variable [33][34].
- T04 pre-filters by `gateways.healthy` (Redis cache) so down gateways aren't even tried. Prevents the "ring twice then continue" UX issue [35].

### Phase 2 — mod_distributor (weighted RR)

```xml
<list name="carrier-twilio" total-weight="10">
  <node name="twilio-us-east" weight="7"/>
  <node name="twilio-us-west" weight="3"/>
</list>
```
- Dialplan: `${distributor(carrier-twilio ${sofia profile gwlist up})}` returns the first up gateway from the weighted set [37].
- Reload via `distributor_ctl reload` after our renderer writes `distributor.conf.xml`.

### Phase 3.5 — Kamailio dispatcher (X02)

- Renderer also writes `dispatcher.list` lines `<setid> <sip-uri> <flags> <priority> <attrs>`.
- `modparam("dispatcher", "ds_ping_method", "OPTIONS")`, `ds_ping_interval=10`, `ds_probing_mode=1`, `ds_probing_threshold=3` [38][39].
- `ds_select_dst("$setid", "8", flags=2)` for priority+failover; `ds_next_dst()` in failure_route [40][41].
- `ds_probing_mode=3` for "ping inactive too" so a recovered gateway re-enters rotation automatically [38].

T02 keeps `priority`, `weight`, `health_check_url`, `active` columns ready from day one; X02 just consumes them.

---

## 7. Sofia rescan procedure (when to call rescan vs reload vs restart)

| Change | Command | Drops calls? | Notes |
|---|---|---|---|
| Add new gateway | `sofia profile external rescan` | No | Picks up new `<X-PRE-PROCESS include>` files [19] |
| Remove gateway | `sofia profile external killgw <name>` | No | Then delete the file [19] |
| Modify existing gateway params | `killgw <name>` then `rescan` | No | `rescan` alone is ignored if same-named gateway already loaded [19][22] |
| Toggle `active=false` | `killgw <name>` (file kept) | No | Restore by `rescan` |
| Change profile-level params (rare) | `sofia profile external restart` | **Yes** | Avoid; only on major upgrades |
| ACL change (carriers IP allowlist) | `reloadacl` | No | Must follow file edit; we generate `acl.conf.xml` when carriers' `ip_allowlist` changes [19] |
| WSS TLS cert change | `sofia profile external restart` | Yes | Out of T02 scope (handled by F03) [F03 PLAN §1.5] |

T02 always uses **killgw + rescan** for safety — even on first-time create (killgw is no-op if absent, returns `+OK Disconnected 0 channel(s)`). Wraps both in the renderer service:

```
async function applyGatewayChange(name) {
  await esl.api(`sofia profile external killgw ${name}`);
  await esl.api(`sofia profile external rescan`);
  await sleep(3000);
  return await esl.api(`sofia status gateway ${name}`);
}
```

If rescan returns a line containing `+ERR` or the post-rescan status query reports `FAIL_WAIT`/`EXPIRED` within 10s, restore the previous XML from `.bak` and re-run `killgw + rescan`, then throw `CARRIER_RELOAD_FAILED`.

---

## 8. Credential rotation flow (encrypt → DB → render → rescan → audit)

1. **Authn:** request must carry an admin/super_admin JWT; idempotency key in header to prevent double-rotation.
2. **Generate or accept new credentials:** `POST /carriers/:id/rotate-creds { username?, password? }`. If body fields omitted, generate strong random (24-char alphanum) — handy for register=true trunks where password is internal.
3. **Encrypt:** call `EnvelopeEncrypt(plaintext, aad=sha256(carriers:password_ct:<id>:<tenant_id>))` (per F05 §4.3). Returns `{ ciphertext, iv, tag, dek_wrap, kek_version }`.
4. **DB transaction:**
   ```
   BEGIN;
     UPDATE carriers
       SET username_ct=?, password_ct=?, kek_version=?, updated_at=NOW(6),
           version=version+1
       WHERE id=? AND version=?;
     INSERT INTO audit_events (...action='auth.carrier.rotate_creds', actor_user_id=?, ...);
   COMMIT;
   ```
5. **Render new XML** to `.tmp`, atomic rename. Keep previous as `.bak`.
6. **`killgw + rescan + sleep 3s + verify`.**
7. **On register=true success →** `REGED` in `sofia status gateway <name>`. **On register=false success →** `Status=UP (ping)` and 200-OK to outbound OPTIONS within 8s.
8. **On failure:** restore `.bak` → `killgw + rescan`, restore previous DB row inside a separate compensating TX (re-read pre-change row from row history or, since we incremented `version`, we keep the prior creds in memory until step 7 succeeds). Log `auth.carrier.rotate_creds_failed` audit event.
9. **Old credentials:** remain valid at the carrier until customer revokes them — for register-based trunks, rotation revokes inflight registrations as soon as new register cycle completes. T02 surfaces a "test old creds invalidated by carrier" status in the UI (manual confirmation by admin).
10. **Never** log plaintext creds (CI grep for `password_ct`, `username_ct`, `Bearer ey` per F05 §8.3).

---

## 9. Per-carrier concurrent-call accounting

### 9.1 Sources of truth

- **FreeSWITCH:** `sofia status gateway <name>` exposes `IB Calls(F/T)` and `OB Calls(F/T)` — failed/total **lifetime** counters for that profile invocation. Not great for live concurrency [23][27].
- **mod_limit:** can enforce `limit_execute` per gateway with `limit_db` backing; fastest live-concurrency check inside dialplan [36].
- **Our own:** `call_log` row with `gateway_id`, `call_started`, `call_ended` — Redis counter `t:{tid}:gw:{id}:active` incremented on `CHANNEL_BRIDGE` event, decremented on `CHANNEL_HANGUP_COMPLETE`.

### 9.2 Phase-1 strategy

- Add `carriers.max_concurrent INT NULL` and `gateways.max_concurrent INT NULL`.
- Maintain Redis counter `t:{tid}:gw:{id}:active` (increment on originate from T04, decrement on hangup via T01 ESL consumer).
- At originate time, T04 reads `active` and rejects (or shifts to fallback gateway) if `active >= max_concurrent`.
- Background reconciler (every 60s): `sofia status gateway` parsed `OB Calls (in-progress = total - failed - completed)` cross-checks Redis; on drift > 2, log warning + correct counter.
- Surface in `GET /carriers/:id/status` as `{ ob_active, max_concurrent, utilization_pct }`.

### 9.3 Carrier-imposed limits to track

- Twilio Elastic Trunking: CPS per-trunk (free tier 1 CPS, paid up to 100+) — separate from concurrent calls [Twilio pricing/CPS in DESIGN §17.1].
- Telnyx: 10 concurrent channels first tier free, scales w/ price [DESIGN §17.1].
- SignalWire: 1 CPS free, $15/mo per +2-20 CPS.
- Bandwidth: contracted; record in `notes JSON`.

Phase-2 module E02 (pacing) will read these to bound dial level; T02 just exposes the field.

---

## 10. Open questions for PLAN

1. **One carrier row, N gateways, or one row each?** F02 PLAN already split (`carriers` 4.20 + `gateways` 4.21). Confirmed correct — keep. T02 admin UI presents "Carriers" with expandable gateways tab.
2. **Phase-1 send PAI?** Do we ship `sip_cid_type=pid` enabled by default for carriers that publish PAI requirements (Bandwidth, Telnyx)? Recommendation: **off by default** (From-only); add `carriers.send_pai BOOLEAN DEFAULT FALSE`; M04 admin checkbox per carrier.
3. **STIR/SHAKEN signing in Phase 1?** Per DESIGN.md §18.1 we rely on the carrier (Twilio, Telnyx, SignalWire) to sign — they all do A-attestation for owned numbers [42][43][44]. We do **not** generate Identity headers in Phase 1. Phase 2 may add Tiltx-style external signing for non-carrier-owned DIDs [28]. Flag for orchestrator: Phase-2 module STIR/SHAKEN-self-sign needed?
4. **E911 model:** separate `kind=byoc` + dialplan-level routing, or first-class `is_emergency_carrier BOOLEAN` flag with a built-in routing rule? Recommendation: flag + dialplan rule (avoids forcing operators to remember the trick).
5. **Branded calling:** Twilio Branded Calling, Hiya Connect, First Orion are **per-DID** registrations, not per-carrier. Out of T02 scope, belongs in X05 (local-presence + branded). Just expose `carriers.notes JSON` for operator memos.
6. **Multi-FS:** when X03 lands, `gateways` rows need `fs_node_affinity VARCHAR(64) NULL`. Phase 1 single-FS; defer column.
7. **SNI / TLS verify on outbound register:** `sofia profile external` already has `tls-verify-policy` (F03 PLAN §2.3). Per-gateway override needed for SignalWire (different cert chain)? Likely yes — add to `template_overrides`.
8. **Inbound DID assignment ownership:** F02 has `did_numbers.carrier_id`. T02 surfaces which DIDs land on which gateway for dashboard, but **DID CRUD lives in I02 / M04**, not T02. Confirmed boundary.
9. **Cost-per-minute tracking:** Phase 2. Add `gateways.cost_per_min_cents NULL` now (column exists, not used) for forward-compat.
10. **Super-admin global carriers (`tenant_id=NULL`):** F02 schema has `tenant_id NOT NULL DEFAULT 1`. To support cross-tenant shared carriers (e.g., a SaaS operator providing default Telnyx for all tenants), need to relax NOT NULL. Recommendation: keep NOT NULL in Phase 1; multi-tenant carriers wait for Phase 4; in the meantime each tenant has its own carrier row pointing at the same FQDN/credentials.

---

## 11. Citations

1. **Twilio — IP Addresses for Elastic SIP Trunking** — https://www.twilio.com/docs/sip-trunking/ip-addresses — regional gateway IP CIDRs, FQDN-only termination guidance, 5060/5061 ports.
2. **Twilio — Regional SIP Trunks** — https://www.twilio.com/docs/global-infrastructure/regional-sip-trunks — termination URI per region, edge parameter, localized URIs.
3. **Twilio — Edge Locations Available for Elastic SIP Trunking** — https://twilio.com/en-us/changelog/twilio-edge-locations-available-for-elastic-sip-trunking — `<example>.pstn.<edge>.twilio.com`, edge param.
4. **Telnyx — SIP Authentication Methods** — https://developers.telnyx.com/docs/voice/sip-trunking/authentication/credential-types/index — credentials, IP+token, IP+tech-prefix, IP+P-Charge-Info, FQDN+creds, FQDN+IP table.
5. **Telnyx — SIP Trunking Overview** — https://developers.telnyx.com/docs/v2/sip-trunking/quickstarts/portal-setup — connections, anchorsite, outbound voice profiles.
6. **Bandwidth — UC Trunking Integration Guide** — https://www.bandwidth.com/support/en/articles/12822954-uc-trunking-integration-guide — mated SBC pair, no register, UDP only, 1350-byte cap, RPID/PAI/Privacy support.
7. **Flowroute — Service Guide / Technical Specifications** — https://support.bcmone.com/flowroute-support/docs/flowroute-service-guide-technical-specifications — SIP digest auth, IP-based auth + tech-prefix recommended, E.164 with optional `+`.
8. **Twilio — Elastic SIP Trunking Configuration Guide (FreeSWITCH)** — https://www.twilio.com/docs/sip-trunking/sample-configuration#freeswitch — FreeSWITCH Secure Trunking PDF, SRTP `AES_CM_128_HMAC_SHA1_80`.
9. **RingCentral — BYOC Service Description** — https://www.ringcentral.com/legal/BYOC-service-description.html — gateway-purchase model, customer-owned SBC, country availability constraints.
10. **RingCentral — BYOC product page** — https://www.ringcentral.com/BYOC.html — certified SBCs (AudioCodes, Ribbon).
11. **SignalWire — Set up a SIP Endpoint** — https://developer.signalwire.com/voice/sip/get-started/ — username/password endpoint, Domain Apps for BYOC SIP.
12. **SignalWire — SIP trunking** — https://signalwire.com/docs/platform/voice/sip/trunking — endpoint creation, encryption, port 5060/5061.
13. **Telnyx — FreeSWITCH IP Trunk Setup** — https://support.telnyx.com/en/articles/1616935-freeswitch-ip-trunk-setup — `username/password=not-used`, register=false, sip.telnyx.com proxy.
14. **Bandwidth — SIP Authentication / Network Bridge** — https://www.bandwidth.com/support/en/articles/12823069-sip-authentication-network-bridge-setup-and-configuration — realm + digest, OPTIONS using IP/hostname not realm SRV.
15. **Bandwidth — SIP peers for 911 service** — https://www.bandwidth.com/support/en/articles/12823289-sip-peers-for-911-service — `X-Account-Id` header, trunk-ID prefix in URI, port 5060.
16. **SignalWire — Provider page (FreeSWITCH Explained)** — https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Interoperability/Providers-ITSPs/20709712/ — gateway XML for register=false/true, `<space>.signalwire.com`.
17. **Flowroute — Inbound and Outbound Calling with Current PoPs** — https://developer.flowroute.com/docs/inbound-and-outbound-calling-with-flowroute-new-pops/ — NAPTR/SRV per region, US/EU/AP/LATAM PoPs.
18. **Flowroute — How do I integrate** — https://flowroute.com/blog/faq/how-do-i-integrate-with-flowroute/ — registration vs IP auth.
19. **FreeSWITCH — Reloading** — https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Configuration/Reloading_13173616/ — official reload table, rescan vs killgw vs restart, "no calls dropped" for rescan/killgw.
20. **FreeSWITCH-users — Reload Configurations (Lloyd)** — http://lists.freeswitch.org/pipermail/freeswitch-users/2010-April/055887.html — `sofia profile xxx rescan` for adding trunks while calls active.
21. **FreeSWITCH-users — outgoing gateway** — http://lists.freeswitch.org/pipermail/freeswitch-users/2010-May/057808.html — `sofia profile <name> rescan reloadxml` vs restart.
22. **FreeSWITCH-users — reloadxml not reloading gateway configuration** — http://lists.freeswitch.org/pipermail/freeswitch-users/2010-April/057134.html — killgw before rescan if gateway already loaded.
23. **FreeSWITCH-users — Gateway State (sofia status gateway columns)** — http://lists.freeswitch.org/pipermail/freeswitch-users/2015-October/116492.html — Profile::Gateway-Name | Data | State | Ping Time | IB Calls(F/T) | OB Calls(F/T); REGED, NOREG.
24. **FreeSWITCH-users — Gateway PingState** — https://lists.freeswitch.org/pipermail/freeswitch-users/2022-December/136103.html — PingState x/y/z, OPTIONS sniff via `sofia global siptrace on`.
25. **mod_sofia TLS gateway pinging stuck (Issue #2489)** — https://github.com/signalwire/freeswitch/issues/2489 — TLS gateway ping never expires bug; killgw+rescan workaround.
26. **mod_sofia params reference** — https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Modules/mod_sofia_1048707 — full param list including `ping`, `unregister-on-options-fail`, `tls-verify-*`.
27. **FreeSWITCH — Monitoring (Nagios plugin)** — https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Auxiliary-Knowledge-and-Utilities/Monitoring_13173431 — sofia-status-internal/external, FAILED-CALLS-IN/OUT counters.
28. **Sangoma KB — Adding STIR/SHAKEN Identity Header (Tiltx)** — https://sangomakb.atlassian.net/wiki/spaces/FCD/pages/9764936 — third-party signing API, attestation level returned per call.
29. **FreeSWITCH-users — Trouble with P-Asserted-Identity headers** — https://lists.freeswitch.org/pipermail/freeswitch-users/2010-March/055080.html — `sip_cid_type=none` to suppress auto-PAI, manual `sip_h_P-Asserted-Identity`.
30. **FreeSWITCH — sip_cid_type variable** — https://freeswitch.org/confluence/display/FREESWITCH/sip_cid_type — pid (PAI), rpid, none; Privacy header interaction.
31. **FreeSWITCH-users — Caller id in P-Asserted-Identity** — http://lists.freeswitch.org/pipermail/freeswitch-users/2015-May/113274.html — controlling CID via PAI.
32. **Ringover — BYOC** — https://support.ringover.com/hc/en-us/articles/32780047351313 — illustrative BYOC field set (SIP trunk name, user/pass, SIP prefix, custom header, transport, IP).
33. **FreeSWITCH-users — Help with multiple gateway dialplan failover and limits** — http://lists.freeswitch.org/pipermail/freeswitch-users/2013-December/101752.html — `continue_on_fail=true`, sequential bridge gateways.
34. **FreeSWITCH-users — Detecting Errors when dialing through multiple gateways** — http://lists.freeswitch.org/pipermail/freeswitch-users/2013-May/095741.html — `[leg_delay_start=8]` simultaneous-with-delay, comma-list bridge.
35. **FreeSWITCH-users — Gateway Failover** — https://lists.freeswitch.org/pipermail/freeswitch-users/2017-November/128131.html — `gateway1|gateway2` syntax with leg-vars.
36. **FreeSWITCH — Gateways Configuration** — https://freeswitch.org/confluence/display/FREESWITCH/Gateways+Configuration — full param sample, `register-proxy`, `outbound-proxy`, `contact-params`, `extension`.
37. **FreeSWITCH — mod_distributor** — https://freeswitch.org/confluence/display/FREESWITCH/mod_distributor — weighted RR, `${distributor(name+up_gws)}`, dead gateway exclusion.
38. **Kamailio — DISPATCHER module** — https://www.kamailio.org/docs/modules/stable/modules/dispatcher.html — algorithms, `ds_ping_method=OPTIONS`, `ds_probing_mode`, weights, priorities.
39. **kamailio/kamailio dispatcher README** — https://github.com/kamailio/kamailio/blob/master/src/modules/dispatcher/README — algorithms 4/8/9/10/11/12/13, congestion-aware EWMA, priority semantics.
40. **SR-Users — Health Check on Dispatcher Failover** — https://lists.kamailio.org/pipermail/sr-users/2021-February/111814.html — `ds_probing_mode=1`, ds_ping_reply_codes class=2;3;4, `failure_route + ds_next_dst`.
41. **SR-Users — Issue with Dispatcher Failover algorithm** — https://lists.kamailio.org/pipermail/sr-users/2017-May/097260.html — algorithm 8 priority semantics (lower = higher priority).
42. **Telnyx — STIR/SHAKEN SIP Header Parameters** — https://developers.telnyx.com/docs/voice/stir-shaken/sip-header-parameters — `verstat` parameter values (Passed/Passed-B/Passed-C/Failed/No-TN), inbound + on-net.
43. **Telnyx — Signing your own calls for SHAKEN/STIR** — https://telnyx.com/resources/shaken-stir-sign-your-calls — small-provider obligation, certificate authority, OCN/499A requirements, Telnyx default A-attestation policy.
44. **Twilio — Branded Calling** — https://www.twilio.com/en-us/voice/branded-calling — STIR/SHAKEN required prerequisite, business profile, T-Mobile/Verizon coverage, registration flow.
45. **Telnyx — Inbound Call Screening Free** — https://telnyx.com/release-notes/inbound-call-screening-free — Nomorobo/YouMail/CallerAPI reputation providers, free as of release.
46. **Vicidial — servers / vicidial_carrier_log / vicidial_server_trunks tables** — http://forum.eflo.net/VICIDIALforum/viewtopic.php?f=4&t=41838 — schema overview; T02 `carriers + gateways` is functional analog of Vicidial's `servers + vicidial_carriers + vicidial_carrier_log` triad.
47. **Vicidial — MySQL_AST_CREATE_tables.sql `servers` table** — https://github.com/inktel/Vicidial/blob/master/extras/MySQL_AST_CREATE_tables.sql — `server_id`, `max_vicidial_trunks`, `vicidial_balance_active` — for comparison only; we do not replicate this schema.
48. **Vicidial — carrier entry populated example** — https://www.vicidial.org/VICIDIALforum/viewtopic.php?f=4&p=116693&t=34249 — Vicidial carrier registration_string, account_entry, dialplan_entry; informs our render/auth-mode separation.
49. **englercj/node-esl** — https://github.com/englercj/node-esl — `modesl` Node ESL bindings; `api`/`bgapi` semantics, BACKGROUND_JOB completion.
50. **vma/esl (Go)** — http://github.com/vma/esl — Go ESL library for `originate`, `Api`, `BgApi`, used by T01 dialer engine; T02 uses it indirectly via T01's wrapper.

---

**End of RESEARCH.md.** Ready for orchestrator review. PLAN phase blocked on F02 + F03 PLAN (both already landed) plus F05 PLAN (envelope-encryption helper signature). Once F05 PLAN ships, T02 PLAN can proceed in ~1 day.
