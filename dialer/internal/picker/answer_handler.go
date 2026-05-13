package picker

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/vici2/dialer/internal/conference"
	"github.com/vici2/dialer/internal/originate"
	"github.com/vici2/dialer/internal/valkey"

	eslpkg "github.com/vici2/dialer/internal/esl"
)

// answerEventStream is the Valkey stream written by T01 on CHANNEL_ANSWER.
const answerEventStream = "events:vici2.call.answered"

// droppedEventStream is the Valkey stream E04 writes when PREDICTIVE has no agent.
// E05 subscribes to play safe-harbor.
const droppedEventStream = "events:vici2.call.dropped"

// answerHandlerBudget is the p99 latency budget for the answer handler.
// XREADGROUP→UUIDTransfer must complete within 250 ms (PLAN §4.2).
const answerHandlerBudget = 250 * time.Millisecond

// AnswerHandler consumes events:vici2.call.answered and pairs PREDICTIVE
// answered calls to a READY agent within ≤ 250 ms.
//
// One AnswerHandler goroutine per campaign per pod.
// Consumer group name: "picker-<podID>" (per-pod unique delivery via
// XREADGROUP). XAUTOCLAIM handles stuck PEL entries after sibling pod failure.
type AnswerHandler struct {
	campaignID int64
	tenantID   int64
	pairer     *AgentPairer
	claimer    *Claimer
	t01        *eslpkg.Client
	vc         *valkey.Client
	metrics    *Metrics
	logger     *slog.Logger
	podID      string
	groupName  string
}

// NewAnswerHandler constructs an AnswerHandler for one campaign.
func NewAnswerHandler(
	campaignID, tenantID int64,
	pairer *AgentPairer,
	claimer *Claimer,
	t01 *eslpkg.Client,
	vc *valkey.Client,
	m *Metrics,
	logger *slog.Logger,
	podID string,
) *AnswerHandler {
	return &AnswerHandler{
		campaignID: campaignID,
		tenantID:   tenantID,
		pairer:     pairer,
		claimer:    claimer,
		t01:        t01,
		vc:         vc,
		metrics:    m,
		logger:     logger,
		podID:      podID,
		groupName:  "picker-" + podID,
	}
}

// Run blocks, consuming events:vici2.call.answered via XREADGROUP.
// Filters to PREDICTIVE mode and current campaignID. Exits on ctx cancellation.
func (h *AnswerHandler) Run(ctx context.Context) {
	consumerID := fmt.Sprintf("c-%d", h.campaignID)

	// Ensure the consumer group exists (create if not; ignore BUSYGROUP error).
	h.vc.State.XGroupCreateMkStream(ctx, answerEventStream, h.groupName, "0") //nolint:errcheck

	for {
		entries, err := h.vc.State.XReadGroup(ctx, &redis.XReadGroupArgs{
			Group:    h.groupName,
			Consumer: consumerID,
			Streams:  []string{answerEventStream, ">"},
			Count:    10,
			Block:    5 * time.Second,
		}).Result()
		if err != nil {
			if ctx.Err() != nil {
				return // context cancelled
			}
			if err == redis.Nil {
				continue // timeout; normal
			}
			h.logger.Error("picker: answer_handler XREADGROUP error",
				"campaign_id", h.campaignID,
				"err", err,
			)
			continue
		}

		for _, stream := range entries {
			for _, msg := range stream.Messages {
				ev := parseAnswerEvent(msg)
				if ev.CampaignID != h.campaignID {
					// Not our campaign — ACK and skip.
					h.vc.State.XAck(ctx, answerEventStream, h.groupName, msg.ID) //nolint:errcheck
					continue
				}
				if ev.Mode != originate.ModePredictive {
					h.vc.State.XAck(ctx, answerEventStream, h.groupName, msg.ID) //nolint:errcheck
					continue
				}
				h.handleAnswer(ctx, ev)
				h.vc.State.XAck(ctx, answerEventStream, h.groupName, msg.ID) //nolint:errcheck
			}
		}
	}
}

