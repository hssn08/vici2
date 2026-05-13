# X02 — Kamailio SIP Dispatcher: Plan

_Last updated: 2026-05-13 | Phase 3.5 | Status: NOT_STARTED_

---

## 1. Executive Summary

X02 deploys Kamailio 6.0 as the SIP front door for the vici2 FreeSWITCH cluster. All SIP traffic (carrier inbound, agent WebSocket, dialer-originated outbound) enters through Kamailio, which load-balances to a pool of N FreeSWITCH instances using the `dispatcher` module. Health probes (SIP OPTIONS, 15s interval) detect dead FS instances within 45 seconds; failover is automatic and transparent to callers. Two Kamailio replicas run behind a keepalived VIP for Kamailio-layer HA.

This plan addresses the documented ~100-agent single-FS ceiling (DESIGN.md §16) and enables Phase 4 horizontal scaling. X03 (campaign affinity) builds directly on the dispatcher sets defined here.

---

## 2. Topology

### 2.1 Physical Layout

```
                        ┌──────────────────────────────────┐
Carriers (PSTN/SIP)     │  VIP: 10.0.0.100:5060 (VRRP)     │
       │                │  VIP: 10.0.0.100:5061 (TLS)       │
       │                │  VIP: 10.0.0.100:7443 (WSS)       │
       │                └──────────┬───────────────────┬─────┘
       │                           │                   │
       ▼                           ▼                   ▼
  ┌────────────────────┐  ┌────────────────────┐
  │  Kamailio-A        │  │  Kamailio-B        │  (active-passive VRRP)
  │  10.0.0.10         │  │  10.0.0.11         │
  │  priority 100      │  │  priority 90       │
  └──────────┬─────────┘  └──────────┬─────────┘
             │                       │
             └──────────┬────────────┘
                        │  SIP (UDP/TCP 5060)
            ┌───────────┼────────────┐
            ▼           ▼            ▼
    ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
    │ FreeSWITCH-1 │ │ FreeSWITCH-2 │ │ FreeSWITCH-N │
    │ 10.0.1.10    │ │ 10.0.1.11    │ │ 10.0.1.1N    │
    │ :5060 SIP    │ │ :5060 SIP    │ │ :5060 SIP    │
    │ :7443 WSS    │ │ :7443 WSS    │ │ :7443 WSS    │
    └──────┬───────┘ └──────┬───────┘ └──────┬───────┘
           │                │                 │
           └────────────────┼─────────────────┘
                            │  RTP (media)
                  ┌─────────▼─────────┐
                  │   rtpengine        │  (X01, co-located with Kamailio)
                  │   10.0.0.10:22222  │
                  └───────────────────┘
```

### 2.2 Port Assignments

| Port | Protocol | Purpose |
|------|----------|---------|
| 5060 | UDP + TCP | SIP (carrier + dialer engine) |
| 5061 | TLS | SIP-TLS (carrier TLS trunks) |
| 7443 | TLS/WSS | WebSocket SIP (browser agents via SIP.js) |
| 9090 | HTTP | Prometheus metrics scrape endpoint |
| 8080 | HTTP | Kamailio JSONRPC management API |
| 22222 | UDP | rtpengine control socket (X01) |

### 2.3 Network Segments

```
10.0.0.0/24   — Kamailio + rtpengine (signaling plane)
10.0.1.0/24   — FreeSWITCH instances (media + signaling)
10.0.2.0/24   — API gateway, dialer engine, MySQL, Redis
10.0.3.0/24   — Management (admin, monitoring)
```

---

## 3. Dispatcher Sets

### 3.1 Set Definitions

| Set ID | Traffic Class | Algorithm | Description |
|--------|--------------|-----------|-------------|
| 1 | Inbound DID → FS | 0 (hash by Call-ID) | Ensures re-INVITE/BYE reach same FS |
| 2 | Outbound dialer → FS | 4 (fewest-active) | Balances load; best distribution for variable call duration |
| 3–9 | Reserved | — | Future use (emergency, priority carriers) |
| 10–19 | Per-tenant FS pools | 4 or 8 | Tenant isolation sets; optional |
| 20 | X03 campaign-affinity | 8 (hash by PV) | `$avp(fs_affinity_uri)` set by X03 routing logic |

### 3.2 Failover Behavior Per Set

**Set 1 (inbound):**
- Primary algorithm: hash by Call-ID (algorithm 0).
- If selected FS is inactive (probe-failed): `ds_next_dst()` picks next available with same hash-fallback ordering.
- If all FS inactive: return `503 Service Unavailable` with `Retry-After: 30`.

**Set 2 (outbound/dialer):**
- Primary: fewest-active (algorithm 4).
- Failure route: `ds_mark_dst("ip")` + `ds_next_dst()` — transparent retry within transaction.
- Max retries: 2 (try up to 3 total FS instances before giving up).

### 3.3 MySQL Dispatcher Table Schema

```sql
-- In kamailio database (separate from vici2 app DB)
CREATE TABLE dispatcher (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  setid       INT NOT NULL DEFAULT 0,
  destination VARCHAR(192) NOT NULL DEFAULT '',
  flags       INT NOT NULL DEFAULT 0,
  priority    INT NOT NULL DEFAULT 0,
  attrs       VARCHAR(128) NOT NULL DEFAULT '',
  description VARCHAR(64) NOT NULL DEFAULT '',
  PRIMARY KEY (id),
  INDEX idx_setid (setid),
  INDEX idx_destination (destination(64))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Initial data (2 FS instances)
INSERT INTO dispatcher (setid, destination, flags, priority, attrs, description) VALUES
  (1, 'sip:10.0.1.10:5060', 0, 0, 'weight=1', 'fs-1 inbound'),
  (1, 'sip:10.0.1.11:5060', 0, 0, 'weight=1', 'fs-2 inbound'),
  (2, 'sip:10.0.1.10:5060', 0, 0, 'weight=1', 'fs-1 outbound'),
  (2, 'sip:10.0.1.11:5060', 0, 0, 'weight=1', 'fs-2 outbound');
```

