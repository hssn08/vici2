# Module F03 — RESEARCH

**Status:** RESEARCH (no PLAN, no code).
**Author:** F03 sub-agent
**Date:** 2026-05-06

Scope: FreeSWITCH 1.10.x base configuration for vici2 — Sofia profiles (internal+external+wss), dialplan philosophy, mod_conference profile for conference-per-agent, mod_event_socket inbound, mod_xml_curl, recording paths, codec strategy, performance tuning, scale ceilings.

---

## 1. Executive summary (10 bullets)

1. **Pin to FreeSWITCH 1.10.12** (released 2024-08-02; the current and last 1.10.x release as of mid-2026). Debian 12 Bookworm is fully supported via SignalWire's `freeswitch.signalwire.com/repo/deb/debian-release/` repo, which **requires a SignalWire Personal Access Token (PAT)**. No package exists on stock Debian — token is mandatory and must be threaded through CI.
2. **Three Sofia profiles, not two.** DESIGN.md §4.2 and the F03 module spec collapse internal+WSS onto one profile listening on 5060/UDP and 7443/WSS. **Reality is fine that way for a small site, but production should split**: a dedicated `wss` profile cleanly isolates DTLS-SRTP cert reload from agent SIP, and isolates browser-codec (OPUS) from carrier-codec (PCMU) negotiation. Recommend `internal` (5060 UDP/TCP, optional hardphones), `wss` (7443 WSS + 5066 WS), `external` (5080 carriers).
3. **mod_conference is the only conference module shipping in 1.10.x.** `mod_conference_legacy` is **not present in 1.10** (it was a transitional alias around 1.6/1.8 — by 1.10 the legacy code is gone and the current `mod_conference` *is* what supersedes the old confbridge/legacy split). No migration concern. The agent-conference primitive maps cleanly: `conference $agent_id@default+flags{moderator}`.
4. **mod_xml_rpc is deprecated and insecure** (HTTP only, no TLS, abyss webserver is unmaintained, default creds are `freeswitch/works`). **Do not load it.** All control goes through mod_event_socket (ESL) on 8021/TCP with password+ACL. Phase 1 spec correctly omits it.
5. **mod_xml_curl is loaded but its bindings are not wired up in Phase 1.** F03 module spec §"Key non-obvious decisions" #8 says "No mod_xml_curl in Phase 1." DESIGN §4.4 says we use it. Reconciling: load the module so the binding can be activated by I03/I01 later without an FS restart, but ship `xml_curl.conf.xml` with empty `<bindings/>` in F03. Static dialplan + static directory carry MVP.
6. **mod_callcenter is loaded but unused in Phase 1.** Conference-per-agent is the SACRED primitive (SPEC §4.4); mod_callcenter is reserved for I01 inbound queues. Document the rationale prominently so a downstream agent doesn't "fix" it by routing outbound through callcenter.
7. **The Artoo R2D2 thread wall is real and confirmed.** GH issue signalwire/freeswitch#1729 (2022) shows `switch_thread_create()` failing around ~1796–1800 sessions even on c5.9xlarge with full ulimits, RAM disk, and 20k RTP ports — Artoo silently drops `max_sessions` to ~1796 to "save the switch from certain doom." This is a **per-process** threading-stack constraint; ulimits help but do not eliminate it. Plan multi-FS sharding (X02/X03) once a single instance is sized for >~1500 concurrent legs (allowing 2 legs per agent call = ~750 simultaneous bridged calls).
8. **WebRTC OPUS is ~5–8× more CPU-intensive than PCMU**, and SRTP/DTLS adds further overhead. Mailing-list and SignalWire benchmarks suggest **~150 concurrent WebRTC SRTP calls per 8-core box** is a realistic ceiling without rtpengine offload (X01) or careful transcoding management. Mitigation: configure `internal` profile so agent legs negotiate OPUS direct to browser, but customer-leg PCMU never transcodes — `bridge` between PCMU customer and OPUS agent is unavoidable and is the actual cost driver.
9. **Single combined PEM is the WSS cert convention.** FreeSWITCH expects `/etc/freeswitch/tls/wss.pem` to contain cert + key + chain in one file (and symlinks `agent.pem`, `tls.pem`, `dtls-srtp.pem` typically point to the same file). Self-signed via mkcert for dev; Let's Encrypt fullchain.pem + privkey.pem concatenated for prod. Cert reload is "sofia profile <name> rescan" — no FS restart needed if the file changes in-place.
10. **Carrier patterns split cleanly into two shapes.** **No-register / IP-auth**: Twilio Elastic SIP, Bandwidth, Flowroute (most). **Register**: RingCentral (per-DID register), Telnyx credentials trunk (optional), some smaller wholesale carriers. Both fit one XML template under `sip_profiles/external/`; the `register=true|false` flag is the only meaningful axis. Dialplan side: outbound = `sofia/gateway/<name>/+1NXXNXXXXXX`. Inbound auth for IP carriers requires populating `acl.conf.xml` with carrier edge IPs.

---

## 2. Version + install strategy

### 2.1 Version pin

- **FreeSWITCH 1.10.12** (released 2024-08-02 via signalwire/freeswitch GitHub release [1]).
- 1.10.12 is the **latest** 1.10.x as of 2026-05; SignalWire's commercial focus has shifted to FreeSWITCH Enterprise, but 1.10.x continues to receive critical-only fixes. We pin and freeze; we do not auto-track HEAD.
- **Why not master/1.11+?** No stable LTS designation; ABI churn for mod_conference and mod_sofia in master; no public-repo package builds. We are not paying for FSE in Phase 1.

