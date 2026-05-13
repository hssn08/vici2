package queue

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/vici2/dialer/internal/conference"
	"github.com/vici2/dialer/internal/esl"
)

// DispatcherConfig holds the constructor arguments for a DispatcherLoop.
type DispatcherConfig struct {
	InGroup    *InGroup
	TenantID   int64
	PodID      string
	Rdb        *redis.Client
	DB         *sql.DB
	ESLClient  *esl.Client
	FSHost     string
	Operator   *conference.Operator
	Keys       QueueKeys
	Scripts    *luaScripts
	SkillCache *SkillCache
	Overflow   *OverflowExecutor
	Announce   *AnnouncementScheduler
	AHT        *AHTUpdater
	Metrics    *Metrics
	Log        *slog.Logger
	// I04 — tenant default outbound CLI (fallback when ingroup.outbound_cli is empty)
	TenantDefaultCLI string
}

// DispatcherLoop is the per-in-group dispatch goroutine.
// I01 PLAN §18.2.
type DispatcherLoop struct {
	cfg DispatcherConfig
	log *slog.Logger
}

// NewDispatcherLoop creates a DispatcherLoop.
func NewDispatcherLoop(cfg DispatcherConfig) *DispatcherLoop {
	log := cfg.Log
	if log == nil {
		log = slog.Default()
	}
	log = log.With("ingroup", cfg.InGroup.ID)
	return &DispatcherLoop{cfg: cfg, log: log}
}

// Run starts the main dispatch loop. Returns when ctx is cancelled.
// I01 PLAN §18.2.
func (d *DispatcherLoop) Run(ctx context.Context) error {
	ig := d.cfg.InGroup
	ticker := time.NewTicker(time.Second) // 1 Hz base tick for overflow/EWT
	defer ticker.Stop()

	// Subscribe to enrollment stream.
	lastStreamID := "$"

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}

		// Read new enrollment events (non-blocking).
		entries, err := d.cfg.Rdb.XRead(ctx, &redis.XReadArgs{
			Streams: []string{d.cfg.Keys.EnrollStream(), lastStreamID},
			Count:   50,
			Block:   0, // non-blocking
		}).Result()
		if err != nil && err != redis.Nil {
			d.log.Error("dispatcher: XRead enroll stream", "err", err)
		}
		if err == nil {
			for _, stream := range entries {
				for _, msg := range stream.Messages {
					lastStreamID = msg.ID
					var evt EnrollEvent
					if err := unmarshalStreamMsg(msg.Values, &evt); err != nil {
						d.log.Warn("dispatcher: unmarshal enroll event", "err", err)
						continue
					}
					if evt.IngroupID != ig.ID {
						continue // not for us
					}
					// Trigger a dispatch cycle immediately on new enrollment.
					if err := d.runDispatchCycle(ctx); err != nil {
						d.log.Error("dispatcher: dispatch cycle (on enroll)", "err", err)
					}
				}
			}
		}

		// Check for max_wait overflow.
		if err := d.checkOverflow(ctx); err != nil {
			d.log.Error("dispatcher: overflow check", "err", err)
		}

		// Run dispatch cycle.
		if err := d.runDispatchCycle(ctx); err != nil {
			d.log.Error("dispatcher: dispatch cycle (tick)", "err", err)
		}
	}
}