`flags` bitmap:
- `0` = active.
- `1` = inactive (DS_INACTIVE_DST).
- `2` = trying (DS_TRYING_DST, probe in flight).
- `4` = probing (DS_PROBING_DST, actively probed).

---

## 4. Files

### 4.1 File Tree

```
infra/
└── kamailio/
    ├── Dockerfile
    ├── kamailio.cfg                     # minimal native cfg: load modules, call KEMI
    ├── tls.cfg                          # TLS profile configuration
    ├── router.lua                       # KEMI Lua routing logic (main)
    ├── dispatcher.list                  # fallback flat file (if DB unavailable)
    ├── prometheus-exporter.cfg          # xhttp_prom module config
    ├── acl-carriers.conf                # carrier IP allowlist (sourced into kamailio.cfg)
    ├── scripts/
    │   ├── dispatcher-list-renderer.py  # syncs MySQL dispatcher table from FS registry
    │   ├── kamailio-reload.sh           # wrapper: kamcmd dispatcher.reload + app_lua.reload
    │   ├── healthcheck.sh               # used by Docker/keepalived
    │   └── check_fs_load.py             # ESL poller: updates dispatcher flags by FS session count
    └── docker-compose.override.yml      # adds kamailio + keepalived services
```

### 4.2 `infra/kamailio/Dockerfile`

```dockerfile
FROM kamailio/kamailio:6.0-bullseye

# Additional Kamailio modules not in base image
RUN apt-get update && apt-get install -y --no-install-recommends \
    kamailio-extra-modules \
    kamailio-mysql-modules \
    kamailio-tls-modules \
    kamailio-lua-modules \
    kamailio-utils-modules \
    kamailio-presence-modules \
    lua5.4 \
    liblua5.4-dev \
    python3 \
    python3-pymysql \
    python3-requests \
    && rm -rf /var/lib/apt/lists/*

COPY kamailio.cfg /etc/kamailio/kamailio.cfg
COPY tls.cfg /etc/kamailio/tls.cfg
COPY router.lua /etc/kamailio/router.lua
COPY dispatcher.list /etc/kamailio/dispatcher.list
COPY acl-carriers.conf /etc/kamailio/acl-carriers.conf
COPY scripts/ /usr/local/bin/kamailio-scripts/

RUN chmod +x /usr/local/bin/kamailio-scripts/*.sh

EXPOSE 5060/udp 5060/tcp 5061/tcp 7443/tcp 9090/tcp 8080/tcp

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
    CMD /usr/local/bin/kamailio-scripts/healthcheck.sh

CMD ["kamailio", "-DD", "-E", "-e"]
```

### 4.3 `infra/kamailio/kamailio.cfg` (Annotated Structure)

The native `kamailio.cfg` is kept minimal — it loads modules and delegates all routing to the Lua KEMI script. This pattern separates "what modules are loaded" (ops concern) from "how routing works" (developer concern).

```
####### Global Parameters #######
debug=2
log_stderror=yes
log_facility=LOG_LOCAL0
fork=yes
children=8          # 2× CPU cores
tcp_children=4
max_while_loops=100
mhomed=1
dns_try_naptr=0
use_dns_cache=0     # dispatch to static IPs, no DNS needed

####### Listeners #######
listen=udp:0.0.0.0:5060
listen=tcp:0.0.0.0:5060
listen=tls:0.0.0.0:5061
listen=tls:0.0.0.0:7443

####### Modules Section #######
mpath="/usr/lib/x86_64-linux-gnu/kamailio/modules/"

loadmodule "kex.so"
loadmodule "corex.so"
loadmodule "tm.so"
loadmodule "tmx.so"
loadmodule "sl.so"
loadmodule "rr.so"
loadmodule "pv.so"
loadmodule "maxfwd.so"
loadmodule "usrloc.so"
loadmodule "registrar.so"
loadmodule "textops.so"
loadmodule "siputils.so"
loadmodule "xlog.so"
loadmodule "sanity.so"
loadmodule "ctl.so"
loadmodule "cfg_rpc.so"
loadmodule "mi_rpc.so"
loadmodule "jsonrpcs.so"
loadmodule "db_mysql.so"
loadmodule "dispatcher.so"
loadmodule "permissions.so"
loadmodule "pike.so"
loadmodule "htable.so"
loadmodule "nathelper.so"
loadmodule "topoh.so"
loadmodule "rtpengine.so"
loadmodule "xhttp.so"
loadmodule "xhttp_prom.so"
loadmodule "app_lua.so"
loadmodule "rtimer.so"
loadmodule "tls.so"

####### Module Parameters #######

# TLS
modparam("tls", "config", "/etc/kamailio/tls.cfg")

# Transaction management
modparam("tm", "failure_reply_mode", 3)
modparam("tm", "fr_timeout", 5)
modparam("tm", "fr_inv_timeout", 120)
modparam("tm", "restart_fr_on_each_reply", 0)

# Record-Route
modparam("rr", "enable_full_lr", 1)
modparam("rr", "append_fromtag", 1)

# Dispatcher
modparam("dispatcher", "db_url", "DBURL")
modparam("dispatcher", "table_name", "dispatcher")
modparam("dispatcher", "ds_ping_method", "OPTIONS")
modparam("dispatcher", "ds_ping_interval", 15)
modparam("dispatcher", "ds_probing_mode", 1)
modparam("dispatcher", "ds_inactive_threshold", 3)
modparam("dispatcher", "ds_restore_threshold", 2)
modparam("dispatcher", "ds_ping_reply_codes", "200|404|486")
modparam("dispatcher", "ds_db_default_reachable", 1)

# Permissions (ACL)
modparam("permissions", "db_url", "DBURL")
modparam("permissions", "address_table", "address")

# Pike (rate limiting)
modparam("pike", "sampling_time_unit", 2)
modparam("pike", "reqs_density_per_unit", 30)
modparam("pike", "remove_latency", 4)

# Topology hiding
modparam("topoh", "mask_key", "TOPOH_SECRET")
modparam("topoh", "mask_ip", "KAMAILIO_PUBLIC_IP")
modparam("topoh", "mask_callid", 0)

# NAT helper
modparam("nathelper", "natping_interval", 30)
modparam("nathelper", "ping_nated_only", 1)
modparam("nathelper", "sipping_bflag", 7)

# rtpengine (X01)
modparam("rtpengine", "rtpengine_sock", "udp:RTPENGINE_IP:22222")

# htable for per-FS metrics
modparam("htable", "htable", "fsload=>size=16;autoexpire=0")
modparam("htable", "htable", "tenantfs=>size=32;autoexpire=0")

# Prometheus
modparam("xhttp_prom", "xhttp_prom_buf_size", 65536)
modparam("xhttp_prom", "xhttp_prom_stats", "all")
modparam("xhttp_prom", "xhttp_prom_pkg_stats", "yes")
modparam("xhttp_prom", "xhttp_prom_shm_stats", "yes")
modparam("xhttp_prom", "xhttp_prom_uptime_stats", "yes")

# KEMI Lua
modparam("app_lua", "load", "/etc/kamailio/router.lua")

# RTtimer for periodic reload
modparam("rtimer", "timer", "name=ds_sync;interval=60;mode=1")

####### KEMI dispatch — all routing in router.lua #######
cfgengine "lua"
```

