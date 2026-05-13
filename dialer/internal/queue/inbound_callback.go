// I04 — Inbound Callback Queue: dispatcher extension.
//
// This file extends the I01 DispatcherLoop with the ability to fire INBOUND
// callbacks when the live queue is empty and an agent is READY.
//
// Key functions:
//   tryFireInboundCallback  — called from runDispatchCycle when queue is empty
//   fetchNextInboundCallback — DB query respecting preserve-position ordering
//   fireInboundCallback      — TCPA gate + Valkey lock + originate
//   promoteInboundCallback   — atomic PENDING → LIVE transition + audit
//   deferInboundCallback     — re-snooze to TCPA nextOpen
//   handleNoAnswerInbound    — policy-based no-answer handling

package queue

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

// InboundCallback is the dispatcher's view of a PENDING INBOUND callback row.
type InboundCallback struct {
	ID                   int64
	LeadID               int64
	CallbackNumber       sql.NullString
	LeadPhone            sql.NullString
	QueuePositionAtOffer sql.NullInt32
	OriginalWaitSeconds  sql.NullInt32
	OriginalIngroupID    sql.NullString
	CreatedAt            time.Time
}

// I04CallbackFireLockKey returns the Valkey key for the per-callback fire idempotency lock.
func (k QueueKeys) I04CallbackFireLock(callbackID int64) string {
	return fmt.Sprintf("t:%d:i04:cb_fire_lock:%d", k.tid, callbackID)
}

// tryFireInboundCallback is called from runDispatchCycle when the live queue is empty.
// I04 PLAN §5.1.
func (d *DispatcherLoop) tryFireInboundCallback(ctx context.Context, agent *Agent) error {
	ig := d.cfg.InGroup
	if d.cfg.DB == nil {
		return nil // no DB configured (test environments without MySQL)
	}

	// Only fire callbacks when live queue is empty (live calls take priority)
	queueSize, err := d.cfg.Rdb.ZCard(ctx, d.cfg.Keys.IngroupQueue(ig.ID)).Result()
	if err != nil {
		return fmt.Errorf("i04: ZCard ingroup queue: %w", err)
	}
	if queueSize > 0 {
		return nil // live calls take priority
	}

	// Fetch next pending INBOUND callback for this ingroup
	cb, err := d.fetchNextInboundCallback(ctx)
	if err != nil {
		return fmt.Errorf("i04: fetchNextInboundCallback: %w", err)
	}
	if cb == nil {
		return nil // no pending INBOUND callbacks
	}

	// Acquire per-callback fire lock (idempotency — prevents double originate)
	// I04 PLAN §5.1 + RESEARCH §8.4
	lockKey := d.cfg.Keys.I04CallbackFireLock(cb.ID)
	locked, err := d.cfg.Rdb.SetNX(ctx, lockKey, d.cfg.PodID, 120*time.Second).Result()
	if err != nil {
		return fmt.Errorf("i04: SetNX fire lock: %w", err)
	}
	if !locked {
		// Another pod is already firing this callback
		d.cfg.Metrics.I04LockContention.WithLabelValues(ig.ID).Inc()
		d.log.Debug("i04: lock contention on callback fire", "callback_id", cb.ID, "ingroup", ig.ID)
		return nil
	}
	// Lock will expire in 120s; we also release it after fire completes/fails

	if err := d.fireInboundCallback(ctx, agent, cb, lockKey); err != nil {
		d.log.Error("i04: fireInboundCallback", "callback_id", cb.ID, "err", err)
		// Release lock on error so another pod can retry
		d.cfg.Rdb.Del(ctx, lockKey)
		return err
	}

	return nil
}

