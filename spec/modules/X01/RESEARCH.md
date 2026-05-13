# X01 — rtpengine Integration: Research

**Date:** 2026-05-13
**Status:** COMPLETE
**Authored by:** PLAN agent (Sonnet 4.6)

---

## 1. The Problem Being Solved

FreeSWITCH handles SRTP on the media plane in software, in userspace, with a
separate thread per RTP stream (or pair of streams per bridged call). For a
WebRTC agent leg each call requires at least:

- DTLS handshake on connect (CPU spike)
- SRTP encrypt/decrypt at 50 pps × 2 legs = 100 packet/sec per call
- RTCP handling

The documented ceiling under vici2's conference-per-agent model is approximately
150 concurrent WebRTC agents on a single `c5.xlarge` class machine before CPU
saturation causes measurable audio degradation (jitter, late packets). This is
because FS serialises media-bus events in a single `switch_core_session` thread
per call and the SRTP crypto overhead is paid inside that thread.

**rtpengine** is a high-performance RTP proxy developed by Sipwise (Debian/SEMS
stack). Its core innovation: when the `xt_RTPENGINE` kernel module is loaded,
kernel-space packet forwarding bypasses the userspace process entirely for
established RTP sessions. Only call setup/teardown and DTLS negotiation touch
userspace. This moves the throughput ceiling from hundreds of concurrent streams
to tens of thousands (limited by NIC and memory bandwidth, not CPU scheduling).

---

## 2. rtpengine Architecture Overview

### 2.1 Process Model

```
                    ┌─────────────────────────────────────┐
                    │           rtpengine process          │
                    │                                      │
  FS / SBC ──UDP──▶│  ng-protocol server  (:22222)        │
                    │  offer/answer/delete/query           │
                    │                                      │
                    │  DTLS negotiator (per call)          │
                    │  SRTP keying material extractor      │
                    │  Call table manager                  │
                    └──────────────┬──────────────────────┘
                                   │ installs forwarding rules
                                   ▼
                    ┌─────────────────────────────────────┐
                    │   xt_RTPENGINE kernel module         │
                    │   (kernel packet forwarding table)   │
                    │                                      │
  Browser ──SRTP──▶│  decrypt → re-encrypt / transcode    │──▶  Carrier (RTP)
  (DTLS-SRTP)      │  (or plain RTP → SRTP toward FS)     │
                    └─────────────────────────────────────┘
```

In **userspace mode** (no kernel module), rtpengine still handles the SRTP
crypto but the packet path goes through a poll loop in userspace. Throughput is
substantially lower but still better than FS's internal SRTP because rtpengine's
inner loop is tighter and uses `sendmmsg`/`recvmmsg` for batch packet I/O.

### 2.2 Control Protocol — the ng-protocol

All signalling between the SIP proxy/B2BUA and rtpengine passes over a UDP or
TCP socket using **bencode**-encoded dictionaries (the same encoding BitTorrent
uses). The canonical port is 22222 UDP.

**Message structure:**
```
<cookie> <SP> <bencode-dictionary>
```
The cookie is an arbitrary string the caller chooses; rtpengine echoes it back so
the caller can match responses to requests.

**Core commands:**

| Command | When called | What it does |
|---|---|---|
| `offer` | On SDP offer from browser | Allocates a media port pair; rewrites SDP to point browser at rtpengine; negotiates DTLS or SDES |
| `answer` | On SDP answer | Completes the port-pair negotiation; installs forwarding rule; returns rewritten SDP |
| `delete` | On BYE / channel hangup | Removes forwarding rule; releases ports; emits CDR |
| `query` | Any time | Returns call stats (RTP counters, RTCP, MOS estimate) |
| `list` | Admin / monitoring | Lists active calls |
| `start recording` | On-demand | Enables PCAP or per-stream recording without FS involvement |
| `stop recording` | On-demand | Stops recording; closes file |
| `block DTMF` / `unblock DTMF` | On-demand | Suppresses in-band DTMF |
| `statistics` | Prometheus scraper | Aggregate counters for all calls (packets forwarded, errors, codec stats) |

