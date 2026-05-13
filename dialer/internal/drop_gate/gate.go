// gate.go — DropGate implementation: in-process FSM + Valkey gate publisher.
//
// E05 PLAN §7 (state machine), §6 (action mapping), §13.1 (public interface).
// One DropGate per active campaign; goroutine-safe via embedded mutex.
package drop_gate

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"strconv"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
	vkey "github.com/vici2/dialer/internal/valkey"
)

// DropReason classifies why a call was abandoned.
// E05 PLAN §8.5 + F02 amendment §9.3.
type DropReason string

const (
	DropReasonNoAgent             DropReason = "no_agent"
	DropReasonTimeout             DropReason = "timeout"
	DropReasonQueueFull           DropReason = "queue_full"
	DropReasonCustomerHangupEarly DropReason = "customer_hangup_early"
	DropReasonAudioMissing        DropReason = "audio_missing"
	DropReasonSoftwareError       DropReason = "software_error"
)

// AllDropReasons returns all valid DropReason values (exhaustiveness check).
func AllDropReasons() []DropReason {
	return []DropReason{
		DropReasonNoAgent,
		DropReasonTimeout,
		DropReasonQueueFull,
		DropReasonCustomerHangupEarly,
		DropReasonAudioMissing,
		DropReasonSoftwareError,
	}
}

// GateState is the FSM state for a campaign.
// E05 PLAN §7.1.
type GateState string

const (
	StateNormal     GateState = "NORMAL"
	StateSoftBreach GateState = "SOFT_BREACH"
	StateHardBreach GateState = "HARD_BREACH"
)

// DropEvent describes a single abandonment event.
// E05 PLAN §13.1.
type DropEvent struct {
	CallUUID     string
	CampaignID   int64
	TenantID     int64
	DropReason   DropReason
	SafeHarborOK bool
	OccurredAt   time.Time
}

// AlertFunc is called by the gate to send operator notifications.
// Severity: "WARN" | "PAGE".
type AlertFunc func(ctx context.Context, severity, message string, tenantID, campaignID int64)

// AuditFunc writes a force-release event to the C03 audit log.
type AuditFunc func(ctx context.Context, actorID, campaignID, tenantID int64, reason string, dropPct float64, engagedSecs float64)

// DropGate manages the per-campaign FCC 3% drop-rate gate.
// One instance per active campaign; goroutine-safe.
type DropGate struct {
	cfg  CampaignConfig
	keys vkey.Keys
	rc   *redis.Client
	db   *sql.DB
	m    *Metrics

	alert AlertFunc
	audit AuditFunc

	mu              sync.Mutex
	state           GateState
	engagedAt       time.Time // zero when not HARD_BREACH
	lastSoftAlert   time.Time
	lastPdropAlert  time.Time
	lastHardAlert   time.Time

	// PDROP alert deduplication: 1 page per campaign per 10-minute window.
	pdropAlertWindowStart time.Time
	pdropAlertsInWindow   int
}

// New constructs a DropGate for one campaign. cfg must pass Validate().
// Pass nil db/m in unit tests.
func New(
	cfg CampaignConfig,
	rc *redis.Client,
	db *sql.DB,
	m *Metrics,
	alertFn AlertFunc,
	auditFn AuditFunc,
) (*DropGate, error) {
	cfg = cfg.ApplyDefaults()
	if err := cfg.Validate(); err != nil {
		if m != nil {
			tid := strconv.FormatInt(cfg.TenantID, 10)
			cid := strconv.FormatInt(cfg.CampaignID, 10)
			m.InvalidConfigTotal.WithLabelValues(tid, cid, "threshold").Inc()
		}
		return nil, fmt.Errorf("drop_gate.New: %w", err)
	}
	return &DropGate{
		cfg:   cfg,
		keys:  vkey.NewKeys(cfg.TenantID),
		rc:    rc,
		db:    db,
		m:     m,
		alert: alertFn,
		audit: auditFn,
		state: StateNormal,
	}, nil
}

// State returns the current FSM state (goroutine-safe).
func (g *DropGate) State() GateState {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.state
}

