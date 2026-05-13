# X03 — Multi-FS Campaign Affinity: Plan

_Last updated: 2026-05-13 | Phase 3.5 | Status: NOT_STARTED_

---

## 1. Executive Summary

X03 introduces explicit FreeSWITCH node affinity for campaigns. Each campaign is pinned to exactly one FS instance. The dialer engine maintains a per-node ESL connection pool and routes all originate commands through the correct ESL socket. Agent SIP registrations are routed to the pinned FS via Kamailio dispatcher set 20 and an `X-Affinity-Campaign` SIP header. Failover is automatic on node death, with re-pin written to the database and broadcast via Redis pub/sub.

Estimated scope: ~1,500 LOC (Go dialer + TS API service + migration).

---

## 2. Schema

### 2.1 New Table: `fs_nodes`

**Migration filename:** `api/prisma/migrations/20260513330000_x03_multi_fs/`

```sql
CREATE TABLE fs_nodes (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id      INT UNSIGNED NOT NULL,                -- NULL = shared/system node
  name           VARCHAR(64)  NOT NULL,                -- human label, e.g. "FS-East-1"
  host           VARCHAR(128) NOT NULL,                -- SIP/RTP host: IP or FQDN
  esl_host       VARCHAR(128) NOT NULL,                -- ESL TCP host (may differ from SIP host)
  esl_port       SMALLINT UNSIGNED NOT NULL DEFAULT 8021,
  esl_password   VARCHAR(255) NOT NULL,                -- encrypted at rest via app-layer envelope
  weight         SMALLINT UNSIGNED NOT NULL DEFAULT 100, -- higher = preferred for auto-assign
  status         ENUM('ACTIVE','DRAINING','UNHEALTHY','OFFLINE') NOT NULL DEFAULT 'ACTIVE',
  last_heartbeat DATETIME(3) NULL,                     -- updated by health-check worker
  metadata       JSON NOT NULL DEFAULT (JSON_OBJECT()), -- ops notes, labels
  created_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  INDEX idx_tenant_status (tenant_id, status),
  INDEX idx_status_heartbeat (status, last_heartbeat)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

**Status enum semantics:**
- `ACTIVE` — healthy, accepts new campaigns and originates.
- `DRAINING` — admin-initiated; no new campaigns assigned; existing campaigns finish.
- `UNHEALTHY` — health-check worker detected ESL failure; new originates blocked.
- `OFFLINE` — manually taken out of service; ignored by all auto-assignment.

### 2.2 Amendment to `campaigns`

```sql
ALTER TABLE campaigns
  ADD COLUMN fs_node_id INT UNSIGNED NULL AFTER tenant_id,
  ADD CONSTRAINT fk_campaigns_fs_node
    FOREIGN KEY (fs_node_id) REFERENCES fs_nodes(id)
    ON DELETE RESTRICT;

-- NULL means: auto-assign pending or campaign not yet started.
```

### 2.3 Prisma Schema Additions

```prisma
model FsNode {
  id            Int       @id @default(autoincrement()) @db.UnsignedInt
  tenantId      Int       @db.UnsignedInt
  name          String    @db.VarChar(64)
  host          String    @db.VarChar(128)
  eslHost       String    @db.VarChar(128) @map("esl_host")
  eslPort       Int       @default(8021) @db.SmallInt @map("esl_port")
  eslPassword   String    @db.VarChar(255) @map("esl_password")
  weight        Int       @default(100) @db.SmallInt
  status        FsNodeStatus @default(ACTIVE)
  lastHeartbeat DateTime? @db.DateTime(3) @map("last_heartbeat")
  metadata      Json      @default("{}")
  createdAt     DateTime  @default(now()) @db.DateTime(3) @map("created_at")
  updatedAt     DateTime  @updatedAt @db.DateTime(3) @map("updated_at")

  campaigns Campaign[]

  @@index([tenantId, status])
  @@index([status, lastHeartbeat])
  @@map("fs_nodes")
}

