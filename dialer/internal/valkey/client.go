// client.go — Valkey client wrapper for the dialer.
//
// F04 PLAN §7.1: opinionated factory around go-redis v9. Phase 1
// collapses state+cache into one instance (the same URL); Phase 2 will
// split into VALKEY_STATE_URL and VALKEY_CACHE_URL without changing the
// caller-facing API.

package valkey

import (
	"context"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/redis/go-redis/v9"
)

// Config controls the dialer's Valkey connection. See PLAN §7.1.
type Config struct {
	// URL is parsed by go-redis's redis.ParseURL. Accepts `redis://`,
	// `rediss://`, and `unix://`. Falls back to env discovery in
	// NewFromEnv (preferred constructor for app code).
	URL string

	// CacheURL is optional. Empty means "same instance, DB 1".
	CacheURL string

	Password string
	TenantID int64 // PLAN §4: every key tenant-prefixed.

	PoolSize    int
	MinIdleConn int
	DialTO      time.Duration
	ReadTO      time.Duration
	WriteTO     time.Duration
}

// applyDefaults returns a copy of c with zero fields filled in.
func (c Config) applyDefaults() Config {
	if c.PoolSize == 0 {
		c.PoolSize = 30
	}
	if c.MinIdleConn == 0 {
		c.MinIdleConn = 5
	}
	if c.DialTO == 0 {
		c.DialTO = 3 * time.Second
	}
	if c.ReadTO == 0 {
		c.ReadTO = 2 * time.Second
	}
	if c.WriteTO == 0 {
		c.WriteTO = 2 * time.Second
	}
	if c.TenantID == 0 {
		c.TenantID = 1 // Phase 1 single-tenant default
	}
	return c
}

// Client bundles the state + cache *redis.Client handles, the typed key
// builders, and the embedded Lua script registry.
type Client struct {
	State   *redis.Client
	Cache   *redis.Client
	Keys    Keys
	Scripts *ScriptRegistry

	cfg Config
}

// New builds a Client from an explicit Config. SCRIPT LOAD is performed
// against State; callers should ensure connectivity before invoking
// (e.g., call Ping(ctx) first).
func New(ctx context.Context, cfg Config) (*Client, error) {
	cfg = cfg.applyDefaults()
	if cfg.URL == "" {
		return nil, errors.New("valkey: Config.URL is required")
	}

	stateOpts, err := redis.ParseURL(cfg.URL)
	if err != nil {
		return nil, fmt.Errorf("valkey: parse URL: %w", err)
	}
	if cfg.Password != "" {
		stateOpts.Password = cfg.Password
	}
	stateOpts.PoolSize = cfg.PoolSize
	stateOpts.MinIdleConns = cfg.MinIdleConn
	stateOpts.DialTimeout = cfg.DialTO
	stateOpts.ReadTimeout = cfg.ReadTO
	stateOpts.WriteTimeout = cfg.WriteTO

	state := redis.NewClient(stateOpts)

	var cache *redis.Client
	switch {
	case cfg.CacheURL != "" && cfg.CacheURL != cfg.URL:
		cOpts, err := redis.ParseURL(cfg.CacheURL)
		if err != nil {
			_ = state.Close()
			return nil, fmt.Errorf("valkey: parse cache URL: %w", err)
		}
		if cfg.Password != "" {
			cOpts.Password = cfg.Password
		}
		cOpts.PoolSize = cfg.PoolSize
		cOpts.MinIdleConns = cfg.MinIdleConn
		cOpts.DialTimeout = cfg.DialTO
		cOpts.ReadTimeout = cfg.ReadTO
		cOpts.WriteTimeout = cfg.WriteTO
		cache = redis.NewClient(cOpts)
	default:
		// Same instance, DB 1 for cache. Phase 1 single-instance.
		cacheOpts := *stateOpts
		cacheOpts.DB = 1
		cache = redis.NewClient(&cacheOpts)
	}

	reg, err := NewScriptRegistry()
	if err != nil {
		_ = state.Close()
		_ = cache.Close()
		return nil, err
	}

	c := &Client{
		State:   state,
		Cache:   cache,
		Keys:    NewKeys(cfg.TenantID),
		Scripts: reg,
		cfg:     cfg,
	}

	// Best-effort SCRIPT LOAD: if the server is unreachable now the call
	// returns an error and the caller decides; in steady state the
	// Eval path will lazy-load on NOSCRIPT anyway.
	if err := reg.Load(ctx, state); err != nil {
		return c, fmt.Errorf("valkey: initial SCRIPT LOAD: %w", err)
	}

	return c, nil
}

// NewFromEnv assembles a Config from the standard env vars (PLAN §7.1
// precedence: VALKEY_STATE_URL → VALKEY_URL → REDIS_URL) and constructs
// the Client.
func NewFromEnv(ctx context.Context) (*Client, error) {
	url := firstNonEmpty(
		os.Getenv("VALKEY_STATE_URL"),
		os.Getenv("VALKEY_URL"),
		os.Getenv("REDIS_URL"),
	)
	if url == "" {
		return nil, errors.New("valkey: no VALKEY_URL / VALKEY_STATE_URL / REDIS_URL set")
	}
	cache := firstNonEmpty(os.Getenv("VALKEY_CACHE_URL"), url)
	tid := int64(1)
	if v := os.Getenv("VICI2_DEFAULT_TENANT_ID"); v != "" {
		// best-effort parse; on error stay at 1
		var n int64
		_, _ = fmt.Sscan(v, &n)
		if n > 0 {
			tid = n
		}
	}
	return New(ctx, Config{
		URL:      url,
		CacheURL: cache,
		Password: os.Getenv("VALKEY_PASSWORD"),
		TenantID: tid,
	})
}

// Ping verifies the state instance is reachable.
func (c *Client) Ping(ctx context.Context) error {
	return c.State.Ping(ctx).Err()
}

// HasBloomModule returns true if the connected Valkey has the
// `valkey-bloom` (or RedisBloom-compatible) module loaded. D05's IsDnc
// uses this to choose between Bloom Lua and in-process fallback.
func (c *Client) HasBloomModule(ctx context.Context) (bool, error) {
	res, err := c.State.Do(ctx, "MODULE", "LIST").Result()
	if err != nil {
		// Older Valkey/Redis versions return wrong-arity if no modules
		// loaded? In practice MODULE LIST exists since Redis 4.x.
		return false, err
	}
	arr, ok := res.([]any)
	if !ok {
		return false, nil
	}
	for _, m := range arr {
		// Each entry is itself a list of key/value pairs.
		inner, ok := m.([]any)
		if !ok {
			continue
		}
		for i := 0; i+1 < len(inner); i += 2 {
			k, _ := inner[i].(string)
			v, _ := inner[i+1].(string)
			if k == "name" && (v == "bf" || v == "valkey-bloom") {
				return true, nil
			}
		}
	}
	return false, nil
}

// Close releases both client connections.
func (c *Client) Close() error {
	var first error
	if err := c.State.Close(); err != nil {
		first = err
	}
	if err := c.Cache.Close(); err != nil && first == nil {
		first = err
	}
	return first
}

func firstNonEmpty(vs ...string) string {
	for _, v := range vs {
		if v != "" {
			return v
		}
	}
	return ""
}
