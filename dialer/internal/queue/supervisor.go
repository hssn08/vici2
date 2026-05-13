package queue

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/redis/go-redis/v9"

	"github.com/vici2/dialer/internal/conference"
	"github.com/vici2/dialer/internal/esl"
)

// SupervisorConfig is the constructor input for the QueueSupervisor.
type SupervisorConfig struct {
	TenantID  int64
	PodID     string
	DB        *sql.DB
	Rdb       *redis.Client
	ESLClient *esl.Client
	FSHost    string
	Operator  *conference.Operator
	Prometheus prometheus.Registerer
	Log       *slog.Logger
}

// QueueSupervisor manages per-in-group dispatcher goroutines.
// I01 PLAN §18.1–§18.3.
type QueueSupervisor struct {
	cfg     SupervisorConfig
	keys    QueueKeys
	scripts *luaScripts
	metrics *Metrics
	skills  *SkillCache
	aht     *AHTUpdater
	janitor *Janitor
	log     *slog.Logger

	mu          sync.Mutex
	dispatchers map[string]*managedDispatcher // key = ingroup_id
	stopCh      chan struct{}
	wg          sync.WaitGroup
}

type managedDispatcher struct {
	loop   *DispatcherLoop
	cancel context.CancelFunc
}

// NewQueueSupervisor constructs a QueueSupervisor. Call Run() to start.
func NewQueueSupervisor(cfg SupervisorConfig) *QueueSupervisor {
	log := cfg.Log
	if log == nil {
		log = slog.Default()
	}
	keys := NewQueueKeys(cfg.TenantID)
	metrics := NewMetrics(cfg.Prometheus)

	return &QueueSupervisor{
		cfg:         cfg,
		keys:        keys,
		metrics:     metrics,
		skills:      NewSkillCache(cfg.DB, cfg.Rdb, keys, log),
		aht:         NewAHTUpdater(cfg.DB, cfg.Rdb, keys, log),
		janitor:     NewJanitor(cfg.DB, cfg.Rdb, keys, log, metrics),
		dispatchers: make(map[string]*managedDispatcher),
		stopCh:      make(chan struct{}),
		log:         log,
	}
}

// Run starts all background goroutines. Blocks until ctx is cancelled.
func (s *QueueSupervisor) Run(ctx context.Context) error {
	// Load Lua scripts.
	scripts, err := loadScripts(ctx, s.cfg.Rdb, s.log)
	if err != nil {
		return fmt.Errorf("supervisor: loadScripts: %w", err)
	}
	s.scripts = scripts

	// Start janitor.
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		if err := s.janitor.Run(ctx); err != nil && err != context.Canceled {
			s.log.Error("supervisor: janitor exited", "err", err)
		}
	}()

	// Start AHT updater.
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		if err := s.aht.RunAHTUpdater(ctx); err != nil && err != context.Canceled {
			s.log.Error("supervisor: AHTUpdater exited", "err", err)
		}
	}()

	// Start skill cache invalidation listener.
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		if err := s.skills.RunInvalidationListener(ctx); err != nil && err != context.Canceled {
			s.log.Error("supervisor: SkillCache invalidation exited", "err", err)
		}
	}()

	// Discover active in-groups from DB and start dispatchers.
	ingroups, err := s.loadIngroups(ctx)
	if err != nil {
		return fmt.Errorf("supervisor: loadIngroups: %w", err)
	}
	for _, ig := range ingroups {
		s.startDispatcher(ctx, ig)
	}

	// Seed AHT.
	igIDs := make([]string, 0, len(ingroups))
	for _, ig := range ingroups {
		igIDs = append(igIDs, ig.ID)
	}
	if err := s.aht.SeedFromDB(ctx, igIDs); err != nil {
		s.log.Warn("supervisor: AHT seed failed", "err", err)
	}

	// Periodically refresh in-group list (new groups added by admin).
	refreshTicker := time.NewTicker(60 * time.Second)
	defer refreshTicker.Stop()

	for {
		select {
		case <-ctx.Done():
			s.wg.Wait()
			return ctx.Err()
		case <-refreshTicker.C:
			newIngroups, err := s.loadIngroups(ctx)
			if err != nil {
				s.log.Error("supervisor: loadIngroups refresh", "err", err)
				continue
			}
			s.reconcileDispatchers(ctx, newIngroups)
		}
	}
}