// Tick is called by the 15-s ticker goroutine. It receives the freshly computed
// drop_pct and denominator from the ticker, applies the FSM, fires alerts,
// and writes Valkey. Returns the current state after transition.
//
// E05 PLAN §7.2 — all 6 FSM transitions.
func (g *DropGate) Tick(ctx context.Context, dropPct float64, denominator int64, tickInterval time.Duration) (GateState, error) {
	g.mu.Lock()
	defer g.mu.Unlock()

	tid := strconv.FormatInt(g.cfg.TenantID, 10)
	cid := strconv.FormatInt(g.cfg.CampaignID, 10)

	// Warmup floor: skip transitions if denominator < 100.
	if denominator < WarmupDenominatorFloor {
		if g.m != nil {
			g.m.WarmupCampaigns.WithLabelValues(tid).Set(1)
		}
		slog.Debug("drop_gate: warmup floor; skipping transitions",
			slog.String("tenant", tid), slog.String("campaign", cid),
			slog.Int64("denominator", denominator))
		return g.state, nil
	}
	if g.m != nil {
		g.m.WarmupCampaigns.WithLabelValues(tid).Set(0)
	}

	effectiveMax := g.cfg.EffectiveMax()
	releaseThreshold := g.cfg.ReleaseThreshold()
	softReturn := g.cfg.SoftReturnThreshold()

	prevState := g.state
	now := time.Now()

	switch g.state {
	case StateNormal:
		if dropPct >= effectiveMax {
			g.transitionToHardBreach(ctx, dropPct, "auto", now)
		} else if dropPct >= g.cfg.DropTargetSoft {
			g.transitionToSoftBreach(ctx, dropPct, now)
		}

	case StateSoftBreach:
		if dropPct >= effectiveMax {
			g.transitionToHardBreach(ctx, dropPct, "auto", now)
		} else if dropPct < softReturn {
			g.transitionToNormal(ctx, dropPct, "auto")
		}

	case StateHardBreach:
		elapsed := now.Sub(g.engagedAt)
		recoverDuration := time.Duration(g.cfg.RecoverSeconds) * time.Second
		if dropPct < releaseThreshold && elapsed >= recoverDuration {
			// Release gate; decide target state.
			if dropPct < softReturn {
				g.transitionToNormal(ctx, dropPct, "auto")
			} else {
				g.transitionToSoftBreach(ctx, dropPct, now)
			}
		}
	}

	// Accumulate breach-seconds metrics.
	if g.m != nil {
		secs := tickInterval.Seconds()
		switch g.state {
		case StateSoftBreach:
			g.m.DropSoftCapBreachedSeconds.WithLabelValues(tid, cid).Add(secs)
		case StateHardBreach:
			g.m.DropHardCapBreachedSeconds.WithLabelValues(tid, cid).Add(secs)
			g.m.DropGateSecondsEngagedTotal.WithLabelValues(tid, cid).Add(secs)
		}
		g.m.DropGateEngaged.WithLabelValues(tid, cid).Set(boolToFloat(g.state == StateHardBreach))
		g.m.DropRatePct.WithLabelValues(tid, cid).Set(dropPct)
	}

	if g.state != prevState {
		slog.Info("drop_gate: state transition",
			slog.String("tenant", tid), slog.String("campaign", cid),
			slog.String("from", string(prevState)), slog.String("to", string(g.state)),
			slog.Float64("drop_pct", dropPct))
	}
	return g.state, nil
}

// RecordDrop is called by the ESL handler (notification only; MySQL writes happen
// in the ESL handler). E05 PLAN §13.1.
func (g *DropGate) RecordDrop(ctx context.Context, evt DropEvent) error {
	tid := strconv.FormatInt(evt.TenantID, 10)
	cid := strconv.FormatInt(evt.CampaignID, 10)

	shp := strconv.FormatBool(evt.SafeHarborOK)
	if g.m != nil {
		g.m.DropsTotal.WithLabelValues(tid, cid, string(evt.DropReason), shp).Inc()
	}

	if !evt.SafeHarborOK {
		if g.m != nil {
			g.m.PdropTotal.WithLabelValues(tid, cid, string(evt.DropReason)).Inc()
			g.m.SafeHarborAudioPlayFailedTotal.WithLabelValues(tid, cid).Inc()
		}
		g.maybePdropAlert(ctx, evt)
	}
	return nil
}

// ForceRelease releases the drop gate immediately regardless of dwell.
// Requires operatorID for audit log. E05 PLAN §13.1.
func (g *DropGate) ForceRelease(ctx context.Context, operatorID int64, reason string) error {
	g.mu.Lock()
	defer g.mu.Unlock()

	if g.state != StateHardBreach {
		return fmt.Errorf("drop_gate: gate is not engaged (state=%s)", g.state)
	}

	dropPct := g.lastKnownDropPct(ctx)
	engagedSecs := time.Since(g.engagedAt).Seconds()

	g.transitionToNormal(ctx, dropPct, "operator")

	if g.audit != nil {
		g.audit(ctx, operatorID, g.cfg.CampaignID, g.cfg.TenantID, reason, dropPct, engagedSecs)
	}

	tid := strconv.FormatInt(g.cfg.TenantID, 10)
	cid := strconv.FormatInt(g.cfg.CampaignID, 10)
	slog.Info("drop_gate: operator force-release",
		slog.String("tenant", tid), slog.String("campaign", cid),
		slog.Int64("operator_id", operatorID),
		slog.String("reason", reason),
		slog.Float64("drop_pct", dropPct),
		slog.Float64("engaged_seconds", engagedSecs))

	return nil
}

