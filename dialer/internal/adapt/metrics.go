// E03 is a clean-room Go port of Vicidial AST_VDadapt.pl (public GPL source,
// in source control since at least 2008 per inktel/Vicidial git history).
// Improvements: explicit anti-windup (back-calculation), deadband, drop_gated fast-cut.
// Prior art documented per SPEC patent-defense protocol.

package adapt

import (
	"strconv"

	"github.com/prometheus/client_golang/prometheus"
)

// Metrics holds all Prometheus instruments for E03 (PLAN §13.1 — 20 metrics).
type Metrics struct {
	TickTotal            *prometheus.CounterVec
	TickSkippedTotal     *prometheus.CounterVec
	ActionTotal          *prometheus.CounterVec
	DialLevel            *prometheus.GaugeVec
	DropPct30d           *prometheus.GaugeVec
	IntegralTerm         *prometheus.GaugeVec
	ClampActiveSeconds   *prometheus.CounterVec
	WarmupActive         *prometheus.GaugeVec
	WarmupCallsRemaining *prometheus.GaugeVec
	FastCutTotal         *prometheus.CounterVec
	DropGatedDebounce    *prometheus.CounterVec
	DropGatedFlap        *prometheus.CounterVec
	TickDuration         *prometheus.HistogramVec
	NoopWriteTotal       *prometheus.CounterVec
	ExternalOverride     *prometheus.CounterVec
	ColdStartTotal       *prometheus.CounterVec
	RestartTotal         *prometheus.CounterVec
	DropPctMissing       *prometheus.CounterVec
	IntegralRunaway      *prometheus.CounterVec
	ConfigInvalid        *prometheus.CounterVec
}

// NewMetrics registers all E03 Prometheus metrics with the given registerer.
func NewMetrics(reg prometheus.Registerer) *Metrics {
	labels := []string{"tenant", "campaign"}

	m := &Metrics{
		TickTotal: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_adapt_tick_total",
			Help: "Total completed adapt outer ticks per campaign.",
		}, labels),

		TickSkippedTotal: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_adapt_tick_skipped_total",
			Help: "Adapt ticks skipped (lock_contention|warm_up|valkey_down|drop_pct_missing|campaign_paused).",
		}, append(labels, "reason")),

		ActionTotal: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_adapt_action_total",
			Help: "Adapt actions taken per campaign (raise|lower_soft|lower_hard|hold|fast_cut|warm_up).",
		}, append(labels, "action")),

		DialLevel: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "vici2_adapt_dial_level",
			Help: "Current dial_level published by E03.",
		}, labels),

		DropPct30d: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "vici2_adapt_drop_pct_30d",
			Help: "Echo of E05 drop_pct_30d for dashboard co-location.",
		}, labels),

		IntegralTerm: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "vici2_adapt_integral_term",
			Help: "Current PI integral term (debug).",
		}, labels),

		ClampActiveSeconds: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_adapt_clamp_active_seconds",
			Help: "Seconds spent at output clamp boundary (ceiling|floor).",
		}, append(labels, "side")),

		WarmupActive: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "vici2_adapt_warmup_active",
			Help: "1 during warm-up gate; 0 after.",
		}, labels),

		WarmupCallsRemaining: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "vici2_adapt_warmup_calls_remaining",
			Help: "Answered-call countdown to warm-up exit.",
		}, labels),

		FastCutTotal: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_adapt_fast_cut_total",
			Help: "Fast-cut events acted on (drop_gated_changed → dial_level=1.0).",
		}, labels),

		DropGatedDebounce: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_adapt_drop_gated_debounce_total",
			Help: "Fast-cuts skipped by debounce window.",
		}, labels),

		DropGatedFlap: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_adapt_drop_gated_flap_total",
			Help: "drop_gated flap detection activations (>3 flips/min).",
		}, labels),

		TickDuration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "vici2_adapt_tick_duration_seconds",
			Help:    "Wall time per adapt tick.",
			Buckets: []float64{0.0001, 0.001, 0.01, 0.1, 1.0},
		}, labels),

		NoopWriteTotal: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_adapt_noop_write_total",
			Help: "Ticks where NeedsWrite=false (quantized level unchanged).",
		}, labels),

		ExternalOverride: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_adapt_external_override_total",
			Help: "Admin wrote dial_level outside E03.",
		}, labels),

		ColdStartTotal: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_adapt_cold_start_total",
			Help: "pace_state HGETALL returned empty (true cold-start).",
		}, labels),

		RestartTotal: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_adapt_restart_total",
			Help: "Hot-restart (pace_state present on startup).",
		}, labels),

		DropPctMissing: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_adapt_drop_pct_missing_total",
			Help: "Ticks where E05 drop_pct_30d key was absent.",
		}, labels),

		IntegralRunaway: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_adapt_integral_runaway_total",
			Help: "Detections of |integral| > IMax×1.5 (back-calc failure).",
		}, labels),

		ConfigInvalid: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_adapt_config_invalid_total",
			Help: "Config validation failures per field.",
		}, append(labels, "field")),
	}

	reg.MustRegister(
		m.TickTotal, m.TickSkippedTotal, m.ActionTotal,
		m.DialLevel, m.DropPct30d, m.IntegralTerm,
		m.ClampActiveSeconds, m.WarmupActive, m.WarmupCallsRemaining,
		m.FastCutTotal, m.DropGatedDebounce, m.DropGatedFlap,
		m.TickDuration, m.NoopWriteTotal, m.ExternalOverride,
		m.ColdStartTotal, m.RestartTotal, m.DropPctMissing,
		m.IntegralRunaway, m.ConfigInvalid,
	)
	return m
}

// Labels returns the tenant+campaign label values.
func Labels(tid, cid int64) prometheus.Labels {
	return prometheus.Labels{
		"tenant":   strconv.FormatInt(tid, 10),
		"campaign": strconv.FormatInt(cid, 10),
	}
}