### 4.4 `infra/kamailio/router.lua` — Full KEMI Lua Routing Script

```lua
-- router.lua — Kamailio KEMI routing for vici2 X02
-- All routing logic lives here; kamailio.cfg only loads modules.

local DS_SET_INBOUND  = 1
local DS_SET_OUTBOUND = 2

-- Carrier source IPs (group 1 in permissions address table)
local CARRIER_ACL_GROUP = 1
-- Internal network (Docker/FS) (group 2)
local INTERNAL_ACL_GROUP = 2

-- ──────────────────────────────────────────────────
-- Main request route
-- ──────────────────────────────────────────────────
function ksr_request_route()
    -- 1. Sanity checks
    if KSR.sanity.sanity_check(1511, 7) < 0 then
        KSR.x.exit()
    end

    -- 2. Max-Forwards check
    if KSR.maxfwd.process_maxfwd(10) < 0 then
        KSR.sl.sl_send_reply(483, "Too Many Hops")
        KSR.x.exit()
    end

    -- 3. Rate limiting (anti-flood)
    if KSR.pike.pike_check_req() < 0 then
        KSR.xlog.xlog("L_WARN", "PIKE blocked: $si:$sp\n")
        KSR.sl.sl_send_reply(429, "Too Many Requests")
        KSR.x.exit()
    end

    -- 4. Handle OPTIONS (health probes from FS back to Kamailio, or manual test)
    if KSR.pv.get("$rm") == "OPTIONS" and KSR.pv.get("$rU") == nil then
        KSR.sl.sl_send_reply(200, "OK")
        KSR.x.exit()
    end

    -- 5. Route in-dialog requests (loose routing)
    if KSR.rr.loose_route() > 0 then
        route_in_dialog()
        KSR.x.exit()
    end

    -- 6. Initial request routing
    if KSR.pv.get("$rm") == "INVITE" then
        route_initial_invite()
    elseif KSR.pv.get("$rm") == "REGISTER" then
        -- Kamailio does NOT handle agent registration (FS does via WSS profile)
        -- Only internal FS-to-FS or management REGISTERs land here; reject others.
        KSR.sl.sl_send_reply(403, "Registration not handled here")
    elseif KSR.pv.get("$rm") == "SUBSCRIBE" or KSR.pv.get("$rm") == "NOTIFY" then
        KSR.sl.sl_send_reply(200, "OK")
    else
        KSR.sl.sl_send_reply(405, "Method Not Allowed")
    end
end

-- ──────────────────────────────────────────────────
-- In-dialog request handling (re-INVITE, BYE, CANCEL, UPDATE, ACK)
-- ──────────────────────────────────────────────────
function route_in_dialog()
    local method = KSR.pv.get("$rm")

    if method == "ACK" then
        KSR.tm.t_relay()
        return
    end

    if method == "BYE" or method == "CANCEL" then
        -- Notify rtpengine to tear down media
        if KSR.is_module_loaded("rtpengine") then
            KSR.rtpengine.del()
        end
    elseif method == "INVITE" then
        -- re-INVITE: update rtpengine
        if KSR.is_module_loaded("rtpengine") then
            KSR.rtpengine.offer()
        end
    end

    KSR.tm.t_relay()
end

-- ──────────────────────────────────────────────────
-- Initial INVITE routing
-- ──────────────────────────────────────────────────
function route_initial_invite()
    -- Determine traffic class by source
    local src_ip = KSR.pv.get("$si")
    local set_id = DS_SET_INBOUND
    local algorithm = 0  -- default: hash by Call-ID

    -- Internal dialer engine or FS (Docker subnet 10.0.2.x or 10.0.1.x)
    if KSR.permissions.check_address(INTERNAL_ACL_GROUP, "$si", "$sp", "$pr") > 0 then
        set_id = DS_SET_OUTBOUND
        algorithm = 4  -- fewest-active for dialer outbound
    elseif KSR.permissions.check_address(CARRIER_ACL_GROUP, "$si", "$sp", "$pr") > 0 then
        set_id = DS_SET_INBOUND
        algorithm = 0  -- hash by Call-ID for inbound
    else
        KSR.xlog.xlog("L_WARN", "INVITE from unknown source $si — rejecting\n")
        KSR.sl.sl_send_reply(403, "Forbidden")
        KSR.x.exit()
    end

    -- Record-Route (so all in-dialog requests come back through Kamailio)
    KSR.rr.record_route()

    -- NAT detection and fixup
    if KSR.nathelper.nat_uac_test(19) > 0 then
        KSR.nathelper.fix_nated_contact()
        KSR.nathelper.fix_nated_sdp(1)
        KSR.setbflag(7)
    end

    -- rtpengine SDP offer rewrite (X01)
    if KSR.is_module_loaded("rtpengine") then
        KSR.rtpengine.offer()
    end

    -- Dispatcher selection
    if KSR.dispatcher.ds_select_dst(set_id, algorithm) < 0 then
        KSR.xlog.xlog("L_ERR", "dispatcher: no active backends in set " .. set_id .. "\n")
        KSR.sl.sl_send_reply(503, "Service Unavailable")
        KSR.hdr.append_after("Retry-After: 30\r\n", nil)
        KSR.x.exit()
    end

    -- Log dispatch decision
    KSR.xlog.xlog("L_INFO",
        "DISPATCH set=" .. set_id .. " dst=" .. KSR.pv.get("$rd") .. ":" .. (KSR.pv.get("$rp") or "5060") ..
        " ci=" .. KSR.pv.get("$ci") .. "\n")

    -- Register failure route for active failover
    KSR.tm.t_on_failure("fs_failure")

    KSR.tm.t_relay()
end

-- ──────────────────────────────────────────────────
-- Failure route: try next backend on timeout/5xx
-- ──────────────────────────────────────────────────
function ksr_failure_route_fs_failure()
    if KSR.tm.t_is_canceled() > 0 then return end

    local last_reply = KSR.pv.get("$T_reply_code") or 0

    -- 503 from FS = overloaded; 408 = timeout; 500 = crashed
    if last_reply == 503 or last_reply == 408 or last_reply == 500 or last_reply == 0 then
        -- Mark current destination as inactive + probing
        KSR.dispatcher.ds_mark_dst("ip")

        KSR.xlog.xlog("L_WARN",
            "FS backend failed (code=" .. last_reply .. "), marking inactive and trying next\n")

        -- Try next destination
        if KSR.dispatcher.ds_next_dst() < 0 then
            KSR.xlog.xlog("L_ERR", "No more backends available — sending 503\n")
            KSR.tm.t_reply(503, "All backends failed")
            return
        end

        -- Re-register failure route for the next attempt
        KSR.tm.t_on_failure("fs_failure")
        KSR.tm.t_relay()
    end
end

-- ──────────────────────────────────────────────────
-- Reply route: rtpengine answer rewrite
-- ──────────────────────────────────────────────────
function ksr_reply_route()
    local code = KSR.pv.get("$rs") or 0
    local method = KSR.pv.get("$rm") or ""

    if method == "INVITE" and code >= 200 and code < 300 then
        if KSR.is_module_loaded("rtpengine") then
            KSR.rtpengine.answer()
        end
    end
end

-- ──────────────────────────────────────────────────
-- xHTTP event route — Prometheus metrics + JSONRPC
-- ──────────────────────────────────────────────────
function ksr_event_route_xhttp_request()
    local path = KSR.pv.get("$hu") or ""

    if path == "/metrics" then
        KSR.xhttp_prom.dispatch()
        return
    end

    if path == "/jsonrpc" then
        KSR.jsonrpcs.dispatch()
        return
    end

    KSR.xhttp.xhttp_reply("404", "Not Found", "text/plain", "Not found\n")
end

-- ──────────────────────────────────────────────────
-- rtimer periodic DS reload from MySQL
-- ──────────────────────────────────────────────────
function ksr_event_route_rtimer_ds_sync()
    KSR.dispatcher.ds_reload()
end
```

