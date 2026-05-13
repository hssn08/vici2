package queue

import (
	"context"
	"fmt"
	"log/slog"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/vici2/dialer/internal/esl"
)

// OverflowExecutor executes the overflow chain for a queued call.
// I01 PLAN §9.
type OverflowExecutor struct {
	rdb     *redis.Client
	eslCli  *esl.Client
	fsHost  string
	keys    QueueKeys
	log     *slog.Logger
	metrics *Metrics
	// reEnqueue is a callback to re-enroll a call in a different ingroup.
	// Called for overflow_ingroup action.
	reEnqueue func(ctx context.Context, call *QueuedCall, targetIngroupID string) error
}

// OverflowConfig is the overflow parameters extracted from an InGroup.
type OverflowConfig struct {
	Action OverflowAction
	Target *string // ingroup_id, SIP address, or nil
}

// NewOverflowExecutor creates an OverflowExecutor.
func NewOverflowExecutor(
	rdb *redis.Client,
	eslCli *esl.Client,
	fsHost string,
	keys QueueKeys,
	log *slog.Logger,
	metrics *Metrics,
	reEnqueue func(ctx context.Context, call *QueuedCall, targetIngroupID string) error,
) *OverflowExecutor {
	if log == nil {
		log = slog.Default()
	}
	return &OverflowExecutor{
		rdb:       rdb,
		eslCli:    eslCli,
		fsHost:    fsHost,
		keys:      keys,
		log:       log,
		metrics:   metrics,
		reEnqueue: reEnqueue,
	}
}

// Execute performs the overflow action for the given call.
// I01 PLAN §9.3 + §9.4.
func (e *OverflowExecutor) Execute(ctx context.Context, call *QueuedCall, cfg OverflowConfig) error {
	// Loop protection: hop >= MaxOverflowHops → force hangup.
	if call.OverflowHops >= MaxOverflowHops {
		e.log.Warn("overflow: loop hard-stop", "call_uuid", call.CallUUID, "hops", call.OverflowHops)
		e.metrics.OverflowLoop.WithLabelValues(call.IngroupID).Inc()
		return e.executeHangup(ctx, call)
	}

	switch cfg.Action {
	case ActionHangup:
		e.metrics.CallsOverflow.WithLabelValues(call.IngroupID, string(ActionHangup)).Inc()
		return e.executeHangup(ctx, call)

	case ActionOverflowIngroup:
		if cfg.Target == nil || *cfg.Target == "" {
			e.log.Error("overflow: overflow_ingroup target is nil", "call_uuid", call.CallUUID)
			return e.executeHangup(ctx, call)
		}
		return e.executeOverflowIngroup(ctx, call, *cfg.Target)

	case ActionVoicemail:
		target := ""
		if cfg.Target != nil {
			target = *cfg.Target
		}
		if target == "" {
			target = call.IngroupID
		}
		e.metrics.CallsOverflow.WithLabelValues(call.IngroupID, string(ActionVoicemail)).Inc()
		return e.executeVoicemail(ctx, call, target)

	case ActionCallbackOffer:
		// Callback offer as overflow action plays offer prompt.
		// If caller presses 1, the API handles scheduling; otherwise hangup.
		e.metrics.CallsOverflow.WithLabelValues(call.IngroupID, string(ActionCallbackOffer)).Inc()
		return e.executeCallbackOffer(ctx, call)

	case ActionExternalTransfer:
		if cfg.Target == nil || *cfg.Target == "" {
			return e.executeHangup(ctx, call)
		}
		e.metrics.CallsOverflow.WithLabelValues(call.IngroupID, string(ActionExternalTransfer)).Inc()
		return e.executeExternalTransfer(ctx, call, *cfg.Target)

	default:
		return e.executeHangup(ctx, call)
	}
}