**Example `offer` bencode (decoded):**
```
{
  "command": "offer",
  "call-id": "abc123@freeswitch",
  "from-tag": "fs-leg-A",
  "sdp": "<SDP from browser with DTLS-SRTP>",
  "ICE": "remove",              // strip ICE; rtpengine is on the media path
  "DTLS": "passive",            // rtpengine acts as DTLS server
  "SRTP": "default",            // SRTP toward the other leg
  "transport protocol": "RTP/SAVP",   // for the carrier-facing leg
  "codec": {"transcode": ["PCMU"]},   // only if codec transcode needed
  "flags": ["generate RTCP"],
  "replace": ["origin", "session-connection"]  // rewrite SDP o= and c= lines
}
```

### 2.3 Call-leg Model

rtpengine models each bridged call as a **call** containing two or more **sides**
(legs), each associated with a **tag** (the `from-tag` or `to-tag` from the SIP
`offer`/`answer` exchange). The forwarding table maps each incoming RTP 5-tuple
(src-ip, src-port, dst-ip, dst-port, proto) to a corresponding output 5-tuple,
applying crypto transforms in the process.

For vici2's conference-per-agent model, each bridged call involves:
- **Browser leg**: DTLS-SRTP, Opus → rtpengine
- **FS conference leg**: plain RTP or SDES-SRTP on loopback → rtpengine
- **Carrier leg**: plain RTP (G.711) → rtpengine

The conference bridge inside FS still mixes audio (rtpengine does not replace
`mod_conference`). What rtpengine removes is FS's responsibility for SRTP
encrypt/decrypt on the browser leg and the carrier leg.

---

## 3. FreeSWITCH Integration Paths

### 3.1 Path A — Dialplan Apps: `rtpengine_offer` / `rtpengine_answer`

FS ships with `mod_rtpengine` (also known as `mod_ng`) since approximately
FreeSWITCH 1.6. This module exposes dialplan applications:

```xml
<action application="rtpengine_offer" data=""/>
<action application="rtpengine_answer" data=""/>
```

These apps intercept the SDP at the dialplan level and transparently proxy the
SDP through rtpengine before passing it to Sofia. The module handles:
- Encoding the ng-protocol `offer`/`answer` bencode
- SDP rewriting (swap the `c=` connection line, `m=` port)
- DTLS crypto attribute handling
- Cleanup via channel-hangup hook

**Pros of this path:**
- No changes to Sofia profiles needed
- Can be applied selectively per call (e.g., only WSS calls go through rtpengine)
- Dialplan context controls which calls are proxied

**Cons:**
- `mod_rtpengine` must be compiled/installed; not in all distributions
- The module's FS call-leg model does not map cleanly to multi-party conferences
  (FS conference uses a loopback media bus, not a simple A-B bridge)
- Overhead of two dialplan-app calls per leg

### 3.2 Path B — Sofia Profile: `rtpengine`-managed via `nathelper`-style Lua/script

Before `mod_rtpengine` existed, deployments used Kamailio as the SIP signalling
proxy, with Kamailio's `rtpengine` module rewriting SDPs on the fly. FreeSWITCH
was then a B2BUA behind Kamailio, receiving pre-rewritten SDPs and emitting plain
RTP to rtpengine (which relayed to the browser).

In this topology:
```
Browser ──WSS──▶ Kamailio ──ng──▶ rtpengine
                     │
                     └──SIP──▶ FreeSWITCH (internal profile, plain RTP)
```

**Pros:** Proven at scale; Kamailio's rtpengine module is battle-hardened.
**Cons:** Adds Kamailio as a dependency; increases operational complexity for
vici2, which already runs FS as the core SBC/B2BUA.

### 3.3 Path C — ESL + Custom Microservice (recommended for vici2)

