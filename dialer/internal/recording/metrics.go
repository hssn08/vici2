package recording

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// recMetrics bundles all Prometheus collectors for the recording package.
// Created once per Recorder and shared for the process lifetime.
// Metric names and labels are frozen per R01 PLAN §7.5.
type recMetrics struct {
	startedTotal    *prometheus.CounterVec
	completedTotal  *prometheus.CounterVec
	failuresTotal   *prometheus.CounterVec
	durationSeconds *prometheus.HistogramVec
	diskUsedPercent *prometheus.GaugeVec
	activeCount     *prometheus.GaugeVec
	pauseTotal      *prometheus.CounterVec
	resumeTotal     *prometheus.CounterVec
}

func newRecMetrics(reg prometheus.Registerer) *recMetrics {
	if reg == nil {
		reg = prometheus.DefaultRegisterer
	}
	factory := promauto.With(reg)
	durationBuckets := []float64{1, 5, 10, 30, 60, 120, 300, 600, 1800, 3600}

	return &recMetrics{
		startedTotal: factory.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_recording_started_total",
			Help: "Total recording sessions started.",
		}, []string{"tenant_id", "campaign_id", "mode"}),

		completedTotal: factory.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_recording_completed_total",
			Help: "Total recording sessions completed (RECORD_STOP received).",
		}, []string{"tenant_id", "campaign_id"}),

		failuresTotal: factory.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_recording_failures_total",
			Help: "Total recording failures by reason.",
		}, []string{"tenant_id", "reason"}),

		durationSeconds: factory.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "vici2_recording_duration_seconds",
			Help:    "Recording duration distribution.",
			Buckets: durationBuckets,
		}, []string{"tenant_id", "campaign_id"}),

		diskUsedPercent: factory.NewGaugeVec(prometheus.GaugeOpts{
			Name: "vici2_recording_disk_used_percent",
			Help: "Fraction (0–1) of recording scratch volume in use.",
		}, []string{"fs_host"}),

		activeCount: factory.NewGaugeVec(prometheus.GaugeOpts{
			Name: "vici2_recording_active_count",
			Help: "Number of calls currently being recorded per tenant.",
		}, []string{"tenant_id"}),

		pauseTotal: factory.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_recording_pause_total",
			Help: "Total PauseRecording (mask) invocations.",
		}, []string{"tenant_id", "actor_role"}),

		resumeTotal: factory.NewCounterVec(prometheus.CounterOpts{
			Name: "vici2_recording_resume_total",
			Help: "Total ResumeRecording (unmask) invocations.",
		}, []string{"tenant_id", "actor_role"}),
	}
}
