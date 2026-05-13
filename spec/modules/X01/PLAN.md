# X01 — rtpengine Integration: Implementation Plan

**Date:** 2026-05-13
**Status:** READY_FOR_IMPLEMENT
**Authored by:** PLAN agent (Sonnet 4.6)
**Research:** X01/RESEARCH.md

---

## 1. Goal and Success Criteria

Deploy `rtpengine` as a sidecar to FreeSWITCH in vici2's Docker Compose stack.
rtpengine offloads SRTP↔RTP transcoding from FreeSWITCH, lifting the documented
~150-concurrent-WebRTC-agent ceiling to a target of **500 concurrent WebRTC
agents** on a single production host.

### 1.1 Acceptance Criteria

- [ ] **Load test passes**: 500 concurrent WebRTC browser sessions (DTLS-SRTP)
      maintained for 10 minutes with zero packet loss > 1% and jitter < 20ms.
- [ ] **FS CPU halved**: CPU utilization for 250 concurrent WebRTC sessions is
      < 50% with rtpengine active (vs ~80% baseline without).
- [ ] **No regression on PSTN calls**: PSTN outbound/inbound calls continue to
      work through the carrier external profile with no quality degradation.
- [ ] **No regression on recording**: R01 stereo WAV recording still produces
      valid files; `RECORD_START`/`RECORD_STOP` ESL events still fire.
- [ ] **rtpengine healthcheck passes** on `docker compose up` within 30s.
- [ ] **`make test-rtpengine` passes** in CI (functional correctness test).
- [ ] **Prometheus metrics visible**: rtpengine metrics scraped successfully by
      vici2's Prometheus instance.
- [ ] **Dev Mac works** in userspace mode (no kernel module required).
- [ ] **Rollback tested**: reverting to FS-native SRTP takes < 5 minutes with
      zero outage via the documented procedure.
- [ ] **Documented prod tuning** in HANDOFF.md.

---

## 2. Deployment Topology

### 2.1 Physical Layout

rtpengine runs as a **sidecar container on the same host as FreeSWITCH**, using
`network_mode: host` to share the host's network stack. This gives:

- Sub-millisecond RTP latency between FS and rtpengine (loopback)
- rtpengine's kernel module can use the same NIC as FS (no cross-host RTP)
- Simplified port management (one host, one port range)
- Failure isolation matches the FS node granularity

```
┌──────────────────────────────────────────────────────────────────────┐
│  Host (Linux, production)   network_mode: host                       │
│                                                                      │
│  ┌──────────────────────┐      UDP:22222        ┌──────────────────┐ │
│  │  vici2_freeswitch    │ ──────────────────▶   │ vici2_rtpengine  │ │
│  │  (FreeSWITCH 1.10)   │                        │ (rtpengine)      │ │
│  │                      │ ◀── plain RTP ──────── │                  │ │
│  │  :5060 SIP           │    loopback            │  :22222 ng-ctrl  │ │
│  │  :5080 SIP external  │                        │  :30000-40000    │ │
│  │  :7443 WSS           │                        │   RTP range      │ │
│  │  :16384-32768 RTP*   │                        │                  │ │
│  └──────────────────────┘                        └──────────────────┘ │
│                                                           │           │
│  * FS RTP range shrinks after X01: FS only handles        │           │
│    loopback/conference legs; rtpengine handles external   │           │
│    RTP to/from browsers and carriers.                     │           │
│                                                           │ kernel    │
│  ┌────────────────────────────────────────────────────────▼─────────┐ │
│  │   xt_RTPENGINE kernel module (prod only; loaded on host)         │ │
│  │   Packet forwarding table: browser↔rtpengine↔FS loopback        │ │
│  └─────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
        ▲                                         ▲
        │ WSS (SIP + DTLS-SRTP media)             │ SIP/RTP
   Browsers                                  Carriers
```

### 2.2 Port Assignments

| Service | Protocol | Port | Notes |
|---|---|---|---|
| rtpengine ng-control | UDP | 22222 | Bound to `127.0.0.1` only (localhost) |
| rtpengine RTP range | UDP | 30000–40000 | Public-facing; browsers and carriers reach this |
| FreeSWITCH SIP internal | UDP/TCP | 5060 | Unchanged |
| FreeSWITCH SIP external | UDP/TCP | 5080 | Unchanged |
| FreeSWITCH WSS | TCP | 7443 | Unchanged |
| FreeSWITCH RTP (loopback only) | UDP | 16384–32768 | After X01: only used for conference loopback |

**The key change**: browsers and carriers send/receive RTP to the rtpengine port
range (30000–40000), not to FS's port range. FS's RTP port range is still
configured but only used for conference loopback legs (internal mixing).

---

## 3. Files to Create

### 3.1 Complete File List

