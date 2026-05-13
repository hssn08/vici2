# X01 — rtpengine Integration: Handoff

**Status:** IMPLEMENTED
**Implemented by:** Claude Sonnet 4.6 (implement agent) — 2026-05-13
**Commit:** ffdc691 `feat(X01): rtpengine SRTP offload sidecar`

---

## What Was Built

14 files created/modified implementing rtpengine as a FreeSWITCH sidecar for
SRTP offload. Target: 500 concurrent WebRTC browser sessions vs ~150 baseline.

### Files Created

| File | Purpose |
|---|---|
| `infra/rtpengine/Dockerfile` | Sipwise ngcp-rtpengine on debian:bookworm-slim |
| `infra/rtpengine/entrypoint.sh` | Startup with kernel mode detection + fallback |
| `infra/rtpengine/healthcheck.sh` | nc UDP ng-protocol bencode statistics probe |
| `infra/rtpengine/rtpengine.conf.example` | Annotated reference config for operators |
| `infra/rtpengine/KERNEL_MODULE.md` | Production kernel module setup runbook |
| `freeswitch/conf/dialplan/default/50_rtpengine.xml` | rtpengine_offer (WSS A-leg) + rtpengine_answer (B-leg) |
| `freeswitch/conf/autoload_configs/rtpengine.conf.xml` | mod_rtpengine → 127.0.0.1:22222, pass-through=true |
| `infra/observability/prometheus/rules/rtpengine.rules.yml` | 4 alert rules |
| `freeswitch/tests/load/rtpengine_load.sh` | 500-concurrent load test with metric assertions |

### Files Modified

| File | Change |
|---|---|
| `freeswitch/conf/autoload_configs/modules.conf.xml` | Added `<load module="mod_rtpengine"/>` after mod_sofia |
| `freeswitch/conf/sip_profiles/wss.xml` | `rtp-secure-media`: mandatory → optional |
| `docker-compose.dev.yml` | Added rtpengine service + rtpengine_recordings volume |
| `docker-compose.macos.yml` | Added rtpengine bridge override (ports 22222, 30000-31000) |
| `infra/observability/prometheus/prometheus.yml` | Added rtpengine scrape job (localhost:9109) |

---

## Topology

rtpengine runs as a sidecar container (`vici2_rtpengine`) on the same host as
FreeSWITCH, using `network_mode: host`. The ng-control socket is bound to
`127.0.0.1:22222/udp`. RTP is served on ports `30000–40000`.

```
Browser (DTLS-SRTP) ←→ rtpengine :30000-40000 ←→ FreeSWITCH :16384-32768 (plain RTP, loopback)
                              ↑
                    ng-protocol 127.0.0.1:22222
                              ↑
                    mod_rtpengine (in FreeSWITCH)
```

---

## Key Env Vars

| Variable | Default | Purpose |
|---|---|---|
| `RTPENGINE_KERNEL_MODE` | `0` | Set to `1` on Linux prod after loading `xt_RTPENGINE` |
| `RTPENGINE_PORT_MIN` | `30000` | RTP port range start |
| `RTPENGINE_PORT_MAX` | `40000` | RTP port range end |
| `RTPENGINE_LOG_LEVEL` | `5` | 5=INFO, 7=DEBUG |
| `RTPENGINE_PROMETHEUS_PORT` | `9109` | Built-in Prometheus metrics HTTP port |

---

## Prometheus Metrics

rtpengine's built-in Prometheus endpoint is scraped at `localhost:9109`.
Alert rules in `infra/observability/prometheus/rules/rtpengine.rules.yml`:

| Alert | Condition | Severity |
|---|---|---|
| `RtpengineDown` | `up{job="rtpengine"} == 0` for 1m | critical |
| `RtpenginePortExhaustion` | `rtpengine_port_unavailable_total > 0` | warning |
| `RtpengineHighSessionLoad` | `rtpengine_sessions_current > 4500` for 5m | warning |
| `RtpengineNgErrors` | `rate(rtpengine_ng_errors_total[5m]) > 0.1` for 5m | warning |

---

## Load Test

```bash
cd freeswitch/tests/load
chmod +x rtpengine_load.sh
TARGET_CALLS=500 SUSTAIN_SEC=600 ./rtpengine_load.sh
```

Acceptance: sessions drain to 0 after ramp-down, no port exhaustion, no ng errors.

---

## Graceful Restart (Kernel Mode)

In kernel mode, rtpengine userspace can be restarted without dropping in-flight
calls (the kernel module continues forwarding RTP while userspace restarts).
In userspace mode, all active calls drop on restart.

`pass-through=true` in `rtpengine.conf.xml` causes mod_rtpengine to fall back
to FS-native SRTP for **new** calls if rtpengine is unreachable during restart.

---

## Recording

R01 `record_session` is NOT replaced. rtpengine diagnostic PCAP is optional.
Primary recording remains FS WAV stereo mix via `record_session`.

---

## Rollback

Full procedure in PLAN.md §7.2. Short form (< 5 minutes):

1. Revert `wss.xml`: restore `rtp-secure-media=mandatory`, remove X01 comment block
2. Remove `<load module="mod_rtpengine"/>` from `modules.conf.xml`
3. `docker compose restart freeswitch`
4. `docker compose stop rtpengine`

In-flight calls drop during FS restart (unavoidable). New calls recover immediately.

---

## Production Kernel Module Setup

See `infra/rtpengine/KERNEL_MODULE.md` for the full runbook.

Short form (run on the host, not in container):

```bash
apt-get install -y ngcp-rtpengine-kernel-dkms linux-headers-$(uname -r)
modprobe xt_RTPENGINE
echo "xt_RTPENGINE" > /etc/modules-load.d/rtpengine.conf
# Then in .env:
RTPENGINE_KERNEL_MODE=1
docker compose restart rtpengine
# Verify:
cat /proc/rtpengine/0/list
```

---

## Open Questions (from PLAN §11)

1. **`mod_rtpengine` Debian package**: Plan uses Sipwise APT repo package
   `ngcp-rtpengine`. FreeSWITCH `mod_rtpengine` is a separate module that may
   require compilation against the FS source tree — verify availability in the
   SignalWire FS 1.10.12 Debian package before first deploy.

2. **`rtp-secure-media=optional` on wss.xml**: Test with a real browser that
   `optional` correctly allows rtpengine to take over DTLS. If browsers reject
   the rewritten SDP, try `rtp-secure-media=false` instead.

3. **Prometheus endpoint availability**: Confirm `--prometheus-listen` is
   present in the Sipwise Debian package for `mr12.5`. If not, deploy the
   companion exporter container (`sipwise/rtpengine-exporter`).

4. **Mac port range**: The 30000-31000 range (1000 ports) in `docker-compose.macos.yml`
   supports ~250 concurrent calls. Adjust if dev testing requires more.

---

*Expanded from PLAN.md stub by implementing agent — 2026-05-13*
