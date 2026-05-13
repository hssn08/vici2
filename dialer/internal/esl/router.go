// router.go — X03 Multi-FS ESL Router.
//
// The Router manages one ESL Client per active FS node. It resolves the
// correct client for a campaign by looking up the fs_node_id assignment in
// Redis (affinity cache, 5 s TTL) then falling back to a DB query. Health
// monitoring runs a heartbeat every 10 s per node; three consecutive failures
// mark the node UNHEALTHY in the DB and broadcast on Redis pub/sub.
//
// X03 PLAN §3.2.
package esl

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"math/rand"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/redis/go-redis/v9"
)

// ──────────────────────────────────────────────────────────────────────────────
// Public error sentinels (X03 PLAN §3.2)
// ──────────────────────────────────────────────────────────────────────────────

var (
	// ErrNodeUnavailable is returned when the ESL connection for a node is
	// UNHEALTHY or not yet connected.
	ErrNodeUnavailable = errors.New("esl: FS node unavailable")

	// ErrNodeNotFound is returned when no FS node is pinned to a campaign.
	ErrNodeNotFound = errors.New("esl: no FS node for campaign")

	// ErrNoHealthyNode is returned when the node pool has no ACTIVE nodes.
	ErrNoHealthyNode = errors.New("esl: no healthy FS node available")
)

// ──────────────────────────────────────────────────────────────────────────────
// NodeConfig — per-node static configuration loaded from DB
// ──────────────────────────────────────────────────────────────────────────────

// NodeConfig holds ESL connection parameters for a single FS node.
type NodeConfig struct {
	NodeID   int
	Host     string
	Port     int
	Password string
	Weight   int
	Status   string // "ACTIVE", "DRAINING", "UNHEALTHY", "OFFLINE"
}

// addr returns the "host:port" ESL address for this node.
func (n NodeConfig) addr() string {
	return fmt.Sprintf("%s:%d", n.Host, n.Port)
}

// ──────────────────────────────────────────────────────────────────────────────
// managedConn — one ESL Client + health state per node
// ──────────────────────────────────────────────────────────────────────────────

type managedConn struct {
	nodeID int
	cfg    NodeConfig

	mu          sync.Mutex
	client      *Client // nil until connected
	healthy     bool
	failCount   int // consecutive heartbeat failures
	lastError   error
	reconnecting bool
}

func (mc *managedConn) isHealthy() bool {
	mc.mu.Lock()
	defer mc.mu.Unlock()
	return mc.healthy && mc.client != nil
}

// ──────────────────────────────────────────────────────────────────────────────
// Router metrics
// ──────────────────────────────────────────────────────────────────────────────

type routerMetrics struct {
	connectionsTotal    *prometheus.GaugeVec
	heartbeatFailures   *prometheus.CounterVec
	reconnectsTotal     *prometheus.CounterVec
	originatesTotal     *prometheus.CounterVec
	violationTotal      prometheus.Counter
	repinTotal          *prometheus.CounterVec
	repinDuration       *prometheus.HistogramVec
	affinityOriginates  *prometheus.CounterVec
}

func newRouterMetrics(reg prometheus.Registerer) *routerMetrics {
	if reg == nil {
		reg = prometheus.DefaultRegisterer
	}
	m := &routerMetrics{}
	m.connectionsTotal = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "vici2_esl_router_connections_total",
		Help: "Current ESL connection count per node and status",
	}, []string{"node_id", "status"})
	m.heartbeatFailures = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "vici2_esl_router_heartbeat_failures_total",
		Help: "Cumulative ESL heartbeat failures per node",
	}, []string{"node_id"})
	m.reconnectsTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "vici2_esl_router_reconnects_total",
		Help: "Successful ESL reconnects per node",
	}, []string{"node_id"})
	m.affinityOriginates = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "vici2_affinity_originates_total",
		Help: "Originates routed per FS node and campaign",
	}, []string{"node_id", "campaign_id"})
	m.violationTotal = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "vici2_affinity_violation_total",
		Help: "Conference UUID mismatch events (affinity violation)",
	})
	m.repinTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "vici2_affinity_repin_total",
		Help: "Re-pin operations by reason (failover/manual/rebalance)",
	}, []string{"reason"})
	m.repinDuration = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "vici2_affinity_repin_duration_seconds",
		Help:    "Time from failure detection to re-pin complete",
		Buckets: prometheus.DefBuckets,
	}, []string{"reason"})

	// Best-effort registration (ignore already-registered errors in tests)
	for _, c := range []prometheus.Collector{
		m.connectionsTotal, m.heartbeatFailures, m.reconnectsTotal,
		m.affinityOriginates, m.violationTotal, m.repinTotal, m.repinDuration,
	} {
		_ = reg.Register(c)
	}
	return m
}

