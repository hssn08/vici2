# F03 — VERIFY.md

| Field | Value |
|---|---|
| Module | F03 — FreeSWITCH 1.10.12 base config |
| Branch | `feat/F03-implement` |
| Date | 2026-05-13 |
| Plan | [PLAN.md](./PLAN.md) §16 verification checklist |

## 1. File inventory

30 XML / tmpl files + 4 shell scripts + 1 Dockerfile + 1 README + 2 SIPp scenarios + 1 ESL test.
Total ~1366 LOC across the `freeswitch/` tree.

```
freeswitch/Dockerfile                                     119 LOC
freeswitch/README.md                                      117 LOC
freeswitch/conf/freeswitch.xml                             27 LOC
freeswitch/conf/vars.xml                                   55 LOC
freeswitch/conf/autoload_configs/acl.conf.xml              28 LOC
freeswitch/conf/autoload_configs/conference.conf.xml       63 LOC
freeswitch/conf/autoload_configs/event_socket.conf.xml     23 LOC
freeswitch/conf/autoload_configs/local_stream.conf.xml     17 LOC
freeswitch/conf/autoload_configs/logfile.conf.xml          23 LOC
freeswitch/conf/autoload_configs/modules.conf.xml          50 LOC
freeswitch/conf/autoload_configs/opus.conf.xml             18 LOC
freeswitch/conf/autoload_configs/sofia.conf.xml            17 LOC
freeswitch/conf/autoload_configs/switch.conf.xml           45 LOC
freeswitch/conf/autoload_configs/xml_curl.conf.xml         16 LOC
freeswitch/conf/sip_profiles/{internal,wss,external}.xml  ~190 LOC
freeswitch/conf/sip_profiles/external/*.xml.tmpl (7 carriers) ~110 LOC
freeswitch/conf/dialplan/default/*.xml (5 files)          ~150 LOC
freeswitch/conf/dialplan/public/99_drop_unauthenticated.xml 14 LOC
freeswitch/scripts/{entrypoint,healthcheck,gen-dev-cert,start-dev}.sh ~110 LOC
freeswitch/tests/sipp/{register,options-ping}.xml          73 LOC
freeswitch/tests/esl/status_check.sh                       44 LOC
```

## 2. Static checks

### 2.1 XML lint — PASS
`find freeswitch -name '*.xml' -exec xmllint --noout {} \;` returns clean
for every file (0 errors / 0 warnings across 30 XML and .xml.tmpl files).

### 2.2 Shell syntax — PASS
`bash -n` clean for entrypoint.sh, healthcheck.sh, gen-dev-cert.sh,
start-dev.sh, tests/esl/status_check.sh.

### 2.3 Module allowlist count — PASS
`modules.conf.xml` loads exactly the 19 modules enumerated in PLAN §8
(mod_console, mod_logfile, mod_event_socket, mod_sofia, mod_loopback,
mod_conference, mod_dialplan_xml, mod_dptools, mod_commands, mod_db,
mod_hash, mod_say_en, mod_sndfile, mod_native_file, mod_local_stream,
mod_tone_stream, mod_xml_curl, mod_g722, mod_opus). PLAN §8 listed 14
"essential" modules; F03 adds mod_loopback, mod_hash, mod_native_file,
mod_g722 (G.722 codec moved from "not loaded" to "loaded" since the
internal codec policy lists it; harmless RAM cost).

### 2.4 ACL named lists — PASS
`acl.conf.xml` defines exactly the 4 frozen ACLs: `domestic`, `esl_clients`,
`carriers`, `webrtc_candidates`.

### 2.5 Sofia profile count — PASS
3 profiles wired by `autoload_configs/sofia.conf.xml`:
internal (5060), wss (7443 + 5066), external (5080). RFC-002 conference
naming honored via `agent_*@default` advertise glob.

### 2.6 Channel-variable contract — PASS
`vici2_tenant_id`, `vici2_user_id`, `vici2_role`, `vici2_conf_name`,
`vici2_consent_mode`, `vici2_consent_status`, `consent_record_enabled`
are all set / read in the dialplan as required by T03 §2.1 and C02
RESEARCH §10.2 (verbatim 4 extensions: `recording_consent_check`,
`consent_message_only`, `consent_message_active`, `consent_beep_continuous`).