// fetchNextInboundCallback queries the DB for the next PENDING INBOUND callback.
// Priority:
//  1. Position-based (queue_position_at_offer IS NOT NULL, within expiry window)
//  2. Any PENDING INBOUND (position expired or IVR path with no position)
//
// I04 PLAN §5.2.
func (d *DispatcherLoop) fetchNextInboundCallback(ctx context.Context) (*InboundCallback, error) {
	if d.cfg.DB == nil {
		return nil, nil
	}
	ig := d.cfg.InGroup
	now := time.Now()

	// Default position expiry: 60 minutes (from InGroup config)
	positionExpiryMinutes := 60
	if ig.CallbackPositionExpiryMinutes > 0 {
		positionExpiryMinutes = ig.CallbackPositionExpiryMinutes
	}
	positionExpiryThreshold := now.Add(-time.Duration(positionExpiryMinutes) * time.Minute)

	// Priority 1: position-based (within expiry window)
	const q1 = `
		SELECT c.id, c.lead_id, c.callback_number, l.phone, c.queue_position_at_offer,
		       c.original_wait_seconds, c.original_ingroup_id, c.created_at
		FROM callbacks c
		LEFT JOIN leads l ON l.id = c.lead_id
		WHERE c.tenant_id = ?
		  AND c.original_ingroup_id = ?
		  AND c.source = 'INBOUND'
		  AND c.status = 'PENDING'
		  AND c.callback_at <= ?
		  AND c.queue_position_at_offer IS NOT NULL
		  AND c.created_at >= ?
		ORDER BY c.queue_position_at_offer ASC, c.created_at ASC
		LIMIT 1`

	cb, err := d.queryRowCallback(ctx, q1, ig.TenantID, ig.ID, now, positionExpiryThreshold)
	if err != nil {
		return nil, err
	}
	if cb != nil {
		return cb, nil
	}

	// Priority 2: any PENDING INBOUND (position expired or IVR path)
	const q2 = `
		SELECT c.id, c.lead_id, c.callback_number, l.phone, c.queue_position_at_offer,
		       c.original_wait_seconds, c.original_ingroup_id, c.created_at
		FROM callbacks c
		LEFT JOIN leads l ON l.id = c.lead_id
		WHERE c.tenant_id = ?
		  AND c.original_ingroup_id = ?
		  AND c.source = 'INBOUND'
		  AND c.status = 'PENDING'
		  AND c.callback_at <= ?
		ORDER BY c.created_at ASC
		LIMIT 1`

	return d.queryRowCallback(ctx, q2, ig.TenantID, ig.ID, now)
}

// queryRowCallback is a helper that scans one callback row from the given query.
func (d *DispatcherLoop) queryRowCallback(ctx context.Context, q string, args ...interface{}) (*InboundCallback, error) {
	row := d.cfg.DB.QueryRowContext(ctx, q, args...)
	cb := &InboundCallback{}
	err := row.Scan(
		&cb.ID,
		&cb.LeadID,
		&cb.CallbackNumber,
		&cb.LeadPhone,
		&cb.QueuePositionAtOffer,
		&cb.OriginalWaitSeconds,
		&cb.OriginalIngroupID,
		&cb.CreatedAt,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("queryRowCallback: %w", err)
	}
	return cb, nil
}

// fireInboundCallback applies the TCPA gate then originates the outbound call.
// I04 PLAN §5.3.
func (d *DispatcherLoop) fireInboundCallback(ctx context.Context, agent *Agent, cb *InboundCallback, lockKey string) error {
	ig := d.cfg.InGroup

	// Resolve the dial number: callback_number first, fall back to lead.phone
	dialNumber := ""
	if cb.CallbackNumber.Valid && cb.CallbackNumber.String != "" {
		dialNumber = cb.CallbackNumber.String
	} else if cb.LeadPhone.Valid {
		dialNumber = cb.LeadPhone.String
	}
	if dialNumber == "" {
		d.log.Warn("i04: no dial number for callback; skipping", "callback_id", cb.ID)
		d.cfg.Rdb.Del(ctx, lockKey)
		return nil
	}

	// Phase 1: TCPA stub — always ALLOW.
	// C01 IMPLEMENT will wire the real callback_fire enforcement point.
	tcpaOutcome := "ALLOW"

	switch tcpaOutcome {
	case "SKIP_UNTIL":
		// Re-snooze callback to next TCPA window
		nextOpen := time.Now().Add(8 * time.Hour) // Phase 1 stub
		if err := d.deferInboundCallback(ctx, cb, ig.ID, nextOpen); err != nil {
			return err
		}
		d.cfg.Rdb.Del(ctx, lockKey)
		return nil

	case "ALLOW":
		// Originate outbound call to customer
		fromCLI := ig.OutboundCli
		if fromCLI == "" {
			fromCLI = d.cfg.TenantDefaultCLI
		}

		if err := d.originateInboundCallback(ctx, ig, agent, cb, dialNumber, fromCLI, tcpaOutcome); err != nil {
			return err
		}

		// Promote PENDING → LIVE
		if err := d.promoteInboundCallback(ctx, ig, agent, cb, tcpaOutcome); err != nil {
			// Release lock on promotion failure
			d.cfg.Rdb.Del(ctx, lockKey)
			return err
		}

		// Release lock after successful promotion
		d.cfg.Rdb.Del(ctx, lockKey)

		d.cfg.Metrics.I04CallbackFired.WithLabelValues(ig.ID, tcpaOutcome).Inc()
		d.log.Info("i04: inbound callback fired",
			"callback_id", cb.ID,
			"ingroup", ig.ID,
			"agent_user_id", agent.UserID,
			"dial_number", dialNumber,
		)
	}

	return nil
}

