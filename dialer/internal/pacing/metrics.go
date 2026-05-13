// metrics.go — all 20 Prometheus metrics for E02.
//
// E02 PLAN §14.1: vici2_dialer_pacing_* prefix; {tenant,campaign} base labels.
// All metrics registered once at construction time; nil-safe (tests without
// Prometheus pass nil *Metrics, which is guarded in decision.go + publish.go).
package pacing

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// Metrics holds all E02 Prometheus instruments.
type Metrics struct {
	// Tick lifecycle
	TickTotal       *prometheus.CounterVec
	TickSkipped     *prometheus.CounterVec
	TickDuration    *prometheus.HistogramVec
	TickOverrun     *prometheus.CounterVec

	// Decision values (gauges, overwritten each tick)
	Desired      *prometheus.GaugeVec
	Agents       *prometheus.GaugeVec
	ActiveCalls  *prometheus.GaugeVec
	DialLevel    *prometheus.GaugeVec

	// Clamp counters
	ClampTotal *prometheus.CounterVec

	// Gate / saturation accumulators
	DropGatedSecondsTotal     *prometheus.CounterVec
	CarrierSaturatedSecsTotal *prometheus.CounterVec

	// Output
	DispatchTokensWrittenTotal *prometheus.CounterVec
	DispatchTokensValue        *prometheus.GaugeVec

	// Reliability
	GoroutinePanicTotal *prometheus.CounterVec

	// Input-quality
	AgentStateStaleTotal     *prometheus.CounterVec
	DialLevelMissingTotal    *prometheus.CounterVec
	DialLevelOutOfRangeTotal *prometheus.CounterVec
	GWActiveMissingTotal     *prometheus.CounterVec
	ConfigInvalidTotal       *prometheus.CounterVec
	ClockSkewSeconds         *prometheus.GaugeVec
}

// NewMetrics registers and returns all E02 Prometheus metrics.
// Pass reg=nil in unit tests to disable registration.
func NewMetrics(reg prometheus.Registerer) *Metrics {
	if reg == nil {
		return nil
	}
	factory := promauto.With(reg)

	tickBuckets := []float64{0.0001, 0.001, 0.01, 0.1, 0.2, 1.0}

	return &Metrics{
		TickTotal: factory.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_dialer_pacing_tick_total",
			Help: "Total pacing ticks attempted (all outcomes) per campaign.",
		}, []string{"tenant", "campaign"}),

		TickSkipped: factory.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_dialer_pacing_tick_skipped_total",
			Help: "Pacing ticks that were no-ops, labelled by reason.",
		}, []string{"tenant", "campaign", "reason"}),

		TickDuration: factory.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "vici2_dialer_pacing_tick_duration_seconds",
			Help:    "Wall-clock duration of each successful pacing tick. SLO: p99 < 200 ms.",
			Buckets: tickBuckets,
		}, []string{"tenant", "campaign"}),

		TickOverrun: factory.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_dialer_pacing_tick_overrun_total",
			Help: "Pacing ticks that exceeded the 200 ms soft deadline.",
		}, []string{"tenant", "campaign"}),

		Desired: factory.NewGaugeVec(prometheus.GaugeOpts{
			Name: "vici2_dialer_pacing_desired",
			Help: "Last tick's desired_new_originates after all 4 clamps.",
		}, []string{"tenant", "campaign"}),

		Agents: factory.NewGaugeVec(prometheus.GaugeOpts{
			Name: "vici2_dialer_pacing_agents",
			Help: "Last tick's agent count by status.",
		}, []string{"tenant", "campaign", "status"}),

		ActiveCalls: factory.NewGaugeVec(prometheus.GaugeOpts{
			Name: "vici2_dialer_pacing_active_calls",
			Help: "Last tick's SCARD of active_calls SET.",
		}, []string{"tenant", "campaign"}),

		DialLevel: factory.NewGaugeVec(prometheus.GaugeOpts{
			Name: "vici2_dialer_pacing_dial_level",
			Help: "Last tick's resolved dial_level value.",
		}, []string{"tenant", "campaign"}),

		ClampTotal: factory.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_dialer_pacing_clamp_total",
			Help: "Per-clamp fire count (all firing clamps counted, not just the binding one).",
		}, []string{"tenant", "campaign", "clamp"}),

		DropGatedSecondsTotal: factory.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_dialer_pacing_drop_gated_seconds_total",
			Help: "Cumulative seconds campaign was drop-gated by E05.",
		}, []string{"tenant", "campaign"}),

		CarrierSaturatedSecsTotal: factory.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_dialer_pacing_carrier_saturated_seconds_total",
			Help: "Cumulative seconds gateway headroom was zero.",
		}, []string{"tenant", "campaign"}),

		DispatchTokensWrittenTotal: factory.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_dialer_pacing_dispatch_tokens_written_total",
			Help: "Successful SET dispatch_tokens writes to Valkey.",
		}, []string{"tenant", "campaign"}),

		DispatchTokensValue: factory.NewGaugeVec(prometheus.GaugeOpts{
			Name: "vici2_dialer_pacing_dispatch_tokens_value",
			Help: "Last written dispatch_tokens value.",
		}, []string{"tenant", "campaign"}),

		GoroutinePanicTotal: factory.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_dialer_pacing_goroutine_panic_total",
			Help: "Per-campaign goroutine panic count.",
		}, []string{"tenant", "campaign"}),

		AgentStateStaleTotal: factory.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_dialer_agent_state_stale_total",
			Help: "Agent ZSET score observations older than 15 s.",
		}, []string{"tenant", "campaign"}),

		DialLevelMissingTotal: factory.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_dialer_dial_level_missing_total",
			Help: "Ticks where dial_level STRING was absent from Valkey.",
		}, []string{"tenant", "campaign"}),

		DialLevelOutOfRangeTotal: factory.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_dialer_dial_level_out_of_range_total",
			Help: "Ticks where dial_level exceeded adaptive_max_level.",
		}, []string{"tenant", "campaign"}),

		GWActiveMissingTotal: factory.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_dialer_gw_active_missing_total",
			Help: "Ticks where a gateway active counter was absent.",
		}, []string{"tenant", "campaign", "gateway_id"}),

		ConfigInvalidTotal: factory.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_dialer_config_invalid_total",
			Help: "Config validation failures at process-cache refresh.",
		}, []string{"tenant", "campaign", "field"}),

		ClockSkewSeconds: factory.NewGaugeVec(prometheus.GaugeOpts{
			Name: "vici2_dialer_clock_skew_seconds",
			Help: "Clock skew estimate between pods (via tick-lock winner distribution).",
		}, []string{"tenant", "campaign"}),
	}
}
