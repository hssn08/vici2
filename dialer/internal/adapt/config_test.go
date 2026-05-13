// E03 is a clean-room Go port of Vicidial AST_VDadapt.pl (public GPL source,
// in source control since at least 2008 per inktel/Vicidial git history).
// Improvements: explicit anti-windup (back-calculation), deadband, drop_gated fast-cut.
// Prior art documented per SPEC patent-defense protocol.

package adapt_test

import (
	"testing"

	"github.com/vici2/dialer/internal/adapt"
)

func TestConfigValidate(t *testing.T) {
	t.Parallel()

	t.Run("clamp_max_level_below_floor", func(t *testing.T) {
		t.Parallel()
		cfg := adapt.Config{
			Mode: adapt.DialMethodAdaptAvg, AdaptiveMaxLevel: 0.5, AutoDialLevel: 1.5,
			HoldBandPP: 0.30, AdaptTickSeconds: 15, WarmupMinAnswered: 50, WarmupMinSeconds: 300,
		}
		if err := cfg.Validate(); err != nil {
			t.Fatal(err)
		}
		if cfg.AdaptiveMaxLevel != adapt.LevelFloor {
			t.Errorf("expected max clamped to %.2f, got %.2f", adapt.LevelFloor, cfg.AdaptiveMaxLevel)
		}
	})

	t.Run("auto_dial_level_clamped_to_max", func(t *testing.T) {
		t.Parallel()
		cfg := adapt.Config{
			Mode: adapt.DialMethodAdaptAvg, AdaptiveMaxLevel: 2.0, AutoDialLevel: 5.0,
			HoldBandPP: 0.30, AdaptTickSeconds: 15, WarmupMinAnswered: 50, WarmupMinSeconds: 300,
		}
		if err := cfg.Validate(); err != nil {
			t.Fatal(err)
		}
		if cfg.AutoDialLevel > cfg.AdaptiveMaxLevel {
			t.Errorf("auto_dial_level %.2f exceeds max %.2f", cfg.AutoDialLevel, cfg.AdaptiveMaxLevel)
		}
	})

	t.Run("intensity_clamped_to_range", func(t *testing.T) {
		t.Parallel()
		cfg := adapt.Config{
			Mode: adapt.DialMethodAdaptAvg, AdaptiveMaxLevel: 3.0, AutoDialLevel: 1.5,
			Intensity: 999, HoldBandPP: 0.30, AdaptTickSeconds: 15,
		}
		_ = cfg.Validate()
		if cfg.Intensity > 20 {
			t.Errorf("intensity %d not clamped to 20", cfg.Intensity)
		}
	})

	t.Run("empty_mode_returns_error", func(t *testing.T) {
		t.Parallel()
		cfg := adapt.Config{
			AdaptiveMaxLevel: 3.0, AutoDialLevel: 1.5, HoldBandPP: 0.30, AdaptTickSeconds: 15,
		}
		if err := cfg.Validate(); err == nil {
			t.Error("expected error for empty mode")
		}
	})

	t.Run("tick_seconds_clamped_high", func(t *testing.T) {
		t.Parallel()
		cfg := adapt.Config{
			Mode: adapt.DialMethodAdaptAvg, AdaptiveMaxLevel: 3.0, AutoDialLevel: 1.5,
			HoldBandPP: 0.30, AdaptTickSeconds: 999, WarmupMinAnswered: 50,
		}
		_ = cfg.Validate()
		if cfg.AdaptTickSeconds > 60 {
			t.Errorf("tick_seconds %d not clamped to 60", cfg.AdaptTickSeconds)
		}
	})

	t.Run("defaults_applied_on_zero", func(t *testing.T) {
		t.Parallel()
		cfg := adapt.Config{
			Mode: adapt.DialMethodAdaptAvg, AdaptiveMaxLevel: 3.0, AutoDialLevel: 1.5,
		}
		_ = cfg.Validate()
		if cfg.HoldBandPP == 0 {
			t.Error("HoldBandPP should be defaulted to 0.30")
		}
		if cfg.AdaptTickSeconds == 0 {
			t.Error("AdaptTickSeconds should be defaulted to 15")
		}
	})

	t.Run("is_adapt_mode", func(t *testing.T) {
		t.Parallel()
		if !adapt.IsAdaptMode(adapt.DialMethodAdaptHard) {
			t.Error("ADAPT_HARD should be adapt mode")
		}
		if !adapt.IsAdaptMode(adapt.DialMethodAdaptAvg) {
			t.Error("ADAPT_AVG should be adapt mode")
		}
		if !adapt.IsAdaptMode(adapt.DialMethodAdaptTapered) {
			t.Error("ADAPT_TAPERED should be adapt mode")
		}
		if adapt.IsAdaptMode(adapt.DialMethod("RATIO")) {
			t.Error("RATIO should NOT be adapt mode")
		}
	})
}
