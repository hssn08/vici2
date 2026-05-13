# X03 — Multi-FS Campaign Affinity: Handoff

_Last updated: 2026-05-13 | Status: COMPLETE_

---

## Status

Implemented in commit `feat(X03): implement multi-FS campaign affinity` (ddd9a02).

---

## What was built

### Database (migration `20260513330000_x03_multi_fs`)
- New `fs_nodes` table: id, tenant_id, name, host, esl_host, esl_port, esl_password (AES-GCM-256 encrypted), weight, status enum (ACTIVE/DRAINING/UNHEALTHY/OFFLINE), last_heartbeat, metadata.
- `campaigns.fs_node_id` FK (NULL = auto-assigned on first originate).
- Prisma schema: `FsNode` model + `FsNodeStatus` enum + `Campaign.fsNode` relation.

### Go dialer: ESL Router (`dialer/internal/esl/router.go`)
- `Router` manages one `managedConn` per FS node, each wrapping a `*Client`.
- `ConnFor(ctx, campaignID)` resolves affinity from Redis cache (key `affinity:campaign:{id}`, 5s TTL), falls back to DB, then returns the matching `*Client`.
- Rendezvous (highest-random-weight) hash: FNV-1a over `[campaignID uint64 LE | nodeID uint64 LE]`, score multiplied by node weight.
- `healthLoop` every 10s: sends ESL `api status`, checks for "UP", 3 failures → marks UNHEALTHY in DB and publishes `vici2.infra.fs_node_status_changed`.
- `reconnectLoop` per unhealthy node: exponential backoff 1s → 2s → 4s → 8s → 30s (cap) with ±20% jitter.
- `subscribePubSub` listens on `vici2.infra.fs_pool_changed` → calls `Reload`.
- Error sentinels: `ErrNodeUnavailable`, `ErrNodeNotFound`, `ErrNoHealthyNode`.
- 5 Prometheus metrics: connections_total, connections_up, heartbeat_total (+ healthy/failed labels), reconnects_total, latency_histogram.

### Go dialer: Affinity Rebalancer (`dialer/internal/affinity/rebalancer.go`)
- `Rebalancer.Run(ctx)` subscribes to `vici2.infra.fs_node_status_changed`.
- On UNHEALTHY event for a node: loads all campaigns on that node, skips those with `active_calls > 0` in Redis, re-pins survivors to best ACTIVE node via rendezvous hash.
- Publishes `vici2.infra.campaign_repinned` for each moved campaign.
- 3 Prometheus metrics: rebalances_total, campaigns_repinned_total, live_skips_total.

### TypeScript API service (`api/src/services/affinity/affinity-service.ts`)
- `getOrAssignNode(campaignId)`: Redis cache → DB → auto-assign via rendezvous hash.
- `pinCampaign(campaignId, nodeId, force, actorId)`: active-call guard (throws `CAMPAIGN_HAS_ACTIVE_CALLS` if calls > 0 and force=false), updates DB + Redis, publishes event.
- `computeAutoAssignment(campaignId)`: queries ACTIVE nodes, applies same FNV-1a rendezvous hash mirrored from Go.
- `getSipServerUri(campaignId)`: resolves node host → `wss://{host}:7443`.
- `listNodes()`, `createNode()`, `updateNode()`, `setNodeStatus()`, `deleteNode()`.
- ESL password: AES-GCM-256 via `api/src/auth/encryption.ts`, stored as base64 in DB, stripped from all GET responses.

### REST endpoints (`api/src/routes/admin/infrastructure/fs-nodes.ts`)
All under `/api/admin/infrastructure/fs-nodes`. RBAC:
- `infra:fs_node:read` → admin + super_admin (GET endpoints)
- `infra:fs_node:edit` → super_admin only (POST/PATCH/DELETE)

Endpoints:
```
GET    /api/admin/infrastructure/fs-nodes
POST   /api/admin/infrastructure/fs-nodes
GET    /api/admin/infrastructure/fs-nodes/:id
PATCH  /api/admin/infrastructure/fs-nodes/:id
DELETE /api/admin/infrastructure/fs-nodes/:id
PATCH  /api/admin/infrastructure/fs-nodes/:id/status
POST   /api/admin/infrastructure/fs-nodes/:id/drain
POST   /api/admin/infrastructure/fs-nodes/:id/activate
POST   /api/admin/infrastructure/fs-nodes/:id/repin
GET    /api/admin/infrastructure/fs-nodes/:id/campaigns
POST   /api/admin/campaigns/:id/pin-node
```

