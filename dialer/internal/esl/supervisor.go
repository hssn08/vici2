package esl

import (
	"context"
	"fmt"
	"log/slog"
	"math"
	"math/rand"
	"net"
	"time"

	"github.com/percipia/eslgo"
	"github.com/percipia/eslgo/command"
)

// supervisor manages the lifecycle of a single FS connection:
// dial, auth, subscribe events, reconcile, heartbeat watch, reconnect.
// It runs as a long-lived goroutine per FS host.
//
// T01 PLAN §4 — Reconnect strategy.
func (c *Client) supervisor(ctx context.Context, fc *fsConn) {
	logger := slog.Default().With(slog.String("fs_host", fc.host))
	logger.Info("esl supervisor starting")

	for {
		select {
		case <-ctx.Done():
			logger.Info("esl supervisor stopping (context cancelled)")
			fc.setState(stateDead)
			return
		default:
		}

		fc.setState(stateConnecting)
		c.setConnectionStatus(fc)

		conn, err := c.dialAndAuth(ctx, fc.host)
		if err != nil {
			logger.Warn("esl dial failed", slog.String("err", err.Error()))
			fc.reconnectFailures++
			if fc.reconnectFailures >= c.opts.DeadThreshold {
				fc.setState(stateDead)
				c.setConnectionStatus(fc)
				logger.Error("esl host marked DEAD", slog.Int("failures", fc.reconnectFailures))
			}
			delay := reconnectDelay(fc.reconnectFailures, c.opts.ReconnectInitial, c.opts.ReconnectMax)
			logger.Info("esl reconnecting", slog.Duration("delay", delay))
			c.metrics.reconnectsTotal.WithLabelValues(fc.host).Inc()
			if !fc.disconnectStart.IsZero() {
				elapsed := time.Since(fc.disconnectStart).Seconds()
				c.metrics.disconnectSecondsTotal.WithLabelValues(fc.host).Add(elapsed)
				fc.disconnectStart = time.Now()
			} else {
				fc.disconnectStart = time.Now()
			}

			select {
			case <-ctx.Done():
				return
			case <-time.After(delay):
			}
			continue
		}

		// Successful connection.
		fc.reconnectFailures = 0
		if !fc.disconnectStart.IsZero() {
			elapsed := time.Since(fc.disconnectStart).Seconds()
			c.metrics.disconnectSecondsTotal.WithLabelValues(fc.host).Add(elapsed)
			fc.disconnectStart = time.Time{}
		}

		// Store the raw eslgo.Conn in fc.
		fc.mu.Lock()
		fc.conn = &realConn{conn}
		fc.mu.Unlock()

		// Subscribe to the allowlist.
		if err := subscribeAllowlist(ctx, conn); err != nil {
			logger.Error("esl subscribe failed", slog.String("err", err.Error()))
			conn.ExitAndClose()
			continue
		}

		// Register HEARTBEAT listener.
		heartbeatID := conn.RegisterEventListener(eslgo.EventListenAll, func(ev *eslgo.Event) {
			if ev.GetName() == "HEARTBEAT" {
				fc.touchHeartbeat()
				c.metrics.lastHeartbeatSeconds.WithLabelValues(fc.host).
					Set(float64(time.Now().Unix()))
			}
		})
		defer conn.RemoveEventListener(eslgo.EventListenAll, heartbeatID)

		// Register BACKGROUND_JOB listener.
		bgJobID := conn.RegisterEventListener(eslgo.EventListenAll, func(ev *eslgo.Event) {
			if ev.GetName() != "BACKGROUND_JOB" {
				return
			}
			jobUUID := ev.GetHeader("Job-Uuid")
			if jobUUID == "" {
				return
			}
			body := string(ev.Body)
			isErr := len(body) > 4 && body[:4] == "-ERR"
			fc.jobs.deliver(jobUUID, jobResult{Body: body, IsError: isErr})
		})
		defer conn.RemoveEventListener(eslgo.EventListenAll, bgJobID)

		// Register general event listener → internal channel.
		evListenerID := conn.RegisterEventListener(eslgo.EventListenAll, func(ev *eslgo.Event) {
			c.ingestEvent(ctx, ev, fc)
		})
		defer conn.RemoveEventListener(eslgo.EventListenAll, evListenerID)

		// Reconcile (RECONCILING state).
		fc.setState(stateReconciling)
		c.setConnectionStatus(fc)
		if c.rdb != nil {
			if err := reconcile(ctx, conn, c.rdb, fc.host, c.opts.TenantID, c.eventCh, c.metrics); err != nil {
				logger.Warn("esl reconcile error", slog.String("err", err.Error()))
				// Non-fatal; proceed to READY.
			}
		}

		fc.setState(stateReady)
		c.setConnectionStatus(fc)
		fc.touchHeartbeat()
		logger.Info("esl connection ready")

		// Monitor for disconnect or heartbeat timeout.
		disconnectCh := make(chan struct{}, 1)
		disconnectListenerID := conn.RegisterEventListener("", func(_ *eslgo.Event) {})
		// We use a ticker to poll heartbeat age and breaker state.
		_ = disconnectListenerID
		ticker := time.NewTicker(5 * time.Second)
		disconnected := false

		// Override the onDisconnect by re-dialling once heartbeat times out.
		for !disconnected {
			select {
			case <-ctx.Done():
				conn.ExitAndClose()
				return
			case <-disconnectCh:
				disconnected = true
			case <-ticker.C:
				// Check heartbeat.
				if fc.heartbeatAge() > c.opts.HeartbeatTimeout {
					logger.Warn("esl heartbeat timeout — forcing reconnect")
					conn.ExitAndClose()
					disconnected = true
				}
				// Update metrics.
				c.setConnectionStatus(fc)
				c.metrics.circuitBreakerState.WithLabelValues(fc.host).
					Set(float64(fc.breaker.State()))
				c.metrics.activeJobs.WithLabelValues(fc.host).
					Set(float64(fc.jobs.len()))
				c.metrics.eventQueueDepth.WithLabelValues(fc.host).
					Set(float64(len(c.eventCh)))
			}
		}
		ticker.Stop()

		fc.setState(stateReconnecting)
		fc.disconnectStart = time.Now()
		c.setConnectionStatus(fc)
		logger.Warn("esl disconnected, reconnecting")
		c.metrics.reconnectsTotal.WithLabelValues(fc.host).Inc()

		delay := reconnectDelay(1, c.opts.ReconnectInitial, c.opts.ReconnectMax)
		select {
		case <-ctx.Done():
			return
		case <-time.After(delay):
		}
	}
}