### 4.5 `infra/kamailio/dispatcher.list` (Fallback File)

```
# Fallback dispatcher list — used if MySQL is unreachable at startup
# Format: setid flags weight attrs uri
# Set 1: inbound
1 0 1 weight=1 sip:10.0.1.10:5060
1 0 1 weight=1 sip:10.0.1.11:5060
# Set 2: outbound
2 0 1 weight=1 sip:10.0.1.10:5060
2 0 1 weight=1 sip:10.0.1.11:5060
```

### 4.6 `infra/kamailio/tls.cfg`

```
[server:default]
method         = TLSv1.2+
verify_certificate = no
require_certificate = no
certificate    = /etc/kamailio/tls/server.crt
private_key    = /etc/kamailio/tls/server.key
ca_list        = /etc/kamailio/tls/ca-bundle.crt
cipher_list    = HIGH:!aNULL:!MD5:!RC4
session_cache  = off

[client:default]
method         = TLSv1.2+
verify_certificate = no
require_certificate = no
certificate    = /etc/kamailio/tls/server.crt
private_key    = /etc/kamailio/tls/server.key
```

### 4.7 `infra/kamailio/scripts/dispatcher-list-renderer.py`

This script is called by the FS pool manager (or manually by ops) when FS instances are added or removed. It writes to the MySQL `dispatcher` table and triggers a hot reload.

