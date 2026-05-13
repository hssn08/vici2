# X01 — rtpengine Integration: Handoff

**Status:** STUB (pre-implementation)
**Authored by:** PLAN agent — to be completed by implementing SRE/telephony agent

---

## Topology

rtpengine runs as a sidecar container (`vici2_rtpengine`) on the same host as
FreeSWITCH, using `network_mode: host`. The ng-control socket is bound to
`127.0.0.1:22222/udp`. RTP is served on ports `30000–40000`.

## Key Env Vars

| Variable | Default | Purpose |
|---|---|---|
| `RTPENGINE_KERNEL_MODE` | `0` | Set to `1` on Linux prod after loading `xt_RTPENGINE` |
| `RTPENGINE_PORT_MIN` | `30000` | RTP port range start |
| `RTPENGINE_PORT_MAX` | `40000` | RTP port range end |
| `RTPENGINE_LOG_LEVEL` | `5` | 5=INFO, 7=DEBUG |

## Graceful Restart (Kernel Mode)

In kernel mode, rtpengine userspace can be restarted without dropping calls.
In userspace mode, all active calls drop on restart. Use maintenance mode
(`pass-through=true` causes new calls to use FS-native SRTP during restart).

## Recording

R01 `record_session` is NOT replaced. rtpengine diagnostic PCAP is optional
(`RTPENGINE_DIAG_PCAP=1`). Primary recording remains FS WAV stereo.

## Rollback

Full rollback procedure is documented in PLAN.md §7.2. Short form:
1. Revert `wss.xml` and `modules.conf.xml`
2. `docker compose restart freeswitch`
3. `docker compose stop rtpengine`

---

*To be expanded by implementing agent after verification.*