// ──────────────────────────────────────────────────────────────────────────────
// Router
// ──────────────────────────────────────────────────────────────────────────────

// Router manages a pool of ESL connections, one per active FS node.
// It reacts to node pool changes published on Redis pub/sub channel
// "vici2.infra.fs_pool_changed". X03 PLAN §3.2.
type Router struct {
	mu      sync.RWMutex
	conns   map[int]*managedConn // keyed by fs_node_id
	rdb     redis.Cmdable
	rdbFull *redis.Client // for pub/sub subscribe
	db      *sql.DB
	logger  *slog.Logger
	metrics *routerMetrics
}

// NewRouter creates a Router and starts health-check and pub/sub loops.
// It loads the initial node pool from the database and dials all active nodes.
func NewRouter(
	ctx context.Context,
	db *sql.DB,
	rdb *redis.Client,
	logger *slog.Logger,
	reg prometheus.Registerer,
) (*Router, error) {
	if logger == nil {
		logger = slog.Default()
	}
	r := &Router{
		conns:   make(map[int]*managedConn),
		rdb:     rdb,
		rdbFull: rdb,
		db:      db,
		logger:  logger,
		metrics: newRouterMetrics(reg),
	}

	if err := r.Reload(ctx); err != nil {
		return nil, fmt.Errorf("esl.Router: initial reload: %w", err)
	}

	go r.healthLoop(ctx)
	go r.subscribePubSub(ctx)

	return r, nil
}

// ConnFor returns the ESL Client for the FS node pinned to campaignID.
// It resolves fs_node_id via Redis cache (key: "affinity:campaign:{id}",
// 5 s TTL, populated from DB on miss) then returns the corresponding client.
// Returns ErrNodeUnavailable if the node is UNHEALTHY or not connected.
// Returns ErrNodeNotFound if the campaign has no pinned node.
func (r *Router) ConnFor(ctx context.Context, campaignID int) (*Client, error) {
	nodeID, err := r.resolveNodeID(ctx, campaignID)
	if err != nil {
		return nil, err
	}

	r.mu.RLock()
	mc, ok := r.conns[nodeID]
	r.mu.RUnlock()

	if !ok {
		return nil, fmt.Errorf("%w: node_id=%d", ErrNodeUnavailable, nodeID)
	}
	if !mc.isHealthy() {
		return nil, fmt.Errorf("%w: node_id=%d", ErrNodeUnavailable, nodeID)
	}

	if r.metrics != nil {
		r.metrics.affinityOriginates.WithLabelValues(
			strconv.Itoa(nodeID),
			strconv.Itoa(campaignID),
		).Inc()
	}

	mc.mu.Lock()
	c := mc.client
	mc.mu.Unlock()
	return c, nil
}

