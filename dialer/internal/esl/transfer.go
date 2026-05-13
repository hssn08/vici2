package esl

import (
	"context"
	"fmt"
	"time"
)

// UUIDTransfer transfers a parked channel to a new dialplan destination.
// destination examples: "conference:agent_t1_u7@default", "extension_name"
// dialplan: "XML" or "inline"
// context: "default"
//
// T01 PLAN §8.
func (c *Client) UUIDTransfer(ctx context.Context, fsHost, callUUID, destination, dialplan, dialContext string) error {
	cmd := fmt.Sprintf("uuid_transfer %s %s %s %s", callUUID, destination, dialplan, dialContext)
	return c.runUUIDCmd(ctx, fsHost, "UUIDTransfer", cmd)
}

// UUIDBridge bridges two parked legs.
// T01 PLAN §8.
func (c *Client) UUIDBridge(ctx context.Context, fsHost, leg1UUID, leg2UUID string) error {
	cmd := fmt.Sprintf("uuid_bridge %s %s", leg1UUID, leg2UUID)
	return c.runUUIDCmd(ctx, fsHost, "UUIDBridge", cmd)
}

// UUIDKill terminates a channel with the given hangup cause.
// cause: "NORMAL_CLEARING" | "ORIGINATOR_CANCEL" | "CALL_REJECTED" etc.
// T01 PLAN §8.
func (c *Client) UUIDKill(ctx context.Context, fsHost, callUUID, cause string) error {
	cmd := fmt.Sprintf("uuid_kill %s %s", callUUID, cause)
	return c.runUUIDCmd(ctx, fsHost, "UUIDKill", cmd)
}

// UUIDPark moves a channel to the park dialplan app.
// T01 PLAN §8.
func (c *Client) UUIDPark(ctx context.Context, fsHost, callUUID string) error {
	cmd := fmt.Sprintf("uuid_park %s", callUUID)
	return c.runUUIDCmd(ctx, fsHost, "UUIDPark", cmd)
}

// UUIDSetVar sets a channel variable on a live channel.
// T01 PLAN §8.
func (c *Client) UUIDSetVar(ctx context.Context, fsHost, callUUID, key, value string) error {
	cmd := fmt.Sprintf("uuid_setvar %s %s %s", callUUID, key, value)
	return c.runUUIDCmd(ctx, fsHost, "UUIDSetVar", cmd)
}

// UUIDBroadcast injects an audio file into a leg of a bridged call.
// leg: "aleg" | "bleg" | "both"
// T01 PLAN §8.
func (c *Client) UUIDBroadcast(ctx context.Context, fsHost, callUUID, audioPath, leg string) error {
	cmd := fmt.Sprintf("uuid_broadcast %s %s %s", callUUID, audioPath, leg)
	return c.runUUIDCmd(ctx, fsHost, "UUIDBroadcast", cmd)
}

// runUUIDCmd issues a bgapi uuid_* command and records metrics.
// All uuid_* commands use bgapi (non-blocking) per PLAN §7.4.
func (c *Client) runUUIDCmd(ctx context.Context, fsHost, name, cmd string) error {
	if c.isShuttingDown() {
		return ErrShuttingDown
	}
	start := time.Now()

	reply, err := c.bgCommand(ctx, fsHost, cmd)
	latency := time.Since(start)

	outcome := "ok"
	if err != nil {
		outcome = "error"
		c.metrics.commandTotal.WithLabelValues(fsHost, name, outcome).Inc()
		c.metrics.commandLatency.WithLabelValues(fsHost, name).Observe(latency.Seconds())
		return fmt.Errorf("esl %s: %w", name, err)
	}
	_ = reply // bgapi returns "+OK Job-UUID: ..." synchronously
	c.metrics.commandTotal.WithLabelValues(fsHost, name, outcome).Inc()
	c.metrics.commandLatency.WithLabelValues(fsHost, name).Observe(latency.Seconds())
	return nil
}