// runDispatchCycle acquires the dispatch lock and attempts to pair callers with agents.
// I01 PLAN §18.3.
func (d *DispatcherLoop) runDispatchCycle(ctx context.Context) error {
	ig := d.cfg.InGroup
	lockKey := d.cfg.Keys.DispatchLock(ig.ID)

	// Try to acquire dispatch lock (multi-pod safety).
	acquired, err := d.cfg.Rdb.SetNX(ctx, lockKey, d.cfg.PodID, DispatchLockTTLSec*time.Second).Result()
	if err != nil {
		return fmt.Errorf("dispatch: SETNX lock: %w", err)
	}
	if !acquired {
		return nil // another pod holds the lock
	}
	defer d.cfg.Rdb.Del(ctx, lockKey) // release on exit

	start := time.Now()

	// Get the next call in queue (lowest score = highest priority).
	results, err := d.cfg.Rdb.ZRangeByScoreWithScores(ctx, d.cfg.Keys.IngroupQueue(ig.ID), &redis.ZRangeBy{
		Min:    "-inf",
		Max:    "+inf",
		Offset: 0,
		Count:  1,
	}).Result()
	if err != nil {
		return fmt.Errorf("dispatch: ZRANGEBYSCORE queue: %w", err)
	}
	if len(results) == 0 {
		// I04: no live calls — check for pending INBOUND callbacks to fire
		// We need a READY agent for this; pick one speculatively
		agent, err := d.pickAgent(ctx, &QueuedCall{IngroupID: ig.ID, TenantID: d.cfg.TenantID})
		if err != nil {
			d.log.Error("dispatch: pickAgent for i04 callback check", "err", err)
			return nil
		}
		if agent != nil {
			if err := d.tryFireInboundCallback(ctx, agent); err != nil {
				d.log.Error("dispatch: tryFireInboundCallback", "err", err)
			}
		}
		return nil // no calls in queue
	}

	callUUID := results[0].Member.(string)

	// Load call state from Redis HASH.
	call, err := d.loadQueuedCall(ctx, callUUID)
	if err != nil {
		d.log.Warn("dispatch: loadQueuedCall", "call_uuid", callUUID, "err", err)
		return nil
	}
	call.IngroupID = ig.ID

	// Pick an agent.
	agent, err := d.pickAgent(ctx, call)
	if err != nil {
		d.log.Error("dispatch: pickAgent", "err", err)
		return nil
	}
	if agent == nil {
		// No eligible agent — track no-agents metric.
		d.cfg.Metrics.NoAgentsSeconds.WithLabelValues(ig.ID).Add(1)
		return nil
	}

	// Build Lua KEYS array.
	keys := [6]string{
		d.cfg.Keys.IngroupQueue(ig.ID),
		d.cfg.Keys.IngroupReadyAgents(ig.ID),
		d.cfg.Keys.GlobalAgentsByStatus("READY"),
		d.cfg.Keys.GlobalAgentsByStatus("INCALL"),
		d.cfg.Keys.AgentHash(agent.UserID),
		d.cfg.Keys.QueueCall(callUUID),
	}

	nowMs := time.Now().UnixMilli()
	ok, err := d.cfg.Scripts.EvalDispatch(
		ctx,
		d.cfg.Rdb,
		keys,
		callUUID,
		strconv.FormatInt(agent.UserID, 10),
		nowMs,
		ig.ID,
	)
	if err != nil {
		return fmt.Errorf("dispatch: EvalDispatch: %w", err)
	}
	if !ok {
		// Race detected (CALL_NOT_IN_QUEUE or AGENT_NOT_READY) — retry next tick.
		d.log.Debug("dispatch: race on EvalDispatch, retrying next tick", "call_uuid", callUUID)
		return nil
	}

	// Dispatch timing metric.
	elapsed := time.Since(start)
	if elapsed > 200*time.Millisecond {
		d.cfg.Metrics.DispatchSlow.WithLabelValues(ig.ID).Inc()
		d.log.Warn("dispatch: slow cycle", "elapsed_ms", elapsed.Milliseconds())
	}
	d.cfg.Metrics.WaitSeconds.WithLabelValues(ig.ID).Observe(time.Since(call.EnterAt).Seconds())
	d.cfg.Metrics.CallsDispatched.WithLabelValues(ig.ID).Inc()

	// Publish inbound_call_offer WS event BEFORE transferring.
	// I01 PLAN §12.1.
	if err := d.publishCallOffer(ctx, call, agent); err != nil {
		d.log.Warn("dispatch: publishCallOffer", "err", err)
	}

	// Write sticky record.
	// I01 PLAN §5.2.
	if ig.StickyEnabled && call.CallerIDe164 != "" {
		stickyTTL := time.Duration(ig.StickyWindowHrs) * time.Hour
		d.cfg.Rdb.Set(ctx, d.cfg.Keys.StickyAgent(call.CallerIDe164), strconv.FormatInt(agent.UserID, 10), stickyTTL)
	}

	// Bridge customer into agent conference (T03 TransferCustomer sacred invariant).
	// I01 PLAN §14, §15, AC-3.
	if _, err := d.cfg.Operator.TransferCustomer(ctx, call.TenantID, agent.UserID, callUUID); err != nil {
		d.log.Error("dispatch: TransferCustomer", "call_uuid", callUUID, "agent", agent.UserID, "err", err)
		// Rollback: agent status back to READY is handled by T03/ESL channel event.
		return fmt.Errorf("dispatch: TransferCustomer: %w", err)
	}

	d.log.Info("dispatch: call dispatched",
		"call_uuid", callUUID,
		"agent_user_id", agent.UserID,
		"wait_sec", int(time.Since(call.EnterAt).Seconds()),
	)

	// Write dispatch audit to DB (async — don't block dispatch path).
	go d.writeDispatchAudit(context.Background(), call, agent.UserID, nowMs)

	return nil
}

