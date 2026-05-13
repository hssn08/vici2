package dnc

import (
	"context"
	"database/sql"
	"regexp"
	"sort"
	"time"

	"github.com/redis/go-redis/v9"
)

// e164RE validates E.164 phone format.
var e164RE = regexp.MustCompile(`^\+[1-9]\d{1,14}$`)

// Checker is the DNC check primitive used by E01 hopper filler and T04 originate gate.
// It holds references to Valkey and MySQL; no network round-trips beyond those two.
type Checker struct {
	rdb     redis.UniversalClient
	db      *sql.DB
	metrics *Metrics
}

// NewChecker creates a Checker. metrics may be nil (no-op).
func NewChecker(rdb redis.UniversalClient, db *sql.DB, metrics *Metrics) *Checker {
	return &Checker{rdb: rdb, db: db, metrics: metrics}
}

// Check implements the DNC hot-path algorithm (PLAN §2.1).
func (c *Checker) Check(ctx context.Context, req CheckRequest) CheckResult {
	start := time.Now()

	// Step 1: validate phone
	if !e164RE.MatchString(req.PhoneE164) {
		return CheckResult{
			IsDNC:         true,
			LatencyMicros: time.Since(start).Microseconds(),
			Reason:        "malformed",
		}
	}

	// Step 2: Bloom pipeline
	bloomHits := bloomMexists(ctx, c.rdb, req.Sources, req.TenantID, req.PhoneE164)

	// Collect positive sources
	var positiveSources []Source
	for _, src := range req.Sources {
		if bloomHits[src] {
			positiveSources = append(positiveSources, src)
		}
	}

	// Step 3: all-negative → fast path
	if len(positiveSources) == 0 {
		c.recordCheck(req.Sources, "miss", time.Since(start))
		return CheckResult{
			IsDNC:         false,
			LatencyMicros: time.Since(start).Microseconds(),
		}
	}

	// Step 4: MySQL confirmation
	confirmed, err := confirmMySQL(
		ctx, c.db,
		req.PhoneE164, req.TenantID, req.CampaignID, req.LeadState,
		positiveSources,
	)
	if err != nil {
		// MySQL unavailable → fail-closed (PLAN §1.5)
		c.recordCheck(positiveSources, "fail_closed", time.Since(start))
		return CheckResult{
			IsDNC:         true,
			Sources:       positiveSources,
			LatencyMicros: time.Since(start).Microseconds(),
		}
	}

	latency := time.Since(start)

	if len(confirmed) == 0 {
		// Bloom false positive
		c.recordFalsePositives(positiveSources)
		c.recordCheck(req.Sources, "false_positive", latency)
		return CheckResult{
			IsDNC:              false,
			BloomFalsePositive: true,
			LatencyMicros:      latency.Microseconds(),
		}
	}

	c.recordCheck(confirmed, "hit", latency)
	return CheckResult{
		IsDNC:         true,
		Sources:       sortSources(confirmed),
		LatencyMicros: latency.Microseconds(),
	}
}

// sortSources sorts by priority (PLAN §2.3): internal > litigator > state > federal.
func sortSources(sources []Source) []Source {
	out := make([]Source, len(sources))
	copy(out, sources)
	sort.Slice(out, func(i, j int) bool {
		return sourcePriority[out[i]] > sourcePriority[out[j]]
	})
	return out
}

func (c *Checker) recordCheck(sources []Source, outcome string, latency time.Duration) {
	if c.metrics == nil {
		return
	}
	for _, src := range sources {
		c.metrics.CheckTotal.WithLabelValues(string(src), outcome).Inc()
		c.metrics.CheckLatency.WithLabelValues(string(src)).Observe(latency.Seconds())
	}
}

func (c *Checker) recordFalsePositives(sources []Source) {
	if c.metrics == nil {
		return
	}
	for _, src := range sources {
		c.metrics.FalsePositiveTotal.WithLabelValues(string(src)).Inc()
	}
}