```python
#!/usr/bin/env python3
"""
dispatcher-list-renderer.py
Syncs the Kamailio dispatcher table from the vici2 FS registry.
Called by: ops CLI, FS pool manager webhook, or cron.

Usage:
  python3 dispatcher-list-renderer.py --action=sync
  python3 dispatcher-list-renderer.py --action=add --fs-ip=10.0.1.12 --sets=1,2
  python3 dispatcher-list-renderer.py --action=remove --fs-ip=10.0.1.11
  python3 dispatcher-list-renderer.py --action=drain --fs-ip=10.0.1.11
"""

import argparse
import subprocess
import sys
import pymysql
import os

KAMAILIO_DB = {
    'host': os.environ.get('KAMAILIO_DB_HOST', '127.0.0.1'),
    'port': int(os.environ.get('KAMAILIO_DB_PORT', '3306')),
    'user': os.environ.get('KAMAILIO_DB_USER', 'kamailio'),
    'password': os.environ.get('KAMAILIO_DB_PASS', ''),
    'database': os.environ.get('KAMAILIO_DB_NAME', 'kamailio'),
}

VICI2_DB = {
    'host': os.environ.get('DATABASE_HOST', '127.0.0.1'),
    'port': int(os.environ.get('DATABASE_PORT', '3306')),
    'user': os.environ.get('DATABASE_USER', 'vici2'),
    'password': os.environ.get('DATABASE_PASS', ''),
    'database': os.environ.get('DATABASE_NAME', 'vici2'),
}

def kamcmd_reload():
    """Trigger Kamailio dispatcher reload via kamcmd."""
    result = subprocess.run(
        ['kamcmd', 'dispatcher.reload'],
        capture_output=True, text=True, timeout=10
    )
    if result.returncode != 0:
        print(f"WARNING: kamcmd reload failed: {result.stderr}", file=sys.stderr)
        return False
    print("Kamailio dispatcher reloaded.")
    return True

def get_vici2_fs_instances(vici2_conn):
    """Read active FS instances from vici2 fs_instances table."""
    with vici2_conn.cursor() as cur:
        cur.execute("""
            SELECT ip_address, sip_port, weight, status
            FROM fs_instances
            WHERE status IN ('active', 'draining')
            ORDER BY id
        """)
        return cur.fetchall()

def sync(args):
    """Full sync: replace dispatcher table content from vici2 fs_instances."""
    vici2_conn = pymysql.connect(**VICI2_DB)
    kam_conn   = pymysql.connect(**KAMAILIO_DB)
    instances  = get_vici2_fs_instances(vici2_conn)
    vici2_conn.close()

    with kam_conn.cursor() as cur:
        cur.execute("DELETE FROM dispatcher WHERE setid IN (1,2)")
        for fs in instances:
            ip, port, weight, status = fs['ip_address'], fs['sip_port'], fs['weight'], fs['status']
            dst = f"sip:{ip}:{port}"
            flags = 1 if status == 'draining' else 0  # DS_INACTIVE if draining
            for setid in [1, 2]:
                cur.execute(
                    "INSERT INTO dispatcher (setid, destination, flags, priority, attrs, description)"
                    " VALUES (%s, %s, %s, %s, %s, %s)",
                    (setid, dst, flags, 0, f'weight={weight}', f'fs-{ip}')
                )
    kam_conn.commit()
    kam_conn.close()
    print(f"Synced {len(instances)} FS instances to dispatcher table.")
    kamcmd_reload()

# ... add/remove/drain actions follow same pattern ...

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--action', required=True, choices=['sync', 'add', 'remove', 'drain'])
    parser.add_argument('--fs-ip')
    parser.add_argument('--sets', default='1,2')
    args = parser.parse_args()
    {'sync': sync}[args.action](args)
```

### 4.8 `infra/kamailio/scripts/healthcheck.sh`

```bash
#!/bin/bash
# healthcheck.sh — verifies Kamailio is alive and accepting SIP
# Sends an OPTIONS request; checks for 200 response.
# Exit 0 = healthy; non-zero = unhealthy.

SIP_PORT=${KAMAILIO_SIP_PORT:-5060}
TIMEOUT=${HEALTHCHECK_TIMEOUT:-3}

# Use nc/sipsak if available; fall back to kamcmd
if command -v sipsak &>/dev/null; then
    sipsak -s "sip:healthcheck@127.0.0.1:${SIP_PORT}" -o ${TIMEOUT} -q >/dev/null 2>&1
    exit $?
fi

# fallback: check that kamcmd responds
kamcmd core.info >/dev/null 2>&1
exit $?
```

### 4.9 `infra/kamailio/scripts/check_fs_load.py`

```python
#!/usr/bin/env python3
"""
check_fs_load.py — Poll ESL heartbeat from each FS; update dispatcher flags
if a FS is overloaded (>85% session capacity).
Run as a cron job or daemonized (every 30s).
"""
import os, time, socket, pymysql

FS_INSTANCES = os.environ.get('FS_INSTANCES', '10.0.1.10,10.0.1.11').split(',')
ESL_PORT     = int(os.environ.get('ESL_PORT', '8021'))
ESL_PASS     = os.environ.get('ESL_PASSWORD', 'ClueCon')
DRAIN_RATIO  = float(os.environ.get('FS_DRAIN_RATIO', '0.85'))

def esl_command(host, cmd):
    """Send a single ESL command and return the response body."""
    s = socket.create_connection((host, ESL_PORT), timeout=5)
    # ESL auth dance
    s.recv(1024)
    s.sendall(f'auth {ESL_PASS}\n\n'.encode())
    s.recv(1024)
    s.sendall(f'api {cmd}\n\n'.encode())
    resp = b''
    while b'\n\n' not in resp:
        resp += s.recv(4096)
    s.close()
    return resp.decode()

def check_and_flag():
    conn = pymysql.connect(host=os.environ.get('KAMAILIO_DB_HOST','127.0.0.1'),
                           user=os.environ.get('KAMAILIO_DB_USER','kamailio'),
                           password=os.environ.get('KAMAILIO_DB_PASS',''),
                           database='kamailio')
    for fs_ip in FS_INSTANCES:
        try:
            resp = esl_command(fs_ip, 'status')
            # Parse: "X session(s) - max Y sessions"
            import re
            m = re.search(r'(\d+) session.*?max (\d+)', resp)
            if m:
                current, max_s = int(m.group(1)), int(m.group(2))
                overloaded = current > DRAIN_RATIO * max_s
                flags = 1 if overloaded else 0
                with conn.cursor() as cur:
                    cur.execute(
                        "UPDATE dispatcher SET flags=%s WHERE destination LIKE %s",
                        (flags, f'sip:{fs_ip}:%')
                    )
                conn.commit()
                if overloaded:
                    import subprocess
                    subprocess.run(['kamcmd','dispatcher.reload'])
                    print(f"FS {fs_ip} flagged as overloaded ({current}/{max_s} sessions)")
        except Exception as e:
            print(f"Could not check {fs_ip}: {e}")
    conn.close()

if __name__ == '__main__':
    check_and_flag()
```

---

## 5. Health Probe Configuration

