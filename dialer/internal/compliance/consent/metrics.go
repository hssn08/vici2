package consent

import "github.com/prometheus/client_golang/prometheus"

// consentMetrics holds all Prometheus collectors for the C02 consent gate.
type consentMetrics struct {
	checkTotal    *prometheus.CounterVec
	skippedTotal  *prometheus.CounterVec
	stateMissing  *prometheus.CounterVec
	checkDuration *prometheus.HistogramVec
	auditDropped  *prometheus.CounterVec
	b2bApplied    *prometheus.CounterVec
}

func newMetrics(reg prometheus.Registerer) *consentMetrics {
	m := &consentMetrics{}

	m.checkTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Namespace: "vici2",
		Subsystem: "compliance_consent",
		Name:      "check_total",
		Help:      "Total CheckConsent invocations.",
	}, []string{"decision", "reason", "state_applied"})

	m.skippedTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Namespace: "vici2",
		Subsystem: "compliance_consent",
		Name:      "skipped_total",
		Help:      "CheckConsent calls resulting in SKIP decision.",
	}, []string{"reason"})

	m.stateMissing = prometheus.NewCounterVec(prometheus.CounterOpts{
		Namespace: "vici2",
		Subsystem: "compliance_consent",
		Name:      "state_missing_total",
		Help:      "CheckConsent calls where lead or caller state is unknown. PAGE-severity per O01.",
	}, []string{"side"}) // side ∈ {"lead", "caller"}

	m.checkDuration = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Namespace: "vici2",
		Subsystem: "compliance_consent",
		Name:      "check_duration_seconds",
		Help:      "Latency of CheckConsent() calls. SLO: p99 < 200µs.",
		Buckets:   []float64{0.000001, 0.00001, 0.0001, 0.001},
	}, []string{})

	m.auditDropped = prometheus.NewCounterVec(prometheus.CounterOpts{
		Namespace: "vici2",
		Subsystem: "compliance_consent",
		Name:      "audit_dropped_total",
		Help:      "Consent audit rows dropped due to sink errors or stream full.",
	}, []string{"reason"}) // reason ∈ {"stream_full", "sink_error"}

	m.b2bApplied = prometheus.NewCounterVec(prometheus.CounterOpts{
		Namespace: "vici2",
		Subsystem: "compliance_consent",
		Name:      "b2b_applied_total",
		Help:      "PA B2B carveouts (§5704(15)) applied. Sanity tracking.",
	}, []string{"state"})

	for _, c := range []prometheus.Collector{
		m.checkTotal,
		m.skippedTotal,
		m.stateMissing,
		m.checkDuration,
		m.auditDropped,
		m.b2bApplied,
	} {
		if reg != nil {
			reg.MustRegister(c)
		}
	}
	return m
}
