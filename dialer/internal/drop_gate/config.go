// config.go — CampaignConfig for E05; threshold validation.
//
// E05 PLAN §4, §9.1: threshold pair soft/hard/FCC ceiling + dwell + counting policy.
package drop_gate

import (
	"fmt"
	"math"
)

const (
	// FCCHardCeilingPct is the absolute FCC § 64.1200(a)(7) ceiling. NEVER exceed.
	FCCHardCeilingPct = 3.00

	// DefaultDropTargetSoft is the default soft-cap alert threshold.
	DefaultDropTargetSoft = 1.00

	// DefaultDropTargetMax is the default hard-gate threshold.
	DefaultDropTargetMax = 1.50

	// DefaultRecoverSeconds is the default dwell time before auto-release.
	DefaultRecoverSeconds = 300

	// MinRecoverSeconds is the minimum configurable dwell.
	MinRecoverSeconds = 60

	// HysteresisPP is the hysteresis band in percentage points.
	HysteresisPP = 1.00

	// WarmupDenominatorFloor is the minimum answered calls before rate computation.
	WarmupDenominatorFloor = 100
)

// CampaignConfig holds the per-campaign E05 configuration loaded from MySQL.
// All thresholds are in percent (e.g., 1.50 = 1.50%).
type CampaignConfig struct {
	TenantID   int64
	CampaignID int64

	// DialMethod: "MANUAL" campaigns are exempt from drop-gate logic.
	DialMethod string

	// FCC threshold pair.
	DropTargetSoft float64 // WARN alert; no gate; default 1.00%
	DropTargetMax  float64 // hard gate; default 1.50%; max 3.00%

	// DropTargetMaxOverride: downward-only cap for regulated industries.
	// 0 means not set (use DropTargetMax).
	DropTargetMaxOverride float64

	// RecoverSeconds: minimum dwell before auto-release. Min 60.
	RecoverSeconds int

	// CountEarlyCustomerHangupAsDrop: FCC-conservative (true = PDROP on early BYE).
	CountEarlyCustomerHangupAsDrop bool

	// SafeHarborAudioPath: FS local path to the required recorded message.
	SafeHarborAudioPath string
}

// Validate returns an error if the config violates the FCC ceiling or
// internal invariants. Called at startup and config-load time.
func (c CampaignConfig) Validate() error {
	if c.DropTargetMax <= 0 {
		return fmt.Errorf("drop_target_max must be > 0, got %.4f", c.DropTargetMax)
	}
	if c.DropTargetMax > FCCHardCeilingPct {
		return fmt.Errorf(
			"drop_target_max=%.2f exceeds FCC hard ceiling %.2f (§ 64.1200(a)(7)); campaign MUST NOT start",
			c.DropTargetMax, FCCHardCeilingPct,
		)
	}
	if c.DropTargetSoft <= 0 {
		return fmt.Errorf("drop_target_soft must be > 0, got %.4f", c.DropTargetSoft)
	}
	if c.DropTargetSoft > c.DropTargetMax {
		return fmt.Errorf(
			"drop_target_soft=%.2f must be <= drop_target_max=%.2f",
			c.DropTargetSoft, c.DropTargetMax,
		)
	}
	if c.DropTargetMaxOverride != 0 && c.DropTargetMaxOverride > c.DropTargetMax {
		return fmt.Errorf(
			"drop_target_max_override=%.2f must be <= drop_target_max=%.2f (downward only)",
			c.DropTargetMaxOverride, c.DropTargetMax,
		)
	}
	if c.RecoverSeconds < MinRecoverSeconds {
		return fmt.Errorf(
			"recover_seconds=%d must be >= %d",
			c.RecoverSeconds, MinRecoverSeconds,
		)
	}
	return nil
}

// EffectiveMax returns the effective hard-gate threshold: the smaller of
// DropTargetMax and DropTargetMaxOverride (if set). Always <= FCCHardCeilingPct.
func (c CampaignConfig) EffectiveMax() float64 {
	if c.DropTargetMaxOverride > 0 {
		return math.Min(c.DropTargetMax, c.DropTargetMaxOverride)
	}
	return c.DropTargetMax
}

// ReleaseThreshold is the drop_pct below which (plus dwell) the gate may release.
// E05 PLAN §7.2: max(effective_max - 1.0, 0.10).
func (c CampaignConfig) ReleaseThreshold() float64 {
	rt := c.EffectiveMax() - HysteresisPP
	if rt < 0.10 {
		return 0.10
	}
	return rt
}

// SoftReturnThreshold is the drop_pct below which SOFT_BREACH returns to NORMAL.
// E05 PLAN §7.5: drop_target_soft - 0.50 pp.
func (c CampaignConfig) SoftReturnThreshold() float64 {
	srt := c.DropTargetSoft - 0.50
	if srt < 0.10 {
		return 0.10
	}
	return srt
}

// IsManual returns true if the campaign uses MANUAL dial method,
// which is exempt from drop-gate logic per FCC rule.
func (c CampaignConfig) IsManual() bool {
	return c.DialMethod == "MANUAL"
}

// ApplyDefaults fills zero-value fields with E05 defaults.
func (c CampaignConfig) ApplyDefaults() CampaignConfig {
	if c.DropTargetMax == 0 {
		c.DropTargetMax = DefaultDropTargetMax
	}
	if c.DropTargetSoft == 0 {
		c.DropTargetSoft = DefaultDropTargetSoft
	}
	if c.RecoverSeconds == 0 {
		c.RecoverSeconds = DefaultRecoverSeconds
	}
	return c
}