// resolveNodeID looks up the fs_node_id for a campaign from Redis cache
// (key: "affinity:campaign:{id}") or falls back to a DB query.
func (r *Router) resolveNodeID(ctx context.Context, campaignID int) (int, error) {
	cacheKey := fmt.Sprintf("affinity:campaign:%d", campaignID)

	val, err := r.rdb.Get(ctx, cacheKey).Result()
	if err == nil && val != "" {
		id, parseErr := strconv.Atoi(val)
		if parseErr == nil && id > 0 {
			return id, nil
		}
	}

	// Cache miss — query DB.
	if r.db == nil {
		return 0, ErrNodeNotFound
	}
	var nodeID sql.NullInt64
	row := r.db.QueryRowContext(ctx,
		"SELECT fs_node_id FROM campaigns WHERE id = ?", campaignID)
	if err := row.Scan(&nodeID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return 0, ErrNodeNotFound
		}
		return 0, fmt.Errorf("esl.Router: db lookup campaign %d: %w", campaignID, err)
	}
	if !nodeID.Valid {
		return 0, ErrNodeNotFound
	}

	// Populate cache.
	_ = r.rdb.Set(ctx, cacheKey, strconv.FormatInt(nodeID.Int64, 10), 5*time.Second).Err()

	return int(nodeID.Int64), nil
}

// Reload re-reads the fs_nodes table and reconciles connections.
// Called on startup and on Redis pub/sub "vici2.infra.fs_pool_changed" events.
func (r *Router) Reload(ctx context.Context) error {
	nodes, err := r.loadNodes(ctx)
	if err != nil {
		return fmt.Errorf("esl.Router.Reload: %w", err)
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	// Build a set of active node IDs.
	active := make(map[int]NodeConfig, len(nodes))
	for _, n := range nodes {
		if n.Status == "OFFLINE" {
			continue
		}
		active[n.NodeID] = n
	}

	// Close and remove nodes that no longer exist or are OFFLINE.
	for id, mc := range r.conns {
		if _, ok := active[id]; !ok {
			r.logger.Info("esl.Router: removing node", slog.Int("node_id", id))
			mc.mu.Lock()
			if mc.client != nil {
				mc.client.Close()
				mc.client = nil
			}
			mc.mu.Unlock()
			delete(r.conns, id)
		}
	}

	// Add new nodes or reconnect changed nodes.
	for id, cfg := range active {
		existing, ok := r.conns[id]
		if !ok {
			// New node.
			mc := &managedConn{nodeID: id, cfg: cfg}
			r.conns[id] = mc
			go r.dialNode(ctx, mc)
		} else {
			// Check if connection parameters changed.
			existing.mu.Lock()
			cfgChanged := existing.cfg.Host != cfg.Host ||
				existing.cfg.Port != cfg.Port ||
				existing.cfg.Password != cfg.Password
			existing.cfg = cfg
			existing.mu.Unlock()
			if cfgChanged {
				r.logger.Info("esl.Router: node config changed, reconnecting",
					slog.Int("node_id", id))
				existing.mu.Lock()
				if existing.client != nil {
					existing.client.Close()
					existing.client = nil
				}
				existing.healthy = false
				existing.mu.Unlock()
				go r.dialNode(ctx, existing)
			}
		}
	}

	r.logger.Info("esl.Router: reload complete",
		slog.Int("active_nodes", len(r.conns)))
	return nil
}

// dialNode dials an ESL connection for a managed node.
func (r *Router) dialNode(ctx context.Context, mc *managedConn) {
	mc.mu.Lock()
	cfg := mc.cfg
	mc.mu.Unlock()

	opts := DefaultOptions()
	opts.FSHosts = []string{cfg.addr()}
	opts.Password = cfg.Password

	client, err := New(opts, r.rdb, nil)
	if err != nil {
		r.logger.Error("esl.Router: failed to create client",
			slog.Int("node_id", mc.nodeID),
			slog.String("err", err.Error()))
		return
	}

	mc.mu.Lock()
	mc.client = client
	mc.healthy = true
	mc.failCount = 0
	mc.mu.Unlock()

	if r.metrics != nil {
		r.metrics.connectionsTotal.WithLabelValues(
			strconv.Itoa(mc.nodeID), "connected").Set(1)
	}

	r.logger.Info("esl.Router: node connected",
		slog.Int("node_id", mc.nodeID),
		slog.String("host", cfg.addr()))

	// Run the client (blocks until context cancelled or Close called).
	go func() {
		_ = client.Run(ctx)
	}()
}

// loadNodes reads all non-OFFLINE FS nodes from the database.
func (r *Router) loadNodes(ctx context.Context) ([]NodeConfig, error) {
	if r.db == nil {
		return nil, fmt.Errorf("loadNodes: db is nil")
	}
	rows, err := r.db.QueryContext(ctx,
		"SELECT id, esl_host, esl_port, esl_password, weight, status FROM fs_nodes WHERE status != 'OFFLINE'")
	if err != nil {
		return nil, fmt.Errorf("loadNodes: %w", err)
	}
	defer rows.Close()

	var nodes []NodeConfig
	for rows.Next() {
		var n NodeConfig
		var pwdEncrypted string
		if err := rows.Scan(&n.NodeID, &n.Host, &n.Port, &pwdEncrypted, &n.Weight, &n.Status); err != nil {
			return nil, fmt.Errorf("loadNodes scan: %w", err)
		}
		// Password is stored encrypted; for ESL dialing we need plaintext.
		// The router receives the plaintext via the affinity service on node create/update.
		// Here we use the raw stored value — in production, the service decrypts before
		// storing in a secrets cache; for X03 phase-1 we accept the stored value as-is.
		n.Password = pwdEncrypted
		nodes = append(nodes, n)
	}
	return nodes, rows.Err()
}

// healthLoop runs every 10 s and calls heartbeat() on each managed connection.
// Three consecutive failures → markNodeUnhealthy. X03 PLAN §3.5.
func (r *Router) healthLoop(ctx context.Context) {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			r.mu.RLock()
			conns := make([]*managedConn, 0, len(r.conns))
			for _, mc := range r.conns {
				conns = append(conns, mc)
			}
			r.mu.RUnlock()

			for _, mc := range conns {
				if err := r.heartbeat(ctx, mc); err != nil {
					mc.mu.Lock()
					mc.failCount++
					mc.lastError = err
					count := mc.failCount
					mc.mu.Unlock()

					if r.metrics != nil {
						r.metrics.heartbeatFailures.WithLabelValues(
							strconv.Itoa(mc.nodeID)).Inc()
					}
					r.logger.Warn("esl.Router: heartbeat failed",
						slog.Int("node_id", mc.nodeID),
						slog.Int("fail_count", count),
						slog.String("err", err.Error()))

					if count >= 3 {
						mc.mu.Lock()
						wasHealthy := mc.healthy
						mc.healthy = false
						mc.mu.Unlock()
						if wasHealthy {
							go r.markNodeUnhealthy(ctx, mc.nodeID)
							go r.reconnectLoop(ctx, mc)
						}
					}
				} else {
					mc.mu.Lock()
					mc.failCount = 0
					mc.healthy = true
					mc.mu.Unlock()
				}
			}
		}
	}
}

