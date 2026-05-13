// E03 is a clean-room Go port of Vicidial AST_VDadapt.pl (public GPL source,
// in source control since at least 2008 per inktel/Vicidial git history).
// Improvements: explicit anti-windup (back-calculation), deadband, drop_gated fast-cut.
// Prior art documented per SPEC patent-defense protocol.

package adapt

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/redis/go-redis/v9"
)

// fastCutEvent is the JSON payload from E05's drop_gated_changed pubsub.
type fastCutEvent struct {
	Event string `json:"event"`
	Gated bool   `json:"gated"`
}

// FastCutter handles event-driven fast-cut for one campaign.
// Registered as a subscriber on the campaign's broadcast channel.
type FastCutter struct {
	tid, cid     int64
	rdb          *redis.Client
	m            *Metrics
	debounce     time.Duration
	lastCut      time.Time
	flapTimes    []time.Time  // ring buffer for flap detection (last 60s)
	flapDebounce time.Time    // extended debounce on flap detection
}

// NewFastCutter creates a FastCutter for the given campaign.
func NewFastCutter(tid, cid int64, rdb *redis.Client, m *Metrics, debounceSec int) *FastCutter {
	if debounceSec <= 0 {
		debounceSec = 30
	}
	return &FastCutter{
		tid:      tid,
		cid:      cid,
		rdb:      rdb,
		m:        m,
		debounce: time.Duration(debounceSec) * time.Second,
	}
}

// HandleMessage processes a pubsub message. Blocks for ≤50 ms on Valkey ops.
// Only acts on event="drop_gated_changed" with gated=true.
func (fc *FastCutter) HandleMessage(ctx context.Context, payload string) {
	var ev fastCutEvent
	if err := json.Unmarshal([]byte(payload), &ev); err != nil {
		return // not JSON; ignore
	}
	if ev.Event != "drop_gated_changed" || !ev.Gated {
		return // only act on gated=true
	}

	lv := Labels(fc.tid, fc.cid)
	now := time.Now()

	// Flap detection: count flips in last 60s.
	fc.pruneFlaps(now)
	fc.flapTimes = append(fc.flapTimes, now)
	if len(fc.flapTimes) > 3 {
		// >3 flips/min → extended debounce.
		fc.flapDebounce = now.Add(5 * time.Minute)
		fc.m.DropGatedFlap.With(lv).Inc()
		slog.Warn("adapt: drop_gated flap detected; extended debounce 5m",
			"tenant", fc.tid, "campaign", fc.cid)
	}

	// Check debounce.
	effectiveDebounce := fc.debounce
	if now.Before(fc.flapDebounce) {
		effectiveDebounce = time.Until(fc.flapDebounce)
	}
	if !fc.lastCut.IsZero() && now.Sub(fc.lastCut) < effectiveDebounce {
		fc.m.DropGatedDebounce.With(lv).Inc()
		return
	}

	// Acquire fast-cut lock (coalesce multi-pod).
	lockKey := fastcutLockKey(fc.tid, fc.cid)
	ok, err := fc.rdb.SetNX(ctx, lockKey, "1", 5*time.Second).Result()
	if err != nil || !ok {
		return // another pod is cutting; skip
	}

	// Read current dial_level.
	dlKey := dialLevelKey(fc.tid, fc.cid)
	cur, err := fc.rdb.Get(ctx, dlKey).Result()
	if err == nil && cur == "1.00" {
		return // already at floor; no-op
	}

	// Write dial_level = 1.0.
	if err := fc.rdb.Set(ctx, dlKey, "1.00", 0).Err(); err != nil {
		slog.Error("adapt: fast-cut SET dial_level failed", "err", err,
			"tenant", fc.tid, "campaign", fc.cid)
		return
	}

	// Update pace_state.
	psKey := paceStateKey(fc.tid, fc.cid)
	_ = fc.rdb.HSet(ctx, psKey,
		fieldIntegralTerm, "0",
		fieldLastAction, "fast_cut",
		fieldLastLevel, "1.00",
		fieldLastTickTs, fmtUnixMs(now),
	).Err()

	// Append to adapt_decisions stream.
	streamKey := adaptDecisionsKey(fc.tid, fc.cid)
	_ = fc.rdb.XAdd(ctx, &redis.XAddArgs{
		Stream: streamKey,
		MaxLen: 5760,
		Values: map[string]any{
			"action":       "fast_cut",
			"new_level":    "1.00",
			"reason":       fmt.Sprintf("drop_gated_changed gated=true at %s", now.Format(time.RFC3339)),
			"ts":           now.UnixMilli(),
		},
	}).Err()

	fc.m.FastCutTotal.With(lv).Inc()
	fc.m.DialLevel.With(lv).Set(1.0)
	fc.lastCut = now

	slog.Info("adapt: fast-cut fired", "tenant", fc.tid, "campaign", fc.cid, "ts", now)
}

// pruneFlaps removes flap timestamps older than 60s.
func (fc *FastCutter) pruneFlaps(now time.Time) {
	cutoff := now.Add(-60 * time.Second)
	i := 0
	for _, t := range fc.flapTimes {
		if t.After(cutoff) {
			fc.flapTimes[i] = t
			i++
		}
	}
	fc.flapTimes = fc.flapTimes[:i]
}