### 5.1 Parameters (set in kamailio.cfg)

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| `ds_ping_method` | `OPTIONS` | Standard SIP health check; every SIP server must respond |
| `ds_ping_interval` | `15` seconds | Detects failure within 45s (3 × 15s) |
| `ds_probing_mode` | `1` (probe all) | Proactive: detects dead FS before a call hits it |
| `ds_inactive_threshold` | `3` | 3 consecutive missed OPTIONS → mark inactive |
| `ds_restore_threshold` | `2` | 2 consecutive successful OPTIONS → restore |
| `ds_ping_reply_codes` | `200\|404\|486` | 200=pong; 404/486=FS alive but no user |

### 5.2 Probe Lifecycle State Machine

```
         +------------+
         |  ACTIVE    |◄───────── 2 consecutive 2xx/4xx/5xx
         +-----+------+
               │ 3 consecutive no-response/timeout
               ▼
         +------------+
         | INACTIVE   │──── calls skip this destination ────►  failover
         +-----+------+
               │ 2 consecutive 2xx/4xx/5xx
               ▼
         +------------+
         |  ACTIVE    │ (restored)
         +------------+
```

### 5.3 Probe Traffic Calculation

With N FS instances and 15s interval:
- 5 FS instances: 2 probes/second (2 Kamailio × 5 FS ÷ 15s ≈ 0.67/s)
- 10 FS instances: 1.3 probes/second
- 20 FS instances: 2.7 probes/second

Negligible. FS handles thousands of OPTIONS/second in production.

---

## 6. Dispatcher Modes Per Traffic Class

### 6.1 Inbound DID Traffic (Carrier → FS)

Flow:
```
Carrier → Kamailio VIP:5060 → dispatcher set 1 (hash Call-ID) → FS internal context
```

Call-ID hash ensures:
- re-INVITE from carrier → same FS.
- BYE from carrier → same FS.
- If selected FS is dead → ds_next_dst() tries another FS.

Routing decision source: `$si` (source IP) matches carrier ACL group 1.

### 6.2 Outbound Dialer Traffic (Dialer Engine → FS)

Flow:
```
Dialer engine (ESL bgapi originate to FS VIP) → Kamailio VIP → dispatcher set 2 (fewest-active) → FS
```

Note: The dialer engine connects to FreeSWITCH directly via ESL (port 8021), not via Kamailio. Kamailio intercepts the SIP originate that FS sends to the carrier. Specifically:

1. Dialer engine ESL `bgapi originate {origination_caller_id_name=...}sofia/external/+1NNNN@carrier_gateway <agent_conf_uuid>` on a specific FS.
2. FS sends INVITE to carrier via Kamailio (which sits in the media path due to Record-Route on carrier-facing profile).
3. OR: FS is configured with outbound proxy `sip:kamailio_vip:5060` so all SIP from FS exits through Kamailio.

For T03 (campaign-to-FS affinity per X03), dialer picks a specific FS ESL target. Kamailio's role is carrier-facing SIP routing, not dialer-to-FS.

The `ds_select_dst(2, 4)` path handles agent-less inbound being routed to an FS that will then push to an agent conference — e.g., IVR or queue routing.

### 6.3 Agent WebSocket Traffic (Browser → FS)

Browser agents connect via WSS to Kamailio VIP port 7443. Kamailio proxies the WSS SIP REGISTER to an FS instance. Kamailio does NOT process WebSocket upgrade itself — it uses the `websocket` module (or routes WSS to FS directly if FS handles WSS).

Two design options:
- **Option A (preferred)**: Kamailio terminates TLS/WSS, decodes SIP, routes via dispatcher to FS. FS receives plain SIP via TCP.
- **Option B**: Kamailio acts as TLS-terminating TCP proxy (via `corex`); FS receives WebSocket SIP. Simpler but fewer features.

vici2 uses **Option A**. FS agents register SIP via WSS→Kamailio→TCP→FS. Agent affinity for registration: hash by From URI (algorithm 3) so the same agent always registers to the same FS. Set 3 reserved for WSS agent routing.

### 6.4 X03 Campaign-Affinity Routing

When X03 is implemented, it sets `$avp(fs_affinity_uri)` to the specific FS URI for a campaign. Kamailio routing:

```lua
local affinity_uri = KSR.pv.get("$avp(fs_affinity_uri)")
if affinity_uri ~= nil then
    -- Direct route to pinned FS (bypass dispatcher set selection)
    KSR.pv.seti("$rU", nil)
    KSR.pv.sets("$rd", affinity_uri)
    KSR.tm.t_relay()
else
    -- Normal fewest-active dispatch
    KSR.dispatcher.ds_select_dst(DS_SET_OUTBOUND, 4)
    KSR.tm.t_relay()
end
```

X03 encodes `$avp(fs_affinity_uri)` in a SIP header `X-FS-Affinity: sip:10.0.1.11:5060`; Kamailio reads this header in `ksr_request_route()`.

---

## 7. Statistics / Prometheus

### 7.1 Metrics Endpoint

HTTP endpoint: `http://kamailio:9090/metrics` (path `/metrics` handled by `xhttp_prom`).

Prometheus scrape config (`prometheus.yml`):
```yaml
scrape_configs:
  - job_name: kamailio
    static_configs:
      - targets: ['10.0.0.10:9090', '10.0.0.11:9090']
    scrape_interval: 15s
```

### 7.2 Key Metrics to Alert On

| Metric | Alert Condition | Severity |
|--------|----------------|----------|
| `kamailio_dispatcher_reachable{set="1"}` | < total FS count | WARNING |
| `kamailio_dispatcher_reachable{set="1"}` | == 0 | CRITICAL |
| `kamailio_core_rcv_replies_total{code="503"}` | rate > 1/min sustained | WARNING |
| `kamailio_tm_active` | > 10000 | WARNING (capacity approaching) |
| `kamailio_shmem_used` | > 80% of shmem size | WARNING |
| `kamailio_pike_blocked_total` | rate > 0 | WARNING (possible scan) |

### 7.3 Custom Metrics from Lua

