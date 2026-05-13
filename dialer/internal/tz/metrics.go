package tz

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// D03 Prometheus metrics — names are frozen per PLAN §11.
var (
	// vici2_tz_resolve_total{confidence, source_tier}
	tzResolveTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "vici2_tz_resolve_total",
		Help: "Total timezone resolutions by confidence level and source tier.",
	}, []string{"confidence", "source_tier"})

	// vici2_tz_resolve_duration_seconds{source_tier}
	tzResolveDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "vici2_tz_resolve_duration_seconds",
		Help:    "Latency of timezone resolution by source tier. SLO: p99 < 1ms.",
		Buckets: []float64{1e-7, 1e-6, 1e-5, 1e-4, 1e-3, 1e-2},
	}, []string{"source_tier"})

	// vici2_tz_split_state_collisions_total{state, npa}
	tzSplitStateCollisions = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "vici2_tz_split_state_collisions_total",
		Help: "NPA fallback on a known split state — indicates seed gap. Alert > 100/day.",
	}, []string{"state", "npa"})

	// vici2_tz_unknown_total{reason}
	tzUnknownTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "vici2_tz_unknown_total",
		Help: "Total NONE outcomes by reason.",
	}, []string{"reason"})

	// vici2_tz_cache_size{cache}
	tzCacheSize = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "vici2_tz_cache_size",
		Help: "Number of entries in each in-process cache.",
	}, []string{"cache"})

	// vici2_tz_cache_hits_total{cache}
	tzCacheHits = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "vici2_tz_cache_hits_total",
		Help: "Cache hits by cache name.",
	}, []string{"cache"})

	// vici2_tz_cache_misses_total{cache}
	tzCacheMisses = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "vici2_tz_cache_misses_total",
		Help: "Cache misses by cache name.",
	}, []string{"cache"})

	// vici2_tz_invalidations_total{reason}
	tzInvalidations = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "vici2_tz_invalidations_total",
		Help: "Cache invalidation events by reason.",
	}, []string{"reason"})

	// vici2_tz_phone_codes_loaded
	tzPhoneCodesLoaded = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "vici2_tz_phone_codes_loaded",
		Help: "Number of NXX entries currently loaded in process map.",
	})

	// vici2_tz_phone_codes_age_seconds
	tzPhoneCodesAge = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "vici2_tz_phone_codes_age_seconds",
		Help: "Seconds since last phone_codes map load. Alert > 86400.",
	})

	// vici2_tz_parse_panics_total — bonus safety metric
	tzParsePanics = promauto.NewCounter(prometheus.CounterOpts{
		Name: "vici2_tz_parse_panics_total",
		Help: "Panics recovered from phonenumbers.Parse (should be zero).",
	})
)

// recordResolve records a resolve outcome to metrics.
func recordResolve(conf Confidence, tier string) {
	tzResolveTotal.WithLabelValues(string(conf), tier).Inc()
}