### 2.2 Distribution & repo

- **Debian 12 Bookworm AMD64** is the target host OS. (Debian 11 Bullseye also supported by 1.10.12; we standardize on 12.) ARM64 is supported by 1.10.12 [1] but not in scope for vici2 Phase 1.
- **SignalWire repo** (`https://freeswitch.signalwire.com/repo/deb/debian-release/`). Requires SignalWire PAT (free for community use; created at signalwire.com per their HOWTO [4]). The token goes in `/etc/apt/auth.conf` and as the keyring fetch credential.
- **Dockerfile strategy**: multi-stage, base on `debian:bookworm-slim`, pass `SIGNALWIRE_TOKEN` as a build secret (`--mount=type=secret`), install `freeswitch-meta-all` or our pruned subset, do NOT bake the token into a layer. SignalWire's official `signalwire/freeswitch` image on Docker Hub is **not** automatically updated and historically lags releases — we build our own image.
- **`freeswitch-meta-all`** pulls in everything; our Dockerfile installs only what we use (see §3.3). Uninstall `mod_xml_rpc` package, `mod_voicemail` (until I05), `mod_amd` (we use mod_avmd), `mod_v8` (no JS), `mod_lua` (no Lua scripts in Phase 1), `mod_python3`, `mod_xml_cdr` (we use ESL for CDR-style events).

### 2.3 Breaking changes 1.8 → 1.10 (cumulative) [2]

- 1.8 → 1.10.0: `mod_pgsql` split out of core. Must be loaded from `pre_load_modules.conf.xml` not `modules.conf.xml`. **Not relevant to us — we use MySQL via the API service, not directly from FS.**
- 1.10.3 → 1.10.4: SpanDSP and sofia-sip removed from tree (now external dependencies, packaged separately by SignalWire). **Transparent if installing from packages.**
- 1.10.6 → 1.10.7: SRTP error → **no longer hangup by default** (was: hangup; now: log+continue); `1000 reqs/sec` cap added in mod_sofia; auth-messages and auth-subscriptions enabled by default; freeswitch.log line prefix changed (breaks fail2ban regexes pre-3143). **F03 implication**: O05 fail2ban rules must use the new prefix; document.
- 1.10.9 → 1.10.10: switch_curl ABI change (`switch_curl_process_form_post_params` removed → `switch_curl_process_mime`). Affects custom mod authors; not us.
- **No deprecation of mod_conference, mod_event_socket, mod_xml_curl, mod_sofia, mod_callcenter, or mod_avmd in 1.10.x.**

### 2.4 mod_conference_legacy — clarification

The DESIGN.md and the briefing reference "mod_conference_legacy replaced by mod_conference." In FreeSWITCH 1.10.x there is **only `mod_conference`** in `src/mod/applications/mod_conference/`. The "legacy" naming belonged to 1.6 when the new mod_conference (with video MCU) was introduced alongside an older variant; by 1.8 the merge was complete and by 1.10 there is no separate legacy module. **No deprecation surprise** — just outdated wording in some docs.

---

## 3. Sofia profile architecture

### 3.1 Three-profile design (recommended; deviates from F03 module spec §"Key non-obvious decisions" #3)

| Profile | Port(s) | Purpose | Auth | NAT |
|---|---|---|---|---|
| `internal` | 5060/UDP+TCP | Optional hardphone agents (back-room desk phones) and internal-only SIP devices | `auth-calls=true` against directory | `apply-nat-acl=nat.auto`; `local-network-acl=localnet.auto` |
| `wss` | 7443/TCP (WSS) + 5066/TCP (WS, dev only) | Browser SIP.js softphones (the primary agent device) | `auth-calls=true`; sip_password from F05 directory | `ext-rtp-ip=auto-nat` or static public IP; DTLS-SRTP mandatory for WSS |
| `external` | 5080/UDP+TCP | Carrier gateways (BYOC: Twilio, Telnyx, RingCentral, Bandwidth, Flowroute, SignalWire) | Per-gateway register or IP-auth via `acl.conf.xml` | `ext-sip-ip` and `ext-rtp-ip` set to public IP (autonat or static) |

**Rationale for splitting `wss` from `internal`:**
- Cert reload affects only the WSS profile; agent hardphones don't drop.
- Codec preferences differ: `wss` advertises `OPUS,PCMU,PCMA`; `internal` advertises `PCMU,PCMA,OPUS`. (OPUS first only where browsers are; otherwise prefer the cheap codec.)
- DTLS fingerprint and `apply-candidate-acl` are WSS-specific clutter that doesn't belong in the hardphone profile.
- Future scale (X02 Kamailio): WSS terminates at FS, but hardphones could be dispatched via Kamailio differently.

**However** — F03 module spec §"Key non-obvious decisions" #3 says collapse onto one `internal` profile. **PLAN phase decision needed**: do we deviate from the module spec (3 profiles) or follow it (2 profiles, internal serves WSS too)? The 2-profile path is FreeSWITCH-vanilla-default and well-trodden; sample configs from SignalWire, Klutch, FS-PBX, Packt all use it. The 3-profile path is cleaner for production but adds a sip_profiles file and one binding port. **Open question for PLAN — flag for human/lead review.** My recommendation: 2 profiles for Phase 1 (matches spec, less surface), revisit in X02.

### 3.2 Internal profile parameters (Phase 1, 2-profile model)