enum FsNodeStatus {
  ACTIVE
  DRAINING
  UNHEALTHY
  OFFLINE
}
```

Amendment to `Campaign` model:
```prisma
model Campaign {
  // ... existing fields ...
  fsNodeId  Int?     @db.UnsignedInt @map("fs_node_id")
  fsNode    FsNode?  @relation(fields: [fsNodeId], references: [id])
}
```

### 2.4 Kamailio Dispatcher Table (set 20)

`fs_nodes` rows with `status='ACTIVE'` are synced to Kamailio's `dispatcher` table (set 20) by the `dispatcher-list-renderer.py` script (X02). Set 20 uses algorithm 8 (hash by PV). The sync is triggered whenever `fs_nodes.status` changes:

```sql
-- Kamailio dispatcher entries for set 20 (managed by sync script, not app migrations)
INSERT INTO dispatcher (setid, destination, flags, priority, attrs, description)
SELECT 20, CONCAT('sip:', host, ':5060'), 0, 0, CONCAT('weight=', weight), name
FROM fs_nodes WHERE status = 'ACTIVE';
```

---

## 3. Dialer Engine Changes

### 3.1 Architecture Overview

Current state (pre-X03): dialer has a single ESL connection configured via environment variable `ESL_HOST`.

Post-X03: dialer maintains a `map[int]*esl.Conn` keyed by `fs_node_id`. The ESL router is responsible for lifecycle management of all connections.

```
dialer/
└── internal/
    └── esl/
        ├── client.go         (existing — single-connection ESL client)
        ├── router.go         (NEW — multi-FS ESL routing layer)
        └── router_test.go    (NEW)
```

### 3.2 New File: `dialer/internal/esl/router.go`

**Package:** `esl`

**Structs:**

```go
// NodeConfig holds the configuration for a single FS ESL connection.
type NodeConfig struct {
    NodeID   int
    Host     string
    Port     int
    Password string
    Weight   int
}

// Router manages a pool of ESL connections, one per active FS node.
// It reacts to node pool changes published on Redis pub/sub channel
// "vici2.infra.fs_pool_changed".
type Router struct {
    mu      sync.RWMutex
    conns   map[int]*managedConn  // keyed by fs_node_id
    redis   *redis.Client
    db      *sql.DB
    logger  *slog.Logger
    metrics *routerMetrics
}

type managedConn struct {
    nodeID    int
    conn      *Client           // existing ESL client
    healthy   bool
    lastError error
    mu        sync.Mutex
}
```

**Key functions:**

```go
// NewRouter creates a Router and starts the health-check loop.
// It loads initial node pool from the database and dials all active nodes.
func NewRouter(ctx context.Context, db *sql.DB, redis *redis.Client, logger *slog.Logger) (*Router, error)

// ConnFor returns the ESL connection for the FS node pinned to campaignID.
// It resolves fs_node_id via Redis cache (key: "affinity:campaign:{id}",
// 5s TTL, populated from DB on miss) then returns the corresponding conn.
// Returns ErrNodeUnavailable if the node is UNHEALTHY or not connected.
func (r *Router) ConnFor(ctx context.Context, campaignID int) (*Client, error)

// Reload re-reads the fs_nodes table and reconciles connections:
// - New nodes: dial and add to pool.
// - Removed or OFFLINE nodes: close connection and remove.
// - Changed nodes (host/port/password): close old, dial new.
// Called on Redis pub/sub "vici2.infra.fs_pool_changed" events.
func (r *Router) Reload(ctx context.Context) error

// healthLoop runs every 10s and calls heartbeat() on each managed connection.
// If heartbeat fails 3 consecutive times, marks node UNHEALTHY in DB and
// broadcasts "vici2.infra.fs_pool_changed" to trigger re-pin.
func (r *Router) healthLoop(ctx context.Context)

// heartbeat sends "api status\n\n" via ESL and checks for a valid response.
func (r *Router) heartbeat(ctx context.Context, mc *managedConn) error

