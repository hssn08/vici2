// recovery.go — cold-start state reconstruction from Valkey.
//
// E05 PLAN §10.4: on process start, read drop_gated + drop_gate_engaged_at
// + fresh MySQL counts to reconstruct FSM state without trusting stale Valkey.
package drop_gate

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
	vkey "github.com/vici2/dialer/internal/valkey"
)

// Recover reconstructs the FSM state for gate from Valkey + MySQL at startup.
// It never trusts a stale Valkey gauge — always re-queries MySQL for the
// authoritative drop rate and publishes fresh Valkey gauges.
//
// E05 PLAN §10.4.
func Recover(ctx context.Context, gate *DropGate, db *sql.DB, rc *redis.Client) error {
	cfg := gate.cfg
	tid := strconv.FormatInt(cfg.TenantID, 10)
	cid := strconv.FormatInt(cfg.CampaignID, 10)
	keys := vkey.NewKeys(cfg.TenantID)

	slog.Info("drop_gate.recovery: starting cold-start recovery",
		slog.String("tenant", tid), slog.String("campaign", cid))

	// 1. Query MySQL (authoritative).
	numerator, denominator, err := queryMysqlRaw(ctx, db, cfg)
	if err != nil {
		return fmt.Errorf("recovery: MySQL query failed for campaign %s: %w", cid, err)
	}

	var dropPct float64
	if denominator >= WarmupDenominatorFloor && denominator > 0 {
		dropPct = 100.0 * float64(numerator) / float64(denominator)
	}

	// 2. Publish fresh gauges.
	if rc != nil {
		pipe := rc.Pipeline()
		pipe.Set(ctx, keys.CampaignDropPct30d(cfg.CampaignID),
			fmt.Sprintf("%.4f", dropPct), 0)
		pipe.Set(ctx, keys.CampaignDropCount30d(cfg.CampaignID),
			strconv.FormatInt(numerator, 10), 0)
		pipe.Set(ctx, keys.CampaignDropDenominator30d(cfg.CampaignID),
			strconv.FormatInt(denominator, 10), 0)
		if _, err := pipe.Exec(ctx); err != nil {
			slog.Warn("drop_gate.recovery: Valkey SET failed (non-fatal)", "err", err)
		}
	}

	// 3. Read drop_gated key + engaged_at.
	gated := false
	var engagedAt time.Time

	if rc != nil {
		exists, err := rc.Exists(ctx, keys.CampaignDropGated(cfg.CampaignID)).Result()
		if err != nil {
			slog.Warn("drop_gate.recovery: EXISTS drop_gated failed", "err", err)
		} else {
			gated = exists > 0
		}

		if gated {
			// Read engagement timestamp.
			tsStr, err := rc.Get(ctx, keys.CampaignDropGateEngagedAt(cfg.CampaignID)).Result()
			if err == nil {
				parsed, err := time.Parse(time.RFC3339, tsStr)
				if err == nil {
					engagedAt = parsed
				}
			}
			// Fallback: read from transitions STREAM.
			if engagedAt.IsZero() {
				engagedAt = readEngagedAtFromStream(ctx, rc, keys, cfg)
			}
			// Last resort: use now (conservative — dwell starts fresh).
			if engagedAt.IsZero() {
				engagedAt = time.Now()
				slog.Warn("drop_gate.recovery: engaged_at unknown; using now",
					slog.String("tenant", tid), slog.String("campaign", cid))
			}
		}
	}

	// 4. Reconstruct FSM state.
	effectiveMax := cfg.EffectiveMax()
	releaseThreshold := cfg.ReleaseThreshold()

	var recoveredState GateState
	switch {
	case dropPct >= effectiveMax || gated:
		// Hard breach: gate stays engaged; dwell tracking continues from engagedAt.
		recoveredState = StateHardBreach
		// Re-engage gate key if it was somehow absent (data race on restart).
		if rc != nil && !gated {
			rc.Set(ctx, keys.CampaignDropGated(cfg.CampaignID), "1", 0)
		}

	case gated && dropPct < releaseThreshold:
		// Dwell may have elapsed — apply check on first ticker tick.
		recoveredState = StateHardBreach // will release on first tick if dwell elapsed

	case dropPct >= cfg.DropTargetSoft:
		recoveredState = StateSoftBreach

	default:
		recoveredState = StateNormal
		// Clean up any stale drop_gated key.
		if rc != nil && gated {
			rc.Del(ctx, keys.CampaignDropGated(cfg.CampaignID))
		}
	}

	gate.SetStateForRecovery(recoveredState, engagedAt)

	slog.Info("drop_gate.recovery: state reconstructed",
		slog.String("tenant", tid), slog.String("campaign", cid),
		slog.String("state", string(recoveredState)),
		slog.Float64("drop_pct", dropPct),
		slog.Int64("numerator", numerator),
		slog.Int64("denominator", denominator),
		slog.Bool("was_gated", gated))

	return nil
}

// readEngagedAtFromStream attempts to recover the engage timestamp from the
// drop_gate_transitions STREAM by reading the last engage entry.
func readEngagedAtFromStream(ctx context.Context, rc *redis.Client, keys vkey.Keys, cfg CampaignConfig) time.Time {
	streamKey := keys.CampaignDropGateTransitions(cfg.CampaignID)
	msgs, err := rc.XRevRangeN(ctx, streamKey, "+", "-", 20).Result()
	if err != nil {
		return time.Time{}
	}
	for _, msg := range msgs {
		action, _ := msg.Values["action"].(string)
		if action != "engage" {
			continue
		}
		tsStr, _ := msg.Values["ts"].(string)
		if tsStr == "" {
			continue
		}
		t, err := time.Parse(time.RFC3339, tsStr)
		if err == nil {
			return t
		}
	}
	return time.Time{}
}

// queryMysqlRaw is the shared MySQL recompute used by both Ticker and Recovery.
func queryMysqlRaw(ctx context.Context, db *sql.DB, cfg CampaignConfig) (numerator, denominator int64, err error) {
	if db == nil {
		return 0, 0, nil
	}
	cidStr := strconv.FormatInt(cfg.CampaignID, 10)

	const qNumerator = `
		SELECT COUNT(*) FROM drop_log
		WHERE tenant_id   = ?
		  AND campaign_id = ?
		  AND dropped_at  >= NOW() - INTERVAL 30 DAY`

	if err = db.QueryRowContext(ctx, qNumerator, cfg.TenantID, cidStr).Scan(&numerator); err != nil {
		return 0, 0, fmt.Errorf("numerator: %w", err)
	}

	// Denominator MUST JOIN statuses WHERE human_answered=TRUE (CI-enforced).
	const qDenominator = `
		SELECT COUNT(*) FROM call_log c
		JOIN statuses s
		  ON c.tenant_id = s.tenant_id
		 AND c.status    = s.status
		WHERE c.tenant_id    = ?
		  AND c.campaign_id  = ?
		  AND c.call_started >= NOW() - INTERVAL 30 DAY
		  AND s.human_answered = TRUE`

	if err = db.QueryRowContext(ctx, qDenominator, cfg.TenantID, cidStr).Scan(&denominator); err != nil {
		return 0, 0, fmt.Errorf("denominator: %w", err)
	}
	return numerator, denominator, nil
}
