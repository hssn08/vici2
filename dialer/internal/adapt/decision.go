// E03 is a clean-room Go port of Vicidial AST_VDadapt.pl (public GPL source,
// in source control since at least 2008 per inktel/Vicidial git history).
// Improvements: explicit anti-windup (back-calculation), deadband, drop_gated fast-cut.
// Prior art documented per SPEC patent-defense protocol.

package adapt

import (
	"context"
	"fmt"
	"log/slog"
	"strconv"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/redis/go-redis/v9"
)

// RunTick executes one full adapt tick for a campaign:
//  1. Acquire tick lock (SET NX EX).
//  2. Pipeline GET: dial_level, drop_pct_30d, drop_gated; HGETALL: pace_state.
//  3. Build AdaptInput and call Decide().
//  4. If NeedsWrite: SET dial_level.
//  5. HSET pace_state.
//  6. XADD adapt_decisions stream.
//  7. Update Prometheus metrics.
//
// Returns (true, nil) when the tick ran; (false, nil) when lock was not acquired.
func RunTick(ctx context.Context, rdb *redis.Client, m *Metrics, cfg Config, podID string) (bool, error) {
	tid, cid := cfg.TenantID, cfg.CampaignID
	lv := Labels(tid, cid)
	start := time.Now()

	// 1. Acquire tick lock.
	lockKey := adaptLockKey(tid, cid)
	lockTTL := time.Duration(cfg.AdaptTickSeconds) * time.Second
	ok, err := rdb.SetNX(ctx, lockKey, podID, lockTTL).Result()
	if err != nil {
		m.TickSkippedTotal.With(prometheus.Labels{"tenant": lv["tenant"], "campaign": lv["campaign"], "reason": "valkey_down"}).Inc()
		return false, fmt.Errorf("adapt: acquire tick lock: %w", err)
	}
	if !ok {
		m.TickSkippedTotal.With(prometheus.Labels{"tenant": lv["tenant"], "campaign": lv["campaign"], "reason": "lock_contention"}).Inc()
		return false, nil
	}

	// 2. Pipeline reads.
	pipe := rdb.Pipeline()
	dlCmd := pipe.Get(ctx, dialLevelKey(tid, cid))
	dpCmd := pipe.Get(ctx, dropPct30dKey(tid, cid))
	dgCmd := pipe.Get(ctx, dropGatedKey(tid, cid))
	psCmd := pipe.HGetAll(ctx, paceStateKey(tid, cid))
	if _, err := pipe.Exec(ctx); err != nil && err != redis.Nil {
		m.TickSkippedTotal.With(prometheus.Labels{"tenant": lv["tenant"], "campaign": lv["campaign"], "reason": "valkey_down"}).Inc()
		return false, fmt.Errorf("adapt: pipeline read: %w", err)
	}

	now := time.Now()

	// Parse drop_pct_30d (E05 gauge).
	var dropPct float64
	if dpStr, err := dpCmd.Result(); err == nil {
		dropPct, _ = strconv.ParseFloat(dpStr, 64)
	} else {
		// Missing: use last cached value from pace_state; log WARN.
		m.DropPctMissing.With(lv).Inc()
		slog.Warn("adapt: drop_pct_30d missing from Valkey; using cached",
			"tenant", tid, "campaign", cid)
	}

	// Parse drop_gated.
	dropGated := false
	if dgStr, err := dgCmd.Result(); err == nil {
		dropGated = dgStr == "1"
	}
	_ = dropGated // consumed by fast-cut path; informational here

	// Parse pace_state.
	psMap, _ := psCmd.Result()
	var ps PaceState
	var coldStart bool
	if len(psMap) == 0 {
		ps = InitPaceState(cfg, now)
		coldStart = true
		m.ColdStartTotal.With(lv).Inc()
	} else {
		ps, _, _ = loadPaceStateFromMap(psMap)
		// If drop_pct_30d was missing, fall back to last cached.
		if dpCmd.Err() != nil {
			dropPct = ps.LastDropPct
		}
		m.RestartTotal.With(lv) // bump only on pod restart, not every tick; handled by supervisor
		_ = coldStart
	}

	// Parse current dial_level (may differ from ps.LastLevel if admin overrode).
	var currentLevel float64
	if dlStr, err := dlCmd.Result(); err == nil {
		currentLevel, _ = strconv.ParseFloat(dlStr, 64)
		if currentLevel != ps.LastLevel && ps.LastLevel != 0 {
			m.ExternalOverride.With(lv).Inc()
			slog.Warn("adapt: dial_level external override detected",
				"tenant", tid, "campaign", cid,
				"expected", ps.LastLevel, "found", currentLevel)
		}
	} else {
		currentLevel = ps.LastLevel
	}
	if currentLevel < LevelFloor {
		currentLevel = clamp(cfg.AutoDialLevel, LevelFloor, cfg.AdaptiveMaxLevel)
	}

	// Check warm-up gate.
	wu := WarmUpState{
		CallsRemaining: ps.WarmUpCallsRemaining,
		StartedAt:      ps.WarmUpStartedAt,
		MinAnswered:    cfg.WarmupMinAnswered,
		MinSeconds:     cfg.WarmupMinSeconds,
	}
	warmUp := wu.IsActive(now)

	// Resolve shift times.
	var shiftStart, shiftEnd time.Time
	if cfg.ShiftStartLocal != nil {
		shiftStart = *cfg.ShiftStartLocal
	}
	if cfg.ShiftEndLocal != nil {
		shiftEnd = *cfg.ShiftEndLocal
	}

	// 3. Decide.
	in := AdaptInput{
		Mode:             cfg.Mode,
		DropPct30d:       dropPct,
		AdaptiveDropPct:  cfg.AdaptiveDropPct,
		CurrentLevel:     currentLevel,
		AdaptiveMaxLevel: cfg.AdaptiveMaxLevel,
		Intensity:        cfg.Intensity,
		HoldBandPP:       cfg.HoldBandPP,
		LastIntegral:     ps.IntegralTerm,
		LastTickTs:       ps.LastTickTs,
		Now:              now,
		TickSeconds:      float64(cfg.AdaptTickSeconds),
		WarmUp:           warmUp,
		ShiftStart:       shiftStart,
		ShiftEnd:         shiftEnd,
	}
	out := Decide(in)

	// 4. Write dial_level if needed.
	if out.NeedsWrite {
		levelStr := strconv.FormatFloat(out.NewLevel, 'f', 2, 64)
		if err := rdb.Set(ctx, dialLevelKey(tid, cid), levelStr, 0).Err(); err != nil {
			slog.Error("adapt: SET dial_level failed", "err", err, "tenant", tid, "campaign", cid)
		}
	} else {
		m.NoopWriteTotal.With(lv).Inc()
	}

	// 5. Update pace_state.
	ps.IntegralTerm = out.NewIntegral
	ps.LastLevel = out.NewLevel
	ps.LastTickTs = now
	ps.LastDropPct = dropPct
	ps.LastAction = out.ActionTaken
	ps.TickCount++
	// Update warm-up calls remaining (unchanged on this path; DecrementCall is on event path).
	if !warmUp {
		ps.WarmUpCallsRemaining = 0
	}
	// Track clamp.
	atCeil := out.NewLevel >= cfg.AdaptiveMaxLevel
	atFloor := out.NewLevel <= LevelFloor
	if atCeil {
		if ps.ClampActiveSince.IsZero() {
			ps.ClampActiveSince = now
		}
		m.ClampActiveSeconds.With(prometheus.Labels{"tenant": lv["tenant"], "campaign": lv["campaign"], "side": "ceiling"}).Add(float64(cfg.AdaptTickSeconds))
	} else if atFloor {
		if ps.ClampActiveSince.IsZero() {
			ps.ClampActiveSince = now
		}
		m.ClampActiveSeconds.With(prometheus.Labels{"tenant": lv["tenant"], "campaign": lv["campaign"], "side": "floor"}).Add(float64(cfg.AdaptTickSeconds))
	} else {
		ps.ClampActiveSince = time.Time{}
	}

	if err := SavePaceState(ctx, rdb, tid, cid, ps); err != nil {
		slog.Error("adapt: save pace_state failed", "err", err, "tenant", tid, "campaign", cid)
	}

	// 6. XADD adapt_decisions stream.
	streamKey := adaptDecisionsKey(tid, cid)
	_ = rdb.XAdd(ctx, &redis.XAddArgs{
		Stream: streamKey,
		MaxLen: 5760,
		Values: map[string]any{
			"action":    out.ActionTaken,
			"new_level": out.NewLevel,
			"drop_pct":  dropPct,
			"integral":  out.NewIntegral,
			"reason":    out.Reason,
			"ts":        now.UnixMilli(),
			"warm_up":   warmUp,
		},
	}).Err()

	// 7. Prometheus metrics.
	elapsed := time.Since(start).Seconds()
	m.TickTotal.With(lv).Inc()
	m.TickDuration.With(lv).Observe(elapsed)
	m.ActionTotal.With(prometheus.Labels{"tenant": lv["tenant"], "campaign": lv["campaign"], "action": out.ActionTaken}).Inc()
	m.DialLevel.With(lv).Set(out.NewLevel)
	m.DropPct30d.With(lv).Set(dropPct)
	m.IntegralTerm.With(lv).Set(out.NewIntegral)

	wu2 := wu
	wu2.CallsRemaining = ps.WarmUpCallsRemaining
	if warmUp {
		m.WarmupActive.With(lv).Set(1)
		m.WarmupCallsRemaining.With(lv).Set(float64(ps.WarmUpCallsRemaining))
	} else {
		m.WarmupActive.With(lv).Set(0)
		m.WarmupCallsRemaining.With(lv).Set(0)
	}

	// Integral runaway check.
	if out.NewIntegral > IMax*1.5 || out.NewIntegral < -IMax*1.5 {
		m.IntegralRunaway.With(lv).Inc()
	}

	return true, nil
}

// loadPaceStateFromMap decodes a map[string]string HGETALL result.
func loadPaceStateFromMap(m map[string]string) (PaceState, bool, error) {
	ps := PaceState{
		IntegralTerm:         parseFloat(m[fieldIntegralTerm]),
		LastLevel:            parseFloat(m[fieldLastLevel]),
		LastDropPct:          parseFloat(m[fieldLastDropPct]),
		LastAction:           m[fieldLastAction],
		WarmUpCallsRemaining: parseInt(m[fieldWarmUpCallsRemaining]),
		TickCount:            parseInt64(m[fieldTickCount]),
	}
	ps.LastTickTs = parseUnixMs(m[fieldLastTickTs])
	ps.WarmUpStartedAt = parseUnixMs(m[fieldWarmUpStartedAt])
	ps.ClampActiveSince = parseUnixMs(m[fieldClampActiveSinceTs])
	return ps, true, nil
}
