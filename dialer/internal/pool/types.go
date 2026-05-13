// Package pool implements X04 — Number Pool + Rotation.
//
// PickFromPool selects a caller-ID number from a named pool using a health-
// weighted LRU algorithm (or round-robin / random / LRU per pool strategy).
// The in-process member cache is invalidated via Valkey pub/sub.
package pool

import "errors"

// ErrPoolEmpty is returned when PickFromPool finds no eligible member
// (all quarantined, capped, or area-code filtered).
var ErrPoolEmpty = errors.New("pool: no eligible member")

// PoolMember is a single DID entry in the in-process cache.
type PoolMember struct {
	NPID        int64  // number_pool_dids.id
	DidID       int64
	E164        string
	AreaCode    string
	HealthScore uint8  // [0, 100]
	LastUsedAt  int64  // Unix timestamp; 0 = never
	Quarantined bool
	AttestLevel string // "A", "B", "C", "unknown"
}

// PoolConfig is the pool-level configuration cached alongside members.
type PoolConfig struct {
	Strategy             string
	DailyCap             int
	MaxConcurrent        int
	ARFloor              float64
	ARMinSample          int
	LocalPresenceEnabled bool // X05: when true, run NPA-matching tiers before pool round-robin
}

// PickRequest is passed to PickFromPool.
type PickRequest struct {
	PoolID       int64
	TenantID     int64
	AreaCodeHint string // "" = no filter; X05 passes 3-digit area code
}

// PickResult is returned by PickFromPool.
type PickResult struct {
	E164   string
	DidID  int64
	NPID   int64  // number_pool_dids.id (for recording last_used_at)
	Source string // "pool:{pool_id}" for CidSource label
}