```
infra/rtpengine/
  Dockerfile                          # rtpengine container image
  rtpengine.conf.example              # annotated config reference
  entrypoint.sh                       # kernel-mode detection + startup
  healthcheck.sh                      # ng-protocol statistics ping

freeswitch/conf/
  dialplan/default/50_rtpengine.xml   # dialplan apps for WSS + external legs
  autoload_configs/rtpengine.conf.xml # mod_rtpengine module config

infra/observability/prometheus/
  rules/rtpengine.rules.yml           # alert rules for rtpengine metrics

docker-compose.dev.yml               # add rtpengine service (MODIFY existing)
docker-compose.macos.yml             # Mac override: userspace mode (MODIFY)
```

**Files modified (not created):**
```
freeswitch/conf/sip_profiles/wss.xml           # disable FS-native SRTP
freeswitch/conf/sip_profiles/external.xml      # no change (carrier is plain RTP)
freeswitch/conf/autoload_configs/modules.conf.xml  # add mod_rtpengine
infra/observability/prometheus/prometheus.yml  # add rtpengine scrape target
```

---

## 4. File Specifications

### 4.1 `infra/rtpengine/Dockerfile`

```dockerfile
# infra/rtpengine/Dockerfile
# X01 — rtpengine sidecar for FreeSWITCH SRTP offload.
# Base: Debian Bookworm to match SignalWire FS base image.
# Kernel module compilation is NOT done here — the module is built against
# the host kernel and loaded on the host. The container runs in userspace mode
# by default; kernel mode is enabled at runtime via RTPENGINE_KERNEL_MODE=1.

ARG RTPENGINE_VERSION=mr12.5
FROM debian:bookworm-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
    rtpengine \
    rtpengine-utils \
    librtpengine-dev \
    # For healthcheck
    netcat-openbsd \
    && rm -rf /var/lib/apt/lists/*

# Copy config and scripts
COPY rtpengine.conf.example /etc/rtpengine/rtpengine.conf.example
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY healthcheck.sh /usr/local/bin/healthcheck.sh
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/healthcheck.sh

# Default RTP port range: 30000-40000 (10,000 ports = 5,000 concurrent streams)
EXPOSE 22222/udp
EXPOSE 30000-40000/udp

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
```

**Note**: The Sipwise `rtpengine` package for Debian Bookworm is available from
the Sipwise APT repository (`deb https://deb.sipwise.com/spce/ bookworm main`).
Verify the package name before implementation — it may be `ngcp-rtpengine` in
some repo configurations. Alternative: build from source using the GitHub release
tag `mr12.5` (current stable as of 2025).

### 4.2 `infra/rtpengine/entrypoint.sh`

```bash
#!/bin/bash
# infra/rtpengine/entrypoint.sh
# X01: rtpengine startup with optional kernel module detection.
set -euo pipefail

RTPENGINE_KERNEL_MODE="${RTPENGINE_KERNEL_MODE:-0}"
RTPENGINE_INTERFACE="${RTPENGINE_INTERFACE:-0.0.0.0}"
RTPENGINE_NG_PORT="${RTPENGINE_NG_PORT:-22222}"
RTPENGINE_PORT_MIN="${RTPENGINE_PORT_MIN:-30000}"
RTPENGINE_PORT_MAX="${RTPENGINE_PORT_MAX:-40000}"
RTPENGINE_TOS="${RTPENGINE_TOS:-184}"  # DSCP EF = 0xB8 = 184
RTPENGINE_LOG_LEVEL="${RTPENGINE_LOG_LEVEL:-5}"  # 5=INFO, 7=DEBUG
RTPENGINE_RECORDING_DIR="${RTPENGINE_RECORDING_DIR:-/var/lib/rtpengine/recordings}"
RTPENGINE_TABLE="${RTPENGINE_TABLE:-0}"  # kernel module table id

mkdir -p "${RTPENGINE_RECORDING_DIR}"

KERNEL_ARGS=""
if [ "${RTPENGINE_KERNEL_MODE}" = "1" ]; then
    if [ -e /proc/rtpengine/control ]; then
        echo "[rtpengine] Kernel module detected; enabling kernel forwarding (table=${RTPENGINE_TABLE})"
        KERNEL_ARGS="--table=${RTPENGINE_TABLE}"
    else
        echo "[rtpengine] WARNING: RTPENGINE_KERNEL_MODE=1 but /proc/rtpengine/control not found. Falling back to userspace mode."
        echo "[rtpengine] Run 'modprobe xt_RTPENGINE' on the host to enable kernel mode."
    fi
else
    echo "[rtpengine] Running in userspace mode (RTPENGINE_KERNEL_MODE=${RTPENGINE_KERNEL_MODE})"
    KERNEL_ARGS="--no-kernel-forwarding"
fi

exec /usr/sbin/rtpengine \
    --interface="${RTPENGINE_INTERFACE}" \
    --listen-ng="127.0.0.1:${RTPENGINE_NG_PORT}" \
    --listen-ng-udp="127.0.0.1:${RTPENGINE_NG_PORT}" \
    --port-min="${RTPENGINE_PORT_MIN}" \
    --port-max="${RTPENGINE_PORT_MAX}" \
    --tos="${RTPENGINE_TOS}" \
    --log-level="${RTPENGINE_LOG_LEVEL}" \
    --log-stderr \
    --recording-dir="${RTPENGINE_RECORDING_DIR}" \
    --recording-method=pcap \
    --foreground \
    ${KERNEL_ARGS} \
    "$@"
```

