package tz

import (
	"context"
	"database/sql"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/nyaruka/phonenumbers"
	"github.com/redis/go-redis/v9"
)

// Resolver implements the 6-tier cascade timezone resolver (D03).
// It is safe for concurrent use.
//
// Tier precedence (FROZEN):
//  1. lead.known_timezone (IANA string)   → ConfKnown
//  2. lead.postal_code → zip_codes map    → ConfZIP
//  3. phone NPA+NXX → phone_codes_overrides then phone_codes → ConfNXX
//  4. phone NPA only → npaOnlyCache OR libphonenumber            → ConfNPA
//  5. lead.state → singleTzStateMap (excluded for 8 split states) → ConfStateDefault
//  6. campaign.default_timezone                                    → ConfCampaignDefault
//
// All tiers exhausted → ConfNone.
type Resolver struct {
	db     *sql.DB
	valkey *redis.Client // pubsub only; not on hot path

	phoneCodesCache atomic.Value // *phoneMap
	overrideCache   atomic.Value // *phoneMap
	npaOnlyCache    atomic.Value // *npaMap
	npaStateCache   atomic.Value // *npaStateMap  X05: NPA→state
	zipCodesCache   atomic.Value // *zipMap

	campaignLRU  *campaignCache
	lastLoadedAt atomicInt64
}

// New creates a new Resolver and returns it (not yet loaded).
// Call Preload(ctx) before first use and Subscribe(ctx) for hot-reload.
func New(db *sql.DB, vk *redis.Client) *Resolver {
	r := &Resolver{
		db:          db,
		valkey:      vk,
		campaignLRU: newCampaignCache(1000),
	}
	// Initialise atomic.Value with empty maps to prevent nil dereferences
	empty := make(phoneMap)
	emptyZ := make(zipMap)
	emptyN := make(npaMap)
	emptyNS := make(npaStateMap)
	r.phoneCodesCache.Store(&empty)
	r.overrideCache.Store(&empty)
	r.zipCodesCache.Store(&emptyZ)
	r.npaOnlyCache.Store(&emptyN)
	r.npaStateCache.Store(&emptyNS)

	warmLocations()
	return r
}

// Start calls Preload (fail-fast on error), Subscribe, and startPeriodicRefresh.
func (r *Resolver) Start(ctx context.Context) error {
	if err := r.Preload(ctx); err != nil {
		return err
	}
	if r.valkey != nil {
		if err := r.Subscribe(ctx); err != nil {
			return err
		}
	}
	r.startPeriodicRefresh(ctx)
	return nil
}

// Resolve runs the 6-tier cascade for a single request.
func (r *Resolver) Resolve(ctx context.Context, req ResolveRequest) (ResolveResult, error) {
	timer := time.Now()

	res, tier := r.resolve(ctx, req)

	tzResolveDuration.WithLabelValues(tier).Observe(time.Since(timer).Seconds())
	recordResolve(res.Confidence, tier)

	return res, nil
}

