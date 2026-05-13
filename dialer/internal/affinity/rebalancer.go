// Package affinity provides the campaign re-pinner for X03 Multi-FS.
//
// The Rebalancer subscribes to the Redis pub/sub channel
// "vici2.infra.fs_node_status_changed" and, when a node goes UNHEALTHY or
// OFFLINE, re-pins affected campaigns to the next healthy node using a
// rendezvous (highest-random-weight) hash over FNV-1a. X03 PLAN §3.4, §10.
package affinity

import (
	"context"
	"database/sql"
	"encoding/binary"
	"errors"
	"fmt"
	"hash/fnv"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/redis/go-redis/v9"
	"github.com/vici2/dialer/internal/esl"
)

// ──────────────────────────────────────────────────────────────────────────────
// Rendezvous hash (X03 PLAN §10)
// ──────────────────────────────────────────────────────────────────────────────

// rendezVousScore computes FNV-1a hash of the concatenation of two uint64s.
// Deterministic: same campaignID + nodeID → same score.
func rendezVousScore(campaignID, nodeID int) uint64 {
	h := fnv.New64a()
	b := make([]byte, 16)
	binary.LittleEndian.PutUint64(b[:8], uint64(campaignID))
	binary.LittleEndian.PutUint64(b[8:], uint64(nodeID))
	h.Write(b)
	return h.Sum64()
}

// nextHealthyNode selects the FS node with the highest weighted rendezvous score
// for the given campaignID, excluding excludeNodeID.
func nextHealthyNode(campaignID, excludeNodeID int, nodes []esl.NodeConfig) (esl.NodeConfig, error) {
	var best esl.NodeConfig
	var bestScore uint64
	found := false

	for _, n := range nodes {
		if n.NodeID == excludeNodeID {
			continue
		}
		if n.Status != "ACTIVE" {
			continue
		}
		w := n.Weight
		if w <= 0 {
			w = 1
		}
		score := rendezVousScore(campaignID, n.NodeID) * uint64(w)
		if !found || score > bestScore {
			best = n
			bestScore = score
			found = true
		}
	}

	if !found {
		return esl.NodeConfig{}, esl.ErrNoHealthyNode
	}
	return best, nil
}

// ──────────────────────────────────────────────────────────────────────────────
// Metrics
// ──────────────────────────────────────────────────────────────────────────────

type rebalancerMetrics struct {
	repinTotal    *prometheus.CounterVec
	repinDuration *prometheus.HistogramVec
}

func newRebalancerMetrics(reg prometheus.Registerer) *rebalancerMetrics {
	if reg == nil {
		reg = prometheus.DefaultRegisterer
	}
	m := &rebalancerMetrics{
		repinTotal: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_affinity_repin_total",
			Help: "Re-pin operations by reason",
		}, []string{"reason"}),
		repinDuration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "vici2_affinity_repin_duration_seconds",
			Help:    "Time from event to re-pin complete",
			Buckets: prometheus.DefBuckets,
		}, []string{"reason"}),
	}
	for _, c := range []prometheus.Collector{m.repinTotal, m.repinDuration} {
		_ = reg.Register(c)
	}
	return m
}

// ──────────────────────────────────────────────────────────────────────────────
// Rebalancer
// ──────────────────────────────────────────────────────────────────────────────

// Rebalancer watches for FS node health events and re-pins campaigns.
// X03 PLAN §3.4.
type Rebalancer struct {
	db      *sql.DB
	rdb     *redis.Client
	logger  *slog.Logger
	metrics *rebalancerMetrics
}

// NewRebalancer constructs a Rebalancer.
func NewRebalancer(
	db *sql.DB,
	rdb *redis.Client,
	logger *slog.Logger,
	reg prometheus.Registerer,
) *Rebalancer {
	if logger == nil {
		logger = slog.Default()
	}
	return &Rebalancer{
		db:      db,
		rdb:     rdb,
		logger:  logger,
		metrics: newRebalancerMetrics(reg),
	}
}

// Run subscribes to Redis "vici2.infra.fs_node_status_changed" and processes
// node-status events. Blocks until ctx is cancelled. X03 PLAN §3.4.
func (rb *Rebalancer) Run(ctx context.Context) error {
	sub := rb.rdb.Subscribe(ctx, "vici2.infra.fs_node_status_changed")
	defer sub.Close()

	rb.logger.Info("affinity.Rebalancer: listening for node status events")

	ch := sub.Channel()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case msg, ok := <-ch:
			if !ok {
				return errors.New("affinity.Rebalancer: pub/sub channel closed")
			}
			// Payload format: "<nodeID>:<status>"
			parts := strings.SplitN(msg.Payload, ":", 2)
			if len(parts) != 2 {
				rb.logger.Warn("affinity.Rebalancer: malformed payload",
					slog.String("payload", msg.Payload))
				continue
			}
			nodeID, err := strconv.Atoi(parts[0])
			if err != nil || nodeID <= 0 {
				rb.logger.Warn("affinity.Rebalancer: invalid node_id in payload",
					slog.String("payload", msg.Payload))
				continue
			}
			status := parts[1]
			if status != "UNHEALTHY" && status != "OFFLINE" {
				continue
			}

			rb.logger.Info("affinity.Rebalancer: node status event",
				slog.Int("node_id", nodeID), slog.String("status", status))

			if err := rb.repinCampaigns(ctx, nodeID); err != nil {
				if errors.Is(err, esl.ErrNoHealthyNode) {
					rb.logger.Warn("affinity.Rebalancer: no healthy node for re-pin",
						slog.Int("failed_node", nodeID))
				} else {
					rb.logger.Error("affinity.Rebalancer: repinCampaigns failed",
						slog.Int("node_id", nodeID), slog.String("err", err.Error()))
				}
			}
		}
	}
}

