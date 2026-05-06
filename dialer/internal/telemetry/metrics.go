// Package telemetry exposes a Prometheus registry per service.
// Naming follows SPEC.md §3.6: vici2_<subsystem>_<unit>.
package telemetry

import (
	"net/http"
	"runtime"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Registry wraps a Prometheus registry plus the base metrics every vici2
// service exposes. Subsystem-specific metrics are added by individual modules
// (e.g. dialer hopper_size, originate_total).
type Registry struct {
	reg *prometheus.Registry

	startTime time.Time
	uptime    prometheus.GaugeFunc

	// Place-holder service metric so /metrics output contains a vici2_*
	// series for the smoke test to grep.
	heartbeat prometheus.Counter

	once sync.Once
}

// NewRegistry returns a Registry with the standard process + go collectors
// plus a vici2_<subsystem>_uptime_seconds gauge and vici2_<subsystem>_heartbeats_total counter.
func NewRegistry(subsystem string) *Registry {
	reg := prometheus.NewRegistry()
	reg.MustRegister(collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))
	reg.MustRegister(collectors.NewGoCollector())

	r := &Registry{
		reg:       reg,
		startTime: time.Now(),
	}
	r.uptime = prometheus.NewGaugeFunc(prometheus.GaugeOpts{
		Namespace: "vici2",
		Subsystem: subsystem,
		Name:      "uptime_seconds",
		Help:      "Seconds since the service process started.",
	}, func() float64 { return time.Since(r.startTime).Seconds() })

	r.heartbeat = prometheus.NewCounter(prometheus.CounterOpts{
		Namespace: "vici2",
		Subsystem: subsystem,
		Name:      "heartbeats_total",
		Help:      "Total /metrics scrapes observed (increments on each Handler invocation).",
	})

	reg.MustRegister(r.uptime)
	reg.MustRegister(r.heartbeat)
	return r
}

// Handler returns an HTTP handler suitable for /metrics.
func (r *Registry) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		r.heartbeat.Inc()
		promhttp.HandlerFor(r.reg, promhttp.HandlerOpts{}).ServeHTTP(w, req)
	})
}

// Reg returns the underlying Prometheus registry for module-specific metrics.
func (r *Registry) Reg() *prometheus.Registry {
	return r.reg
}

// silence "imported and not used" if the file is trimmed; ensures runtime import remains valid in expansions.
var _ = runtime.Version