// pickAgent selects the best eligible agent for the call.
// Applies sticky routing first, then primary algorithm.
// I01 PLAN §5.2–§5.3.
func (d *DispatcherLoop) pickAgent(ctx context.Context, call *QueuedCall) (*Agent, error) {
	ig := d.cfg.InGroup

	// Collect all READY agents for this ingroup.
	members, err := d.cfg.Rdb.ZRangeByScoreWithScores(ctx, d.cfg.Keys.IngroupReadyAgents(ig.ID), &redis.ZRangeBy{
		Min: "-inf",
		Max: "+inf",
	}).Result()
	if err != nil {
		return nil, fmt.Errorf("pickAgent: ZRANGE ready_agents: %w", err)
	}
	if len(members) == 0 {
		return nil, nil
	}

	// Sticky routing check.
	// I01 PLAN §5.2.
	if ig.StickyEnabled && call.CallerIDe164 != "" {
		stickyIDStr, err := d.cfg.Rdb.Get(ctx, d.cfg.Keys.StickyAgent(call.CallerIDe164)).Result()
		if err == nil && stickyIDStr != "" {
			stickyID, _ := strconv.ParseInt(stickyIDStr, 10, 64)
			if stickyID > 0 {
				agent, err := d.loadAgent(ctx, stickyID, 0)
				if err == nil && agent != nil && agent.Status == "READY" {
					score := agent.Skills.MatchScore(ig.SkillRequirements)
					if score >= 0 {
						d.cfg.Metrics.StickyWait.WithLabelValues(ig.ID).Inc()
						return agent, nil
					}
				}
			}
		}
	}

	// Load all candidate agents and filter by skill match.
	var candidates []*Agent
	for _, m := range members {
		userIDStr, _ := m.Member.(string)
		userID, _ := strconv.ParseInt(userIDStr, 10, 64)
		if userID == 0 {
			continue
		}
		agent, err := d.loadAgent(ctx, userID, int64(m.Score))
		if err != nil {
			d.log.Warn("pickAgent: loadAgent", "user_id", userID, "err", err)
			continue
		}
		if agent.Status != "READY" {
			continue
		}
		score := agent.Skills.MatchScore(ig.SkillRequirements)
		if score < 0 {
			continue // gated
		}
		candidates = append(candidates, agent)
	}

	if len(candidates) == 0 {
		return nil, nil
	}

	return PickAgent(call, ig, candidates), nil
}

