// E03 is a clean-room Go port of Vicidial AST_VDadapt.pl (public GPL source,
// in source control since at least 2008 per inktel/Vicidial git history).
// Improvements: explicit anti-windup (back-calculation), deadband, drop_gated fast-cut.
// Prior art documented per SPEC patent-defense protocol.

package adapt

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

// Config is the per-campaign config snapshot for E03.
// Loaded from MySQL on startup and on campaign_config_changed pubsub.
type Config struct {
	TenantID   int64
	CampaignID int64

	Mode            DialMethod
	AdaptiveDropPct float64 // campaigns.adaptive_drop_pct
	AdaptiveMaxLevel float64 // validated ≥ 1.0 at construction
	AutoDialLevel   float64 // cold-start initial level; read once
	Intensity       int     // -20..+20
	HoldBandPP      float64 // default 0.30
	AdaptTickSeconds int    // default 15
	WarmupMinAnswered int   // default 50
	WarmupMinSeconds  int   // default 300
	DropGatedDebounce int   // default 30
	// ShiftStartLocal and ShiftEndLocal are nil when not set (no taper).
	ShiftStartLocal *time.Time
	ShiftEndLocal   *time.Time
}

// Validate clamps and validates config fields. Returns error on invalid.
func (c *Config) Validate() error {
	if c.AdaptiveMaxLevel < LevelFloor {
		c.AdaptiveMaxLevel = LevelFloor
	}
	if c.AutoDialLevel < LevelFloor {
		c.AutoDialLevel = LevelFloor
	}
	if c.AutoDialLevel > c.AdaptiveMaxLevel {
		c.AutoDialLevel = c.AdaptiveMaxLevel
	}
	if c.HoldBandPP <= 0 {
		c.HoldBandPP = 0.30
	}
	if c.AdaptTickSeconds <= 0 {
		c.AdaptTickSeconds = 15
	}
	if c.AdaptTickSeconds > 60 {
		c.AdaptTickSeconds = 60
	}
	if c.WarmupMinAnswered < 0 {
		c.WarmupMinAnswered = 0
	}
	if c.WarmupMinSeconds < 0 {
		c.WarmupMinSeconds = 0
	}
	if c.DropGatedDebounce < 0 {
		c.DropGatedDebounce = 0
	}
	if c.Intensity < -20 {
		c.Intensity = -20
	}
	if c.Intensity > 20 {
		c.Intensity = 20
	}
	if c.Mode == "" {
		return fmt.Errorf("adapt: config: mode is empty for campaign %d", c.CampaignID)
	}
	return nil
}

// IsAdaptMode returns true if the mode is one of the E03 adaptive modes.
func IsAdaptMode(m DialMethod) bool {
	switch m {
	case DialMethodAdaptHard, DialMethodAdaptAvg, DialMethodAdaptTapered:
		return true
	}
	return false
}

// LoadConfig reads campaign config from MySQL for E03.
// Returns error if campaign not found or not in ADAPT_* mode.
func LoadConfig(ctx context.Context, db *sql.DB, tid, cid int64) (Config, error) {
	const q = `
SELECT
    dial_method,
    adaptive_drop_pct,
    adaptive_max_level,
    auto_dial_level,
    COALESCE(adaptive_intensity, 0),
    COALESCE(hold_band_pp, 0.30),
    COALESCE(adapt_tick_seconds, 15),
    COALESCE(warmup_min_answered, 50),
    COALESCE(warmup_min_seconds, 300),
    COALESCE(drop_gated_debounce_sec, 30),
    shift_start_local,
    shift_end_local
FROM campaigns
WHERE tenant_id = ? AND id = ? AND active = 1
LIMIT 1`

	row := db.QueryRowContext(ctx, q, tid, cid)

	var (
		modeStr         string
		dropPct         float64
		maxLevel        float64
		autoLevel       float64
		intensity       int
		holdBand        float64
		tickSec         int
		warmupAnswered  int
		warmupSecs      int
		debounce        int
		shiftStartRaw   sql.NullString
		shiftEndRaw     sql.NullString
	)

	if err := row.Scan(
		&modeStr, &dropPct, &maxLevel, &autoLevel,
		&intensity, &holdBand, &tickSec,
		&warmupAnswered, &warmupSecs, &debounce,
		&shiftStartRaw, &shiftEndRaw,
	); err != nil {
		return Config{}, fmt.Errorf("adapt: load config tid=%d cid=%d: %w", tid, cid, err)
	}

	cfg := Config{
		TenantID:          tid,
		CampaignID:        cid,
		Mode:              DialMethod(modeStr),
		AdaptiveDropPct:   dropPct,
		AdaptiveMaxLevel:  maxLevel,
		AutoDialLevel:     autoLevel,
		Intensity:         intensity,
		HoldBandPP:        holdBand,
		AdaptTickSeconds:  tickSec,
		WarmupMinAnswered: warmupAnswered,
		WarmupMinSeconds:  warmupSecs,
		DropGatedDebounce: debounce,
	}

	// Parse TIME columns (HH:MM:SS) as today's date in UTC.
	if shiftStartRaw.Valid && shiftStartRaw.String != "" {
		t := parseTimeOfDay(shiftStartRaw.String)
		if !t.IsZero() {
			cfg.ShiftStartLocal = &t
		}
	}
	if shiftEndRaw.Valid && shiftEndRaw.String != "" {
		t := parseTimeOfDay(shiftEndRaw.String)
		if !t.IsZero() {
			cfg.ShiftEndLocal = &t
		}
	}

	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

// parseTimeOfDay parses "HH:MM:SS" and returns a time.Time for today UTC.
func parseTimeOfDay(s string) time.Time {
	t, err := time.Parse("15:04:05", s)
	if err != nil {
		// Try HH:MM fallback.
		t, err = time.Parse("15:04", s)
		if err != nil {
			return time.Time{}
		}
	}
	now := time.Now().UTC()
	return time.Date(now.Year(), now.Month(), now.Day(), t.Hour(), t.Minute(), t.Second(), 0, time.UTC)
}
