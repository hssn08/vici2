package tz

import (
	"context"
	"log/slog"

	"github.com/redis/go-redis/v9"
)

const invalidateChannel = "vici2.phone_codes.invalidate"

// Subscribe starts a Valkey pubsub listener for cache invalidation events.
// Messages:
//   - "FULL" → full reload of all caches
//   - "<NPA><NXX>" (6 chars) → single NXX override reload
//
// This goroutine runs for the lifetime of ctx. It is safe to call Subscribe
// even if Valkey is unavailable — it will reconnect automatically.
func (r *Resolver) Subscribe(ctx context.Context) error {
	sub := r.valkey.Subscribe(ctx, invalidateChannel)
	go func() {
		defer sub.Close()
		ch := sub.Channel()
		for {
			select {
			case <-ctx.Done():
				return
			case msg, ok := <-ch:
				if !ok {
					return
				}
				r.handleInvalidation(ctx, msg.Payload)
			}
		}
	}()
	return nil
}

// handleInvalidation processes a single pubsub message payload.
func (r *Resolver) handleInvalidation(ctx context.Context, payload string) {
	if payload == "FULL" {
		slog.Info("tz: full reload triggered by pubsub")
		if err := r.Preload(ctx); err != nil {
			slog.Error("tz: full reload failed", "err", err)
		}
		tzInvalidations.WithLabelValues("full_reload").Inc()
		return
	}

	if len(payload) == 6 {
		npa := payload[:3]
		nxx := payload[3:6]
		slog.Info("tz: single NXX invalidation", "npa", npa, "nxx", nxx)
		r.reloadNXX(npa, nxx)
		tzInvalidations.WithLabelValues("pubsub").Inc()
		return
	}

	slog.Warn("tz: unrecognized invalidation payload", "payload", payload)
}

// PublishInvalidate publishes a cache invalidation event for a single NXX or
// a full reload. Called by the admin REST handlers after writing to DB.
func PublishInvalidate(ctx context.Context, vk *redis.Client, npa, nxx string) error {
	payload := npa + nxx
	if len(payload) != 6 {
		payload = "FULL"
	}
	return vk.Publish(ctx, invalidateChannel, payload).Err()
}

// PublishFullReload publishes a FULL invalidation to all processes.
func PublishFullReload(ctx context.Context, vk *redis.Client) error {
	return vk.Publish(ctx, invalidateChannel, "FULL").Err()
}