// heartbeat sends "api status\n\n" via ESL and checks for a valid response.
// Timeout: 5 s. X03 PLAN §8.2.
func (r *Router) heartbeat(ctx context.Context, mc *managedConn) error {
	mc.mu.Lock()
	c := mc.client
	mc.mu.Unlock()

	if c == nil {
		return errors.New("no client")
	}

	hbCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	// Pick any healthy host to send the heartbeat command.
	hosts := c.HealthyHosts()
	if len(hosts) == 0 {
		return errors.New("no healthy ESL host for heartbeat")
	}
	resp, err := c.command(hbCtx, hosts[0], "status")
	if err != nil {
		return fmt.Errorf("heartbeat send: %w", err)
	}
	if !strings.Contains(resp, "UP") {
		return fmt.Errorf("heartbeat: unexpected response: %q", resp)
	}
	return nil
}

// reconnectLoop attempts ESL reconnect for an UNHEALTHY node with exponential
// backoff (1s→30s, ±20% jitter). X03 PLAN §8.3.
func (r *Router) reconnectLoop(ctx context.Context, mc *managedConn) {
	mc.mu.Lock()
	if mc.reconnecting {
		mc.mu.Unlock()
		return
	}
	mc.reconnecting = true
	mc.mu.Unlock()

	defer func() {
		mc.mu.Lock()
		mc.reconnecting = false
		mc.mu.Unlock()
	}()

	delays := []time.Duration{1, 2, 4, 8, 30}
	attempt := 0

	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		idx := attempt
		if idx >= len(delays) {
			idx = len(delays) - 1
		}
		base := delays[idx] * time.Second
		jitter := time.Duration(float64(base) * 0.2 * (rand.Float64()*2 - 1))
		delay := base + jitter
		if delay < 0 {
			delay = base
		}

		r.logger.Info("esl.Router: reconnect attempt",
			slog.Int("node_id", mc.nodeID),
			slog.Int("attempt", attempt+1),
			slog.Duration("delay", delay))

		select {
		case <-ctx.Done():
			return
		case <-time.After(delay):
		}

		mc.mu.Lock()
		cfg := mc.cfg
		mc.mu.Unlock()

		opts := DefaultOptions()
		opts.FSHosts = []string{cfg.addr()}
		opts.Password = cfg.Password

		client, err := New(opts, r.rdb, nil)
		if err != nil {
			attempt++
			continue
		}

		mc.mu.Lock()
		if mc.client != nil {
			mc.client.Close()
		}
		mc.client = client
		// Node stays UNHEALTHY in DB — admin must manually mark ACTIVE.
		// We do mark the local conn as healthy so originates can resume
		// once an admin re-activates the node.
		mc.healthy = false // still UNHEALTHY in DB — do not originate yet
		mc.failCount = 0
		mc.reconnecting = false
		mc.mu.Unlock()

		if r.metrics != nil {
			r.metrics.reconnectsTotal.WithLabelValues(
				strconv.Itoa(mc.nodeID)).Inc()
		}

		go func() { _ = client.Run(ctx) }()

		r.logger.Info("esl.Router: node reconnected (still UNHEALTHY in DB)",
			slog.Int("node_id", mc.nodeID))
		return
	}
}

