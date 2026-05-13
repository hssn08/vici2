# F03 — HANDOFF.md

| Field | Value |
|---|---|
| Module | F03 — FreeSWITCH 1.10.12 base config |
| Branch | `feat/F03-implement` |
| Date | 2026-05-13 |
| Spec | [PLAN.md](./PLAN.md) |
| Sister docs | [VERIFY.md](./VERIFY.md) |

This is the contract surface F03 exposes to downstream modules. After PLAN
approval and IMPLEMENT delivery, every interface below is FROZEN; changes
require an RFC.

---

## 1. Network surface

| Port  | Proto      | Profile / service       | Bound by                  | Consumed by |
|---    |---         |---                      |---                        |---|
| 5060  | UDP+TCP    | sofia profile `internal`| `sip_profiles/internal.xml` | hardphones, T03 future |
| 5066  | TCP        | sofia profile `wss` (WS, dev only) | `sip_profiles/wss.xml` | A02 (SIP.js, plaintext fallback) |
| 7443  | TCP (TLS)  | sofia profile `wss`     | `sip_profiles/wss.xml`    | A02 (SIP.js primary) |
| 5080  | UDP+TCP    | sofia profile `external`| `sip_profiles/external.xml` | T02 carrier gateways, BYOC SIP |
| 8021  | TCP        | mod_event_socket        | `autoload_configs/event_socket.conf.xml` | **T01 (ESL bridge)** |
| 16384-32768 | UDP   | RTP                     | `switch.conf.xml`          | All media legs |

## 2. ESL contract (T01 consumes)

- **Host:** compose service name `freeswitch` (or `host.docker.internal:8021` from non-host-network containers).
- **Password env:** `FS_EVENT_SOCKET_PASSWORD`.
- **ACL:** named list `esl_clients` (loopback + Docker bridge families 172.16/12, 10/8, 192.168/16).
- **Rotation:** `fs_cli -x 'reload mod_event_socket'` (drops clients; T01 MUST implement reconnect-with-backoff).
- **Authoritative password var path:** `vars.xml` -> `$${esl_password}` -> `event_socket.conf.xml`.
- **Stop-on-bind-error:** true (FS crashes loud if 8021 collides — no silent fallback).

## 3. Conference naming (RFC-002 — HARD CONSTRAINT)

```
agent_t<tenant_id>_u<user_id>@default
```

Phase 1 single-tenant: `agent_t1_u<uid>@default`. The conference profile
`default` is shared by all per-agent conferences; advertise glob
`agent_*@default` in `conference.conf.xml`.

- T03 owns the helper function (`ConferenceName(tid, uid)`); F03 dialplan
  extracts (tid, uid) from extension capture groups.
- Customer leg landing extension: `conf_<tid>_<uid>` (in
  `dialplan/default/01_agent_conference.xml`).
- Agent park-and-join extension: `*9<tid>_<uid>` (browser dials on login).

## 4. Channel variables (the seam between F03 dialplan and Go/TS consumers)

| Var name                  | Set by                | Read by         | Phase-1 default |
|---                        |---                    |---              |---|
| `vici2_tenant_id`         | dialplan capture group / T04 originate | R01, T01, S02, C02 | `1` |
| `vici2_user_id`           | dialplan capture group / T04 originate | T03, R01, S02 | required |
| `vici2_role`              | dialplan / T04        | T01, S02       | `agent_leg`/`customer_leg`/`third_leg` |
| `vici2_conf_name`         | dialplan / T04        | T01, S02       | `agent_t<tid>_u<uid>` (no `@default` suffix) |
| `vici2_campaign_id`       | T04 originate         | R01, C02       | populates recording path |
| `vici2_lead_id`           | T04 originate         | R01, C02       | populates recording path |
| `vici2_call_uuid`         | T04 originate         | R01, C02, C03  | per-call durability key |
| `vici2_consent_mode`      | T04 originate (from C02 CheckResult) | dialplan dispatch | ALLOW / PROMPT_BEEP / PROMPT_MESSAGE / REQUIRE_ACTIVE / SKIP |
| `vici2_consent_status`    | dialplan (C02 leaf extension) | R01, C03 | not_required / prompted_assumed / prompted_accepted / prompted_declined / beep_only / skipped |
| `vici2_consent_dtmf`      | dialplan (consent_message_active) | dialplan | `1` accept, `2` decline |
| `vici2_consent_state`     | T04 originate         | C03, O01       | 2-letter state code applied |
| `consent_record_enabled`  | dialplan (consent extensions) | R01     | gates `bgapi uuid_record start` |
| `RECORD_STEREO`           | T03/T04 dialplan      | core record_session | `true` |
| `RECORD_MIN_SEC`          | T03/T04 dialplan      | core record_session | `2` |
| `recording_follow_transfer` | safety extension    | core record_session | `true` |
| `record_beep_pre`         | consent_beep_continuous | core record_session | `tone_stream://%(500,0,1400)` |