// originateInboundCallback publishes an originate event to the Valkey stream
// that the ESL bridge picks up to initiate the outbound call.
// In full production this would call T04 Originator interface.
// Phase 1: publishes to events:vici2.i04.originate (ESL bridge subscribes).
func (d *DispatcherLoop) originateInboundCallback(
	ctx context.Context,
	ig *InGroup,
	agent *Agent,
	cb *InboundCallback,
	dialNumber, fromCLI, tcpaOutcome string,
) error {
	type originateEvent struct {
		Type               string `json:"type"`
		TenantID           int64  `json:"tenant_id"`
		CallbackID         int64  `json:"callback_id"`
		AgentUserID        int64  `json:"agent_user_id"`
		ToNumber           string `json:"to_number"`
		FromNumber         string `json:"from_number"`
		IngroupID          string `json:"ingroup_id"`
		Direction          string `json:"direction"`
		ConsentMode        string `json:"consent_mode"`
		SkipInternalDNC    bool   `json:"skip_internal_dnc"`
		SkipNationalDNC    bool   `json:"skip_national_dnc"`
		OriginalWaitSec    *int32 `json:"original_wait_seconds,omitempty"`
		QueuePositionAtOffer *int32 `json:"queue_position_at_offer,omitempty"`
	}

	var waitSec *int32
	if cb.OriginalWaitSeconds.Valid {
		v := cb.OriginalWaitSeconds.Int32
		waitSec = &v
	}
	var queuePos *int32
	if cb.QueuePositionAtOffer.Valid {
		v := cb.QueuePositionAtOffer.Int32
		queuePos = &v
	}

	evt := originateEvent{
		Type:             "i04_originate",
		TenantID:         ig.TenantID,
		CallbackID:       cb.ID,
		AgentUserID:      agent.UserID,
		ToNumber:         dialNumber,
		FromNumber:       fromCLI,
		IngroupID:        ig.ID,
		Direction:        "inbound_callback",
		ConsentMode:      "INBOUND_CALLBACK_REQUESTED",
		SkipInternalDNC:  true,  // express consent overrides internal DNC
		SkipNationalDNC:  false, // National DNC is NEVER bypassed
		OriginalWaitSec:  waitSec,
		QueuePositionAtOffer: queuePos,
	}

	payload, err := json.Marshal(evt)
	if err != nil {
		return fmt.Errorf("i04: marshal originate event: %w", err)
	}

	return d.cfg.Rdb.XAdd(ctx, &redis.XAddArgs{
		Stream: "events:vici2.i04.originate",
		MaxLen: 10000,
		Approx: true,
		Values: map[string]interface{}{
			"payload":     string(payload),
			"callback_id": strconv.FormatInt(cb.ID, 10),
			"tenant_id":   strconv.FormatInt(ig.TenantID, 10),
		},
	}).Err()
}

