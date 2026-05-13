package picker

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/vici2/dialer/internal/valkey"

	eslpkg "github.com/vici2/dialer/internal/esl"
)

// amdEventStream is the Valkey stream written by T01 + AMD detector.
const amdEventStream = "events:vici2.call.amd_detected"

// vmdropAuditStream is the Valkey stream for VM drop audit events.
// Consumed by the API's vmdrop-audit-consumer.ts worker.
const vmdropAuditStream = "events:vici2.audit.vmdrop"

// AMDHandler consumes events:vici2.call.amd_detected and applies the
// per-list amd_action (drop / transfer / message / park / vmdrop).
//
// AMD action is per-list (not per-campaign) per F02 schema. The list
// configuration is read from a process-level cache invalidated via pubsub.
// PLAN §6.4.
type AMDHandler struct {
	campaignID int64
	tenantID   int64
	t01        *eslpkg.Client
	vc         *valkey.Client
	metrics    *Metrics
	logger     *slog.Logger
	podID      string
	groupName  string

	// I05: VM drop asset local path resolved from CampaignConfig.VMDropPath
	vmDropPath string

	// listAMDActionFn resolves the per-list amd_action string.
	// Default: "drop". This is a function so tests can inject list configs.
	listAMDActionFn func(listID int64) string
}

// NewAMDHandler constructs an AMDHandler for one campaign.
func NewAMDHandler(
	campaignID, tenantID int64,
	t01 *eslpkg.Client,
	vc *valkey.Client,
	m *Metrics,
	logger *slog.Logger,
	podID string,
	listAMDActionFn func(listID int64) string,
) *AMDHandler {
	if listAMDActionFn == nil {
		listAMDActionFn = func(_ int64) string { return "drop" }
	}
	return &AMDHandler{
		campaignID:      campaignID,
		tenantID:        tenantID,
		t01:             t01,
		vc:              vc,
		metrics:         m,
		logger:          logger,
		podID:           podID,
		groupName:       "picker-amd-" + podID,
		listAMDActionFn: listAMDActionFn,
	}
}

// SetVMDropPath sets the resolved local path for the VM drop asset.
// Called by the campaign runner when the config snapshot includes vmdrop_local_path.
func (h *AMDHandler) SetVMDropPath(path string) {
	h.vmDropPath = path
}

// Run blocks, consuming events:vici2.call.amd_detected via XREADGROUP.
// Filters to current campaignID. Exits on ctx cancellation.
func (h *AMDHandler) Run(ctx context.Context) {
	consumerID := fmt.Sprintf("amd-%d", h.campaignID)

	h.vc.State.XGroupCreateMkStream(ctx, amdEventStream, h.groupName, "0") //nolint:errcheck

	for {
		entries, err := h.vc.State.XReadGroup(ctx, &redis.XReadGroupArgs{
			Group:    h.groupName,
			Consumer: consumerID,
			Streams:  []string{amdEventStream, ">"},
			Count:    10,
			Block:    5 * time.Second,
		}).Result()
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			if err == redis.Nil {
				continue
			}
			h.logger.Error("picker: amd_handler XREADGROUP error",
				"campaign_id", h.campaignID,
				"err", err,
			)
			continue
		}

		for _, stream := range entries {
			for _, msg := range stream.Messages {
				ev := parseAMDEvent(msg)
				if ev.CampaignID != h.campaignID {
					h.vc.State.XAck(ctx, amdEventStream, h.groupName, msg.ID) //nolint:errcheck
					continue
				}
				h.handle(ctx, ev)
				h.vc.State.XAck(ctx, amdEventStream, h.groupName, msg.ID) //nolint:errcheck
			}
		}
	}
}

