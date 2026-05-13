package queue

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// SkillCache is the in-process cache of agent skill sets.
// I01 PLAN §4.4: zero MySQL hits in steady state.
// TTL: 5 minutes. Invalidation via pubsub agent_skills_changed:{user_id}.
type SkillCache struct {
	mu      sync.RWMutex
	entries map[int64]*skillCacheEntry
	db      *sql.DB
	rdb     *redis.Client
	keys    QueueKeys
	log     *slog.Logger
}

type skillCacheEntry struct {
	skillSet  AgentSkillSet
	loadedAt  time.Time
}

// NewSkillCache constructs a SkillCache.
func NewSkillCache(db *sql.DB, rdb *redis.Client, keys QueueKeys, log *slog.Logger) *SkillCache {
	if log == nil {
		log = slog.Default()
	}
	return &SkillCache{
		entries: make(map[int64]*skillCacheEntry),
		db:      db,
		rdb:     rdb,
		keys:    keys,
		log:     log,
	}
}

// Get returns the skill set for the given agent. Loads from MySQL on miss.
// I01 PLAN §4.4.
func (c *SkillCache) Get(ctx context.Context, userID int64) (*AgentSkillSet, error) {
	// Fast path: read lock
	c.mu.RLock()
	entry, ok := c.entries[userID]
	c.mu.RUnlock()
	if ok && time.Since(entry.loadedAt) < SkillCacheTTL {
		return &entry.skillSet, nil
	}

	// Slow path: load from DB
	skills, err := c.loadFromDB(ctx, userID)
	if err != nil {
		return nil, err
	}

	c.mu.Lock()
	c.entries[userID] = &skillCacheEntry{
		skillSet: *skills,
		loadedAt: time.Now(),
	}
	c.mu.Unlock()

	return skills, nil
}

// Invalidate evicts a single agent from cache (called by pubsub handler).
func (c *SkillCache) Invalidate(userID int64) {
	c.mu.Lock()
	delete(c.entries, userID)
	c.mu.Unlock()
}

// loadFromDB queries agent_skills for the given user, excluding expired skills.
// I01 PLAN §4.5.
func (c *SkillCache) loadFromDB(ctx context.Context, userID int64) (*AgentSkillSet, error) {
	const q = `
		SELECT skill_key, skill_value, proficiency
		FROM agent_skills
		WHERE user_id = ?
		  AND active = TRUE
		  AND (expires_at IS NULL OR expires_at >= CURDATE())`

	rows, err := c.db.QueryContext(ctx, q, userID)
	if err != nil {
		return nil, fmt.Errorf("skill_cache: loadFromDB user %d: %w", userID, err)
	}
	defer rows.Close()

	set := &AgentSkillSet{
		Skills:   make(map[string]int),
		LoadedAt: time.Now(),
	}
	for rows.Next() {
		var key, val string
		var prof int
		if err := rows.Scan(&key, &val, &prof); err != nil {
			return nil, fmt.Errorf("skill_cache: scan: %w", err)
		}
		set.Skills[key+":"+val] = prof
	}
	return set, rows.Err()
}

// RunInvalidationListener subscribes to agent_skills_changed:{user_id} pubsub
// and evicts the relevant cache entry on receipt.
// I01 PLAN §4.4.
func (c *SkillCache) RunInvalidationListener(ctx context.Context) error {
	// Pattern subscribe so a single subscription catches all user IDs.
	pubsub := c.rdb.PSubscribe(ctx, "agent_skills_changed:*")
	defer pubsub.Close()

	ch := pubsub.Channel()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case msg, ok := <-ch:
			if !ok {
				return nil
			}
			// channel = "agent_skills_changed:{userID}"
			var userID int64
			suffix := strings.TrimPrefix(msg.Channel, "agent_skills_changed:")
			if _, err := fmt.Sscanf(suffix, "%d", &userID); err != nil {
				c.log.Warn("skill_cache: malformed invalidation channel", "channel", msg.Channel)
				continue
			}
			c.Invalidate(userID)
			c.log.Debug("skill_cache: invalidated", "user_id", userID)
		}
	}
}
