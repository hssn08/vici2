// pacer.go — per-campaign Pacer goroutine.
//
// E02 PLAN §9 + §3: 1 Hz outer ticker + SET NX EX 1 tick lock + sub-tick
// event-driven acceleration. Runs entirely within the dialer process.
package pacing

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/redis/go-redis/v9"
	vkey "github.com/vici2/dialer/internal/valkey"
)

const (
	tickDeadline   = 200 * time.Millisecond // E02 PLAN §3.4: soft abort
	subTickDebounce = 50 * time.Millisecond  // E02 PLAN §3.3
)

// Pacer is the per-campaign goroutine owner. It ticks every cfg.TickInterval(),
// acquires the Valkey tick lock, reads snapshot, decides, publishes.
type Pacer struct {
	tenantID   int64
	campaignID string
	podID      string

	rc      *redis.Client
	keys    vkey.Keys
	store   *ConfigStore
	reader  *SnapshotReader
	decider *Decider
	pub     *Publisher
	m       *Metrics

	// eventCh receives sub-tick acceleration signals (agent state changed,
	// drop_gate_cleared). Buffered 1; overflow drops (harmless, next tick catches up).
	eventCh chan struct{}

	stopCh chan struct{}
}

// newPacer constructs a Pacer for a single campaign.
func newPacer(
	tenantID int64,
	campaignID string,
	podID string,
	rc *redis.Client,
	keys vkey.Keys,
	store *ConfigStore,
	m *Metrics,
) *Pacer {
	reader := NewSnapshotReader(rc, keys, m)
	decider := NewDecider(m)
	pub := NewPublisher(rc, keys, m)

	return &Pacer{
		tenantID:   tenantID,
		campaignID: campaignID,
		podID:      podID,
		rc:         rc,
		keys:       keys,
		store:      store,
		reader:     reader,
		decider:    decider,
		pub:        pub,
		m:          m,
		eventCh:    make(chan struct{}, 1),
		stopCh:     make(chan struct{}),
	}
}

// Signal sends a sub-tick acceleration signal. Non-blocking; overflow dropped.
func (p *Pacer) Signal() {
	select {
	case p.eventCh <- struct{}{}:
	default:
	}
}

// Stop requests the pacer to exit its run loop.
func (p *Pacer) Stop() {
	close(p.stopCh)
}

// Run is the goroutine entry point. It never returns until ctx is cancelled or
// Stop() is called. Panics are caught by the supervisor's recover wrapper.
func (p *Pacer) Run(ctx context.Context) {
	tid := p.tenantID
	cid := p.campaignID

	// Load initial config to determine tick interval.
	cfg, found, err := p.store.Get(ctx, tid, cid)
	if err != nil || !found {
		slog.Warn("pacing: campaign not found on start; pacer exiting",
			slog.Int64("tenant", tid), slog.String("campaign", cid))
		return
	}

	ticker := time.NewTicker(cfg.TickInterval())
	defer ticker.Stop()

	// debounce timer for sub-tick events.
	debounce := time.NewTimer(0)
	debounce.Stop()
	var debounceActive bool

	for {
		select {
		case <-ctx.Done():
			return
		case <-p.stopCh:
			return

		case <-ticker.C:
			debounce.Stop()
			debounceActive = false
			p.tick(ctx, cfg)
			// Refresh ticker if pacing_tick_ms changed.
			if newCfg, found, _ := p.store.Get(ctx, tid, cid); found {
				if newCfg.PacingTickMs != cfg.PacingTickMs {
					ticker.Reset(newCfg.TickInterval())
				}
				cfg = newCfg
			}

		case <-p.eventCh:
			// Sub-tick: coalesce with debounce (E02 PLAN §3.3).
			if !debounceActive {
				debounce.Reset(subTickDebounce)
				debounceActive = true
			}

		case <-debounce.C:
			debounceActive = false
			p.tick(ctx, cfg)
		}
	}
}