```lua
-- In ksr_request_route, after ds_select_dst:
KSR.xhttp_prom.counter_inc("vici2_dispatched_calls_total", 1,
    "set=" .. set_id .. ",algo=" .. algorithm)

-- In ksr_failure_route_fs_failure:
KSR.xhttp_prom.counter_inc("vici2_dispatch_failures_total", 1,
    "reason=" .. (KSR.pv.get("$T_reply_code") or "timeout"))
```

---

## 8. Keepalived / VRRP HA

### 8.1 Configuration

Two Kamailio VMs (or containers with macvlan): `10.0.0.10` (MASTER) and `10.0.0.11` (BACKUP). VIP: `10.0.0.100`.

`/etc/keepalived/keepalived.conf` on MASTER:
```
global_defs {
    router_id KAMAILIO_A
    enable_script_security
}

vrrp_script check_kamailio {
    script "/usr/local/bin/kamailio-scripts/healthcheck.sh"
    interval 2
    weight -60
    rise 2
    fall 3
}

vrrp_instance KAMAILIO_VIP {
    state MASTER
    interface eth0
    virtual_router_id 51
    priority 100
    advert_int 1
    authentication {
        auth_type PASS
        auth_pass vici2kam1
    }
    virtual_ipaddress {
        10.0.0.100/24 dev eth0 label eth0:vip
    }
    track_script {
        check_kamailio
    }
    notify_master "/usr/local/bin/kamailio-scripts/kamailio-reload.sh"
}
```

On BACKUP: identical, except `state BACKUP` and `priority 90`.

### 8.2 Failover Timing

- `advert_int = 1` → BACKUP detects MASTER failure within 3s (3 missed adverts).
- `healthcheck.sh interval = 2s`, `fall = 3` → if Kamailio process dies, VRRP priority drops by 60 within 6s → BACKUP takes over.
- Total failover: ≤10 seconds.
- SIP clients (carriers, SIP.js) retry INVITE on 503 within their retry interval (typically 5–30s) — they recover automatically.

### 8.3 Shared State Between Replicas

- Dispatcher state (which FS is active): read from MySQL `dispatcher` table on startup + every 60s (rtimer). Both Kamailio instances converge within 60s of any state change.
- `htable` contents (per-FS metrics, tenant→FS mapping): NOT shared. Each instance builds independently. Acceptable — the data is for routing hints, not hard state.
- `pike` blocked-IP table: NOT shared. Acceptable — a blocked IP will be blocked on whichever Kamailio handles subsequent requests.

---

## 9. ACL and Rate-Limiting Strategy

### 9.1 Carrier IP Allowlist

The `address` table in the Kamailio DB:

```sql
-- Group 1: carrier IPs
INSERT INTO address (grp, ip_addr, mask, port, tag) VALUES
  (1, '54.172.60.0', 24, 5060, 'twilio-us-east'),
  (1, '54.244.51.0', 24, 5060, 'twilio-us-west'),
  (1, '34.203.250.0', 24, 5060, 'telnyx'),
  -- ... other carrier ranges
  (2, '10.0.0.0',    8,  0,    'internal');

-- Reload after changes:
-- kamcmd permissions.reload
```

Carrier IP lists change infrequently. Ops procedure: add new ranges in `acl-carriers.conf`, apply via `kamcmd permissions.reload`. Automation: `check_carrier_ips.sh` cron that fetches current IP ranges from carrier API (Twilio publishes them as JSON) and updates the address table.

### 9.2 Pike Rate Limits by Source Type

| Source | Limit | Rationale |
|--------|-------|-----------|
| Carrier IPs (group 1) | 30 req/2s (15 req/s) | Bursts during mass inbound; carriers handle backpressure |
| Internal (group 2) | 200 req/2s | Dialer engine can batch-originate aggressively |
| Unknown IPs | 5 req/2s | Strict limit before ACL check; stops scanners fast |

### 9.3 Brute-Force Protection

- `sanity` module: rejects malformed SIP before it reaches routing logic (protects against fuzzing).
- `topoh`: hides FS IPs from external parties (prevents direct-to-FS attacks).
- FS ACL: FS only accepts SIP from Kamailio IP; direct external SIP to FS is blocked at firewall.

### 9.4 Firewall Rules (iptables / nftables)

```
# Only Kamailio VIP → FS SIP
-A INPUT -s 10.0.0.100/32 -p udp --dport 5060 -j ACCEPT
-A INPUT -p udp --dport 5060 -j DROP  # block direct-to-FS SIP
# Management
-A INPUT -s 10.0.3.0/24 -p tcp --dport 8021 -j ACCEPT  # ESL from mgmt
-A INPUT -p tcp --dport 8021 -j DROP
```

---

## 10. Acceptance Criteria

### 10.1 Functional Tests

| Test | Pass Condition |
|------|---------------|
| **Basic dispatch** | SIPp sends 100 INVITEs; wireshark confirms calls distributed across both FS instances |
| **Round-trip call** | Carrier SIP INVITE → Kamailio → FS → 200 OK → ACK → BYE; no errors |
| **Re-INVITE affinity** | Hold/resume (re-INVITE) reaches the same FS as the original INVITE (Call-ID hash) |
| **BYE routing** | BYE in-dialog reaches same FS |
| **OPTIONS probe response** | Kamailio sends OPTIONS to each FS every 15s; FS responds 200; `kamcmd dispatcher.list` shows all as active |

### 10.2 Failover Tests (Core Acceptance)

| Test | Procedure | Pass Condition |
|------|-----------|---------------|
| **FS hard kill** | `docker stop fs-1`; observe Kamailio probe behavior | Kamailio marks fs-1 inactive within ≤45s; new calls go to fs-2 only; `kamcmd dispatcher.list` confirms |
| **FS graceful drain** | Run `dispatcher-list-renderer.py --action=drain --fs-ip=10.0.1.10`; wait 30s | New calls skip fs-1; in-flight calls complete on fs-1 |
| **FS restore** | `docker start fs-1`; observe restore | fs-1 re-enters pool within 30s (2 × 15s); `dispatcher.list` shows active |
| **Kamailio failover (VRRP)** | Kill Kamailio MASTER process | VIP moves to BACKUP within ≤10s; SIPp retransmits succeed; no 503 delivered to client |
| **Full pool down** | Stop all FS instances | Kamailio returns 503 with Retry-After: 30 to all new INVITEs within 45s |
| **Failover during call** | Kill FS-1 mid-call | Active calls on fs-1 drop (expected — no live migration); new calls route to fs-2 within 45s |