**Kernel module loading (production host, run once after boot):**
```bash
# On the host (not in the container):
modprobe xt_RTPENGINE
# Make it persistent:
echo "xt_RTPENGINE" >> /etc/modules-load.d/rtpengine.conf
```

### 4.3 `infra/rtpengine/rtpengine.conf.example`

This is the reference config file. The container uses CLI flags (more
Docker-friendly than file config), but this file documents all options for
operators.

```ini
# infra/rtpengine/rtpengine.conf.example
# X01 — rtpengine reference configuration.
# The production container uses CLI flags from entrypoint.sh; this file is for
# operator reference and non-containerized deployments.
#
# Docs: https://github.com/sipwise/rtpengine/blob/master/README.md

[rtpengine]

# Network interface for RTP (public IP or interface name).
# In host-network mode, the host's public IP is used automatically.
# Set to a specific IP if the host is multi-homed.
interface = 0.0.0.0

# ng-control protocol: listen only on loopback (FS sends locally).
listen-ng = 127.0.0.1:22222
listen-ng-udp = 127.0.0.1:22222

# RTP port range. 10,000 ports = 5,000 concurrent streams.
# Each stream requires 2 ports (RTP + RTCP); each call = 2 streams = 4 ports.
# 10,000 ports / 4 = 2,500 concurrent bridged calls maximum.
# If 500 concurrent agents are the target: 500 × 2 streams × 2 ports = 2,000 ports.
# Add 5x headroom for setup/teardown overlap: 10,000 is appropriate.
port-min = 30000
port-max = 40000

# DSCP marking for QoS. 184 = 0xB8 = DSCP EF (Expedited Forwarding).
# Ensure network path honors DSCP or this is a no-op.
tos = 184

# Kernel forwarding. Remove this line (or set table=0) to enable kernel mode.
# Default is no-kernel-forwarding for Docker Desktop compatibility.
no-kernel-forwarding = true

# Logging. 5=INFO is appropriate for production. 7=DEBUG for troubleshooting.
log-level = 5
log-stderr = true

# Recording (optional diagnostic PCAP; not the primary recording mechanism).
# R01 recording (FS record_session) remains the primary recording path.
recording-dir = /var/lib/rtpengine/recordings
recording-method = pcap

# RTCP. Generate synthetic RTCP toward FS to normalize browser RTCP quirks.
# "generate RTCP" flag is passed per-call in the ng offer; not a global setting.

# Homer/HEPv3 mirroring (optional; enable if you run a Homer SIP capture server).
# homer = 127.0.0.1:9060
# homer-protocol = udp
# homer-id = 2000
```

### 4.4 `infra/rtpengine/healthcheck.sh`

rtpengine has no HTTP health endpoint. We probe the ng-protocol socket.

```bash
#!/bin/bash
# infra/rtpengine/healthcheck.sh
# X01: rtpengine health probe via ng-protocol statistics command.
# ng-protocol uses bencode over UDP. We send a statistics request and check
# for a non-error response. Uses nc (netcat) in UDP mode.
#
# Timeout: 2s. If rtpengine is healthy, response comes in < 50ms.
set -euo pipefail

NG_HOST="${RTPENGINE_NG_HOST:-127.0.0.1}"
NG_PORT="${RTPENGINE_NG_PORT:-22222}"
COOKIE="healthcheck_$(date +%s)"

# Bencode for: {"command": "statistics"}
# Format: <cookie> <SP> d7:command10:statisticse
REQUEST="${COOKIE} d7:command10:statisticse"

RESPONSE=$(printf '%s' "${REQUEST}" | nc -u -w 2 "${NG_HOST}" "${NG_PORT}" 2>/dev/null || true)

if echo "${RESPONSE}" | grep -q "${COOKIE}"; then
    exit 0
else
    echo "[rtpengine healthcheck] No valid response from ${NG_HOST}:${NG_PORT}" >&2
    exit 1
fi
```

### 4.5 `freeswitch/conf/dialplan/default/50_rtpengine.xml`

This dialplan file intercepts calls at the WSS leg (browser WebRTC) and passes
SDPs through rtpengine before sending them onward. It applies `rtpengine_offer`
on new calls and `rtpengine_answer` on the answering leg.