// tick is one pacing iteration: lock → snapshot → decide → publish.
func (p *Pacer) tick(ctx context.Context, cfg CampaignConfig) {
	tid := p.tenantID
	cid := p.campaignID
	tidStr := cfg.TenantIDStr()

	if p.m != nil {
		p.m.TickTotal.WithLabelValues(tidStr, cid).Inc()
	}

	// Check campaign still active.
	freshCfg, found, err := p.store.Get(ctx, tid, cid)
	if err != nil || !found || !freshCfg.Active {
		reason := "campaign_inactive"
		if !found {
			reason = "campaign_deleted"
		}
		slog.Debug("pacing: tick skipped",
			slog.String("reason", reason),
			slog.Int64("tenant", tid), slog.String("campaign", cid))
		if p.m != nil {
			p.m.TickSkipped.WithLabelValues(tidStr, cid, reason).Inc()
		}
		return
	}
	cfg = freshCfg

	// MANUAL mode: write 0 tokens and return.
	if cfg.DialMethod == DialMethodManual {
		_ = p.pub.Publish(ctx, cfg, DecideResult{}, TickMeta{LockAcquired: true, PodID: p.podID})
		if p.m != nil {
			p.m.TickSkipped.WithLabelValues(tidStr, cid, "manual_mode").Inc()
		}
		return
	}

	// Acquire tick lock (E02 PLAN §9.1).
	lockKey := p.keys.DialerTick(mustParseCampaignID(cid))
	lockTTL := cfg.TickInterval()
	ok, err := p.rc.SetNX(ctx, lockKey, p.podID, lockTTL).Result()
	if err != nil {
		slog.Warn("pacing: tick lock error",
			slog.Int64("tenant", tid), slog.String("campaign", cid), slog.String("err", err.Error()))
		if p.m != nil {
			p.m.TickSkipped.WithLabelValues(tidStr, cid, "valkey_down").Inc()
		}
		return
	}
	if !ok {
		// Another pod holds the lock for this campaign-second.
		if p.m != nil {
			p.m.TickSkipped.WithLabelValues(tidStr, cid, "lock_contention").Inc()
		}
		_ = p.pub.PublishLockMiss(ctx, cfg)
		return
	}

	start := time.Now()

	// Soft deadline context (E02 PLAN §3.4).
	tickCtx, cancel := context.WithTimeout(ctx, tickDeadline)
	defer cancel()

	nowMs := time.Now().UnixMilli()
	snap, err := p.reader.Read(tickCtx, cfg, nowMs)
	if err != nil {
		slog.Warn("pacing: snapshot read failed",
			slog.Int64("tenant", tid), slog.String("campaign", cid), slog.String("err", err.Error()))
		if p.m != nil {
			p.m.TickSkipped.WithLabelValues(tidStr, cid, "valkey_down").Inc()
		}
		return
	}

	res := p.decider.Decide(snap)

	dur := time.Since(start)
	if dur > tickDeadline {
		slog.Warn("pacing: tick exceeded 200ms deadline",
			slog.Int64("tenant", tid), slog.String("campaign", cid),
			slog.Duration("duration", dur))
		if p.m != nil {
			p.m.TickOverrun.WithLabelValues(tidStr, cid).Inc()
		}
		return
	}

	meta := TickMeta{
		PodID:          p.podID,
		LockAcquired:   true,
		Base:           res.Base,
		ClampsFired:    res.ClampsFired,
		TickDurationUs: dur.Microseconds(),
	}

	if err := p.pub.Publish(tickCtx, cfg, res, meta); err != nil {
		slog.Warn("pacing: publish failed",
			slog.Int64("tenant", tid), slog.String("campaign", cid), slog.String("err", fmt.Sprintf("%v", err)))
		return
	}

	// Prometheus gauges.
	if p.m != nil {
		p.m.TickDuration.WithLabelValues(tidStr, cid).Observe(dur.Seconds())
		p.m.Agents.WithLabelValues(tidStr, cid, "READY").Set(float64(snap.ReadyAgents))
		p.m.Agents.WithLabelValues(tidStr, cid, "INCALL").Set(float64(snap.InCallAgents))
		p.m.Agents.WithLabelValues(tidStr, cid, "WRAPUP").Set(float64(snap.WrapupAgents))
		p.m.ActiveCalls.WithLabelValues(tidStr, cid).Set(float64(snap.ActiveCalls))
		p.m.DialLevel.WithLabelValues(tidStr, cid).Set(res.Level)
		if snap.DropGated {
			p.m.DropGatedSecondsTotal.WithLabelValues(tidStr, cid).Add(cfg.TickInterval().Seconds())
		}
		if snap.GWHeadroom == 0 {
			p.m.CarrierSaturatedSecsTotal.WithLabelValues(tidStr, cid).Add(cfg.TickInterval().Seconds())
		}
	}
}

// mustParseCampaignID parses cid as int64; returns 0 on error (callers
// must handle 0 = skip per-campaign operations that need numeric key).
func mustParseCampaignID(cid string) int64 {
	v, _ := parseInt64(cid)
	return v
}

func parseInt64(s string) (int64, bool) {
	var v int64
	_, err := fmt.Sscan(s, &v)
	return v, err == nil
}