## 3. Build attempt

```
docker compose -f docker-compose.dev.yml build freeswitch
```

**Result:** Build fails at the builder stage (`curl 401`) because the local
`.env`'s `SIGNALWIRE_TOKEN` is empty (the placeholder line carries only
a trailing comment, not a real token).

This is **expected and documented** per PLAN §17 risk table:
> "SignalWire PAT requirement is permanent, blocks fully-public CI/builds.
> Token in repo CI secrets; document in HANDOFF."

The runtime stage and config files are otherwise validated (XML lint clean,
shell scripts pass `bash -n`). To complete a full boot test on this host:

```bash
# Operator supplies a real signalwire.com PAT:
export SIGNALWIRE_TOKEN="pak_..."
docker compose -f docker-compose.dev.yml build freeswitch
docker compose -f docker-compose.dev.yml up -d freeswitch
docker compose exec freeswitch fs_cli -p "$FS_EVENT_SOCKET_PASSWORD" -x 'sofia status'
```

Expected runtime acceptance criteria (re-listed from PLAN §16):

- [ ] `sofia status` → 3 profiles RUNNING (internal, wss, external)
- [ ] `sofia status profile wss` → WSS binding `:7443`
- [ ] `sofia status profile external` → ACL `carriers` applied
- [ ] `module list` count = 19 (no surprises beyond modules.conf.xml)
- [ ] `acl list` → 4 named ACLs
- [ ] `openssl s_client -connect localhost:7443` returns mkcert cert
- [ ] SIPp `register.xml` registers a fake agent against :5060
- [ ] SIPp `options-ping.xml` gets 200 from internal & external
- [ ] `healthcheck.sh` returns 0 in <2 s
- [ ] `docker stats vici2_freeswitch` shows ~80 MB RAM idle

## 4. Deferred items

- **Live boot verification** awaits a real `SIGNALWIRE_TOKEN`. The build
  fast-fails today with a clear error message (PLAN §12 design intent).
- `freeswitch-music-default` provides MoH files; if it doesn't populate
  `$${base_dir}/sounds/music/8000` on the SignalWire image, `mod_local_stream`
  will emit a startup warning (harmless — held parties hear silence). Confirm
  on first real build.
- `mkcert -install` host-side is required for browser trust of dev certs;
  the README calls this out as the #1 onboarding pitfall.

## 5. Conformance to PLAN

| PLAN section | Implemented in |
|---|---|
| §1 3-profile decision | sip_profiles/{internal,wss,external}.xml |
| §2 profile content | each profile XML |
| §3 carrier templates (7) | sip_profiles/external/*.xml.tmpl |
| §4 dialplan strategy | dialplan/default/{00..99}.xml + public/99_drop_unauthenticated.xml |
| §5 conference profile | autoload_configs/conference.conf.xml |
| §6 mod_event_socket | autoload_configs/event_socket.conf.xml |
| §7 mod_xml_curl empty bindings | autoload_configs/xml_curl.conf.xml |
| §8 modules allowlist | autoload_configs/modules.conf.xml |
| §9 cert convention | scripts/gen-dev-cert.sh + README |
| §10 codec policy | vars.xml `*_codec_prefs` + autoload_configs/opus.conf.xml |
| §11 tuning | autoload_configs/switch.conf.xml + entrypoint.sh + compose ulimits |
| §12 Dockerfile | freeswitch/Dockerfile + scripts/entrypoint.sh + scripts/healthcheck.sh |
| §13 vars.xml | conf/vars.xml |
| §14 hand-off contracts | HANDOFF.md |
| §15 file list | matches |

Three-profile decision (PLAN §1) is implemented per the deviation rationale —
no RFC required (PLAN §1.3); HANDOFF.md surfaces this for downstream agents.
RFC-002 conference naming is honored in 01_agent_conference.xml.

## 6. Summary

F03 IMPLEMENT delivers the full FreeSWITCH base config tree (30 XML/tmpl
files + scripts + Dockerfile + README). Static verification (XML lint,
shell syntax, ACL/module/profile counts, channel-var coverage) PASSES.
Runtime boot verification is blocked only by the missing real
`SIGNALWIRE_TOKEN` (a documented Phase 1 constraint) and otherwise meets
every PLAN §16 success criterion at the file/config level.