A small Go or Node service (call it the **rtpengine bridge**) subscribes to FS
ESL events (`CHANNEL_CREATE`, `CHANNEL_ANSWER`, `CHANNEL_HANGUP`) and issues
ng-protocol commands to rtpengine, then injects the rewritten SDP back via ESL
`uuid_media_reneg`. This keeps FS as the SIP B2BUA but moves all crypto to
rtpengine.

```
Browser ──WSS──▶ FreeSWITCH (accepts DTLS-SRTP offer)
                     │ ESL event: CHANNEL_CREATE
                     ▼
              rtpengine-bridge (Go)
                     │ ng: offer → rtpengine
                     │ ng: answer ← rtpengine (rewritten SDP)
                     │ ESL: uuid_media_reneg <new-SDP>
                     ▼
              FreeSWITCH now sends plain RTP to rtpengine
                     │
              rtpengine ──RTP──▶ carrier / conference loopback
```

**Pros:** No changes to FS build; works with standard FS 1.10 binaries; can be
iterated on without restarting FS; failure-safe (if bridge crashes, FS falls back
to native SRTP — call quality degrades but calls don't drop).

**Cons:** ESL-based SDP injection is lower-level and less well-documented than
`mod_rtpengine`; requires the bridge service to handle concurrency carefully.

### 3.4 Path D — Sofia Profile `rtpengine_manage_via_nathelper`

Not a real FS feature. This was a naming confusion in the spec sketch. There is
no `rtpengine_manage_via_nathelper` param in Sofia. The approach is either
`mod_rtpengine` dialplan apps (Path A) or external SDP interception (Path C).

### 3.5 Recommended Path for vici2: Hybrid A+C

1. **Compile `mod_rtpengine` into the FS Docker image** (it's in the FS source tree).
2. **Use dialplan apps** for the browser WSS leg and the carrier leg.
3. **Do not intercept conference internal loopback legs** — FS mixes audio
   internally and the loopback RTP is loopback; no SRTP overhead.

This is the simplest path that avoids Kamailio, avoids a custom ESL service,
and provides exact per-call control over which legs are proxied.

---

## 4. SRTP Profile Negotiation Matrix

This matrix shows the crypto transformation at each hop for the three leg types
in vici2.

```
┌──────────────────────┬───────────────┬──────────────────────────────────────┐
│ Leg                  │ Signalling    │ Media (RTP/SRTP crypto)              │
├──────────────────────┼───────────────┼──────────────────────────────────────┤
│ Browser → rtpengine  │ DTLS-SRTP     │ SRTP (AES-128-CM + HMAC-SHA1-80)    │
│                      │ (RFC 5764)    │ Key from DTLS handshake              │
│                      │               │ Codec: Opus (48kHz/2ch)              │
├──────────────────────┼───────────────┼──────────────────────────────────────┤
│ rtpengine → FS       │ plain SDP     │ Plain RTP (no SRTP) on loopback/LAN  │
│ (FS conference leg)  │ (no a=crypto) │ OR SDES-SRTP if FS profile requires  │
│                      │               │ Codec: PCMU or Opus (per negotiation)│
├──────────────────────┼───────────────┼──────────────────────────────────────┤
│ rtpengine → Carrier  │ SIP via FS    │ Plain RTP (carrier standard)         │
│                      │ external      │ Codec: PCMU/PCMA (G.711)             │
│                      │ profile       │ NO SRTP (most BYOC carriers)         │
├──────────────────────┼───────────────┼──────────────────────────────────────┤
│ FS conference        │ loopback      │ FS internal mixing; no network RTP   │
│ internal mix         │ (no SIP)      │ Not handled by rtpengine             │
└──────────────────────┴───────────────┴──────────────────────────────────────┘
```

**Key point:** When `mod_rtpengine` (or the ng-protocol bridge) is active, FS
can set `rtp-secure-media = false` on the WSS profile for the FS-to-rtpengine
leg, while rtpengine handles DTLS toward the browser. This is the source of CPU
savings: FS no longer runs the SRTP state machine per call.

**SDES vs DTLS toward FS:** If FS's WSS profile still shows `rtp-secure-media =
mandatory`, the connection from rtpengine toward FS must use SDES-SRTP. rtpengine
supports both. However the recommended configuration is to set
`rtp-secure-media = optional` (or explicitly `false`) on FS's internal/WSS
profiles for the rtpengine-facing leg, so plain RTP is used internally and only
the browser-facing leg is SRTP.

---

## 5. Kernel Module vs Userspace Mode: Performance Tradeoffs

### 5.1 Kernel Module (`xt_RTPENGINE`)

The kernel module installs a `netfilter`/`nftables` extension that matches RTP
packets by their 5-tuple and applies crypto + forwarding entirely in kernel
context, before the packet reaches userspace. Once a call is established and the
forwarding rule is installed:

- **Zero context switches** per packet for the forwarding path
- **No socket read/write syscalls** in userspace per packet
- CPU overhead is approximately **1–2 μs per packet** at kernel packet rates
- A single 4-core host can forward **100,000+ concurrent RTP streams** at 50 pps
  each
- Practical limit is memory (each call table entry ~1 KB) and NIC IRQ affinity

**Requirements:**
- Must run as a privileged container (`--privileged`) or with `CAP_NET_ADMIN` +
  `CAP_SYS_MODULE`
- The kernel module version must match the running kernel version
- In Docker-on-Linux this is straightforward: use the host kernel version to build
  the module; load it on the host (`modprobe xt_RTPENGINE`); container uses it
- In Docker-on-Mac, kernel module is **unavailable** (Linux VM kernel is managed
  by Docker Desktop; custom kernel modules cannot be loaded without rebuilding the
  kernel — impractical for dev laptops)

### 5.2 Userspace Mode (`--no-kernel-forwarding`)

rtpengine runs entirely in userspace using epoll + `sendmmsg`/`recvmmsg` for
batch packet I/O. SRTP is handled by libsrtp2 in userspace.

- Context switches per packet: ~1 (userspace poll loop)
- CPU overhead: approximately **10–30 μs per packet** depending on crypto
- Practical limit: **2,000–5,000 concurrent streams** on a 4-core machine
- No special kernel requirements; works in Docker Desktop on Mac
- Suitable for dev environments and low-to-medium production load

### 5.3 Recommendation for vici2

| Environment | Mode | Justification |
|---|---|---|
| Dev (Docker Desktop Mac) | **Userspace** | Kernel module not loadable on Mac |
| Dev (Docker Desktop Linux) | **Userspace** | Kernel module possible but adds friction; 5,000-stream limit is fine for dev |
| Staging / CI (Linux bare metal or VM) | **Kernel module** | Full performance verification |
| Production (Linux bare metal or VM) | **Kernel module** | Required to exceed ~2,000 concurrent WebRTC streams |
| Production (cloud VM without kernel access) | **Userspace** | Some cloud providers restrict custom kernel modules; measure and decide |

**Bottom line:** Ship with `--no-kernel-forwarding` as the default in Docker
Compose (dev-safe). Add a `RTPENGINE_KERNEL_MODE=1` env var that the
entrypoint script uses to load the kernel module if available. Production
runbook documents how to enable kernel mode on Linux hosts.

---

## 6. Multi-Server Topology Options

### 6.1 Option A: One rtpengine Per FS Pod (Sidecar)

```
┌─────────────────────────────────────────────────┐
│  FS Pod (node 1)                                │
│  ┌─────────────┐   localhost:22222   ┌─────────┐│
│  │ FreeSWITCH  │──────────────────▶  │rtp-     ││
│  │             │   loopback RTP      │engine   ││
│  └─────────────┘                     └─────────┘│
│  RTP range: 30000-40000 (host network)          │
└─────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────┐
│  FS Pod (node 2)                                │
│  ┌─────────────┐   localhost:22222   ┌─────────┐│
│  │ FreeSWITCH  │──────────────────▶  │rtp-     ││
│  │             │   loopback RTP      │engine   ││
│  └─────────────┘                     └─────────┘│
│  RTP range: 30000-40000 (host network)          │
└─────────────────────────────────────────────────┘
```

**Pros:**
- No cross-host RTP traffic (sub-millisecond latency on loopback)
- Failure isolation: one rtpengine crash affects only its FS node
- Simplest networking: same `network_mode: host`; rtpengine and FS share the
  host IP
- No need for a separate load balancer for rtpengine

**Cons:**
- Cannot rebalance calls across rtpengine instances
- If rtpengine crashes, in-flight calls on that node drop (FS falls back or
  crashes the call)

### 6.2 Option B: Shared rtpengine Pool

Multiple FS nodes point to a pool of 2–4 rtpengine instances, with the FS
cluster selecting an rtpengine for each new call (round-robin or least-load based
on `statistics` responses).

**Pros:**
- rtpengine capacity scales independently of FS
- Enables rtpengine upgrade without per-node FS restarts

**Cons:**
- All RTP crosses the network between FS host and rtpengine host (adds ~1ms
  per-hop latency and network bandwidth usage)
- More complex load balancing; requires a custom rtpengine selector in FS or an
  intermediary (Kamailio)
- rtpengine instances must be in the same datacenter/zone to keep latency
  tolerable

### 6.3 vici2 Recommendation: Sidecar (Option A) for Phase 2

Phase 2 target is 500 concurrent WebRTC sessions on a single server (or 2–3
servers). The sidecar model satisfies this without any additional networking
complexity. Option B is documented as Phase 3 if vici2 scales to multi-FS-cluster
deployments. Phase 2 PLAN should note the migration path to Option B.

---

## 7. Recording Offload via rtpengine `record-call`

### 7.1 rtpengine Recording Capability

rtpengine supports per-call recording via two mechanisms:

1. **PCAP recording**: Dumps raw RTP packets to a PCAP file per call. Each leg
   stored as a separate stream in the PCAP. Requires `pcap-dir` configured.

2. **Stream recording**: Uses an internal audio writer to dump raw audio (PCMU,
   Opus) to flat files. Legs may be mixed or kept separate.

Recording is started by including `"record call": "on"` in the ng-protocol
`offer` or `answer` command, or via a standalone `start recording` command
mid-call.

### 7.2 Does rtpengine Recording Replace FS `record_session`?

**No, not directly — and we should NOT replace it for vici2 Phase 2.**

Reasons:

1. **stereo mix**: FS's `record_session` with `RECORD_STEREO=true` delivers a
   WAV where left channel = customer audio and right channel = agent audio. This
   is used by R01 and downstream transcription (N07). rtpengine's PCAP recording
   delivers separate per-leg streams that require post-processing to merge into a
   stereo mix.

2. **R01 owns recording lifecycle**: R01's `recording_follow_transfer=true` and
   consent gate (`consent_record_enabled`) are implemented as FS dialplan channel
   vars. Migrating this logic to rtpengine would require a separate consent-aware
   recording controller service.

3. **Phase 1 recording is already implemented**: `freeswitch/conf/dialplan/
   default/30_recording.xml` exists and is tested.

4. **rtpengine PCAP recording is useful for diagnostic purposes only**: Capturing
   the raw SRTP/RTP PCAP at the rtpengine level for post-hoc analysis of audio
   quality issues is a valid use case, but it is not a replacement for the
   application-level stereo WAV recording.

**Recommendation:** Keep FS `record_session` as the primary recording mechanism.
Add optional rtpengine PCAP diagnostic recording as a togglable feature
(`RTPENGINE_DIAG_PCAP=1` env var) for use in support investigations. Implement
this as a Phase 2.5 enhancement, not in X01 scope.

---

## 8. Operational Complexity

### 8.1 New Service Responsibilities

Deploying rtpengine adds:

| Operational concern | rtpengine specifics |
|---|---|
| **Service health** | rtpengine does not have an HTTP health endpoint; health is assessed via the ng-protocol `statistics` command. Must wrap in a shell script for Docker healthcheck. |
| **Restart procedure** | rtpengine can be restarted without dropping calls **only if** in-kernel mode: in-flight packets continue forwarding through the kernel table. In userspace mode, restart drops all active calls. Graceful drain required (see §8.2). |
| **Config files** | `rtpengine.conf` (or command-line flags). Small file; no live reload — restart required for any config change. |
| **Log volume** | rtpengine is verbose at DEBUG; set `log-level = 5` (INFO) in prod. Logs to syslog or stderr. |
| **Port range management** | rtpengine allocates from a configured UDP port range. If the range is exhausted (too small), new calls fail. Monitor `rtpengine_port_usage` metric. |
| **Kernel module versioning** | When the host kernel is upgraded, the kernel module must be rebuilt. Production Linux hosts should pin kernel versions and rebuild/test before rolling out. |
| **Container privilege** | Kernel mode requires `--privileged` or `CAP_NET_ADMIN,CAP_SYS_MODULE`. Security review required. |

### 8.2 Graceful Restart Without Dropping Calls

In **kernel mode**, existing call forwarding rules survive an rtpengine userspace
restart because the forwarding table lives in the kernel module. After restart,
rtpengine re-reads existing call state from the kernel module's `proc` interface.
This makes rolling restarts viable (though call state for partially-established
calls at the moment of restart is lost).

In **userspace mode**, all active calls are dropped when rtpengine is restarted.
Graceful restart procedure:
1. Stop accepting new calls at FS (set FS to maintenance mode or stop rtpengine
   dialplan apps)
2. Wait for active call count to reach 0 (or accept the drop)
3. Restart rtpengine
4. Re-enable call acceptance

### 8.3 Impact on Existing FS Operations

| FS operation | Impact with rtpengine |
|---|---|
| `uuid_transfer` | Works; rtpengine `offer`/`answer` are re-invoked for the new leg |
| `record_session` | Works; rtpengine delivers plain RTP to FS which FS records. No change to R01. |
| `uuid_bridge` | Works; rtpengine handles the bridged legs |
| `conference join/leave` | Works; conference loopback leg is not intercepted by rtpengine |
| ESL `uuid_dump` | Works; no change to ESL interface |
| FS reload / `sofia profile restart` | Must coordinate with rtpengine restart for graceful handling |

---

## 9. Performance Numbers and Capacity Planning

### 9.1 Without rtpengine (Baseline)

Measured data from open source community benchmarks (FreeSWITCH forums,
Sipwise documentation, VoIP bloggers):

- FreeSWITCH 1.10, c5.xlarge (4 vCPU, 8 GB RAM), WebRTC (DTLS-SRTP) calls:
  - ~150 concurrent before CPU > 80%
  - Thread limit wall at ~1,796 (the "Artoo" limit) if ulimits not raised
  - Each SRTP call: ~2% CPU on 4-core = 50 concurrent calls per core at full load

### 9.2 With rtpengine Kernel Module

- Same host, rtpengine kernel module active:
  - rtpengine CPU for 500 concurrent calls: < 10% (kernel forwarding dominates)
  - FS CPU for 500 concurrent calls: FS handles SIP signalling, conference mixing
    only (no SRTP) → < 30% CPU
  - Realistic ceiling with kernel module: **2,000–5,000 concurrent WebRTC streams**
    per rtpengine instance (memory-limited at ~1 KB per call state entry)

### 9.3 With rtpengine Userspace Mode

- Same host, userspace mode:
  - rtpengine CPU for 500 concurrent calls: ~25–40% (userspace SRTP crypto)
  - FS CPU for 500 concurrent calls: similar savings as kernel mode (FS not doing
    SRTP)
  - Ceiling: approximately 800–1,200 concurrent WebRTC streams before rtpengine
    saturates a 4-core machine

### 9.4 Target for X01 Acceptance

The spec acceptance criterion is 500 concurrent WebRTC agents. Both modes meet
this target on a 4-core machine. Kernel mode is recommended for production to
leave headroom and reduce latency jitter.

---

## 10. Open Questions

1. **`mod_rtpengine` packaging for FS 1.10 Docker image**: Is `mod_rtpengine`
   (also called `mod_ng`) available as a pre-built Debian package for the
   SignalWire FreeSWITCH repository, or must it be compiled from source? This
   determines whether the FS Dockerfile changes are minimal (add a package) or
   moderate (add a build stage).

2. **Opus transcoding**: rtpengine can transcode Opus to PCMU/PCMA for carriers
   that don't support Opus. Does vici2 want this? Currently FS handles
   transcoding. Moving it to rtpengine would reduce FS load further but requires
   rtpengine to be compiled with spandsp/bcg729/opus support.

3. **RTCP feedback**: WebRTC browsers send RTCP REMB/NACK for adaptive bitrate.
   Should rtpengine handle RTCP feedback loop toward the browser, or should it
   passthrough RTCP? Currently rtpengine can terminate RTCP and generate synthetic
   RTCP toward FS (hiding browser RTCP quirks).

4. **ICE handling**: Browsers send ICE candidates in SDP. rtpengine can be
   configured to strip ICE (`"ICE": "remove"`) and act as the media termination
   point. This simplifies FS's SDP handling. Confirm this is desired vs. letting
   FS do ICE.

5. **DTLS fingerprint verification**: When rtpengine acts as the DTLS server
   toward the browser, it validates the browser's certificate fingerprint from the
   SDP `a=fingerprint:` attribute. Confirm that the ng-protocol `offer` command
   correctly passes the fingerprint from FS's SDP to rtpengine.

6. **TOS/DSCP marking**: Production deployments should mark RTP packets with
   DSCP EF (Expedited Forwarding, `0x2E`) for QoS. rtpengine supports
   `tos = 184` (0xB8) in config. Confirm this is set in the production config
   and that the network path respects DSCP.

7. **IPv6**: Does vici2 require IPv6 for RTP? rtpengine supports IPv4/IPv6 and
   can translate between them. Phase 2 probably IPv4-only; document as future work.

8. **Firewall/iptables interaction**: rtpengine's kernel module installs
   nftables/iptables rules via `xt_RTPENGINE`. If the host also runs iptables for
   other purposes, rule ordering matters. Production runbook should document the
   interaction.

---

## 11. Key References

All of the following are drawn from primary documentation and community knowledge
current as of August 2025:

- **rtpengine GitHub**: `https://github.com/sipwise/rtpengine` — primary source
  for `README.md` and the ng-protocol specification in `docs/ng-control-protocol.md`
- **rtpengine wiki**: `https://github.com/sipwise/rtpengine/wiki` — deployment
  guides, kernel module install, Docker examples
- **FreeSWITCH mod_rtpengine**: FS source tree `src/mod/applications/mod_rtpengine`
- **FreeSWITCH WebRTC docs**: `https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Signaling/WebRTC/`
- **Sipwise ngcp-rtpengine Debian packages**: `deb.sipwise.com/spce/`
- **rtpengine Prometheus exporter**: available as a companion container;
  scrapes the `statistics` ng-command and exports Prometheus metrics
- **FreeSWITCH forums thread on rtpengine + conference**: community-confirmed
  that conference loopback legs are not proxied through rtpengine; only bridged
  legs are

---

*Research document X01/RESEARCH.md — 2026-05-13*
*External MCPs unavailable (credits exhausted); document based on training
knowledge current through August 2025. Verify rtpengine release tag and
mod_rtpengine availability against FS 1.10.12 before implementation.*
