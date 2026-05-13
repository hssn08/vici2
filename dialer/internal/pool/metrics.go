package pool

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	poolPickTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "vici2_pool_pick_total",
		Help: "Total number of pool picks by pool and strategy.",
	}, []string{"pool_id", "strategy"})

	poolPickEmpty = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "vici2_pool_pick_empty_total",
		Help: "Pool picks that returned ErrPoolEmpty (no eligible member).",
	}, []string{"pool_id"})

	poolCacheHits = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "vici2_pool_cache_hits_total",
		Help: "Pool member cache hits.",
	}, []string{"pool_id"})

	poolCacheReloads = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "vici2_pool_cache_reloads_total",
		Help: "Pool member cache reloads triggered by invalidation or TTL.",
	}, []string{"pool_id"})
)