// resolve is the internal implementation (without metrics wrapper).
func (r *Resolver) resolve(_ context.Context, req ResolveRequest) (ResolveResult, string) {
	// ── Tier 1: explicit lead.known_timezone ────────────────────────────────
	if req.KnownTimezone != "" {
		if loc, ok := loadLocation(req.KnownTimezone); ok {
			return ResolveResult{
				IANA:       req.KnownTimezone,
				Location:   loc,
				Confidence: ConfKnown,
				Source:     "lead.known_timezone",
			}, "tier1"
		}
		// Bad IANA string — warn and fall through (do not block on a typo)
		slog.Warn("tz: invalid lead.known_timezone, falling through",
			"value", req.KnownTimezone, "lead_id", req.LeadID)
		tzUnknownTotal.WithLabelValues("bad_known_tz").Inc()
	}

	// Parse phone number once (cached in LRU)
	var parsed parsedNumber
	var parseOK bool
	if req.PhoneE164 != "" {
		p, err := parseE164(req.PhoneE164)
		if err == nil {
			parsed = p
			parseOK = true
		} else {
			slog.Debug("tz: parse failed", "phone", req.PhoneE164, "err", err)
			tzUnknownTotal.WithLabelValues("invalid_phone").Inc()
		}
	}

	// ── Tier 2: ZIP → zip_codes map ─────────────────────────────────────────
	if isValidUSZip(req.Zip) {
		zc := r.zipCodesCache.Load().(*zipMap)
		key := zipKey(req.Zip)
		if entry, ok := (*zc)[key]; ok {
			tzCacheHits.WithLabelValues("zip").Inc()
			return r.buildResult(entry, ConfZIP, "zip:"+req.Zip, parsed, parseOK), "tier2"
		}
		tzCacheMisses.WithLabelValues("zip").Inc()
	}

	if parseOK {
		// ── Tier 3: NPA+NXX override then phone_codes ───────────────────────
		key := parsed.Key

		ov := r.overrideCache.Load().(*phoneMap)
		if entry, ok := (*ov)[key]; ok {
			tzCacheHits.WithLabelValues("overrides").Inc()
			src := "nxx:override:" + parsed.NPA + "-" + parsed.NXX
			return r.buildResult(entry, ConfNXX, src, parsed, parseOK), "tier3"
		}
		tzCacheMisses.WithLabelValues("overrides").Inc()

		pc := r.phoneCodesCache.Load().(*phoneMap)
		if entry, ok := (*pc)[key]; ok {
			tzCacheHits.WithLabelValues("phone_codes").Inc()
			src := "nxx:" + parsed.NPA + "-" + parsed.NXX
			return r.buildResult(entry, ConfNXX, src, parsed, parseOK), "tier3"
		}
		tzCacheMisses.WithLabelValues("phone_codes").Inc()

		// ── Tier 4: NPA-only collapse, then libphonenumber ──────────────────
		nm := r.npaOnlyCache.Load().(*npaMap)
		if entry, ok := (*nm)[parsed.NPA]; ok {
			tzCacheHits.WithLabelValues("npa_only").Inc()
			// Emit split-state collision metric if needed
			if splitStates[req.State] {
				tzSplitStateCollisions.WithLabelValues(req.State, parsed.NPA).Inc()
			}
			return r.buildResult(entry, ConfNPA, "npa:"+parsed.NPA, parsed, parseOK), "tier4"
		}
		tzCacheMisses.WithLabelValues("npa_only").Inc()

		// Libphonenumber NPA-level fallback (safety net)
		if parsed.Raw != nil {
			zones, _ := phonenumbers.GetTimezonesForNumber(parsed.Raw)
			if len(zones) > 0 {
				if loc, ok := loadLocation(zones[0]); ok {
					if splitStates[req.State] {
						tzSplitStateCollisions.WithLabelValues(req.State, parsed.NPA).Inc()
					}
					entry := cacheEntry{IANA: zones[0], Loc: loc}
					src := "npa:libphonenumber:" + parsed.NPA
					return r.buildResult(entry, ConfNPA, src, parsed, parseOK), "tier4"
				}
			}
		}
	}

	// ── Tier 5: single-tz state default (NOT for 8 split states) ────────────
	if req.State != "" {
		if iana, ok := singleTzStateMap[req.State]; ok {
			if loc, ok := loadLocation(iana); ok {
				return ResolveResult{
					IANA:       iana,
					Location:   loc,
					Confidence: ConfStateDefault,
					Source:     "state:" + req.State,
					NPA:        parsed.NPA,
					NXX:        parsed.NXX,
					NumberType: parsed.Type,
				}, "tier5"
			}
		}
		// split state or unknown state → fall through intentionally
		if req.State != "" && !splitStates[req.State] {
			// State not in singleTzStateMap and not a known split state
			tzUnknownTotal.WithLabelValues("no_state").Inc()
		}
	}

	// ── Tier 6: campaign default ─────────────────────────────────────────────
	if req.CampaignID != "" {
		if iana, ok := r.campaignLRU.get(req.CampaignID); ok && iana != "" {
			if loc, ok := loadLocation(iana); ok {
				return ResolveResult{
					IANA:       iana,
					Location:   loc,
					Confidence: ConfCampaignDefault,
					Source:     "campaign:" + req.CampaignID,
					NPA:        parsed.NPA,
					NXX:        parsed.NXX,
					NumberType: parsed.Type,
				}, "tier6"
			}
		}
	}

	// All tiers exhausted
	tzUnknownTotal.WithLabelValues("no_default").Inc()
	return ResolveResult{
		Confidence: ConfNone,
		NPA:        parsed.NPA,
		NXX:        parsed.NXX,
		NumberType: parsed.Type,
	}, "none"
}