// loadAgent loads an agent's state from Redis HASH + skill cache.
func (d *DispatcherLoop) loadAgent(ctx context.Context, userID, readyScore int64) (*Agent, error) {
	fields, err := d.cfg.Rdb.HGetAll(ctx, d.cfg.Keys.AgentHash(userID)).Result()
	if err != nil {
		return nil, err
	}

	skills, err := d.cfg.SkillCache.Get(ctx, userID)
	if err != nil {
		d.log.Warn("loadAgent: skill cache miss", "user_id", userID, "err", err)
		skills = &AgentSkillSet{Skills: make(map[string]int)}
	}

	lastDisp, _ := strconv.ParseInt(fields["last_dispatched_at"], 10, 64)
	callsToday, _ := strconv.ParseInt(fields["calls_handled_today"], 10, 64)
	rank, _ := strconv.Atoi(fields["rank"])

	return &Agent{
		UserID:            userID,
		Status:            fields["status"],
		LastReadyChangeTs: readyScore,
		LastDispatchedAt:  lastDisp,
		CallsHandledToday: callsToday,
		Rank:              rank,
		Skills:            *skills,
	}, nil
}

// loadQueuedCall loads call state from Redis HASH.
func (d *DispatcherLoop) loadQueuedCall(ctx context.Context, callUUID string) (*QueuedCall, error) {
	fields, err := d.cfg.Rdb.HGetAll(ctx, d.cfg.Keys.QueueCall(callUUID)).Result()
	if err != nil {
		return nil, fmt.Errorf("loadQueuedCall: HGetAll %s: %w", callUUID, err)
	}
	if len(fields) == 0 {
		return nil, fmt.Errorf("loadQueuedCall: no hash for %s", callUUID)
	}

	enterTs, _ := strconv.ParseInt(fields["enter_ts"], 10, 64)
	baseScore, _ := strconv.ParseInt(fields["base_score"], 10, 64)
	hops, _ := strconv.Atoi(fields["overflow_hops"])
	var leadID *int64
	if lid, err := strconv.ParseInt(fields["lead_id"], 10, 64); err == nil && lid > 0 {
		leadID = &lid
	}
	var stickyTarget *int64
	if st, err := strconv.ParseInt(fields["sticky_target_user"], 10, 64); err == nil && st > 0 {
		stickyTarget = &st
	}
	var did *string
	if fields["did_e164"] != "" {
		s := fields["did_e164"]
		did = &s
	}

	return &QueuedCall{
		CallUUID:          callUUID,
		IngroupID:         fields["ingroup_id"],
		TenantID:          d.cfg.TenantID,
		CallerIDe164:      fields["caller_id"],
		DIDe164:           did,
		LeadID:            leadID,
		EnterAt:           time.UnixMilli(enterTs),
		BaseScore:         baseScore,
		OverflowHops:      hops,
		StickyTarget:      stickyTarget,
		MatchedSkillsJSON: fields["matched_skills"],
	}, nil
}

// checkOverflow checks waiting calls for max_wait violation.
// I01 PLAN §9.2.
func (d *DispatcherLoop) checkOverflow(ctx context.Context) error {
	ig := d.cfg.InGroup
	if ig.MaxWaitSec <= 0 {
		return nil
	}
	deadline := time.Now().Add(-time.Duration(ig.MaxWaitSec) * time.Second).UnixMilli()

	// All calls with enter_ts_ms score that indicates they entered more than max_wait ago.
	// Since base_score = enter_ts_ms - boost_ms, we need to query the HASH for actual enter_ts.
	// For simplicity: list all calls and check their HASH.
	callUUIDs, err := d.cfg.Rdb.ZRange(ctx, d.cfg.Keys.IngroupQueue(ig.ID), 0, -1).Result()
	if err != nil {
		return err
	}

	for _, uuid := range callUUIDs {
		enterTsStr, _ := d.cfg.Rdb.HGet(ctx, d.cfg.Keys.QueueCall(uuid), "enter_ts").Result()
		enterTs, _ := strconv.ParseInt(enterTsStr, 10, 64)
		if enterTs == 0 || enterTs > deadline {
			continue
		}

		// Max wait exceeded.
		call, err := d.loadQueuedCall(ctx, uuid)
		if err != nil {
			d.log.Warn("overflow: loadQueuedCall", "call_uuid", uuid, "err", err)
			continue
		}

		// Remove from queue before acting.
		d.cfg.Rdb.ZRem(ctx, d.cfg.Keys.IngroupQueue(ig.ID), uuid)
		d.cfg.Rdb.HSet(ctx, d.cfg.Keys.QueueCall(uuid),
			"exit_at", strconv.FormatInt(time.Now().UnixMilli(), 10),
			"exit_reason", "timeout",
		)

		overflowCfg := OverflowConfig{
			Action: ig.NoAgentAction,
			Target: ig.NoAgentTarget,
		}
		if err := d.cfg.Overflow.Execute(ctx, call, overflowCfg); err != nil {
			d.log.Error("overflow: execute", "call_uuid", uuid, "err", err)
		}
	}
	return nil
}

