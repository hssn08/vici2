package janitor

import (
	"context"
	"fmt"
	"log/slog"
	"regexp"
	"strconv"
	"time"

	"github.com/vici2/dialer/internal/audit"
)

// agentConfRE matches agent home and hold conferences — NEVER kill.
// Derived from conference.ConferenceName() and conference.HoldConferenceName().
// E06 PLAN §4.2. RFC-002.
var agentConfRE = regexp.MustCompile(`^agent_t\d+_u\d+(_hold)?$`)

// isAgentHomeConf reports whether a conference name is an agent home or hold
// conference. These are unconditionally protected from the stale conf sweeper.
func isAgentHomeConf(name string) bool {
	return agentConfRE.MatchString(name)
}

// sweepStaleConferences lists all FS conferences, records empty-since
// timestamps in Valkey, and kills those empty for > StaleConfAge that
// are not agent home conferences.
// E06 PLAN §4.
func (j *Janitor) sweepStaleConferences(ctx context.Context) (int, error) {
	if j.cfg.ESL == nil {
		return 0, nil
	}

	// Step 1: List all conferences from FS.
	conferences, err := j.cfg.ESL.ListAllConferences(ctx, j.cfg.FSHost)
	if err != nil {
		return 0, fmt.Errorf("sweepStaleConferences: ListAllConferences: %w", err)
	}

	now := time.Now()
	emptySinceKey := j.cfg.Keys.JanitorEmptyConfs()

	// Step 2: Update empty-since HASH.
	for _, conf := range conferences {
		if isAgentHomeConf(conf.Name) {
			// Agent home conf: remove from empty-since tracking if present.
			j.cfg.Rdb.HDel(ctx, emptySinceKey, conf.Name)
			continue
		}
		if conf.MemberCount > 0 {
			// Not empty: remove from tracking.
			j.cfg.Rdb.HDel(ctx, emptySinceKey, conf.Name)
			continue
		}
		// Empty, non-agent conf: record first-empty time if not already recorded.
		j.cfg.Rdb.HSetNX(ctx, emptySinceKey, conf.Name,
			strconv.FormatInt(now.UnixMilli(), 10))
	}

	// Step 3: Find conferences empty long enough.
	allEmpty, err := j.cfg.Rdb.HGetAll(ctx, emptySinceKey).Result()
	if err != nil {
		return 0, fmt.Errorf("sweepStaleConferences: HGetAll: %w", err)
	}

	killed := 0
	for confName, emptyMsStr := range allEmpty {
		// Double-check the safety guard (defensive: the HASH might have been
		// populated before this code path was added).
		if isAgentHomeConf(confName) {
			j.cfg.Rdb.HDel(ctx, emptySinceKey, confName)
			continue
		}

		emptyMs, err := strconv.ParseInt(emptyMsStr, 10, 64)
		if err != nil {
			j.log.Warn("sweepStaleConferences: bad empty_since value",
				"conf", confName, "val", emptyMsStr, "err", err)
			j.cfg.Rdb.HDel(ctx, emptySinceKey, confName)
			continue
		}
		emptyDuration := now.Sub(time.UnixMilli(emptyMs))

		if emptyDuration < j.cfg.StaleConfAge {
			continue // not yet stale
		}

		// Re-check: verify it's still in FS and still empty (avoid race).
		members, err := j.cfg.ESL.ConferenceList(ctx, j.cfg.FSHost, confName)
		if err != nil {
			// Conference likely gone already; remove tracking.
			j.cfg.Rdb.HDel(ctx, emptySinceKey, confName)
			continue
		}
		if len(members) > 0 {
			// Conference recovered; remove tracking.
			j.cfg.Rdb.HDel(ctx, emptySinceKey, confName)
			continue
		}

		// Kill it.
		if kickErr := j.cfg.ESL.ConferenceKick(ctx, j.cfg.FSHost, confName, "all"); kickErr != nil {
			j.log.Error("sweepStaleConferences: ConferenceKick",
				"conf", confName, "err", kickErr)
			continue // don't remove from tracking; retry next tick
		}

		j.cfg.Rdb.HDel(ctx, emptySinceKey, confName)
		j.auditConfKill(ctx, confName, emptyDuration)
		j.cfg.Metrics.StaleConfsKilled.Inc()
		killed++
	}

	return killed, nil
}

// auditConfKill writes an audit_log entry for a stale conference kill.
// E06 PLAN §4.4.
func (j *Janitor) auditConfKill(ctx context.Context, confName string, emptyFor time.Duration) {
	if j.cfg.AuditWriter == nil {
		return
	}
	entityID := confName
	requestID := j.sweepTickID
	userAgent := "vici2-janitor/1.0"
	_, err := j.cfg.AuditWriter.AppendAuditLog(ctx, audit.AuditLogRow{
		TenantID:   uint64(j.cfg.TenantID),
		ActorKind:  "system",
		Action:     "conference_killed",
		EntityType: "conference",
		EntityID:   &entityID,
		AfterJSON: map[string]interface{}{
			"empty_for_seconds": int(emptyFor.Seconds()),
			"swept_at":          time.Now().UTC().Format(time.RFC3339Nano),
		},
		RequestID: &requestID,
		UserAgent: &userAgent,
		Ts:        time.Now().UTC(),
	})
	if err != nil {
		j.log.Warn("janitor: auditConfKill: AppendAuditLog",
			slog.String("conf", confName),
			slog.String("err", err.Error()),
		)
	}
}
