# Module F03 — FreeSWITCH Base Config (Docker) — PLAN

**Module:** F03 (Foundation, Phase 1)
**Author:** F03 PLAN sub-agent
**Date:** 2026-05-06
**Status:** PROPOSED — awaiting orchestrator/lead review.
**Companion:** [RESEARCH.md](./RESEARCH.md) — 29 citations behind every choice.

This plan resolves the open question raised in RESEARCH.md, specifies every
file F03 IMPLEMENT will create, and freezes the public interfaces that T01,
T02, T03, T04, A02, R01, F05, I02, X01, X02, and O01 will consume.

Once this plan is approved, the public interface (ports, env vars, ESL host,
recording path convention, ACL names, dialplan extension hooks, gateway XML
template shape) is FROZEN. Internal XML structure within F03 may change
during IMPLEMENT without an RFC.

---

## 0. TL;DR (10 bullets)

1. **3 Sofia profiles, not 2.** `internal` (5060/UDP+TCP for hardphones),
   `wss` (7443/TCP WSS + 5066/TCP WS dev-only for browser softphones),
   `external` (5080/UDP+TCP for carriers). Deviates from F03.md spec
   §"Key non-obvious decisions" #3 — see §1 below for justification. Cost
   is one extra XML file and one extra port; benefit is independent
   cert/codec/ACL policy and isolated cert-reload blast radius.
2. **FreeSWITCH 1.10.12** on `signalwire/freeswitch:1.10.12` (debian-bookworm).
   `SIGNALWIRE_TOKEN` is a build-time arg; never baked into the image
   layer (passed via `--build-arg` from compose, sourced from `.env`).
3. **Module list is an explicit allowlist of 17 modules** — no
   `freeswitch-meta-all`. Notably loaded: `mod_xml_curl` (with empty
   `<bindings/>` so I01/I03/F05 can wire later without restart).
   Notably NOT loaded: `mod_xml_rpc`, `mod_xml_cdr`, `mod_voicemail`,
   `mod_amd`, `mod_v8`, `mod_lua`, `mod_python3`, `mod_h26x`, `mod_vpx`,
   `mod_curl`, `mod_spandsp`, `mod_g729`. `mod_callcenter` deferred to I01.
4. **Conference profile**: silent enter/exit/alone, `comfort-noise=true`,
   `interval=20`, `rate=8000` (PCMU-friendly, defensible Phase 1 default
   trading agent-side audio quality for ~6× lower mix CPU), `caller-controls=none`,
   `member-flags=endconf` baseline (overridden per-channel for customer leg).
5. **ulimit -s 240** (240 KB stack/thread, set in entrypoint and compose
   `ulimits:`). Per RESEARCH §9.1, single biggest mitigation for the
   Artoo R2D2 ~1796-thread wall — buys headroom from ~1796 to the same
   ~1796 *with* memory left over instead of OOM. Plus `nofile=1048576`
   and `nproc=65535`.
6. **Single combined PEM at `/etc/freeswitch/tls/wss.pem`** (cert + key + chain).
   Dev: `mkcert -install` on host, `gen-dev-cert.sh` writes the file.
   Prod: Let's Encrypt DNS-01 with post-renewal hook running
   `fs_cli -x 'sofia profile wss restart'` (sofia-sip cannot hot-reload TLS
   bindings; rescan is insufficient — known issue, documented).
7. **mod_event_socket** binds `0.0.0.0:8021/TCP`, password from env
   `FS_EVENT_SOCKET_PASSWORD`, ACL `esl_clients` (named, populated from
   Docker bridge subnet in dev). Rotation procedure documented:
   `fs_cli -x 'reload mod_event_socket'` — T01 must implement
   reconnect-with-backoff.
8. **Recording path convention frozen for R01:**
   `/var/lib/freeswitch/recordings/<tenant_id>/<YYYY>/<MM>/<DD>/<campaign_id>_<lead_id>_<call_uuid>.wav`.
   Volume `freeswitch_recordings` (already declared by F01) mounted there.
   `RECORD_STEREO=true`, `recording_follow_transfer=true` set by T03/T04 dialplan.
9. **Codec policy.** internal: `PCMU,PCMA,OPUS,G722`. external:
   `PCMU,PCMA`. wss: `OPUS,PCMU`. mod_opus tuned `complexity=10`,
   `maxaveragebitrate=24000`, `useinbandfec=1`, `usedtx=1`. Conference
   mixes at 8 kHz to match PSTN customer leg and minimize transcoding cost.
10. **Hand-off interfaces frozen** (see §14): ESL `host:8021` + env-var
    password for T01; recording path for R01; xml_curl `directory` binding
    point for F05 Phase 2; `public` dialplan DID extension range
    [10–89] for I02; ACL `carriers` (empty named list) for T02 to populate;
    `external_sip_ip`/`external_rtp_ip` env-injected via `vars.xml` for
    X01/X02 future SDP rewrite/dispatcher integration.

---

## 1. Resolution of the 2-vs-3 Sofia profile open question

### 1.1 Decision: **3 profiles**

| Profile | Bindings | Purpose | Auth model |
|---|---|---|---|
| `internal` | 5060/UDP, 5060/TCP | Optional hardphones, internal SIP devices, future supervisor desk phones | digest auth from xml directory (static Phase 1; xml_curl Phase 2 via F05 binding) |
| `wss` | 7443/TCP (WSS), 5066/TCP (WS, dev only — gated by `WSS_ENABLE_PLAINTEXT_WS=true`) | Browser SIP.js softphones (the primary agent device per DESIGN §7.2) | digest auth from same xml directory; DTLS-SRTP mandatory |
| `external` | 5080/UDP, 5080/TCP | Carrier gateways (BYOC: Twilio, Telnyx, RingCentral, Bandwidth, Flowroute, SignalWire) | per-gateway register OR IP-ACL via `acl.conf.xml` |

### 1.2 Why this deviates from F03.md spec §"Key non-obvious decisions" #3