// SetStateForRecovery directly sets the FSM state and engagedAt during cold-start
// recovery. Called by recovery.go after reading Valkey on startup.
func (g *DropGate) SetStateForRecovery(state GateState, engagedAt time.Time) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.state = state
	g.engagedAt = engagedAt
}

// EngagedAt returns when the gate was last engaged (zero if not in HARD_BREACH).
func (g *DropGate) EngagedAt() time.Time {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.engagedAt
}

// ---- internal transitions ----

func (g *DropGate) transitionToHardBreach(ctx context.Context, dropPct float64, source string, now time.Time) {
	g.state = StateHardBreach
	g.engagedAt = now

	tid := strconv.FormatInt(g.cfg.TenantID, 10)
	cid := strconv.FormatInt(g.cfg.CampaignID, 10)
	cidInt := g.cfg.CampaignID

	// Write Valkey gate key (no TTL — sticky until DEL).
	if g.rc != nil {
		if err := g.rc.Set(ctx, g.keys.CampaignDropGated(cidInt), "1", 0).Err(); err != nil {
			slog.Error("drop_gate: failed to SET drop_gated", "err", err,
				slog.String("tenant", tid), slog.String("campaign", cid))
		}
		ts := now.UTC().Format(time.RFC3339)
		if err := g.rc.Set(ctx, g.keys.CampaignDropGateEngagedAt(cidInt), ts, 0).Err(); err != nil {
			slog.Warn("drop_gate: failed to SET drop_gate_engaged_at", "err", err)
		}
		g.appendTransitionStream(ctx, cidInt, "engage", dropPct, source, 0, "")
	}

	// Prometheus.
	if g.m != nil {
		g.m.DropGateEngagementsTotal.WithLabelValues(tid, cid, source).Inc()
	}

	// PAGE alert (deduplication: 1 page per campaign per 10 min).
	if g.alert != nil && time.Since(g.lastHardAlert) > 10*time.Minute {
		g.alert(ctx, "PAGE",
			fmt.Sprintf("drop-gate ENGAGED: campaign %d drop_pct=%.2f%% >= hard_cap=%.2f%%",
				cidInt, dropPct, g.cfg.EffectiveMax()),
			g.cfg.TenantID, cidInt)
		g.lastHardAlert = time.Now()
	}

	// Broadcast pubsub event.
	if g.rc != nil {
		payload, _ := json.Marshal(map[string]any{
			"event":    "drop_gate_engaged",
			"drop_pct": dropPct,
			"ts":       now.UTC().Format(time.RFC3339),
		})
		g.rc.Publish(ctx, g.keys.BroadcastCampaign(cidInt), payload)
	}
}

func (g *DropGate) transitionToSoftBreach(ctx context.Context, dropPct float64, now time.Time) {
	g.state = StateSoftBreach
	g.engagedAt = time.Time{} // reset dwell timer

	tid := strconv.FormatInt(g.cfg.TenantID, 10)
	cid := strconv.FormatInt(g.cfg.CampaignID, 10)
	cidInt := g.cfg.CampaignID

	// WARN alert (deduplication: 1 page per campaign per 60 min).
	if g.alert != nil && time.Since(g.lastSoftAlert) > 60*time.Minute {
		g.alert(ctx, "WARN",
			fmt.Sprintf("drop-rate SOFT_BREACH: campaign %d drop_pct=%.2f%% >= soft_cap=%.2f%%",
				cidInt, dropPct, g.cfg.DropTargetSoft),
			g.cfg.TenantID, cidInt)
		g.lastSoftAlert = now
	}

	// Broadcast pubsub event.
	if g.rc != nil {
		payload, _ := json.Marshal(map[string]any{
			"event":    "soft_breach",
			"drop_pct": dropPct,
		})
		g.rc.Publish(ctx, g.keys.BroadcastCampaign(cidInt), payload)
	}

	if g.m != nil {
		_ = tid // labels used in Tick(); referenced here for completeness
		_ = cid
	}
}

