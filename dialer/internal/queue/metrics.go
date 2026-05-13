package queue

import (
	"github.com/prometheus/client_golang/prometheus"
)

// Metrics holds all Prometheus metrics for the I01 inbound queue.
// I01 PLAN §21.
type Metrics struct {
	// Gauges
	QueueDepth   *prometheus.GaugeVec
	ReadyAgents  *prometheus.GaugeVec
	EWTSeconds   *prometheus.GaugeVec
	SkillCacheHitRatio prometheus.Gauge

	// Counters
	CallsEntered    *prometheus.CounterVec
	CallsDispatched *prometheus.CounterVec
	CallsAbandoned  *prometheus.CounterVec
	CallsOverflow   *prometheus.CounterVec
	CallsCallback   *prometheus.CounterVec
	DispatchSlow    *prometheus.CounterVec
	DispatcherRecovered *prometheus.CounterVec
	OverflowLoop    *prometheus.CounterVec
	FullBlock       *prometheus.CounterVec
	AgentAutoPause  *prometheus.CounterVec
	StickyWait      *prometheus.CounterVec
	CallbackLookupTimeout *prometheus.CounterVec
	NoAgentsSeconds *prometheus.CounterVec

	// Histograms
	WaitSeconds *prometheus.HistogramVec

	// internal
	skillCacheHits   prometheus.Counter
	skillCacheMisses prometheus.Counter
}

// NewMetrics registers and returns all I01 metrics.
// Pass nil to use the default registry.
func NewMetrics(reg prometheus.Registerer) *Metrics {
	if reg == nil {
		reg = prometheus.DefaultRegisterer
	}
	factory := func(f func() prometheus.Collector) prometheus.Collector {
		c := f()
		reg.MustRegister(c)
		return c
	}

	m := &Metrics{}

	m.QueueDepth = factory(func() prometheus.Collector {
		return prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "vici2_ingroup_queue_depth",
			Help: "Current ZCARD of inbound queue ZSET.",
		}, []string{"ingroup_id"})
	}).(*prometheus.GaugeVec)

	m.ReadyAgents = factory(func() prometheus.Collector {
		return prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "vici2_ingroup_ready_agents",
			Help: "Current ZCARD of ready_agents ZSET.",
		}, []string{"ingroup_id"})
	}).(*prometheus.GaugeVec)

	m.EWTSeconds = factory(func() prometheus.Collector {
		return prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "vici2_ingroup_ewt_seconds",
			Help: "Current EWT for position 1.",
		}, []string{"ingroup_id"})
	}).(*prometheus.GaugeVec)

	m.SkillCacheHitRatio = factory(func() prometheus.Collector {
		return prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "vici2_ingroup_skill_cache_hit_ratio",
			Help: "In-process skill cache hit rate (0-1).",
		})
	}).(prometheus.Gauge)

	m.CallsEntered = factory(func() prometheus.Collector {
		return prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_ingroup_calls_entered_total",
			Help: "Total calls enrolled in inbound queue.",
		}, []string{"ingroup_id"})
	}).(*prometheus.CounterVec)

	m.CallsDispatched = factory(func() prometheus.Collector {
		return prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_ingroup_calls_dispatched_total",
			Help: "Total calls dispatched to agents.",
		}, []string{"ingroup_id"})
	}).(*prometheus.CounterVec)

	m.CallsAbandoned = factory(func() prometheus.Collector {
		return prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_ingroup_calls_abandoned_total",
			Help: "Callers who hung up while waiting.",
		}, []string{"ingroup_id"})
	}).(*prometheus.CounterVec)

	m.CallsOverflow = factory(func() prometheus.Collector {
		return prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_ingroup_calls_overflow_total",
			Help: "Calls exited via overflow action.",
		}, []string{"ingroup_id", "action"})
	}).(*prometheus.CounterVec)

	m.CallsCallback = factory(func() prometheus.Collector {
		return prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_ingroup_calls_callback_total",
			Help: "Callback offers accepted.",
		}, []string{"ingroup_id"})
	}).(*prometheus.CounterVec)

	m.WaitSeconds = factory(func() prometheus.Collector {
		return prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "vici2_ingroup_wait_seconds",
			Help:    "Wait time from queue enter to dispatch.",
			Buckets: prometheus.DefBuckets,
		}, []string{"ingroup_id"})
	}).(*prometheus.HistogramVec)

	m.DispatchSlow = factory(func() prometheus.Collector {
		return prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_ingroup_dispatch_slow_total",
			Help: "Dispatch cycles > 200ms.",
		}, []string{"ingroup_id"})
	}).(*prometheus.CounterVec)

	m.DispatcherRecovered = factory(func() prometheus.Collector {
		return prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_ingroup_dispatcher_recovered_total",
			Help: "Times dispatcher picked up from dead pod.",
		}, []string{"ingroup_id"})
	}).(*prometheus.CounterVec)

	m.OverflowLoop = factory(func() prometheus.Collector {
		return prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_ingroup_overflow_loop_total",
			Help: "Overflow loop hard-stops (hop >= 3).",
		}, []string{"ingroup_id"})
	}).(*prometheus.CounterVec)

	m.FullBlock = factory(func() prometheus.Collector {
		return prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_ingroup_full_block_total",
			Help: "Calls blocked at entry because queue was full.",
		}, []string{"ingroup_id"})
	}).(*prometheus.CounterVec)

	m.AgentAutoPause = factory(func() prometheus.Collector {
		return prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_agent_auto_pause_total",
			Help: "Auto-pauses triggered by reject limit or other automation.",
		}, []string{"reason"})
	}).(*prometheus.CounterVec)

	m.StickyWait = factory(func() prometheus.Collector {
		return prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_ingroup_sticky_wait_total",
			Help: "Sticky-agent wait events for WRAPUP transitions.",
		}, []string{"ingroup_id"})
	}).(*prometheus.CounterVec)

	m.CallbackLookupTimeout = factory(func() prometheus.Collector {
		return prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_callback_lookup_timeout_total",
			Help: "D01 CRM lookups that timed out (> 200ms).",
		}, []string{"ingroup_id"})
	}).(*prometheus.CounterVec)

	m.NoAgentsSeconds = factory(func() prometheus.Collector {
		return prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_ingroup_no_agents_seconds",
			Help: "Seconds with zero ready agents.",
		}, []string{"ingroup_id"})
	}).(*prometheus.CounterVec)

	return m
}