// executeHangup plays apology TTS and kills the channel.
// I01 PLAN §9.3.
func (e *OverflowExecutor) executeHangup(ctx context.Context, call *QueuedCall) error {
	// Play apology audio before hangup.
	_ = e.eslCli.UUIDBroadcast(ctx, e.fsHost, call.CallUUID, "sounds/i01/apology_hangup.wav", "aleg")
	time.Sleep(3 * time.Second) // allow audio to start
	if err := e.eslCli.UUIDKill(ctx, e.fsHost, call.CallUUID, "NORMAL_CLEARING"); err != nil {
		return fmt.Errorf("overflow/hangup: UUIDKill %s: %w", call.CallUUID, err)
	}
	return nil
}

// executeOverflowIngroup re-enqueues the call in a different in-group.
// I01 PLAN §9.3.
func (e *OverflowExecutor) executeOverflowIngroup(ctx context.Context, call *QueuedCall, targetIngroupID string) error {
	// Increment hop counter.
	hopsKey := e.keys.QueueCall(call.CallUUID)
	newHops, err := e.rdb.HIncrBy(ctx, hopsKey, "overflow_hops", 1).Result()
	if err != nil {
		return fmt.Errorf("overflow/ingroup: HINCR hops: %w", err)
	}
	call.OverflowHops = int(newHops)

	if call.OverflowHops >= MaxOverflowHops {
		e.log.Warn("overflow: hard-stop after hop increment", "call_uuid", call.CallUUID, "hops", call.OverflowHops)
		e.metrics.OverflowLoop.WithLabelValues(call.IngroupID).Inc()
		return e.executeHangup(ctx, call)
	}

	e.metrics.CallsOverflow.WithLabelValues(call.IngroupID, string(ActionOverflowIngroup)).Inc()
	call.IngroupID = targetIngroupID
	return e.reEnqueue(ctx, call, targetIngroupID)
}

// executeVoicemail transfers the call to the voicemail extension.
// I01 PLAN §9.3.
func (e *OverflowExecutor) executeVoicemail(ctx context.Context, call *QueuedCall, igid string) error {
	dest := fmt.Sprintf("voicemail_%s XML default", igid)
	if err := e.eslCli.UUIDTransfer(ctx, e.fsHost, call.CallUUID, dest, "XML", "default"); err != nil {
		return fmt.Errorf("overflow/voicemail: UUIDTransfer %s: %w", call.CallUUID, err)
	}
	return nil
}

// executeCallbackOffer plays the callback offer prompt.
// Actual scheduling handled by the API on digit receipt.
// I01 PLAN §11.
func (e *OverflowExecutor) executeCallbackOffer(ctx context.Context, call *QueuedCall) error {
	// play_and_get_digits via uuid_broadcast execute app.
	// audio = callback_offer.wav followed by invalid.wav fallback.
	audio := "sounds/i01/callback_offer.wav"
	if err := e.eslCli.UUIDBroadcast(ctx, e.fsHost, call.CallUUID, audio, "aleg"); err != nil {
		return fmt.Errorf("overflow/callback_offer: broadcast: %w", err)
	}
	// The API endpoint /internal/queue/exit_callback handles the rest via DTMF events.
	return nil
}

// executeExternalTransfer transfers the call to an external SIP destination.
// I01 PLAN §9.3 — WARNING: loses recording/analytics.
func (e *OverflowExecutor) executeExternalTransfer(ctx context.Context, call *QueuedCall, target string) error {
	dest := fmt.Sprintf("sofia/external/%s", target)
	if err := e.eslCli.UUIDTransfer(ctx, e.fsHost, call.CallUUID, dest, "XML", "default"); err != nil {
		return fmt.Errorf("overflow/external_transfer: UUIDTransfer %s: %w", call.CallUUID, err)
	}
	return nil
}

// RemoveFromQueue atomically removes a call from queue ZSET and updates the call HASH.
// Used by hangup handler and timeout handler.
func (e *OverflowExecutor) RemoveFromQueue(ctx context.Context, igid, callUUID, reason string) error {
	pipe := e.rdb.Pipeline()
	pipe.ZRem(ctx, e.keys.IngroupQueue(igid), callUUID)
	pipe.HSet(ctx, e.keys.QueueCall(callUUID),
		"exit_at", strconv.FormatInt(time.Now().UnixMilli(), 10),
		"exit_reason", reason,
	)
	_, err := pipe.Exec(ctx)
	return err
}
