package pool

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

const cacheTTL = 5 * time.Minute

// cacheEntry is one pool's cached state.
type cacheEntry struct {
	members   []PoolMember
	config    PoolConfig
	loadedAt  time.Time
	mu        sync.RWMutex
	invalid   bool // set true by pub/sub handler; cleared on next load
}

// Cache is the in-process pool member cache. It uses a sharded map to reduce
// lock contention across pools.
type Cache struct {
	shards [16]struct {
		mu      sync.RWMutex
		entries map[int64]*cacheEntry
	}
	db  *sql.DB
	rdb redis.UniversalClient
}

// NewCache creates a Cache backed by MySQL (db) and Valkey (rdb for pub/sub).
func NewCache(db *sql.DB, rdb redis.UniversalClient) *Cache {
	c := &Cache{db: db, rdb: rdb}
	for i := range c.shards {
		c.shards[i].entries = make(map[int64]*cacheEntry)
	}
	return c
}

func (c *Cache) shard(poolID int64) *struct {
	mu      sync.RWMutex
	entries map[int64]*cacheEntry
} {
	return &c.shards[poolID%16]
}

// Get returns the member list and config for the given pool, loading from DB
// on cache miss or after TTL expiry.
func (c *Cache) Get(ctx context.Context, tenantID, poolID int64) ([]PoolMember, PoolConfig, error) {
	pidStr := fmt.Sprintf("%d", poolID)
	s := c.shard(poolID)

	// Fast path: read lock
	s.mu.RLock()
	entry, ok := s.entries[poolID]
	s.mu.RUnlock()

	if ok {
		entry.mu.RLock()
		stale := entry.invalid || time.Since(entry.loadedAt) > cacheTTL
		if !stale {
			members := entry.members
			config := entry.config
			entry.mu.RUnlock()
			poolCacheHits.WithLabelValues(pidStr).Inc()
			return members, config, nil
		}
		entry.mu.RUnlock()
	}

	// Slow path: reload
	members, config, err := c.loadFromDB(ctx, tenantID, poolID)
	if err != nil {
		return nil, PoolConfig{}, err
	}

	s.mu.Lock()
	if _, exists := s.entries[poolID]; !exists {
		s.entries[poolID] = &cacheEntry{}
	}
	e := s.entries[poolID]
	s.mu.Unlock()

	e.mu.Lock()
	e.members = members
	e.config = config
	e.loadedAt = time.Now()
	e.invalid = false
	e.mu.Unlock()

	poolCacheReloads.WithLabelValues(pidStr).Inc()
	return members, config, nil
}

// Invalidate marks a pool's cache entry as stale; next Get will reload.
func (c *Cache) Invalidate(poolID int64) {
	s := c.shard(poolID)
	s.mu.RLock()
	entry, ok := s.entries[poolID]
	s.mu.RUnlock()
	if !ok {
		return
	}
	entry.mu.Lock()
	entry.invalid = true
	entry.mu.Unlock()
}

// Subscribe starts a goroutine that listens on the pub/sub invalidation
// channel pattern t:{tenantID}:pool:*:invalidate and invalidates the cache
// for the named pool. Runs until ctx is cancelled.
func (c *Cache) Subscribe(ctx context.Context, tenantID int64) {
	pattern := fmt.Sprintf("t:%d:pool:*:invalidate", tenantID)
	go func() {
		sub := c.rdb.PSubscribe(ctx, pattern)
		defer func() { _ = sub.Close() }()

		ch := sub.Channel()
		for {
			select {
			case <-ctx.Done():
				return
			case msg, ok := <-ch:
				if !ok {
					return
				}
				// Extract pool_id from the channel name
				var tid, pid int64
				_, _ = fmt.Sscanf(msg.Channel, "t:%d:pool:{%d}:invalidate", &tid, &pid)
				if pid > 0 {
					c.Invalidate(pid)
				}
			}
		}
	}()
}

// poolRow is a scan target for the DB query.
type poolRow struct {
	id            int64
	tenantID      int64
	strategy      string
	dailyCap      int
	maxConcurrent int
	arFloor       float64
	arMinSample   int
}

type memberRow struct {
	id          int64
	didID       int64
	e164        string
	areaCode    string
	healthScore int
	lastUsedAt  sql.NullTime
	quarantined bool
	attestLevel string
}

// loadFromDB queries MySQL for the pool config and non-quarantined members.
func (c *Cache) loadFromDB(ctx context.Context, tenantID, poolID int64) ([]PoolMember, PoolConfig, error) {
	poolQuery := `
		SELECT id, tenant_id, strategy, daily_cap, max_concurrent, ar_floor, ar_min_sample
		FROM number_pools
		WHERE id = ? AND tenant_id = ? AND active = 1
		LIMIT 1`

	var pr poolRow
	err := c.db.QueryRowContext(ctx, poolQuery, poolID, tenantID).Scan(
		&pr.id, &pr.tenantID, &pr.strategy, &pr.dailyCap,
		&pr.maxConcurrent, &pr.arFloor, &pr.arMinSample,
	)
	if err == sql.ErrNoRows {
		return nil, PoolConfig{}, fmt.Errorf("pool %d not found", poolID)
	}
	if err != nil {
		return nil, PoolConfig{}, fmt.Errorf("pool: load config: %w", err)
	}

	config := PoolConfig{
		Strategy:      pr.strategy,
		DailyCap:      pr.dailyCap,
		MaxConcurrent: pr.maxConcurrent,
		ARFloor:       pr.arFloor,
		ARMinSample:   pr.arMinSample,
	}

	memberQuery := `
		SELECT npd.id, npd.did_id, dn.e164, npd.area_code, npd.health_score,
		       npd.last_used_at, npd.quarantined, npd.attest_level
		FROM number_pool_dids npd
		JOIN did_numbers dn ON dn.id = npd.did_id
		WHERE npd.pool_id = ? AND npd.tenant_id = ?
		ORDER BY npd.id ASC`

	rows, err := c.db.QueryContext(ctx, memberQuery, poolID, tenantID)
	if err != nil {
		return nil, config, fmt.Errorf("pool: load members: %w", err)
	}
	defer rows.Close()

	var members []PoolMember
	for rows.Next() {
		var mr memberRow
		if err := rows.Scan(
			&mr.id, &mr.didID, &mr.e164, &mr.areaCode, &mr.healthScore,
			&mr.lastUsedAt, &mr.quarantined, &mr.attestLevel,
		); err != nil {
			return nil, config, fmt.Errorf("pool: scan member: %w", err)
		}
		var lastUsed int64
		if mr.lastUsedAt.Valid {
			lastUsed = mr.lastUsedAt.Time.Unix()
		}
		members = append(members, PoolMember{
			NPID:        mr.id,
			DidID:       mr.didID,
			E164:        mr.e164,
			AreaCode:    mr.areaCode,
			HealthScore: uint8(mr.healthScore),
			LastUsedAt:  lastUsed,
			Quarantined: mr.quarantined,
			AttestLevel: mr.attestLevel,
		})
	}
	if err := rows.Err(); err != nil {
		return nil, config, fmt.Errorf("pool: iterate members: %w", err)
	}

	return members, config, nil
}

// marshalMembers serializes member list to JSON (for Valkey members key — informational).
func marshalMembers(members []PoolMember) (string, error) {
	b, err := json.Marshal(members)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// keep compiler happy for unused marshal helper
var _ = marshalMembers