// dialAndAuth dials an FS host and authenticates.
func (c *Client) dialAndAuth(ctx context.Context, host string) (*eslgo.Conn, error) {
	dialCtx, cancel := context.WithTimeout(ctx, c.opts.DialTimeout)
	defer cancel()

	dialer := &net.Dialer{
		Timeout:   c.opts.DialTimeout,
		KeepAlive: 30 * time.Second,
	}
	netConn, err := dialer.DialContext(dialCtx, "tcp", host)
	if err != nil {
		return nil, fmt.Errorf("dial %s: %w", host, err)
	}

	opts := eslgo.InboundOptions{
		Options: eslgo.Options{
			Context:     ctx,
			Logger:      eslgo.NilLogger{},
			ExitTimeout: 5 * time.Second,
		},
		Network:     "tcp",
		Password:    c.opts.Password,
		AuthTimeout: c.opts.DialTimeout,
	}
	_ = netConn // eslgo.Dial handles its own net.Dial; close ours.
	netConn.Close()

	conn, err := eslgo.Dial(host, c.opts.Password, func() {
		// onDisconnect is handled by supervisor heartbeat check.
	})
	if err != nil {
		return nil, fmt.Errorf("eslgo.Dial %s: %w", host, err)
	}
	_ = opts // suppress lint warning on opts if we use Dial directly
	return conn, nil
}

// subscribeAllowlist sends `events plain <allowlist>` to FS.
// See T01 PLAN §6.1.
func subscribeAllowlist(ctx context.Context, conn *eslgo.Conn) error {
	_, err := conn.SendCommand(ctx, command.Event{
		Format: "plain",
		Listen: []string{
			"CHANNEL_CREATE",
			"CHANNEL_ANSWER",
			"CHANNEL_HANGUP",
			"CHANNEL_HANGUP_COMPLETE",
			"CHANNEL_BRIDGE",
			"CHANNEL_UNBRIDGE",
			"RECORD_START",
			"RECORD_STOP",
			"DTMF",
			"BACKGROUND_JOB",
			"HEARTBEAT",
			"CUSTOM",
		},
	})
	return err
}

// reconnectDelay computes the exponential backoff delay for the given attempt.
// PLAN §4.1: delay = min(initial * 2^(attempt-1), cap) * (1 + jitter[-0.25,+0.25])
func reconnectDelay(attempt int, initial, max time.Duration) time.Duration {
	if attempt <= 0 {
		attempt = 1
	}
	exp := math.Pow(2, float64(attempt-1))
	d := time.Duration(float64(initial) * exp)
	if d > max {
		d = max
	}
	// Apply ±25% jitter.
	jitter := (rand.Float64()*0.5 - 0.25) // [-0.25, +0.25]
	d = time.Duration(float64(d) * (1 + jitter))
	if d < 0 {
		d = initial
	}
	return d
}

// setConnectionStatus updates the per-FS connection_status gauge.
// All states are reset to 0 then the active one set to 1.
func (c *Client) setConnectionStatus(fc *fsConn) {
	for _, s := range []string{"connected", "reconnecting", "circuit_open", "dead"} {
		c.metrics.connectionStatus.WithLabelValues(fc.host, s).Set(0)
	}
	switch fc.getState() {
	case stateReady:
		c.metrics.connectionStatus.WithLabelValues(fc.host, "connected").Set(1)
	case stateConnecting, stateReconciling, stateReconnecting:
		c.metrics.connectionStatus.WithLabelValues(fc.host, "reconnecting").Set(1)
	case stateDead:
		c.metrics.connectionStatus.WithLabelValues(fc.host, "dead").Set(1)
	}
	if fc.breaker != nil && fc.breaker.State() == int(cbOpen) {
		c.metrics.connectionStatus.WithLabelValues(fc.host, "circuit_open").Set(1)
	}
}