The F03 module spec mandates 2 profiles ("Internal profile binds 5060 UDP/TCP
for SIP, plus 7443 for WSS — single profile handles both"). RESEARCH §3.1
flagged this as the open question; my recommendation in RESEARCH §11 #1 was
"2 profiles in Phase 1 to match spec; revisit at X02." After re-reading:

**Reversed.** 3 profiles is the right call for these concrete reasons:

1. **TLS reload blast radius.** Cert renewal (LE every 60 days, prod) requires
   `sofia profile <name> restart` — sofia-sip does not hot-reload TLS bindings
   reliably (RESEARCH §6.2, [27]). With 2 profiles, the restart drops every
   internal SIP registration including future hardphones and supervisor desks
   (S02 eavesdrop endpoints). With 3 profiles, only browser softphones drop
   for a few seconds during cert reload — they auto-reconnect via SIP.js retry
   logic. Hardphones never even notice.

2. **Codec preference inversion.** WSS endpoints want `OPUS,PCMU` (browsers
   strongly prefer OPUS, fall back to PCMU). Internal hardphones want
   `PCMU,PCMA,OPUS` (avoid OPUS transcoding cost where possible). Same
   profile cannot cleanly express both — `inbound-codec-prefs` is per-profile,
   not per-endpoint-class.

3. **DTLS-SRTP / candidate-ACL clutter.** WSS profile needs
   `rtp-secure-media=mandatory`, `apply-candidate-acl=webrtc_candidates`,
   `dtls-srtp.pem` configuration. None of these belong in a hardphone profile,
   and overlaying them creates spurious negotiation failures for non-WebRTC
   peers.

4. **Future X02 (Kamailio dispatcher) cleaner.** When Kamailio fronts FS at
   X02/X03, browser WSS terminates at FS directly (or at Kamailio→FS over WS),
   while hardphones may dispatch differently. Two profile names give Kamailio
   independent routing rules without reconfiguration.

5. **Marginal cost.** One additional ~120-line XML file, one extra port
   (5066 dev / 7443 prod is already exposed), zero new modules. mod_sofia
   handles N profiles with no measurable overhead; OPTIONS keepalives are
   per-gateway not per-profile.

### 1.3 Why this is not RFC-worthy

The F03 module spec §"Key non-obvious decisions" was written before the
RESEARCH phase confirmed (a) the cert-reload TLS-binding limitation, (b) the
codec-preference inversion, and (c) the X02 future requirement. PLAN-phase
decisions that strengthen rather than weaken the public interface (3 profiles
is a strict superset of 2-profile capability) and that don't change downstream
contracts (every consumer module — T01, T02, T03, T04, A02 — sees the same
ports and ESL surface) do not require RFC per SPEC §12. The change is
recorded here as a deliberate F03-PLAN-time refinement; future F03/HANDOFF.md
must call this out so downstream agents reading F03.md see the override.

If lead/orchestrator review disagrees, fallback is trivial: collapse `wss.xml`
into `internal.xml` by adding `<param name="wss-binding" value=":7443"/>` and
`<param name="tls-cert-dir" value="$${certs_dir}"/>` blocks, and accept the
trade-offs above. No other PLAN content changes.

---

## 2. Sofia profile XMLs — content sketches

### 2.1 `freeswitch/conf/sip_profiles/internal.xml`

```xml
<profile name="internal">
  <aliases/>
  <gateways>
    <X-PRE-PROCESS cmd="include" data="internal/*.xml"/>
  </gateways>
  <domains>
    <domain name="all" alias="true" parse="false"/>
  </domains>
  <settings>
    <param name="debug" value="0"/>
    <param name="sip-trace" value="no"/>
    <param name="sip-capture" value="no"/>
    <param name="watchdog-enabled" value="no"/>
    <param name="log-auth-failures" value="true"/>
    <param name="forward-unsolicited-mwi-notify" value="false"/>
    <param name="context" value="default"/>

    <!-- Bindings -->
    <param name="rfc2833-pt" value="101"/>
    <param name="sip-port" value="$${internal_sip_port}"/>          <!-- 5060 -->
    <param name="dialplan" value="XML"/>
    <param name="dtmf-duration" value="2000"/>
    <param name="inbound-codec-prefs" value="$${internal_codec_prefs}"/>   <!-- PCMU,PCMA,OPUS,G722 -->
    <param name="outbound-codec-prefs" value="$${internal_codec_prefs}"/>
    <param name="rtp-timer-name" value="soft"/>

    <!-- Auth -->
    <param name="auth-calls" value="true"/>
    <param name="accept-blind-reg" value="false"/>
    <param name="accept-blind-auth" value="false"/>
    <param name="auth-all-packets" value="false"/>
    <param name="nonce-ttl" value="60"/>
    <param name="manage-presence" value="false"/>

    <!-- NAT / addressing -->
    <param name="ext-rtp-ip" value="$${external_rtp_ip}"/>
    <param name="ext-sip-ip" value="$${external_sip_ip}"/>
    <param name="rtp-ip" value="$${local_ip_v4}"/>
    <param name="sip-ip" value="$${local_ip_v4}"/>
    <param name="apply-nat-acl" value="nat.auto"/>
    <param name="local-network-acl" value="localnet.auto"/>
    <param name="apply-inbound-acl" value="domestic"/>

    <!-- Media -->
    <param name="media-option" value="resume-media-on-hold"/>
    <param name="dtmf-type" value="rfc2833"/>
    <param name="enable-3pcc" value="proxy"/>
    <param name="rtp-secure-media" value="optional"/>
    <param name="hold-music" value="local_stream://moh"/>

    <!-- Misc -->
    <param name="presence-hosts" value="$${domain},$${local_ip_v4}"/>
    <param name="presence-privacy" value="false"/>
    <param name="record-template" value="$${recordings_dir}/$${tenant_id}/${strftime(%Y/%m/%d)}/${campaign_id}_${lead_id}_${uuid}.wav"/>
    <param name="record-path" value="$${recordings_dir}"/>
    <param name="challenge-realm" value="auto_from"/>
  </settings>
</profile>
```

Key choices: `auth-calls=true` (digest required), `apply-inbound-acl=domestic`
(localhost + Docker bridge in dev), `rtp-secure-media=optional` (hardphones
generally don't do SRTP).

### 2.2 `freeswitch/conf/sip_profiles/wss.xml`

```xml
<profile name="wss">
  <aliases/>
  <gateways/>
  <domains>
    <domain name="all" alias="true" parse="false"/>
  </domains>
  <settings>
    <param name="debug" value="0"/>
    <param name="context" value="default"/>
    <param name="dialplan" value="XML"/>
    <param name="rfc2833-pt" value="101"/>

    <!-- Plain SIP off; bind only WSS (and optional WS) -->
    <param name="sip-port" value="5066"/>           <!-- WS port; only used if WSS_ENABLE_PLAINTEXT_WS=true via X-PRE-PROCESS toggle -->
    <param name="ws-binding" value=":5066"/>
    <param name="wss-binding" value=":7443"/>

    <!-- TLS -->
    <param name="tls" value="true"/>
    <param name="tls-only" value="false"/>          <!-- WSS handles its own TLS at WS layer -->
    <param name="tls-cert-dir" value="$${certs_dir}"/>
    <param name="tls-version" value="tlsv1.2,tlsv1.3"/>

    <!-- Auth -->
    <param name="auth-calls" value="true"/>
    <param name="accept-blind-reg" value="false"/>
    <param name="accept-blind-auth" value="false"/>
    <param name="nonce-ttl" value="60"/>
    <param name="challenge-realm" value="auto_from"/>

    <!-- Codecs: OPUS first for browsers -->
    <param name="inbound-codec-prefs" value="$${wss_codec_prefs}"/>     <!-- OPUS,PCMU -->
    <param name="outbound-codec-prefs" value="$${wss_codec_prefs}"/>
    <param name="inbound-codec-negotiation" value="generous"/>

    <!-- Mandatory secure media for browsers -->
    <param name="rtp-secure-media" value="mandatory"/>
    <param name="rtp-secure-media-inbound" value="mandatory"/>
    <param name="rtp-secure-media-outbound" value="mandatory"/>

    <!-- WebRTC ICE -->
    <param name="apply-candidate-acl" value="webrtc_candidates"/>
    <param name="ext-rtp-ip" value="$${external_rtp_ip}"/>
    <param name="ext-sip-ip" value="$${external_sip_ip}"/>
    <param name="rtp-ip" value="$${local_ip_v4}"/>
    <param name="local-network-acl" value="localnet.auto"/>
    <param name="rtp-timer-name" value="soft"/>

    <param name="dtmf-type" value="rfc2833"/>
    <param name="manage-presence" value="false"/>
    <param name="record-template" value="$${recordings_dir}/$${tenant_id}/${strftime(%Y/%m/%d)}/${campaign_id}_${lead_id}_${uuid}.wav"/>
  </settings>
</profile>
```

Cert convention: `$${certs_dir}` resolves to `/etc/freeswitch/tls`; FreeSWITCH
auto-loads `wss.pem` from there. DTLS-SRTP fingerprint pulled from same file.

### 2.3 `freeswitch/conf/sip_profiles/external.xml`

```xml
<profile name="external">
  <aliases/>
  <gateways>
    <X-PRE-PROCESS cmd="include" data="external/*.xml"/>
  </gateways>
  <domains/>
  <settings>
    <param name="debug" value="0"/>
    <param name="context" value="public"/>            <!-- inbound carrier traffic lands in public dialplan -->
    <param name="dialplan" value="XML"/>
    <param name="rfc2833-pt" value="101"/>
    <param name="sip-port" value="$${external_sip_port}"/>   <!-- 5080 -->

    <!-- Auth: carriers authenticate via IP ACL or per-gateway register -->
    <param name="auth-calls" value="false"/>
    <param name="accept-blind-auth" value="false"/>
    <param name="apply-inbound-acl" value="carriers"/>       <!-- T02 populates -->

    <param name="inbound-codec-prefs" value="$${external_codec_prefs}"/>   <!-- PCMU,PCMA -->
    <param name="outbound-codec-prefs" value="$${external_codec_prefs}"/>
    <param name="inbound-codec-negotiation" value="generous"/>

    <param name="ext-rtp-ip" value="$${external_rtp_ip}"/>
    <param name="ext-sip-ip" value="$${external_sip_ip}"/>
    <param name="rtp-ip" value="$${local_ip_v4}"/>
    <param name="rtp-timer-name" value="soft"/>
    <param name="dtmf-type" value="rfc2833"/>
    <param name="manage-presence" value="false"/>
    <param name="rtp-secure-media" value="false"/>           <!-- most carriers plain RTP -->

    <param name="caller-id-in-from" value="true"/>           <!-- carrier expects From=our DID -->
    <param name="username" value="freeswitch"/>
    <param name="password" value=""/>
  </settings>
</profile>
```

Carrier gateways are `<X-PRE-PROCESS include>`'d from `sip_profiles/external/*.xml`.
T02 owns rendering those at runtime from the `carriers` MySQL table.

---

## 3. Gateway templates — `freeswitch/conf/sip_profiles/external/`

F03 ships **only `.tmpl` files** (env-substituted by entrypoint), not active
gateway XMLs. T02 will write actual rendered XMLs based on admin-UI carrier
records. The `.tmpl` files are reference templates an operator can drop into
place by hand for the very first carrier before T02 is implemented.

Common shape (from RESEARCH §3.4, validated against [9][10][12][14]):

### 3.1 `twilio.xml.tmpl`

```xml
<include>
  <gateway name="${CARRIER_NAME}">
    <param name="username" value="${TWILIO_TERMINATION_USER}"/>     <!-- digest cred-list (optional, recommended alongside IP-auth) -->
    <param name="password" value="${TWILIO_TERMINATION_PASS}"/>
    <param name="realm" value="Twilio-outbound"/>
    <param name="proxy" value="${TWILIO_PROXY}"/>                   <!-- e.g. <tenant>.pstn.twilio.com -->
    <param name="register" value="false"/>
    <param name="caller-id-in-from" value="true"/>
    <param name="codec-prefs" value="PCMU,PCMA"/>
    <param name="dtmf-type" value="rfc2833"/>
    <param name="ping" value="25"/>
    <param name="retry-seconds" value="30"/>
  </gateway>
</include>
```
Inbound auth: Twilio edge IPs in `acl.conf.xml` named ACL `carriers`.

### 3.2 `ringcentral.xml.tmpl`

```xml
<include>
  <gateway name="${CARRIER_NAME}">
    <param name="username" value="${RC_AUTHID}"/>
    <param name="password" value="${RC_PASSWORD}"/>
    <param name="realm" value="sip.ringcentral.com"/>
    <param name="proxy" value="sip.ringcentral.com"/>
    <param name="register" value="true"/>
    <param name="register-transport" value="tls"/>
    <param name="expire-seconds" value="600"/>
    <param name="caller-id-in-from" value="true"/>
    <param name="codec-prefs" value="PCMU,PCMA"/>
    <param name="dtmf-type" value="rfc2833"/>
    <param name="ping" value="25"/>
  </gateway>
</include>
```

### 3.3 `telnyx.xml.tmpl` (credentials trunk)

```xml
<include>
  <gateway name="${CARRIER_NAME}">
    <param name="username" value="${TELNYX_USER}"/>
    <param name="password" value="${TELNYX_PASS}"/>
    <param name="realm" value="sip.telnyx.com"/>
    <param name="proxy" value="sip.telnyx.com"/>
    <param name="register" value="${TELNYX_REGISTER}"/>     <!-- "true" creds trunk; "false" IP trunk -->
    <param name="caller-id-in-from" value="true"/>
    <param name="codec-prefs" value="PCMU,PCMA"/>
    <param name="dtmf-type" value="rfc2833"/>
    <param name="ping" value="25"/>
  </gateway>
</include>
```

### 3.4 `signalwire.xml.tmpl`

```xml
<include>
  <gateway name="${CARRIER_NAME}">
    <param name="username" value="${SW_PROJECT_TOKEN_USER}"/>
    <param name="password" value="${SW_PROJECT_TOKEN}"/>
    <param name="realm" value="${SW_SPACE}.sip.signalwire.com"/>
    <param name="proxy" value="${SW_SPACE}.sip.signalwire.com"/>
    <param name="register" value="true"/>
    <param name="register-transport" value="tls"/>
    <param name="caller-id-in-from" value="true"/>
    <param name="codec-prefs" value="PCMU,PCMA,OPUS"/>
    <param name="dtmf-type" value="rfc2833"/>
    <param name="ping" value="25"/>
  </gateway>
</include>
```

### 3.5 `bandwidth.xml.tmpl`

```xml
<include>
  <gateway name="${CARRIER_NAME}">
    <param name="proxy" value="${BW_REALM}"/>            <!-- e.g. <acct-hex>.auth.bandwidth.com -->
    <param name="realm" value="${BW_REALM}"/>
    <param name="register" value="false"/>
    <param name="caller-id-in-from" value="true"/>
    <param name="codec-prefs" value="PCMU,PCMA"/>
    <param name="dtmf-type" value="rfc2833"/>
    <param name="ping" value="25"/>
  </gateway>
</include>
```
Inbound auth: Bandwidth published edge IPs in `carriers` ACL.

### 3.6 `flowroute.xml.tmpl`

```xml
<include>
  <gateway name="${CARRIER_NAME}">
    <param name="proxy" value="us-west-or.sip.flowroute.com"/>
    <param name="realm" value="sip.flowroute.com"/>
    <param name="register" value="false"/>
    <param name="caller-id-in-from" value="true"/>
    <param name="codec-prefs" value="PCMU,PCMA"/>
    <param name="dtmf-type" value="rfc2833"/>
    <param name="ping" value="25"/>
  </gateway>
</include>
```

### 3.7 `generic-byoc.xml.tmpl`

Catchall — every variable env-substituted, register flag toggleable, allows
admin to bring up any standards-compliant carrier without code changes.

```xml
<include>
  <gateway name="${CARRIER_NAME}">
    <param name="username" value="${GW_USER}"/>
    <param name="password" value="${GW_PASS}"/>
    <param name="realm" value="${GW_REALM}"/>
    <param name="proxy" value="${GW_PROXY}"/>
    <param name="from-domain" value="${GW_FROM_DOMAIN}"/>
    <param name="register" value="${GW_REGISTER}"/>            <!-- true|false -->
    <param name="register-transport" value="${GW_TRANSPORT}"/> <!-- udp|tcp|tls -->
    <param name="expire-seconds" value="${GW_EXPIRE}"/>
    <param name="caller-id-in-from" value="true"/>
    <param name="codec-prefs" value="${GW_CODECS}"/>
    <param name="dtmf-type" value="rfc2833"/>
    <param name="ping" value="25"/>
    <param name="retry-seconds" value="30"/>
  </gateway>
</include>
```

**Critical caveat for IMPLEMENT.** Every provider's actual auth method must be
re-verified at integration time — RESEARCH §3.4 captured the published patterns
but providers occasionally change. T02 IMPLEMENT must run an OPTIONS-ping
smoke test per gateway as part of carrier-create flow.

---

## 4. Dialplan strategy — thin XML, mod_xml_curl bindings empty

Per RESEARCH §4.1, Phase 1 keeps dialplans minimal. Hot path control is
ESL-driven `originate` from T04 with inline destination. mod_xml_curl is
loaded so I01/I03/F05 can wire bindings later; ships with empty `<bindings/>`.

### 4.1 `freeswitch/conf/dialplan/default/00_safety.xml`

```xml
<include>
  <context name="default">
    <extension name="catchall_safety" continue="true">
      <condition field="destination_number" expression="^.*$">
        <action application="set" data="hangup_after_bridge=true"/>
        <action application="set" data="continue_on_fail=true"/>
        <action application="set" data="recording_follow_transfer=true"/>
        <action application="log" data="INFO dialplan default catchall dest=${destination_number} caller=${caller_id_number} uuid=${uuid}"/>
      </condition>
    </extension>
  </context>
</include>
```

### 4.2 `freeswitch/conf/dialplan/default/01_agent_conference.xml` (stub — T03 expands)

```xml
<include>
  <context name="default">
    <!-- *9<user_id> = agent joins their personal conference (browser dials this on login) -->
    <extension name="agent_conference_join">
      <condition field="destination_number" expression="^\*9(\d+)$">
        <action application="answer"/>
        <action application="set" data="conference_enter_sound=silence_stream://1"/>
        <action application="set" data="conference_exit_sound=silence_stream://1"/>
        <action application="conference" data="agent_$1@default+flags{moderator,nomoh}"/>
        <action application="hangup"/>
      </condition>
    </extension>

    <!-- conf_<user_id> = customer leg lands here on bridge (originate inline target) -->
    <extension name="customer_into_agent_conf">
      <condition field="destination_number" expression="^conf_(\d+)$">
        <action application="answer"/>
        <action application="set" data="RECORD_STEREO=true"/>
        <action application="set" data="RECORD_MIN_SEC=2"/>
        <action application="set" data="recording_follow_transfer=true"/>
        <action application="record_session" data="$${recordings_dir}/$${tenant_id}/${strftime(%Y/%m/%d)}/${campaign_id}_${lead_id}_${uuid}.wav"/>
        <action application="conference" data="agent_$1@default+flags{endconf=false}"/>
        <action application="hangup"/>
      </condition>
    </extension>
  </context>
</include>
```
T03 owns final form; F03 ships this as a working stub so SIPp regression
tests can exercise the path.

### 4.3 `freeswitch/conf/dialplan/default/02_outbound.xml` (stub — T04 expands)

```xml
<include>
  <context name="default">
    <!-- Agent-originated manual outbound (via originate from T04). Falls through to gateway. -->
    <extension name="outbound_via_carrier">
      <condition field="destination_number" expression="^(\+?1?\d{10,15})$">
        <action application="set" data="effective_caller_id_number=${origination_caller_id_number}"/>
        <action application="set" data="effective_caller_id_name=${origination_caller_id_name}"/>
        <action application="bridge" data="sofia/gateway/${carrier_name}/$1"/>
      </condition>
    </extension>
  </context>
</include>
```
Most outbound bypasses this file — T04's originate string carries `sofia/gateway/<carrier>/+1...`
directly. This file is the fallback for transfer-out and click-to-dial scenarios.

### 4.4 `freeswitch/conf/dialplan/default/99_features.xml`

```xml
<include>
  <context name="default">
    <!-- *0 toggle silent supervisor mode (S02) — placeholder, S02 implements -->
    <!-- *1 listen-only eavesdrop -->
    <!-- *2 whisper -->
    <!-- *3 barge -->
    <!-- *7 hold -->
    <extension name="hold_toggle">
      <condition field="destination_number" expression="^\*7$">
        <action application="bind_meta_app" data="2 a s execute_extension::hold_toggle XML default"/>
        <action application="hold"/>
      </condition>
    </extension>
    <!-- Reserved feature-code range *0-*9; S02/A07 expand. -->
  </context>
</include>
```

### 4.5 `freeswitch/conf/dialplan/public/00_drop_unauthenticated.xml`

```xml
<include>
  <context name="public">
    <!-- Anything reaching public that isn't matched by I02-rendered DID extensions (10-89) gets dropped. -->
    <extension name="public_drop">
      <condition field="destination_number" expression="^.*$">
        <action application="log" data="WARNING public dialplan drop dest=${destination_number} src=${network_addr}"/>
        <action application="respond" data="503 Service Unavailable"/>
        <action application="hangup"/>
      </condition>
    </extension>
  </context>
</include>
```
**Numbering convention frozen for I02:** DID-routing extensions populate
files numbered `dialplan/public/10_*.xml` through `dialplan/public/89_*.xml`.
File `00_drop_unauthenticated.xml` MUST remain numbered last in match order
(achieved by FreeSWITCH evaluating extensions top-to-bottom and the file-load
order being lexical — actual catch-all goes in `99_drop.xml`; we use `00_*`
naming convention but rename to `99_*` if testing reveals the include order
issue. **PLAN-time decision: rename to `99_drop_unauthenticated.xml`** so
it loads after I02-rendered files alphabetically.)

### 4.6 mod_xml_curl bindings

Empty in F03. `xml_curl.conf.xml` ships as:

```xml
<configuration name="xml_curl.conf" description="cURL XML Gateway">
  <bindings>
    <!-- Phase 1: empty. I01/I03/F05 wire bindings here. -->
  </bindings>
</configuration>
```

Documented activation: F05 Phase 2 adds a `directory` binding pointing at
the api `/internal/freeswitch/directory` endpoint. I03 adds a `dialplan`
binding for IVR routing. mod_xml_curl is in the module load list so these
can be activated by writing one file + `fs_cli -x 'reloadxml'` — no FS
restart needed.

---

## 5. Conference profile — `freeswitch/conf/autoload_configs/conference.conf.xml`

Single profile `default` shared by all per-agent conferences. Per-channel
behavior (moderator vs participant, MoH vs silence) is set via `uuid_setvar`
and conference flags at join time, NOT in this profile.

```xml
<configuration name="conference.conf" description="Audio Conference">
  <advertise>
    <room name="agent_*@default" status="FREE"/>
  </advertise>

  <caller-controls>
    <!-- Empty: caller-controls=none in profile means no DTMF mute/kick by participants. -->
    <group name="none">
    </group>
  </caller-controls>

  <profiles>
    <profile name="default">
      <param name="rate" value="8000"/>
      <param name="interval" value="20"/>
      <param name="energy-level" value="100"/>
      <param name="channels" value="1"/>
      <param name="comfort-noise" value="true"/>
      <param name="comfort-noise-level" value="800"/>

      <!-- Silent everything — agent doesn't want join/leave beeps -->
      <param name="enter-sound" value="silence_stream://1"/>
      <param name="exit-sound" value="silence_stream://1"/>
      <param name="alone-sound" value="silence_stream://1"/>
      <param name="muted-sound" value="silence_stream://1"/>
      <param name="unmuted-sound" value="silence_stream://1"/>
      <param name="kicked-sound" value="silence_stream://1"/>
      <param name="locked-sound" value="silence_stream://1"/>
      <param name="is-locked-sound" value="silence_stream://1"/>
      <param name="is-unlocked-sound" value="silence_stream://1"/>
      <param name="moh-sound" value="local_stream://moh"/>

      <param name="caller-id-name" value="${conference_caller_name}"/>
      <param name="caller-id-number" value="${conference_caller_number}"/>
      <param name="sound-prefix" value="$${sounds_dir}/en/us/callie"/>

      <param name="caller-controls" value="none"/>
      <param name="member-flags" value="endconf"/>      <!-- defaults; per-channel overrides -->

      <!-- No auto-record — recording is per-call via record_session, not auto -->
      <param name="auto-record" value=""/>

      <!-- Limits -->
      <param name="max-members" value="20"/>            <!-- 2 typical, 20 hard cap for 3-way + supervisor barge -->
    </profile>
  </profiles>
</configuration>
```

**Per-channel overrides applied via `uuid_setvar` at join (set by T03 dialplan or T04 originate string):**
- Agent leg: flags `moderator,nomoh` → can kick, no MoH while alone (silence).
- Customer leg: flag `endconf=false` → conf survives customer hangup so agent stays for next call.
- Supervisor (S02): flag `mute,deaf=false` (whisper) or `mute,deaf=true` (listen).

---

## 6. mod_event_socket — `freeswitch/conf/autoload_configs/event_socket.conf.xml`

```xml
<configuration name="event_socket.conf" description="Socket Client">
  <settings>
    <param name="nat-map" value="false"/>
    <param name="listen-ip" value="0.0.0.0"/>           <!-- Docker bridge access; ACL restricts -->
    <param name="listen-port" value="8021"/>
    <param name="password" value="$${esl_password}"/>   <!-- vars.xml pulls from FS_EVENT_SOCKET_PASSWORD env -->
    <param name="apply-inbound-acl" value="esl_clients"/>
    <param name="stop-on-bind-error" value="true"/>     <!-- fail loud if port collision -->
    <!-- Tuned -->
    <param name="max-sessions" value="10000"/>          <!-- ESL session count, not call session count -->
    <param name="cmd-timeout" value="60"/>              <!-- seconds to wait for fs_cli command -->
    <param name="max-event-bytes" value="1048576"/>     <!-- 1 MB; large CDR-like payloads -->
  </settings>
</configuration>
```

Env injection path: `FS_EVENT_SOCKET_PASSWORD` env var → entrypoint substitutes
into `vars.xml` `<X-PRE-PROCESS cmd="set" data="esl_password=..."/>` → mod_event_socket
reads `$${esl_password}` at module load.

ACL `esl_clients` is defined in `acl.conf.xml` (§7) and contains:
- `127.0.0.0/8` (loopback)
- `172.16.0.0/12` (Docker default bridge family — covers compose default and user-defined bridges)
- Host-managed extra CIDRs via env (`ESL_EXTRA_ACL_CIDRS=10.0.0.0/24,...`)

---

## 7. mod_xml_curl — `freeswitch/conf/autoload_configs/xml_curl.conf.xml`

```xml
<configuration name="xml_curl.conf" description="cURL XML Gateway">
  <bindings>
    <!-- Phase 1: empty. Downstream modules wire bindings via additional X-PRE-PROCESS includes. -->
  </bindings>
</configuration>
```

Module is loaded so bindings can be hot-added via `fs_cli -x 'reload mod_xml_curl'`
without FS restart. F05 Phase 2 / I01 / I03 each include their own
`xml_curl_<purpose>.conf.xml` snippet that the API serves.

Documented hand-off contract for downstream wiring:
- `gateway-url`: `http://api:3000/internal/freeswitch/<binding-type>`
- Auth: HTTP basic, creds from env `FS_XMLCURL_USER` / `FS_XMLCURL_PASS`
- `disable-100-continue=true`, `timeout=10`, `auth-scheme=basic`
- API endpoint must respond with `Content-Type: text/xml` and a valid
  `<document>` envelope.

---

## 8. modules.conf.xml — explicit allowlist

```xml
<configuration name="modules.conf" description="Modules">
  <modules>
    <!-- Logging -->
    <load module="mod_console"/>
    <load module="mod_logfile"/>            <!-- file logger; rotated externally -->

    <!-- Event socket (CRITICAL — T01 depends) -->
    <load module="mod_event_socket"/>

    <!-- SIP stack -->
    <load module="mod_sofia"/>
    <load module="mod_loopback"/>

    <!-- Conference (the SACRED primitive per SPEC §4.4) -->
    <load module="mod_conference"/>

    <!-- Dialplan + apps -->
    <load module="mod_dptools"/>
    <load module="mod_commands"/>
    <load module="mod_db"/>
    <load module="mod_dialplan_xml"/>
    <load module="mod_say_en"/>
    <load module="mod_sndfile"/>            <!-- WAV playback + recording -->
    <load module="mod_native_file"/>        <!-- MP3 (for MoH) -->
    <load module="mod_local_stream"/>       <!-- Music on Hold -->
    <load module="mod_tone_stream"/>        <!-- silence_stream:// -->

    <!-- API integration (bindings empty in Phase 1; loaded for hot-add) -->
    <load module="mod_xml_curl"/>

    <!-- Codecs -->
    <!-- PCMU/PCMA are built into core; do not load explicitly. -->
    <load module="mod_opus"/>

    <!-- NOT loaded in Phase 1 (deferred to later modules):
         mod_callcenter   — I01 enables it (Phase 3 inbound)
         mod_avmd         — Phase 2 (E03 adaptive AMD)
         mod_voicemail    — Phase 3 (I05)
         mod_event_multicast — multi-FS (X03), not needed Phase 1

         Intentionally NEVER loaded:
         mod_xml_rpc      — insecure (HTTP only, default creds; per RESEARCH §1#4)
         mod_xml_cdr      — we use ESL events, not XML CDR push
         mod_amd          — we use mod_avmd (better quality per RESEARCH)
         mod_v8           — no JS dialplan
         mod_lua          — no Lua scripts in Phase 1
         mod_python3      — no Python scripts
         mod_h26x         — audio-only
         mod_vpx          — audio-only
         mod_curl         — no HTTP from dialplan in Phase 1
         mod_spandsp      — no fax / T.38
         mod_g729         — paid codec, skip for OSS
    -->
  </modules>
</configuration>
```

**14 modules loaded in Phase 1.** (RESEARCH §11 #10 listed 17 candidates;
PLAN drops `mod_callcenter` and `mod_avmd` to "deferred not loaded" since
they have zero Phase 1 use — loading them costs RAM and surface area for
no benefit. Phase 2/3 add them via a small modules.conf.xml diff.)

---

## 9. WebRTC certificate convention

### 9.1 Single combined PEM

`/etc/freeswitch/tls/wss.pem` contains, in order:
1. Server certificate (PEM)
2. Server private key (PEM)
3. Intermediate CA chain (PEM, concatenated)

`tls-cert-dir=/etc/freeswitch/tls` causes mod_sofia to discover `wss.pem`
automatically. Same file used for DTLS-SRTP fingerprint (no separate file
needed; symlinks `dtls-srtp.pem`, `agent.pem`, `cafile.pem` may be added
later for clarity but are not required Phase 1).

### 9.2 Dev path (mkcert)

`freeswitch/scripts/gen-dev-cert.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../tls"
command -v mkcert >/dev/null || { echo "Install mkcert and run 'mkcert -install' on host"; exit 1; }
mkcert -cert-file _cert.pem -key-file _key.pem \
  localhost 127.0.0.1 ::1 host.docker.internal "*.local" "$(hostname)"
cat _cert.pem _key.pem "$(mkcert -CAROOT)/rootCA.pem" > wss.pem
rm _cert.pem _key.pem
chmod 600 wss.pem
echo "wss.pem written. Restart FS: docker compose restart freeswitch"
```

Onboarding doc (HANDOFF.md) must say: **mkcert must be installed on the
host and `mkcert -install` run there**, so the host browser trusts the
generated CA. This is the #1 dev-onboarding pitfall (RESEARCH §11 #5).

### 9.3 Prod path (Let's Encrypt DNS-01)

Documented procedure for HANDOFF/runbook (not implemented in F03):
1. certbot with DNS-01 plugin (route53/cloudflare/etc.) issues cert for
   `fs.<domain>`.
2. Post-renewal hook script:
   ```bash
   cat /etc/letsencrypt/live/fs.<domain>/fullchain.pem \
       /etc/letsencrypt/live/fs.<domain>/privkey.pem \
       > /etc/freeswitch/tls/wss.pem
   chown freeswitch:freeswitch /etc/freeswitch/tls/wss.pem
   chmod 600 /etc/freeswitch/tls/wss.pem
   fs_cli -p "$FS_EVENT_SOCKET_PASSWORD" -x 'sofia profile wss restart'
   ```
3. cron via systemd timer; runs every 12h; certbot is idempotent.

**Known limitation:** `sofia profile wss restart` drops all WSS registrations
for ~3-5 seconds. SIP.js auto-reconnects. `rescan` does NOT reload the TLS
binding (sofia-sip limitation per RESEARCH §6.2 [27]); restart is mandatory.

---

## 10. Codec policy

| Profile | Inbound prefs | Outbound prefs | Why |
|---|---|---|---|
| `internal` | `PCMU,PCMA,OPUS,G722` | `PCMU,PCMA,OPUS,G722` | Hardphones — prefer cheap G.711 to avoid OPUS encode cost; G.722 wideband if endpoint supports |
| `external` | `PCMU,PCMA` | `PCMU,PCMA` | Carriers offer PSTN-grade only |
| `wss` | `OPUS,PCMU` | `OPUS,PCMU` | Browsers strongly prefer OPUS; PCMU fallback for ancient/edge cases |

mod_opus tuning (`autoload_configs/opus.conf.xml`):
```xml
<configuration name="opus.conf" description="Opus Codec">
  <settings>
    <param name="use-vbr" value="1"/>
    <param name="complexity" value="10"/>
    <param name="maxaveragebitrate" value="24000"/>     <!-- 24 kbps voice -->
    <param name="maxplaybackrate" value="48000"/>
    <param name="useinbandfec" value="1"/>              <!-- FEC for packet loss -->
    <param name="usedtx" value="1"/>                    <!-- DTX silence suppression -->
    <param name="sprop-stereo" value="0"/>
    <param name="stereo" value="0"/>
    <param name="adjust-bitrate" value="1"/>
  </settings>
</configuration>
```

Conference mixes at `rate=8000` (defensible Phase 1 default per RESEARCH §8.2) —
trades agent-side audio quality for ~6× lower mix CPU. A/B test in Phase 2 if
agents complain; switching to 16kHz/48kHz is a one-line change.

---

## 11. Tuning + kernel

### 11.1 `freeswitch/conf/autoload_configs/switch.conf.xml`

```xml
<configuration name="switch.conf" description="Core Configuration">
  <cli-keybindings>
    <key name="1" value="help"/>
    <key name="2" value="status"/>
    <key name="3" value="show channels"/>
    <key name="4" value="show calls"/>
    <key name="5" value="sofia status"/>
    <key name="6" value="reloadxml"/>
    <key name="7" value="console loglevel 0"/>
    <key name="8" value="console loglevel 7"/>
  </cli-keybindings>

  <default-ptimes/>

  <settings>
    <!-- Concurrency caps -->
    <param name="max-sessions" value="3000"/>                <!-- Below Artoo wall (~1796); per-instance cap -->
    <param name="sessions-per-second" value="50"/>           <!-- Burst guard for runaway dialer -->
    <param name="max-dtmf-duration" value="192000"/>
    <param name="min-dtmf-duration" value="400"/>

    <!-- Threading -->
    <param name="threadsmax" value="4000"/>                  <!-- Hard ceiling; Artoo will limit before this -->
    <param name="auto-create-schemas" value="true"/>
    <param name="enable-monotonic-timing" value="true"/>

    <!-- Logging -->
    <param name="loglevel" value="info"/>                    <!-- prod: info; debug only when troubleshooting -->
    <param name="colorize-console" value="true"/>

    <!-- RTP -->
    <param name="rtp-start-port" value="16384"/>
    <param name="rtp-end-port" value="32768"/>

    <!-- Dialplan -->
    <param name="dialplan-timestamps" value="false"/>

    <!-- DB -->
    <param name="core-db-dsn" value="sqlite:///$${db_dir}/core.db"/>   <!-- file in container; small -->
  </settings>
</configuration>
```

`max-sessions=3000` is intentional: above the Artoo soft-cap (~1796) so
operators see Artoo's protective log line ("Setting max sessions to ~1796 to
save the switch") rather than silent rejection. Per-FS practical ceiling is
~750 simultaneous bridged calls (1500 legs).

### 11.2 Container ulimits (compose `ulimits:` block + entrypoint)

Already declared in F01 PLAN compose for `freeswitch:` service; F03 PLAN
extends with stack ulimit:

```yaml
ulimits:
  nofile:
    soft: 1048576
    hard: 1048576
  nproc: 65535
  stack: 245760            # 240 KB per thread — CRITICAL for thread count
  core: -1
  memlock: -1
  rtprio: 99
```

Plus entrypoint sets `ulimit -s 240` (KB) explicitly before `exec freeswitch`,
since some Docker setups don't honor compose stack ulimit.

### 11.3 Host kernel tuning (documented for HANDOFF, not set by F03 inside container)

`/etc/sysctl.d/99-freeswitch.conf` on the host (operator runs):
```
fs.file-max = 1048576
net.core.rmem_max = 26214400
net.core.wmem_max = 26214400
net.core.rmem_default = 262144
net.core.wmem_default = 262144
net.core.netdev_max_backlog = 5000
net.ipv4.udp_mem = 65536 131072 262144
net.ipv4.ip_local_port_range = 1024 65535
net.netfilter.nf_conntrack_max = 1048576
```

`/etc/security/limits.conf`:
```
freeswitch  soft  nofile  1048576
freeswitch  hard  nofile  1048576
freeswitch  soft  nproc   65535
freeswitch  hard  nproc   65535
```

Containers cannot change kernel sysctls without `--privileged` (and we don't
want privileged mode). Host operator does this; F03 HANDOFF.md ships the
above as a runbook entry.

---

## 12. Dockerfile (refines F01 stub)

```dockerfile
# syntax=docker/dockerfile:1.7
FROM signalwire/freeswitch:1.10.12 AS base

ARG SIGNALWIRE_TOKEN

# Install only the modules we actually use (per modules.conf.xml allowlist §8).
# The base image ships freeswitch-meta-vanilla; we add OPUS + xml_curl explicitly,
# remove unused metas to slim image.
RUN --mount=type=secret,id=signalwire_token \
    set -eux; \
    if [ -f /run/secrets/signalwire_token ]; then \
      SIGNALWIRE_TOKEN="$(cat /run/secrets/signalwire_token)"; \
    fi; \
    [ -n "${SIGNALWIRE_TOKEN}" ] || { echo "SIGNALWIRE_TOKEN required"; exit 1; }; \
    echo "machine freeswitch.signalwire.com login signalwire password ${SIGNALWIRE_TOKEN}" > /etc/apt/auth.conf.d/signalwire.conf; \
    chmod 600 /etc/apt/auth.conf.d/signalwire.conf; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      freeswitch-mod-console \
      freeswitch-mod-logfile \
      freeswitch-mod-event-socket \
      freeswitch-mod-sofia \
      freeswitch-mod-loopback \
      freeswitch-mod-conference \
      freeswitch-mod-dptools \
      freeswitch-mod-commands \
      freeswitch-mod-db \
      freeswitch-mod-dialplan-xml \
      freeswitch-mod-say-en \
      freeswitch-mod-sndfile \
      freeswitch-mod-native-file \
      freeswitch-mod-local-stream \
      freeswitch-mod-tone-stream \
      freeswitch-mod-xml-curl \
      freeswitch-mod-opus \
      freeswitch-music-default \
      freeswitch-sounds-en-us-callie \
      gettext-base curl; \
    rm /etc/apt/auth.conf.d/signalwire.conf; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

# Strip any stale base configs; we mount our own.
RUN rm -rf /etc/freeswitch/* || true

# Copy our committed conf tree into the image (overlaid by bind-mount in dev).
COPY conf/ /etc/freeswitch/

# Entrypoint: env-substitute .tmpl files, set ulimit -s 240, exec FS.
COPY scripts/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY scripts/healthcheck.sh /usr/local/bin/healthcheck.sh
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/healthcheck.sh

# Recordings + logs as volumes
VOLUME ["/var/lib/freeswitch/recordings", "/var/log/freeswitch"]

# Healthcheck — fs_cli status returns "UP" when ready
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=5 \
  CMD /usr/local/bin/healthcheck.sh || exit 1

# Documented ports — operator must publish these (compose `ports:`)
EXPOSE 5060/udp 5060/tcp \
       5066/tcp \
       5080/udp 5080/tcp \
       7443/tcp \
       8021/tcp \
       16384-32768/udp

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["freeswitch", "-nf", "-nonat", "-c"]
```

`scripts/entrypoint.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail

# Stack-size mitigation for the Artoo R2D2 thread wall (RESEARCH §9.1)
ulimit -s 240 || true
ulimit -n 1048576 || true
ulimit -u 65535 || true

# Env-substitute .tmpl files in conf tree
shopt -s globstar nullglob
for tmpl in /etc/freeswitch/**/*.tmpl; do
  out="${tmpl%.tmpl}"
  envsubst < "$tmpl" > "$out"
done

exec "$@"
```

`scripts/healthcheck.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
PASS="${FS_EVENT_SOCKET_PASSWORD:-ClueCon}"
out="$(fs_cli -p "$PASS" -x 'status' 2>/dev/null || true)"
echo "$out" | grep -qE '^UP ' || exit 1
sofia="$(fs_cli -p "$PASS" -x 'sofia status' 2>/dev/null || true)"
# Expect 3 profiles RUNNING: internal, wss, external
[ "$(echo "$sofia" | grep -c RUNNING)" -ge 3 ] || exit 1
exit 0
```

---

## 13. `freeswitch/conf/vars.xml`

Env-defaults, substituted by entrypoint where needed. This is the single
configuration surface F03 exposes to compose env.

```xml
<include>
  <!-- Domain -->
  <X-PRE-PROCESS cmd="set" data="domain=$${local_ip_v4}"/>
  <X-PRE-PROCESS cmd="set" data="domain_name=$${domain}"/>
  <X-PRE-PROCESS cmd="set" data="hostname=freeswitch"/>

  <!-- Tenancy (Phase 1: single-tenant, value=1 per SPEC §4.5) -->
  <X-PRE-PROCESS cmd="set" data="tenant_id=1"/>

  <!-- Sofia ports -->
  <X-PRE-PROCESS cmd="set" data="internal_sip_port=5060"/>
  <X-PRE-PROCESS cmd="set" data="internal_tls_port=5061"/>
  <X-PRE-PROCESS cmd="set" data="external_sip_port=5080"/>
  <X-PRE-PROCESS cmd="set" data="wss_port=7443"/>
  <X-PRE-PROCESS cmd="set" data="ws_port=5066"/>

  <!-- NAT / public addressing — operator overrides via FS_* env in prod -->
  <X-PRE-PROCESS cmd="set" data="external_rtp_ip=auto-nat"/>
  <X-PRE-PROCESS cmd="set" data="external_sip_ip=auto-nat"/>

  <!-- Codecs -->
  <X-PRE-PROCESS cmd="set" data="internal_codec_prefs=PCMU,PCMA,OPUS,G722"/>
  <X-PRE-PROCESS cmd="set" data="external_codec_prefs=PCMU,PCMA"/>
  <X-PRE-PROCESS cmd="set" data="wss_codec_prefs=OPUS,PCMU"/>
  <X-PRE-PROCESS cmd="set" data="global_codec_prefs=PCMU,PCMA,OPUS,G722"/>
  <X-PRE-PROCESS cmd="set" data="outbound_codec_prefs=PCMU,PCMA,OPUS"/>

  <!-- Recording -->
  <X-PRE-PROCESS cmd="set" data="recordings_dir=/var/lib/freeswitch/recordings"/>

  <!-- Certs -->
  <X-PRE-PROCESS cmd="set" data="certs_dir=/etc/freeswitch/tls"/>

  <!-- ESL — populated by entrypoint envsubst from FS_EVENT_SOCKET_PASSWORD env -->
  <X-PRE-PROCESS cmd="set" data="esl_password=${FS_EVENT_SOCKET_PASSWORD}"/>

  <!-- Default password for static directory entries (F05 generates real ones) -->
  <X-PRE-PROCESS cmd="set" data="default_password=${FS_DEFAULT_SIP_PASSWORD}"/>

  <!-- Sound paths -->
  <X-PRE-PROCESS cmd="set" data="sound_prefix=$${sounds_dir}/en/us/callie"/>

  <!-- xml_curl future hookup -->
  <X-PRE-PROCESS cmd="set" data="xmlcurl_url=http://api:3000/internal/freeswitch"/>
  <X-PRE-PROCESS cmd="set" data="xmlcurl_user=${FS_XMLCURL_USER}"/>
  <X-PRE-PROCESS cmd="set" data="xmlcurl_pass=${FS_XMLCURL_PASS}"/>
</include>
```

`vars.xml` is the **only** file with `${ENV_VAR}` placeholders — entrypoint
runs `envsubst` over it (saved as `vars.xml.tmpl` → `vars.xml`). Other config
files use only `$${var}` (FS-internal var lookup) which doesn't need envsubst.

---

## 14. Hand-off interfaces (FROZEN after PLAN approval)

### 14.1 T01 (ESL bridge)
- **Connect to:** `host=freeswitch` (compose service name) or `host.docker.internal:8021` from non-network-mode-host containers; port `8021/TCP`.
- **Auth:** password from env `FS_EVENT_SOCKET_PASSWORD`.
- **ACL:** must connect from a CIDR in named ACL `esl_clients` (Docker bridge by default).
- **Reconnect contract:** T01 MUST implement reconnect-with-backoff; password rotation procedure is `fs_cli -x 'reload mod_event_socket'` which drops all clients.
- **Subscribed events:** T01 owns event filter; F03 documents recommended subscriptions in RESEARCH §7.4.

### 14.2 R01 (recording)
- **Path:** `/var/lib/freeswitch/recordings/<tenant_id>/<YYYY>/<MM>/<DD>/<campaign_id>_<lead_id>_<call_uuid>.wav`
- **Volume:** `freeswitch_recordings` (declared in F01 compose).
- **Format:** WAV PCM 8 kHz mono by default; stereo when `RECORD_STEREO=true` is set.
- **Lifecycle event:** `RECORD_STOP` event with `Record-File-Path`, `Record-Ms`, `Record-Read-Sample-Rate` headers.
- **Channel vars set by T03/T04 dialplan:** `RECORD_STEREO=true`, `RECORD_MIN_SEC=2`, `recording_follow_transfer=true`.

### 14.3 F05 (auth, SIP credentials)
- **Phase 1:** static directory — F05 generates one XML file per agent under `freeswitch/conf/directory/default/<username>.xml`, then triggers `fs_cli -x 'reloadxml'`.
- **Phase 2:** F05 may flip to `mod_xml_curl` `directory` binding by adding a snippet to `xml_curl.conf.xml` and `fs_cli -x 'reload mod_xml_curl'`. F03 reserves the binding shape (URL, basic-auth creds in `vars.xml`).
- **SIP password storage:** plaintext in directory XML for Phase 1 (file is mode 0600, owned by freeswitch user); F05 may move to xml_curl + DB lookup later.

### 14.4 I02 (DID inbound routing)
- **Dialplan extension point:** files numbered `dialplan/public/10_*.xml` through `dialplan/public/89_*.xml` are I02's territory. F03 ships only `99_drop_unauthenticated.xml` (catchall). Numbering convention frozen.
- **Reload:** I02 writes file → `fs_cli -x 'reloadxml'`.

### 14.5 X01 (rtpengine)
- **Future SDP rewrite point:** `apply-candidate-acl=webrtc_candidates` on the wss profile is the seam — X01 will replace this with `mod_rtpengine` channel-var driven SDP rewrite. F03 commits the named ACL placeholder (empty list) so X01 has a stable hook.
- **Codec offload:** X01 may bypass FS for SRTP entirely; conference profile rate stays 8 kHz to match.

### 14.6 X02 (Kamailio dispatcher)
- **Future hook:** Kamailio fronts FS at port 5060 (internal) and 5080 (external). F03's external profile `apply-inbound-acl=carriers` will be widened to include Kamailio's IP. WSS direct-to-FS unchanged Phase 3.5+.

### 14.7 O01 (metrics)
- **No FS-side metrics module loaded in Phase 1.** O01 will run a separate `freeswitch-exporter` Go binary as its own compose service; that service polls `fs_cli -x 'status'`, `'show channels count'`, `'show calls count'`, `'sofia status'` over ESL and emits Prometheus metrics on its own port. F03 commits the ESL surface; O01 owns the exporter.

### 14.8 T02 (carrier mgmt)
- **Gateway file location:** `freeswitch/conf/sip_profiles/external/<carrier_name>.xml`. T02 renders from `carriers` MySQL table.
- **Reload:** T02 writes file → `fs_cli -x 'sofia profile external rescan'` (no FS restart; gateway register/unregister happens in-stack).
- **ACL `carriers` population:** T02 writes `acl.conf.xml` `carriers` named-list from `carriers.ip_allowlist` JSON, then `fs_cli -x 'reloadacl'`.

### 14.9 T03 (agent conference dialplan)
- **Files:** T03 owns `01_agent_conference.xml`. F03 ships a working stub (§4.2) that T03 will replace.
- **Conference name pattern:** `agent_<user_id>@default` — frozen.

### 14.10 T04 (originate)
- **ESL command shape:** `bgapi originate {var1=...,var2=...}sofia/gateway/<carrier>/+1NXXNXXXXXX 'transfer:conf_<user_id> XML default' inline`
- Customer leg lands in `customer_into_agent_conf` extension (§4.2) which sets recording vars and joins the conference.

---

## 15. Files F03 IMPLEMENT will create

```
freeswitch/Dockerfile                                       (refines F01 stub)
freeswitch/scripts/entrypoint.sh
freeswitch/scripts/healthcheck.sh
freeswitch/scripts/gen-dev-cert.sh
freeswitch/conf/vars.xml.tmpl                               (envsubst→vars.xml)
freeswitch/conf/freeswitch.xml                              (root include — usually unchanged from base)
freeswitch/conf/autoload_configs/modules.conf.xml
freeswitch/conf/autoload_configs/switch.conf.xml
freeswitch/conf/autoload_configs/event_socket.conf.xml
freeswitch/conf/autoload_configs/xml_curl.conf.xml          (empty bindings)
freeswitch/conf/autoload_configs/conference.conf.xml
freeswitch/conf/autoload_configs/opus.conf.xml
freeswitch/conf/autoload_configs/local_stream.conf.xml      (MoH source dirs)
freeswitch/conf/autoload_configs/logfile.conf.xml           (rotation handed to host logrotate)
freeswitch/conf/autoload_configs/sofia.conf.xml             (loader pulling sip_profiles/*.xml)
freeswitch/conf/sip_profiles/internal.xml
freeswitch/conf/sip_profiles/wss.xml                         (NEW — 3-profile decision)
freeswitch/conf/sip_profiles/external.xml
freeswitch/conf/sip_profiles/internal/.gitkeep
freeswitch/conf/sip_profiles/external/.gitkeep
freeswitch/conf/sip_profiles/external/twilio.xml.tmpl
freeswitch/conf/sip_profiles/external/ringcentral.xml.tmpl
freeswitch/conf/sip_profiles/external/telnyx.xml.tmpl
freeswitch/conf/sip_profiles/external/signalwire.xml.tmpl
freeswitch/conf/sip_profiles/external/bandwidth.xml.tmpl
freeswitch/conf/sip_profiles/external/flowroute.xml.tmpl
freeswitch/conf/sip_profiles/external/generic-byoc.xml.tmpl
freeswitch/conf/dialplan/default/00_safety.xml
freeswitch/conf/dialplan/default/01_agent_conference.xml    (stub; T03 expands)
freeswitch/conf/dialplan/default/02_outbound.xml            (stub; T04 expands)
freeswitch/conf/dialplan/default/99_features.xml
freeswitch/conf/dialplan/public/99_drop_unauthenticated.xml
freeswitch/conf/directory/default/.gitkeep                   (F05 populates)
freeswitch/conf/acl.conf.xml
freeswitch/conf/lang/en/.gitkeep                             (sounds package owns the rest)
freeswitch/tls/.gitkeep                                      (gitignored content; gen-dev-cert.sh writes wss.pem)
freeswitch/tests/sipp/register.xml                           (SIPp scenario — registers a fake agent)
freeswitch/tests/sipp/options-ping.xml                       (SIPp scenario — OPTIONS to internal profile)
freeswitch/tests/esl/status_check.sh                         (bash test — connects to ESL, asserts RUNNING)
.env.example                                                 (F03 adds: FS_EVENT_SOCKET_PASSWORD, FS_DEFAULT_SIP_PASSWORD, FS_XMLCURL_USER, FS_XMLCURL_PASS, SIGNALWIRE_TOKEN doc)
```

`acl.conf.xml`:
```xml
<configuration name="acl.conf" description="Network Lists">
  <network-lists>
    <list name="domestic" default="deny">
      <node type="allow" cidr="127.0.0.0/8"/>
      <node type="allow" cidr="172.16.0.0/12"/>      <!-- Docker bridge family -->
      <node type="allow" cidr="10.0.0.0/8"/>
    </list>
    <list name="esl_clients" default="deny">
      <node type="allow" cidr="127.0.0.0/8"/>
      <node type="allow" cidr="172.16.0.0/12"/>
      <node type="allow" cidr="10.0.0.0/8"/>
    </list>
    <list name="carriers" default="deny">
      <!-- Empty in F03; T02 populates from carriers.ip_allowlist -->
    </list>
    <list name="webrtc_candidates" default="allow">
      <!-- Empty allow-default in F03; X01 may tighten -->
    </list>
  </network-lists>
</configuration>
```

---

## 16. Verification (F03 IMPLEMENT phase will record in VERIFY.md)

The 10 manual checks from F03.md remain unchanged. PLAN-time additions:

- [ ] `sofia status` shows **3 profiles** RUNNING: `internal`, `wss`, `external`.
- [ ] `sofia status profile wss` shows WSS binding on `:7443`.
- [ ] `sofia status profile external` shows ACL `carriers` applied (even if empty).
- [ ] `module list` count matches the 14-module allowlist (§8); no surprises.
- [ ] `acl list` shows 4 named ACLs: `domestic`, `esl_clients`, `carriers`, `webrtc_candidates`.
- [ ] From host: `openssl s_client -connect localhost:7443 -servername host.docker.internal` returns valid (mkcert-signed) cert.
- [ ] SIPp register scenario registers an agent against the `internal` profile (NOT the wss profile — wss is HTTP-WS handshake, SIPp can't do WSS easily; document).
- [ ] SIPp OPTIONS scenario gets 200 from `internal:5060` and `external:5080`.
- [ ] Healthcheck script returns 0; takes <2s.
- [ ] `docker stats vici2_freeswitch` shows ~80 MB RAM idle (3-profile + opus = slightly above the 50 MB target in F03.md; document).

---

## 17. Risks and open questions

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| sofia-sip TLS-binding hot-reload limitation forces brief WSS outage every 60 days for cert renewal | High | Medium | 3-profile design isolates blast radius. SIP.js auto-reconnects in <5s. Schedule renewals in low-traffic window. |
| SignalWire PAT requirement is permanent, blocks fully-public CI/builds | Medium | Medium | Token in repo CI secrets; document in HANDOFF; alternative is self-build from source (~30min CI cost, deferred). |
| FS 1.10.6 → 1.10.7 log-format change breaks fail2ban regexes < 3143 | Low | Low | Document for O05; we're on 1.10.12 — operator must use modern fail2ban regex set. |
| Artoo R2D2 wall ~1796 sessions per FS | Certain | Bounds Phase 1 to ~750 simultaneous bridged calls per instance | `ulimit -s 240` mitigates per-thread cost. Multi-FS via X02/X03 once we approach limit. |
| WebRTC SRTP ceiling ~150 concurrent without rtpengine offload (X01) | High | Medium | Accept Phase 1 cap of ~150 concurrent agents per FS; X01 raises to ~5000. |
| Mac dev: WebRTC + Docker bridge networking degraded | High | Medium | F01's `docker-compose.macos.yml` override + documentation. F03 inherits. |
| `mod_callcenter` not loaded in Phase 1 — I01 must add it via modules.conf.xml diff | Low | Low | Documented; I01 PLAN will see this and ship a one-line modules.conf.xml diff + `fs_cli -x 'load mod_callcenter'`. |
| `99_drop_unauthenticated.xml` numbering interaction with future I02-rendered files | Low | Low | Catchall is `99_*` (loads last alphabetically); I02 must use `10_*` through `89_*` range. Frozen in §14.4. |
| Cert provisioning ergonomics on dev (mkcert -install host requirement) | High | Low | gen-dev-cert.sh prints clear error if mkcert not on host. README + HANDOFF document it as #1 onboarding step. |

### 17.1 Open questions resolved at PLAN

| Open question (RESEARCH §11) | Resolution |
|---|---|
| 1. 2-profile vs 3-profile Sofia | **3 profiles** — see §1 |
| 2. Conference rate 8/16/48 kHz | **8 kHz** Phase 1 — see §10 |
| 3. Static vs xml_curl directory | **Static** Phase 1; xml_curl optional Phase 2 — see §14.3 |
| 4. TURN credentials in F03 | **Env vars defined, not consumed** — `TURN_URL`, `TURN_USERNAME`, `TURN_PASSWORD` in `.env.example`; A02 (SIP.js) and operator-deployed coturn share them. F03 doesn't ship coturn. |
| 5. Cert provisioning in Docker dev | **mkcert on host** — `gen-dev-cert.sh` documented as host-side prereq |
| 6. mod_callcenter empty config | **Not loaded Phase 1** — I01 enables. Avoids carrying empty conf + RAM cost. |
| 7. Logging strategy | **mod_console + mod_logfile both loaded.** Console for Docker stdout capture; logfile to `/var/log/freeswitch` mounted volume for forensics. logrotate is host's job per F01. |
| 8. Healthcheck | **`fs_cli status \| grep ^UP` + `sofia status \| grep -c RUNNING >= 3`** in `healthcheck.sh` (§12) |
| 9. mkcert in Dockerfile | **No** — `gen-dev-cert.sh` runs on host; cert mounted into container. |
| 10. Module list final cut | **14 modules** (§8) — narrower than RESEARCH's 17; mod_callcenter and mod_avmd deferred |

### 17.2 No RFCs raised

The 3-profile decision (§1) is recorded as a PLAN-time refinement of the
F03.md spec §"Key non-obvious decisions" #3 wording. Per SPEC §12, RFCs are
required when an interface change affects downstream consumers; downstream
modules (T01, T02, T03, T04, A02) see the same external ports and ESL surface
either way, and the change strictly expands capability. No RFC required.

---

End of PLAN.md.