// reconnectLoop attempts ESL reconnect for an UNHEALTHY node with exponential
// backoff (1s, 2s, 4s, 8s, max 30s). On reconnect success, sets conn healthy.
// Does NOT auto-re-pin campaigns — that is the re-pinner's responsibility.
func (r *Router) reconnectLoop(ctx context.Context, mc *managedConn)
```

**Error types:**

```go
var (
    ErrNodeUnavailable  = errors.New("esl: FS node unavailable")
    ErrNodeNotFound     = errors.New("esl: no FS node for campaign")
    ErrNoHealthyNode    = errors.New("esl: no healthy FS node available")
)
```

### 3.3 Affinity Cache

Redis key: `affinity:campaign:{campaign_id}` → value: `{fs_node_id}` (integer string)

- TTL: 5 seconds.
- Written by: API affinity service on any pin change; re-pinner on failover.
- Read by: `Router.ConnFor` before DB lookup.
- On cache miss: DB lookup `SELECT fs_node_id FROM campaigns WHERE id=?`; result is cached.

This cache exists to avoid a DB query on every originate tick (which runs every `1000ms / calls_per_second` for each campaign). With 50 campaigns at 10 CPS each, that's 500 potential DB queries/sec — the Redis cache eliminates this.

### 3.4 Replacing Single-FS ESL in E02 Pacing Loop

Current E02 pacing loop pseudocode calls `p.originateOne(c, leadID)` which internally uses a single `eslConn`. Post-X03:

```go
func (p *Pacer) originateOne(ctx context.Context, c *Campaign, leadID int) error {
    conn, err := p.eslRouter.ConnFor(ctx, c.ID)
    if err != nil {
        // node unavailable — skip this originate, increment metric
        p.metrics.originateSkipped.WithLabelValues("node_unavailable").Inc()
        return nil
    }
    // ... existing originate logic using conn ...
}
```

The `Pacer` receives `*Router` via constructor injection. The single-FS `eslConn` field is removed from `Pacer`.

### 3.5 Re-pinner

**New file:** `dialer/internal/affinity/rebalancer.go`

The re-pinner listens on Redis pub/sub `vici2.infra.fs_node_status_changed` and runs the re-pin logic:

```go
// Rebalancer watches for FS node health events and re-pins campaigns.
type Rebalancer struct {
    db      *sql.DB
    redis   *redis.Client
    logger  *slog.Logger
    metrics *rebalancerMetrics
}

// Run subscribes to Redis and processes node-status events.
func (rb *Rebalancer) Run(ctx context.Context) error

// repinCampaigns finds all campaigns pinned to nodeID and re-pins them
// to the next healthy node by rendezvous hash. Only campaigns with
// active_calls == 0 (Redis SCard) are re-pinned immediately.
// Campaigns with active_calls > 0 are queued as FAILOVER_PENDING and
// re-pinned when active_calls drains to zero.
func (rb *Rebalancer) repinCampaigns(ctx context.Context, nodeID int) error

// nextHealthyNode computes the rendezvous hash for campaignID across
// all healthy nodes (excluding excludeNodeID) and returns the winner.
func (rb *Rebalancer) nextHealthyNode(campaignID int, excludeNodeID int, nodes []NodeConfig) (NodeConfig, error)

// rendezVousHash implements the highest-random-weight algorithm.
// score(node) = FNV1a(campaignID || nodeID); pick max.
func rendezVousHash(campaignID, nodeID int) uint64
```

### 3.6 Health-Check Worker

The health-check runs in the dialer process (or can be a separate goroutine in the worker service). It:
1. Every 10s: ESL `api status` to each node.
2. On 3 consecutive failures: calls `markNodeUnhealthy(nodeID)`.
3. `markNodeUnhealthy`: `UPDATE fs_nodes SET status='UNHEALTHY' WHERE id=?`; publishes `vici2.infra.fs_node_status_changed:{nodeID}:UNHEALTHY` to Redis.
4. On reconnect success after UNHEALTHY: does NOT auto-recover — admin must mark ACTIVE.

---

## 4. API Service Changes

### 4.1 New Service: `api/src/services/affinity/affinity-service.ts`

```typescript
export class AffinityService {
  constructor(
    private db: PrismaClient,
    private redis: RedisClient,
    private logger: Logger,
  ) {}

  /**
   * Returns the fs_node_id for a campaign, auto-assigning if NULL.
   * Result is written to DB and Redis cache.
   */
  async getOrAssignNode(campaignId: number): Promise<number>

  /**
   * Manually pins a campaign to a specific FS node.
   * Rejects if campaign has active_calls > 0 unless force=true.
   * Writes audit log entry.
   */
  async pinCampaign(campaignId: number, nodeId: number, force?: boolean): Promise<void>

  /**
   * Rendezvous hash: pick the FS node with the highest hash score
   * among all healthy nodes (status='ACTIVE').
   */
  async computeAutoAssignment(campaignId: number): Promise<number>

  /**
   * Returns the SIP registration URI for an agent's active campaign.
   * Used by agent-login endpoint to populate sip_server_uri.
   */
  async getSipServerUri(campaignId: number): Promise<string>

