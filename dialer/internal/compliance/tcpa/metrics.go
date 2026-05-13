package tcpa

import "github.com/prometheus/client_golang/prometheus"

// tcpaMetrics holds all Prometheus collectors for the C01 TCPA gate.
type tcpaMetrics struct {
	checkTotal       *prometheus.CounterVec
	outsideWindow    *prometheus.CounterVec
	boundaryAdvisory *prometheus.CounterVec
	checkDuration    *prometheus.HistogramVec
	auditDropped     *prometheus.CounterVec
	calendarAge      prometheus.GaugeFunc
}

func newMetrics(reg prometheus.Registerer, hc *HolidayCalendar) *tcpaMetrics {
	m := &tcpaMetrics{}

	m.checkTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Namespace: "vici2",
		Subsystem: "compliance_tcpa",
		Name:      "check_total",
		Help:      "Total TCPA window check invocations.",
	}, []string{"outcome", "reason", "enforcement_point", "state"})

	m.outsideWindow = prometheus.NewCounterVec(prometheus.CounterOpts{
		Namespace: "vici2",
		Subsystem: "compliance_tcpa",
		Name:      "outside_window_total",
		Help:      "Non-ALLOW results at the originate enforcement point (SEV1 trigger).",
	}, []string{"enforcement_point", "reason", "state"})

	m.boundaryAdvisory = prometheus.NewCounterVec(prometheus.CounterOpts{
		Namespace: "vici2",
		Subsystem: "compliance_tcpa",
		Name:      "boundary_advisory_total",
		Help:      "WindowClosesWithin advisory true returns.",
	}, []string{"kind", "state"})

	m.checkDuration = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Namespace: "vici2",
		Subsystem: "compliance_tcpa",
		Name:      "check_duration_seconds",
		Help:      "Latency of Check() calls.",
		Buckets:   []float64{0.000001, 0.00001, 0.0001, 0.001, 0.01},
	}, []string{"enforcement_point"})

	m.auditDropped = prometheus.NewCounterVec(prometheus.CounterOpts{
		Namespace: "vici2",
		Subsystem: "compliance_tcpa",
		Name:      "audit_dropped_total",
		Help:      "Audit rows dropped due to sink errors or stream full.",
	}, []string{"reason"})

	m.calendarAge = prometheus.NewGaugeFunc(prometheus.GaugeOpts{
		Namespace: "vici2",
		Subsystem: "compliance_tcpa",
		Name:      "holiday_calendar_age_seconds",
		Help:      "Seconds since the holiday calendar was last refreshed.",
	}, hc.AgeSeconds)

	for _, c := range []prometheus.Collector{
		m.checkTotal,
		m.outsideWindow,
		m.boundaryAdvisory,
		m.checkDuration,
		m.auditDropped,
		m.calendarAge,
	} {
		if reg != nil {
			reg.MustRegister(c)
		}
	}
	return m
}
