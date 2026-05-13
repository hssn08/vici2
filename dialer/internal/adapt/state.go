// E03 is a clean-room Go port of Vicidial AST_VDadapt.pl (public GPL source,
// in source control since at least 2008 per inktel/Vicidial git history).
// Improvements: explicit anti-windup (back-calculation), deadband, drop_gated fast-cut.
// Prior art documented per SPEC patent-defense protocol.

package adapt

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

// Valkey HASH field names for pace_state (PLAN §10.1 — FROZEN).
const (
	fieldIntegralTerm         = "integral_term"
	fieldLastLevel            = "last_level"
	fieldLastTickTs           = "last_tick_ts"
	fieldLastDropPct          = "last_drop_pct"
	fieldLastAction           = "last_action"
	fieldWarmUpCallsRemaining = "warm_up_calls_remaining"
	fieldWarmUpStartedAt      = "warm_up_started_at"
	fieldClampActiveSinceTs   = "clamp_active_since_ts"
	fieldTickCount            = "tick_count"
)

// PaceState is the controller state persisted in Valkey HASH pace_state.
// All nine fields per PLAN §10.1.
type PaceState struct {
	IntegralTerm         float64
	LastLevel            float64
	LastTickTs           time.Time
	LastDropPct          float64
	LastAction           string
	WarmUpCallsRemaining int
	WarmUpStartedAt      time.Time
	ClampActiveSince     time.Time
	TickCount            int64
}

// paceStateKey returns the Valkey HASH key for campaign pace_state.
// PLAN §10.1: t:{tid}:campaign:{cid}:pace_state (hash tag {cid} for cluster colocation).
func paceStateKey(tid, cid int64) string {
	return fmt.Sprintf("t:%d:campaign:{%d}:pace_state", tid, cid)
}

// dialLevelKey returns the Valkey STRING key for dial_level.
func dialLevelKey(tid, cid int64) string {
	return fmt.Sprintf("t:%d:campaign:{%d}:dial_level", tid, cid)
}

// dropPct30dKey returns the Valkey STRING key for E05's drop_pct_30d.
func dropPct30dKey(tid, cid int64) string {
	return fmt.Sprintf("t:%d:campaign:{%d}:drop_pct_30d", tid, cid)
}

// dropGatedKey returns the Valkey STRING key for E05's drop_gated flag.
func dropGatedKey(tid, cid int64) string {
	return fmt.Sprintf("t:%d:campaign:{%d}:drop_gated", tid, cid)
}

// adaptLockKey returns the tick deduplication lock key (PLAN §4.2).
func adaptLockKey(tid, cid int64) string {
	return fmt.Sprintf("t:%d:adapt:lock:{%d}", tid, cid)
}

// fastcutLockKey returns the fast-cut coalescing lock key (PLAN §10.2).
func fastcutLockKey(tid, cid int64) string {
	return fmt.Sprintf("t:%d:adapt:fastcut:{%d}", tid, cid)
}

// adaptDecisionsKey returns the audit STREAM key for adapt decisions.
func adaptDecisionsKey(tid, cid int64) string {
	return fmt.Sprintf("t:%d:campaign:{%d}:adapt_decisions", tid, cid)
}

// broadcastCampaignKey returns the pubsub channel for campaign broadcast events.
func broadcastCampaignKey(tid, cid int64) string {
	return fmt.Sprintf("t:%d:broadcast:campaign:%d", tid, cid)
}

// LoadPaceState reads pace_state from Valkey HGETALL.
// Returns (zero-value, false, nil) when key absent (cold-start).
func LoadPaceState(ctx context.Context, rdb *redis.Client, tid, cid int64) (PaceState, bool, error) {
	key := paceStateKey(tid, cid)
	m, err := rdb.HGetAll(ctx, key).Result()
	if err != nil {
		return PaceState{}, false, fmt.Errorf("adapt: HGETALL %s: %w", key, err)
	}
	if len(m) == 0 {
		return PaceState{}, false, nil // cold-start
	}

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

// SavePaceState atomically writes all pace_state fields via HSET.
func SavePaceState(ctx context.Context, rdb *redis.Client, tid, cid int64, ps PaceState) error {
	key := paceStateKey(tid, cid)
	args := []any{
		fieldIntegralTerm, strconv.FormatFloat(ps.IntegralTerm, 'f', 6, 64),
		fieldLastLevel, strconv.FormatFloat(ps.LastLevel, 'f', 2, 64),
		fieldLastTickTs, fmtUnixMs(ps.LastTickTs),
		fieldLastDropPct, strconv.FormatFloat(ps.LastDropPct, 'f', 4, 64),
		fieldLastAction, ps.LastAction,
		fieldWarmUpCallsRemaining, strconv.Itoa(ps.WarmUpCallsRemaining),
		fieldWarmUpStartedAt, fmtUnixMs(ps.WarmUpStartedAt),
		fieldClampActiveSinceTs, fmtUnixMs(ps.ClampActiveSince),
		fieldTickCount, strconv.FormatInt(ps.TickCount, 10),
	}
	if err := rdb.HSet(ctx, key, args...).Err(); err != nil {
		return fmt.Errorf("adapt: HSET %s: %w", key, err)
	}
	return nil
}

// InitPaceState creates a fresh PaceState for a cold-start.
func InitPaceState(cfg Config, now time.Time) PaceState {
	startLevel := clamp(cfg.AutoDialLevel, LevelFloor, cfg.AdaptiveMaxLevel)
	return PaceState{
		IntegralTerm:         0,
		LastLevel:            startLevel,
		LastTickTs:           time.Time{},
		LastDropPct:          0,
		LastAction:           "warm_up",
		WarmUpCallsRemaining: cfg.WarmupMinAnswered,
		WarmUpStartedAt:      now,
		ClampActiveSince:     time.Time{},
		TickCount:            0,
	}
}

// --- codec helpers ---

func parseFloat(s string) float64 {
	if s == "" {
		return 0
	}
	v, _ := strconv.ParseFloat(s, 64)
	return v
}

func parseInt(s string) int {
	if s == "" {
		return 0
	}
	v, _ := strconv.Atoi(s)
	return v
}

func parseInt64(s string) int64 {
	if s == "" {
		return 0
	}
	v, _ := strconv.ParseInt(s, 10, 64)
	return v
}

func parseUnixMs(s string) time.Time {
	if s == "" || s == "0" {
		return time.Time{}
	}
	ms, err := strconv.ParseInt(s, 10, 64)
	if err != nil || ms == 0 {
		return time.Time{}
	}
	return time.UnixMilli(ms).UTC()
}

func fmtUnixMs(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return strconv.FormatInt(t.UnixMilli(), 10)
}
