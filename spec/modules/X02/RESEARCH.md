# X02 — Kamailio SIP Dispatcher: Research

_Last updated: 2026-05-13_

---

## 1. Why Kamailio for a Call-Center SIP Proxy

Kamailio is a high-performance, production-hardened SIP proxy written in C. It handles millions of SIP messages per second on commodity hardware and ships with a `dispatcher` module specifically designed for load-balancing back-ends (FreeSWITCH, Asterisk, etc.). The vici2 project hits the single-FS ceiling around 100 concurrent agents; Kamailio is the documented solution path (DESIGN.md §16, Vicistack guide).

Key properties that make Kamailio the right choice over pure IP-level load balancers (HAProxy, nginx) for SIP:

- **SIP-aware routing** — reads Call-ID, From-tag, To-tag to enforce per-dialog affinity. HAProxy layer-4 hashing can approximate this but breaks on re-INVITE if a NAT changes the source IP.
- **Health probing at the SIP level** — `dispatcher` sends periodic SIP OPTIONS to each backend and interprets 200/4xx/timeout as health signals, not just TCP connect.
- **Failure routing at the message level** — can try next destination within the same transaction (no 503 to the client) if the first FS does not respond.
- **Active config reload** — `ds_reload` RPC reloads the dispatcher set from file or DB without dropping calls; no restart required.
- **KEMI** — Kamailio Embedded Interface allows the routing logic to be scripted in Lua (or JavaScript) so complex logic lives outside the native kamailio.cfg pseudo-language.

---

## 2. Kamailio Dispatcher Module (`dispatcher`)

### 2.1 Module Overview

The `dispatcher` module (path: `modules/dispatcher/`) maintains one or more **sets** of destination URIs. Each set is identified by an integer set ID. Routing functions pick a destination from a set and write it into the request URI (or an AVP), then forward.

Key parameters:
- `ds_ping_method` — SIP method for health probes (default `OPTIONS`).
- `ds_ping_interval` — probe interval in seconds (default 10; we set 30).
- `ds_probing_mode` — `0` = probe only inactive nodes (passive); `1` = probe all nodes (active).
- `ds_ping_reply_codes` — pipe-separated list of SIP codes to treat as alive (e.g. `200|404|486`; 404 and 486 indicate FS is up but no user found — still alive).
- `ds_inactive_threshold` — number of consecutive probe failures before marking a destination inactive (default 3).
- `ds_restore_threshold` — number of consecutive probe successes to restore an inactive destination.
- `ds_db_url` — if set, load destinations from DB instead of flat file.
- `ds_table_name` — DB table for destinations.
- `ds_flags` — per-destination bitmap of flags stored with each URI.

### 2.2 `ds_select_dst()` — Selection Algorithms

The function signature is:
```
ds_select_dst(set_id, algorithm)
```

`algorithm` is an integer:

