package originate

import (
	"context"
	"log/slog"
	"strconv"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/redis/go-redis/v9"
	"github.com/vici2/dialer/internal/pool"
	"github.com/vici2/dialer/internal/valkey"
)

// MatchTier constants for X05 local-presence tier results.
const (
	MatchTierExactNPA     = 1
	MatchTierNeighborNPA  = 2
	MatchTierSameState    = 3
	MatchTierPoolFallback = 4
)

// LocalPresenceResult extends pool.PickResult with X05 match-tier information.
type LocalPresenceResult struct {
	pool.PickResult
	MatchTier int    // 1-4; see MatchTier constants above
	MatchNPA  string // the NPA that matched for tiers 1-3; empty for tier 4
}

// PoolServiceProvider is the interface LocalPresencePicker requires from X04's
// pool service. *pool.Service implements this interface.
type PoolServiceProvider interface {
	PickFromPool(ctx context.Context, req pool.PickRequest) (*pool.PickResult, error)
	GetMembers(ctx context.Context, tenantID, poolID int64) ([]pool.PoolMember, pool.PoolConfig, error)
}

// x05Metrics holds Prometheus counters for the local-presence picker.
var x05Metrics = struct {
	matchTierTotal      *prometheus.CounterVec
	reservedNPASkip     *prometheus.CounterVec
	allQuarantinedTotal *prometheus.CounterVec
}{
	matchTierTotal: promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "vici2_x05_match_tier_total",
		Help: "Local-presence CID picks by tier.",
	}, []string{"tenant_id", "pool_id", "tier"}),

	reservedNPASkip: promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "vici2_x05_reserved_npa_skip_total",
		Help: "Calls where the called NPA was reserved (toll-free, etc.) — skipped to Tier 4.",
	}, []string{"tenant_id"}),

	allQuarantinedTotal: promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "vici2_x05_all_quarantined_total",
		Help: "Times a tier had candidates but all were quarantined.",
	}, []string{"tenant_id", "pool_id", "tier"}),
}

// LocalPresencePicker wraps X04's pool.Service with the X05 four-tier
// NPA-matching algorithm. It is used on the hot originate path in the
// Go dialer process.
type LocalPresencePicker struct {
	svcInterface PoolServiceProvider // injectable for testing
	poolSvc      *pool.Service       // concrete type for production use
	rdb          redis.UniversalClient
	keys         valkey.Keys
	tzResolver   NPAStateResolver
	indexBuilder *NPAIndexBuilder
}

// NewLocalPresencePicker creates a LocalPresencePicker backed by a concrete *pool.Service.
func NewLocalPresencePicker(
	poolSvc *pool.Service,
	rdb redis.UniversalClient,
	keys valkey.Keys,
	tz NPAStateResolver,
	builder *NPAIndexBuilder,
) *LocalPresencePicker {
	return &LocalPresencePicker{
		poolSvc:      poolSvc,
		svcInterface: poolSvc,
		rdb:          rdb,
		keys:         keys,
		tzResolver:   tz,
		indexBuilder: builder,
	}
}

// PickCallerIDWithLocalPresence runs the 4-tier local-presence waterfall.
//
// When localPresenceEnabled is false for the pool, it delegates directly to
// X04's PickFromPool (zero overhead). When enabled, it attempts:
//
//	Tier 1: exact NPA match
//	Tier 2: neighbor NPA match (overlay area codes)
//	Tier 3: same-state match
//	Tier 4: X04 pool fallback (health-weighted)
//
// gatewayCarrierID is reserved for Phase-2 A-attestation preference (pass 0).
func (p *LocalPresencePicker) PickCallerIDWithLocalPresence(
	ctx context.Context,
	tenantID int64,
	poolID int64,
	calledE164 string,
	localPresenceEnabled bool,
	gatewayCarrierID int64, // Phase-2: 0 = ignore
) (*LocalPresenceResult, error) {
	return p.pickWithInterface(ctx, tenantID, poolID, calledE164, localPresenceEnabled, gatewayCarrierID)
}

