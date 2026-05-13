package esl

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// eslMetrics bundles all Prometheus collectors for the esl package.
// One instance is created per Client and shared across all fsConns.
// See T01 PLAN §12 for the full metric table.
type eslMetrics struct {
	connectionStatus       *prometheus.GaugeVec
	reconnectsTotal        *prometheus.CounterVec
	disconnectSecondsTotal *prometheus.CounterVec
	lastHeartbeatSeconds   *prometheus.GaugeVec
	eventsTotal            *prometheus.CounterVec
	eventsDroppedTotal     *prometheus.CounterVec
	eventQueueDepth        *prometheus.GaugeVec
	eventHydrationTotal    *prometheus.CounterVec
	originateTotal         *prometheus.CounterVec
	originateLatency       *prometheus.HistogramVec
	commandTotal           *prometheus.CounterVec
	commandLatency         *prometheus.HistogramVec
	activeJobs             *prometheus.GaugeVec
	jobsOrphanedTotal      *prometheus.CounterVec
	circuitBreakerState    *prometheus.GaugeVec
	rateLimitBlockedTotal  *prometheus.CounterVec
	reconciledCallsTotal   *prometheus.CounterVec
	unaffinedOrigTotal     prometheus.Counter
	streamsXaddTotal       *prometheus.CounterVec
	pubsubPublishTotal     *prometheus.CounterVec
}

func newESLMetrics(reg prometheus.Registerer) *eslMetrics {
	factory := promauto.With(reg)
	latencyBuckets := []float64{0.1, 0.25, 0.5, 1, 2, 5, 10}

	return &eslMetrics{
		connectionStatus: factory.NewGaugeVec(prometheus.GaugeOpts{
			Name: "vici2_esl_connection_status",
			Help: "Per-FS connection health (1=this state is active).",
		}, []string{"fs_host", "state"}),

		reconnectsTotal: factory.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_esl_reconnects_total",
			Help: "Total ESL reconnect attempts per FS host.",
		}, []string{"fs_host"}),

		disconnectSecondsTotal: factory.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_esl_disconnect_seconds_total",
			Help: "Cumulative seconds each FS host was disconnected.",
		}, []string{"fs_host"}),

		lastHeartbeatSeconds: factory.NewGaugeVec(prometheus.GaugeOpts{
			Name: "vici2_esl_last_heartbeat_seconds",
			Help: "Unix timestamp of last received HEARTBEAT per FS host.",
		}, []string{"fs_host"}),

		eventsTotal: factory.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_esl_events_total",
			Help: "Total ESL events received per FS host and event name.",
		}, []string{"fs_host", "event_name"}),

		eventsDroppedTotal: factory.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_esl_events_dropped_total",
			Help: "ESL events dropped due to backpressure.",
		}, []string{"fs_host", "event_name", "reason"}),

		eventQueueDepth: factory.NewGaugeVec(prometheus.GaugeOpts{
			Name: "vici2_esl_event_queue_depth",
			Help: "Current depth of the internal event queue per FS host.",
		}, []string{"fs_host"}),

		eventHydrationTotal: factory.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_esl_event_hydration_total",
			Help: "Event hydration outcomes (ok|miss|partial).",
		}, []string{"result"}),

		originateTotal: factory.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_esl_originate_total",
			Help: "Total originate attempts by outcome.",
		}, []string{"fs_host", "gateway", "outcome"}),

		originateLatency: factory.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "vici2_esl_originate_latency_seconds",
			Help:    "Latency from bgapi originate to BACKGROUND_JOB.",
			Buckets: latencyBuckets,
		}, []string{"fs_host", "outcome"}),

		commandTotal: factory.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_esl_command_total",
			Help: "Total uuid_* / conference / reload commands.",
		}, []string{"fs_host", "cmd", "outcome"}),

		commandLatency: factory.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "vici2_esl_command_latency_seconds",
			Help:    "Command execution latency.",
			Buckets: latencyBuckets,
		}, []string{"fs_host", "cmd"}),

		activeJobs: factory.NewGaugeVec(prometheus.GaugeOpts{
			Name: "vici2_esl_active_jobs",
			Help: "Number of bgapi jobs awaiting BACKGROUND_JOB.",
		}, []string{"fs_host"}),

		jobsOrphanedTotal: factory.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_esl_jobs_orphaned_total",
			Help: "bgapi jobs that timed out without a BACKGROUND_JOB.",
		}, []string{"fs_host"}),

		circuitBreakerState: factory.NewGaugeVec(prometheus.GaugeOpts{
			Name: "vici2_esl_circuit_breaker_state",
			Help: "Circuit breaker state per FS (0=closed,1=half_open,2=open).",
		}, []string{"fs_host"}),

		rateLimitBlockedTotal: factory.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_esl_rate_limit_blocked_total",
			Help: "Token-bucket rejections by kind.",
		}, []string{"fs_host", "gateway", "kind"}),

		reconciledCallsTotal: factory.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_esl_reconciled_calls_total",
			Help: "Calls reconciled on reconnect by action.",
		}, []string{"fs_host", "action"}),

		unaffinedOrigTotal: factory.NewCounter(prometheus.CounterOpts{
			Name: "vici2_esl_unaffined_originate_total",
			Help: "Originate calls without an FSHost set (round-robin fallback).",
		}),

		streamsXaddTotal: factory.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_esl_streams_xadd_total",
			Help: "Valkey Stream XADD attempts by stream and outcome.",
		}, []string{"stream", "outcome"}),

		pubsubPublishTotal: factory.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_esl_pubsub_publish_total",
			Help: "Valkey pub/sub PUBLISH attempts by channel class and outcome.",
		}, []string{"channel_class", "outcome"}),
	}
}