  /**
   * Lists all FS nodes with their current status, campaign counts, and
   * last heartbeat. Used by the admin UI.
   */
  async listNodes(): Promise<FsNodeWithStats[]>

  /**
   * Creates a new FS node. ESL password is envelope-encrypted before storage.
   */
  async createNode(input: CreateFsNodeInput): Promise<FsNode>

  /**
   * Updates node status (ACTIVE/DRAINING/OFFLINE). UNHEALTHY is set only
   * by the health-check worker, not by API callers.
   * Triggers dispatcher-list-renderer.py sync on status change.
   */
  async setNodeStatus(nodeId: number, status: FsNodeStatus): Promise<void>
}
```

### 4.2 REST Endpoints

Base path: `/api/admin/infrastructure/fs-nodes`

| Method | Path | RBAC | Description |
|--------|------|------|-------------|
| `GET` | `/` | `infra:fs_node:read` | List all FS nodes (with stats) |
| `POST` | `/` | `infra:fs_node:edit` | Create FS node |
| `GET` | `/:id` | `infra:fs_node:read` | Get single node |
| `PATCH` | `/:id` | `infra:fs_node:edit` | Update node (name, weight, status) |
| `DELETE` | `/:id` | `infra:fs_node:edit` | Soft-delete (set OFFLINE) |
| `POST` | `/:id/drain` | `infra:fs_node:edit` | Set status=DRAINING |
| `POST` | `/:id/activate` | `infra:fs_node:edit` | Set status=ACTIVE |
| `GET` | `/:id/campaigns` | `infra:fs_node:read` | List campaigns pinned to node |
| `POST` | `/campaigns/:campaign_id/pin` | `infra:fs_node:edit` | Pin/re-pin campaign |
| `DELETE` | `/campaigns/:campaign_id/pin` | `infra:fs_node:edit` | Clear pin (auto-assign) |

**Pin request body:**
```typescript
{
  fsNodeId: number;   // target node
  force?: boolean;    // override active-calls guard
}
```

**List response (GET /):**
```typescript
{
  nodes: Array<{
    id: number;
    name: string;
    host: string;
    eslHost: string;
    eslPort: number;
    weight: number;
    status: 'ACTIVE' | 'DRAINING' | 'UNHEALTHY' | 'OFFLINE';
    lastHeartbeat: string | null;  // ISO 8601
    campaignCount: number;         // campaigns pinned here
    activeCalls: number;           // current active calls (from Redis)
    eslConnected: boolean;         // dialer router has live conn
    metadata: Record<string, unknown>;
  }>;
}
```

### 4.3 Agent Login Endpoint Amendment

`POST /api/agent/login` response currently returns `{ sip_server: string }` as a static value. Post-X03, the endpoint:

1. Reads the agent's active campaign (from session or request body `campaignId`).
2. Calls `AffinityService.getSipServerUri(campaignId)`.
3. Returns the FS-specific WSS URI: `wss://<fs_node.host>:7443` (or Kamailio VIP if `fs_node_id` is NULL).

If `campaignId` is not provided (agent not yet assigned to a campaign), falls back to Kamailio VIP.

---

## 5. RBAC

### 5.1 New Verbs

Add to `shared/types/src/rbac.ts` VERBS array:

```typescript
// infra / fs-nodes (X03)
'infra:fs_node:read',
'infra:fs_node:edit',
```

### 5.2 Role Matrix

| Role | `infra:fs_node:read` | `infra:fs_node:edit` |
|------|---------------------|---------------------|
| `super_admin` | yes | yes |
| `admin` | yes | no |
| `supervisor` | no | no |
| `agent` | no | no |
| `viewer` | no | no |
| `integrator` | no | no |

Rationale: FS node management is infrastructure-level. `super_admin` only can change nodes (edit). `admin` can view node health to diagnose call quality issues but cannot change affinity.

---

## 6. X02 Integration (Kamailio Dispatcher Set 20)

### 6.1 Set 20 Population

The `dispatcher-list-renderer.py` script (X02) is extended to handle set 20:

```python
def sync_set_20(conn, fs_nodes):
    """Sync active FS nodes to Kamailio dispatcher set 20."""
    cur = conn.cursor()
    cur.execute("DELETE FROM dispatcher WHERE setid = 20")
    for node in fs_nodes:
        if node['status'] == 'ACTIVE':
            cur.execute(
                "INSERT INTO dispatcher (setid, destination, flags, priority, attrs, description)"
                " VALUES (20, %s, 0, %s, %s, %s)",
                (
                    f"sip:{node['host']}:5060",
                    node['weight'],
                    f"weight={node['weight']}",
                    node['name'],
                )
            )
    conn.commit()
    trigger_kamailio_reload()
```

