# T02 — Carrier Mgmt + Sofia Gateway Templating — PLAN

**Module:** T02 (Telephony, Phase 1)
**Author:** T02-PLAN sub-agent (Claude Opus 4.7, 1M ctx)
**Date:** 2026-05-06
**Status:** PROPOSED — awaiting orchestrator review.
**Companion:** [RESEARCH.md](./RESEARCH.md) — 50 citations.
**Depends on (PLANs FROZEN upstream):** F02 (`carriers` + `gateways`),
F03 (external profile + ACL `carriers`), F05 (envelope encryption +
RBAC middleware), T01 (ESL `Reload` / `Api` wrappers).
**Blocks:** T04 (originate consumes gateway names + concurrent-call cap),
M04 (carriers admin UI), I02 (DID inbound routing), X04 (number pool),
O01 (carrier-health metrics), O05 (rotation runbook).

This PLAN turns RESEARCH §1–§10 into the concrete carrier kinds, template
file layout, REST surface, render-pipeline modules, Sofia rescan choreography,
credential-rotation transaction, caller-ID policy, failover plan, concurrent-
call accounting strategy, health-poller cadence, and hand-off contracts the
IMPLEMENT phase will deliver. Once approved the **public surface** —
`carriers.kind` enum (8 values), template file names, REST routes,
Redis key shapes, ESL command sequence, audit-event names, Prometheus
metric names — is FROZEN.

---

## 0. TL;DR (10-bullet decision summary)

1. **Eight carrier kinds, one Handlebars template each.** `carriers.kind`
   enum widens from F02's 5 (`twilio|telnyx|signalwire|ringcentral|byoc`)
   to **8**: `twilio`, `telnyx-creds`, `telnyx-ip`, `signalwire`,
   `ringcentral`, `bandwidth`, `flowroute`, `byoc`. Each gets a
   `.hbs` template at `freeswitch/conf/sip_profiles/external/templates/<kind>.hbs`.
   F03's bootstrap `.xml.tmpl` files stay (env-substituted, single-trunk
   bring-up); T02's `.hbs` overrides at runtime per-carrier-row.
   **F02 amendment ticket** filed for the enum widen (mechanical, F02
   IMPLEMENT picks up before T02 IMPLEMENT lands).
2. **Auth-mode is derived per carrier kind (matrix in §2).** `register`
   and `username_ct present?` are populated by the create handler from
   the kind. Twilio = no-register IP+digest FQDN; Telnyx-creds = register
   digest; Telnyx-ip = no-register IP+tech-prefix; RingCentral = register
   via SBC; SignalWire = register digest project_id:api_token + TLS;
   Bandwidth = no-register dual-SBC IP-allowlist UDP-only; Flowroute =
   no-register IP + 8-digit tech-prefix; BYOC = configurable.
3. **REST surface (8 admin routes) under `/api/admin/carriers`.** CRUD +
   `test` (OPTIONS ping, returns latency) + `health` (cached 90 s status)
   + `rotate-credentials` (encrypt new → DB tx → render → killgw+rescan
   → verify → audit). Plus `/api/admin/gateways` for the per-gateway
   sub-resource (1:N under a carrier). All routes go through
   `requireAuth + requireTenant + requirePermission('carrier:edit'|'carrier:read')`
   per F05 §6.2.
4. **Sofia rescan = universal `killgw + sleep 1s + rescan + sleep 3s
   + status verify`.** Single-flight queue per profile (Valkey lock
   `t:{tid}:lock:carrier:rescan:external`, 30 s TTL) to serialize
   concurrent admin edits. On failure: rollback `.bak`, re-rescan, throw
   `CARRIER_RELOAD_FAILED`, audit `carrier.reload_failed`. Never
   `restart` (drops calls).
5. **Atomic XML write.** Renderer writes `<gw_name>.xml.tmp`, `fsync`,
   `rename` to `<gw_name>.xml`, keeps prior as `<gw_name>.xml.bak` (one
   rotation). POSIX rename atomic on same FS. ACL file (`acl.conf.xml`,
   named-list `carriers`) regenerated from `carriers.ip_allowlist` JSON
   union; `reloadacl` after.
6. **Credential rotation = encrypt → DB tx → render → killgw+rescan →
   verify → audit.** Calls `F05.encrypt({table:'carriers', column:
   'password_ct', rowId, tenantId, plaintext})` per F05 §4.6. Writes
   `(username_ct, password_ct, kek_version, version+1)` in single TX
   with `audit_events` row. **Cleartext password lands on disk inside
   the rendered XML** — Phase-1 acceptable per F05 §5.1 Path A
   compromise (file mode `0640 root:freeswitch`); Phase-2 ticket migrates
   carrier creds to mod_xml_curl loopback binding (mirrors F05's SIP-creds
   migration).