```xml
<?xml version="1.0"?>
<!--
  X01 — rtpengine dialplan integration.
  Applies rtpengine SDP proxying to WebRTC (WSS profile) legs.

  Priority: 50 — after 45_safe_harbor.xml, before 60_ingroup.xml.
  Pattern: only apply to calls arriving via the wss Sofia profile
  (detected by channel variable ${sofia_profile_name}).

  What this does:
    rtpengine_offer: intercepts the SDP from the browser before FS processes
      it; sends it to rtpengine; rtpengine returns a rewritten SDP pointing
      the browser's RTP at rtpengine (port 30000-40000). FS uses this
      rewritten SDP in its DTLS negotiation with the browser... except:
      rtpengine acts as the DTLS server. FS no longer does SRTP.

    rtpengine_answer: called on the answering leg to complete the offer/answer
      exchange. rtpengine finalises the forwarding rule.

  IMPORTANT: The continue="true" on the rtpengine extensions ensures that
  the call falls through to the appropriate routing extension (01_agent_conference,
  02_outbound, etc.). rtpengine extensions are purely media-plane interceptors.

  Flags passed to rtpengine offer:
    ICE=remove        — strip ICE candidates; rtpengine is the media endpoint
    DTLS=passive      — rtpengine handles DTLS handshake with the browser
    SRTP=default      — use SRTP toward the browser; plain RTP toward FS
    replace           — rewrite SDP o= and c= connection lines
    generate RTCP     — rtpengine synthesizes RTCP toward FS
-->
<include>
  <context name="default">

    <!--
      rtpengine_offer fires on the A-leg (incoming WSS call from browser).
      Condition: sofia_profile_name = "wss" identifies browser WebRTC calls.
      continue=true: fall through to the routing extension after this one.
    -->
    <extension name="rtpengine_offer_wss" continue="true">
      <condition field="${sofia_profile_name}" expression="^wss$">
        <action application="set" data="rtpengine_offer_flags=ICE=remove DTLS=passive SRTP=default replace-origin replace-session-connection generate-RTCP codec-transcode-pcmu"/>
        <action application="rtpengine_offer" data="${rtpengine_offer_flags}"/>
        <action application="log" data="INFO [X01] rtpengine_offer applied: call-id=${call_id} uuid=${uuid}"/>
      </condition>
    </extension>

    <!--
      rtpengine_answer fires on the B-leg after FS has created the answering
      channel. This applies to outbound carrier legs initiated by T04 originate.
      condition: rtpengine_offer_set=true means offer was already applied
      (set by mod_rtpengine after rtpengine_offer runs on the A-leg).
    -->
    <extension name="rtpengine_answer_carrier" continue="true">
      <condition field="${rtpengine_offer_set}" expression="^true$">
        <action application="rtpengine_answer" data=""/>
        <action application="log" data="INFO [X01] rtpengine_answer applied: call-id=${call_id} uuid=${uuid}"/>
      </condition>
    </extension>

  </context>
</include>
```

### 4.6 `freeswitch/conf/autoload_configs/rtpengine.conf.xml`

`mod_rtpengine` configuration — points it at the rtpengine instance.

```xml
<?xml version="1.0"?>
<!--
  X01 — mod_rtpengine module configuration.
  mod_rtpengine connects to rtpengine via the ng-protocol UDP socket.
  The proxy is on localhost (sidecar topology).
-->
<configuration name="rtpengine.conf" description="rtpengine module configuration">
  <settings>
    <!-- ng-control UDP address of rtpengine. Sidecar: always 127.0.0.1:22222 -->
    <param name="proxy-ip" value="127.0.0.1"/>
    <param name="proxy-port" value="22222"/>

    <!-- UDP timeout for ng-protocol responses (ms). 500ms is generous. -->
    <param name="timeout" value="500"/>

    <!-- If rtpengine is unreachable, fall back to native FS SRTP.
         This is the safety net: if rtpengine crashes, calls degrade
         gracefully to FS-native SRTP rather than failing entirely. -->
    <param name="pass-through" value="true"/>

    <!-- Bencode cookie prefix (for log correlation) -->
    <param name="cookie" value="vici2"/>
  </settings>
</configuration>
```

### 4.7 Modifications to `freeswitch/conf/sip_profiles/wss.xml`

After X01, the WSS profile's SRTP handling must be adjusted. rtpengine becomes
the DTLS endpoint, so FS should use plain RTP on the rtpengine-facing leg.
However, the `rtp-secure-media = mandatory` setting in the WSS profile controls
what FS advertises in SDP _to the browser_, not what FS uses internally.

With `mod_rtpengine` active, FS's SDP toward the browser is intercepted and
rewritten by rtpengine before it reaches the browser. The FS-internal setting for
`rtp-secure-media` only affects the FS-to-rtpengine leg. We want:
- FS ↔ rtpengine: **plain RTP** (no crypto overhead)
- rtpengine ↔ browser: **DTLS-SRTP** (handled entirely by rtpengine)