This runs whenever `fs_nodes.status` changes (triggered by the API via a Redis event).

### 6.2 Kamailio Routing for X-Affinity-Campaign

Add to `kamailio/kamailio.cfg.tmpl` in `ksr_request_route()`:

```lua
-- X03: Campaign affinity routing for agent REGISTER and INVITE
local campaign_id = KSR.hdr.get("X-Affinity-Campaign")
if campaign_id ~= nil then
    -- Lookup pinned FS URI from Redis (set by vici2 API)
    -- Key: "affinity:campaign:{id}" → "sip:{fs_host}:5060"
    local fs_uri = redis_get("affinity:campaign:" .. campaign_id)
    if fs_uri ~= nil and fs_uri ~= "" then
        KSR.pv.sets("$avp(fs_affinity_uri)", fs_uri)
        if KSR.dispatcher.ds_select_dst(20, 8) < 0 then
            KSR.sl.sl_send_reply(503, "No affinity FS available")
            return
        end
        KSR.tm.t_relay()
        return
    end
end
-- Fallthrough to normal dispatch (set 1 or 2)
```

The Redis lookup in Kamailio's Lua uses `ndb_redis` module (already loaded by X02 for other purposes).

### 6.3 X-Affinity-Campaign Header Injection

SIP.js UserAgent configuration (agent frontend):

```typescript
const userAgent = new UserAgent({
  uri: UserAgent.makeURI(`sip:${sipUsername}@${sipDomain}`),
  transportOptions: {
    server: `wss://${sipServer}:7443`,
  },
  extraHeaders: campaignId
    ? [`X-Affinity-Campaign: ${campaignId}`]
    : [],
});
```

For `bgapi originate` commands from the dialer, the `X-Affinity-Campaign` header is injected in the SIP INVITE by the FS dialplan (if needed for Kamailio routing). However, since the dialer already routes to the correct FS ESL directly, the outbound SIP leg's `X-Affinity-Campaign` header is only needed for the carrier-to-Kamailio path (inbound calls), which are handled by set 1 (Call-ID hash), not set 20.

---

## 7. Admin UI: `(admin)/infrastructure/fs-nodes`

### 7.1 Page Structure

Route: `web/app/(admin)/infrastructure/fs-nodes/page.tsx`

**Components:**

```
FsNodesPage
├── FsNodesHeader (title, "Add Node" button)
├── FsNodesTable
│   ├── columns: Name, Host, ESL Host:Port, Weight, Status, Campaigns, Active Calls, Last Heartbeat, Actions
│   ├── Status badge: green (ACTIVE), yellow (DRAINING), red (UNHEALTHY), gray (OFFLINE)
│   └── Actions: Drain, Activate, View Campaigns, Delete (soft)
└── FsNodeDrawer (create/edit form, slides in from right)
    ├── Fields: Name, Host, ESL Host, ESL Port, ESL Password (masked), Weight, Metadata
    └── Save / Cancel buttons

FsNodeDetailPage  (route: /infrastructure/fs-nodes/[id])
├── NodeHealthCard (status, last heartbeat, ESL connected indicator)
├── CampaignAffinityTable
│   ├── columns: Campaign Name, Status, Active Calls, Pin Type (auto/manual)
│   └── Actions: Re-pin (select target node), Clear Pin (auto-assign)
└── RecentEventsLog (audit log filtered to this node)
```

### 7.2 Data Flow

- `GET /api/admin/infrastructure/fs-nodes` → polling every 15s (or WebSocket push when `vici2.infra.fs_node_status_changed` fires).
- Node status badges update in real time via WebSocket event: `{ type: 'fs_node_status', nodeId, status, lastHeartbeat }`.
- "Drain" action: `POST /api/admin/infrastructure/fs-nodes/:id/drain` → shows confirmation modal with campaign count.
- "Re-pin campaign" action: form to select target node → `POST /api/admin/infrastructure/fs-nodes/campaigns/:campaign_id/pin`.

### 7.3 Read-Only Health View vs. Management

The page is read-only for `admin` role (RBAC `infra:fs_node:read`): they can see all node status, heartbeat, campaign counts, and active calls, but "Add Node", "Drain", "Activate", "Delete" and re-pin buttons are hidden. Only `super_admin` (`infra:fs_node:edit`) sees the management actions.

---

## 8. Reconnect and Health-Check Protocol

### 8.1 Per-Node Reconnect State Machine

```
         dial()
  NEW ──────────────────────► CONNECTED
                                  │
                          heartbeat fail (1st)
                                  │
                                  ▼
                             DEGRADED
                                  │
                      heartbeat fail (2nd & 3rd)
                                  │
                                  ▼
                             UNHEALTHY ◄──── DB written, Redis published
                                  │
                          reconnectLoop starts
                                  │
                     exponential backoff (1s, 2s, 4s ... 30s)
                                  │
                         dial() succeeds
                                  │
                                  ▼
                            RECONNECTED ──► (node still UNHEALTHY in DB
                                             until admin marks ACTIVE)