// repinCampaigns finds all campaigns pinned to nodeID and re-pins them to the
// next healthy node by rendezvous hash. Campaigns with active_calls > 0 are
// left as-is (they become FAILOVER_PENDING implicitly since the node is dead).
// X03 PLAN §3.4, §9.
func (rb *Rebalancer) repinCampaigns(ctx context.Context, nodeID int) error {
	start := time.Now()

	// Load all healthy nodes for re-pin target selection.
	nodes, err := rb.loadActiveNodes(ctx)
	if err != nil {
		return fmt.Errorf("repinCampaigns: load nodes: %w", err)
	}

	// Find campaigns pinned to the failed node.
	rows, err := rb.db.QueryContext(ctx,
		"SELECT id, tenant_id FROM campaigns WHERE fs_node_id = ?", nodeID)
	if err != nil {
		return fmt.Errorf("repinCampaigns: query campaigns: %w", err)
	}
	defer rows.Close()

	type campaign struct {
		id       string
		tenantID int64
	}
	var campaigns []campaign
	for rows.Next() {
		var c campaign
		if err := rows.Scan(&c.id, &c.tenantID); err != nil {
			return fmt.Errorf("repinCampaigns: scan: %w", err)
		}
		campaigns = append(campaigns, c)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("repinCampaigns: rows: %w", err)
	}

	if len(campaigns) == 0 {
		return nil
	}

	rb.logger.Info("affinity.Rebalancer: re-pinning campaigns",
		slog.Int("node_id", nodeID), slog.Int("count", len(campaigns)))

	var repinned, skipped int
	for _, c := range campaigns {
		cidInt, _ := strconv.Atoi(c.id)

		// Check active_calls in Redis.
		activeKey := fmt.Sprintf("t:%d:campaign:{%s}:active_calls", c.tenantID, c.id)
		activeStr, err := rb.rdb.Get(ctx, activeKey).Result()
		if err == nil && activeStr != "" {
			active, _ := strconv.Atoi(activeStr)
			if active > 0 {
				rb.logger.Info("affinity.Rebalancer: skipping campaign with active calls",
					slog.String("campaign_id", c.id), slog.Int("active_calls", active))
				skipped++
				continue
			}
		}

		// Pick next healthy node.
		target, err := nextHealthyNode(cidInt, nodeID, nodes)
		if err != nil {
			rb.logger.Warn("affinity.Rebalancer: no healthy node for campaign",
				slog.String("campaign_id", c.id))
			continue
		}

		// Update DB.
		_, err = rb.db.ExecContext(ctx,
			"UPDATE campaigns SET fs_node_id = ? WHERE id = ?", target.NodeID, c.id)
		if err != nil {
			rb.logger.Error("affinity.Rebalancer: update campaigns failed",
				slog.String("campaign_id", c.id), slog.String("err", err.Error()))
			continue
		}

		// Update Redis affinity cache.
		cacheKey := fmt.Sprintf("affinity:campaign:%s", c.id)
		_ = rb.rdb.Set(ctx, cacheKey, strconv.Itoa(target.NodeID), 5*time.Second).Err()

		// Publish campaign_repinned event.
		payload := fmt.Sprintf(`{"campaignId":%q,"fromNode":%d,"toNode":%d}`,
			c.id, nodeID, target.NodeID)
		_ = rb.rdb.Publish(ctx, "vici2.infra.campaign_repinned", payload).Err()

		rb.logger.Info("affinity.Rebalancer: campaign re-pinned",
			slog.String("campaign_id", c.id),
			slog.Int("from_node", nodeID),
			slog.Int("to_node", target.NodeID))
		repinned++
	}

	dur := time.Since(start)
	if rb.metrics != nil {
		rb.metrics.repinTotal.WithLabelValues("failover").Add(float64(repinned))
		rb.metrics.repinDuration.WithLabelValues("failover").Observe(dur.Seconds())
	}

	rb.logger.Info("affinity.Rebalancer: re-pin complete",
		slog.Int("repinned", repinned), slog.Int("skipped", skipped),
		slog.Duration("duration", dur))

	return nil
}

// loadActiveNodes reads all ACTIVE FS nodes from the database.
func (rb *Rebalancer) loadActiveNodes(ctx context.Context) ([]esl.NodeConfig, error) {
	rows, err := rb.db.QueryContext(ctx,
		"SELECT id, esl_host, esl_port, weight, status FROM fs_nodes WHERE status = 'ACTIVE'")
	if err != nil {
		return nil, fmt.Errorf("loadActiveNodes: %w", err)
	}
	defer rows.Close()

	var nodes []esl.NodeConfig
	for rows.Next() {
		var n esl.NodeConfig
		if err := rows.Scan(&n.NodeID, &n.Host, &n.Port, &n.Weight, &n.Status); err != nil {
			return nil, fmt.Errorf("loadActiveNodes scan: %w", err)
		}
		nodes = append(nodes, n)
	}
	return nodes, rows.Err()
}