// handleAnswer picks an agent and transfers the parked call within ≤ 250 ms.
func (h *AnswerHandler) handleAnswer(ctx context.Context, ev AnsweredEvent) {
	start := time.Now()

	h.metrics.PredictiveAnswered.WithLabelValues(
		fmt.Sprintf("%d", h.tenantID),
		fmt.Sprintf("%d", h.campaignID),
	).Inc()

	// Pick agent via pick_agent_for_call.v1.lua.
	agentID, err := h.pairer.PickForCall(ctx, h.tenantID, h.campaignID, ev.CallUUID)
	if err != nil || agentID == 0 {
		// No agent → emit drop event; E05 plays safe-harbor.
		h.emitDrop(ctx, ev, "no_agent")
		h.metrics.PredictiveDrop.WithLabelValues(
			fmt.Sprintf("%d", h.tenantID),
			fmt.Sprintf("%d", h.campaignID),
			"no_agent",
		).Inc()
		return
	}

	// Transfer to agent conference using ConferenceFQN (RFC-002 lint: must use
	// conference.ConferenceFQN; no inline "agent_" assembly allowed).
	confFQN := conference.ConferenceFQN(h.tenantID, agentID, "default")
	dest := "conference:" + confFQN + "+flags{join-only}"

	if err := h.t01.UUIDTransfer(ctx, ev.FSHost, ev.CallUUID, dest, "inline", "default"); err != nil {
		// Transfer failed: release agent back to READY and emit drop.
		h.pairer.ReleaseReservation(ctx, h.campaignID, agentID) //nolint:errcheck
		h.emitDrop(ctx, ev, "agent_transfer_failed")
		h.metrics.PredictiveDrop.WithLabelValues(
			fmt.Sprintf("%d", h.tenantID),
			fmt.Sprintf("%d", h.campaignID),
			"agent_transfer_failed",
		).Inc()
		h.logger.Error("picker: answer_handler UUIDTransfer failed",
			"campaign_id", h.campaignID,
			"call_uuid", ev.CallUUID,
			"agent_id", agentID,
			"err", err,
		)
		return
	}

	elapsed := time.Since(start)
	h.metrics.AnswerHandlerLatency.WithLabelValues(
		fmt.Sprintf("%d", h.tenantID),
		fmt.Sprintf("%d", h.campaignID),
	).Observe(elapsed.Seconds())

	if elapsed > answerHandlerBudget {
		h.logger.Warn("picker: answer_handler latency exceeded budget",
			"campaign_id", h.campaignID,
			"call_uuid", ev.CallUUID,
			"elapsed_ms", elapsed.Milliseconds(),
			"budget_ms", answerHandlerBudget.Milliseconds(),
		)
	}
}

// emitDrop writes to events:vici2.call.dropped so E05 can play safe-harbor.
func (h *AnswerHandler) emitDrop(ctx context.Context, ev AnsweredEvent, reason string) {
	h.vc.State.XAdd(ctx, &redis.XAddArgs{ //nolint:errcheck
		Stream: droppedEventStream,
		Values: map[string]interface{}{
			"call_uuid":   ev.CallUUID,
			"campaign_id": ev.CampaignID,
			"tenant_id":   ev.TenantID,
			"reason":      reason,
			"ts_ms":       time.Now().UnixMilli(),
		},
	})
}

// parseAnswerEvent extracts an AnsweredEvent from a Valkey stream message.
func parseAnswerEvent(msg redis.XMessage) AnsweredEvent {
	ev := AnsweredEvent{}
	if v, ok := msg.Values["call_uuid"].(string); ok {
		ev.CallUUID = v
	}
	if v, ok := msg.Values["campaign_id"].(string); ok {
		var n int64
		fmt.Sscan(v, &n)
		ev.CampaignID = n
	}
	if v, ok := msg.Values["tenant_id"].(string); ok {
		var n int64
		fmt.Sscan(v, &n)
		ev.TenantID = n
	}
	if v, ok := msg.Values["lead_id"].(string); ok {
		var n int64
		fmt.Sscan(v, &n)
		ev.LeadID = n
	}
	if v, ok := msg.Values["mode"].(string); ok {
		ev.Mode = originate.OriginateMode(v)
	}
	if v, ok := msg.Values["fs_host"].(string); ok {
		ev.FSHost = v
	}
	if v, ok := msg.Values["ts_ms"].(string); ok {
		var n int64
		fmt.Sscan(v, &n)
		ev.TsMs = n
	}
	return ev
}