// StartIngroup starts a dispatcher for a new in-group (called on admin create).
func (s *QueueSupervisor) StartIngroup(ctx context.Context, ig *InGroup) {
	s.startDispatcher(ctx, ig)
}

// StopIngroup stops the dispatcher for a deleted in-group.
func (s *QueueSupervisor) StopIngroup(igID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if md, ok := s.dispatchers[igID]; ok {
		md.cancel()
		delete(s.dispatchers, igID)
	}
}

// startDispatcher starts a goroutine for one in-group.
func (s *QueueSupervisor) startDispatcher(parentCtx context.Context, ig *InGroup) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, ok := s.dispatchers[ig.ID]; ok {
		return // already running
	}

	announce := NewAnnouncementScheduler(
		s.cfg.Rdb, s.cfg.ESLClient, s.cfg.FSHost,
		s.keys, s.aht, s.log, s.metrics,
	)

	overflow := NewOverflowExecutor(
		s.cfg.Rdb, s.cfg.ESLClient, s.cfg.FSHost,
		s.keys, s.log, s.metrics,
		func(ctx context.Context, call *QueuedCall, targetIngroupID string) error {
			// Re-enqueue: just ZADD to the target ingroup queue.
			return s.cfg.Rdb.ZAdd(ctx, s.keys.IngroupQueue(targetIngroupID), redis.Z{
				Score:  float64(call.BaseScore),
				Member: call.CallUUID,
			}).Err()
		},
	)

	loop := NewDispatcherLoop(DispatcherConfig{
		InGroup:    ig,
		TenantID:   s.cfg.TenantID,
		PodID:      s.cfg.PodID,
		Rdb:        s.cfg.Rdb,
		DB:         s.cfg.DB,
		ESLClient:  s.cfg.ESLClient,
		FSHost:     s.cfg.FSHost,
		Operator:   s.cfg.Operator,
		Keys:       s.keys,
		Scripts:    s.scripts,
		SkillCache: s.skills,
		Overflow:   overflow,
		Announce:   announce,
		AHT:        s.aht,
		Metrics:    s.metrics,
		Log:        s.log,
	})

	ctx, cancel := context.WithCancel(parentCtx)
	s.dispatchers[ig.ID] = &managedDispatcher{loop: loop, cancel: cancel}

	s.wg.Add(2)
	go func() {
		defer s.wg.Done()
		if err := loop.Run(ctx); err != nil && err != context.Canceled {
			s.log.Error("supervisor: dispatcher exited", "ingroup", ig.ID, "err", err)
		}
	}()
	go func() {
		defer s.wg.Done()
		announce.RunForIngroup(ctx, ig)
	}()

	s.log.Info("supervisor: dispatcher started", "ingroup", ig.ID)
}

// reconcileDispatchers stops removed and starts new in-group dispatchers.
func (s *QueueSupervisor) reconcileDispatchers(ctx context.Context, current []*InGroup) {
	currentSet := make(map[string]*InGroup, len(current))
	for _, ig := range current {
		currentSet[ig.ID] = ig
	}

	s.mu.Lock()
	for igID, md := range s.dispatchers {
		if _, ok := currentSet[igID]; !ok {
			md.cancel()
			delete(s.dispatchers, igID)
			s.log.Info("supervisor: dispatcher stopped (ingroup removed)", "ingroup", igID)
		}
	}
	s.mu.Unlock()

	for _, ig := range current {
		s.startDispatcher(ctx, ig)
	}
}

