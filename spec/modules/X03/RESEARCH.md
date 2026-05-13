# X03 — Multi-FS Campaign Affinity: Research

_Last updated: 2026-05-13 | Phase 3.5 | Status: NOT_STARTED_

---

## 1. Why Campaign Affinity Is Necessary

### 1.1 The Conference-Per-Agent Invariant

Vici2 inherits Vicidial's architectural heart: every logged-in agent occupies a persistent FreeSWITCH conference room for the duration of their session. Outbound calls, inbound transfers, whisper coaching, and 3-way conferences all work by joining or leaving that one conference room. This collapses all call-control operations — blind transfer, warm transfer, leave-3way, park-and-dial — into a single primitive: `conference member add/kick`.

This model is elegant and operationally simple when all parties (agent conference, customer call leg, carrier gateway) are on the same FreeSWITCH instance. The conference state is in-process memory on that FS node. ESL commands target a local socket. Everything is synchronous.

The invariant that makes this work: **agent home conference and all their campaign's active calls must reside on the same FreeSWITCH process.**

### 1.2 What Happens Without Affinity

Without affinity, the dialer engine may originate a customer leg on FS-2 while the agent conference lives on FS-1. To bridge these two legs, one of the following must occur:

#### Option A: SIP Re-INVITE hairpin through Kamailio
The customer leg on FS-2 is directed to call the agent's SIP extension, which Kamailio routes back to FS-1 where the conference lives. This produces:

- Two SIP signaling transactions through Kamailio per joined leg.
- RTP media travels FS-2 → Kamailio/rtpengine → FS-1 or FS-2 → Kamailio → FS-1 depending on media anchoring configuration.
- Added round-trip latency of 5–40 ms depending on topology.
- Two additional RTP re-encode hops if G.711 is not end-to-end (transcoding penalty).
- Kamailio must maintain call-leg state correlation across three SIP dialogs (customer, agent, inter-FS bridge).

#### Option B: `mod_loopback` with cross-channel bridging
FreeSWITCH `mod_loopback` creates a virtual channel pair (`loopback/...`) that acts as a SIP-like loopback inside one FS instance. To bridge FS-2's customer leg to an FS-1 conference, you would need a loopback channel on FS-2 that acts as the "remote conference participant", then an actual SIP call from FS-2 to FS-1.

This is effectively option A with extra complexity: loopback channels consume memory and processing equivalent to a real channel pair, and you still need a SIP hop between instances.

#### Option C: ESL `uuid_bridge` across FS instances
ESL `uuid_bridge` can only bridge two channels that exist on the same FS process. There is no cross-FS `uuid_bridge`. Attempting to bridge a UUID from FS-1 on FS-2's ESL connection returns an error. This is a hard limitation of FreeSWITCH's channel model.

#### Option D: `mod_event_socket` remote channel control
You can instruct FS-1 to execute `uuid_transfer` to push the customer call to a conference extension on FS-1 — but this only works if the customer call is already on FS-1. If the customer leg was originated from FS-2, you cannot transfer that UUID from FS-1.

**Conclusion:** All cross-FS bridging paths either require a SIP hop (hairpin, option A), a loopback channel pair (option B), or are simply unavailable (options C, D). Every one of these approaches adds latency, complexity, and failure modes. Affinity is the only operationally clean solution.

### 1.3 Latency and Quality Impact

A SIP hairpin between two FS instances on the same LAN adds approximately 10–30 ms of one-way latency to the media path (network RTT + RTP processing on the intermediate node). For a call-center voice call, where ITU-T G.114 recommends ≤150 ms one-way, this is significant:

- Agent-supervisor whisper on a hairpinned call now has two extra hops.
- DTMF detection at FS may occur on the wrong instance (customer leg on FS-2, DTMF handler on FS-1 conference).
- Recording: `mod_record_session` records the channel on the FS where it originates. A hairpinned call produces partial recording on FS-2 + partial on FS-1, requiring post-call merge.

### 1.4 FreeSWITCH Conference Memory Model

FreeSWITCH `mod_conference` maintains all member state in-process in a linked list guarded by a mutex per conference. Conference UUIDs are local to the FS process. The ESL command `conference <name> list` only sees members on the local instance.

This means:
- `conference_set_auto_outcall` (used for warm transfer) only works if the conference is local.
- `conference <name> kick <member-id>` operates on local member IDs.
- Supervisor eavesdrop/whisper (`conference <name> relate <member1> <member2> nospeak`) is local-only.

