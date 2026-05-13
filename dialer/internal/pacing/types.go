// Package pacing is the E02 headroom publisher — per-campaign 1 Hz tick that
// reads Valkey state, computes desired_new_originates via the Vicidial-derived
// formula + 4 clamps, and writes dispatch_tokens for E04 to consume.
//
// E02 PLAN §12: all pacing logic lives here. No gRPC surface; E04 reads
// dispatch_tokens via Valkey (pure STRING contract).
package pacing

import (
	"fmt"
	"time"
)

// DialMethod mirrors the campaigns.dial_method ENUM.
// E02 PLAN §7.
type DialMethod string

const (
	DialMethodManual       DialMethod = "MANUAL"
	DialMethodProgressive  DialMethod = "PROGRESSIVE"
	DialMethodRatio        DialMethod = "RATIO"
	DialMethodAdaptHard    DialMethod = "ADAPT_HARD"
	DialMethodAdaptAvg     DialMethod = "ADAPT_AVG"
	DialMethodAdaptTapered DialMethod = "ADAPT_TAPERED"
)

// CampaignConfig is the process-cached MySQL read for a campaign row.
// Refreshed every 60 s or immediately on campaign_config_changed pubsub.
// E02 PLAN §5.6 + §11.
type CampaignConfig struct {
	TenantID   int64
	CampaignID string

	Active     bool
	DialMethod DialMethod

	// Level fields
	AutoDialLevel    float64 // campaigns.auto_dial_level (RATIO static level)
	AdaptiveMaxLevel float64 // campaigns.adaptive_max_level (sanity cap for E03 output)

	// Tally flag — governs RATIO mode agent count (§2.2).
	AvailableOnlyTally bool

	// E02 Amendment A2/E02 columns (§11.1):
	CallsPerSecond      int     // campaigns.calls_per_second DEFAULT 5; informational
	RampUpFactor        float64 // campaigns.ramp_up_factor DEFAULT 2.00
	MinCallBufferSecs   float64 // campaigns.min_call_buffer_seconds DEFAULT 2.00
	PacingTickMs        int     // campaigns.pacing_tick_ms DEFAULT 1000

	// Gateway IDs for carrier headroom reads (§5.5).
	// Each entry is a gateway_id whose active counter lives in Valkey.
	GatewayIDs    []int64
	GatewayMaxCon map[int64]int // gateway_id → max_concurrent
}

// TickInterval returns the per-campaign tick duration, clamped to [200ms,5s].
func (c CampaignConfig) TickInterval() time.Duration {
	ms := c.PacingTickMs
	if ms < 200 {
		ms = 1000
	}
	if ms > 5000 {
		ms = 5000
	}
	return time.Duration(ms) * time.Millisecond
}

// Snapshot is the Valkey read result assembled by SnapshotReader for one tick.
// E02 PLAN §5: 9 pipelined ops, all resolved before Decide() is called.
type Snapshot struct {
	Config CampaignConfig

	// Agent counts (E02 PLAN §5.1).
	ReadyAgents  int
	InCallAgents int
	WrapupAgents int

	// Active originations (E02 PLAN §5.2).
	ActiveCalls int

	// E03's dial_level output (E02 PLAN §5.3). 0 = absent (use fallback).
	DialLevel float64

	// E05's drop gate (E02 PLAN §5.4). True = key exists.
	DropGated bool

	// Carrier headroom (E02 PLAN §5.5). Sum of max_concurrent - active across
	// all campaign gateways. -1 = no gateways configured (treat as unlimited).
	GWHeadroom int

	// AvgWaitToAnswerMs is Phase 2 stub = 4000 ms (FCC 4-ring minimum).
	// Phase 3: real EWMA from E03's published avg_wait_ms STRING.
	AvgWaitToAnswerMs int
}

// TenantIDStr returns tenant_id as a string for Prometheus label values.
func (c *CampaignConfig) TenantIDStr() string {
	if c.TenantID == 0 {
		return "1"
	}
	return fmt.Sprintf("%d", c.TenantID)
}

// TickMeta carries per-tick timing + outcome metadata for audit/metrics.
type TickMeta struct {
	PodID          string
	LockAcquired   bool
	Base           int
	ClampsFired    []string
	TickDurationUs int64
}
