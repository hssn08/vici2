package picker

import (
	"github.com/prometheus/client_golang/prometheus"
)

// Metrics holds all 16 Prometheus metrics for the picker package.
// See PLAN §13.1 for the full metric set and §13.2 for alert rules.
type Metrics struct {
	// vici2_picker_dispatch_total — all dispatches by outcome.
	DispatchTotal *prometheus.CounterVec

	// vici2_picker_claim_total — result: success|empty_hopper|lead_lock_collision|error
	ClaimTotal *prometheus.CounterVec

	// vici2_picker_no_ready_agent_total — PROGRESSIVE skipped — no READY agent.
	NoReadyAgent *prometheus.CounterVec

	// vici2_picker_pick_latency_seconds — phase: claim|pick_agent|t04|total
	PickLatency *prometheus.HistogramVec

	// vici2_picker_retry_total — recycled: true|false
	RetryTotal *prometheus.CounterVec

	// vici2_picker_callback_dispatched_total
	CallbackDispatched *prometheus.CounterVec

	// vici2_picker_predictive_answered_total
	PredictiveAnswered *prometheus.CounterVec

	// vici2_picker_predictive_drop_total — reason: no_agent|agent_transfer_failed|agent_logged_out
	PredictiveDrop *prometheus.CounterVec

	// vici2_picker_amd_action_total — action: drop|transfer|message|park
	AMDAction *prometheus.CounterVec

	// vici2_picker_tokens_consumed_total
	TokensConsumed *prometheus.CounterVec

	// vici2_picker_tokens_over_decremented_total
	TokensOverDecremented *prometheus.CounterVec

	// vici2_picker_token_leaked_total — T04 deadline timeout; token not restored.
	TokenLeaked *prometheus.CounterVec

	// vici2_picker_orphaned_claim_total — E06 janitor reaped orphan.
	OrphanedClaim *prometheus.CounterVec

	// vici2_picker_active_inflight — gauge: HLEN of in_flight HASH.
	ActiveInFlight *prometheus.GaugeVec

	// vici2_picker_answer_handler_latency_seconds — XREADGROUP→UUIDTransfer.
	AnswerHandlerLatency *prometheus.HistogramVec

	// vici2_picker_valkey_unavailable_seconds — seconds Valkey unreachable.
	ValkeyUnavailableSecs *prometheus.GaugeVec
}

// NewMetrics registers all picker Prometheus metrics on the given registerer.
// Pass prometheus.DefaultRegisterer for production; prometheus.NewRegistry()
// for isolated tests.
func NewMetrics() *Metrics {
	return NewMetricsWithRegisterer(prometheus.DefaultRegisterer)
}

// NewMetricsWithRegisterer registers all picker metrics on reg.
// Tests should pass a fresh prometheus.NewRegistry() to avoid duplicate
// registration panics.
func NewMetricsWithRegisterer(reg prometheus.Registerer) *Metrics {
	pickerBuckets := []float64{0.001, 0.01, 0.1, 1.0}
	answerBuckets := []float64{0.01, 0.05, 0.1, 0.25, 0.5, 2.0}

	newCounter := func(name, help string, labels []string) *prometheus.CounterVec {
		c := prometheus.NewCounterVec(prometheus.CounterOpts{Name: name, Help: help}, labels)
		reg.MustRegister(c)
		return c
	}
	newHisto := func(name, help string, buckets []float64, labels []string) *prometheus.HistogramVec {
		h := prometheus.NewHistogramVec(prometheus.HistogramOpts{Name: name, Help: help, Buckets: buckets}, labels)
		reg.MustRegister(h)
		return h
	}
	newGauge := func(name, help string, labels []string) *prometheus.GaugeVec {
		g := prometheus.NewGaugeVec(prometheus.GaugeOpts{Name: name, Help: help}, labels)
		reg.MustRegister(g)
		return g
	}

	return &Metrics{
		DispatchTotal: newCounter(
			"vici2_picker_dispatch_total",
			"Total dispatch attempts by tenant, campaign, mode, and outcome.",
			[]string{"tenant", "campaign", "mode", "outcome"},
		),
		ClaimTotal: newCounter(
			"vici2_picker_claim_total",
			"Total hopper claim attempts by tenant, campaign, and result.",
			[]string{"tenant", "campaign", "result"},
		),
		NoReadyAgent: newCounter(
			"vici2_picker_no_ready_agent_total",
			"Dispatches skipped because no READY agent was available.",
			[]string{"tenant", "campaign", "reason"},
		),
		PickLatency: newHisto(
			"vici2_picker_pick_latency_seconds",
			"Dispatch latency by phase: claim|pick_agent|t04|total.",
			pickerBuckets,
			[]string{"tenant", "campaign", "mode", "phase"},
		),
		RetryTotal: newCounter(
			"vici2_picker_retry_total",
			"Leads released for retry, by outcome and requeue decision.",
			[]string{"tenant", "campaign", "outcome", "recycled"},
		),
		CallbackDispatched: newCounter(
			"vici2_picker_callback_dispatched_total",
			"Callback leads dispatched (IsCallback=true in hopper entry).",
			[]string{"tenant", "campaign"},
		),
		PredictiveAnswered: newCounter(
			"vici2_picker_predictive_answered_total",
			"PREDICTIVE customer answers received by the answer handler.",
			[]string{"tenant", "campaign"},
		),
		PredictiveDrop: newCounter(
			"vici2_picker_predictive_drop_total",
			"PREDICTIVE calls dropped (no agent or transfer failure).",
			[]string{"tenant", "campaign", "reason"},
		),
		AMDAction: newCounter(
			"vici2_picker_amd_action_total",
			"AMD detection actions taken per list and action type.",
			[]string{"tenant", "campaign", "list", "action"},
		),
		TokensConsumed: newCounter(
			"vici2_picker_tokens_consumed_total",
			"Successful dispatch token DECR operations.",
			[]string{"tenant", "campaign"},
		),
		TokensOverDecremented: newCounter(
			"vici2_picker_tokens_over_decremented_total",
			"Over-decrement races detected; INCR-back applied.",
			[]string{"tenant", "campaign"},
		),
		TokenLeaked: newCounter(
			"vici2_picker_token_leaked_total",
			"Tokens leaked due to dispatch deadline timeout (Q8: accepted).",
			[]string{"tenant", "campaign"},
		),
		OrphanedClaim: newCounter(
			"vici2_picker_orphaned_claim_total",
			"Orphaned in_flight entries reaped by E06 janitor.",
			[]string{"tenant", "campaign"},
		),
		ActiveInFlight: newGauge(
			"vici2_picker_active_inflight",
			"Current number of in-flight leads (HLEN of in_flight HASH).",
			[]string{"tenant", "campaign"},
		),
		AnswerHandlerLatency: newHisto(
			"vici2_picker_answer_handler_latency_seconds",
			"PREDICTIVE answer handler latency: XREADGROUP delivery to UUIDTransfer.",
			answerBuckets,
			[]string{"tenant", "campaign"},
		),
		ValkeyUnavailableSecs: newGauge(
			"vici2_picker_valkey_unavailable_seconds",
			"Seconds since Valkey was last reachable (0 = healthy).",
			[]string{"tenant"},
		),
	}
}
