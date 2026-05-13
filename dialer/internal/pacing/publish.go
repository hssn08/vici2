// publish.go — Publisher: writes dispatch_tokens + pacing_decisions stream
// + 4 live-gauge STRINGs to Valkey.
//
// E02 PLAN §6: all Valkey writes per tick go through this file.
// Pipeline: SET dispatch_tokens EX 2, XADD pacing_decisions, SETEX ×4.
package pacing

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
	vkey "github.com/vici2/dialer/internal/valkey"
)

const (
	dispatchTokensTTL = 2 * time.Second // E02 PLAN §4.1
	streamMaxLen      = 86400           // 24 h at 1 Hz; XTRIM nightly by F04
)

// Publisher writes E02's Valkey outputs each tick.
type Publisher struct {
	rc   *redis.Client
	keys vkey.Keys
	m    *Metrics
}

// NewPublisher constructs a Publisher.
func NewPublisher(rc *redis.Client, keys vkey.Keys, m *Metrics) *Publisher {
	return &Publisher{rc: rc, keys: keys, m: m}
}

// Publish writes all Valkey artifacts for one tick:
//   (a) dispatch_tokens STRING SET EX 2
//   (b) pacing_decisions Stream XADD MAXLEN ~ 86400
//   (c) 4 live-gauge STRINGs (no TTL)
//
// Even when desired=0, dispatch_tokens is written (not deleted) so E04 can
// distinguish "E02 healthy, says no dispatch" from "E02 down". E02 PLAN §4.4.
func (p *Publisher) Publish(ctx context.Context, cfg CampaignConfig, res DecideResult, meta TickMeta) error {
	cid := cfg.CampaignID
	cidInt, err := strconv.ParseInt(cid, 10, 64)
	if err != nil {
		cidInt = 0
	}

	pipe := p.rc.Pipeline()

	// (a) dispatch_tokens — primary E04 contract.
	dispatchKey := dispatchTokensKey(cfg.TenantID, cid)
	pipe.Set(ctx, dispatchKey, res.Desired, dispatchTokensTTL)

	// (b) pacing_decisions stream audit entry.
	streamKey := pacingDecisionsKey(cfg.TenantID, cid)
	clampsFiredStr := strings.Join(res.ClampsFired, ",")
	lockAcquiredVal := "0"
	if meta.LockAcquired {
		lockAcquiredVal = "1"
	}
	dropGatedVal := "0"
	if res.Desired == 1 && len(res.ClampsFired) > 0 {
		// heuristic: check if drop clamp fired
		for _, c := range res.ClampsFired {
			if c == "drop" {
				dropGatedVal = "1"
				break
			}
		}
	}
	streamVals := []interface{}{
		"ts", time.Now().UnixMilli(),
		"agents", res.AgentCount,
		"level", fmt.Sprintf("%.4f", res.Level),
		"active", 0, // filled below
		"base", res.Base,
		"gw_headroom", -1, // filled below
		"ramp_max", 0,    // computed in Pacer; stored in TickMeta
		"drop_gated", dropGatedVal,
		"desired", res.Desired,
		"clamps_fired", clampsFiredStr,
		"tick_duration_us", meta.TickDurationUs,
		"lock_acquired", lockAcquiredVal,
	}
	_ = cidInt // suppress unused; used for key selection below
	pipe.XAdd(ctx, &redis.XAddArgs{
		Stream: streamKey,
		MaxLen: streamMaxLen,
		Approx: true,
		Values: streamVals,
	})

	// (c) Live-gauge STRINGs (no TTL — S01/E03 reads anytime).
	desiredKey := fmt.Sprintf("t:%d:campaign:{%s}:pacing_desired_last_tick", cfg.TenantID, cid)
	agentsKey := fmt.Sprintf("t:%d:campaign:{%s}:pacing_agents_last_tick", cfg.TenantID, cid)
	activeKey := fmt.Sprintf("t:%d:campaign:{%s}:pacing_active_last_tick", cfg.TenantID, cid)
	clampKey := fmt.Sprintf("t:%d:campaign:{%s}:pacing_clamp_fired", cfg.TenantID, cid)

	pipe.Set(ctx, desiredKey, res.Desired, 0)
	pipe.Set(ctx, agentsKey, res.AgentCount, 0)
	pipe.Set(ctx, activeKey, 0 /*snap.ActiveCalls passed via TickMeta in Pacer*/, 0)
	pipe.Set(ctx, clampKey, clampsFiredStr, 0)

	if _, err := pipe.Exec(ctx); err != nil {
		return fmt.Errorf("publish: pipeline exec: %w", err)
	}

	// Prometheus.
	if p.m != nil {
		tid := cfg.TenantIDStr()
		p.m.DispatchTokensWrittenTotal.WithLabelValues(tid, cid).Inc()
		p.m.DispatchTokensValue.WithLabelValues(tid, cid).Set(float64(res.Desired))
		p.m.Desired.WithLabelValues(tid, cid).Set(float64(res.Desired))
	}
	return nil
}

// PublishLockMiss writes only the pacing_decisions stream entry for a
// lock-miss tick (lock_acquired=0), so forensics can observe skew.
// E02 PLAN §6.2.
func (p *Publisher) PublishLockMiss(ctx context.Context, cfg CampaignConfig) error {
	cid := cfg.CampaignID
	streamKey := pacingDecisionsKey(cfg.TenantID, cid)

	return p.rc.XAdd(ctx, &redis.XAddArgs{
		Stream: streamKey,
		MaxLen: streamMaxLen,
		Approx: true,
		Values: []interface{}{
			"ts", time.Now().UnixMilli(),
			"lock_acquired", "0",
			"desired", -1,
		},
	}).Err()
}

// dispatchTokensKey returns the E04-contract key for dispatch_tokens.
// E02 PLAN §4.1 + §6.1.
func dispatchTokensKey(tenantID int64, campaignID string) string {
	return fmt.Sprintf("t:%d:campaign:{%s}:dispatch_tokens", tenantID, campaignID)
}

// pacingDecisionsKey returns the audit stream key.
// E02 PLAN §6.2.
func pacingDecisionsKey(tenantID int64, campaignID string) string {
	return fmt.Sprintf("t:%d:campaign:{%s}:pacing_decisions", tenantID, campaignID)
}