**Change:**
```xml
<!-- BEFORE (wss.xml, current) -->
<param name="rtp-secure-media" value="mandatory"/>
<param name="rtp-secure-media-inbound" value="mandatory"/>
<param name="rtp-secure-media-outbound" value="mandatory"/>

<!-- AFTER (wss.xml, X01) -->
<!-- rtpengine handles DTLS-SRTP toward the browser; FS uses plain RTP
     on the FS↔rtpengine loopback leg. mod_rtpengine rewrites SDPs. -->
<param name="rtp-secure-media" value="optional"/>
<!-- rtp-secure-media-inbound and rtp-secure-media-outbound removed;
     mod_rtpengine controls per-call crypto via ng-protocol offer flags. -->
```

**IMPORTANT**: This change must be applied atomically with enabling
`mod_rtpengine` in `modules.conf.xml`. Applying the wss.xml change without the
module active will break WebRTC calls (no SRTP = browser rejects connection).

### 4.8 Modifications to `freeswitch/conf/autoload_configs/modules.conf.xml`

Add `mod_rtpengine` to the module load list, alongside existing telephony modules.

```xml
<!-- Add after <load module="mod_sofia"/>: -->
<!-- X01: rtpengine SDP proxy for SRTP offload. Must come after mod_sofia. -->
<load module="mod_rtpengine"/>
```

### 4.9 `docker-compose.dev.yml` — rtpengine Service Addition

Add the following service block to `docker-compose.dev.yml`:

```yaml
  rtpengine:
    build:
      context: ./infra/rtpengine
    image: vici2/rtpengine:mr12.5
    container_name: vici2_rtpengine
    restart: unless-stopped
    # Must share host network with freeswitch for loopback RTP and kernel mode.
    network_mode: host
    cap_add:
      # CAP_NET_ADMIN: required for kernel mode nftables rule installation.
      # In userspace mode (dev), these caps are unused but harmless.
      - NET_ADMIN
      - SYS_MODULE
    environment:
      RTPENGINE_INTERFACE: "0.0.0.0"
      RTPENGINE_NG_PORT: "22222"
      RTPENGINE_PORT_MIN: "30000"
      RTPENGINE_PORT_MAX: "40000"
      RTPENGINE_TOS: "184"
      RTPENGINE_LOG_LEVEL: "${RTPENGINE_LOG_LEVEL:-5}"
      # Set to "1" on Linux production hosts after loading xt_RTPENGINE kernel module.
      RTPENGINE_KERNEL_MODE: "${RTPENGINE_KERNEL_MODE:-0}"
      RTPENGINE_RECORDING_DIR: "/var/lib/rtpengine/recordings"
    volumes:
      - rtpengine_recordings:/var/lib/rtpengine/recordings
    healthcheck:
      test: ["CMD", "/usr/local/bin/healthcheck.sh"]
      interval: 15s
      timeout: 5s
      retries: 5
      start_period: 20s
    # rtpengine must be healthy before freeswitch starts mod_rtpengine.
    # Note: freeswitch's depends_on is currently not set (it uses network_mode:host);
    # the pass-through=true in rtpengine.conf.xml handles startup races gracefully.
```

Also add the volume declaration:
```yaml
volumes:
  # ... existing volumes ...
  rtpengine_recordings:
```

### 4.10 `docker-compose.macos.yml` — Mac Override

Mac Docker Desktop cannot use `network_mode: host` for the same semantics as
Linux. The Mac override forces userspace mode and uses Docker bridge networking
for the rtpengine service, with port publishing.

```yaml
# docker-compose.macos.yml additions for X01:
services:
  rtpengine:
    network_mode: bridge  # Override host mode for Mac
    networks: [vici2_default]
    environment:
      # Kernel module is never available on Mac; force userspace.
      RTPENGINE_KERNEL_MODE: "0"
      # On Mac, rtpengine is not on the same host as FS; ng-control goes
      # via Docker bridge. FS's rtpengine.conf.xml must use container IP.
      # Set this to "rtpengine" (Docker service name resolves to container IP).
      RTPENGINE_NG_HOST: "rtpengine"
    ports:
      - "22222:22222/udp"
      - "30000-31000:30000-31000/udp"  # Limited range for dev (1,000 ports)

  freeswitch:
    environment:
      # On Mac, FS must reach rtpengine via the Docker bridge, not loopback.
      # mod_rtpengine picks up RTPENGINE_PROXY_IP if mod_rtpengine supports it;
      # otherwise, patch rtpengine.conf.xml proxy-ip to use Docker service name.
      RTPENGINE_PROXY_IP: "rtpengine"
      RTPENGINE_PROXY_PORT: "22222"
```

**Mac caveat**: Even with the bridge override, RTP media from browsers to the
Mac Docker Desktop stack will have NAT issues (same as all RTP on Mac Docker).
Developers should use a Linux VM or the `docker-compose.macos.yml` with reduced
expectations for full media flow. The primary dev flow on Mac is running unit
tests and smoke tests; full load testing requires a Linux environment. This is
the same caveat documented for F03 in DESIGN.md.

---

