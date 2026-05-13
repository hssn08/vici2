// metrics.go — all 19 Prometheus metrics for E05. Names are FROZEN.
//
// E05 PLAN §14: vici2_e05_* prefix; {tenant, campaign} base labels.
// No PII in labels — phone_e164 is never a metric label (CI-enforced).
package drop_gate

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// Metrics holds all E05 Prometheus instruments.
// Pass nil in unit tests that do not need metrics.
type Metrics struct {
	// Drop rate gauges (the regulated numbers)
	DropRatePct           *prometheus.GaugeVec
	DropCount30d          *prometheus.GaugeVec
	DropDenominator30d    *prometheus.GaugeVec

	// Gate state gauge (0/1)
	DropGateEngaged *prometheus.GaugeVec

	// Gate engage/release counters
	DropGateEngagementsTotal *prometheus.CounterVec
	DropGateReleasesTotal    *prometheus.CounterVec

	// Cumulative time-based counters
	DropGateSecondsEngagedTotal  *prometheus.CounterVec
	DropSoftCapBreachedSeconds   *prometheus.CounterVec
	DropHardCapBreachedSeconds   *prometheus.CounterVec

	// Per-drop classification
	DropsTotal   *prometheus.CounterVec
	PdropTotal   *prometheus.CounterVec
	SafeHarborAudioPlayFailedTotal *prometheus.CounterVec

	// Reconciler health
	StreamDriftPct         *prometheus.GaugeVec
	StreamSevereDriftTotal *prometheus.CounterVec

	// Latency histograms
	TickerDurationSeconds      *prometheus.HistogramVec
	ReconcilerDurationSeconds  *prometheus.HistogramVec
	DropLogWriteLatencySeconds *prometheus.HistogramVec

	// Config / warmup health
	InvalidConfigTotal *prometheus.CounterVec
	WarmupCampaigns    *prometheus.GaugeVec
}

// NewMetrics registers and returns all E05 Prometheus metrics.
// Pass reg=nil in unit tests to disable registration.
func NewMetrics(reg prometheus.Registerer) *Metrics {
	if reg == nil {
		return nil
	}
	factory := promauto.With(reg)
	latBuckets := []float64{0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1.0}

	return &Metrics{
		DropRatePct: factory.NewGaugeVec(prometheus.GaugeOpts{
			Name: "vici2_e05_drop_rate_pct",
			Help: "Live 30-day rolling abandonment rate in percent (the FCC-regulated number).",
		}, []string{"tenant", "campaign"}),

		DropCount30d: factory.NewGaugeVec(prometheus.GaugeOpts{
			Name: "vici2_e05_drop_count_30d",
			Help: "Numerator: drop_log rows in the last 30 days.",
		}, []string{"tenant", "campaign"}),

		DropDenominator30d: factory.NewGaugeVec(prometheus.GaugeOpts{
			Name: "vici2_e05_drop_denominator_30d",
			Help: "Denominator: live-answered call_log rows in the last 30 days (JOIN statuses WHERE human_answered=TRUE).",
		}, []string{"tenant", "campaign"}),

		DropGateEngaged: factory.NewGaugeVec(prometheus.GaugeOpts{
			Name: "vici2_e05_drop_gate_engaged",
			Help: "1 if the hard-cap gate is currently engaged for this campaign, 0 otherwise.",
		}, []string{"tenant", "campaign"}),

		DropGateEngagementsTotal: factory.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_e05_drop_gate_engagements_total",
			Help: "Number of times the drop gate has been engaged.",
		}, []string{"tenant", "campaign", "source"}),

		DropGateReleasesTotal: factory.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_e05_drop_gate_releases_total",
			Help: "Number of times the drop gate has been released.",
		}, []string{"tenant", "campaign", "source"}),

		DropGateSecondsEngagedTotal: factory.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_e05_drop_gate_seconds_engaged_total",
			Help: "Cumulative seconds the hard gate has been engaged.",
		}, []string{"tenant", "campaign"}),

		DropSoftCapBreachedSeconds: factory.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_e05_drop_soft_cap_breached_seconds",
			Help: "Cumulative seconds the campaign has been in SOFT_BREACH state.",
		}, []string{"tenant", "campaign"}),

		DropHardCapBreachedSeconds: factory.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_e05_drop_hard_cap_breached_seconds",
			Help: "Cumulative seconds the campaign has been in HARD_BREACH state.",
		}, []string{"tenant", "campaign"}),

		DropsTotal: factory.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_e05_drops_total",
			Help: "Per-drop classification counter. No PII in labels.",
		}, []string{"tenant", "campaign", "drop_reason", "safe_harbor_played"}),

		PdropTotal: factory.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_e05_pdrop_total",
			Help: "PDROPs: calls abandoned without safe-harbor audio playing. Each is a § 64.1200(a)(7) per-call violation.",
		}, []string{"tenant", "campaign", "reason"}),

		SafeHarborAudioPlayFailedTotal: factory.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_e05_safe_harbor_audio_play_failed_total",
			Help: "Times safe-harbor audio failed to play on a live-answered call. PAGE on any rate > 0.",
		}, []string{"tenant", "campaign"}),

		StreamDriftPct: factory.NewGaugeVec(prometheus.GaugeOpts{
			Name: "vici2_e05_stream_drift_pct",
			Help: "Reconciler: fractional drift between drop_window STREAM count and drop_log MySQL count (last 30d).",
		}, []string{"tenant", "campaign"}),

		StreamSevereDriftTotal: factory.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_e05_stream_severe_drift_total",
			Help: "Times reconciler detected severe drift (>1%) and applied fail-closed gating.",
		}, []string{"tenant", "campaign"}),

		TickerDurationSeconds: factory.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "vici2_e05_ticker_duration_seconds",
			Help:    "Wall-clock duration of each 15-s ticker cycle.",
			Buckets: latBuckets,
		}, []string{"tenant"}),

		ReconcilerDurationSeconds: factory.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "vici2_e05_reconciler_duration_seconds",
			Help:    "Wall-clock duration of each 60-s reconciler cycle.",
			Buckets: latBuckets,
		}, []string{"tenant"}),

		DropLogWriteLatencySeconds: factory.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "vici2_e05_drop_log_write_latency_seconds",
			Help:    "Latency of per-drop MySQL INSERT + UPDATE transaction.",
			Buckets: latBuckets,
		}, []string{"tenant"}),

		InvalidConfigTotal: factory.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_e05_invalid_config_total",
			Help: "Times a campaign config failed E05 threshold validation.",
		}, []string{"tenant", "campaign", "reason"}),

		WarmupCampaigns: factory.NewGaugeVec(prometheus.GaugeOpts{
			Name: "vici2_e05_warmup_campaigns",
			Help: "Number of campaigns currently in the denominator warmup phase (answered < 100).",
		}, []string{"tenant"}),
	}
}
