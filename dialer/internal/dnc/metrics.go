package dnc

import (
	"github.com/prometheus/client_golang/prometheus"
)

// Metrics holds the Prometheus metrics for the DNC module (PLAN §11.1).
type Metrics struct {
	CheckTotal          *prometheus.CounterVec
	CheckLatency        *prometheus.HistogramVec
	FalsePositiveTotal  *prometheus.CounterVec
	BloomUnavailable    *prometheus.GaugeVec
	BloomInProcessActive *prometheus.GaugeVec
	BloomRebuilding     *prometheus.GaugeVec
	BypassTotal         *prometheus.CounterVec
	SyncLastSuccess     *prometheus.GaugeVec
	SyncFailuresTotal   *prometheus.CounterVec
}

// NewMetrics registers DNC metrics into the provided Prometheus registry.
func NewMetrics(reg prometheus.Registerer) *Metrics {
	m := &Metrics{
		CheckTotal: prometheus.NewCounterVec(
			prometheus.CounterOpts{
				Name: "vici2_dnc_check_total",
				Help: "DNC check outcomes by source.",
			},
			[]string{"source", "outcome"},
		),
		CheckLatency: prometheus.NewHistogramVec(
			prometheus.HistogramOpts{
				Name:    "vici2_dnc_check_latency_seconds",
				Help:    "DNC check latency.",
				Buckets: []float64{.0005, .001, .002, .005, .01, .025, .05, .1},
			},
			[]string{"source"},
		),
		FalsePositiveTotal: prometheus.NewCounterVec(
			prometheus.CounterOpts{
				Name: "vici2_dnc_false_positive_total",
				Help: "Bloom false positives by source.",
			},
			[]string{"source"},
		),
		BloomUnavailable: prometheus.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "vici2_dnc_bloom_unavailable",
				Help: "1 if Bloom is unavailable for a source.",
			},
			[]string{"source"},
		),
		BloomInProcessActive: prometheus.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "vici2_dnc_bloom_inprocess_active",
				Help: "1 if in-process Bloom fallback is active.",
			},
			[]string{"source"},
		),
		BloomRebuilding: prometheus.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "vici2_dnc_bloom_rebuilding",
				Help: "1 if Bloom is rebuilding from MySQL.",
			},
			[]string{"source"},
		),
		BypassTotal: prometheus.NewCounterVec(
			prometheus.CounterOpts{
				Name: "vici2_dnc_bypass_total",
				Help: "DNC bypass outcomes.",
			},
			[]string{"user_role", "outcome"},
		),
		SyncLastSuccess: prometheus.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "vici2_dnc_sync_last_success_timestamp",
				Help: "Unix timestamp of last successful sync.",
			},
			[]string{"source"},
		),
		SyncFailuresTotal: prometheus.NewCounterVec(
			prometheus.CounterOpts{
				Name: "vici2_dnc_sync_failures_total",
				Help: "DNC sync failures by source and kind.",
			},
			[]string{"source", "kind"},
		),
	}

	reg.MustRegister(
		m.CheckTotal,
		m.CheckLatency,
		m.FalsePositiveTotal,
		m.BloomUnavailable,
		m.BloomInProcessActive,
		m.BloomRebuilding,
		m.BypassTotal,
		m.SyncLastSuccess,
		m.SyncFailuresTotal,
	)
	return m
}