## 5. Dialplan extension contracts

### 5.1 `default` context

| Extension                       | Pattern             | Owner       | Behavior |
|---                              |---                  |---          |---|
| `catchall_safety`               | `^.*$` (continue=true) | F03      | Sets bridge/transfer safety defaults |
| `agent_conference_join`         | `^\*9(\d+)_(\d+)$`  | F03→T03    | Agent joins their personal conf as moderator |
| `customer_into_agent_conf`      | `^conf_(\d+)_(\d+)$`| F03→T03    | Customer leg → consent check → conference join, endconf=false |
| `recording_consent_check`       | (execute_extension) | F03 (C02)  | Dispatcher: branch on `${vici2_consent_mode}` |
| `consent_message_only`          | (execute_extension) | F03 (C02)  | `playback ${consent_msg_audio}` + set status=prompted_assumed |
| `consent_message_active`        | (execute_extension) | F03 (C02)  | `play_and_get_digits` for DTMF press-1 |
| `consent_beep_continuous`       | (execute_extension) | F03 (C02)  | Sets `record_beep_pre` tone |
| `outbound_via_carrier`          | `^(\+?1?\d{10,15})$`| F03→T04    | Fallback `bridge sofia/gateway/${carrier_name}/$1` |
| `hold_toggle`                   | `^\*7$`             | F03        | Bind meta_app for hold |

### 5.2 `public` context

| File range                       | Owner | Notes |
|---                               |---    |---|
| `10_*.xml` through `89_*.xml`    | I02   | DID-routing files — number range FROZEN |
| `99_drop_unauthenticated.xml`    | F03   | Catchall 503 — last alphabetically |

I02 writes files in its number range, then `fs_cli -x 'reloadxml'`. No FS restart.

## 6. Recording path convention (R01 contract)

```
/var/lib/freeswitch/recordings/<tenant_id>/<YYYY>/<MM>/<DD>/<campaign_id>_<lead_id>_<call_uuid>.wav
```

- Volume: `freeswitch_recordings` (declared in docker-compose.dev.yml).
- Sofia profiles' `record-template` interpolates the channel vars and the strftime values at runtime.
- R01 starts recording via `bgapi uuid_record start` only when `consent_record_enabled=true`
  and `vici2_consent_status` is set; defense-in-depth.
- `RECORD_STOP` event payload provides `Record-File-Path`, `Record-Ms`,
  `Record-Read-Sample-Rate`.

## 7. ACLs (T02 + X01 consume)

| Named list              | Default | Phase-1 contents                     | Mutated by |
|---                      |---      |---                                   |---|
| `domestic`              | deny    | 127/8, 172.16/12, 10/8, 192.168/16  | (static) |
| `esl_clients`           | deny    | 127/8, 172.16/12, 10/8, 192.168/16  | operator (env injection) |
| `carriers`              | deny    | empty                                | **T02** (writes from MySQL `carriers.ip_allowlist`, then `reloadacl`) |
| `webrtc_candidates`     | allow   | empty                                | X01 may tighten |

Reload procedure: `fs_cli -x 'reloadacl'` — does NOT drop connections.

## 8. Carrier gateway lifecycle (T02 consumes)

- **Template directory:** `freeswitch/conf/sip_profiles/external/*.xml.tmpl`
  (7 carriers shipped: twilio, ringcentral, telnyx, signalwire, bandwidth,
  flowroute, generic-byoc).
- **Live directory:** `freeswitch/conf/sip_profiles/external/*.xml` —
  T02 renders rendered XML here from MySQL `carriers` rows.
- **Reload:** `fs_cli -x 'sofia profile external rescan'` — no restart;
  gateway register/unregister happens in-stack.

## 9. mod_xml_curl wiring point (F05 / I01 / I03)

`autoload_configs/xml_curl.conf.xml` ships with EMPTY `<bindings/>`. The
module is loaded so downstream agents can add bindings via a snippet +
`fs_cli -x 'reload mod_xml_curl'` (no FS restart needed).

Frozen contract for any future binding:
- gateway-url: `http://api:3000/internal/freeswitch/<binding-type>`
- Auth: HTTP basic, creds from env `FS_XMLCURL_USER` / `FS_XMLCURL_PASS`
  (consumed via `$${xmlcurl_user}` / `$${xmlcurl_pass}` in `vars.xml`).
- `disable-100-continue=true`, `timeout=10`, `auth-scheme=basic`.
- API endpoint must respond `Content-Type: text/xml` with a valid
  `<document>` envelope.