func (g *DropGate) transitionToNormal(ctx context.Context, dropPct float64, source string) {
	prevState := g.state
	g.state = StateNormal
	g.engagedAt = time.Time{}

	tid := strconv.FormatInt(g.cfg.TenantID, 10)
	cid := strconv.FormatInt(g.cfg.CampaignID, 10)
	cidInt := g.cfg.CampaignID

	// DEL drop_gated key (only if we were HARD_BREACH).
	if prevState == StateHardBreach && g.rc != nil {
		if err := g.rc.Del(ctx, g.keys.CampaignDropGated(cidInt)).Err(); err != nil {
			slog.Error("drop_gate: failed to DEL drop_gated", "err", err,
				slog.String("tenant", tid), slog.String("campaign", cid))
		}
		if err := g.rc.Del(ctx, g.keys.CampaignDropGateEngagedAt(cidInt)).Err(); err != nil {
			slog.Warn("drop_gate: failed to DEL drop_gate_engaged_at", "err", err)
		}
		g.appendTransitionStream(ctx, cidInt, "release", dropPct, source, 0, "")
	}

	if g.m != nil {
		if prevState == StateHardBreach {
			g.m.DropGateReleasesTotal.WithLabelValues(tid, cid, source).Inc()
		}
		g.m.DropGateEngaged.WithLabelValues(tid, cid).Set(0)
	}
}

// appendTransitionStream adds a {action, drop_pct, source, ts} entry to the
// drop_gate_transitions STREAM and inserts a row in MySQL drop_gate_transition_log.
func (g *DropGate) appendTransitionStream(ctx context.Context, cidInt int64, action string, dropPct float64, source string, operatorID int64, reason string) {
	if g.rc == nil {
		return
	}
	now := time.Now().UTC()
	values := map[string]any{
		"action":   action,
		"drop_pct": fmt.Sprintf("%.2f", dropPct),
		"source":   source,
		"ts":       now.Format(time.RFC3339),
	}
	if operatorID != 0 {
		values["operator_id"] = strconv.FormatInt(operatorID, 10)
	}
	if reason != "" {
		values["reason"] = reason
	}

	streamKey := g.keys.CampaignDropGateTransitions(cidInt)
	if err := g.rc.XAdd(ctx, &redis.XAddArgs{
		Stream: streamKey,
		Values: values,
	}).Err(); err != nil {
		slog.Warn("drop_gate: XADD drop_gate_transitions failed", "err", err)
	}

	// MySQL durable write (background; non-fatal on error).
	if g.db != nil {
		go g.insertTransitionLog(context.Background(), cidInt, action, dropPct, source, operatorID, reason, now)
	}
}

func (g *DropGate) insertTransitionLog(ctx context.Context, cidInt int64, action string, dropPct float64, source string, operatorID int64, reason string, occurredAt time.Time) {
	var opID *int64
	if operatorID != 0 {
		opID = &operatorID
	}
	var reasonPtr *string
	if reason != "" {
		reasonPtr = &reason
	}
	const q = `INSERT INTO drop_gate_transition_log
		(tenant_id, campaign_id, action, drop_pct, source, operator_id, reason, occurred_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	if _, err := g.db.ExecContext(ctx, q,
		g.cfg.TenantID,
		strconv.FormatInt(cidInt, 10),
		action,
		fmt.Sprintf("%.2f", dropPct),
		source,
		opID,
		reasonPtr,
		occurredAt,
	); err != nil {
		slog.Error("drop_gate: insertTransitionLog failed", "err", err)
	}
}

// maybePdropAlert pages operator on PDROP with 10-minute deduplication.
// E05 PLAN §7, AC-05.
func (g *DropGate) maybePdropAlert(ctx context.Context, evt DropEvent) {
	if g.alert == nil {
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()

	now := time.Now()
	if now.Sub(g.pdropAlertWindowStart) > 10*time.Minute {
		g.pdropAlertWindowStart = now
		g.pdropAlertsInWindow = 0
	}
	if g.pdropAlertsInWindow == 0 {
		g.alert(ctx, "PAGE",
			fmt.Sprintf("PDROP: campaign %d call %s safe_harbor NOT played (reason=%s) — per-call § 64.1200(a)(7) violation",
				evt.CampaignID, evt.CallUUID, evt.DropReason),
			evt.TenantID, evt.CampaignID)
	}
	g.pdropAlertsInWindow++
}

// lastKnownDropPct reads drop_pct_30d from Valkey. Returns 0 on error.
func (g *DropGate) lastKnownDropPct(ctx context.Context) float64 {
	if g.rc == nil {
		return 0
	}
	v, err := g.rc.Get(ctx, g.keys.CampaignDropPct30d(g.cfg.CampaignID)).Result()
	if err != nil {
		return 0
	}
	pct, _ := strconv.ParseFloat(v, 64)
	return pct
}

func boolToFloat(b bool) float64 {
	if b {
		return 1
	}
	return 0
}