## 5. Sofia Profile Changes Summary

| Profile | Before X01 | After X01 |
|---|---|---|
| `wss.xml` | `rtp-secure-media=mandatory` | `rtp-secure-media=optional`; DTLS handled by rtpengine |
| `internal.xml` | `rtp-secure-media=optional` | No change; internal profile calls are plain RTP or SDES |
| `external.xml` | `rtp-secure-media=false` | No change; carrier calls are plain RTP |

The wss.xml change is the only structural Sofia profile change. The `optional`
value allows FS to use plain RTP when mod_rtpengine rewrites the SDP, while still
accepting SRTP on calls that do NOT go through rtpengine (e.g., if rtpengine is
in pass-through mode due to a restart).

---

## 6. Monitoring and Alerting

### 6.1 rtpengine Prometheus Metrics

rtpengine exposes metrics via the ng-protocol `statistics` command. A companion
**rtpengine-exporter** Prometheus scraper translates ng-protocol statistics into
Prometheus format.

The exporter (e.g., `sipwise/rtpengine-prometheus-exporter` or a custom Go
service) is deployed as a lightweight sidecar next to rtpengine. Alternatively,
rtpengine ships with a built-in `/metrics` HTTP endpoint if compiled with
`--enable-prometheus-endpoint`.

**Recommended: use rtpengine's built-in Prometheus endpoint** (available in
`mr11.0+`):

Add to `entrypoint.sh`:
```bash
--prometheus-listen=0.0.0.0:9109 \
--prometheus-prefix=rtpengine_ \
```

The entrypoint and Dockerfile should expose port 9109. Add a scrape target to
Prometheus:

```yaml
# infra/observability/prometheus/prometheus.yml addition:
  - job_name: 'rtpengine'
    static_configs:
      - targets: ['localhost:9109']
    scrape_interval: 15s
```

### 6.2 Key Metrics

| Metric | Description | Alert threshold |
|---|---|---|
| `rtpengine_calls_total` | Total calls processed (counter) | Rate drop > 50% in 5m |
| `rtpengine_sessions_current` | Active call sessions | > 4,500 (90% of capacity) |
| `rtpengine_streams_current` | Active RTP streams | > 9,000 (90% of port range) |
| `rtpengine_packets_forwarded_total` | RTP packets forwarded (counter) | Rate drop while calls > 0 |
| `rtpengine_errors_total` | Error counter by type | Any rate > 0 sustained 5m |
| `rtpengine_ng_errors_total` | ng-protocol errors | Any rate > 0 sustained 1m |
| `rtpengine_port_unavailable_total` | Port range exhaustion events | Any occurrence |
| `rtpengine_kernel_calls_total` | Calls forwarded by kernel (0 in userspace mode) | Unexpectedly 0 in prod kernel mode |

### 6.3 Alert Rules (`infra/observability/prometheus/rules/rtpengine.rules.yml`)

```yaml
groups:
  - name: rtpengine
    rules:
      - alert: RtpengineDown
        expr: up{job="rtpengine"} == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "rtpengine is down"
          description: "rtpengine Prometheus endpoint unreachable for 1m. WebRTC call quality degrading; FS in pass-through SRTP mode."

      - alert: RtpenginePortExhaustion
        expr: rtpengine_port_unavailable_total > 0
        for: 0m
        labels:
          severity: warning
        annotations:
          summary: "rtpengine port range exhausted"
          description: "rtpengine cannot allocate ports for new calls. Expand port-min/port-max range. Current active streams: {{ $value }}"

      - alert: RtpengineHighSessionLoad
        expr: rtpengine_sessions_current > 4500
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "rtpengine approaching session capacity"
          description: "rtpengine has {{ $value }} active sessions (threshold: 4500/5000). Consider adding another FS/rtpengine node."

      - alert: RtpengineNgErrors
        expr: rate(rtpengine_ng_errors_total[5m]) > 0.1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "rtpengine ng-protocol errors elevated"
          description: "rtpengine is returning ng-protocol errors. Check FS mod_rtpengine configuration and rtpengine logs."
```

---

## 7. Migration Plan

### 7.1 Phase Rollout

X01 migration is designed to be zero-downtime using FS's `pass-through = true`
safety net in `rtpengine.conf.xml`.

**Phase 1 (Box 1 only — 0% → 100% on one node):**
1. Deploy rtpengine container on the first FS node (or the single dev/staging
   node).
2. `docker compose up rtpengine` — rtpengine starts; no calls affected yet
   (mod_rtpengine not loaded).
3. Verify rtpengine healthcheck passes.
4. Verify Prometheus metrics visible.
5. Enable `mod_rtpengine`: add to `modules.conf.xml`; apply wss.xml change.
6. Restart FS (`docker compose restart freeswitch`) — all subsequent calls on
   this node go through rtpengine.
7. Monitor for 30 minutes: check call quality, FS CPU, rtpengine metrics.

