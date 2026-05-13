// Package picker implements E04 — lead-claim, dispatch, and agent/lead
// pairing for outbound campaigns.
package picker

import (
	"context"
	"fmt"
	"log/slog"
	"sync"

	"github.com/google/uuid"
	"github.com/vici2/dialer/internal/originate"
	"github.com/vici2/dialer/internal/valkey"

	eslpkg "github.com/vici2/dialer/internal/esl"
)

// SupervisorConfig contains all dependencies for the Supervisor.
type SupervisorConfig struct {
	TenantID int64
	PodID    string // unique per dialer instance; used for consumer group IDs

	ValkeyClient *valkey.Client
	T04          Originator      // T04 compliance pipeline
	T01          *eslpkg.Client  // T01 ESL client for UUIDTransfer
	Metrics      *Metrics
	Logger       *slog.Logger

	// ListAMDActionFn resolves per-list amd_action. If nil, defaults to "drop".
	ListAMDActionFn func(listID int64) string
}

// campaignWorkers holds the per-campaign goroutine context and cancel function.
type campaignWorkers struct {
	cancel context.CancelFunc
}

// Supervisor manages per-campaign dispatch loops and answer handlers.
// It is the top-level public object for E04.
//
// Goroutine layout (PLAN §8.1):
//   - One Supervisor goroutine (singleton): config-change pubsub listener.
//   - Per-campaign: 1 DispatchLoop goroutine + 1 AnswerHandler goroutine (PREDICTIVE).
//   - Per-campaign: 1 AMDHandler goroutine (if campaign.amd_enabled).
type Supervisor struct {
	cfg      SupervisorConfig
	cfgCache *CampaignConfigCache
	tokens   *TokenBucket
	claimer  *Claimer
	pairer   *AgentPairer
	checker  *PreT04Checker
	freqCap  *FreqCapIncrementer
	janitor  *Janitor

	mu       sync.Mutex
	workers  map[int64]*campaignWorkers // campaignID → worker context
}

// NewSupervisor constructs a Supervisor.
// Call Start(ctx) to begin processing.
func NewSupervisor(cfg SupervisorConfig) (*Supervisor, error) {
	if cfg.PodID == "" {
		cfg.PodID = uuid.New().String()[:8]
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	if cfg.Metrics == nil {
		cfg.Metrics = NewMetrics()
	}

	cfgCache := NewCampaignConfigCache()
	m := cfg.Metrics
	vc := cfg.ValkeyClient

	tokens := NewTokenBucket(vc, m)
	claimer := NewClaimer(vc, m)
	pairer := NewAgentPairer(vc, m)
	checker := NewPreT04Checker(vc, cfgCache)
	freqCap := NewFreqCapIncrementer(vc)
	janitor := NewJanitor(vc, cfgCache, claimer, m, cfg.Logger)

	return &Supervisor{
		cfg:      cfg,
		cfgCache: cfgCache,
		tokens:   tokens,
		claimer:  claimer,
		pairer:   pairer,
		checker:  checker,
		freqCap:  freqCap,
		janitor:  janitor,
		workers:  make(map[int64]*campaignWorkers),
	}, nil
}

// Start blocks until ctx is cancelled, running the pubsub config-change listener.
// Callers should call ActivateCampaign to register campaigns before or after Start.
func (s *Supervisor) Start(ctx context.Context) error {
	// Subscribe to all campaign config-change channels via pattern subscribe.
	pattern := fmt.Sprintf("t:%d:broadcast:campaign:*:config_changed", s.cfg.TenantID)
	pubsub := s.cfg.ValkeyClient.State.PSubscribe(ctx, pattern)
	defer pubsub.Close()

	ch := pubsub.Channel()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case msg, ok := <-ch:
			if !ok {
				return nil
			}
			// Extract campaign ID from channel name and reload config.
			var cid int64
			if _, err := fmt.Sscanf(msg.Channel,
				fmt.Sprintf("t:%d:broadcast:campaign:%%d:config_changed", s.cfg.TenantID),
				&cid,
			); err != nil {
				continue
			}
			s.reloadConfig(ctx, cid)
		}
	}
}

// Stop gracefully stops all per-campaign workers.
func (s *Supervisor) Stop(_ context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, w := range s.workers {
		w.cancel()
	}
	s.workers = make(map[int64]*campaignWorkers)
	return nil
}

// ActivateCampaign loads the campaign config and starts per-campaign workers.
// Safe to call multiple times (idempotent per campaign).
func (s *Supervisor) ActivateCampaign(ctx context.Context, campaignID int64) error {
	cfg, err := LoadCampaignConfig(ctx, s.cfg.ValkeyClient, s.cfg.TenantID, campaignID)
	if err != nil {
		return fmt.Errorf("picker: load campaign config %d: %w", campaignID, err)
	}
	cfg.Active = true
	s.cfgCache.Set(cfg)
	s.startWorkers(ctx, cfg)
	return nil
}