7. **Caller-ID = three-knob policy.** Hard-coded per template:
   `caller-id-in-from=true` (all carriers). At originate time T04 sets
   `sip_cid_type=pid` for non-Bandwidth (P-Asserted-Identity) and
   `sip_cid_type=none + sip_h_P-Asserted-Identity=<sip:...>` for
   Bandwidth (avoids dual-PAI bug #29). STIR/SHAKEN signing delegated
   to carriers (Phase-1; A-attestation default per Twilio/Telnyx/SignalWire
   defaults — RESEARCH §1.10).
8. **Failover phased.** **Phase 1:** T04 builds `sofia/gateway/<gw1>/+E164|sofia/gateway/<gw2>/+E164`
   (sequential pipe-list) ordered by `(gateways.active, priority ASC,
   weight DESC)`, pre-filtering by Valkey health-cache. **Phase 2:**
   `mod_distributor` weighted round-robin (regenerated `distributor.conf.xml`
   on edit). **Phase 3.5:** Kamailio dispatcher (X02 module). All three
   phases consume the same `priority`, `weight`, `active` columns —
   F02 PLAN already has `priority`; **F02 amendment ticket** adds
   `weight SMALLINT NOT NULL DEFAULT 100` and
   `max_concurrent INT NULL` to `gateways`, plus
   `max_concurrent INT NULL` and `send_pai BOOLEAN DEFAULT FALSE` to
   `carriers`.
9. **Per-gateway concurrent-call accounting via Valkey counter.** Key
   `t:{tid}:gw:{id}:active` incremented on `CHANNEL_CREATE` event,
   decremented on `CHANNEL_HANGUP_COMPLETE` (T01 `EnrichedEvent`
   consumer). T04 enforces at originate time: refuses (or shifts to
   fallback gateway) if `active >= gateways.max_concurrent` (or
   `carriers.max_concurrent` aggregate). 60-second reconciler
   cross-checks counter against `sofia status gateway <name>` OB Calls
   and corrects on drift > 2.
10. **Health poller = 30 s loop, Redis-cached 90 s.** Single
    `api sofia status gateway` per FS via T01 `Api()`; parses tab-separated
    rows; writes
    `t:{tid}:carrier:status:{gateway_id} → {state, status, ping_ms, ib_active, ob_active, healthy, polled_at}`
    (TTL 90 s); emits Prom gauge `vici2_carrier_health_status{name,state}`.
    Healthy iff `REGED` (register=true) or `NOREG && Status=UP (ping)`
    (register=false). State change → `audit_events` row + carrier-state
    event stream. **TLS ping-stuck watchdog** (signalwire/freeswitch#2489):
    if `PingState x/y/z` and `Status=UP` but last-ping-age > 3×PingFreq,
    auto-`killgw + rescan`; counted in `vici2_carrier_ping_stuck_total`.

---

## 1. Carrier kinds (FROZEN)

### 1.1 Enum

`carriers.kind ENUM` widens to (F02 amendment, non-breaking — adding
enum values is a `MODIFY COLUMN` migration):

```
twilio
telnyx-creds
telnyx-ip
signalwire
ringcentral
bandwidth
flowroute
byoc
```

The pre-existing `telnyx` value (F02 PLAN §4.20) collapses into two
explicit modes (`telnyx-creds` / `telnyx-ip`). Migration retags any
pre-T02 `kind='telnyx'` rows by inspecting `register` (true → `telnyx-creds`,
false → `telnyx-ip`).

### 1.2 Per-kind defaults (assembled by create handler)

| `kind` | `register` | `transport` (default) | `expire_seconds` | `proxy` template | `ip_allowlist` source | `caller-id-in-from` |
|---|---|---|---|---|---|---|
| `twilio` | false | tls (5061) | n/a | `<acct>.pstn.<edge>.twilio.com` | Twilio published edge CIDRs | true |
| `telnyx-creds` | true | tls (5061) | 3600 | `sip.telnyx.com` | (none — auth via creds) | true |
| `telnyx-ip` | false | udp/tcp (5060) | n/a | `sip.telnyx.com` | Telnyx connection-IP | true |
| `signalwire` | true | tls (5061) | 3600 | `<space>.sip.signalwire.com` | (none) | true |
| `ringcentral` | true | tls (5061) | 600 | `sip.ringcentral.com` | (none) | true |
| `bandwidth` | false | udp ONLY (5060) | n/a | `<acct-hex>.auth.bandwidth.com` (realm) | Bandwidth mated SBC pair IPs | true |
| `flowroute` | false | udp/tcp (5060) | n/a | `<region>.sip.flowroute.com` | Flowroute IP-auth list | true |
| `byoc` | configurable | configurable | configurable | operator-supplied | operator-supplied | true |

Operator can override every field via `gateways.template_overrides`
JSON (e.g., `{"transport":"tls"}` to upgrade Bandwidth from UDP — at
operator's risk; we surface a warning in the test response if Bandwidth
+ TLS).

---

## 2. Auth-mode matrix (DERIVED, FROZEN)

`auth_mode` is a derived field returned in API responses (not stored).
Computed in `api/src/carriers/auth-mode.ts` from
`(carriers.kind, carriers.register, carriers.username_ct present?)`.

| `kind` | `register` | Username CT? | Outbound auth | Inbound auth | Sofia params produced |
|---|---|---|---|---|---|
| `twilio` | false | yes | digest cred-list | IP-ACL `carriers` (Twilio edge CIDRs) | `username`, `password`, `proxy`, `register=false`, `register-transport=tls`, `caller-id-in-from=true`, `ping=25`, `ping-max=3` |
| `telnyx-creds` | true | yes | digest user/pass | IP-ACL or FQDN+creds | `username`, `password`, `realm=sip.telnyx.com`, `proxy=sip.telnyx.com`, `register=true`, `register-transport=tls`, `expire-seconds=3600`, `caller-id-in-from=true`, `ping=25` |
| `telnyx-ip` | false | no | IP allowlist + tech-prefix prepend | IP-ACL `carriers` | `username=not-used`, `password=not-used`, `proxy=sip.telnyx.com`, `register=false`, `caller-id-in-from=true`, `ping=25` (T04 prepends tech-prefix) |
| `signalwire` | true | yes (project_id : api_token OR endpoint user/pass) | digest | IP-ACL or domain-app | `username`, `password`, `realm=<space>.sip.signalwire.com`, `proxy=<space>.sip.signalwire.com`, `register=true`, `register-transport=tls`, `caller-id-in-from=true`, `ping=25` |
| `ringcentral` | true | yes (per-DID register) | digest via SBC | SBC-mediated (FS plays SBC role) | `username`, `password`, `realm=sip.ringcentral.com`, `proxy=sip.ringcentral.com`, `register=true`, `register-transport=tls`, `expire-seconds=600`, `extension=<DID>`, `caller-id-in-from=true`, `ping=25` |
| `bandwidth` | false | optional (digest realm bridge) | IP allowlist (mated SBC pair) | IP-ACL `carriers` (BOTH mated IPs) | `username=optional`, `password=optional`, `realm=<acct-hex>.auth.bandwidth.com`, `proxy=<primary-sbc-ip>` (with `outbound-proxy=<secondary>` for failover), `register=false`, `register-transport=udp`, `caller-id-in-from=true`, `ping=25` (note: ping uses IP not realm SRV) |
| `flowroute` | false | no | IP allowlist + 8-digit tech-prefix prepend | IP-ACL `carriers` | `username=not-used`, `password=not-used`, `proxy=<region>.sip.flowroute.com`, `register=false`, `caller-id-in-from=true`, `ping=25` (T04 prepends tech-prefix) |
| `byoc` | configurable | configurable | configurable (digest, IP, none) | configurable | every Sofia param overridable via `template_overrides` JSON |

**Validation rules (enforced in create handler, returned as 400
`CARRIER_INVALID_FIELD`):**

- `register=true` requires `username_ct` non-null + `password_ct` non-null.
- `kind in ('twilio','bandwidth','flowroute','telnyx-ip')` requires
  `register=false` AND `ip_allowlist` non-empty array.
- `kind='ringcentral'` requires `extension` (per-DID register).
- `kind='bandwidth'` requires `transport='udp'` (warning if operator
  overrides via `template_overrides`).
- `proxy` regex `^[a-zA-Z0-9.\-:]{1,255}$` (allow `:port` suffix).

---

## 3. Handlebars templates (per-kind `.hbs` files)

### 3.1 Location

```
freeswitch/conf/sip_profiles/external/templates/twilio.hbs
freeswitch/conf/sip_profiles/external/templates/telnyx-creds.hbs
freeswitch/conf/sip_profiles/external/templates/telnyx-ip.hbs
freeswitch/conf/sip_profiles/external/templates/signalwire.hbs
freeswitch/conf/sip_profiles/external/templates/ringcentral.hbs
freeswitch/conf/sip_profiles/external/templates/bandwidth.hbs
freeswitch/conf/sip_profiles/external/templates/flowroute.hbs
freeswitch/conf/sip_profiles/external/templates/byoc.hbs
```

(Eight files. Source-controlled. Renderer loads at boot via
`fs.readFileSync` + `Handlebars.compile` cache — no runtime template
edit allowed in Phase 1. Phase 2 ticket: hot-reload on file watch.)

### 3.2 Common shape (Twilio example)

```handlebars
<include>
  <gateway name="{{name}}">
    {{#if username}}<param name="username" value="{{username}}"/>{{/if}}
    {{#if password}}<param name="password" value="{{password}}"/>{{/if}}
    {{#if realm}}<param name="realm" value="{{realm}}"/>{{/if}}
    <param name="proxy" value="{{proxy}}"/>
    {{#if outbound_proxy}}<param name="outbound-proxy" value="{{outbound_proxy}}"/>{{/if}}
    <param name="register" value="{{register}}"/>
    <param name="register-transport" value="{{transport}}"/>
    {{#if expire_seconds}}<param name="expire-seconds" value="{{expire_seconds}}"/>{{/if}}
    {{#if retry_seconds}}<param name="retry-seconds" value="{{retry_seconds}}"/>{{/if}}
    {{#if extension}}<param name="extension" value="{{extension}}"/>{{/if}}
    {{#if from_user}}<param name="from-user" value="{{from_user}}"/>{{/if}}
    {{#if from_domain}}<param name="from-domain" value="{{from_domain}}"/>{{/if}}
    <param name="caller-id-in-from" value="true"/>
    <param name="codec-prefs" value="{{codec_prefs}}"/>
    <param name="dtmf-type" value="rfc2833"/>
    <param name="ping" value="{{ping_seconds}}"/>
    <param name="ping-max" value="{{ping_max}}"/>
    <param name="context" value="public"/>
    {{#if rtp_secure_media}}<param name="rtp-secure-media" value="{{rtp_secure_media}}"/>{{/if}}
    {{#if srtp_crypto_suites}}<param name="srtp-crypto-suites" value="{{srtp_crypto_suites}}"/>{{/if}}
    {{#each extra_params}}
    <param name="{{name}}" value="{{value}}"/>
    {{/each}}
  </gateway>
</include>
```

### 3.3 Knobs exposed vs. hard-coded

| Knob | Source | Phase 1 |
|---|---|---|
| `username`, `password`, `proxy`, `realm`, `from-user`, `from-domain`, `register`, `register-transport`, `expire-seconds`, `retry-seconds`, `extension` | DB columns (`carriers.*`, `gateways.*`) | exposed |
| `caller-id-in-from`, `dtmf-type`, `context` | hard-coded per template | hard-coded (override via `template_overrides.extra_params`) |
| `codec-prefs` | per-kind default; `gateways.template_overrides.codec_prefs` overrides | exposed (default per kind in §1.2) |
| `ping`, `ping-max` | `gateways.template_overrides.ping_seconds` / `ping_max` (defaults 25 / 3) | exposed |
| `rtp-secure-media`, `srtp-crypto-suites` | per-kind preset (Twilio Secure Trunking on; others off) | preset, override via `template_overrides` |
| `outbound-proxy`, `register-proxy`, `contact-params` | `template_overrides` JSON | overridable |

### 3.4 Injection defense

- Handlebars `{{ }}` HTML-escapes by default (covers `<`, `>`, `&`, `"`).
- **Additionally** every interpolation is Zod-validated before render
  (`api/src/carriers/validators.ts`):
  - `name`: `^[a-z][a-z0-9-]{0,62}$`
  - `proxy`: `^[a-zA-Z0-9.\-:]{1,255}$`
  - `username`, `password`, `from_user`, `realm`: deny `<>&\n\r`
  - `extension`: `^[+]?[0-9]{1,32}$`
  - numeric fields: integer ranges (`expire_seconds` in `[60..86400]`,
    `ping_seconds` in `[5..300]`)
- Test fixture in `api/test/carriers/render.test.ts`:
  `name='<gateway"/><param name="evil" value="x"/>"'` either rejected
  by Zod or escaped to `&lt;gateway&quot;...` — verifies Sofia parses
  identically.

---

## 4. REST API surface (FROZEN)

All routes under `/api/admin/carriers` (and `/api/admin/gateways` for
sub-resource), RBAC `requirePermission('carrier:read'|'carrier:edit')`
per F05 §6.2; tenant-scoped via global `requireTenant` hook.

| Method | Path | Body / Query | Returns | Notes |
|---|---|---|---|---|
| `POST` | `/carriers` | `CreateCarrierBody` | full carrier (passwords masked `***`) | Triggers render + rescan; rolls back on failure |
| `GET` | `/carriers` | `?active=true&kind=twilio&page=1&per_page=50` | paginated list `{ data, pagination }` (passwords masked) | Live state from Redis cache |
| `GET` | `/carriers/:id` | — | full carrier (passwords masked `***`) | |
| `PUT` | `/carriers/:id` | `UpdateCarrierBody` | full carrier | Optimistic concurrency via `version` column; re-render + rescan if rendered fields changed; if only `active`/`weight`/notes changed, just `killgw+rescan`; `username/password` change → routes through `rotate-credentials` flow |
| `DELETE` | `/carriers/:id` | `?force=true` | `{ id, deleted_at }` | Refuse with 409 `CARRIER_IN_USE` if any campaign or `did_numbers` reference it; `force=true` bypasses (super_admin only); soft delete; remove XML files for all gateways; `killgw` each; `rescan` |
| `POST` | `/carriers/:id/test` | `{ to?: "+14155551212" }` | `{ ok, state, ping_ms, status, options_response_code?, raw }` | OPTIONS smoke test (see §6.3) |
| `GET` | `/carriers/:id/health` | — | `{ state, status, ping_ms, ib_active, ob_active, healthy, polled_at }` | Reads Redis cache (90 s TTL); `?refresh=true` forces immediate poll |
| `POST` | `/carriers/:id/rotate-credentials` | `{ username?, password? }` | `{ id, kek_version, version }` | Discrete rotation endpoint (§7); audit `auth.carrier.rotate_creds` |
| `GET` | `/gateways` | `?carrier_id=` | per-gateway list | gateways are 1:N under a carrier |
| `POST` | `/carriers/:id/gateways` | full gateway object | `{ id, ... }` | Renders one XML per gateway under same carrier |
| `PUT` | `/gateways/:gid` | partial | `{ id, ... }` | Same render+rescan pipeline |
| `DELETE` | `/gateways/:gid` | — | `{ id }` | Removes XML file; `killgw`; `rescan` |

**OpenAPI:** Schemas (`Carrier`, `Gateway`, `CarrierStatus`, `CarrierTestResult`)
land in `shared/openapi/openapi.yaml` in the T02 PR.

**Error codes (Phase 1):**

- `CARRIER_NOT_FOUND` (404)
- `CARRIER_IN_USE` (409 — referenced by campaign/did)
- `CARRIER_INVALID_FIELD` (400 — Zod or matrix violation)
- `CARRIER_VERSION_CONFLICT` (409 — optimistic concurrency)
- `CARRIER_RELOAD_FAILED` (500 — rescan errored or status verify failed)
- `CARRIER_RESCAN_LOCKED` (503 — single-flight lock contention; client retry)
- `CARRIER_TEST_FAILED` (200 with `{ ok: false, reason }` — soft failure;
  not HTTP error)

---

## 5. Render pipeline (concrete file layout)

### 5.1 File list (FROZEN, under `api/src/carriers/`)

```
api/src/carriers/
  handlers/
    create.ts                  — POST /carriers
    list.ts                    — GET  /carriers
    get.ts                     — GET  /carriers/:id
    update.ts                  — PUT  /carriers/:id
    delete.ts                  — DELETE /carriers/:id
    test.ts                    — POST /carriers/:id/test
    health.ts                  — GET  /carriers/:id/health
    rotate.ts                  — POST /carriers/:id/rotate-credentials
    gateways/
      list.ts                  — GET  /gateways
      create.ts                — POST /carriers/:id/gateways
      update.ts                — PUT  /gateways/:gid
      delete.ts                — DELETE /gateways/:gid
  templates.ts                 — loads all .hbs files at boot, exports renderGateway(kind, ctx)
  render.ts                    — orchestrates DB read → renderGateway → atomic write
  sofia-control.ts             — ESL wrapper: killgw, rescan, status, reloadacl (delegates to T01)
  health-poller.ts             — 30-s background loop, writes Valkey cache + Prom metrics
  health-cache.ts              — Valkey read/write helpers for status cache
  acl-renderer.ts              — regenerates acl.conf.xml carriers named-list from carriers.ip_allowlist union
  auth-mode.ts                 — derives auth_mode string from (kind, register, username_ct)
  validators.ts                — Zod schemas + per-kind validation rules
  errors.ts                    — typed error classes (CarrierReloadFailed, etc.)
  index.ts                     — barrel export

api/src/carriers/lua/
  rescan_lock.v1.lua           — single-flight lock acquire (SET NX EX) for serialized rescans

api/test/carriers/
  render.test.ts               — template-injection harness, golden XML per kind
  validators.test.ts           — every kind × field validation
  auth-mode.test.ts            — matrix coverage
  sofia-control.test.ts        — ESL stubbed; killgw + rescan + status sequence
  health-poller.test.ts        — parser unit tests (REGED, NOREG+UP, FAIL_WAIT, etc.)
  acl-renderer.test.ts         — atomic write + reloadacl trigger
  rotate.test.ts               — encrypt → DB tx → render → rescan → audit; rollback on rescan fail
  handlers/*.test.ts           — one per handler (Fastify integration)
```

### 5.2 `render.ts` flow (per gateway change)

```
1. Acquire single-flight lock (Lua SET NX EX 30 t:{tid}:lock:carrier:rescan:external)
   - On contention: retry 3× with 500ms exponential back-off; then 503 CARRIER_RESCAN_LOCKED
2. Load carrier + gateway from DB (decrypt password via F05.decrypt)
3. Build template context (apply per-kind defaults from §1.2, merge template_overrides)
4. renderGateway(kind, ctx) → XML string
5. xmllint --noout (in-process libxml binding) — defense against template bugs
6. Move existing /etc/freeswitch/conf/sip_profiles/external/<gw_name>.xml → .bak (if exists)
7. Write <gw_name>.xml.tmp + fsync + rename to <gw_name>.xml (mode 0640 root:freeswitch)
8. Call sofia-control.applyGatewayChange(gw_name)  // see §6
9. On success: audit carrier.rendered; release lock; return
10. On failure: restore .bak → rename → applyGatewayChange again (recovery rescan);
    audit carrier.reload_failed; release lock; throw CARRIER_RELOAD_FAILED
```

### 5.3 `acl-renderer.ts` flow

Triggered when any `carriers.ip_allowlist` changes:

1. Acquire lock `t:{tid}:lock:carrier:acl` (separate from rescan lock).
2. Read ALL active carriers' `ip_allowlist`, union into the `carriers`
   named-list of `acl.conf.xml`.
3. Atomic write `acl.conf.xml.tmp` → `acl.conf.xml`.
4. T01 `Reload(fsHost, "acl")` → ESL `reloadacl`.
5. Audit `carrier.acl_reloaded`.

(F03 PLAN already provisions the empty `carriers` named-list; T02
populates it per RESEARCH §1.3 and F03 §14.8.)

---

## 6. Sofia rescan procedure (universal safe sequence)

### 6.1 `sofia-control.applyGatewayChange(gw_name)` — FROZEN sequence

```typescript
async function applyGatewayChange(gwName: string): Promise<GatewayStatus> {
  // 1. killgw — non-disruptive; no-op if absent (returns "+OK Disconnected 0 channel(s)")
  await t01.api(fsHost, `sofia profile external killgw ${gwName}`);
  await sleep(1000);
  // 2. rescan — picks up new/modified XML; preserves live calls
  const rescan = await t01.api(fsHost, `sofia profile external rescan`);
  if (rescan.includes('+ERR')) {
    throw new CarrierReloadFailed('rescan returned +ERR', { rescan });
  }
  await sleep(3000);
  // 3. status verify — parse one-line per gateway
  const status = await t01.api(fsHost, `sofia status gateway ${gwName}`);
  return parseGatewayStatus(status);
}
```

### 6.2 When to call rescan vs reload vs restart (RESEARCH §7)

| Change | Command sequence | Drops calls? |
|---|---|---|
| Add new gateway | `killgw` (no-op) → `rescan` | No |
| Modify existing gateway params | `killgw <name>` → `rescan` | No |
| Toggle `active=false` | `killgw <name>` (file kept) | No |
| Remove gateway | `killgw <name>` → delete file → `rescan` | No |
| ACL change | `reloadacl` (after `acl-renderer.ts` writes) | No |
| Profile-level params (rare; codec change at profile scope) | `restart` | **Yes — never default** |
| WSS TLS cert | `restart` | Yes — F03 owns this; out of T02 scope |

### 6.3 Test endpoint (`POST /carriers/:id/test`)

1. Validate carrier exists + admin perms.
2. Render gateway XML (already on disk; re-render to capture latest DB).
3. `applyGatewayChange(gw_name)` (idempotent killgw + rescan).
4. Sleep 3000 ms (rescan settle).
5. Parse `sofia status gateway <gw_name>` for `state`, `ping_ms`, `status`.
6. If `register=true` and `state != REGED` after retry up to 8 s
   total → `{ ok:false, reason:"REGISTRATION_FAILED" }`.
7. If `register=false` and `status != "UP (ping)"` after 5 s →
   `{ ok:false, reason:"NO_OPTIONS_REPLY" }`.
8. Otherwise `{ ok:true, state, ping_ms, status }`.
9. Optional `to` parameter: `bgapi originate
   {origination_uuid=<u>,hangup_after_bridge=true,leg_timeout=10}sofia/gateway/<name>/<to>
   &echo()` — reports bridge/hangup cause without billing a long call.
   Disabled by default (operator opts in per request).

### 6.4 Single-flight queue

Lua `rescan_lock.v1.lua` (loaded via F04 SCRIPT LOAD pattern):

```lua
-- KEYS[1] = t:{tid}:lock:carrier:rescan:external
-- ARGV[1] = lock_token (uuidv7)
-- ARGV[2] = ttl_ms (default 30000)
local existing = redis.call('GET', KEYS[1])
if not existing then
  redis.call('SET', KEYS[1], ARGV[1], 'PX', tonumber(ARGV[2]))
  return {'OK', ARGV[1]}
end
return {'BUSY', existing}
```

Release via `EVAL "if redis.call('GET',KEYS[1])==ARGV[1] then return
redis.call('DEL',KEYS[1]) end" 1 <key> <token>` (no Lua file — too small).

Concurrent admin edits → second one waits 500/1000/2000 ms then 503
`CARRIER_RESCAN_LOCKED`. Lock TTL 30 s ensures crashed renderers
release.

---

## 7. Credential rotation flow (concrete)

### 7.1 Endpoint shape

```
POST /api/admin/carriers/:id/rotate-credentials
Authorization: Bearer <admin JWT>
Idempotency-Key: <uuid>            // header, prevents double-rotation on retry
Content-Type: application/json
{
  "username": "AC...optional",     // optional; if omitted, keep existing
  "password": "new-password-or-let-server-generate"  // optional; if omitted, generate 32-char alphanum
}
```

Returns:
```json
{ "id": 17, "kek_version": 1, "version": 8 }
```

### 7.2 Algorithmic flow

1. **Authn:** `requireAuth + requireRole('admin') + requirePermission('carrier:edit')`.
2. **Idempotency:** Valkey `t:{tid}:idem:carrier-rotate:{key} → result` (TTL 5 min).
   Replay returns cached response.
3. **Load + decrypt** existing creds (audit `auth.carrier.cred_read`,
   actor = current admin).
4. **Encrypt new** via F05.encrypt():
   ```typescript
   const blob = encrypt({
     table: 'carriers',
     column: 'password_ct',
     rowId: BigInt(carrier.id),
     tenantId: BigInt(carrier.tenant_id),
     plaintext: newPassword,
   });
   ```
5. **DB transaction** (single TX per F02 + F05 conventions):
   ```sql
   BEGIN;
     UPDATE carriers
       SET username_ct=?, password_ct=?, kek_version=?,
           updated_at=NOW(6), version=version+1
       WHERE id=? AND tenant_id=? AND version=?;
     -- audit_events row in same TX (atomic)
     INSERT INTO audit_log
       (tenant_id, actor_user_id, actor_kind, action, entity_type,
        entity_id, before_json, after_json, ip, user_agent, request_id, ts)
       VALUES (?,?,?,'auth.carrier.rotate_creds','carrier',?, ?, ?, ?, ?, ?, NOW(6));
   COMMIT;
   ```
   On `version` mismatch → 409 `CARRIER_VERSION_CONFLICT`.
6. **Render new XML for every gateway under this carrier** (single
   `render.ts` call per gateway, serialized via the same single-flight
   lock).
7. **`killgw + rescan + sleep 3s + verify`** per gateway.
8. **Verify success:**
   - `register=true`: `state == REGED` within 8 s.
   - `register=false`: `Status == "UP (ping)"` within 8 s (OPTIONS reply).
9. **On failure:** restore prior XML from `.bak`, recovery `killgw +
   rescan`, **compensating DB TX** that re-writes the prior creds (kept
   in memory between steps 3 and 8 — never logged); audit
   `auth.carrier.rotate_creds_failed`; throw `CARRIER_RELOAD_FAILED`.
10. **Old credentials** remain valid at the carrier until the carrier
    revokes them — for register-based trunks, rotation revokes inflight
    registrations on next register cycle. T02 surfaces a "test old creds
    invalidated by carrier" status in the UI (manual confirmation by admin).
11. **Never log plaintext creds** (CI grep — F05 §9.3 catalog already
    includes `password_ct`, `username_ct`).

### 7.3 Cleartext on disk — Phase-1 compromise

Per F05 §5.1 Path A: cleartext SIP/carrier passwords land on disk inside
the rendered XML. File mode `0640 root:freeswitch`. `.dockerignore`
already blocks `freeswitch/conf/sip_profiles/external/*.xml` from git
(F01). Phase-2 ticket (filed in T02 HANDOFF): migrate carrier creds to
`mod_xml_curl` loopback binding, mirroring F05's SIP-creds Phase-2
ticket. Until then: encrypted root volume in non-dev deployments,
host-local file system permissions.

---

## 8. Caller-ID handling

### 8.1 Hard-coded per template (gateway-level)

- `caller-id-in-from=true` on every gateway — required by every Phase-1
  carrier (RESEARCH §1.8); makes `effective_caller_id_number` go in
  the SIP `From` header.

### 8.2 Per-call channel vars (T04 originate-time)

T04 sets the following channel vars on `bgapi originate` based on
carrier kind (read from `carriers.kind` via DB lookup keyed by
`gateway_id`):

| Carrier kind(s) | Channel vars |
|---|---|
| All except `bandwidth` | `sip_cid_type=pid` (mod_sofia auto-populates `P-Asserted-Identity` from `effective_caller_id_number`) |
| `bandwidth` | `sip_cid_type=none, sip_h_P-Asserted-Identity=<sip:{cid_e164}@{realm}>` (manual injection — avoids dual-PAI bug, RESEARCH §1.8 / cite [29]) |
| All | `effective_caller_id_number=<E.164>` (from campaign/lead/carriers.caller_id_e164 fallback) |
| All (when needed) | `origination_privacy=hide_name+hide_number` for anonymous (RFC 3325 Privacy header) |
| All (when needed) | `origination_caller_id_number=<override>` for per-campaign/per-DID CID |

### 8.3 PAI default

Phase-1 default: **PAI on for non-Bandwidth, manual injection for
Bandwidth.** Future per-carrier opt-out via `carriers.send_pai BOOLEAN
DEFAULT FALSE` (F02 amendment ticket — see §1.1) — when
`send_pai=false`, T04 omits `sip_cid_type=pid`, From-header only.

### 8.4 STIR/SHAKEN

Delegated to carriers in Phase 1. Twilio/Telnyx/SignalWire all default
to A-attestation for owned numbers (RESEARCH cite [42][43][44]). No
Identity-header generation at FS layer. Phase-2 module spec (deferred):
Tiltx-style external signing for non-carrier-owned DIDs (cite [28]).

---

## 9. Failover (phased)

### 9.1 Phase 1 — bridge dial-string fallback

T04 builds the originate destination by joining gateways for the
carrier ordered by `(gateways.active, priority ASC, weight DESC)`,
**pre-filtered by health cache**:

```
sofia/gateway/<gw1>/+1NPANXXXXXX|sofia/gateway/<gw2>/+1NPANXXXXXX
```

- `|` = sequential (try gw1; on failure → gw2). [RESEARCH §6 Phase 1]
- T04 reads `t:{tid}:carrier:status:{gateway_id}.healthy` from cache
  and skips unhealthy gateways before constructing the dial-string.
  Prevents the "ring twice then continue" UX issue.
- Comma-list (`gw1,gw2` simultaneous) reserved for Phase 2 — needs
  `[leg_delay_start=Ns]` per-leg vars to avoid double-billing.

### 9.2 Phase 2 — `mod_distributor` (weighted RR)

T02 renderer also writes `freeswitch/conf/autoload_configs/distributor.conf.xml`:

```xml
<list name="carrier-twilio" total-weight="10">
  <node name="twilio-us-east" weight="7"/>
  <node name="twilio-us-west" weight="3"/>
</list>
```

Reload via `distributor_ctl reload`. Dialplan picks via
`${distributor(carrier-twilio ${sofia profile gwlist up})}` (only up
gateways from `gwlist`). Phase 2 ticket; columns
(`weight SMALLINT NOT NULL DEFAULT 100`) added to `gateways` from day 1.

### 9.3 Phase 3.5 — Kamailio dispatcher (X02 module)

X02 module (separate spec) consumes the same `gateways` rows. T02 just
exposes:

- `gateways.priority` (lower = higher priority)
- `gateways.weight` (relative weight within priority tier)
- `gateways.active` (drop from rotation when false)

Renderer in X02 writes `dispatcher.list` lines `<setid> <sip-uri>
<flags> <priority> <attrs>` from these columns.

---

## 10. Per-gateway concurrent-call accounting

### 10.1 Source of truth

**Valkey counter:** `t:{tid}:gw:{id}:active` (INTEGER).

- Incremented on `CHANNEL_CREATE` event whose `variable_sip_gateway_name`
  matches a tracked gateway. T01's `EnrichedEvent` consumer extracts
  `gateway_id` from `variable_gateway_id` (set at originate time by T04
  as `{gateway_id=N}` channel var).
- Decremented on `CHANNEL_HANGUP_COMPLETE` for the same UUID.
- INCR / DECR are atomic; brief overcounting tolerated (reconciler
  fixes drift).

### 10.2 Enforcement (T04 originate-time)

T04 reads:
- `gateways.max_concurrent` (per-gateway cap; null = unlimited)
- `carriers.max_concurrent` (carrier-wide aggregate; null = unlimited)
- Sum of `t:{tid}:gw:{id}:active` for all gateways under the carrier
  (cached 1 s)

Refuses originate (or shifts to next gateway in failover list) if
`active >= max_concurrent`. Surfaces as
`vici2_esl_originate_total{outcome="gateway_at_capacity"}` (extends T01's
metric label set).

### 10.3 60-second reconciler

Background job (single-instance via Valkey lock, runs every 60 s):

1. `api sofia status gateway` (one call, all gateways).
2. Parse `OB Calls (in-progress = total - failed - completed)` per row.
   *(Note: `OB Calls (F/T)` shows lifetime totals; in-progress requires
   subtracting completed-via-hangup count tracked separately by T01.
   Implementation detail: use `show calls` per-gateway count instead —
   verified at IMPLEMENT.)*
3. Compare to Valkey counter.
4. On drift > 2 → log `carrier.counter_drift_detected` warning + correct
   counter to FS truth.
5. Emit `vici2_carrier_counter_drift_total{gateway,direction}`.

### 10.4 Carrier-imposed limits (operator-tracked)

`carriers.notes JSON` (F02 amendment — add to `carriers`) holds
free-form operator memos:

- Twilio Elastic CPS limits (separate from concurrent — RESEARCH §9.3).
- Telnyx 10-channel free tier.
- SignalWire CPS pricing.
- Bandwidth contracted concurrency.

Phase-2 module E02 (pacing) will read these to bound dial level; T02
just exposes the field.

---

## 11. Health check polling

### 11.1 Cadence

Every **30 seconds**, single-instance background loop in API server
(Valkey lock `t:{tid}:lock:carrier:health-poller` with 35 s TTL).

### 11.2 Sequence

1. ESL `api sofia status gateway` (one call, all gateways).
2. Parse one row per active gateway (regex on
   `external::<name>\s+sip:...\s+(REGED|NOREG|UNREG|FAILED|FAIL_WAIT|EXPIRED|NOAVAIL)\s+(\d+\.\d+)\s+(\d+/\d+)\s+(\d+/\d+)`).
3. For `register=false` rows where state is `NOREG`: additionally call
   `sofia status gateway <name>` (verbose) and parse `Status:` line for
   `UP (ping)` / `DOWN`.
4. Compute `healthy`:
   - `register=true` + `state == REGED` → healthy
   - `register=false` + `state == NOREG` + `status == "UP (ping)"` → healthy
   - All others → unhealthy
5. Write `t:{tid}:carrier:status:{gateway_id} → JSON{state, status,
   ping_ms, ib_active, ob_active, healthy, polled_at}` (TTL 90 s).
6. Emit Prom gauge `vici2_carrier_health_status{tenant, gateway,
   carrier_kind, state} = {0|1}`.
7. On state change (was healthy → now down or vice versa): publish
   `vici2.carrier.state_changed` to event stream + write `audit_log`
   row.
8. On 3 consecutive `DOWN` polls → `audit_log` row severity warn (Phase 1);
   Phase 2 wires PagerDuty/Slack.

### 11.3 TLS ping-stuck watchdog

Per RESEARCH §5.5 / cite [25] — known TLS-gateway bug
(signalwire/freeswitch#2489):

- Track `last_ping_age = now - (current_time - PingFreq * (PingState_y - PingState_x))`.
- If `Status == "UP (ping)"` but `last_ping_age > 3 × PingFreq` →
  auto `applyGatewayChange(gateway_name)` (killgw + rescan).
- Counter `vici2_carrier_ping_stuck_total{gateway}` increments.

### 11.4 OPTIONS keepalive defaults

- `ping=25` seconds default (RESEARCH §5.5).
- `ping-max=3` consecutive failures before mark-down.
- `unregister-on-options-fail=false` (F03 PLAN §2.3 — prevents flap on
  transient OPTIONS loss for register=true gateways).
- `secure-only=true` for SignalWire when TLS-only required (per RESEARCH
  §10 question 7 — yes, per-gateway via `template_overrides`).

---

## 12. E911 routing

Phase 1: **separate gateway entry**, typically a separate carrier row
with `kind='byoc'` or `kind='bandwidth'` named `bandwidth-e911`,
`twilio-e911`, etc., pointing at the carrier's 911-specific SBC pool.
Routed by destination match (`911`, `933`) on the dialplan (T03 / I02
own the dispatcher logic).

T02 exposes:
- `carriers.is_emergency BOOLEAN NOT NULL DEFAULT FALSE` (F02 amendment
  — see §1.1) so admin UI can tag and dialplan can filter.
- Bandwidth-specific: `template_overrides.extra_params` includes
  `{"name":"sip_h_X-Account-Id","value":"<acct>"}` per RESEARCH cite [15].
- Twilio: configured at the Twilio Trunk dashboard side; no FS-side
  knob.
- Telnyx: dedicated emergency number registration; carrier-side.

Phase-2 enforcement (validation that an `is_emergency=true` gateway
actually serves `911`/`933`) is documented in HANDOFF — Phase 1 is
documented-only.

---

## 13. Multi-tenant carrier sharing

### 13.1 Phase 1 (per-tenant only)

- `carriers.tenant_id NOT NULL` (F02 PLAN §4.20 has `DEFAULT 1`).
- Each tenant has its own carrier row even if pointing at the same
  FQDN/credentials (operationally inefficient but secure default).
- Super-admin can create carriers in any tenant via `?tenant_id=N`
  query param + `requireRole('super_admin')`.

### 13.2 Phase 2 (deferred — global carriers)

- New table `tenant_carrier_grants (tenant_id, carrier_id, granted_at,
  granted_by_user_id)`.
- `carriers.tenant_id` relaxed to nullable; `tenant_id IS NULL` ⇒
  global carrier.
- Tenants opt-in to global carriers via `tenant_carrier_grants` row.
- Phase-2 module spec (M04 / future); T02 leaves the schema unchanged
  in Phase 1.

---

## 14. Hand-off (FROZEN interfaces)

### 14.1 To T04 (originate)

- Reads `gateways` rows ordered by `(active, priority ASC, weight DESC)`
  per carrier; pre-filters by Valkey `carrier:status:{id}.healthy`.
- Builds dial-string `sofia/gateway/<gw1>/+1NPA...|sofia/gateway/<gw2>/+1NPA...`.
- Sets channel vars per §8.2 (caller-ID, PAI mode).
- For Telnyx-IP / Flowroute: prepends 8-digit tech-prefix to dialed
  E.164 (lookup from `gateways.template_overrides.tech_prefix`).
- **Concurrent-call check:** before originate, sum
  `t:{tid}:gw:{id}:active` for the chosen gateway; refuse if
  `>= gateways.max_concurrent`. Try next gateway in failover list.

### 14.2 To I02 (DID inbound routing)

- Inbound call hits `external` profile → context `public` → I02
  dialplan handler.
- I02 looks up `did_numbers` row by `To` header E.164; reads
  `did_numbers.carrier_id` for ACL/rate purposes (already in F02 §4.22).
- T02 doesn't own DID CRUD — boundary clean.

### 14.3 To M04 (carriers admin UI)

- Consumes `/api/admin/carriers/*` endpoints exactly per §4 OpenAPI
  schemas.
- Live status via `GET /carriers/:id/health` (cached); auto-refresh
  every 30 s in UI.
- "Test" button → `POST /carriers/:id/test`; surfaces ping latency.
- "Rotate creds" → `POST /carriers/:id/rotate-credentials` (modal
  prompts for new password OR auto-generate).

### 14.4 To F05 (encryption)

- T02 calls `encrypt({table:'carriers', column:'password_ct', rowId,
  tenantId, plaintext})` and `decrypt({...})` exclusively via F05's
  helper. No direct AES use.
- AAD binding (F05 §4.4) prevents row-swap attacks on stolen `password_ct`
  blobs.

### 14.5 To F02 (schema amendments)

T02 PLAN files **F02 amendment ticket** (mechanical, F02 IMPLEMENT
picks up before T02 IMPLEMENT lands):

- `carriers.kind` enum widens from
  `('twilio','telnyx','signalwire','ringcentral','byoc')` to
  `('twilio','telnyx-creds','telnyx-ip','signalwire','ringcentral','bandwidth','flowroute','byoc')`.
- `carriers.send_pai BOOLEAN NOT NULL DEFAULT FALSE` (per-call PAI default).
- `carriers.is_emergency BOOLEAN NOT NULL DEFAULT FALSE` (E911 tag).
- `carriers.max_concurrent INT NULL` (carrier-wide concurrency cap).
- `carriers.notes JSON NOT NULL DEFAULT (JSON_OBJECT())` (operator memos).
- `carriers.version INT NOT NULL DEFAULT 1` (optimistic concurrency —
  used by PUT/rotate handlers).
- `gateways.weight SMALLINT NOT NULL DEFAULT 100` (Phase 2 distributor
  weight; Phase 3.5 Kamailio dispatcher weight).
- `gateways.max_concurrent INT NULL` (per-gateway concurrency cap).
- `gateways.version INT NOT NULL DEFAULT 1`.
- `gateways.cost_per_min_cents INT NULL` (forward-compat; unused
  Phase 1).
- Migration retags pre-T02 `kind='telnyx'` rows by `register` (true →
  `telnyx-creds`, false → `telnyx-ip`).

### 14.6 To F03 (ACL + external profile)

- F03 ships `apply-inbound-acl="carriers"` on the external profile +
  empty `<list name="carriers" default="deny"/>` in `acl.conf.xml`.
- T02 populates the named-list via `acl-renderer.ts` (§5.3).
- F03's `.xml.tmpl` files at `freeswitch/conf/sip_profiles/external/*.tmpl`
  remain (env-substituted bootstrap); T02's runtime `.hbs` files at
  `freeswitch/conf/sip_profiles/external/templates/<kind>.hbs` override
  per-row.

### 14.7 To T01 (ESL bridge)

- T02 calls T01's `Api(fsHost, command)` for `killgw`, `rescan`, `status`
  primitives.
- T02 calls T01's `Reload(fsHost, "acl")` for `reloadacl`.
- T01 is responsible for serializing `api` calls per FS connection
  (per T01 PLAN §5).
- Multi-FS: T02 fans out `applyGatewayChange` to ALL healthy FS hosts
  (each runs its own `mod_sofia`). Phase 1 single-FS so simply targets
  `fsHost = healthyHosts()[0]`. Multi-FS hand-off in X03.

### 14.8 To O01 (observability)

Prometheus metrics emitted by T02:

| Metric | Type | Labels | Purpose |
|---|---|---|---|
| `vici2_carrier_health_status` | gauge | `tenant, gateway, carrier_kind, state` | 0/1 per gateway state |
| `vici2_carrier_active_calls` | gauge | `tenant, gateway, carrier_kind` | Live concurrency from Valkey counter |
| `vici2_carrier_options_ping_seconds` | histogram | `tenant, gateway, carrier_kind` (NHCB) | OPTIONS RTT |
| `vici2_carrier_ping_stuck_total` | counter | `gateway` | TLS ping-stuck watchdog fires |
| `vici2_carrier_counter_drift_total` | counter | `gateway, direction` (over/under) | Reconciler corrections |
| `vici2_carrier_rescan_total` | counter | `outcome=success|fail|locked` | Rescan attempts |
| `vici2_carrier_rotate_creds_total` | counter | `outcome=success|fail|verify_timeout` | Credential rotations |
| `vici2_carrier_render_duration_seconds` | histogram | `kind` | Template render perf |

### 14.9 To O05 (security baseline + runbooks)

- **KEK rotation runbook** (already authored by F05 §4.7) extends to
  cover carrier creds — no new runbook needed.
- **Carrier credential rotation runbook** (T02 HANDOFF.md):
  1. Operator generates new password at carrier portal.
  2. `POST /api/admin/carriers/:id/rotate-credentials { password: "..." }`
     with idempotency key.
  3. Verify `state == REGED` (or `Status == "UP (ping)"`) within 8 s.
  4. On failure: T02 auto-rolls back; check `audit_log WHERE
     action='auth.carrier.rotate_creds_failed'`; investigate; retry.
  5. Revoke old creds at carrier portal once rotation verified.
- **TLS ping-stuck watchdog runbook**: alert fires →
  check `vici2_carrier_ping_stuck_total` per gateway → manual
  `sofia profile external killgw + rescan` if watchdog ineffective.

### 14.10 To C03 (audit immutability)

T02 produces audit rows via F05's `audit()` writer:

| `action` | Severity | When |
|---|---|---|
| `carrier.created` | info | POST /carriers OK |
| `carrier.updated` | info | PUT /carriers/:id OK |
| `carrier.deleted` | warn | DELETE /carriers/:id OK |
| `carrier.rendered` | info | XML written + rescan succeeded |
| `carrier.reload_failed` | warn | rescan errored or status verify failed |
| `carrier.acl_reloaded` | info | acl.conf.xml regenerated + reloadacl succeeded |
| `carrier.health_state_changed` | warn | healthy ↔ down transition |
| `auth.carrier.cred_read` | warn | password decrypted (rotation step 3 or super_admin view) |
| `auth.carrier.rotate_creds` | warn | rotation TX committed |
| `auth.carrier.rotate_creds_failed` | warn | rotation rolled back |
| `gateway.created` / `.updated` / `.deleted` | info | per-gateway changes |
| `carrier.counter_drift_detected` | warn | reconciler corrected drift > 2 |

---

## 15. Resolved open questions (RESEARCH §10)

| # | Question | Resolution |
|---|---|---|
| 1 | One carrier row, N gateways, or one row each? | F02 split confirmed correct (carriers + gateways). |
| 2 | Phase-1 send PAI? | Default **on** for non-Bandwidth (T04 sets `sip_cid_type=pid`); manual injection for Bandwidth (`sip_cid_type=none + sip_h_P-Asserted-Identity`). Per-carrier opt-out via `carriers.send_pai BOOLEAN`. |
| 3 | STIR/SHAKEN signing in Phase 1? | **Delegated to carriers.** Twilio/Telnyx/SignalWire default A-attestation. Phase-2 Tiltx-style external signing for non-carrier-owned DIDs. |
| 4 | E911 model? | **Separate gateway entry** (kind='byoc' or 'bandwidth' tagged `is_emergency=true`); routed by dialplan destination match. Phase-2 enforcement of routing-correctness. |
| 5 | Branded calling? | Out of T02 scope; X05 module (per-DID registrations). `carriers.notes JSON` exposes operator memos. |
| 6 | Multi-FS gateway affinity? | Single-FS Phase 1; defer `gateways.fs_node_affinity` column to X03. |
| 7 | SNI / TLS-verify per-gateway override (SignalWire)? | **Yes** — per-gateway via `template_overrides.secure_only=true` + `tls-verify-policy` override. |
| 8 | Inbound DID assignment ownership? | Confirmed: `did_numbers` CRUD lives in I02 / M04, not T02. T02 surfaces "which DIDs land on which gateway" for dashboard read-only. |
| 9 | Cost-per-minute tracking? | Phase 2. `gateways.cost_per_min_cents INT NULL` column added now (forward-compat). |
| 10 | Super-admin global carriers (`tenant_id=NULL`)? | **Per-tenant Phase 1** (each tenant has own carrier row even pointing at same FQDN/creds). Phase-2 global carriers via `tenant_carrier_grants`. |

---

## 16. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **Cred rotation atomicity** — failure mid-rescan leaves FS in mixed state | Medium | High | `.bak` rollback on rescan fail + recovery rescan; audit `rotate_creds_failed`; in-memory backup of pre-change creds; alert via O01. |
| **Concurrent-call counter drift** (Valkey vs FS truth) | Medium | Low | 60-s reconciler corrects drift > 2; metric `vici2_carrier_counter_drift_total`. |
| **TLS ping-stuck bug** (signalwire/freeswitch#2489) | Low | Medium | Watchdog auto-`killgw + rescan`; metric `vici2_carrier_ping_stuck_total`; manual force-test endpoint. |
| **XML injection via carrier name/password** | Low | High | Handlebars `{{ }}` escapes by default; Zod validators (§3.4); test fixture verifies; CI grep for raw `Handlebars.SafeString`. |
| **Race between two admins editing same carrier** | Medium | Low | Optimistic concurrency via `version` column + 409 `CARRIER_VERSION_CONFLICT`. |
| **Single-flight lock crashes mid-rescan** | Low | Medium | 30-s TTL on Valkey lock; next request waits then proceeds. |
| **Bandwidth UDP-only constraint accidentally overridden** | Low | Medium | Validator warns; `template_overrides` with `transport != udp` for `kind=bandwidth` returns 400 unless `force=true` query param. |
| **Decrypt latency under burst** (rotation of many carriers) | Low | Low | F05's 30-s LRU cache of decrypted DEKs (F05 §4.6) covers this. |
| **Pre-T02 `kind='telnyx'` rows not migrated** | Low | High | F02 amendment migration explicitly retags by `register` flag; integration test verifies. |
| **Cleartext password on disk (Phase-1 compromise)** | High | Medium | Documented; `0640 root:freeswitch`; encrypted root volume; Phase-2 `mod_xml_curl` migration ticket. |

---

## 17. RFCs filed

**Zero RFCs filed by this PLAN.** All decisions derive from RESEARCH +
upstream PLAN constraints (F02, F03, F05, T01). The PLAN explicitly:

- **Amends F02 PLAN** (mechanical, §14.5): widens `carriers.kind` enum,
  adds `send_pai`, `is_emergency`, `max_concurrent`, `notes`, `version`
  on carriers; adds `weight`, `max_concurrent`, `version`,
  `cost_per_min_cents` on gateways.
- **Aligns with F03 PLAN** (§14.6): consumes the empty `carriers` named-list
  ACL; coexists with F03's bootstrap `.xml.tmpl` files.
- **Consumes F05 PLAN** unchanged (encryption helper, RBAC middleware,
  audit writer).
- **Consumes T01 PLAN** unchanged (ESL `Api`, `Reload`, `EnrichedEvent`
  consumer).

If during IMPLEMENT any of the F02 amendments meets pushback from F02
owner, RFC-T02-001 (carrier kind enum widen + new columns) is
pre-flagged as the natural landing spot.

---

## 18. Acceptance criteria (from T02.md, restated against this PLAN)

- [ ] All 8 `kind` templates render valid XML (`xmllint --noout` passes
      golden fixtures per kind).
- [ ] CRUD endpoints work + RBAC enforced (every route through
      `requirePermission('carrier:*')`).
- [ ] Live status visible in < 60 s of any state change (30-s poll +
      90-s cache).
- [ ] Rescan failure rolls back file change (`.bak` restored,
      `applyGatewayChange` re-run, throws `CARRIER_RELOAD_FAILED`).
- [ ] Encrypted-at-rest credentials via F05 envelope; never returned
      in API responses (passwords masked `***`).
- [ ] Audit log row for every create/update/delete/rotate/reload event
      (catalog §14.10).
- [ ] Soft delete removes XML file + `killgw` + `rescan`.
- [ ] OPTIONS test endpoint works (`POST /carriers/:id/test`).
- [ ] Concurrent-call counter increments/decrements correctly under
      load (integration test against real FS).
- [ ] Reconciler corrects counter drift within 60 s.
- [ ] TLS ping-stuck watchdog fires in regression test for
      signalwire/freeswitch#2489.
- [ ] All 8 carriers' templates manually verified against published
      vendor docs (RESEARCH cites [1]–[18]).
- [ ] OpenAPI schemas (`Carrier`, `Gateway`, `CarrierStatus`,
      `CarrierTestResult`) merged into `shared/openapi/openapi.yaml`.
- [ ] HANDOFF.md ships credential-rotation runbook + carrier-onboarding
      runbook + Phase-2 mod_xml_curl migration ticket.

---

End of PLAN.md.