**Phase 2 (10% of production traffic):**
1. Apply to one of N production FS nodes.
2. Use load balancer sticky-session routing to direct ~10% of WebRTC traffic to
   this node.
3. Monitor for 24 hours.
4. If no incidents: proceed to Phase 3.

**Phase 3 (100% of production):**
1. Apply rtpengine to all remaining FS nodes.
2. Roll out one node at a time with 15-minute monitoring windows between nodes.
3. Confirm acceptance criteria (500-concurrent load test).

### 7.2 Rollback Plan

The rollback procedure is fast because `pass-through = true` is always enabled.

**Soft rollback (degrade gracefully, no restart):**
- If rtpengine container crashes, `pass-through = true` causes mod_rtpengine to
  fall back to FS-native SRTP for new calls. In-flight calls on rtpengine are
  dropped (RTP forwarding stops).
- Action: `docker compose restart rtpengine`
- New calls immediately go through rtpengine again after restart.
- In-flight call drop window: duration of rtpengine restart (~5 seconds).

**Hard rollback (remove rtpengine, revert to FS-native SRTP):**
1. Revert `freeswitch/conf/sip_profiles/wss.xml` (restore `rtp-secure-media=mandatory`).
2. Remove `<load module="mod_rtpengine"/>` from `modules.conf.xml`.
3. `docker compose restart freeswitch`
4. `docker compose stop rtpengine`
5. In-flight calls: dropped during FS restart (unavoidable for hard rollback).

**Target rollback time: < 5 minutes** (mostly the FS restart ~30s + config change).

Git tag the config state before X01 goes to production so `git checkout <pre-x01-tag>`
restores all config files.

---

## 8. Load Test Specification

### 8.1 Tools

- **SIPp + custom scenario**: simulate 500 WebRTC browser registrations and
  concurrent calls. Use SIPp with a WebRTC-compatible scenario (DTLS-SRTP offer).
  Note: SIPp does not natively support DTLS-SRTP; use `sipp-tls` build with
  a custom script that pre-negotiates DTLS outside SIPp and feeds SRTP streams.
  Alternative: use `baresip` or `sipml5` for browser-compatible DTLS-SRTP load
  testing.
- **RTP stream generator**: once calls are established, generate constant 50 pps
  RTP/SRTP streams for the duration of the test.
- **Measurement**: Prometheus metrics for packet loss, jitter, MOS (rtpengine
  exposes estimated MOS via `query` command).

### 8.2 Test Procedure

```bash
# make test-rtpengine-load
# 1. Pre-condition: rtpengine running, kernel module loaded (prod only)
# 2. Ramp: 50 concurrent calls/minute until 500 total
# 3. Sustain: hold 500 concurrent for 10 minutes
# 4. Assert: packet_loss < 1%, jitter_p95 < 20ms, MOS > 3.5
# 5. Ramp down: hang up 50 calls/minute
# 6. Post: verify rtpengine sessions_current returns to 0
```

### 8.3 Acceptance Verification

| Metric | Pass Threshold | Measurement Method |
|---|---|---|
| Concurrent WebRTC sessions | 500 | `rtpengine_sessions_current` Prometheus metric |
| Packet loss | < 1% | `rtpengine_packets_lost_total` / `rtpengine_packets_total` |
| Jitter (p95) | < 20ms | rtpengine `query` RTCP data |
| MOS estimate | > 3.5 (4.0 target) | rtpengine `query` MOS field |
| FS CPU during 500-session test | < 50% on 4-core | `node_cpu_seconds_total` Prometheus |
| rtpengine CPU during 500-session test | < 30% userspace, < 10% kernel | `node_cpu_seconds_total` for container |
| Calls established successfully | > 99.5% | SIPp 200 OK counter |
| Test duration without failure | 10 minutes | No alert fires, no call drops |

---

## 9. Implementation Task Breakdown

### 9.1 Tasks (Ordered)

| # | Task | File(s) | Est. LOC | Notes |
|---|---|---|---|---|
| 1 | rtpengine Dockerfile | `infra/rtpengine/Dockerfile` | ~30 | Build from Sipwise Debian package |
| 2 | entrypoint.sh | `infra/rtpengine/entrypoint.sh` | ~50 | Kernel mode detection |
| 3 | healthcheck.sh | `infra/rtpengine/healthcheck.sh` | ~20 | nc-based ng-probe |
| 4 | rtpengine.conf.example | `infra/rtpengine/rtpengine.conf.example` | ~60 | Reference config, annotated |
| 5 | Dialplan apps | `freeswitch/conf/dialplan/default/50_rtpengine.xml` | ~50 | rtpengine_offer/answer XML |
| 6 | mod_rtpengine config | `freeswitch/conf/autoload_configs/rtpengine.conf.xml` | ~20 | Points to localhost:22222 |
| 7 | modules.conf.xml patch | `freeswitch/conf/autoload_configs/modules.conf.xml` | +2 | Add mod_rtpengine load |
| 8 | wss.xml patch | `freeswitch/conf/sip_profiles/wss.xml` | ~3 | Change rtp-secure-media |
| 9 | docker-compose.dev.yml | `docker-compose.dev.yml` | ~30 | Add rtpengine service |
| 10 | docker-compose.macos.yml | `docker-compose.macos.yml` | ~20 | Mac bridge network override |
| 11 | Prometheus scrape config | `infra/observability/prometheus/prometheus.yml` | +5 | Add rtpengine scrape job |
| 12 | Alert rules | `infra/observability/prometheus/rules/rtpengine.rules.yml` | ~40 | 4 alert rules |
| 13 | Load test script | `freeswitch/tests/load/rtpengine_load.sh` | ~80 | 500-concurrent test |
| 14 | Kernel module install doc | `infra/rtpengine/KERNEL_MODULE.md` | ~60 | Host-level setup for prod |

