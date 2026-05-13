package janitor

import "github.com/prometheus/client_golang/prometheus"

// Metrics holds E06 Prometheus collectors.
// E06 PLAN §6.
type Metrics struct {
	StuckChannelsKilled prometheus.Counter
	StaleConfsKilled    prometheus.Counter
	OrphanLocksCleared  prometheus.Counter
	TickDuration        prometheus.Histogram
}

// NewMetrics registers and returns E06 Prometheus metrics.
// If reg is nil, prometheus.DefaultRegisterer is used.
func NewMetrics(reg prometheus.Registerer) *Metrics {
	if reg == nil {
		reg = prometheus.DefaultRegisterer
	}
	m := &Metrics{
		StuckChannelsKilled: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "vici2_janitor_stuck_channels_killed_total",
			Help: "Total call_log rows closed by the janitor sweeper.",
		}),
		StaleConfsKilled: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "vici2_janitor_stale_confs_killed_total",
			Help: "Total FreeSWITCH conferences destroyed by the janitor sweeper.",
		}),
		OrphanLocksCleared: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "vici2_janitor_orphan_locks_cleared_total",
			Help: "Total orphaned in_flight HASH entries and originate_audit rows reaped.",
		}),
		TickDuration: prometheus.NewHistogram(prometheus.HistogramOpts{
			Name:    "vici2_janitor_tick_duration_seconds",
			Help:    "Duration of each janitor sweep tick (leader pod only).",
			Buckets: []float64{0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0},
		}),
	}
	reg.MustRegister(
		m.StuckChannelsKilled,
		m.StaleConfsKilled,
		m.OrphanLocksCleared,
		m.TickDuration,
	)
	return m
}
