// snapshot.go — SnapshotReader: builds the 9-op Valkey pipeline per tick.
//
// E02 PLAN §5: 3×ZCARD (agent status), 1×SCARD (active_calls), 1×GET
// (dial_level), 1×EXISTS (drop_gated), up to 3×GET (gw_active per carrier).
// All ops pipelined in one round-trip; p99 ≤ 300 µs on LAN.
package pacing

import (
	"context"
	"fmt"
	"log/slog"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
	vkey "github.com/vici2/dialer/internal/valkey"
)

const (
	// agentStaleThreshold is how old an agent ZSET score can be before we treat
	// the agent as PAUSED. E02 PLAN §5.1 (15 s).
	agentStaleThreshold = 15 * time.Second

	// avgWaitToAnswerMsPhase2Stub is the Phase 2 hard-coded stub for
	// avg_wait_to_answer_ms (FCC 4-ring minimum). E02 PLAN §2.3 + Appendix A Q9.
	avgWaitToAnswerMsPhase2Stub = 4000
)

// SnapshotReader reads Valkey state for a single campaign tick.
type SnapshotReader struct {
	rc   *redis.Client
	keys vkey.Keys
	m    *Metrics
}

// NewSnapshotReader constructs a SnapshotReader.
func NewSnapshotReader(rc *redis.Client, keys vkey.Keys, m *Metrics) *SnapshotReader {
	return &SnapshotReader{rc: rc, keys: keys, m: m}
}

// Read assembles the Snapshot for (tenantID, campaignID, cfg) in one pipeline.
// Returns an error if the Valkey pipeline fails wholesale (partial failures
// are handled gracefully per §5 failure-mode semantics).
func (r *SnapshotReader) Read(ctx context.Context, cfg CampaignConfig, nowMs int64) (Snapshot, error) {
	tid := cfg.TenantIDStr()
	cid := cfg.CampaignID

	// Parse campaign ID as int64 for key builders that need it.
	cidInt, err := strconv.ParseInt(cid, 10, 64)
	if err != nil {
		// Campaign IDs may be non-numeric strings (VARCHAR(32)).
		// Keys that need cidInt (agent ZSETs, active_calls) use the raw string fallback.
		cidInt = 0
	}

	pipe := r.rc.Pipeline()

	// 1–3: ZCARD agent status ZSETs
	var (
		readyCmd  *redis.IntCmd
		incallCmd *redis.IntCmd
		wrapupCmd *redis.IntCmd
	)
	if cidInt > 0 {
		readyCmd = pipe.ZCard(ctx, r.keys.AgentsByCampaignStatus(cidInt, vkey.AgentReady))
		incallCmd = pipe.ZCard(ctx, r.keys.AgentsByCampaignStatus(cidInt, vkey.AgentInCall))
		wrapupCmd = pipe.ZCard(ctx, r.keys.AgentsByCampaignStatus(cidInt, vkey.AgentWrapup))
	}

	// 4: SCARD active_calls
	var activeCmd *redis.IntCmd
	if cidInt > 0 {
		activeCmd = pipe.SCard(ctx, r.keys.CampaignActiveCalls(cidInt))
	}

	// 5: GET dial_level
	var dialLevelCmd *redis.StringCmd
	if cidInt > 0 {
		dialLevelCmd = pipe.Get(ctx, r.keys.CampaignDialLevel(cidInt))
	}

	// 6: EXISTS drop_gated
	dropGatedKey := fmt.Sprintf("t:%d:campaign:{%s}:drop_gated", cfg.TenantID, cid)
	dropGatedCmd := pipe.Exists(ctx, dropGatedKey)

	// 7–9: GET gw_active per gateway (up to 3 in a typical pool)
	gwCmds := make([]*redis.StringCmd, len(cfg.GatewayIDs))
	for i, gwID := range cfg.GatewayIDs {
		gwCmds[i] = pipe.Get(ctx, r.keys.GatewayActive(gwID))
	}

	// Execute the pipeline.
	if _, err := pipe.Exec(ctx); err != nil && err != redis.Nil {
		return Snapshot{}, fmt.Errorf("snapshot: pipeline exec: %w", err)
	}

	snap := Snapshot{
		Config:            cfg,
		AvgWaitToAnswerMs: avgWaitToAnswerMsPhase2Stub,
		GWHeadroom:        -1, // unlimited if no gateways configured
	}

	// Resolve agent counts.
	if cidInt > 0 && readyCmd != nil {
		snap.ReadyAgents = int(readyCmd.Val())
		snap.InCallAgents = int(incallCmd.Val())
		snap.WrapupAgents = int(wrapupCmd.Val())
	}

	// Active calls.
	if cidInt > 0 && activeCmd != nil {
		snap.ActiveCalls = int(activeCmd.Val())
	}

	// Dial level.
	if cidInt > 0 && dialLevelCmd != nil {
		if dialLevelStr, err := dialLevelCmd.Result(); err == nil {
			if v, parseErr := strconv.ParseFloat(dialLevelStr, 64); parseErr == nil {
				// Sanity-clamp: E03 bug guard.
				if cfg.AdaptiveMaxLevel > 0 && v > cfg.AdaptiveMaxLevel {
					slog.Warn("pacing: dial_level out of range, clamping",
						slog.String("tenant", tid), slog.String("campaign", cid),
						slog.Float64("value", v), slog.Float64("max", cfg.AdaptiveMaxLevel))
					if r.m != nil {
						r.m.DialLevelOutOfRangeTotal.WithLabelValues(tid, cid).Inc()
					}
					v = cfg.AdaptiveMaxLevel
				}
				snap.DialLevel = v
			}
		} else if err == redis.Nil {
			// Missing: cold-start; will fall back to auto_dial_level in resolveLevel.
			slog.Debug("pacing: dial_level absent, using auto_dial_level fallback",
				slog.String("tenant", tid), slog.String("campaign", cid))
			if r.m != nil {
				r.m.DialLevelMissingTotal.WithLabelValues(tid, cid).Inc()
			}
		}
	}

	// Drop gate.
	if v, err := dropGatedCmd.Result(); err == nil {
		snap.DropGated = v > 0
	}

	// Gateway headroom.
	if len(cfg.GatewayIDs) > 0 {
		headroom := 0
		for i, gwID := range cfg.GatewayIDs {
			gwIDStr := strconv.FormatInt(gwID, 10)
			maxCon := cfg.GatewayMaxCon[gwID]
			if v, err := gwCmds[i].Result(); err == nil {
				active, _ := strconv.Atoi(v)
				h := maxCon - active
				if h < 0 {
					h = 0
				}
				headroom += h
			} else if err == redis.Nil {
				// T02 not yet populated: assume 0 active → full headroom.
				slog.Debug("pacing: gw_active absent, assuming full headroom",
					slog.String("tenant", tid), slog.String("gateway", gwIDStr))
				if r.m != nil {
					r.m.GWActiveMissingTotal.WithLabelValues(tid, cid, gwIDStr).Inc()
				}
				headroom += maxCon
			}
		}
		snap.GWHeadroom = headroom
	}

	return snap, nil
}