Key params (from SignalWire vanilla + WebRTC docs [5][6]):
- `sip-port=5060`, `tls-sip-port=5061` (TLS for SIP-over-TLS hardphones; optional, off in dev)
- `wss-binding=:7443`, `ws-binding=:5066` (5066 dev only, gated behind compose env var)
- `tls-cert-dir=$${certs_dir}` (`/etc/freeswitch/tls`), expects `wss.pem`, `agent.pem`, `cafile.pem`
- `auth-calls=true`, `accept-blind-reg=false`, `accept-blind-auth=false`
- `apply-nat-acl=nat.auto`, `local-network-acl=localnet.auto`
- `ext-rtp-ip=auto-nat` (dev) / explicit public IP (prod, set in vars.xml)
- `ext-sip-ip=auto-nat` / explicit
- `dtmf-type=rfc2833`
- `inbound-codec-prefs=OPUS,PCMU,PCMA`, `outbound-codec-prefs=OPUS,PCMU,PCMA`
- `inbound-codec-negotiation=generous`
- `rtp-secure-media=optional` for WSS endpoints (browsers always SRTP via DTLS)
- `media-option=resume-media-on-hold` (recording continues on hold)
- `nonce-ttl=60`
- `manage-presence=false` (Phase 1 doesn't need BLF/presence)
- `enable-3pcc=proxy` (for warm-transfer 3PCC if needed)
- `record-template=$${recordings_dir}/${strftime(%Y/%m/%d)}/${campaign_id}_${lead_id}_${uuid}.wav`

### 3.3 External profile parameters

- `sip-port=5080` (separate from internal so no port collision; carriers cannot reach internal auth realm)
- `auth-calls=false` (carriers authenticate via IP ACL; per-call rejection from dialplan if unmatched)
- `accept-blind-auth=false`
- `apply-inbound-acl=carriers.auto` (the ACL we build from `carriers.ip_allowlist` JSON via T02 renderer)
- `ext-rtp-ip` / `ext-sip-ip` per host
- `inbound-codec-prefs=PCMU,PCMA` (carriers do PSTN-grade codecs; OPUS rare here)
- `outbound-codec-prefs=PCMU,PCMA`
- `disable-transcoding=false` (we accept that PCMU↔OPUS transcoding is needed for browser↔carrier bridges; this is the dominant CPU cost)
- `context=public` (inbound carrier calls land in the `public` dialplan first — DID lookup, then transfer to default)
- `manage-presence=false`

### 3.4 Carrier gateway shapes

Reviewed Twilio [9][10][11], Telnyx [12][13], RingCentral, Bandwidth [14] BYOC docs.

| Carrier | register | Auth | Realm/proxy hint |
|---|---|---|---|
| Twilio Elastic SIP | `false` | IP-ACL **and/or** credential list (digest 407 challenge) — Twilio recommends both | `<tenant>.pstn.twilio.com` per region |
| Telnyx (creds trunk) | `true` | Username/password digest | `sip.telnyx.com` |
| Telnyx (IP trunk) | `false` | IP-ACL | `sip.telnyx.com` (no register) |
| RingCentral | `true` (per-DID typically) | Credentials | `sip.ringcentral.com` |
| Bandwidth | `false` typical | IP-ACL via Bandwidth realm | `<acct-hex>.auth.bandwidth.com` |
| Flowroute | `false` | IP-ACL | `us-west-or.sip.flowroute.com` |
| SignalWire | `true` | Token-based | `<space>.sip.signalwire.com` |

Common XML shape (DESIGN §4.3 already correct):
```
<gateway name="<carrier>">
  <param name="username" value="${USER}"/>
  <param name="password" value="${PASS}"/>
  <param name="proxy" value="<host>"/>
  <param name="realm" value="<realm>"/>
  <param name="register" value="true|false"/>
  <param name="caller-id-in-from" value="true"/>
  <param name="codec-prefs" value="PCMU,PCMA"/>
  <param name="dtmf-type" value="rfc2833"/>
  <param name="ping" value="25"/>          <!-- OPTIONS keepalive -->
  <param name="retry-seconds" value="30"/>
</gateway>
```

For non-register IP-auth carriers (Twilio, Bandwidth, Flowroute), the ACL is the actual security boundary — `acl.conf.xml` must list each carrier's published edge IP ranges. Twilio publishes per-region ranges; T02 renderer reads `carriers.ip_allowlist` JSON from MySQL (DESIGN §5.1 schema) and writes `acl.conf.xml`. F03 ships a stub `acl.conf.xml` with `loopback.auto`, `localnet.auto`, `nat.auto`, plus an empty named list `carriers` that T02 fills in.

---

## 4. Dialplan philosophy (thin, server-side via xml_curl)

### 4.1 Phase 1: static XML, minimal

DESIGN §4.4 lists 4 contexts: `from_carrier`, `from_agent`, `internal_dialer`, `agent_conference`. The F03 module spec uses `default` and `public` (the FS conventions) and adds `00_safety.xml`, `99_features.xml`. **Reconcile**: keep FS conventions (`default`, `public`) as the dialplan *contexts* in XML; the F03 spec naming is correct. The DESIGN §4.4 "contexts" are conceptual — `internal_dialer` and `agent_conference` map to extensions inside the `default` context, not separate XML contexts.

Concrete static dialplan files for Phase 1 (numbering: low number = matched first):

- `dialplan/public/00_drop_unauthenticated.xml` — anything reaching `public` that isn't a known DID gets dropped (return error 503). DID-routing to T02-rendered files goes 10–89.
- `dialplan/default/00_safety.xml` — drop weird destinations, set common channel vars.
- `dialplan/default/01_agent_conference.xml` — `*9${user_id}` extension: agent's WSS leg dials this on login → answer → join `conference_${user_id}@default+flags{moderator,nomoh}`. (T03 owns this file.)
- `dialplan/default/02_outbound.xml` — for agent-originated outbound (manual click-to-dial that originated FROM the agent leg, not from dialer). Routes via `sofia/gateway/<carrier>/<phone>`. (Most outbound goes through originate from T04, which sets the dialplan path explicitly via `transfer_after_bridge` and avoids this file.)
- `dialplan/default/99_features.xml` — `*` codes for park, eavesdrop, etc.

### 4.2 mod_xml_curl loaded but bindings empty in Phase 1

`xml_curl.conf.xml` ships with `<bindings/>` empty. mod_xml_curl is in modules.conf.xml so I03 can swap in bindings without restarting FS. The hot path (manual dial, conference join) is all static XML — no HTTP roundtrip per call, no API as a single point of failure for telephony.

When bindings DO get added (Phase 3 I03/I01):
- `dialplan` binding for IVR routing — API serves the IVR dialplan based on DID + caller state.
- `directory` binding optional — F05 SIP credentials served from MySQL via API. Phase 1 keeps directory static (one XML per agent, generated by F05 on user-create) for simplicity. Phase 2/3 can flip to xml_curl directory for hot-reload.
- **NOT** `configuration` binding — Sofia profiles stay on disk (carrier rescan pattern).

### 4.3 Originate-driven dialplan (the actual control flow)

T04 owns the outbound primitive. It calls ESL `bgapi originate {var1=...,var2=...}sofia/gateway/<carrier>/+1NXXNXXXXXX 'transfer:conf_${userId}+flags{join-only} XML default' inline`. The dialplan extension `conf_<userId>` (a wildcard match in 01_agent_conference.xml or a synthesized inline) executes the conference app. So **most originate flows never hit the static dialplan** — the inline extension is provided by the originate string. F03 just needs to make sure the conference app works and `transfer` is enabled (default).

---

## 5. Conference profile design (mod_conference)

### 5.1 Profile params for "agent-conference-per-user" (based on mod_conference 1.10 docs [3] and the simple/default profiles in vanilla FS)

```
profile name="default"
  rate            = 8000           # PCMU friendly (avoids resampling for PSTN customer leg)
  interval        = 20             # 20ms ptime; matches PCMU default
  energy-level    = 100            # low, so background noise from agent sometimes mixes (don't squelch)
  channels        = 1              # mono (we're audio-only)
  comfort-noise   = true           # avoids dead silence on hold
  enter-sound     = silence_stream://1   # SILENT — no "you have entered the conference" beep
  exit-sound      = silence_stream://1   # SILENT
  alone-sound     = silence_stream://1   # agent sitting alone in their conf hears silence, not "you are alone"
  moh-sound       = local_stream://moh   # only used if customer is on hold while agent talks to 3rd party
  muted-sound     = silence_stream://1
  unmuted-sound   = silence_stream://1
  kicked-sound    = silence_stream://1
  caller-id-name  = ${conference_caller_name}  # set per-channel via uuid_setvar
  caller-id-number = ${conference_caller_number}
  sound-prefix    = $${sounds_dir}/en/us/callie
  caller-controls = none           # we do NOT want agents accidentally muting via DTMF
  comfort-noise-level = 800        # low CN; tunable
  auto-record =                    # leave blank — recording is per-call via record_session, not auto
  member-flags = endconf           # destroy conference when last member leaves (cleans up agent logout)
```

Conference flags applied per-channel at join time (not in profile):
- Agent leg: `moderator` (lets them kick), `nomoh` (no MoH while waiting alone — silence)
- Customer leg: `endconf=false` (don't tear down conf when customer hangs up; agent stays for next call)

### 5.2 Why energy-level 100 and not 300?

Default mod_conference is 300 (gates background noise). For a 2-person agent↔customer conference, gating either side's audio when they pause causes choppy speech (the gate is noticeable). Lowering to 100 keeps both legs always-on, which is what you want for a call, not a meeting. Trade-off: more CPU because we always mix instead of pass-through. For 2-party conferences this is negligible.

### 5.3 Per-channel variables (applied via `uuid_setvar` at join)

- `conference_enter_sound=silence_stream://1` — overrides profile (DESIGN §4.6 implicit)
- `conference_exit_sound=silence_stream://1`
- `recording_follow_transfer=true` — recording continues across `uuid_transfer`
- `RECORD_STEREO=true` — agent on one channel, customer on other
- `RECORD_MIN_SEC=2`

### 5.4 Conference scale per FS instance

mod_conference docs [3]: "create as many conferences as you like, as long as system resources are available." Realistically the bottleneck is `switch_thread_create()` — every conference has a runner thread plus 1 thread per member. With the Artoo wall (§9), and 2 members per agent conference (agent + customer), **practical ceiling is ~750 simultaneous talking pairs per FS instance**, well above MVP needs.

---

## 6. WebRTC setup (WSS, certs, STUN/TURN, NAT)

### 6.1 WSS

Per SignalWire WebRTC docs [6]: WSS binds via `wss-binding=:7443` on the internal (or dedicated wss) profile. `tls-cert-dir` points to a directory containing:
- `wss.pem` — combined cert + key + chain in single file (cert first, key middle, intermediates appended) [6][7]
- `agent.pem` — same shape, used for SIP-over-TLS (port 5061)
- `cafile.pem` — root CA cert(s)
- `dtls-srtp.pem` — typically symlinked to `wss.pem`

Browsers **require a publicly trusted certificate** (or a manually-imported CA) for WSS — self-signed without trust import causes WebSocket error 1006 and the SIP.js connection silently fails [8].

### 6.2 Cert chain handling

- **Dev**: `mkcert -install` creates a local CA, trusted by host browsers via OS trust store. `gen-dev-cert.sh` (F03 file list) generates `wss.pem` for `localhost` + `host.docker.internal`. Document for macOS Docker users that they must `mkcert -install` on the host so Chrome trusts the CA.
- **Prod**: Let's Encrypt via O05; ACME DNS-01 challenge (since FS isn't HTTP). `cat fullchain.pem privkey.pem > /etc/freeswitch/tls/wss.pem` and `sofia profile internal rescan`. Renewal: cron-driven, with post-renewal hook running `fs_cli -x 'sofia profile internal rescan'`.

### 6.3 DTLS-SRTP

Mandatory for WebRTC media (browsers refuse plain RTP). FreeSWITCH negotiates DTLS-SRTP automatically on WSS-originated calls. Channel var `rtp_secure_media=mandatory` for WSS endpoints; for the carrier leg of a bridged call, set `rtp_secure_media=optional` (most carriers don't do SRTP).

### 6.4 STUN / TURN / coturn

- Browsers add STUN candidates automatically via SIP.js/WebRTC default config (Google's stun.l.google.com:19302 fallback).
- **TURN is required** for agents behind symmetric NAT (corporate firewalls, hotel Wi-Fi, mobile). Coturn [16] is the reference implementation. Run as a separate container; auth via long-term creds or REST-based time-limited tokens (TURN REST API draft).
- F03 does NOT ship coturn. coturn is a separate concern (O05 security baseline or its own X-module). **F03 documents the TURN env vars** (`TURN_HOST`, `TURN_USERNAME`, `TURN_PASSWORD`) so SIP.js (A02) and FreeSWITCH (`apply-candidate-acl`) can both consume them when ready.
- For Phase 1 dev, no TURN — assumes agents on home networks where srflx (STUN) works. Document that ~10–30% of NAT scenarios will need TURN for production.

### 6.5 NAT params

In `vars.xml`:
- `external_sip_ip=stun:stun.freeswitch.org` (dev) — never use this in prod (unreliable per SignalWire docs [15]).
- `external_sip_ip=$${external_sip_ip_static}` (prod) — actual public IP.
- `external_rtp_ip` similarly.
- `local_ip_v4` auto-detected.

If FS itself sits behind NAT (e.g., AWS NAT gateway): set `ext-rtp-ip` and `ext-sip-ip` to the elastic IP, and ensure `local-network-acl=localnet.auto` so FS knows when to use the local vs external IP per peer.

---

## 7. ESL (mod_event_socket) config and security

### 7.1 Listen and ACL

Per mod_event_socket docs [17][18]:
- `listen-ip=127.0.0.1` in dev (single-host docker compose; the dialer container reaches FS via the Docker bridge so listen-ip=0.0.0.0 in compose is fine if ACL'd).
- `listen-ip=0.0.0.0` in prod (multi-host) bound only to the internal management VLAN; firewall externally.
- `listen-port=8021`.
- `password=$${ESL_PASSWORD}` — **must be env-driven**. F03's `vars.xml` does an `X-PRE-PROCESS cmd="env-set" data="ESL_PASSWORD=..."` during container start, so the conf reads `${ESL_PASSWORD}` at FS load time.
- `apply-inbound-acl=esl_clients` — named ACL in `acl.conf.xml`. Multiple `apply-inbound-acl` entries do NOT stack (only first wins per docs [17]); use a single named ACL with multiple `<node>` entries.
- **From 1.6 onward an ACL is required**; without one ESL refuses connections [18].

### 7.2 Password rotation

Procedure: change env var, `kill -HUP $(pidof freeswitch)` does NOT reload event_socket.conf (FS does not honor HUP for that). Either:
- Restart FS (drops all sessions — bad).
- `fs_cli -x 'reload mod_event_socket'` — disconnects all current ESL clients, reloads the conf, re-binds; clients reconnect with new password. Documented as the rotation path. **T01 must implement reconnect-with-backoff** to survive this.

### 7.3 ACL strategy

`acl.conf.xml` lists:
- `loopback.auto` — auto-built, allows 127.0.0.0/8.
- `localnet.auto` — auto-built, allows RFC1918 nets.
- `nat.auto` — auto-built.
- `esl_clients` — named, populated from env-rendered list of dialer/api container IPs (or Docker bridge subnet in dev).
- `carriers` — named, populated by T02 from `carriers.ip_allowlist` JSON. Empty in F03; just the structure.
- `webrtc_candidates` — named, used by `apply-candidate-acl` on the WSS profile (allows ICE candidates in expected ranges).

### 7.4 Per-event filtering

mod_event_socket supports `events plain CUSTOM <subclass>` (and JSON, XML formats). T01 will filter to: `CHANNEL_CREATE`, `CHANNEL_ANSWER`, `CHANNEL_HANGUP`, `CHANNEL_HANGUP_COMPLETE`, `RECORD_STOP`, `CUSTOM conference::maintenance`, `CUSTOM avmd::beep`, `CUSTOM sofia::register`, `CUSTOM sofia::unregister`. F03 doesn't configure filtering — that's an ESL-client concern — but the event types we listen for are documented here for T01.

---

## 8. Codec strategy

### 8.1 Choices

- **Customer leg (carrier)**: PCMU (G.711µ-law) primary in US; PCMA (G.711a-law) fallback for EU carriers. No transcoding cost on this leg. Carriers virtually always offer PCMU/PCMA.
- **Agent leg (browser, WSS)**: OPUS @ 48kHz preferred — required for WebRTC interop, native browser support. Fallback PCMU.
- **Inevitable transcoding**: PCMU customer ↔ OPUS browser through the conference. Per mailing list [19] and SignalWire benchmarks: OPUS encode/decode is ~5–8× the CPU of PCMU. WebRTC SRTP adds further. Aggregate: **~25–50% CPU on a 2vCPU AWS m3.medium for 10 concurrent OPUS-WebRTC participants** [19].
- **mod_opus settings**:
  - `complexity=10` (default; assume modern host CPU).
  - `maxaveragebitrate=24000` (24kbps; 32kbps is overkill for voice).
  - `useinbandfec=1` (Opus FEC for packet loss resilience — important for WebRTC).
  - `usedtx=1` (DTX silence suppression, saves bandwidth).

### 8.2 Avoid transcoding where possible

- Conferences mix at the *highest* member's rate. With one PCMU customer at 8kHz and one OPUS browser at 48kHz, the conference runs at 48kHz, downsampling for PCMU. CPU cost comes from the OPUS encode for the agent leg primarily.
- Setting `rate=8000` on the conference profile *forces* 8kHz mix — saves CPU but reduces audio quality on the agent's end (OPUS is downgraded). For a contact-center MVP where audio quality on the customer side is what matters and the agent's headset is over a known network, **8kHz is a defensible default**. Document trade-off.
- Mixing-rate decision: **interval=20, rate=8000** is the F03 baseline. Re-evaluate after Phase 1 if agents complain.

### 8.3 What we don't load

- No G.722, G.729 (G.729 is a paid codec; G.722 we don't need).
- No iLBC, GSM (legacy, no value).
- No video codecs (H.264, VP8) — `mod_h26x`, `mod_vpx` not loaded. Phase 1 is audio-only.
- No mod_silk (Skype's old codec, dead).

---

## 9. Tuning and scale ceilings

### 9.1 The Artoo wall (~1796 sessions per FS instance)

- **Confirmed real**, GH issue #1729 [20]. Even on a c5.9xlarge (36 vCPU, 72GB RAM) with all recommended ulimits and core.db on RAM disk, FS hits `switch_thread_create() failed` and Artoo drops `max_sessions` automatically before reaching 2000 threads.
- **Cause**: per-process thread limit, related to APR thread pool + Linux `clone()` overhead at high thread counts. Each call leg = ≥1 thread; recording/transcoding = additional threads. ~2 threads/leg average at scale.
- **Mitigation**:
  - ulimits (next subsection) help reach the wall but cannot pass it.
  - Reduce stack size: `ulimit -s 240` (240KB/thread vs default 8MB) — this is the **single biggest win** and was Anthony's recommendation circa 2009 [21]. 240KB × 1796 threads = ~430MB stack space; 8MB × 1796 = 14GB.
  - Multi-FS sharding (X02/X03) is the architectural answer once a single FS approaches ~1500 legs (75% of 1796).
- **For vici2 sizing**: 1 FS instance = ~750 simultaneous talking pairs (agent+customer). At dial-level 2.0 with 200 agents = 400 pairs. Phase 1 single-FS comfortably handles 200–400 agents. Multi-FS is X-track concern.

### 9.2 ulimits (Dockerfile + compose `ulimits:` block)

Per FreeSWITCH performance docs [21]:

```
ulimit -n 999999     # nofile (open files)  — minimum 1M for prod
ulimit -s 240        # stack (KB) — CRITICAL for thread count
ulimit -u unlimited  # nproc
ulimit -i unlimited  # signals
ulimit -d unlimited
ulimit -v unlimited
ulimit -l unlimited
ulimit -c unlimited  # core dumps for debugging
```

Docker Compose form:
```yaml
ulimits:
  nofile:
    soft: 1048576
    hard: 1048576
  nproc: 65535
  stack: 245760   # bytes, == 240KB
  core: -1
```

Host-level in `/etc/security/limits.conf` for systemd-managed FS:
```
freeswitch  soft  nofile  1048576
freeswitch  hard  nofile  1048576
freeswitch  soft  nproc   65535
freeswitch  hard  nproc   65535
```

And in `/etc/systemd/system/freeswitch.service.d/override.conf`:
```
[Service]
LimitNOFILE=1048576
LimitNPROC=65535
LimitSTACK=infinity
TasksMax=infinity
```

### 9.3 switch.conf.xml params

Per docs [22]:
- `max-sessions=5000` — **cap for safety**. Even though Artoo enforces ~1796, set 5000 so we see Artoo log lines instead of silent rejection. F03 module spec already says 5000.
- `sessions-per-second=100` — burst cap. Prevents a runaway dialer from melting the box.
- `rtp-start-port=16384`, `rtp-end-port=32768` — narrow if firewalled; default range is sufficient for dev/MVP.
- `disable-monotonic-timing=false` — keep monotonic clock.
- `loglevel=info` (debug only when troubleshooting).

### 9.4 Kernel tuning (host)

Per [23]:
```
# /etc/sysctl.d/99-freeswitch.conf
fs.file-max = 1000000
net.core.rmem_max = 26214400
net.core.wmem_max = 26214400
net.core.rmem_default = 262144
net.core.wmem_default = 262144
net.core.netdev_max_backlog = 5000
net.ipv4.udp_mem = 65536 131072 262144
net.ipv4.ip_local_port_range = 1024 65535
net.netfilter.nf_conntrack_max = 1048576    # if iptables/conntrack is in path
```

`netdev_max_backlog` is the most-commonly-overlooked one — under bursty UDP, NIC drops cause one-way audio that's hard to diagnose. F03 documents these for O05/host-prep but does NOT set them inside the container (containers can't change kernel sysctls without `--privileged`). The host operator does this.

### 9.5 RTP timer

`<param name="rtp-timer-name" value="soft"/>` on each Sofia profile. `soft` (FS internal scheduler) is reliable in containers and VMs, unlike `timerfd` which can have cgroup interactions. Modern kernels are tickless so the historical advice about 1000Hz is moot.

### 9.6 WebRTC SRTP ceiling

From Packt + ML threads + dOpensource benchmarks: ~150 concurrent OPUS-over-DTLS-SRTP calls per 8-core box without rtpengine offload. The bottleneck is OPUS encode plus DTLS handshake plus SRTP cipher (AES-128-CTR + HMAC-SHA1). rtpengine (X01) offloads SRTP to userspace daemon with kernel-bypass; reportedly raises ceiling to ~5000 concurrent. **Phase 1 caps at 150 concurrent agents** per FS instance from this constraint, looser than the 1796-thread limit. Plan accordingly: shard before 150.

---

## 10. Recording integration (path conventions for R01)

### 10.1 Path convention

Per DESIGN §4.6:
```
$${recordings_dir}/${strftime(%Y/%m/%d)}/${campaign_id}_${lead_id}_${uuid}.wav
```

`recordings_dir` set in `vars.xml` to `/var/lib/freeswitch/recordings` (FS package default) or `/recordings` mounted as a volume. WAV format is the FS-native output of `record_session`.

### 10.2 record_session app

Driven by dialplan or `uuid_setvar` on the customer leg before bridge. The recording starts at bridge time, not earlier; use `RECORD_PRE_BUFFER_FRAMES` to capture pre-bridge audio if needed (we don't).

### 10.3 Stereo

`RECORD_STEREO=true` is the standard — agent on one channel, customer on the other. Important for transcription (N07) and supervisor review.

### 10.4 RECORD_STOP event

When recording finishes (call hangup or `uuid_record stop`), FS emits `RECORD_STOP` event with `Record-File-Path`, `Record-Ms`, `Record-Read-Sample-Rate`, `Record-Calls` headers. T01 listens; R02 worker picks up the file path, encodes WAV→MP3 via ffmpeg, uploads to S3, writes `recording_log` row.

### 10.5 recording_follow_transfer=true

Critical for the conference-per-agent model: when the customer is `uuid_transfer`'d into the agent's conference, the recording follows the customer leg without restart. Set on the customer leg before bridge.

### 10.6 Disk pressure

Default codec = WAV PCM 8kHz mono = ~64kbps = ~480KB/min. 1 hour call = ~28MB. 100 concurrent calls × 1 hour = ~2.8GB/hour. Local disk fills fast — R02 must upload + delete promptly (within minutes). F03 should mount a dedicated volume for `/recordings` so disk-full doesn't kill FS.

---

## 11. Open questions for PLAN

1. **2-profile vs 3-profile Sofia setup** (§3.1). F03 module spec says 2; production-best-practice says 3. PLAN must choose. **My recommendation: 2 profiles in Phase 1 to match spec; revisit at X02.**
2. **Conference rate: 8kHz vs 16kHz vs 48kHz.** 8kHz saves CPU but downsamples agent audio. 48kHz gives best browser quality but increases mix CPU 6×. **My recommendation: 8kHz Phase 1, A/B test in Phase 2.**
3. **Static vs xml_curl directory in Phase 1.** Module spec says static. F05 generates one user XML per agent. Trade-off: static = simpler but every user-create requires file write + `reloadxml`. xml_curl directory = HTTP roundtrip per registration but live. **My recommendation: static Phase 1, xml_curl Phase 2 if reload latency hurts.**
4. **Where do TURN credentials live?** F03 doesn't ship coturn but configures FS to advertise TURN candidates. Env var convention should be set in F03 even though coturn is operator-provided. PLAN: define `TURN_URL`, `TURN_USERNAME`, `TURN_PASSWORD` env vars, document; A02 (SIP.js) consumes the same.
5. **Cert provisioning in Docker dev.** mkcert requires `mkcert -install` on the *host*, not in the container. Document this prerequisite prominently — it's the #1 onboarding pain.
6. **mod_callcenter empty config now or later?** Module spec says load it with empty config (placeholder). Confirm I01 will overwrite via template, not append. Decision: ship empty `callcenter.conf.xml.tmpl` with a comment marking it as I01-territory.
7. **Logging strategy.** Module spec asks "mod_console only or also mod_logfile?" Recommend: in Docker, mod_console (stdout) only — Docker captures stdout; logrotate is the host's job. mod_logfile in /var/log/freeswitch/ creates disk pressure. **Final answer for PLAN.**
8. **Healthcheck.** Module spec asks for ESL probe + module count check. Recommend: bash script doing `fs_cli -x 'status' | grep -c "RUNNING"` and `fs_cli -x 'sofia status' | grep -c "RUNNING"` (expect 2 = internal + external). Docker compose healthcheck calls this every 10s with 30s start grace.
9. **Whether to bake mkcert into the Dockerfile.** mkcert can run inside the container at first start, but the CA must be imported on the host browser regardless. Recommend: separate `gen-dev-cert.sh` script the user runs once on the host, with output mounted into the container. Document.
10. **Module list final cut.** Drafting (Phase 1 only):

   Required: `mod_console`, `mod_sofia`, `mod_event_socket`, `mod_xml_curl`, `mod_dptools`, `mod_dialplan_xml`, `mod_conference`, `mod_callcenter`, `mod_avmd`, `mod_db`, `mod_loopback`, `mod_local_stream`, `mod_native_file`, `mod_sndfile`, `mod_tone_stream`, `mod_commands`, `mod_say_en`, `mod_g711` (PCMU/PCMA codec), `mod_opus`, `mod_voicemail`-OFF (Phase 3), `mod_dialplan_asterisk`-OFF, `mod_xml_cdr`-OFF (we use ESL events), `mod_xml_rpc`-OFF, `mod_amd`-OFF, `mod_v8`-OFF, `mod_lua`-OFF, `mod_python3`-OFF, `mod_h26x`-OFF, `mod_vpx`-OFF, `mod_redis`-OFF (we use Redis from app, not FS), `mod_curl`-OFF (no HTTP from dialplan in Phase 1), `mod_spandsp`-OFF (no fax).

---

## 12. Citations

[1] FreeSWITCH 1.10.12 release — github.com/signalwire/freeswitch/releases — release 2024-08-03.
[2] FreeSWITCH 1.10.x Release notes / Breaking changes — developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Release-Notes/FreeSWITCH-1.10.x-Release-notes_25460878/
[3] mod_conference module reference — developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Modules/mod_conference_3965534/
[4] Debian install + SignalWire repo + PAT — freeswitch.org/confluence/display/FREESWITCH/Debian
[5] SignalWire Sofia-SIP stack reference — developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Configuration/Sofia-SIP-Stack/
[6] WebRTC + WSS configuration — developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Configuration/WebRTC_3375381/
[7] FS PBX TLS / WSS combined PEM convention — fspbx.com/docs/configuration/fspbx-tls-setup/
[8] WSS troubleshooting (JsSIP 1006, cert chain) — lists.freeswitch.org/pipermail/freeswitch-users/2013-September/099453.html
[9] Twilio Elastic SIP + FreeSWITCH guide — twilio.com/en-us/blog/getting-started-placing-outbound-calls-with-twilio-elastic-sip-trunking-and-freeswitch-html
[10] Twilio Elastic SIP step-by-step (no-register, IP ACL) — twilio.com/blog/elastic-sip-trunking-step-by-step-setup
[11] Twilio Secure Trunking with FreeSWITCH — docs-resources.prod.twilio.com/documents/TwilioSecure-Freeswitch.pdf
[12] Telnyx FreeSWITCH credentials trunk — support.telnyx.com/en/articles/1618801-freeswitch-credentials-trunk
[13] Telnyx SIP trunk config guides — developers.telnyx.com/docs/voice/sip-trunking/configuration-guides/index
[14] Bandwidth BYOC SIP trunk reference — bandwidth.com/support/en/articles/12823442
[15] NAT Traversal — confluence.freeswitch.org/display/FREESWITCH/NAT+Traversal
[16] coturn project (TURN/STUN reference) — github.com/coturn/coturn
[17] mod_event_socket module reference — wiki.freeswitch.org/wiki/Mod_event_socket and developer.signalwire.com mirror
[18] mod_event_socket ACL requirement (1.6+) — github.com/signalwire/freeswitch-docs (mod_event_socket_1048924.mdx)
[19] OPUS CPU benchmarks (mailing list, AWS m3.2xl, 10-person WebRTC conf) — lists.freeswitch.org/pipermail/freeswitch-users/2016-April/119791.html
[20] Artoo R2D2 thread wall (1796 ceiling, c5.9xlarge) — github.com/signalwire/freeswitch/issues/1729
[21] FS Performance Testing & ULIMIT recommendations — developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Configuration/Performance-Testing-and-Configurations/
[22] switch.conf.xml core params — developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Configuration/Configuring-FreeSWITCH/Switch.conf.xml_9634306/
[23] Linux kernel tuning for 5000+ concurrent FS calls — sunilkumarnayak.in/blog/optimizing-freeswitch-5000-concurrent-calls
[24] Firewall ports reference (RTP 16384–32768, ESL 8021, etc.) — wiki.freeswitch.org/wiki/Firewall
[25] mod_avmd reference + tuning — freeswitch.org/confluence/display/FREESWITCH/mod_avmd and PR #2418 (1.10.x param exposure)
[26] mod_xml_curl reference — developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Modules/mod_xml_curl_1049001/
[27] FS WebRTC NAT/cert blog post (Let's Encrypt path) — dopensource.com/2017/01/21/setting-up-freeswitch-webrtc-functionality/
[28] STUN/TURN/ICE in WebRTC, decision matrix — innovateasterisk.com/stun-turn-webrtc-asterisk-nat-traversal/
[29] Vicidial inktel repo (Asterisk-based; included for historical comparison only — not used as FreeSWITCH reference) — github.com/inktel/Vicidial

---

End of RESEARCH.md.