// pickWithInterface is the internal implementation that uses the svcInterface field.
// Separated to allow both production and test injection.
func (p *LocalPresencePicker) pickWithInterface(
	ctx context.Context,
	tenantID int64,
	poolID int64,
	calledE164 string,
	localPresenceEnabled bool,
	_ int64, // gatewayCarrierID: Phase-2 placeholder
) (*LocalPresenceResult, error) {
	tidStr := strconv.FormatInt(tenantID, 10)
	pidStr := strconv.FormatInt(poolID, 10)

	svc := p.resolvedService()

	// Fast path: feature disabled for this pool — delegate to X04 directly.
	if !localPresenceEnabled {
		res, err := svc.PickFromPool(ctx, pool.PickRequest{
			PoolID:   poolID,
			TenantID: tenantID,
		})
		if err != nil {
			return nil, err
		}
		return &LocalPresenceResult{PickResult: *res, MatchTier: MatchTierPoolFallback}, nil
	}

	calledNPA := extractNPA(calledE164)

	// Reserved NPA (toll-free, premium-rate, etc.) — skip to Tier 4.
	if calledNPA == "" || isReservedNPA(calledNPA) {
		x05Metrics.reservedNPASkip.WithLabelValues(tidStr).Inc()
		x05Metrics.matchTierTotal.WithLabelValues(tidStr, pidStr, "pool_fallback").Inc()
		return p.x04FallbackWith(ctx, tenantID, poolID, svc)
	}

	// Build a map of DID ID → PoolMember from the X04 in-process cache.
	// This is used by sampleHealthyDID to look up E.164 without extra I/O.
	membersByID := p.buildMemberMap(ctx, tenantID, poolID, svc)

	// Tier 1: exact NPA match
	if res, ok := p.sampleHealthyDID(ctx, poolID, pidStr,
		p.keys.PoolNPAIndex(poolID, calledNPA), "exact_npa", membersByID); ok {
		x05Metrics.matchTierTotal.WithLabelValues(tidStr, pidStr, "exact_npa").Inc()
		return &LocalPresenceResult{PickResult: *res, MatchTier: MatchTierExactNPA, MatchNPA: calledNPA}, nil
	}

	// Tier 2: neighbor NPA match
	for _, neighborNPA := range neighborNPAs(calledNPA) {
		if neighborNPA == "" {
			continue
		}
		if res, ok := p.sampleHealthyDID(ctx, poolID, pidStr,
			p.keys.PoolNPAIndex(poolID, neighborNPA), "neighbor_npa", membersByID); ok {
			x05Metrics.matchTierTotal.WithLabelValues(tidStr, pidStr, "neighbor_npa").Inc()
			return &LocalPresenceResult{PickResult: *res, MatchTier: MatchTierNeighborNPA, MatchNPA: neighborNPA}, nil
		}
	}

	// Tier 3: same state match
	if calledState := p.tzResolver.StateForNPA(calledNPA); calledState != "" {
		if res, ok := p.sampleHealthyDID(ctx, poolID, pidStr,
			p.keys.PoolStateIndex(poolID, calledState), "same_state", membersByID); ok {
			x05Metrics.matchTierTotal.WithLabelValues(tidStr, pidStr, "same_state").Inc()
			return &LocalPresenceResult{PickResult: *res, MatchTier: MatchTierSameState, MatchNPA: ""}, nil
		}
	}

	// Tier 4: X04 pool fallback
	x05Metrics.matchTierTotal.WithLabelValues(tidStr, pidStr, "pool_fallback").Inc()
	return p.x04FallbackWith(ctx, tenantID, poolID, svc)
}

// resolvedService returns the PoolServiceProvider to use.
func (p *LocalPresencePicker) resolvedService() PoolServiceProvider {
	if p.svcInterface != nil {
		return p.svcInterface
	}
	return p.poolSvc
}