### Admin UI (`web/src/app/(admin)/admin/infrastructure/fs-nodes/page.tsx`)
- "use client" Next.js page, 15s auto-polling.
- Health table: node name, host, status badge, last heartbeat, campaign count, active calls, ESL connection indicator.
- Actions: Drain, Activate, Re-pin all campaigns.

### Kamailio set 20 (`infra/kamailio/scripts/dispatcher-list-renderer.py`)
- `get_vici2_fs_nodes()`: queries `fs_nodes` table for ACTIVE/DRAINING nodes.
- `sync_set_20(kam_conn, fs_nodes)`: upserts dispatcher records with `setid=20`, `priority=weight`.
- `action_sync()` now calls both FS instance sync (sets 1+2) and set-20 sync.

---

## Affinity model summary

Each campaign has an optional `fs_node_id`. When NULL (new campaign), the first originate call triggers auto-assignment via rendezvous hash over all ACTIVE nodes weighted by their `weight` field. The assignment is written to DB and cached in Redis for 5s.

Manual pin: admin calls `POST /api/admin/infrastructure/fs-nodes/:id/repin` or `POST /api/admin/campaigns/:id/pin-node`. Active-call guard prevents accidental mid-call migration unless `force=true`.

---

## Rebalancer rules

Fires when a `fs_node_status_changed` event arrives with `status=UNHEALTHY`. For each campaign pinned to the failed node:
1. Check Redis `t:{tid}:campaign:{cid}:active_calls` — if > 0, skip (live call will finish on its FS process; calls are isolated per FS).
2. Re-pin to highest-rendezvous-score ACTIVE node (excluding the failed node).
3. Publish `vici2.infra.campaign_repinned`.

Campaigns with live calls continue on the failed node until calls end; new originates after re-pin go to the new node.

---

## Ops procedures

### Adding a new FS node
1. Deploy FreeSWITCH instance with ESL port 8021 open.
2. `POST /api/admin/infrastructure/fs-nodes` with name, host, esl_host, esl_port, esl_password, weight=100.
3. Status starts as ACTIVE; router auto-discovers on next `Reload` (pub/sub triggers immediately).
4. Run `dispatcher-list-renderer.py --action=sync` to add to Kamailio set 20.
5. New campaigns will be auto-assigned to the new node via rendezvous hash.

### Draining a node (graceful maintenance)
1. `POST /api/admin/infrastructure/fs-nodes/:id/drain` — sets status=DRAINING.
2. No new campaigns are assigned (rebalancer skips DRAINING nodes).
3. Wait for active_calls → 0 (monitor via health table).
4. `POST /api/admin/infrastructure/fs-nodes/:id/repin` to move lingering pinned campaigns.
5. Take node offline.

### Emergency re-pin (node failure)
1. Node goes UNHEALTHY (3 failed heartbeats, ~30s).
2. Rebalancer automatically moves idle campaigns.
3. Live calls on the failed node will fail (FreeSWITCH process gone); agents see call drop.
4. Agents re-login; new campaigns originate on healthy nodes.

### Kamailio set 20 resync
```bash
python3 dispatcher-list-renderer.py --action=sync
```
Triggers on any node CRUD via pub/sub + router Reload.

---

## ESL router health verification

Prometheus metrics (all prefixed `vici2_esl_`):
- `esl_router_connections_total{node_id}` — total connection attempts
- `esl_router_connections_up{node_id}` — current healthy connections (0/1)
- `esl_router_heartbeats_total{node_id,result}` — heartbeat outcomes (healthy/failed)
- `esl_router_reconnects_total{node_id}` — reconnection attempts
- `esl_router_conn_latency_seconds{node_id}` — heartbeat round-trip histogram

---

## Known edge cases

- **Multi-campaign agents**: agents register SIP with `X-FS-Affinity-Campaign` header for their active campaign. If an agent manages multiple campaigns on different FS nodes simultaneously, they must re-register per campaign switch.
- **Forced re-pin during live calls**: `force=true` updates the DB pin immediately. The current call stays on the old FS node (ESL originated it there); the next originate uses the new node. No mid-call bridge migration is possible (cross-FS bridging is impossible without hairpin).
- **FAILOVER_PENDING campaigns**: rebalancer only queries `campaign_status = ACTIVE`. Campaigns in other states are skipped.
- **Weight=0**: treated as weight=1 (floor) in rendezVousScore to avoid division-by-zero; the node still receives some assignments.