// publishCallOffer publishes the inbound_call_offer WS event.
// I01 PLAN §12.1.
func (d *DispatcherLoop) publishCallOffer(ctx context.Context, call *QueuedCall, agent *Agent) error {
	type leadInfo struct {
		ID        *int64 `json:"id,omitempty"`
		FirstName string `json:"first_name,omitempty"`
		LastName  string `json:"last_name,omitempty"`
		City      string `json:"city,omitempty"`
		Status    string `json:"status,omitempty"`
		Rank      int    `json:"rank,omitempty"`
	}
	type offer struct {
		Type           string    `json:"type"`
		CallUUID       string    `json:"call_uuid"`
		IngroupID      string    `json:"ingroup_id"`
		IngroupName    string    `json:"ingroup_name"`
		CallerIDe164   string    `json:"caller_id_e164"`
		DIDe164        *string   `json:"did_e164,omitempty"`
		WaitSeconds    int       `json:"wait_seconds"`
		Direction      string    `json:"direction"`
		PreviewTimeoutMs int     `json:"preview_timeout_ms"`
		Lead           *leadInfo `json:"lead,omitempty"`
	}

	waitSec := int(time.Since(call.EnterAt).Seconds())
	msg := offer{
		Type:             "inbound_call_offer",
		CallUUID:         call.CallUUID,
		IngroupID:        d.cfg.InGroup.ID,
		IngroupName:      d.cfg.InGroup.Name,
		CallerIDe164:     call.CallerIDe164,
		DIDe164:          call.DIDe164,
		WaitSeconds:      waitSec,
		Direction:        "in",
		PreviewTimeoutMs: 3000,
	}

	payload, err := json.Marshal(msg)
	if err != nil {
		return err
	}

	// Publish to per-agent broadcast channel.
	channel := fmt.Sprintf("t:%d:broadcast:agent:%d", d.cfg.TenantID, agent.UserID)
	return d.cfg.Rdb.Publish(ctx, channel, string(payload)).Err()
}

// writeDispatchAudit writes a queue_log row for the dispatch event.
func (d *DispatcherLoop) writeDispatchAudit(ctx context.Context, call *QueuedCall, agentUserID, nowMs int64) {
	const q = `
		INSERT INTO queue_log (tenant_id, queue_call_id, event_at, event, metadata)
		SELECT ?, id, FROM_UNIXTIME(? / 1000, '%Y-%m-%d %H:%i:%s.%f'), 'dispatch',
			JSON_OBJECT('agent_user_id', ?)
		FROM queue_calls
		WHERE tenant_id = ? AND call_uuid = ?
		LIMIT 1`

	if d.cfg.DB == nil {
		return
	}
	_, err := d.cfg.DB.ExecContext(ctx, q,
		d.cfg.TenantID, nowMs, agentUserID, d.cfg.TenantID, call.CallUUID)
	if err != nil {
		d.log.Error("writeDispatchAudit: insert queue_log", "err", err)
	}
}

// unmarshalStreamMsg converts a Redis Stream message map into a struct.
func unmarshalStreamMsg(values map[string]interface{}, target interface{}) error {
	b, err := json.Marshal(values)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, target)
}