```

State transitions are local to the dialer router's `managedConn`. DB state (`fs_nodes.status`) is authoritative; the router reads DB status on startup and on `vici2.infra.fs_pool_changed` events.

### 8.2 ESL Heartbeat Command

```
api status\n\n
```

Expected response contains `UP x years, x days, x hours, x minutes, x seconds`. Timeout: 5s. If response does not contain "UP" or times out, heartbeat fails.

### 8.3 Reconnect Backoff Schedule

| Attempt | Delay |
|---------|-------|
| 1 | 1s |
| 2 | 2s |
| 3 | 4s |
| 4 | 8s |
| 5+ | 30s (cap) |

Jitter: ±20% to prevent thundering herd when multiple FS nodes recover simultaneously.

### 8.4 Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `vici2_esl_router_connections_total` | Gauge | `node_id`, `status` | Current conn count per node |
| `vici2_esl_router_heartbeat_failures_total` | Counter | `node_id` | Cumulative heartbeat failures |
| `vici2_esl_router_reconnects_total` | Counter | `node_id` | Successful reconnects |
| `vici2_affinity_originates_total` | Counter | `node_id`, `campaign_id` | Originates routed per node |
| `vici2_affinity_violation_total` | Counter | — | Conference-UUID-mismatch events |
| `vici2_affinity_repin_total` | Counter | `reason` | Re-pins (failover / manual / rebalance) |
| `vici2_affinity_repin_duration_seconds` | Histogram | `reason` | Time from failure detection to re-pin complete |

---

## 9. Failover Sequence (Detailed)

```
T+0s    FS-3 crashes (kernel panic / network partition)
T+0s    ESL TCP connections to FS-3 drop; all agents on FS-3 lose SIP
T+0s    Dialer router: heartbeat goroutine for FS-3 gets TCP error (immediate)
T+5s    Heartbeat failure count hits 3 (next 2 checks also fail, ~10s total)
          [Note: first failure is immediate on TCP drop, not after 10s interval]
T+5s    Router calls markNodeUnhealthy(3):
          UPDATE fs_nodes SET status='UNHEALTHY' WHERE id=3
          PUBLISH Redis "vici2.infra.fs_node_status_changed" → "3:UNHEALTHY"
T+5s    Rebalancer receives Redis event
T+5s    Rebalancer queries: SELECT id FROM campaigns WHERE fs_node_id=3
T+5s    For each campaign:
          activeCalls = SCARD "vici2:{tid}:campaign:{cid}:active_calls"
          if activeCalls == 0:
            nextNode = nextHealthyNode(campaignID, excludeNode=3, healthyNodes)
            UPDATE campaigns SET fs_node_id=nextNode WHERE id=campaignID
            SET Redis "affinity:campaign:{cid}" = "sip:{nextNode.host}:5060" EX 5
            INSERT audit_log ...
            PUBLISH "vici2.infra.campaign_repinned" → {campaignId, fromNode:3, toNode:nextNode}