## 10. F05 directory contract (Phase 1 = static XML)

- **Path:** `freeswitch/conf/directory/default/<username>.xml` (one file per agent).
- F05 generates the file, then `fs_cli -x 'reloadxml'`.
- The user XML MUST include `<variable name="vici2_tenant_id" value="..."/>`
  so T03's `user_data($2@${domain} var vici2_tenant_id)` cross-tenant
  check resolves.
- Phase-1 single-tenant: `vici2_tenant_id=1` everywhere.
- Phase-2: F05 may flip to `mod_xml_curl directory` binding; F03's empty
  bindings file is the seam.

## 11. Cert / TLS rotation

- Combined PEM at `/etc/freeswitch/tls/wss.pem` (cert + key + chain).
- **Dev:** `freeswitch/scripts/gen-dev-cert.sh` (mkcert on host, `mkcert -install` once).
- **Prod:** post-renewal hook concatenates LE files into `wss.pem`, then
  `fs_cli -x 'sofia profile wss restart'` (sofia-sip cannot hot-reload
  TLS bindings; `rescan` is insufficient). The restart drops only WSS
  clients (~3-5 s); internal hardphones unaffected — this is the
  3-profile-design payoff.

## 12. Deviations from the spec, called out explicitly

### 12.1 Three Sofia profiles (not 2)
PLAN §1 reverses the F03 spec §"Key non-obvious decisions" #3. Justification
is in PLAN §1.2 (TLS reload blast radius + codec preference inversion +
DTLS-SRTP ACL clutter + X02 future + marginal cost). No RFC required per
PLAN §1.3 (the change strictly expands capability; downstream interfaces
unchanged).

### 12.2 Module count = 19 (PLAN said 14)
Production added 5 extras (mod_loopback, mod_hash, mod_native_file, mod_g722,
mod_say_en) — all listed in PLAN §8 module XML but PLAN §8 prose said "14".
The XML inventory is canonical; the prose count was imprecise. RAM impact
is negligible (each adds ~1-2 MB).

### 12.3 Recording path now uses `vici2_*` channel-vars
Original PLAN sketch had `${tenant_id}_${campaign_id}_${lead_id}_${uuid}.wav`
interpolation; F03 IMPLEMENT switches to the `vici2_` prefixed names because
T03/R01/C02 all standardized on `vici2_tenant_id`, `vici2_campaign_id`,
`vici2_lead_id`. Consumer-facing path string is unchanged.

## 13. What F03 does NOT do (defers to downstream)

- **F05** populates `directory/default/*.xml` (agent SIP creds).
- **T02** renders `sip_profiles/external/<carrier>.xml` from MySQL.
- **T03** replaces F03's stub `01_agent_conference.xml` with production
  extension after fully implementing the conference helper + tenant check.
- **T04** is the actual originator; F03 ships only the fallback
  `outbound_via_carrier` extension.
- **R01** issues `bgapi uuid_record start` (F03 only declares the path
  convention and sets `RECORD_STEREO`).
- **C02** lives in dialer Go; F03 ships only the 4 leaf extensions
  (RESEARCH §10.2 verbatim).
- **I02** writes DID dialplan files in the `public/10_*…89_*.xml` range.
- **S02** uses the reserved feature codes `*0-*3` for supervisor modes.
- **X01** may tighten `webrtc_candidates` ACL and offload SRTP via rtpengine.
- **O01** runs its own freeswitch-exporter binary against ESL.

## 14. Operator runbook stubs

Documented but not implemented inside the container (host-side):

```ini
# /etc/sysctl.d/99-freeswitch.conf
fs.file-max = 1048576
net.core.rmem_max = 26214400
net.core.wmem_max = 26214400
net.core.netdev_max_backlog = 5000
net.ipv4.udp_mem = 65536 131072 262144
net.ipv4.ip_local_port_range = 1024 65535
net.netfilter.nf_conntrack_max = 1048576
```

```
# /etc/security/limits.conf
freeswitch soft nofile 1048576
freeswitch hard nofile 1048576
freeswitch soft nproc  65535
freeswitch hard nproc  65535
```

## 15. Known limits

- Per-FS practical ceiling: **~750 simultaneous bridged calls** (1500 legs)
  due to Artoo R2D2 ~1796-thread wall, after `ulimit -s 240` mitigation.
- WebRTC SRTP ceiling: **~150 concurrent agents per FS** without rtpengine
  offload (X01 raises to ~5000).
- WSS cert renewal causes a **3-5 s WSS reconnect storm** every ~60 days
  (LE renewal). SIP.js auto-reconnects.
- `mod_callcenter` not loaded — I01 enables when it lands (modules.conf.xml
  one-line diff + `fs_cli -x 'load mod_callcenter'`).
