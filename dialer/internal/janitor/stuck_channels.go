package janitor

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/vici2/dialer/internal/audit"
)

// stuckRow holds data for one candidate stuck call_log row.
type stuckRow struct {
	ID          int64
	UUID        string
	CallStarted time.Time
	UserID      *int64
	CampaignID  *string
}

// sweepStuckChannels finds call_log rows open > StuckChannelAge, cross-
// references with live FS channels, closes DB rows not found in FS, and
// hangs up channels still in FS.
// E06 PLAN §3.
func (j *Janitor) sweepStuckChannels(ctx context.Context) (int, error) {
	if j.cfg.DB == nil {
		return 0, nil
	}

	// Step 1: Query DB for candidate stuck rows.
	candidates, err := j.queryStuckRows(ctx)
	if err != nil {
		return 0, fmt.Errorf("sweepStuckChannels: query: %w", err)
	}
	if len(candidates) == 0 {
		return 0, nil
	}

	// Step 2: Get live FS channel UUIDs.
	liveUUIDs, err := j.getLiveChannelUUIDs(ctx)
	if err != nil {
		// Log but proceed; even if ESL fails, we can still close stale DB rows.
		j.log.Warn("sweepStuckChannels: getLiveChannelUUIDs failed; proceeding without ESL kill",
			"err", err)
	}

	// Step 3: Cross-reference and kill.
	killed := 0
	for _, row := range candidates {
		if liveUUIDs != nil && liveUUIDs[row.UUID] {
			// Channel still exists in FS — send hangup.
			if eslErr := j.cfg.ESL.UUIDKill(ctx, j.cfg.FSHost, row.UUID, "NORMAL_CLEARING"); eslErr != nil {
				j.log.Warn("sweepStuckChannels: UUIDKill", "uuid", row.UUID, "err", eslErr)
				// Continue — close DB row regardless.
			}
		}

		// Close the DB row whether or not ESL kill succeeded.
		// The channel may have already hung up naturally.
		if dbErr := j.closeCallLogRow(ctx, row.ID, row.CallStarted); dbErr != nil {
			j.log.Error("sweepStuckChannels: closeCallLogRow",
				"uuid", row.UUID, "id", row.ID, "err", dbErr)
			continue
		}

		j.auditChannelKill(ctx, row)
		j.cfg.Metrics.StuckChannelsKilled.Inc()
		killed++
	}

	return killed, nil
}

// queryStuckRows returns call_log rows open > StuckChannelAge.
// E06 PLAN §3.2 Step 1.
func (j *Janitor) queryStuckRows(ctx context.Context) ([]stuckRow, error) {
	const q = `
		SELECT id, uuid, call_started, user_id, campaign_id
		FROM call_log
		WHERE tenant_id    = ?
		  AND call_ended   IS NULL
		  AND call_started < NOW() - INTERVAL ? SECOND
		  AND call_started >= NOW() - INTERVAL 35 DAY
		ORDER BY call_started ASC
		LIMIT ?`

	rows, err := j.cfg.DB.QueryContext(ctx, q,
		j.cfg.TenantID,
		int64(j.cfg.StuckChannelAge.Seconds()),
		j.cfg.MaxKillsPerTick,
	)
	if err != nil {
		return nil, fmt.Errorf("queryStuckRows: %w", err)
	}
	defer rows.Close()

	var candidates []stuckRow
	for rows.Next() {
		var r stuckRow
		if err := rows.Scan(&r.ID, &r.UUID, &r.CallStarted, &r.UserID, &r.CampaignID); err != nil {
			return nil, fmt.Errorf("queryStuckRows: scan: %w", err)
		}
		candidates = append(candidates, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("queryStuckRows: rows.Err: %w", err)
	}
	return candidates, nil
}

// getLiveChannelUUIDs fetches live channel UUIDs from all healthy FS hosts.
// E06 PLAN §3.2 Step 2.
func (j *Janitor) getLiveChannelUUIDs(ctx context.Context) (map[string]bool, error) {
	if j.cfg.ESL == nil {
		return nil, nil
	}
	uuids, err := j.cfg.ESL.ShowChannelUUIDs(ctx, j.cfg.FSHost)
	if err != nil {
		return nil, fmt.Errorf("getLiveChannelUUIDs: %w", err)
	}
	return uuids, nil
}

// closeCallLogRow closes one stuck call_log row.
// E06 PLAN §3.2 Step 4.
func (j *Janitor) closeCallLogRow(ctx context.Context, id int64, callStarted time.Time) error {
	const q = `
		UPDATE call_log
		   SET call_ended   = NOW(6),
		       status       = 'JANITOR',
		       hangup_cause = 'JANITOR_SWEEP',
		       updated_at   = NOW(6)
		 WHERE id           = ?
		   AND call_started = ?
		   AND call_ended   IS NULL`

	_, err := j.cfg.DB.ExecContext(ctx, q, id, callStarted)
	if err != nil {
		return fmt.Errorf("closeCallLogRow(%d): %w", id, err)
	}
	return nil
}

// auditChannelKill writes an audit_log entry for a stuck channel kill.
// E06 PLAN §3.2 Step 6.
func (j *Janitor) auditChannelKill(ctx context.Context, row stuckRow) {
	if j.cfg.AuditWriter == nil {
		return
	}
	entityID := row.UUID
	requestID := j.sweepTickID
	userAgent := "vici2-janitor/1.0"
	_, err := j.cfg.AuditWriter.AppendAuditLog(ctx, audit.AuditLogRow{
		TenantID:  uint64(j.cfg.TenantID),
		ActorKind: "system",
		Action:    "channel_killed",
		EntityType: "call_log",
		EntityID:   &entityID,
		AfterJSON: map[string]interface{}{
			"status":       "JANITOR",
			"hangup_cause": "JANITOR_SWEEP",
			"swept_at":     time.Now().UTC().Format(time.RFC3339Nano),
		},
		RequestID: &requestID,
		UserAgent: &userAgent,
		Ts:        time.Now().UTC(),
	})
	if err != nil {
		j.log.Warn("janitor: auditChannelKill: AppendAuditLog",
			slog.String("uuid", row.UUID),
			slog.String("err", err.Error()),
		)
	}
}