T+5s    Dialer router receives "vici2.infra.fs_pool_changed" (or campaign_repinned)
T+5s    Dialer router's affinity cache is invalidated for affected campaigns
T+6s    Next dialer tick: ConnFor(campaignID) → returns conn to new node → originates resume
T+30s   Kamailio's OPTIONS probe for FS-3 fails 3 times → marks set 20 entry for FS-3 INACTIVE
T+30s   Agent re-REGISTER attempts via Kamailio → set 20 skips FS-3 → routes to available node
```

Total origination downtime for affected campaigns: ~5–6 seconds (ESL-drop to dialer re-routing).
Agent conference recovery: requires agent manual re-login (SIP stack reconnects automatically in frontend).

---

## 10. Rebalancer: Rendezvous Hash Implementation

```go
// rendezVousScore computes FNV-1a hash of the concatenation of two integers.
func rendezVousScore(campaignID, nodeID int) uint64 {
    h := fnv.New64a()
    b := make([]byte, 16)
    binary.LittleEndian.PutUint64(b[:8], uint64(campaignID))
    binary.LittleEndian.PutUint64(b[8:], uint64(nodeID))
    h.Write(b)
    return h.Sum64()
}

// nextHealthyNode selects the FS node with the highest rendezvous score
// for the given campaignID, excluding excludeNodeID.
func (rb *Rebalancer) nextHealthyNode(campaignID, excludeNodeID int, nodes []NodeConfig) (NodeConfig, error) {
    var best NodeConfig
    var bestScore uint64
    found := false
    for _, n := range nodes {
        if n.NodeID == excludeNodeID || n.Status != "ACTIVE" {
            continue
        }
        score := rendezVousScore(campaignID, n.NodeID) * uint64(n.Weight)
        if !found || score > bestScore {
            best = n
            bestScore = score
            found = true
        }
    }
    if !found {
        return NodeConfig{}, ErrNoHealthyNode
    }
    return best, nil
}
```

The weight multiplication biases the distribution: a node with `weight=200` has approximately twice the probability of winning the rendezvous hash for any given campaign, compared to a node with `weight=100`.

---

## 11. Testing Plan

### 11.1 Unit Tests

**`dialer/internal/esl/router_test.go`:**
- `TestConnFor_CacheHit`: cache returns correct node without DB hit.
- `TestConnFor_NodeUnavailable`: UNHEALTHY node returns `ErrNodeUnavailable`.
- `TestConnFor_NullAffinity`: NULL `fs_node_id` triggers auto-assign.
- `TestRouter_Reload_NewNode`: new FS node added → router dials it.
- `TestRouter_Reload_RemovedNode`: node removed → connection closed.
- `TestHeartbeat_FailThrice_MarkUnhealthy`: 3 failures → DB update + Redis publish.

**`dialer/internal/affinity/rebalancer_test.go`:**
- `TestRendezVousHash_Determinism`: same inputs → same output.
- `TestRendezVousHash_Distribution`: 1000 campaigns, 3 nodes → roughly 333 each (±5%).
- `TestRepinCampaigns_SkipsActiveCalls`: campaign with active_calls > 0 stays on failed node as FAILOVER_PENDING.
- `TestRepinCampaigns_NoHealthyNodes`: returns `ErrNoHealthyNode`, sets campaign to FAILOVER_PENDING.
- `TestRepinCampaigns_WritesAuditLog`: re-pin writes correct audit log entry.

**`api/src/services/affinity/affinity-service.test.ts`:**
- `getOrAssignNode: returns cached assignment`
- `getOrAssignNode: auto-assigns NULL campaign`
- `pinCampaign: rejects if active_calls > 0 and force=false`
- `pinCampaign: allows force re-pin`
- `computeAutoAssignment: rendezvous hash matches Go implementation` (golden test)

### 11.2 Integration Tests

**Scenario A — Affinity routing (happy path):**
1. Create 3 FS nodes in DB; start ESL router.
2. Create 6 campaigns; trigger auto-assignment.
3. Assert 2 campaigns per node (±1, depending on hash distribution).
4. Verify `ConnFor(campaignID)` returns connection to the assigned node for each campaign.

**Scenario B — Node failure and re-pin:**
1. Create 3 FS nodes + 3 campaigns (1 per node).
2. Simulate FS-2 failure (close listener port).
3. Assert router marks FS-2 UNHEALTHY within 15s (3 heartbeat failures × 5s).
4. Assert campaign on FS-2 is re-pinned to FS-1 or FS-3.
5. Assert new originates for that campaign route to the new node.

**Scenario C — Manual pin:**
1. Campaign auto-assigned to FS-1.
2. API call: `POST /infrastructure/fs-nodes/campaigns/:id/pin` with `fsNodeId=2`.
3. Assert `campaigns.fs_node_id = 2` in DB.
4. Assert `ConnFor(campaignID)` returns FS-2 connection.
5. Assert audit log entry written.

**Scenario D — Force re-pin with active calls:**
1. Campaign on FS-1 with active_calls = 5 in Redis.
2. API call: `POST /infrastructure/fs-nodes/campaigns/:id/pin` with `fsNodeId=2, force=false`.
3. Assert HTTP 409 with `{ error: { code: "CAMPAIGN_HAS_ACTIVE_CALLS", ... } }`.
4. Retry with `force=true`.
5. Assert re-pin succeeds; audit log shows `force=true`.

---

## 12. LOC Estimate

| File | LOC |
|------|-----|
| `dialer/internal/esl/router.go` | 350 |
| `dialer/internal/esl/router_test.go` | 200 |
| `dialer/internal/affinity/rebalancer.go` | 200 |
| `dialer/internal/affinity/rebalancer_test.go` | 150 |
| `api/src/services/affinity/affinity-service.ts` | 200 |
| `api/src/routes/admin/infrastructure/fs-nodes.ts` | 150 |
| `api/test/affinity/affinity-service.test.ts` | 150 |
| `api/prisma/migrations/20260513330000_x03_multi_fs/migration.sql` | 40 |
| `web/app/(admin)/infrastructure/fs-nodes/page.tsx` | 200 |
| `web/app/(admin)/infrastructure/fs-nodes/[id]/page.tsx` | 120 |
| `shared/types/src/rbac.ts` (2 verbs) | 5 |
| `kamailio/kamailio.cfg.tmpl` amendment | 30 |
| `kamailio/scripts/dispatcher-list-renderer.py` amendment | 50 |
| **Total** | **~1,845** |

Target ~1,500 LOC as stated — tests account for 500 of the 1,845. Production code alone is ~1,200.

---

## 13. Migration Script

**File:** `api/prisma/migrations/20260513330000_x03_multi_fs/migration.sql`

```sql
-- X03: Multi-FS Campaign Affinity
-- Migration: 20260513330000_x03_multi_fs
-- Direction: UP