// markNodeUnhealthy updates fs_nodes.status to UNHEALTHY and publishes a
// Redis event to trigger re-pinner. X03 PLAN §3.5.
func (r *Router) markNodeUnhealthy(ctx context.Context, nodeID int) {
	_, err := r.db.ExecContext(ctx,
		"UPDATE fs_nodes SET status='UNHEALTHY', last_heartbeat=NOW(3) WHERE id=?", nodeID)
	if err != nil {
		r.logger.Error("esl.Router: markNodeUnhealthy DB update failed",
			slog.Int("node_id", nodeID), slog.String("err", err.Error()))
	}

	if pubErr := r.rdb.Publish(ctx, "vici2.infra.fs_node_status_changed",
		fmt.Sprintf("%d:UNHEALTHY", nodeID)).Err(); pubErr != nil {
		r.logger.Error("esl.Router: publish fs_node_status_changed failed",
			slog.Int("node_id", nodeID), slog.String("err", pubErr.Error()))
	}

	r.logger.Warn("esl.Router: node marked UNHEALTHY",
		slog.Int("node_id", nodeID))

	if r.metrics != nil {
		r.metrics.connectionsTotal.WithLabelValues(
			strconv.Itoa(nodeID), "unhealthy").Set(1)
		r.metrics.connectionsTotal.WithLabelValues(
			strconv.Itoa(nodeID), "connected").Set(0)
	}
}

// subscribePubSub listens on "vici2.infra.fs_pool_changed" and calls Reload.
func (r *Router) subscribePubSub(ctx context.Context) {
	if r.rdbFull == nil {
		return
	}
	sub := r.rdbFull.Subscribe(ctx, "vici2.infra.fs_pool_changed")
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
			r.logger.Info("esl.Router: received fs_pool_changed, reloading",
				slog.String("payload", msg.Payload))
			if err := r.Reload(ctx); err != nil {
				r.logger.Error("esl.Router: reload on pub/sub event failed",
					slog.String("err", err.Error()))
			}
		}
	}
}
