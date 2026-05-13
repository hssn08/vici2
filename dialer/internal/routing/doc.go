// Package routing implements T02 — carrier/gateway selection for outbound dialing.
//
// # Responsibilities
//
//   - SelectGateway: weight + max_concurrent + cost-aware gateway picker.
//   - Per-carrier connector kinds (8 enum values).
//   - Active-call tracking via Valkey counters (t:{tid}:gw:{id}:active).
//   - Failover when a gateway is unhealthy or at capacity.
//   - DID/caller-ID picker (per-campaign/list rotation).
//   - DialString builder consumed by T04 originate pipeline.
//
// # Key shapes (Valkey)
//
//	t:{tid}:gw:{id}:active           — INT counter, INCR on CREATE, DECR on HANGUP
//	t:{tid}:carrier:status:{gw_id}   — JSON HASH, TTL 90s, written by health poller
//	t:{tid}:lock:carrier:rescan       — single-flight lock (30s TTL, SET NX PX)
//
// # Frozen public surface (T02 PLAN §14)
//
//   - SelectGateway(ctx, SelectRequest) (Gateway, error)
//   - IncGatewayActive(ctx, tenantID, gatewayID) error
//   - DecGatewayActive(ctx, tenantID, gatewayID) error
//   - BuildDialString(tenantID int64, gateways []Gateway, dest string) string
//   - CallerIDForCall(req CIDRequest) string
//
// T01 PLAN §16.2: T01 owns ESL transport; routing owns selection policy only.
// T04 calls SelectGateway before invoking T01.Originate.
package routing