CREATE TABLE fs_nodes (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id      INT UNSIGNED NOT NULL,
  name           VARCHAR(64)  NOT NULL,
  host           VARCHAR(128) NOT NULL,
  esl_host       VARCHAR(128) NOT NULL,
  esl_port       SMALLINT UNSIGNED NOT NULL DEFAULT 8021,
  esl_password   VARCHAR(255) NOT NULL,
  weight         SMALLINT UNSIGNED NOT NULL DEFAULT 100,
  status         ENUM('ACTIVE','DRAINING','UNHEALTHY','OFFLINE') NOT NULL DEFAULT 'ACTIVE',
  last_heartbeat DATETIME(3) NULL,
  metadata       JSON NOT NULL DEFAULT (JSON_OBJECT()),
  created_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                 ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  INDEX idx_tenant_status (tenant_id, status),
  INDEX idx_status_heartbeat (status, last_heartbeat)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE campaigns
  ADD COLUMN fs_node_id INT UNSIGNED NULL AFTER tenant_id;

ALTER TABLE campaigns
  ADD CONSTRAINT fk_campaigns_fs_node
  FOREIGN KEY (fs_node_id) REFERENCES fs_nodes(id)
  ON DELETE RESTRICT;

-- DOWN (rollback):
-- ALTER TABLE campaigns DROP FOREIGN KEY fk_campaigns_fs_node;
-- ALTER TABLE campaigns DROP COLUMN fs_node_id;
-- DROP TABLE fs_nodes;
```

---

## 14. Open Items Before Implementation

| Item | Owner | Resolution |
|------|-------|------------|
| Confirm Kamailio `ndb_redis` already loaded in X02 cfg | X02 implementer | Check `kamailio.cfg.tmpl` module load list |
| Decide whether re-REGISTER on campaign switch is agent-triggered or server-push | Agent UI team | Recommend: server push via WebSocket `{ type: 'sip_migrate', newServer }` |
| Recording storage: per-FS local vs. shared NFS vs. direct S3 push | Infra/SRE | Recommend: direct S3 push from FS (see RESEARCH §7.3) |
| Determine if `esl_password` uses same KEK as carrier creds (T02) | API team | Yes — use existing envelope encryption service |
| Tenant isolation: can `super_admin` see nodes across tenants? | Product | Yes — fs_nodes is a cluster-level resource; tenant_id is for multi-tenant pools |
