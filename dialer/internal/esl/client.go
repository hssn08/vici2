package esl

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/redis/go-redis/v9"
)

// Client manages ESL connections to one or more FreeSWITCH hosts.
// It provides the complete T01 transport surface: Originate, UUID commands,
// ConferenceCommand, Reload, and ChannelEvent fan-out to Valkey.
//
// All public methods are safe for concurrent use.
// T01 PLAN §2.
type Client struct {
	opts Options

	// conns holds one fsConn per FS host, keyed by "host:port".
	// Written once at construction; reads are protected by mu during init.
	conns map[string]*fsConn
	mu    sync.RWMutex // guards conns map structure (not values)

	// rrIdx is the round-robin counter for unaffined originate.
	rrIdx uint64
	rrMu  sync.Mutex

	// rdb is the Valkey client for hydration and fan-out. May be nil.
	rdb redis.Cmdable

	// eventCh is the bounded internal event channel (all FS hosts share one).
	eventCh chan EnrichedEvent

	// metrics is the shared Prometheus registry for all esl_* collectors.
	metrics *eslMetrics

	// shuttingDown is set to 1 on Close() to reject new commands.
	shuttingDown atomic.Int32

	// cancel shuts down all supervisors.
	cancel context.CancelFunc
}

// New constructs a Client with the given Options and Valkey client.
// rdb may be nil (disables fan-out and hydration; useful in unit tests).
// reg may be nil (falls back to prometheus.DefaultRegisterer).
//
// The Client does NOT start supervisor goroutines here; call Run(ctx).
func New(opts Options, rdb redis.Cmdable, reg prometheus.Registerer) (*Client, error) {
	if err := opts.Validate(); err != nil {
		return nil, err
	}
	if reg == nil {
		reg = prometheus.DefaultRegisterer
	}

	c := &Client{
		opts:    opts,
		conns:   make(map[string]*fsConn, len(opts.FSHosts)),
		rdb:     rdb,
		eventCh: make(chan EnrichedEvent, opts.InternalQueueDepth),
		metrics: newESLMetrics(reg),
	}

	for _, host := range opts.FSHosts {
		c.conns[host] = &fsConn{
			host:    host,
			breaker: newCircuitBreaker(opts.CircuitFailThreshold, opts.CircuitOpenDuration),
			jobs:    newJobDispatcher(),
		}
		c.conns[host].setState(stateConnecting)
	}

	return c, nil
}

// NewFromEnv constructs a Client from environment variables.
// See Options.DefaultOptions for the env var table.
func NewFromEnv(rdb redis.Cmdable, reg prometheus.Registerer) (*Client, error) {
	opts := DefaultOptions()
	return New(opts, rdb, reg)
}

// Run starts supervisor goroutines for all configured FS hosts and the
// fan-out loop. It blocks until ctx is cancelled, then shuts down cleanly.
//
// Typical usage:
//
//	c, _ := esl.New(opts, rdb, reg)
//	if err := c.Run(ctx); err != nil { ... }
func (c *Client) Run(ctx context.Context) error {
	runCtx, cancel := context.WithCancel(ctx)
	c.cancel = cancel

	var wg sync.WaitGroup

	// Start supervisor for each host.
	for _, fc := range c.conns {
		wg.Add(1)
		go func(fc *fsConn) {
			defer wg.Done()
			c.supervisor(runCtx, fc)
		}(fc)
	}

	// Start fan-out loop.
	wg.Add(1)
	go func() {
		defer wg.Done()
		c.fanOutLoop(runCtx)
	}()

	slog.Info("esl client running",
		slog.Int("fs_hosts", len(c.conns)),
		slog.Int("queue_depth", c.opts.InternalQueueDepth),
	)

	// Block until context is cancelled.
	<-runCtx.Done()
	c.shuttingDown.Store(1)

	// Graceful shutdown: close all connections.
	for _, fc := range c.conns {
		fc.mu.RLock()
		rc, ok := fc.conn.(*realConn)
		fc.mu.RUnlock()
		if ok && rc != nil {
			rc.c.ExitAndClose()
		}
	}

	wg.Wait()
	slog.Info("esl client stopped")
	return nil
}

// Close signals the client to shut down. Blocks until all goroutines exit.
// Equivalent to cancelling the context passed to Run.
func (c *Client) Close() {
	c.shuttingDown.Store(1)
	if c.cancel != nil {
		c.cancel()
	}
}

// HealthyHosts returns the list of FS host strings currently in READY state
// with circuit breaker CLOSED or HALF_OPEN.
// Used by T04 for affinity-aware originate planning.
func (c *Client) HealthyHosts() []string {
	c.mu.RLock()
	defer c.mu.RUnlock()

	var healthy []string
	for host, fc := range c.conns {
		if fc.isReady() && fc.breaker.State() != int(cbOpen) {
			healthy = append(healthy, host)
		}
	}
	return healthy
}

// HostStatus returns a map of fs_host → state string for /health responses.
func (c *Client) HostStatus() map[string]string {
	c.mu.RLock()
	defer c.mu.RUnlock()

	m := make(map[string]string, len(c.conns))
	for host, fc := range c.conns {
		m[host] = fmt.Sprintf("%s (breaker=%d)", fc.getState().String(), fc.breaker.State())
	}
	return m
}

// isShuttingDown returns true if Close() has been called.
func (c *Client) isShuttingDown() bool {
	return c.shuttingDown.Load() == 1
}

// EventCh returns a read-only view of the internal enriched-event channel.
// Consumers (eslbridge fan-out, tests) can drain events from this channel.
// The channel is closed when the Client stops.
func (c *Client) EventCh() <-chan EnrichedEvent {
	return c.eventCh
}