// handle dispatches the per-list amd_action.
func (h *AMDHandler) handle(ctx context.Context, ev AMDEvent) {
	action := h.listAMDActionFn(ev.ListID)

	h.metrics.AMDAction.WithLabelValues(
		fmt.Sprintf("%d", h.tenantID),
		fmt.Sprintf("%d", h.campaignID),
		fmt.Sprintf("%d", ev.ListID),
		action,
	).Inc()

	switch action {
	case "drop":
		if err := h.t01.UUIDKill(ctx, ev.FSHost, ev.CallUUID, "NORMAL_CLEARING"); err != nil {
			h.logger.Error("picker: amd_handler UUIDKill error",
				"call_uuid", ev.CallUUID, "err", err)
		}
	case "transfer":
		// Per-list transfer target (amd_transfer_group) — Phase 3.
		// Phase 2: transfer to a default ingroup. Logged as a WARN for now.
		h.logger.Warn("picker: amd_handler transfer action — Phase 3 not implemented",
			"campaign_id", h.campaignID, "call_uuid", ev.CallUUID)
	case "message":
		// Play the AMD voicemail audio file and hang up.
		if err := h.t01.UUIDBroadcast(ctx, ev.FSHost, ev.CallUUID,
			"play_and_hangup,/var/lib/vici2/audio/amd_msg.wav", "aleg"); err != nil {
			h.logger.Error("picker: amd_handler UUIDBroadcast error",
				"call_uuid", ev.CallUUID, "err", err)
		}
	case "vmdrop":
		// I05: Play pre-uploaded VM drop audio asset and hang up.
		// Falls back to plain drop if no asset is configured.
		vmPath := h.vmDropPath
		if vmPath == "" {
			h.logger.Warn("picker: vmdrop — no asset configured, falling back to drop",
				"campaign_id", h.campaignID, "call_uuid", ev.CallUUID)
			if h.metrics != nil && h.metrics.VMDropFallback != nil {
				h.metrics.VMDropFallback.WithLabelValues(
					fmt.Sprintf("%d", h.tenantID),
					fmt.Sprintf("%d", h.campaignID),
					"no_asset",
				).Inc()
			}
			h.emitVMDropAuditEvent(ctx, ev, "vmdrop_blocked_no_asset", vmPath)
			if err := h.t01.UUIDKill(ctx, ev.FSHost, ev.CallUUID, "NORMAL_CLEARING"); err != nil {
				h.logger.Error("picker: vmdrop fallback UUIDKill error",
					"call_uuid", ev.CallUUID, "err", err)
			}
			return
		}
		audioArg := "play_and_hangup," + vmPath
		if err := h.t01.UUIDBroadcast(ctx, ev.FSHost, ev.CallUUID, audioArg, "aleg"); err != nil {
			h.logger.Error("picker: vmdrop UUIDBroadcast error",
				"call_uuid", ev.CallUUID, "err", err)
			// Best-effort hangup on broadcast failure
			_ = h.t01.UUIDKill(ctx, ev.FSHost, ev.CallUUID, "NORMAL_CLEARING")
			if h.metrics != nil && h.metrics.VMDropFallback != nil {
				h.metrics.VMDropFallback.WithLabelValues(
					fmt.Sprintf("%d", h.tenantID),
					fmt.Sprintf("%d", h.campaignID),
					"broadcast_error",
				).Inc()
			}
			h.emitVMDropAuditEvent(ctx, ev, "vmdrop_blocked_no_asset", vmPath)
			return
		}
		if h.metrics != nil && h.metrics.VMDropPlayed != nil {
			h.metrics.VMDropPlayed.WithLabelValues(
				fmt.Sprintf("%d", h.tenantID),
				fmt.Sprintf("%d", h.campaignID),
			).Inc()
		}
		h.emitVMDropAuditEvent(ctx, ev, "vmdrop_played", vmPath)
		h.logger.Info("picker: vmdrop played",
			"campaign_id", h.campaignID, "call_uuid", ev.CallUUID, "path", vmPath)
	case "park":
		// Phase 3 voicemail-drop — no-op in Phase 2.
		h.logger.Info("picker: amd_handler park — voicemail-drop Phase 3 stub",
			"campaign_id", h.campaignID, "call_uuid", ev.CallUUID)
	default:
		h.logger.Warn("picker: amd_handler unknown action",
			"action", action, "campaign_id", h.campaignID)
	}
}

// emitVMDropAuditEvent writes a VM drop audit event to the Valkey stream.
// Consumed by api/src/workers/vmdrop-audit-consumer.ts.
func (h *AMDHandler) emitVMDropAuditEvent(ctx context.Context, ev AMDEvent, auditAction string, vmPath string) {
	if h.vc == nil {
		return
	}
	payload := map[string]string{
		"action":       auditAction,
		"entity_type":  "campaign",
		"entity_id":    fmt.Sprintf("%d", ev.CampaignID),
		"tenant_id":    fmt.Sprintf("%d", ev.TenantID),
		"call_uuid":    ev.CallUUID,
		"lead_id":      fmt.Sprintf("%d", ev.LeadID),
		"vm_drop_path": vmPath,
	}
	data, err := json.Marshal(payload)
	if err != nil {
		h.logger.Error("picker: failed to marshal vmdrop audit payload", "err", err)
		return
	}
	if err := h.vc.State.XAdd(ctx, &redis.XAddArgs{
		Stream: vmdropAuditStream,
		Values: map[string]interface{}{"data": string(data)},
	}).Err(); err != nil {
		h.logger.Error("picker: failed to emit vmdrop audit event",
			"action", auditAction, "call_uuid", ev.CallUUID, "err", err)
	}
}

// parseAMDEvent extracts an AMDEvent from a Valkey stream message.
func parseAMDEvent(msg redis.XMessage) AMDEvent {
	ev := AMDEvent{}
	if v, ok := msg.Values["call_uuid"].(string); ok {
		ev.CallUUID = v
	}
	if v, ok := msg.Values["campaign_id"].(string); ok {
		fmt.Sscan(v, &ev.CampaignID)
	}
	if v, ok := msg.Values["tenant_id"].(string); ok {
		fmt.Sscan(v, &ev.TenantID)
	}
	if v, ok := msg.Values["lead_id"].(string); ok {
		fmt.Sscan(v, &ev.LeadID)
	}
	if v, ok := msg.Values["list_id"].(string); ok {
		fmt.Sscan(v, &ev.ListID)
	}
	if v, ok := msg.Values["result"].(string); ok {
		ev.Result = v
	}
	if v, ok := msg.Values["fs_host"].(string); ok {
		ev.FSHost = v
	}
	if v, ok := msg.Values["ts_ms"].(string); ok {
		fmt.Sscan(v, &ev.TsMs)
	}
	return ev
}