// DeactivateCampaign stops per-campaign workers and removes from config cache.
func (s *Supervisor) DeactivateCampaign(campaignID int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if w, ok := s.workers[campaignID]; ok {
		w.cancel()
		delete(s.workers, campaignID)
	}
	s.cfgCache.Delete(campaignID)
}

// SweepOrphans is called by E06 every 60 s. Returns the count of orphaned
// claims released. PLAN §5.3.
func (s *Supervisor) SweepOrphans(ctx context.Context) (int, error) {
	return s.janitor.SweepOrphans(ctx)
}

// DispatchManual is called by A04 for manual / agent-only callback dials.
// Bypasses the token-bucket (MANUAL is agent-initiated). PLAN §16.1.
func (s *Supervisor) DispatchManual(ctx context.Context, req ManualDispatchRequest) (*ManualDispatchResult, error) {
	cfg, ok := s.cfgCache.Get(req.CampaignID)
	if !ok {
		return nil, fmt.Errorf("picker: campaign %d not active", req.CampaignID)
	}

	// Claim lead.
	claim, err := s.claimer.Claim(ctx, req.TenantID, req.CampaignID, s.cfg.PodID, cfg.LeadLockTTLSec)
	if err != nil {
		return nil, fmt.Errorf("picker: manual dispatch claim: %w", err)
	}
	claim.LeadID = req.LeadID // A04 already knows which lead

	// Build MANUAL originate request.
	attemptUUID := uuid.New().String()
	oreq := buildOriginateRequest(attemptUUID, cfg, claim, req.AgentID, originate.ModeManual)

	res, err := s.cfg.T04.Originate(ctx, oreq)
	if err != nil {
		s.claimer.ReleaseWithPolicy(ctx, req.CampaignID, claim, OutcomeCarrierFail) //nolint:errcheck
		return nil, fmt.Errorf("picker: manual dispatch originate: %w", err)
	}

	return &ManualDispatchResult{
		AttemptUUID: res.AttemptUUID,
		CallUUID:    res.CallUUID,
	}, nil
}

// startWorkers spawns per-campaign goroutines. Must be called with a valid cfg.
func (s *Supervisor) startWorkers(parentCtx context.Context, cfg CampaignConfig) {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Kill existing workers for this campaign (config reload path).
	if existing, ok := s.workers[cfg.CampaignID]; ok {
		existing.cancel()
	}

	workerCtx, cancel := context.WithCancel(parentCtx)
	s.workers[cfg.CampaignID] = &campaignWorkers{cancel: cancel}

	// Dispatch loop goroutine.
	loop := NewDispatchLoop(
		cfg,
		s.tokens,
		s.claimer,
		s.pairer,
		s.checker,
		s.freqCap,
		s.cfg.T04,
		s.cfg.ValkeyClient,
		s.cfg.Metrics,
		s.cfg.Logger,
		s.cfg.PodID,
	)
	go loop.Run(workerCtx)

	// Answer handler goroutine (PREDICTIVE mode).
	if s.cfg.T01 != nil {
		ah := NewAnswerHandler(
			cfg.CampaignID,
			cfg.TenantID,
			s.pairer,
			s.claimer,
			s.cfg.T01,
			s.cfg.ValkeyClient,
			s.cfg.Metrics,
			s.cfg.Logger,
			s.cfg.PodID,
		)
		go ah.Run(workerCtx)

		// AMD handler goroutine.
		if cfg.AMDEnabled {
			amd := NewAMDHandler(
				cfg.CampaignID,
				cfg.TenantID,
				s.cfg.T01,
				s.cfg.ValkeyClient,
				s.cfg.Metrics,
				s.cfg.Logger,
				s.cfg.PodID,
				s.cfg.ListAMDActionFn,
			)
			go amd.Run(workerCtx)
		}
	}
}

// reloadConfig fetches the latest config snapshot from Valkey and updates
// both the cache and the running workers. PLAN §8.5.
func (s *Supervisor) reloadConfig(ctx context.Context, campaignID int64) {
	cfg, err := LoadCampaignConfig(ctx, s.cfg.ValkeyClient, s.cfg.TenantID, campaignID)
	if err != nil {
		s.cfg.Logger.Error("picker: failed to reload campaign config",
			"campaign_id", campaignID, "err", err)
		return
	}
	s.cfgCache.Set(cfg)

	if cfg.Active {
		s.startWorkers(ctx, cfg)
	} else {
		s.DeactivateCampaign(campaignID)
	}
}
