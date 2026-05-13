package routing

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// routingMetrics holds all Prometheus collectors for the routing package.
// T02 PLAN §14.8 metric names.
type routingMetrics struct {
	// vici2_carrier_health_status{tenant, gateway, carrier_kind, state} — 0/1.
	healthStatus *prometheus.GaugeVec

	// vici2_carrier_active_calls{tenant, gateway, carrier_kind} — live concurrency.
	activeCalls *prometheus.GaugeVec

	// vici2_carrier_counter_drift_total{gateway, direction(over|under)}.
	counterDrift *prometheus.CounterVec

	// vici2_carrier_options_ping_seconds{tenant, gateway, carrier_kind} — OPTIONS RTT histogram.
	optionsPing *prometheus.HistogramVec

	// vici2_carrier_ping_stuck_total{gateway} — TLS ping-stuck watchdog fires.
	pingStuck *prometheus.CounterVec
}

// Metrics is the exported handle for the routing package metrics.
// Constructed once per process via NewMetrics().
type Metrics struct {
	m *routingMetrics
}

// NewMetrics registers and returns the routing Prometheus collectors.
// reg may be nil (uses prometheus.DefaultRegisterer).
func NewMetrics(reg prometheus.Registerer) *Metrics {
	if reg == nil {
		reg = prometheus.DefaultRegisterer
	}
	f := promauto.With(reg)
	return &Metrics{m: &routingMetrics{
		healthStatus: f.NewGaugeVec(prometheus.GaugeOpts{
			Name: "vici2_carrier_health_status",
			Help: "Gateway health: 1=healthy, 0=unhealthy. T02 PLAN §14.8.",
		}, []string{"tenant", "gateway", "carrier_kind", "state"}),

		activeCalls: f.NewGaugeVec(prometheus.GaugeOpts{
			Name: "vici2_carrier_active_calls",
			Help: "Live concurrent active calls per gateway from Valkey counter. T02 PLAN §14.8.",
		}, []string{"tenant", "gateway", "carrier_kind"}),

		counterDrift: f.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_carrier_counter_drift_total",
			Help: "Reconciler corrections when Valkey counter drifts from FS truth. T02 PLAN §14.8.",
		}, []string{"gateway", "direction"}),

		optionsPing: f.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "vici2_carrier_options_ping_seconds",
			Help:    "OPTIONS RTT measured by FS ping. T02 PLAN §14.8.",
			Buckets: []float64{0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0},
		}, []string{"tenant", "gateway", "carrier_kind"}),

		pingStuck: f.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_carrier_ping_stuck_total",
			Help: "TLS ping-stuck watchdog auto-killgw+rescan fires. T02 PLAN §14.8.",
		}, []string{"gateway"}),
	}}
}

// ObserveHealth updates health status gauge and OPTIONS ping histogram.
func (m *Metrics) ObserveHealth(tenant, gateway, kind string, gh GatewayHealth) {
	if m == nil || m.m == nil {
		return
	}
	v := 0.0
	if gh.Healthy {
		v = 1.0
	}
	m.m.healthStatus.WithLabelValues(tenant, gateway, kind, string(gh.State)).Set(v)
	if gh.PingMS > 0 {
		m.m.optionsPing.WithLabelValues(tenant, gateway, kind).Observe(gh.PingMS / 1000.0)
	}
}

// ObserveActiveCalls updates the active-calls gauge.
func (m *Metrics) ObserveActiveCalls(tenant, gateway, kind string, count int64) {
	if m == nil || m.m == nil {
		return
	}
	m.m.activeCalls.WithLabelValues(tenant, gateway, kind).Set(float64(count))
}

// IncCounterDrift increments the counter-drift counter.
// direction should be "over" or "under". T02 PLAN §10.3.
func (m *Metrics) IncCounterDrift(gateway, direction string) {
	if m == nil || m.m == nil {
		return
	}
	m.m.counterDrift.WithLabelValues(gateway, direction).Inc()
}

// IncPingStuck increments the ping-stuck watchdog counter. T02 PLAN §11.3.
func (m *Metrics) IncPingStuck(gateway string) {
	if m == nil || m.m == nil {
		return
	}
	m.m.pingStuck.WithLabelValues(gateway).Inc()
}