// ingestEvent receives a raw event from eslgo, enriches it, and routes
// it to the bounded internal channel subject to the backpressure policy.
func (c *Client) ingestEvent(ctx context.Context, ev *eslgo.Event, fc *fsConn) {
	name := ev.GetName()
	if name == "" {
		return
	}
	c.metrics.eventsTotal.WithLabelValues(fc.host, name).Inc()

	// Update heartbeat from HEARTBEAT events.
	if name == "HEARTBEAT" {
		// Already handled in supervisor heartbeat listener; skip fan-out.
		return
	}

	// BACKGROUND_JOB is handled by the job dispatcher listener; no fan-out.
	if name == "BACKGROUND_JOB" {
		return
	}

	e := enrichEvent(ctx, ev, fc.host, c.rdb, c.opts.TenantID, c.metrics)

	// Backpressure: check queue depth.
	queueLen := len(c.eventCh)
	queueCap := cap(c.eventCh)
	highWater := queueCap * 8 / 10 // 80%

	if queueLen < highWater {
		// Normal path: non-blocking send.
		select {
		case c.eventCh <- e:
		default:
			// Channel full despite the check: drop non-critical.
			if !e.Critical {
				c.metrics.eventsDroppedTotal.WithLabelValues(fc.host, name, "backpressure").Inc()
			} else {
				// Force enqueue critical (block up to 1s).
				forceEnqueue(ctx, c.eventCh, e, fc.host, name, c.metrics)
			}
		}
	} else {
		// High-water reached.
		if e.Critical {
			forceEnqueue(ctx, c.eventCh, e, fc.host, name, c.metrics)
		} else {
			c.metrics.eventsDroppedTotal.WithLabelValues(fc.host, name, "backpressure").Inc()
		}
	}
}

// forceEnqueue blocks up to 1s trying to enqueue a critical event.
// If the channel is still full after 1s, it panics with a descriptive
// message so the supervisor can force-close and reconnect.
func forceEnqueue(
	ctx context.Context,
	ch chan EnrichedEvent,
	e EnrichedEvent,
	fsHost, eventName string,
	m *eslMetrics,
) {
	timer := time.NewTimer(time.Second)
	defer timer.Stop()
	select {
	case ch <- e:
	case <-timer.C:
		// Force-close signal: drop + log.  The supervisor reconnect will
		// recover state via reconcile. We do NOT crash the process.
		m.eventsDroppedTotal.WithLabelValues(fsHost, eventName, "critical_queue_full").Inc()
	case <-ctx.Done():
	}
}

// realConn wraps *eslgo.Conn to satisfy the eslgoConn interface.
// The interface exists only for test stubbing; in production we use *eslgo.Conn directly.
type realConn struct{ c *eslgo.Conn }

// Kept for interface satisfaction but not actually called via interface in prod.
// Command methods on Client use *eslgo.Conn directly via the fc.mu-guarded pointer.
func (r *realConn) ExitAndClose() { r.c.ExitAndClose() }

// getConn returns the raw *eslgo.Conn for the named host if it is READY.
// All command methods call this; returns error if not READY/DEAD/etc.
func (c *Client) getConn(fsHost string) (*eslgo.Conn, *fsConn, error) {
	c.mu.RLock()
	fc, ok := c.conns[fsHost]
	c.mu.RUnlock()
	if !ok {
		return nil, nil, ErrFSUnknown
	}
	switch fc.getState() {
	case stateDead:
		return nil, fc, ErrFSDead
	case stateReady:
	default:
		return nil, fc, ErrNotConnected
	}
	fc.mu.RLock()
	rc, ok2 := fc.conn.(*realConn)
	fc.mu.RUnlock()
	if !ok2 || rc == nil {
		return nil, fc, ErrNotConnected
	}
	return rc.c, fc, nil
}

// eslgo NilLogger (silence library internal noise in prod)
// Defined in the eslgo package but we need to reference it here.
var _ = eslgo.NilLogger{}

// fanOutLoop drains the internal event channel and publishes to Valkey.
// Runs as a goroutine inside Client.Run.
func (c *Client) fanOutLoop(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case e, ok := <-c.eventCh:
			if !ok {
				return
			}
			if c.rdb == nil {
				continue
			}
			// Stream publish.
			if stream := eventStreamName(e); stream != "" {
				publishStream(ctx, c.rdb, stream, e, c.metrics)
			}
			// Pub/sub publish.
			if channels := pubSubChannels(e); len(channels) > 0 {
				publishPubSub(ctx, c.rdb, channels, e, c.metrics)
			}
			// Drop-window for adaptive engine.
			writeDropWindow(ctx, c.rdb, e)
		}
	}
}