**Total estimated LOC**: ~470 lines across 14 files (mostly config and shell scripts, no application code changes).

### 9.2 Implementation Agent Type

**sre / telephony** agent: The work is primarily Docker configuration, FS XML
dialplan, and shell scripting. No Node.js, Go, or SQL changes are required.

### 9.3 Dependencies from Other Modules

- **F03** (FreeSWITCH base config): must be implemented and the Dockerfile must
  be buildable. X01 adds `mod_rtpengine` to the FS Docker build.
- **O01** (Prometheus/Grafana): the rtpengine Prometheus scrape target and alert
  rules require O01's infrastructure to exist. X01 adds to it.

### 9.4 Blocked Modules (downstream)

- **R03** (recording playback): no direct dependency on X01. If rtpengine
  diagnostic PCAP recording is used, R03 may want to link to PCAP files; defer
  to Phase 3.
- **X02–X05** (if any): future scale-out modules may depend on X01's proven
  rtpengine topology.

---

## 10. Kernel Module Production Setup (Runbook Excerpt)

The kernel module setup is a one-time host-level operation. It is documented here
for the HANDOFF; the HANDOFF.md expands on it.

```bash
# 1. Install kernel headers for the running kernel
apt-get install -y linux-headers-$(uname -r)

# 2. Install rtpengine kernel module build dependencies
apt-get install -y dpkg-dev dkms

# 3. Install the rtpengine kernel DKMS package
# (from Sipwise repo or build from source)
apt-get install -y ngcp-rtpengine-kernel-dkms

# 4. Verify module loads
modprobe xt_RTPENGINE
lsmod | grep xt_RTPENGINE  # should show the module

# 5. Make persistent
echo "xt_RTPENGINE" > /etc/modules-load.d/rtpengine.conf

# 6. Set RTPENGINE_KERNEL_MODE=1 in docker-compose or .env
# This tells the rtpengine container to use the kernel table.

# 7. Verify kernel forwarding active
# After rtpengine starts with kernel mode, check:
cat /proc/rtpengine/0/list  # should show active kernel table entries for calls
```

---

## 11. Open Questions for Implementer

1. **`mod_rtpengine` package availability**: Confirm that `mod_rtpengine` is
   available as a pre-built Debian package for FS 1.10.12 from the SignalWire
   repo, or whether it must be compiled from the FS source tree.
   If compiled from source, the FS Dockerfile needs a multi-stage build with the
   FS source included. This could add 1–2 days of effort.

2. **`rtp-secure-media = optional` on wss.xml**: Test with a real browser that
   `optional` correctly allows rtpengine to take over DTLS. If browsers reject
   the rewritten SDP (e.g., because FS's SDP offer still includes its own
   `a=fingerprint:` attribute), investigate whether `rtp-secure-media = false`
   is needed instead.

3. **rtpengine Prometheus endpoint**: Confirm `--prometheus-listen` is available
   in the Sipwise Debian package for `mr12.5`. If not, use the companion
   exporter container (`sipwise/rtpengine-exporter`) instead.

4. **Mac Docker Desktop port range**: Publishing 10,000 UDP ports
   (`30000-40000:30000-40000/udp`) in Docker Desktop is known to be very slow
   to start and may be unstable. The `docker-compose.macos.yml` override limits
   this to 1,000 ports (`30000-31000`). Test and adjust.

5. **FS restart during migration**: The hard rollback requires a FS restart which
   drops in-flight calls. Evaluate whether the `uuid_media_reneg` ESL approach
   (RESEARCH §3.3, Path C) would allow enabling/disabling rtpengine per-call
   without FS restart. This would require a small ESL service (~200 LOC Go)
   but enables zero-in-flight-call-drop rollback. Defer to Phase 3 unless the
   implementer judges it feasible within 4–5 days.

---

*Plan document X01/PLAN.md — 2026-05-13*
*Implementer: begin with Tasks 1–4 (rtpengine container), then Task 9
(docker-compose), verify rtpengine starts, then Tasks 5–8 (FS integration).*