### 10.3 Performance Tests

| Metric | Target |
|--------|--------|
| Kamailio throughput | ≥5000 SIP messages/second on reference hardware (4-core, 8GB) |
| Call setup latency (Kamailio overhead) | <5ms added latency (p99) |
| Failover detection time | ≤45s (3 × 15s probe interval) |
| VIP failover time | ≤10s |
| Prometheus scrape latency | <100ms for `/metrics` response |

---

## 11. LOC Estimate

| File | Estimated LOC |
|------|--------------|
| `kamailio.cfg` (module loading + params) | 150 |
| `router.lua` (KEMI routing logic) | 180 |
| `tls.cfg` | 25 |
| `dispatcher.list` (fallback) | 15 |
| `Dockerfile` | 35 |
| `dispatcher-list-renderer.py` | 120 |
| `check_fs_load.py` | 80 |
| `healthcheck.sh` | 20 |
| `kamailio-reload.sh` | 15 |
| `keepalived.conf` (both nodes) | 60 |
| `docker-compose.override.yml` | 40 |
| MySQL schema (`kamailio_schema.sql`) | 50 |
| `prometheus-scrape.yml` additions | 15 |
| **Total** | **~805 lines** |

---

## 12. Phase Plan

### Phase 3.5.0 — Foundation (Days 1–3)

1. `infra/kamailio/Dockerfile` — build and verify module list installs cleanly.
2. `kamailio.cfg` — module loading, basic params, `cfgengine "lua"`.
3. `router.lua` — minimal skeleton: sanity check → max-forwards → OPTIONS self-response → relay all else.
4. `docker-compose.override.yml` — add kamailio service with env vars.
5. Smoke test: Kamailio starts, responds to OPTIONS, `kamcmd core.info` works.

### Phase 3.5.1 — Dispatcher Core (Days 3–6)

1. MySQL dispatcher table schema.
2. `dispatcher-list-renderer.py` — `sync` action.
3. `dispatcher.list` fallback file.
4. `router.lua` — full routing logic: ACL check, inbound/outbound path, `ds_select_dst`, failure route.
5. Test: 2 FS instances, send SIPp INVITEs, verify both receive traffic.
6. Test: kill FS-1, verify failover within 45s.

### Phase 3.5.2 — TLS + WSS (Days 6–8)

1. `tls.cfg` — TLS profiles.
2. Dev cert generation script.
3. WSS routing path in `router.lua`.
4. Test: browser SIP.js connects via WSS → Kamailio → FS; call completes.

### Phase 3.5.3 — HA + Hardening (Days 8–10)

1. `keepalived.conf` — VRRP config for both nodes.
2. `healthcheck.sh` — used by Docker + keepalived.
3. `permissions` address table population (carrier ACLs).
4. `pike` rate-limit tuning.
5. `topoh` topology hiding.
6. Test: kill MASTER Kamailio; verify VIP failover ≤10s.

### Phase 3.5.4 — Observability (Days 10–12)

1. `xhttp_prom` metrics endpoint.
2. Prometheus scrape config additions.
3. Grafana dashboard: dispatcher health, call rate, failure counts.
4. Alertmanager rules.
5. `check_fs_load.py` — FS overload drain automation.
6. Test: all acceptance criteria pass.

### Phase 3.5.5 — Docs + Handoff (Day 12)

1. `spec/runbooks/kamailio.md` — ops runbook.
2. `spec/modules/X02/HANDOFF.md` — technical handoff for X03.
3. Update `docker-compose.yml` (merge override).
4. PR review + merge.

---

## 13. Risks and Mitigations

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|-----------|
| Auth challenge looping (401 from FS) | Medium | High | FS internal profile should not challenge SIP from Kamailio (whitelist Kamailio IP in FS ACL). If carrier challenges: add `from_gw` context handling in router.lua |
| WSS client re-registration storm after VRRP failover | Low | Medium | SIP.js has exponential backoff; Kamailio handles REGISTER bursts with pike limits |
| dispatcher.reload race condition (two Kamailio instances reload simultaneously) | Low | Low | MySQL SELECT is read-only; concurrent reload is safe |
| Lua script error causes 500 to all requests | Medium | High | Add `pcall()` wrapper around all KEMI functions; log errors with xlog; never let exceptions propagate unhandled |
| rtpengine (X01) unavailable at startup | Low | Medium | Guard all rtpengine calls with `KSR.is_module_loaded("rtpengine")` and try/catch; fall back to direct FS media |
| Carrier SIP-TLS cert validation failures | Medium | Medium | `verify_certificate = no` for inbound carriers (few carriers present valid certs); add per-carrier TLS client config when needed |

---

## 14. Dependencies on Adjacent Modules

| Module | Dependency Type | Notes |
|--------|----------------|-------|
| F03 | Prerequisite | FS must be up and responding to OPTIONS before dispatcher can probe it. FS Sofia profile must accept SIP from Kamailio IP without challenge. |
| T03 | Coordinate | T03 dialplan uses `*9${user_id}` — these come from browser via WSS through Kamailio. Kamailio must not modify the Request-URI user part. |
| X01 | Parallel | rtpengine module loaded in Kamailio; if X01 not deployed, `rtpengine.*` calls are skipped (guarded). |
| X03 | Downstream | X03 relies on the dispatcher sets defined here. X03 will read/write `$avp(fs_affinity_uri)` and expects Kamailio to honor it in routing. Document the header convention (`X-FS-Affinity`) in HANDOFF.md. |
| T04 | Coordinate | Dialer originate goes FS→carrier via Kamailio (outbound proxy). FS external profile must set `outbound-proxy = sip:10.0.0.100:5060`. |
