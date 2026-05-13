package originate

import "github.com/prometheus/client_golang/prometheus"

// Metrics holds all T04 Prometheus collectors.
// All metric names are prefixed vici2_t04_ (T04 PLAN §12).
type Metrics struct {
	// vici2_t04_originate_total{tenant,campaign,mode,outcome}
	OriginateTotal *prometheus.CounterVec

	// vici2_t04_compliance_blocked_total{gate,sub_reason}
	ComplianceBlockedTotal *prometheus.CounterVec

	// vici2_t04_gate_duration_seconds{gate}
	GateDuration *prometheus.HistogramVec

	// vici2_t04_audit_insert_latency_seconds
	AuditInsertLatency prometheus.Histogram

	// vici2_t04_idempotent_replays_total{mode}
	IdempotentReplaysTotal *prometheus.CounterVec

	// vici2_t04_dnc_bypass_token_redeemed_total{actor_user_id}
	DNCBypassTokenRedeemedTotal *prometheus.CounterVec

	// vici2_t04_inflight
	Inflight prometheus.Gauge

	// vici2_t04_local_presence_miss_total{npa_nxx}
	LocalPresenceMissTotal *prometheus.CounterVec

	// vici2_t04_carrier_fail_total{fs_host,reason}
	CarrierFailTotal *prometheus.CounterVec
}

var gateDurationBuckets = []float64{0.0001, 0.0005, 0.001, 0.005, 0.01, 0.05, 0.1, 1}

// NewMetrics registers all T04 collectors on reg (nil = default prometheus.DefaultRegisterer).
func NewMetrics(reg prometheus.Registerer) *Metrics {
	if reg == nil {
		reg = prometheus.DefaultRegisterer
	}
	m := &Metrics{
		OriginateTotal: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_t04_originate_total",
			Help: "Total T04 originate attempts by tenant/campaign/mode/outcome.",
		}, []string{"tenant", "campaign", "mode", "outcome"}),

		ComplianceBlockedTotal: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_t04_compliance_blocked_total",
			Help: "T04 compliance gate blocks by gate/sub_reason.",
		}, []string{"gate", "sub_reason"}),

		GateDuration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "vici2_t04_gate_duration_seconds",
			Help:    "Per-gate evaluation latency.",
			Buckets: gateDurationBuckets,
		}, []string{"gate"}),

		AuditInsertLatency: prometheus.NewHistogram(prometheus.HistogramOpts{
			Name:    "vici2_t04_audit_insert_latency_seconds",
			Help:    "originate_audit INSERT+UPDATE latency.",
			Buckets: gateDurationBuckets,
		}),

		IdempotentReplaysTotal: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_t04_idempotent_replays_total",
			Help: "T04 idempotent replays (same attempt_uuid returned cached result).",
		}, []string{"mode"}),

		DNCBypassTokenRedeemedTotal: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_t04_dnc_bypass_token_redeemed_total",
			Help: "DNC bypass token redemptions by actor_user_id.",
		}, []string{"actor_user_id"}),

		Inflight: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "vici2_t04_inflight",
			Help: "Count of originate_audit rows with outcome=OTHER (in-flight calls).",
		}),

		LocalPresenceMissTotal: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_t04_local_presence_miss_total",
			Help: "X05 local-presence pool misses by NPA-NXX prefix.",
		}, []string{"npa_nxx"}),

		CarrierFailTotal: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_t04_carrier_fail_total",
			Help: "T01 transport failures by fs_host and reason.",
		}, []string{"fs_host", "reason"}),
	}

	reg.MustRegister(
		m.OriginateTotal,
		m.ComplianceBlockedTotal,
		m.GateDuration,
		m.AuditInsertLatency,
		m.IdempotentReplaysTotal,
		m.DNCBypassTokenRedeemedTotal,
		m.Inflight,
		m.LocalPresenceMissTotal,
		m.CarrierFailTotal,
	)
	return m
}
