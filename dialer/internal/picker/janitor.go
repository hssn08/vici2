package picker

import (
	"context"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/vici2/dialer/internal/valkey"
)

// orphanAgeThreshold is the minimum age of an in_flight entry before the
// janitor considers it orphaned. PLAN §5.3: 5 minutes.
const orphanAgeThreshold = 5 * time.Minute

// Janitor provides SweepOrphans for the E06 janitor module.
// E06 calls picker.Supervisor.SweepOrphans(ctx) every 60 s.
type Janitor struct {
	vc       *valkey.Client
	cfgCache *CampaignConfigCache
	claimer  *Claimer
	metrics  *Metrics
	logger   *slog.Logger
}

// NewJanitor constructs a Janitor.
func NewJanitor(
	vc *valkey.Client,
	cfgCache *CampaignConfigCache,
	claimer *Claimer,
	m *Metrics,
	logger *slog.Logger,
) *Janitor {
	return &Janitor{
		vc:       vc,
		cfgCache: cfgCache,
		claimer:  claimer,
		metrics:  m,
		logger:   logger,
	}
}

// SweepOrphans scans the in_flight HASH for all active campaigns and releases
// any entries older than orphanAgeThreshold. Returns the count of orphans released.
//
// Called by E06 every 60 s. PLAN §5.3.
func (j *Janitor) SweepOrphans(ctx context.Context) (int, error) {
	campaignIDs := j.cfgCache.ActiveCampaignIDs()
	totalReleased := 0

	for _, cid := range campaignIDs {
		cfg, ok := j.cfgCache.Get(cid)
		if !ok {
			continue
		}
		key := fmt.Sprintf("t:%d:campaign:{%d}:in_flight", cfg.TenantID, cid)
		entries, err := j.vc.State.HGetAll(ctx, key).Result()
		if err != nil {
			j.logWarn("picker: janitor HGetAll error",
				"campaign_id", cid, "err", err)
			continue
		}

		for leadIDStr, val := range entries {
			leadID, err := strconv.ParseInt(leadIDStr, 10, 64)
			if err != nil {
				continue
			}
			claimTs, lockVal := parseInFlightEntry(val)
			if time.Since(claimTs) <= orphanAgeThreshold {
				continue
			}
			// Orphan: release with requeue.
			if err := j.claimer.Release(ctx, cid, leadID, lockVal, true, 0); err != nil {
				j.logError("picker: janitor release orphan error",
					"campaign_id", cid, "lead_id", leadID, "err", err)
				continue
			}
			totalReleased++
			j.metrics.OrphanedClaim.WithLabelValues(
				fmt.Sprintf("%d", cfg.TenantID),
				fmt.Sprintf("%d", cid),
			).Inc()
			j.logInfo("picker: janitor released orphan",
				"campaign_id", cid,
				"lead_id", leadID,
				"age_min", time.Since(claimTs).Minutes(),
			)
		}

		// Update active_inflight gauge.
		j.metrics.ActiveInFlight.WithLabelValues(
			fmt.Sprintf("%d", cfg.TenantID),
			fmt.Sprintf("%d", cid),
		).Set(float64(len(entries) - totalReleased))
	}

	return totalReleased, nil
}

func (j *Janitor) logWarn(msg string, args ...any) {
	if j.logger != nil {
		j.logger.Warn(msg, args...)
	}
}
func (j *Janitor) logError(msg string, args ...any) {
	if j.logger != nil {
		j.logger.Error(msg, args...)
	}
}
func (j *Janitor) logInfo(msg string, args ...any) {
	if j.logger != nil {
		j.logger.Info(msg, args...)
	}
}

// parseInFlightEntry parses the "instanceID:claim_ts_ms" format stored in
// the in_flight HASH by claim_lead_from_hopper.v1.lua.
func parseInFlightEntry(val string) (claimTs time.Time, lockVal string) {
	// val format: "instance_id:now_ms" as set by Hopper.Claim.
	parts := strings.SplitN(val, ":", 2)
	if len(parts) < 2 {
		return time.Time{}, val
	}
	tsMs, err := strconv.ParseInt(parts[len(parts)-1], 10, 64)
	if err != nil {
		return time.Time{}, val
	}
	return time.UnixMilli(tsMs), val
}