// x04FallbackWith delegates to X04's health-weighted pool picker via the
// provided service interface.
func (p *LocalPresencePicker) x04FallbackWith(
	ctx context.Context,
	tenantID, poolID int64,
	svc PoolServiceProvider,
) (*LocalPresenceResult, error) {
	res, err := svc.PickFromPool(ctx, pool.PickRequest{
		PoolID:   poolID,
		TenantID: tenantID,
	})
	if err != nil {
		return nil, err
	}
	return &LocalPresenceResult{PickResult: *res, MatchTier: MatchTierPoolFallback}, nil
}

// buildMemberMap returns a map of DID ID → *PoolMember using the X04 in-process
// cache. Returns a nil map on cache miss (callers handle nil gracefully).
func (p *LocalPresencePicker) buildMemberMap(
	ctx context.Context,
	tenantID, poolID int64,
	svc PoolServiceProvider,
) map[int64]*pool.PoolMember {
	members, _, err := svc.GetMembers(ctx, tenantID, poolID)
	if err != nil {
		return nil
	}
	m := make(map[int64]*pool.PoolMember, len(members))
	for i := range members {
		m[members[i].DidID] = &members[i]
	}
	return m
}

// sampleHealthyDID samples up to 5 DID IDs from the Valkey SET at valkeyKey,
// checks each against the quarantine key via a pipelined EXISTS, and returns
// the PickResult for the first non-quarantined DID. Returns false if no healthy
// candidate was found or the SET is empty.
func (p *LocalPresencePicker) sampleHealthyDID(
	ctx context.Context,
	poolID int64,
	pidStr string,
	valkeyKey string,
	tierLabel string,
	membersByID map[int64]*pool.PoolMember,
) (*pool.PickResult, bool) {
	// SRANDMEMBER with negative count returns up to N members.
	candidates, err := p.rdb.SRandMemberN(ctx, valkeyKey, 5).Result()
	if err != nil || len(candidates) == 0 {
		// Empty SET — trigger async index rebuild if sentinel missing.
		sentinelKey := p.keys.PoolNPAIndexBuilt(poolID)
		exists, _ := p.rdb.Exists(ctx, sentinelKey).Result()
		if exists == 0 && p.indexBuilder != nil {
			slog.Debug("x05: cold-start index rebuild triggered", "pool_id", poolID, "key", valkeyKey)
			go func() {
				bctx := context.Background()
				if err2 := p.indexBuilder.RebuildPool(bctx, p.keys.TenantID(), poolID); err2 != nil {
					slog.Error("x05: cold-start rebuild failed", "pool_id", poolID, "err", err2)
				}
			}()
		}
		return nil, false
	}

	// Parse candidate DID IDs.
	didIDs := make([]int64, 0, len(candidates))
	for _, c := range candidates {
		id, parseErr := strconv.ParseInt(c, 10, 64)
		if parseErr == nil {
			didIDs = append(didIDs, id)
		}
	}
	if len(didIDs) == 0 {
		return nil, false
	}

	// Pipeline: EXISTS quarantine key for each candidate (single round-trip).
	pipe := p.rdb.Pipeline()
	cmds := make([]*redis.IntCmd, len(didIDs))
	for i, id := range didIDs {
		cmds[i] = pipe.Exists(ctx, p.keys.DIDQuarantined(poolID, id))
	}
	_, _ = pipe.Exec(ctx) // errors handled per-command below

	for i, cmd := range cmds {
		if cmd == nil {
			continue
		}
		quarantined, _ := cmd.Result()
		if quarantined > 0 {
			continue // quarantined — try next
		}
		// Found a healthy candidate.
		didID := didIDs[i]
		e164 := ""
		npid := int64(0)
		if membersByID != nil {
			if m, ok := membersByID[didID]; ok {
				e164 = m.E164
				npid = m.NPID
			}
		}
		return &pool.PickResult{
			E164:   e164,
			DidID:  didID,
			NPID:   npid,
			Source: "pool:" + pidStr,
		}, true
	}

	// All candidates quarantined.
	tenantIDStr := strconv.FormatInt(p.keys.TenantID(), 10)
	x05Metrics.allQuarantinedTotal.WithLabelValues(tenantIDStr, pidStr, tierLabel).Inc()
	return nil, false
}