// buildResult constructs a ResolveResult from a cache entry + parsed number info.
func (r *Resolver) buildResult(entry cacheEntry, conf Confidence, source string, p parsedNumber, ok bool) ResolveResult {
	res := ResolveResult{
		IANA:       entry.IANA,
		Location:   entry.Loc,
		Confidence: conf,
		Source:     source,
	}
	if ok {
		res.NPA = p.NPA
		res.NXX = p.NXX
		res.NumberType = p.Type
	}
	return res
}

// ResolveBatch resolves a slice of requests concurrently (goroutine pool, max 64).
// Used by E01 hopper filler. Target: 1000 leads in <500 µs.
func (r *Resolver) ResolveBatch(ctx context.Context, reqs []ResolveRequest) ([]ResolveResult, error) {
	results := make([]ResolveResult, len(reqs))
	if len(reqs) == 0 {
		return results, nil
	}

	const maxWorkers = 64
	sem := make(chan struct{}, maxWorkers)
	var wg sync.WaitGroup

	for i, req := range reqs {
		wg.Add(1)
		sem <- struct{}{}
		go func(idx int, r2 ResolveRequest) {
			defer wg.Done()
			defer func() { <-sem }()
			res, _ := r.resolve(ctx, r2)
			results[idx] = res
		}(i, req)
	}
	wg.Wait()
	return results, nil
}

// SetCampaignDefault caches a campaign's default timezone. Called by admin
// handlers when campaign config is updated. TTL: 5 minutes.
func (r *Resolver) SetCampaignDefault(campaignID, iana string) {
	r.campaignLRU.set(campaignID, iana)
}

// StateForNPA returns the 2-character US state code for the given 3-digit NPA
// (area code), or "" if the NPA is not in the phone_codes table or has no
// state assignment. Used by X05 local-presence Tier-3 same-state matching.
//
// The NPA→state map is loaded at startup (alongside npaOnlyCache) and refreshed
// every 6 hours. Lookups are O(1) with no I/O.
func (r *Resolver) StateForNPA(npa string) string {
	m := r.npaStateCache.Load().(*npaStateMap)
	return (*m)[npa]
}

// campaignCache is a simple TTL-aware LRU for campaign default timezones.
type campaignCache struct {
	mu    sync.Mutex
	m     map[string]campaignEntry
	cap   int
	order []string
}

type campaignEntry struct {
	iana      string
	expiresAt time.Time
}

func newCampaignCache(cap int) *campaignCache {
	return &campaignCache{
		m:     make(map[string]campaignEntry, cap),
		cap:   cap,
		order: make([]string, 0, cap),
	}
}

func (c *campaignCache) get(id string) (string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.m[id]
	if !ok {
		return "", false
	}
	if time.Now().After(e.expiresAt) {
		delete(c.m, id)
		return "", false
	}
	return e.iana, true
}

func (c *campaignCache) set(id, iana string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.m[id] = campaignEntry{iana: iana, expiresAt: time.Now().Add(5 * time.Minute)}
	if len(c.m) > c.cap {
		// Simple eviction: remove first entry in order slice
		for _, k := range c.order {
			if _, ok := c.m[k]; ok {
				delete(c.m, k)
				break
			}
		}
	}
}