| Code | Algorithm | Notes |
|------|-----------|-------|
| 0 | **Hashed by Call-ID** | Deterministic. Same Call-ID always picks same backend. Best for per-dialog affinity (re-INVITE, BYE reach same FS). |
| 1 | **Weighted round-robin** | Cycles through all active backends. Each destination's `attrs` field carries a `weight=N` param. FS instances with weight=2 get twice the traffic of weight=1. |
| 2 | **Hash by To-URI** | Routes based on the called party; useful for PBX fan-out where the same extension always lands the same box. |
| 3 | **Hash by From-URI** | Routes based on caller; useful for agent-to-FS affinity (one agent's calls all go same FS). |
| 4 | **Fewest-active (random)** | Picks the backend with fewest active connections; tie-broken randomly. **Recommended for outbound originate** (most even distribution when calls vary in duration). |
| 5 | **Hash by Authorization username** | Derived from SIP `Authorization: username` field. |
| 6 | **Random** | Pure random among active. |
| 7 | **Priority-ordered** | Tries highest-priority (lowest `priority` value) first; fails over to lower priority. |
| 8 | **Hashed by PV** (pseudo-variable) | Hashes on a configurable PV — e.g. `$avp(campaign_id)` for campaign affinity. X03 will use this. |
| 9 | **Fewest-active (deterministic)** | Like 4 but ties resolved by URI sort order. |

For vici2:
- **Set #1 (inbound DID → FS)**: algorithm 0 (hash by Call-ID) — ensures re-INVITE/BYE go same box.
- **Set #2 (outbound dialer → FS)**: algorithm 4 (fewest-active) — balances load across FS pool.
- **Set #3 (X03 campaign-pinned)**: algorithm 8 (hash by `$avp(fs_affinity)`) — X03 writes the FS URI into an AVP; Kamailio routes to it.

### 2.3 `ds_select_domain()` vs `ds_select_dst()`

`ds_select_dst()` replaces the request URI directly. `ds_select_domain()` populates `$rd` (R-URI domain) and `$rp` (port) separately — useful when you want to modify `r-uri` domain but keep the original `user` part. For FS, `ds_select_dst()` is the right choice because FS expects to see itself as the request URI.

### 2.4 `ds_mark_dst()` — Inline Failure Marking

When a branch fails (e.g. 408 timeout or connection refused), the routing script calls:
```
ds_mark_dst("ip")
```
This marks the current destination as inactive/probing and signals the module to try the next destination in the set. This enables per-transaction failover (the client never sees a 503).

### 2.5 Dispatcher List Format (flat file)

`/etc/kamailio/dispatcher.list`:
```
# setid flags weight attrs uri
1 0 1 weight=1 sip:10.0.1.10:5060
1 0 1 weight=1 sip:10.0.1.11:5060
1 0 2 weight=2 sip:10.0.1.12:5060
2 0 1 weight=1 sip:10.0.1.10:5060
2 0 1 weight=1 sip:10.0.1.11:5060
```

The `attrs` field is a free-form string; `dispatcher` respects `weight=N` in it for algorithm 1.

### 2.6 Dispatcher DB Backend

Instead of a flat file, `dispatcher` can query a MySQL table:
```sql
CREATE TABLE dispatcher (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  setid      INT NOT NULL DEFAULT 0,
  destination VARCHAR(192) NOT NULL DEFAULT '',
  flags      INT NOT NULL DEFAULT 0,
  priority   INT NOT NULL DEFAULT 0,
  attrs      VARCHAR(128) NOT NULL DEFAULT '',
  description VARCHAR(64) NOT NULL DEFAULT ''
);
```

Hot reload at runtime:
```
kamcmd dispatcher.reload
```
or via `XMLRPC`:
```
kamcmd jsonrpc.exec '{"method":"dispatcher.reload"}'
```

vici2 will use the DB backend: the dispatcher-list-renderer script (called on FS pool change events) writes to this table and triggers `dispatcher.reload` via kamcmd. This avoids any Kamailio restart.

---

## 3. Health Probe Mechanics

### 3.1 SIP OPTIONS Keepalive

Kamailio sends SIP `OPTIONS` messages to each backend at `ds_ping_interval` seconds. The probe OPTIONS is sent from Kamailio's bound IP/port to the FS SIP port. A response in the 2xx, 4xx, or 5xx range (configurable via `ds_ping_reply_codes`) counts as **alive**. No response within the SIP transaction timeout counts as **missed**.

Recommended `ds_ping_reply_codes = "200|404|486|408"`: 200 (ping response), 404 (extension not found — FS up), 486 (busy — FS up), 408 (timeout from FS, but we want to treat separately — see below).

Note: including 408 in ping_reply_codes would mask FS timeouts. Better to leave 408 out and let missed-probes tracking handle it.

### 3.2 Active vs Passive Probing Modes

- **`ds_probing_mode = 0` (passive)** — only probes destinations that have been marked inactive or suspect (latched into `DS_INACTIVE_DST`). Active healthy destinations are NOT probed. Lowers probe traffic but means you only discover FS death after the first failed call.
- **`ds_probing_mode = 1` (active)** — probes ALL destinations continuously. For a small FS pool (3–10 boxes), the probe overhead is negligible. This is the correct choice for production: you learn of FS health before the first call hits a dead box.
- **`ds_probing_mode = 2`** — probes only destinations with the `DS_PROBING_DST` flag set per destination.

vici2 uses `ds_probing_mode = 1`.

### 3.3 Threshold Semantics

With `ds_inactive_threshold = 3` and `ds_ping_interval = 30`:
- An FS instance going down is detected in at most 3 × 30 = **90 seconds** from last success.
- With `ds_ping_interval = 15`, detection is ≤45 seconds (matches the X02.md spec).
- With `ds_ping_interval = 10`, detection is ≤30 seconds.

The trade-off: shorter interval = faster detection but more OPTIONS traffic. At 10 FS instances with 10s interval, Kamailio sends 1 OPTIONS/10s/FS = 1 per second total — trivial load.

vici2 sets:
- `ds_ping_interval = 15`
- `ds_inactive_threshold = 3`
- `ds_restore_threshold = 2`

This gives ≤45s failover detection and 30s restore hysteresis.

### 3.4 Response Time Probing (Kamailio `rtimer` + AVP)

The dispatcher module does not track response latency natively, but Kamailio's `tm` module can record reply timestamps. A companion Lua KEMI script can read `$Ri` (reply received time) vs. `$T_req_start` for each probe and store per-backend RTT in a shared hash table (`$sht(probe=>dst:rtt)`). This RTT data can be exported to Prometheus via the HTTP API module.

The `htable` module stores `rtt_<fs_ip>` values; the metrics exporter script reads them.

---

## 4. Failover Semantics

### 4.1 Active Failover (Per-Transaction)

When `ds_select_dst()` picks a backend and the forward fails (timeout or connection refused), Kamailio can try the next destination without returning a 5xx to the client:

```lua
-- KEMI Lua example
if not KSR.dispatcher.ds_select_dst(1, 4) then
    KSR.sl.sl_send_reply(503, "Service Unavailable")
    return
end
KSR.tm.t_on_failure("route_failure")
KSR.tm.t_relay()
```

In the failure route:
```lua
function ksr_failure()
    if KSR.tm.t_is_canceled() then return end
    -- mark current dst bad, try next
    KSR.dispatcher.ds_mark_dst("ip")
    if not KSR.dispatcher.ds_next_dst() then
        KSR.sl.sl_send_reply(503, "No available backends")
        return
    end
    KSR.tm.t_relay()
end
```

`ds_next_dst()` picks the next destination in the set (following the same algorithm). Combined with `ds_mark_dst()`, Kamailio will skip all dead backends until it finds one or exhausts the list.

### 4.2 Passive Failover (Health-State Based)

`ds_select_dst()` skips destinations with `DS_INACTIVE_DST` flag by default. So once a backend is marked inactive by probing, all new calls automatically avoid it — no per-call failure routing needed for steady-state. The active failover (per-transaction) only matters for the window between a backend dying and the probe detecting it.

### 4.3 In-Dialog Request Affinity

Re-INVITE, UPDATE, BYE, CANCEL, PRACK — all mid-dialog requests carry the same Call-ID and must reach the same FS instance. Kamailio handles this in two ways:

1. **Hash-by-Call-ID (algorithm 0)**: Works as long as the Call-ID doesn't change. Stateless — no shared state needed between Kamailio replicas.

2. **Loose routing with Record-Route**: When Kamailio inserts itself in the Record-Route header, all subsequent in-dialog requests are routed through Kamailio. Kamailio can then re-apply the hash-by-Call-ID to route to the same FS. This is the recommended approach for multi-Kamailio-replica setups where any Kamailio instance may handle any request.

For vici2: Kamailio adds a `Record-Route` on INVITE; all subsequent in-dialog requests arrive at Kamailio and are dispatched by Call-ID hash — guaranteeing same FS.

### 4.4 Split-Brain Scenario

With two Kamailio replicas behind a VIP:
- If one Kamailio replica loses its view of the FS pool (network partition), it may have different health state than the other.
- Mitigation: both Kamailio instances share the same MySQL dispatcher table. Probes from both instances update a shared `last_seen` timestamp in the DB. If one Kamailio marks an FS as inactive (via DB flag update), the other picks this up on the next `ds_reload` (triggered by a timer — every 60s or on flag change).
- Alternative: use Kamailio's `dmq` (Distributed Message Queue) module to sync dispatcher state in real time between replicas.

For vici2 Phase 3.5, MySQL-shared state with 60s sync is sufficient. Full DMQ is Phase 5+.

### 4.5 Slow-Poke FreeSWITCH

An FS instance may respond to OPTIONS (not dead) but be severely overloaded and processing calls slowly. Symptoms: high call setup latency, audio quality issues.

Detection strategy:
- Track OPTIONS RTT via `rtimer`; if RTT > 2s for 3 consecutive probes, add `DS_INACTIVE_DST` flag manually via `kamcmd dispatcher.set_state ip sip:10.0.1.12:5060 1`.
- Alternatively: FS ESL event `HEARTBEAT` includes `Session-Count` and `Max-Sessions`. The vici2 dispatcher-renderer script reads this via ESL and updates `dispatcher.flags` for overloaded FS instances.

### 4.6 Full Pool Failure

If all destinations in a set are marked inactive, `ds_select_dst()` returns false. The routing script must handle this gracefully:

```lua
if not KSR.dispatcher.ds_select_dst(1, 4) then
    KSR.tm.t_reply(503, "All backends unavailable")
    return
end
```

For inbound calls: return 503 with `Retry-After: 30` to encourage the carrier to retry.
For dialer-originated: the dialer engine will see ESL event `CHANNEL_HANGUP_COMPLETE` with `Hangup-Cause: NO_ROUTE_DESTINATION` — pacing loop should pause.

---

## 5. KEMI Scripting (Lua)

### 5.1 What is KEMI

KEMI (Kamailio Embedded Interface) is Kamailio's foreign-function interface, allowing routing logic to be written in Lua (via `app_lua`), JavaScript (Node.js via `app_jsdt`), Python (via `app_python3`), or Ruby. The native `kamailio.cfg` format is powerful but its macro-like syntax is hard to maintain; KEMI Lua is significantly more readable and testable.

### 5.2 KEMI Lua Entry Points

Kamailio calls into Lua through named functions that correspond to routing blocks:

| Kamailio block | Lua function |
|----------------|-------------|
| `request_route` | `ksr_request_route()` |
| `reply_route` | `ksr_reply_route()` |
| `failure_route[NAME]` | `ksr_failure_route_NAME()` |
| `branch_route[NAME]` | `ksr_branch_route_NAME()` |
| `event_route[NAME]` | `ksr_event_route_NAME()` |

### 5.3 Key KEMI Lua API Points

```lua
-- Module access
KSR.dispatcher.ds_select_dst(setid, algorithm)
KSR.dispatcher.ds_mark_dst(mode)  -- "ip" = mark inactive + probing
KSR.dispatcher.ds_next_dst()
KSR.tm.t_relay()
KSR.tm.t_on_failure("failure_handler")
KSR.sl.sl_send_reply(code, reason)
KSR.hdr.append("X-FS-ID: " .. fs_ip .. "\r\n")
KSR.pv.seti("$avp(fs_set)", setid)
KSR.pv.get("$ci")   -- Call-ID
KSR.pv.get("$fu")   -- From URI
KSR.pv.get("$tu")   -- To URI
KSR.pv.get("$rm")   -- Request Method
KSR.pv.get("$src_ip") -- source IP
KSR.rtpengine.offer() -- for X01 integration
KSR.rtpengine.answer()
KSR.permissions.check_address(group, ipvar, portvar, protovar)
KSR.pike.pike_check_req()  -- rate limiting
```

### 5.4 Lua vs JavaScript KEMI

Both are supported. Lua advantages for vici2:
- Simpler syntax for routing tables (Lua tables are more compact than JS objects).
- `lua` is lighter than `node.js`; no event loop overhead.
- Kamailio `app_lua` runs Lua 5.1 (LuaJIT if built with it) — deterministic, no GC surprises.
- Better tested in Kamailio community; more examples.

JavaScript (`app_jsdt`) uses Duktape (not V8) — lighter than Node but less featureful. Ruled out: the ecosystem has fewer examples for Kamailio use specifically.

**Decision: Lua.**

### 5.5 Runtime Configuration Updates (JSRPC/kamcmd)

Even with Lua routing logic, operational parameters (dispatcher set state, rate-limit thresholds) can be updated without restarting Kamailio:

```bash
# Reload dispatcher from DB
kamcmd dispatcher.reload

# Mark a specific FS as inactive (manual maintenance)
kamcmd dispatcher.set_state ip sip:10.0.1.11:5060 1

# Mark FS as active again
kamcmd dispatcher.set_state ap sip:10.0.1.11:5060 1

# Show current dispatcher state
kamcmd dispatcher.list

# Reload Lua script
kamcmd app_lua.reload /etc/kamailio/router.lua
```

The `kamcmd` utility communicates with Kamailio's UNIX socket (`/var/run/kamailio/kamailio_ctl`) via the BINRPC protocol. For remote management, enable the XMLRPC or JSONRPC HTTP listener.

---

## 6. Multi-Tenant Routing

### 6.1 Per-Tenant SIP Profile Selection

In vici2, tenants share the same Kamailio instance but are isolated at the application layer. Tenant identification in Kamailio:

1. **By carrier source IP + DID**: inbound calls arrive from carrier; Kamailio reads `$si` (source IP), looks up in `htable(carrier_tenant)` to get `tenant_id`. Sets `$avp(tenant_id)`.
2. **By SIP domain**: agents register with SIP URI `user@tenant.vici2.example.com`; `$td` (To domain) identifies the tenant.
3. **By custom SIP header**: internal calls from dialer carry `X-Tenant-ID: <uuid>` header.

### 6.2 Per-Tenant FS Pool Routing

Different tenants may be pinned to different FS instances (or share a pool). Dispatcher sets encode this:
- Set 1: shared pool (all FS instances).
- Sets 10–19: tenant-specific subsets for premium tenants needing isolation.

Lua routing logic:
```lua
local tenant_id = KSR.pv.get("$avp(tenant_id)")
local set_id = tenant_fs_sets[tenant_id] or 1  -- default to shared
KSR.dispatcher.ds_select_dst(set_id, 4)
```

`tenant_fs_sets` is a Lua table loaded from MySQL at startup (or reloaded via `app_lua.reload`).

---

## 7. rtpengine Integration

### 7.1 Architecture with rtpengine and Kamailio

When rtpengine is deployed (X01), the SIP signaling flow changes:

```
UA ──INVITE──→ Kamailio ──(rtpengine offer)──→ rtpengine (modify SDP)
                              ──INVITE──→ FreeSWITCH
FS ──200 OK──→ Kamailio ──(rtpengine answer)──→ rtpengine (modify SDP)
                              ──200 OK──→ UA
Media: UA ←──RTP──→ rtpengine ←──RTP──→ FS
```

Kamailio is the signaling anchor; rtpengine is the media anchor. FS never sees external IPs in the SDP.

### 7.2 `rtpengine` Kamailio Module

The `rtpengine` Kamailio module communicates with rtpengine via UDP control protocol (default port 22222):

```
loadmodule "rtpengine.so"
modparam("rtpengine", "rtpengine_sock", "udp:127.0.0.1:22222")
```

In KEMI Lua:
```lua
-- On INVITE (offer)
KSR.rtpengine.offer()

-- On 200 OK (answer)
KSR.rtpengine.answer()

-- On BYE/CANCEL
KSR.rtpengine.del()
```

### 7.3 rtpengine Interaction with Dispatcher

`ds_select_dst()` selects the FS backend. After selection, `rtpengine.offer()` rewrites the SDP to pin media through rtpengine. The FS SDP answer comes back and `rtpengine.answer()` closes the media path.

If Kamailio fails over to a different FS mid-call (theoretically shouldn't happen with Call-ID hash, but possible in edge cases), the rtpengine session must be updated. This is handled by `rtpengine.offer()` being called again in the re-INVITE path.

### 7.4 rtpengine Health

rtpengine itself can be monitored: the `rtpengine` Kamailio module marks an rtpengine instance as failed if the control socket doesn't respond. Multiple rtpengine instances can be configured:
```
modparam("rtpengine", "rtpengine_sock",
  "udp:10.0.1.10:22222 udp:10.0.1.11:22222")
```
Round-robins between them; marks failed ones inactive.

---

## 8. Dispatcher Routing Tables and DB Backends

### 8.1 File Backend

`/etc/kamailio/dispatcher.list` — reloaded via `ds_reload_by_rotate()` or `ds_reload()` MI command. Simple, no external dependency, but requires file write + MI command for changes.

### 8.2 MySQL Backend

```
modparam("dispatcher", "db_url", "mysql://kamailio:pass@localhost/kamailio")
modparam("dispatcher", "table_name", "dispatcher")
modparam("dispatcher", "ds_db_default_reachable", 1)
```

On startup, reads all rows. On `dispatcher.reload` MI command, re-reads from DB. The vici2 dispatcher-renderer writes to this table when the FS pool changes (FS added/removed/maintenance).

### 8.3 Combined Approach (file as fallback)

Pattern: primary = MySQL, fallback = file. If MySQL is unreachable at startup, `ds_load_file()` reads the flat file. This ensures Kamailio can start even during a DB outage.

### 8.4 Key-Value Backend (Redis)

Kamailio 5.6+ can use the `ndb_redis` module to read dispatcher URIs from Redis. Useful when the FS pool is managed by a Redis-aware orchestrator. vici2 already uses Redis for agent state; this is a Phase 4+ option.

---

## 9. Failure Modes In Depth

### 9.1 Split-Brain (Two Kamailio Replicas, DB Divergence)

Scenario: Kamailio-A and Kamailio-B share a VIP. DB link from Kamailio-A to MySQL fails. Kamailio-A's dispatcher state is stale (cannot reload). Kamailio-B reloads correctly.

Mitigation:
- Kamailio-A logs a CRIT error and alerts.
- Both Kamailio replicas run a 60s periodic `ds_reload`. If either fails, it serves stale but functional state (routes to all destinations it last knew).
- Monitor `dispatcher.list` inconsistency via Prometheus metric `kamailio_dispatcher_unhealthy_total`.

### 9.2 Slow-Poke FS

Scenario: FS responds to OPTIONS (200 OK) within 3s. `ds_ping_interval = 15s`. Kamailio marks it healthy. But SIP INVITEs from FS to agents are taking 8s to set up (agent media delayed).

Detection:
- SIPp test: track 200-to-ACK latency per FS.
- ESL monitor: FS `heartbeat` event includes `Max-Sessions` and `Session-Count`. If `Session-Count > 0.85 * Max-Sessions`, mark as degraded.
- Kamailio `rtimer`: measure INVITE→180 latency per destination; if p95 > 3s, reduce weight.

Response:
- Reduce weight of slow FS in dispatcher table (update `attrs` field, `dispatcher.reload`).
- Drain: set `DS_INACTIVE_DST` flag for new calls; in-flight calls complete naturally (no FS restart).

### 9.3 Full FS Pool Down

All FS instances fail simultaneously (data center network event, bad deploy).

Kamailio behavior:
- All destinations marked inactive by probe failures within `3 × ds_ping_interval`.
- `ds_select_dst()` returns false.
- Kamailio replies 503 with `Retry-After: 30` to all new INVITEs.
- Inbound carrier: carrier retries; if duration < 30min, calls recover automatically when FS restores.
- Outbound dialer: dialer engine sees 503 or `NO_ROUTE_DESTINATION`; pauses pacing; resumes when health check passes.

Recovery:
- As FS instances come back, `ds_restore_threshold = 2` means each needs 2 successful OPTIONS before re-entering the pool.
- First FS restored: Kamailio starts routing there; other FS instances progressively restored.

### 9.4 Kamailio Restart Mid-Call

Kamailio is stateless at the SIP transaction level (for UDP). Mid-call Re-INVITEs and BYEs carry Route headers set by the original Kamailio Record-Route. After a Kamailio restart, those Route headers point to the Kamailio VIP (not a specific instance), so in-flight dialog requests route to the newly started Kamailio.

TCP SIP connections: re-established by the UA/FS on next request. Possible brief delay.

WebSocket (WSS): agent SIP.js will reconnect after Kamailio restart within SIP.js's reconnect interval (default 5s).

---

## 10. Kamailio 5.7+ Features Relevant to vici2

### 10.1 Version Notes

Kamailio 5.7 (2023) and 5.8 (2024) introduced:
- **KEMI Lua 5.4 support** via `app_lua` update (5.1 was default; 5.4 brings proper integer types and bitwise ops).
- **Improved `htable` clustering** — hash table contents can be synced via DMQ.
- **`rtpengine` module updates** — WebRTC ICE and DTLS-SRTP interoperability improvements.
- **`http_async_client`** — async HTTP calls from KEMI without blocking worker threads.
- **`sipjson` module** — parse/generate JSON in routing script, useful for API callbacks.

### 10.2 Kamailio 6.0 (2025)

Kamailio 6.0 is the current major version as of 2025. Key changes:
- Native IPv6 in dispatcher (parity with IPv4).
- Improved `dispatcher` DB backend with connection pooling.
- `app_lua` now defaults to Lua 5.4 where available.
- Official Docker images at `kamailio/kamailio:6.0-bullseye`.

vici2 targets Kamailio 6.0 for Phase 3.5.

---

## 11. Security Hardening Considerations

### 11.1 ACL / Permissions Module

The `permissions` module provides address-group-based ACL:
```
loadmodule "permissions.so"
modparam("permissions", "db_url", DBURL)
modparam("permissions", "address_table", "address")
```

`address` table maps `(group_id, ip, mask, port, tag)`. Groups:
- Group 1: Carrier IPs (allowed inbound SIP from outside).
- Group 2: Internal network (Docker subnet, allowed all methods).
- Group 3: Agent IPs (optional; useful for dedicated softphone devices).

In routing:
```lua
if not KSR.permissions.check_address(1, "$si", "$sp", "$pr") then
    KSR.sl.sl_send_reply(403, "Forbidden")
    return
end
```

### 11.2 Pike (Rate Limiting)

The `pike` module tracks requests per source IP per unit time and bans flooding IPs:
```
modparam("pike", "sampling_time_unit", 2)
modparam("pike", "reqs_density_per_unit", 30)
modparam("pike", "remove_latency", 4)
```

30 requests/2s = 15 req/s max per IP before blocking. Legitimate carrier SIP should never exceed this; scanners will be blocked.

### 11.3 Topology Hiding

The `topoh` module rewrites Via/Contact/Record-Route headers to hide internal FS IPs from the carrier:
```
loadmodule "topoh.so"
modparam("topoh", "mask_key", "random-secret")
modparam("topoh", "mask_ip", "203.0.113.10")  -- Kamailio's public IP
```

External parties see only Kamailio's IP; FS private IPs are never exposed. This is important for multi-tenant deployments and carrier compatibility.

### 11.4 TLS Configuration

Kamailio TLS for carrier SIP-TLS and WSS:
```
listen=tls:0.0.0.0:5061
listen=tls:0.0.0.0:7443
```

`tls.cfg`:
```
[server:default]
method = TLSv1.2+
verify_certificate = no   # inbound carriers rarely present certs
require_certificate = no
certificate = /etc/kamailio/tls/server.crt
private_key = /etc/kamailio/tls/server.key
ca_list = /etc/kamailio/tls/ca-bundle.crt
```

WSS for browser agents: same TLS certificate (must be publicly trusted — Let's Encrypt).

---

## 12. Prometheus Metrics

Kamailio exposes metrics via the `xhttp` + `xhttp_prom` modules (Kamailio 5.5+):

```
loadmodule "xhttp.so"
loadmodule "xhttp_prom.so"
modparam("xhttp_prom", "xhttp_prom_buf_size", 65536)
modparam("xhttp_prom", "xhttp_prom_stats", "all")
```

HTTP endpoint: `http://kamailio:9090/metrics` — Prometheus scrapes this.

Available metrics include:
- `kamailio_core_rcv_requests_total` — requests received by method.
- `kamailio_core_fwd_requests_total` — forwarded requests.
- `kamailio_dispatcher_reachable` — reachable destinations per set.
- `kamailio_dispatcher_unreachable` — unreachable destinations per set.
- `kamailio_tm_active` — active transactions.
- `kamailio_shmem_used` — shared memory usage.

Custom metrics via Lua:
```lua
KSR.xhttp_prom.counter_inc("vici2_calls_dispatched_total", 1, {set=tostring(set_id)})
KSR.xhttp_prom.gauge_set("vici2_fs_active_sessions", sessions, {fs=fs_ip})
```

---

## 13. NAT Traversal

### 13.1 Agent WebSocket NAT

Browser agents connect via WSS from behind NAT. Kamailio's `nathelper` module patches SDP and Contact headers to use the correct public IP:

```
loadmodule "nathelper.so"
modparam("nathelper", "natping_interval", 30)
modparam("nathelper", "ping_nated_only", 1)
modparam("nathelper", "sipping_bflag", 7)
```

In routing:
```lua
if KSR.nathelper.nat_uac_test(19) then
    KSR.nathelper.fix_nated_contact()
    KSR.nathelper.fix_nated_sdp(1)
    KSR.setbflag(7)  -- mark for keep-alive pings
end
```

`nat_uac_test(19)` = RFC1918 in Contact (1) + RFC1918 in Via (2) + private SDP IP (16). Bitmask 19 = 1+2+16.

### 13.2 Carrier-Side NAT

Carriers typically don't NAT (static IPs). FS sits on a private IP; Kamailio's `topoh` hides this. Media flows via rtpengine which is on a public IP.

---

## 14. Keepalived / VRRP for Kamailio HA

### 14.1 Active-Active vs Active-Passive

**Active-passive (1 VIP, 1 active Kamailio, 1 standby):**
- Simpler; keepalived `MASTER`/`BACKUP` with VIP floating.
- Failover time: 3–10 seconds (keepalived dead interval).
- During failover, in-flight SIP transactions may fail (Kamailio state is not replicated). This is acceptable for UDP SIP (client retransmits).

**Active-active (2 VIPs, round-robined by DNS or by carrier config):**
- Both Kamailio instances receive traffic. Session state is symmetric (no shared state needed for UDP SIP with hash routing).
- Keepalived used for each instance's own VIP (health check only).
- If one Kamailio fails, carriers need to detect and switch VIPs — requires DNS TTL management or carrier-side failover config.

vici2 Phase 3.5 target: **active-passive** with a single VIP. Simpler, and the failover window (3–10s) is acceptable since SIP clients retransmit. Phase 5+ can introduce active-active.

### 14.2 keepalived.conf Structure

```
vrrp_instance KAMAILIO_VIP {
    state MASTER
    interface eth0
    virtual_router_id 51
    priority 100
    advert_int 1
    authentication {
        auth_type PASS
        auth_pass secret123
    }
    virtual_ipaddress {
        10.0.0.100/24
    }
    track_script {
        check_kamailio
    }
}

vrrp_script check_kamailio {
    script "/usr/local/bin/check_kamailio.sh"
    interval 2
    weight -50
}
```

`check_kamailio.sh` sends a local OPTIONS to `127.0.0.1:5060` and checks the response. If Kamailio is dead, the script returns non-zero, priority drops by 50, and BACKUP takes over.

---

## 15. Open Questions

1. **`dispatcher` file vs DB**: At what FS pool size does DB polling overhead become measurable? Benchmark at 10, 50, 100 FS instances. File is always faster to read; DB is easier to update programmatically.

2. **DMQ vs MySQL-shared state for dual-Kamailio**: DMQ (Distributed Message Queue) syncs dispatcher health state in real time between Kamailio instances. Is this necessary for Phase 3.5 (2 Kamailio replicas), or is 60s MySQL-sync sufficient? If an FS dies and the MySQL-sync lag means one Kamailio doesn't know for 60s, calls during that window may fail. Acceptable?

3. **rtpengine failure with Kamailio**: If rtpengine is down but FS is up, do we route calls without SRTP offload (falling back to FS handling SRTP directly)? This requires per-call detection of rtpengine availability and a bypass routing path.

4. **WSS agent connection affinity**: A browser agent connects WSS to Kamailio. If the VIP fails over to the backup Kamailio, the WSS connection drops and SIP.js reconnects. Does this cause an agent-state flicker? The debounce in T03 (5s) should cover this.

5. **Kamailio ACL and carrier IP rotation**: Twilio/Telnyx periodically add/change edge IPs. How do we keep the `address` table current? Options: (a) subscribe to carrier IP change notifications, (b) allow the carrier's AS (BGP prefix), (c) validate via SIP credentials instead of IP.

6. **Algorithm 8 (PV hash) for X03**: X03 will set `$avp(fs_affinity_uri)` to the specific FS URI a campaign is pinned to. Algorithm 8 hashes on a PV. Does `ds_select_dst(set_id, 8)` respect the PV to pick a *specific* URI (not just consistent hashing)? Need to verify: the PV algorithm does consistent hash, not exact match. For exact-URI routing, use `ds_is_from_list()` + `ds_select_dst` in combination, or use a different approach (direct `$du` / `$fs` manipulation).

7. **Load metric source**: The dispatcher's fewest-active algorithm (algorithm 4) counts active dialogs in Kamailio's transaction table — not actual FS session count. Kamailio sees each SIP dialog as one transaction, which maps 1:1 to an FS session, so this is accurate as long as Kamailio processes all SIP traffic. But if FS talks directly to a carrier (e.g., for PSTN call recording), those sessions are invisible to Kamailio.

8. **Kamailio 6.0 Docker image**: Verify `kamailio/kamailio:6.0-bullseye` is production-stable and includes the required modules (`dispatcher`, `app_lua`, `rtpengine`, `permissions`, `pike`, `topoh`, `nathelper`, `htable`, `xhttp_prom`). Some modules are not compiled into the base image and require `kamailio-extra-modules` Debian package.
