# X02 — Kamailio SIP Dispatcher: Handoff

_Status: COMPLETE | Implemented: 2026-05-13_

---

## Topology Summary

- Kamailio 6.0, 2 replicas, active-passive VRRP. VIP: `10.0.0.100`.
- SIP entry points: UDP/TCP 5060, TLS 5061, WSS 7443.
- Dispatcher set 1 (inbound, hash-by-Call-ID) and set 2 (outbound, fewest-active).
- Health probes: SIP OPTIONS every 15s; 3 misses → inactive; 2 successes → restore (≤45s failover).
- FS ACL: FS instances accept SIP only from Kamailio VIP.

## For X03 (Campaign Affinity)

- Set header `X-FS-Affinity: sip:<fs_ip>:5060` on originate requests to signal affinity to Kamailio.
- Kamailio `router.lua` reads this header and bypasses dispatcher selection, routing directly to the specified FS.
- Dispatcher set 20 reserved for X03 per-campaign routing if AVP-based approach is preferred.
- If the pinned FS is inactive, Kamailio falls back to `ds_select_dst(2, 4)` (fewest-active from set 2).

## Operational Commands

```bash
# Show dispatcher state
kamcmd dispatcher.list

# Reload dispatcher from MySQL
kamcmd dispatcher.reload

# Manually drain an FS instance
python3 /usr/local/bin/kamailio-scripts/dispatcher-list-renderer.py --action=drain --fs-ip=<IP>

# Restore a drained FS
python3 /usr/local/bin/kamailio-scripts/dispatcher-list-renderer.py --action=sync

# Add a new FS instance
python3 /usr/local/bin/kamailio-scripts/dispatcher-list-renderer.py --action=add --fs-ip=<IP> --sets=1,2

# Reload Lua routing script (after changes)
kamcmd app_lua.reload /etc/kamailio/router.lua

# Reload carrier ACLs
kamcmd permissions.reload
```

## Key File Paths

| File | Purpose |
|------|---------|
| `/etc/kamailio/kamailio.cfg` | Module loading and parameters |
| `/etc/kamailio/router.lua` | All routing logic (KEMI Lua) |
| `/etc/kamailio/tls.cfg` | TLS certificate profiles |
| `/etc/kamailio/dispatcher.list` | Fallback flat-file dispatcher list |
| `/etc/keepalived/keepalived.conf` | VRRP HA config |
| `kamailio` DB, `dispatcher` table | Live dispatcher state (MySQL) |
| `kamailio` DB, `address` table | Carrier ACL groups |

## Prometheus Metrics

- Endpoint: `http://<kamailio-ip>:9090/metrics`
- Key metrics: `kamailio_dispatcher_reachable`, `vici2_dispatched_calls_total`, `vici2_dispatch_failures_total`

## FreeSWITCH Requirements

- FS Sofia `internal` profile must have outbound-proxy or trust-list entry for Kamailio VIP (`10.0.0.100`) — no SIP challenge for traffic from Kamailio.
- FS external profile must set `outbound-proxy = sip:10.0.0.100:5060` so all carrier-bound SIP exits through Kamailio.
- FS ACL: `<list name="kamailio_trust">` with Kamailio VIP + both replica IPs.

## Implementation Notes

### Files Created
- `infra/kamailio/` — Dockerfile, kamailio.cfg, router.lua, dispatcher.list, tls.cfg,
  acl-carriers.conf, scripts/{entrypoint,healthcheck,kamailio-reload}.sh,
  scripts/{dispatcher-list-renderer,check_fs_load}.py
- `infra/keepalived/keepalived.conf` — VRRP active-passive HA
- `infra/observability/prometheus/rules/kamailio.rules.yml` — alert rules

### Files Modified
- `docker-compose.dev.yml` — added `kamailio` service
- `docker-compose.macos.yml` — added `kamailio` Mac override
- `infra/observability/prometheus/prometheus.yml` — added `kamailio` scrape job

### X03 Integration Detail
`router.lua::route_initial_invite()` checks for `X-FS-Affinity` header first.
If present, the header is stripped (not forwarded to FS) and the call is routed
directly to the specified FS URI via `KSR.pv.sets("$ru", affinity_uri)`.
The failure route (`ksr_failure_route_fs_failure`) fires on affinity-FS failure
but `ds_next_dst()` will return -1 (no set context). X03 should handle 503
from Kamailio and fall back to sending without the affinity header.

### rtpengine pcall guards
All rtpengine calls use `pcall()` in router.lua. An X01 outage does not block
SIP routing — calls proceed with FS-native media handling.

## Runbook Pointer

Full operations runbook: `spec/runbooks/kamailio.md` (to be created by ops).