All of these operations are required by vici2 agent workflow. They are incompatible with cross-FS conference membership without significant additional middleware.

---

## 2. Vicidial's `server_id` Model and Why X03 is Post-Vicidial

### 2.1 Vicidial's Architecture

Vicidial uses a `servers` table where each Asterisk server has a unique `server_ip`. All Vicidial daemons (`AST_VDauto_dial.pl`, `AST_VDhopper.pl`, `AST_update.pl`) are per-server: there is a separate daemon process on each Asterisk box, each operating against its own AMI socket.

The `vicidial_live_agents` table has a `server_ip` column. The dialer daemon queries:
```sql
SELECT * FROM vicidial_live_agents WHERE server_ip = '$my_ip' AND status = 'READY';
```

So each dialer daemon only originates calls for agents on its own Asterisk server. Campaigns are implicitly pinned to the server where their agents happen to be logged in. There is no concept of multi-server campaign affinity — it emerges naturally because the dialer is co-located with Asterisk.

The `campaigns` table has no `server_id` foreign key. Campaign-to-server mapping is implicit through `vicidial_campaign_servers` (a mapping table added in later Vicidial versions) which controls which servers serve which campaigns.

### 2.2 Why Vicidial's Model Doesn't Scale

Vicidial's per-server daemon model means:
- No centralized dial-level control across servers.
- A campaign split across servers requires each server's daemon to independently calculate dial level, which creates thundering-herd origination.
- Redis-based coordination (which vici2 uses) is entirely absent.
- The MEMORY-engine tables (`vicidial_live_agents`, `vicidial_auto_calls`) are per-server and not replicated.

For Vicidial, the "solution" to multi-server was to keep campaigns entirely on one server and only use the second server for overflow or separate campaigns. This is the behavioral pattern X03 is formalizing.

### 2.3 X03: Explicit Affinity as a First-Class Primitive

X03 makes server affinity a first-class database constraint: `campaigns.fs_node_id FK → fs_nodes.id`. The dialer engine is centralized (not co-located with FS) and explicitly routes ESL connections by looking up `campaigns.fs_node_id`. This is a significant architectural advancement over Vicidial:

- Campaigns can be rebalanced across FS nodes without restarting daemons.
- Affinity is inspectable via the admin UI.
- Failover is policy-driven and audited.
- The dialer pool can scale independently of FS instances.

---

## 3. Affinity Policy

### 3.1 Hash-Based Auto-Assignment

When a campaign has `fs_node_id IS NULL` (newly created or intentionally floating), the assignment worker performs:

```
node_id = consistent_hash(campaign_id) mod |healthy_nodes|
```

Consistent hashing (rendezvous/highest-random-weight hash) is preferred over modular hash because it minimizes reshuffling when the FS pool grows. With modular hash, adding one FS causes ~50% of campaigns to move. With rendezvous hash, only `1/N` campaigns move.

**Rendezvous hash algorithm (per campaign):**
```
For each healthy FS node n:
    score(n) = hash(campaign_id || node_id)   # e.g. FNV-1a or xxHash
Pick node with highest score.
```

This is deterministic and stateless — any dialer replica can compute the same assignment without coordination.

### 3.2 Admin Manual Pin

An admin can explicitly set `campaigns.fs_node_id = X` via the admin UI (`(admin)/infrastructure/fs-nodes`). This overrides auto-assignment. The assigned node is stored in the database and cached in Redis with a 5-second TTL.

Manual pins are appropriate when:
- A campaign requires specific hardware (GPU for AMD, local file system for recording storage).
- An operator is debugging and wants deterministic placement.
- A campaign has compliance requirements that restrict it to a specific data-center node.

### 3.3 Weight-Based Assignment

`fs_nodes.weight` (integer, default 100) allows the auto-assignment to bias toward higher-capacity nodes. The weighted rendezvous hash:

```
score(n) = hash(campaign_id || node_id) * weight(n)
```

A node with `weight=200` is approximately twice as likely to receive a campaign as a node with `weight=100`. Setting `weight=0` effectively removes the node from auto-assignment while keeping it in the pool for manually-pinned campaigns.

### 3.4 Sticky Assignment Once Pinned

Once a campaign is assigned (auto or manual), the assignment is written to `campaigns.fs_node_id` and is not changed unless:

