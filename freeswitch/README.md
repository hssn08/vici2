# vici2 FreeSWITCH (F03)

FreeSWITCH 1.10.12 base config for vici2 — three Sofia profiles (internal,
wss, external), mod_conference + mod_event_socket + mod_xml_curl, codec
policy tuned per profile, and a small dialplan that frozen-interfaces
T01 (ESL), T03 (agent conference), T04 (originate), R01 (recording), C02
(recording consent), F05 (directory), and I02 (DID inbound).

Authoritative spec: `/root/vici2/spec/modules/F03/PLAN.md`.

## Profiles

| Profile  | Port(s)               | Purpose                       | Auth                         |
|---       |---                    |---                            |---                           |
| internal | 5060/UDP+TCP          | Hardphones / desk phones      | digest (XML directory)       |
| wss      | 7443/TCP, 5066/TCP    | Browser softphone (SIP.js)    | digest + DTLS-SRTP mandatory |
| external | 5080/UDP+TCP          | Carriers / BYOC               | IP ACL `carriers` or register|

Conference profile name pattern (RFC-002 — HARD CONSTRAINT):
`agent_t<tenant_id>_u<user_id>@default`. The conference profile advertises
glob `agent_*@default`.

## Module allowlist

14 modules loaded — see `conf/autoload_configs/modules.conf.xml`. Explicitly
NOT loaded in Phase 1: mod_xml_rpc, mod_xml_cdr, mod_voicemail, mod_amd,
mod_callcenter, mod_avmd, mod_v8, mod_lua, mod_python3, mod_curl, mod_spandsp.

## Channel-variable conventions

| Var name              | Set by              | Consumed by         | Meaning                                    |
|---                    |---                  |---                  |---                                         |
| `vici2_tenant_id`     | dialplan / T04      | R01, T01, S02       | tenant the call belongs to (Phase 1 = 1)   |
| `vici2_user_id`       | dialplan / T04      | T03, R01, S02       | agent that owns the conference             |
| `vici2_role`          | dialplan / T04      | T01, S02            | `agent_leg`, `customer_leg`, `third_leg`   |
| `vici2_conf_name`     | dialplan / T04      | T01, S02            | full RFC-002 conf name                     |
| `vici2_campaign_id`   | T04                 | R01                 | populates recording path                   |
| `vici2_lead_id`       | T04                 | R01                 | populates recording path                   |
| `vici2_call_uuid`     | T04                 | R01, C02, C03       | per-call durability key                    |
| `vici2_consent_mode`  | T04 (from C02)      | dialplan, R01       | ALLOW/PROMPT_*/REQUIRE_ACTIVE/SKIP         |
| `vici2_consent_status`| dialplan (C02 ext)  | R01, C03            | not_required/prompted_*/declined/beep_only |
| `consent_record_enabled`| dialplan (C02 ext)| R01                 | gate flag for `record_session`             |

## Dialplan extension points

| File                                          | Owner | What it does                                         |
|---                                            |---    |---                                                   |
| `dialplan/default/00_safety.xml`              | F03   | Sets hangup_after_bridge, continue_on_fail, etc.     |
| `dialplan/default/01_agent_conference.xml`    | F03→T03 | `*9<tid>_<uid>` join + `conf_<tid>_<uid>` customer leg |
| `dialplan/default/02_outbound.xml`            | F03→T04 | Fallback carrier bridge for click-to-dial          |
| `dialplan/default/03_consent.xml`             | F03 (C02 ext) | 4 consent extensions per C02 RESEARCH §10.2 |
| `dialplan/default/99_features.xml`            | F03   | `*7` hold; reserves `*0-*9` for S02/A07              |
| `dialplan/public/10_*.xml`…`89_*.xml`         | I02   | DID inbound routes (number range frozen)             |
| `dialplan/public/99_drop_unauthenticated.xml` | F03   | Catchall 503 for unmatched public traffic            |

## Recording path convention (R01 contract)

```
/var/lib/freeswitch/recordings/<tenant_id>/<YYYY>/<MM>/<DD>/<campaign_id>_<lead_id>_<call_uuid>.wav
```

Set on the customer leg by T03/T04 (`RECORD_STEREO=true`, `RECORD_MIN_SEC=2`,
`recording_follow_transfer=true`). R01 issues `bgapi uuid_record start` only
when `consent_record_enabled=true` and `vici2_consent_status` is set.

## Dev quickstart

1. Install mkcert on host and run `mkcert -install` once.
2. `./scripts/gen-dev-cert.sh` to create `tls/wss.pem`.
3. Populate `.env` with at least `SIGNALWIRE_TOKEN` and
   `FS_EVENT_SOCKET_PASSWORD`.
4. `docker compose -f docker-compose.dev.yml up freeswitch -d`
5. Probe: `docker compose exec freeswitch fs_cli -p "$FS_EVENT_SOCKET_PASSWORD" -x 'sofia status'`
6. ESL smoke test from host: `./tests/esl/status_check.sh 127.0.0.1:8021`

## Cert rotation (prod)

```bash
cat /etc/letsencrypt/live/fs.<domain>/fullchain.pem \
    /etc/letsencrypt/live/fs.<domain>/privkey.pem \
    > /etc/freeswitch/tls/wss.pem
chown freeswitch:freeswitch /etc/freeswitch/tls/wss.pem
chmod 600 /etc/freeswitch/tls/wss.pem
fs_cli -p "$FS_EVENT_SOCKET_PASSWORD" -x 'sofia profile wss restart'
```

`rescan` is NOT sufficient — sofia-sip cannot hot-reload TLS bindings. The
restart drops only WSS-connected clients (SIP.js auto-reconnects in <5s);
internal hardphones unaffected, justifying the 3-profile split.

## Host kernel tuning (operator runs once)

`/etc/sysctl.d/99-freeswitch.conf` — see F03 PLAN §11.3.
`/etc/security/limits.conf` — `nofile 1048576`, `nproc 65535`.

## Verification checks

```bash
# 1. Build
docker compose -f docker-compose.dev.yml build freeswitch

# 2. Boot
docker compose -f docker-compose.dev.yml up -d freeswitch

# 3. Sofia 3-profile RUNNING
docker compose exec freeswitch fs_cli -p "$FS_EVENT_SOCKET_PASSWORD" -x 'sofia status'

# 4. Module list
docker compose exec freeswitch fs_cli -p "$FS_EVENT_SOCKET_PASSWORD" -x 'show modules' | grep -E 'mod_conference|mod_event_socket|mod_xml_curl'

# 5. ESL reachable from host
nc 127.0.0.1 8021 < /dev/null

# 6. WSS port listening
ss -tnlp | grep 7443
```