// loadIngroups queries active in-groups from MySQL.
func (s *QueueSupervisor) loadIngroups(ctx context.Context) ([]*InGroup, error) {
	if s.cfg.DB == nil {
		return nil, nil
	}
	const q = `
		SELECT id, name, max_queue, agent_wait_sec,
		       COALESCE(routing_strategy, 'skill_priority'),
		       COALESCE(sticky_enabled, false),
		       COALESCE(sticky_window_hours, 24),
		       COALESCE(sticky_first_try_seconds, 15),
		       COALESCE(sticky_wait_during_wrapup, true),
		       COALESCE(recording_mode, 'ALL'),
		       recording_disclosure_audio,
		       COALESCE(moh_stream, 'local_stream://moh'),
		       welcome_audio,
		       COALESCE(announce_interval_sec, 30),
		       COALESCE(announce_min_wait_sec, 60),
		       COALESCE(entry_full_action, 'hangup'),
		       entry_full_target,
		       COALESCE(no_agent_action, 'voicemail'),
		       no_agent_target,
		       COALESCE(closed_action, 'voicemail'),
		       closed_target,
		       COALESCE(callback_offer_enabled, false),
		       COALESCE(callback_offer_after_seconds, 90),
		       wrapup_seconds,
		       business_hours_id
		FROM ingroups
		WHERE tenant_id = ?`

	rows, err := s.cfg.DB.QueryContext(ctx, q, s.cfg.TenantID)
	if err != nil {
		return nil, fmt.Errorf("loadIngroups: query: %w", err)
	}
	defer rows.Close()

	var result []*InGroup
	for rows.Next() {
		ig := &InGroup{TenantID: s.cfg.TenantID}
		var (
			routingStrategy   string
			entryFullAction   string
			noAgentAction     string
			closedAction      string
			recordingMode     string
			recordingDisc     sql.NullString
			welcomeAudio      sql.NullString
			entryFullTarget   sql.NullString
			noAgentTarget     sql.NullString
			closedTarget      sql.NullString
			wrapupSec         sql.NullInt32
			businessHoursID   sql.NullInt64
		)
		err := rows.Scan(
			&ig.ID, &ig.Name, &ig.MaxQueue, &ig.MaxWaitSec,
			&routingStrategy, &ig.StickyEnabled,
			&ig.StickyWindowHrs, &ig.StickyFirstTrySec, &ig.StickyWaitWrapup,
			&recordingMode, &recordingDisc, &ig.MOHStream, &welcomeAudio,
			&ig.AnnounceIntervalSec, &ig.AnnounceMinWaitSec,
			&entryFullAction, &entryFullTarget,
			&noAgentAction, &noAgentTarget,
			&closedAction, &closedTarget,
			&ig.CallbackOfferEnabled, &ig.CallbackOfferAfterSeconds,
			&wrapupSec, &businessHoursID,
		)
		if err != nil {
			return nil, fmt.Errorf("loadIngroups: scan: %w", err)
		}

		ig.RoutingStrategy = RoutingStrategy(routingStrategy)
		ig.RecordingMode = RecordingMode(recordingMode)
		ig.EntryFullAction = OverflowAction(entryFullAction)
		ig.NoAgentAction = OverflowAction(noAgentAction)
		ig.ClosedAction = OverflowAction(closedAction)

		if recordingDisc.Valid {
			ig.RecordingDisclosureAudio = &recordingDisc.String
		}
		if welcomeAudio.Valid {
			ig.WelcomeAudio = &welcomeAudio.String
		}
		if entryFullTarget.Valid {
			ig.EntryFullTarget = &entryFullTarget.String
		}
		if noAgentTarget.Valid {
			ig.NoAgentTarget = &noAgentTarget.String
		}
		if closedTarget.Valid {
			ig.ClosedTarget = &closedTarget.String
		}
		if wrapupSec.Valid {
			v := int(wrapupSec.Int32)
			ig.WrapupSec = &v
		}
		if businessHoursID.Valid {
			ig.BusinessHoursID = &businessHoursID.Int64
		}

		// Load skill requirements.
		skills, err := s.loadIngroupSkills(ctx, ig.ID)
		if err != nil {
			s.log.Warn("loadIngroups: loadIngroupSkills", "ingroup", ig.ID, "err", err)
		}
		ig.SkillRequirements = skills

		result = append(result, ig)
	}
	return result, rows.Err()
}

// loadIngroupSkills loads skill requirements for one in-group.
func (s *QueueSupervisor) loadIngroupSkills(ctx context.Context, igID string) ([]SkillRequirement, error) {
	if s.cfg.DB == nil {
		return nil, nil
	}
	const q = `
		SELECT skill_key, skill_value, min_proficiency, required, weight
		FROM ingroup_skills
		WHERE tenant_id = ? AND ingroup_id = ?`

	rows, err := s.cfg.DB.QueryContext(ctx, q, s.cfg.TenantID, igID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var reqs []SkillRequirement
	for rows.Next() {
		var r SkillRequirement
		if err := rows.Scan(&r.SkillKey, &r.SkillValue, &r.MinProficiency, &r.Required, &r.Weight); err != nil {
			return nil, err
		}
		reqs = append(reqs, r)
	}
	return reqs, rows.Err()
}
