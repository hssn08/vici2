package pool

import (
	"context"
	"database/sql"
	"fmt"
	"math/rand"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/vici2/dialer/internal/valkey"
)

// Service is the pool picker service. Create with NewService.
type Service struct {
	cache *Cache
	rdb   redis.UniversalClient
	keys  valkey.Keys
}

// NewService creates a Service. db is used by the cache to load pool state.
// rdb is the Valkey client. keys must be bound to the correct tenant.
func NewService(db *sql.DB, rdb redis.UniversalClient, keys valkey.Keys) *Service {
	return &Service{
		cache: NewCache(db, rdb),
		rdb:   rdb,
		keys:  keys,
	}
}

// StartInvalidationSubscriber starts a background goroutine that listens for
// pool invalidation pub/sub messages and clears the in-process cache.
// Call once after creating the service.
func (s *Service) StartInvalidationSubscriber(ctx context.Context) {
	s.cache.Subscribe(ctx, s.keys.TenantID())
}

// PickFromPool selects a caller-ID number from the named pool.
// It enforces: quarantine exclusion, daily cap, concurrent cap, area-code filter.
// Returns ErrPoolEmpty if no eligible member exists.
func (s *Service) PickFromPool(ctx context.Context, req PickRequest) (*PickResult, error) {
	pidStr := strconv.FormatInt(req.PoolID, 10)

	members, config, err := s.cache.Get(ctx, req.TenantID, req.PoolID)
	if err != nil {
		return nil, fmt.Errorf("pool: cache miss: %w", err)
	}

	eligible := s.filterMembers(ctx, members, req, config)
	if len(eligible) == 0 {
		poolPickEmpty.WithLabelValues(pidStr).Inc()
		return nil, ErrPoolEmpty
	}

	var picked *PoolMember
	switch config.Strategy {
	case "round_robin":
		picked = s.pickRoundRobin(ctx, eligible, req)
	case "random":
		picked = pickRandom(eligible)
	case "least_recently_used":
		picked = pickLRU(eligible)
	default: // health_weighted_lru
		picked = pickHealthWeightedLRU(eligible)
	}

	if picked == nil {
		poolPickEmpty.WithLabelValues(pidStr).Inc()
		return nil, ErrPoolEmpty
	}

	// Increment concurrent counter (decremented by Release on call hangup)
	s.rdb.Incr(ctx, s.keys.DIDConcurrent(picked.DidID))

	// Increment daily counter with midnight TTL
	s.incrDailyCounter(ctx, picked.DidID)

	poolPickTotal.WithLabelValues(pidStr, config.Strategy).Inc()

	return &PickResult{
		E164:   picked.E164,
		DidID:  picked.DidID,
		NPID:   picked.NPID,
		Source: fmt.Sprintf("pool:%d", req.PoolID),
	}, nil
}

// Release decrements the concurrent-call counter for a DID after hangup.
// Called by the originate/hangup path.
func (s *Service) Release(ctx context.Context, didID int64) {
	s.rdb.Decr(ctx, s.keys.DIDConcurrent(didID))
}

// filterMembers removes ineligible members from the candidate list.
func (s *Service) filterMembers(
	ctx context.Context,
	members []PoolMember,
	req PickRequest,
	config PoolConfig,
) []*PoolMember {
	eligible := make([]*PoolMember, 0, len(members))
	for i := range members {
		m := &members[i]

		if m.Quarantined {
			continue
		}

		// Area-code filter (X05 local-presence)
		if req.AreaCodeHint != "" && m.AreaCode != req.AreaCodeHint {
			continue
		}

		// Daily cap
		if config.DailyCap > 0 {
			dailyKey := s.keys.DIDDailyCalls(m.DidID)
			val, err := s.rdb.Get(ctx, dailyKey).Int()
			if err == nil && val >= config.DailyCap {
				continue
			}
		}

		// Concurrent cap
		if config.MaxConcurrent > 0 {
			concKey := s.keys.DIDConcurrent(m.DidID)
			val, err := s.rdb.Get(ctx, concKey).Int()
			if err == nil && val >= config.MaxConcurrent {
				continue
			}
		}

		eligible = append(eligible, m)
	}
	return eligible
}

// pickHealthWeightedLRU selects a member using health score weighted by
// recency: w = HealthScore / (1 + hours_since_last_use).
// Recently-used numbers have lower weight, so the algorithm naturally rotates.
func pickHealthWeightedLRU(eligible []*PoolMember) *PoolMember {
	if len(eligible) == 0 {
		return nil
	}
	now := time.Now().Unix()

	weights := make([]float64, len(eligible))
	var total float64
	for i, m := range eligible {
		hoursSince := 0.0
		if m.LastUsedAt > 0 {
			hoursSince = float64(now-m.LastUsedAt) / 3600.0
		}
		w := float64(m.HealthScore) / (1.0 + hoursSince)
		if w < 0.001 {
			w = 0.001 // floor to avoid zero-weight starvation
		}
		weights[i] = w
		total += w
	}

	// Weighted random selection
	r := rand.Float64() * total
	var cum float64
	for i, w := range weights {
		cum += w
		if r <= cum {
			return eligible[i]
		}
	}
	// Fallback (float rounding)
	return eligible[len(eligible)-1]
}

// pickRoundRobin selects via atomic INCR in Valkey modulo pool size.
func (s *Service) pickRoundRobin(ctx context.Context, eligible []*PoolMember, req PickRequest) *PoolMember {
	if len(eligible) == 0 {
		return nil
	}
	cursor, err := s.rdb.Incr(ctx, s.keys.PoolRRCursor(req.PoolID)).Result()
	if err != nil {
		// Fallback to random on Valkey error
		return eligible[rand.Intn(len(eligible))]
	}
	idx := int(cursor-1) % len(eligible)
	if idx < 0 {
		idx = 0
	}
	return eligible[idx]
}

// pickRandom selects a random eligible member.
func pickRandom(eligible []*PoolMember) *PoolMember {
	if len(eligible) == 0 {
		return nil
	}
	return eligible[rand.Intn(len(eligible))]
}

// pickLRU returns the member with the oldest LastUsedAt timestamp.
func pickLRU(eligible []*PoolMember) *PoolMember {
	if len(eligible) == 0 {
		return nil
	}
	best := eligible[0]
	for _, m := range eligible[1:] {
		if m.LastUsedAt < best.LastUsedAt {
			best = m
		}
	}
	return best
}

// incrDailyCounter atomically increments the daily call counter for a DID,
// setting a TTL of seconds-until-midnight-UTC if the key did not exist.
func (s *Service) incrDailyCounter(ctx context.Context, didID int64) {
	key := s.keys.DIDDailyCalls(didID)

	// Try to set key with TTL if it doesn't exist yet (NX = set if not exists)
	now := time.Now().UTC()
	midnight := time.Date(now.Year(), now.Month(), now.Day()+1, 0, 0, 0, 0, time.UTC)
	ttl := time.Until(midnight)
	if ttl < time.Second {
		ttl = time.Second
	}

	// Use SetNX to initialize to 0 with TTL; then INCR
	s.rdb.SetNX(ctx, key, 0, ttl)
	s.rdb.Incr(ctx, key)
}