1. The admin explicitly changes it via the UI (with a confirmation warning about live calls).
2. The pinned FS node fails and the failover policy triggers (§4 below).
3. A rebalance is explicitly triggered by the admin.

Live campaigns (at least one active call or one logged-in agent) are never rebalanced automatically. Only campaigns with zero active calls and zero logged-in agents are eligible for auto-rebalance.

---

## 4. Failover Policy

### 4.1 Failure Detection

The `fs_nodes` table has a `last_heartbeat` column updated by the health-check worker every 10 seconds. The health-check worker probes each FS via ESL:

```
api connect -> send "api status\n\n" -> check response
```

An FS node is marked `status='UNHEALTHY'` if:
- ESL connection is refused (TCP connect timeout ≤5s).
- Or the heartbeat timestamp is >30 seconds old.

Additionally, Kamailio's OPTIONS probes (X02, 15s interval, 3 misses = INACTIVE) provide a secondary health signal. X03 can read Kamailio's dispatcher table to cross-validate FS health.

### 4.2 What Happens When Pinned FS Dies

When `fs_node_id=3` goes UNHEALTHY:

**Immediate impact:**
- All agent conferences on FS-3 are lost (the TCP connections from agents' WebRTC to FS-3 drop).
- Active calls on FS-3 drop — the customer calls get a dead air / disconnect.
- The dialer engine loses its ESL connection to FS-3; the router marks FS-3 as unavailable.

**Response:**
1. Health-check worker detects FS-3 UNHEALTHY; sets `fs_nodes.status='UNHEALTHY'`.
2. Dialer engine's ESL router receives a pool-update event from Redis pub/sub.
3. Campaigns pinned to FS-3 are eligible for emergency re-pin (only if `active_calls = 0` — since FS-3 is dead, active_calls is already 0 from the database perspective).
4. The re-pinner selects the next healthy FS by the same rendezvous hash, excluding the failed node.
5. Agents on FS-3 must re-register their SIP clients. The agent UI WebSocket push notifies agents: "Your server has changed; please wait for reconnection." The frontend SIP.js client receives a new SIP server URI and re-REGISTERs automatically.
6. Audit log entry written: `[FAILOVER] campaign {id} re-pinned from fs_node {3} to fs_node {5}; reason=node_unhealthy`.

### 4.3 Conference Recovery After Failover

Agent conferences on the failed FS are irrecoverable — FreeSWITCH conference state is not replicated. Active calls that were bridged are also lost. Recovery options:

- **Automatic callback**: the system can schedule an automatic callback for leads whose calls were dropped mid-conversation (status set to `FAILOVER_DROP`; a new hopper entry is created with high priority).
- **Agent re-login**: agents that were on FS-3 must log back into the agent UI, which triggers a new SIP REGISTER to FS-5 (the new pinned node) and a new conference room is created.

### 4.4 Re-Pin Policy Detail

Re-pin is triggered only when:
- `fs_nodes.status` changes to `UNHEALTHY` OR `OFFLINE`.
- The campaign has no active calls (`active_calls = 0` in Redis set).

Campaigns with active calls on a dead FS are marked `FAILOVER_PENDING`. The re-pin is deferred until `active_calls` drains to zero (which happens immediately on FS death since all channels drop). Practically, re-pin is near-instant on FS failure.

**Re-pin target selection:**
1. Exclude the failed node.
2. Use rendezvous hash of remaining healthy nodes.
3. Do not move campaigns that are manually pinned unless the admin explicitly clicks "emergency re-pin" in the UI.
4. Write audit log.
5. Publish `vici2.infra.campaign_repinned` event to Redis pub/sub.

### 4.5 FS Node Recovery

When a failed FS node recovers:
- It is NOT automatically re-added to the pool as a target for auto-assignment.
- An admin must explicitly mark it `ACTIVE` in the UI.
- Campaigns that were re-pinned away from it during failure are NOT automatically moved back (to avoid thrash).
- The recovered node gets new campaigns via auto-assignment as new campaigns are created.

This is the same "manual re-enable" pattern used by Kamailio dispatcher for probe-recovered nodes (X02, `ds_restore_threshold=2`).

---

## 5. Agent Webphone Registration and FS Routing

### 5.1 Registration Flow

Agent browsers run SIP.js over WSS. On login, the frontend receives the agent's `sip_username` and a `sip_server_uri` from the API. Today (without X03) this is a static Kamailio VIP. With X03, the `sip_server_uri` encodes the campaign's pinned FS or routes via Kamailio set 20.

The registration flow:
```
1. Agent logs in → API returns { sip_username, sip_password, sip_server: "sips:10.0.0.100:7443" }
2. SIP.js sends REGISTER to Kamailio VIP (WSS)
3. Kamailio receives REGISTER; reads X-Affinity-Campaign header (injected by API/SIP.js UA params)
4. Kamailio routes REGISTER to fs_nodes[campaign.fs_node_id].host via dispatcher set 20
5. FS accepts REGISTER; agent is now registered on the pinned FS
```

### 5.2 X-Affinity-Campaign Header

The API injects an extra SIP header `X-Affinity-Campaign: <campaign_id>` in the REGISTER's extra headers. This is done via the SIP.js `UserAgent` options:

```javascript
extraHeaders: [`X-Affinity-Campaign: ${campaignId}`]
```

Kamailio reads this header in `ksr_request_route()`:

```lua
local campaign_id = KSR.hdr.get("X-Affinity-Campaign")
if campaign_id ~= nil then
    local fs_uri = lookup_campaign_fs(campaign_id)  -- queries Redis or DB
    KSR.pv.sets("$avp(fs_affinity_uri)", fs_uri)
    KSR.dispatcher.ds_select_dst(20, 8)  -- set 20, algorithm 8 = hash by PV
end
```

Algorithm 8 in Kamailio dispatcher is "hash by PV" (process variable) — when `$avp(fs_affinity_uri)` is set to a specific URI, algorithm 8 routes to that exact URI within set 20.

### 5.3 Campaign-to-Agent Multi-Campaign Agents

An agent can be a member of multiple campaigns (vici2 DESIGN §2). The affinity header must encode the *primary active campaign* — the one the agent is currently working. Campaign switching triggers a SIP re-REGISTER with an updated `X-Affinity-Campaign` header, which Kamailio uses to route the agent's subsequent REGISTER to the new campaign's pinned FS.

If the new campaign is pinned to a different FS, the agent's SIP registration moves. Active calls on the old FS are completed normally (the agent stays bridged on the old FS until disposition). This is the "live call stays on old FS" invariant from the failover policy.

### 5.4 Dispatcher Set 20 Membership

Set 20 is pre-populated with all `fs_nodes` rows where `status='ACTIVE'`. The `dispatcher-list-renderer.py` script (X02) populates set 20 with the same FS pool as sets 1 and 2. When `$avp(fs_affinity_uri)` is set, Kamailio uses algorithm 8 to match exactly the URI in the AVP — effectively a direct route, not a hash. The "set 20" membership provides the health-probe infrastructure (OPTIONS 15s) even for affinity routes; if the target FS fails the probe, `ds_select_dst` returns failure and the failure route handles it.

---

## 6. Conference Invariant Enforcement

### 6.1 The Invariant

For campaign C pinned to FS node N:
- Agent A working campaign C MUST have their SIP registration pointing to N.
- All `bgapi originate` commands for campaign C MUST target N's ESL socket.
- All `conference <agent_conf_uuid> member add` commands MUST execute on N.
- All recording sessions for calls in campaign C MUST write to N's local storage (before archival to S3).

### 6.2 Enforcement in the Dialer Engine

The ESL router in `dialer/internal/esl/router.go` exposes a `ConnFor(campaignID string) (*esl.Conn, error)` function. The pacing loop (E02) calls this function before every originate. The router:

1. Reads `campaign.fs_node_id` from its cache (updated via Redis pub/sub on every pin change).
2. Returns the pre-established ESL connection to that FS node.
3. If the connection is unavailable (node UNHEALTHY), returns `ErrNodeUnavailable` — the pacing loop skips origination for that campaign until the node recovers or a re-pin occurs.

This ensures no originate command is ever sent to the wrong FS.

### 6.3 Enforcement in Agent SIP Registration

The API's agent-login endpoint checks `campaign.fs_node_id` before returning `sip_server_uri`. If `fs_node_id` is set, the returned `sip_server_uri` encodes the correct FS. If `fs_node_id` is NULL (campaign not yet assigned), the login endpoint triggers synchronous auto-assignment before returning.

### 6.4 What If Invariant Is Violated?

If an agent's conference ends up on FS-A but their campaign is pinned to FS-B (e.g., due to a stale client or a race condition during re-pin), the conference join will fail: the originate on FS-B will try to join the agent's conference by UUID, but that UUID doesn't exist on FS-B. The originate will fail with "no such conference". This is a detectable failure mode — the dialer engine logs it as `CONFERENCE_UUID_MISMATCH` and increments the `vici2_affinity_violation_total` metric. The agent UI receives a "session error" event and prompts re-login.

---

## 7. Open Questions

### 7.1 Multi-Campaign Agents: Which FS Wins?

If agent A is eligible for campaigns C1 (pinned to FS-1) and C2 (pinned to FS-2), and the system assigns them a call from C1, they are registered on FS-1. If they then switch to C2, they must re-REGISTER to FS-2. This means agent conference migration happens at campaign-switch time, not call time. Open questions:
- Should mid-shift campaign switching be rate-limited (e.g., max 1 switch per 60s) to reduce re-REGISTER churn?
- Should the system automatically merge campaigns onto the same FS for agents who are in multiple campaigns?

### 7.2 Conference UUID Persistence Across Re-login

When an agent re-registers to a new FS (after failover), their conference UUID changes. Any in-flight supervisor eavesdrop sessions that held the old UUID become invalid. How should the supervisor UI be notified? Options:
- Redis pub/sub event `vici2.agent.fs_migrated` with new UUID.
- Supervisor UI polls agent state and sees new UUID automatically.

### 7.3 Recording Storage and Affinity

`mod_record_session` writes to the FS local filesystem. With affinity, all recordings for a campaign are on one FS's disk. Recording archival worker (I04) must know which FS has which recordings. Options:
- Archival worker SSH-pulls from each FS independently.
- FS nodes NFS-mount a shared recording directory (eliminates the per-FS storage problem but introduces NFS dependency).
- FS nodes push completed recordings to S3 directly via `mod_aws_s3` (cleanest; X03 should recommend this path).

### 7.4 Determinism During Simultaneous FS Deaths

If two FS nodes die simultaneously, campaigns on both need re-pinning. The re-pinner should use a distributed lock (Redis) to prevent two dialer replicas from both re-pinning the same campaign. The rendezvous hash is deterministic (same result without coordination), so the lock is only needed for the database write — not the target selection.

### 7.5 Kamailio Set 20 and Direct ESL vs. SIP Path

X02 PLAN §5.3 notes: "For T03 (campaign-to-FS affinity per X03), dialer picks a specific FS ESL target. Kamailio's role is carrier-facing SIP routing, not dialer-to-FS." This implies the dialer's `bgapi originate` goes directly to the FS ESL socket (TCP 8021), bypassing Kamailio entirely. But the outbound SIP leg from FS to carrier still exits via Kamailio (FS external profile has `outbound-proxy = sip:kamailio-vip`). Set 20 is therefore only relevant for agent SIP REGISTER routing, not for dialer-to-FS ESL. This distinction should be clearly documented in HANDOFF.md.

### 7.6 Re-pin During Active Campaign

If an admin manually re-pins a campaign from FS-A to FS-B while the campaign is running:
- The API should refuse unless active_calls == 0 AND no agents are logged in.
- If the admin overrides (force re-pin), the system should: stop the campaign, wait for active calls to finish (or force-drop them), re-pin, restart.
- The UI should display a warning modal with the current active_calls count before allowing a forced re-pin.

---

## 8. Summary of Key Findings

| Finding | Impact |
|---------|--------|
| Cross-FS bridging requires SIP hairpin or `mod_loopback` — both add ≥10ms latency and significant complexity | High — justifies affinity as mandatory, not optional |
| ESL `uuid_bridge` and `conference member` are strictly local to the FS process | High — any cross-FS operation requires at minimum an extra SIP hop |
| Vicidial's server affinity is implicit (per-server daemon); vici2 makes it explicit | Medium — explicit is more operationally flexible |
| Rendezvous hash is the right auto-assignment algorithm (minimizes redistribution on pool change) | Medium — important for smooth scale-out |
| Failed FS: conferences and active calls are irrecoverable; only re-pin is possible | High — ops must understand this; automatic callback for dropped leads is advisable |
| Kamailio set 20 provides health-probe infrastructure for affinity routes | Medium — X02 and X03 must coordinate set 20 population |
| Agent re-REGISTER on campaign switch is the right SIP model (not mid-call re-INVITE) | Low — but important for implementation clarity |