// promoteInboundCallback atomically transitions the callback PENDING → LIVE
// and writes the audit event. I04 PLAN §5.4.
func (d *DispatcherLoop) promoteInboundCallback(
	ctx context.Context,
	ig *InGroup,
	agent *Agent,
	cb *InboundCallback,
	tcpaOutcome string,
) error {
	if d.cfg.DB == nil {
		return nil
	}

	tx, err := d.cfg.DB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("i04: promoteInboundCallback: begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	// CAS: only update if still PENDING (idempotent)
	res, err := tx.ExecContext(ctx,
		`UPDATE callbacks SET status='LIVE', fired_at=NOW(6) WHERE id=? AND tenant_id=? AND status='PENDING'`,
		cb.ID, ig.TenantID,
	)
	if err != nil {
		return fmt.Errorf("i04: promote callback UPDATE: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		// Already promoted (race) — idempotent skip
		d.log.Debug("i04: promoteInboundCallback: callback already promoted (idempotent skip)", "callback_id", cb.ID)
		return tx.Commit()
	}

	// Update lead status to CALLBK
	if _, err := tx.ExecContext(ctx,
		`UPDATE leads SET status='CALLBK', owner_user_id=?, modify_at=NOW() WHERE id=? AND tenant_id=?`,
		agent.UserID, cb.LeadID, ig.TenantID,
	); err != nil {
		return fmt.Errorf("i04: promote lead UPDATE: %w", err)
	}

	// Write audit event
	detailsJSON := fmt.Sprintf(
		`{"action":"callback.inbound_fired","ingroup_id":%q,"agent_user_id":%d,"consent_mode":"INBOUND_CALLBACK_REQUESTED","skip_internal_dnc":true,"skip_national_dnc":false,"tcpa_outcome":%q,"original_wait_seconds":%s,"queue_position_at_offer":%s}`,
		ig.ID,
		agent.UserID,
		tcpaOutcome,
		nullableInt32JSON(cb.OriginalWaitSeconds),
		nullableInt32JSON(cb.QueuePositionAtOffer),
	)

	if _, err := tx.ExecContext(ctx,
		`INSERT INTO audit_log (tenant_id, actor_kind, action, entity_type, entity_id, after_json, ts)
		 VALUES (?, 'system', 'callback.inbound_fired', 'callback', ?, ?, NOW(6))`,
		ig.TenantID, strconv.FormatInt(cb.ID, 10), detailsJSON,
	); err != nil {
		// Audit failure is non-fatal for the promotion itself — log but continue
		d.log.Error("i04: promoteInboundCallback: audit INSERT failed", "err", err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("i04: promoteInboundCallback: commit: %w", err)
	}

	// After-commit: push WS event to agent
	go d.publishInboundCallbackOffer(context.Background(), ig, agent, cb)

	return nil
}

// deferInboundCallback re-snoozes a callback to the next TCPA window.
// I04 PLAN §5.3 (SKIP_UNTIL branch).
func (d *DispatcherLoop) deferInboundCallback(ctx context.Context, cb *InboundCallback, ingroupID string, nextOpen time.Time) error {
	if d.cfg.DB == nil {
		return nil
	}

	_, err := d.cfg.DB.ExecContext(ctx,
		`UPDATE callbacks SET callback_at=? WHERE id=? AND tenant_id=? AND status='PENDING'`,
		nextOpen, cb.ID, d.cfg.InGroup.TenantID,
	)
	if err != nil {
		return fmt.Errorf("i04: deferInboundCallback: %w", err)
	}

	d.cfg.Metrics.I04CallbackDeferred.WithLabelValues(ingroupID, "tcpa_skip_until").Inc()
	d.log.Info("i04: callback deferred (TCPA)", "callback_id", cb.ID, "next_open", nextOpen)
	return nil
}

// publishInboundCallbackOffer sends the WS inbound_callback_offer event to the agent.
// I04 PLAN §8.1.
func (d *DispatcherLoop) publishInboundCallbackOffer(ctx context.Context, ig *InGroup, agent *Agent, cb *InboundCallback) {
	type callbackOffer struct {
		Type                 string  `json:"type"`
		CallbackID           int64   `json:"callback_id"`
		IngroupID            string  `json:"ingroup_id"`
		IngroupName          string  `json:"ingroup_name"`
		CallbackNumber       string  `json:"callback_number,omitempty"`
		OriginalWaitSeconds  *int32  `json:"original_wait_seconds,omitempty"`
		QueuePositionAtOffer *int32  `json:"queue_position_at_offer,omitempty"`
		Direction            string  `json:"direction"`
	}

	msg := callbackOffer{
		Type:        "inbound_callback_offer",
		CallbackID:  cb.ID,
		IngroupID:   ig.ID,
		IngroupName: ig.Name,
		Direction:   "inbound_callback",
	}
	if cb.CallbackNumber.Valid {
		msg.CallbackNumber = cb.CallbackNumber.String
	}
	if cb.OriginalWaitSeconds.Valid {
		v := cb.OriginalWaitSeconds.Int32
		msg.OriginalWaitSeconds = &v
	}
	if cb.QueuePositionAtOffer.Valid {
		v := cb.QueuePositionAtOffer.Int32
		msg.QueuePositionAtOffer = &v
	}

	payload, err := json.Marshal(msg)
	if err != nil {
		d.log.Error("i04: marshal inbound_callback_offer", "err", err)
		return
	}

	channel := fmt.Sprintf("t:%d:broadcast:agent:%d", ig.TenantID, agent.UserID)
	if err := d.cfg.Rdb.Publish(ctx, channel, string(payload)).Err(); err != nil {
		d.log.Warn("i04: publishInboundCallbackOffer: publish failed", "err", err)
	}
}

// ── Helpers ───────────────────────────────────────────────────────────────────

func nullableInt32JSON(v sql.NullInt32) string {
	if !v.Valid {
		return "null"
	}
	return strconv.FormatInt(int64(v.Int32), 10)
}

