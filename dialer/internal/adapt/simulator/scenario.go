// E03 is a clean-room Go port of Vicidial AST_VDadapt.pl (public GPL source,
// in source control since at least 2008 per inktel/Vicidial git history).
// Improvements: explicit anti-windup (back-calculation), deadband, drop_gated fast-cut.
// Prior art documented per SPEC patent-defense protocol.

package simulator

import (
	"time"

	"github.com/vici2/dialer/internal/adapt"
)

// ScenarioConfig defines a simulation scenario.
type ScenarioConfig struct {
	Name          string
	Mode          adapt.DialMethod
	AdaptDropPct  float64 // target abandonment %
	AdaptMaxLevel float64
	AutoDialLevel float64
	Intensity     int
	HoldBandPP    float64
	TickSeconds   float64
	ShiftHours    float64 // for TAPERED: total shift duration (0 = no shift)
	NumAgents     int
	ConnectRate   float64
	WarmupTicks   int   // pre-warm ticks (warm=true, ignored for pass criteria)
	NumTicks      int   // main simulation ticks
	WindowTicks   int   // drop% window
	Seed          int64

	// Mid-scenario perturbations.
	AgentDropAt    int // tick index to drop agents
	AgentDropTo    int // new agent count after drop
	ConnectRateAt  int     // tick to change connect rate
	ConnectRateTo  float64 // new connect rate
	GatedAt        int     // tick to inject drop_gated=true (fast-cut test)
}

// Result holds simulation outcome statistics.
type Result struct {
	Name         string
	Ticks        int
	MeanDrop     float64
	MaxDrop      float64
	LevelOscAmp  float64 // max amplitude of level oscillation
	FinalLevel   float64
	WarmUpExited bool
	GatedFired   bool
}

// Run executes one scenario and returns the result.
func Run(cfg ScenarioConfig) Result {
	agents := NewAgentPool(cfg.NumAgents, cfg.Seed)
	leads := NewLeadList(cfg.ConnectRate, cfg.Seed+1)
	tracker := NewMockDropTracker(cfg.WindowTicks)
	pacer := MockPacer{}

	// Controller state.
	level := cfg.AutoDialLevel
	if level < 1.0 {
		level = 1.0
	}
	integral := 0.0
	activeCalls := 0

	var now time.Time
	shiftStart := time.Time{}
	shiftEnd := time.Time{}
	if cfg.ShiftHours > 0 && cfg.Mode == adapt.DialMethodAdaptTapered {
		now = time.Date(2026, 1, 1, 8, 0, 0, 0, time.UTC)
		shiftStart = now
		shiftEnd = now.Add(time.Duration(cfg.ShiftHours * float64(time.Hour)))
	} else {
		now = time.Date(2026, 1, 1, 8, 0, 0, 0, time.UTC)
	}

	var levels []float64
	var drops []float64
	gatedFired := false
	warmUpExited := false

	for tick := 0; tick < cfg.WarmupTicks+cfg.NumTicks; tick++ {
		isWarmUp := tick < cfg.WarmupTicks
		if !isWarmUp && !warmUpExited {
			warmUpExited = true
		}

		// Apply perturbations.
		mainTick := tick - cfg.WarmupTicks
		if cfg.AgentDropAt > 0 && mainTick == cfg.AgentDropAt {
			agents.Resize(cfg.AgentDropTo)
		}
		if cfg.ConnectRateAt > 0 && mainTick == cfg.ConnectRateAt {
			leads.ConnectRate = cfg.ConnectRateTo
		}

		// Simulate fast-cut injection.
		if cfg.GatedAt > 0 && mainTick == cfg.GatedAt {
			level = 1.0
			integral = 0
			gatedFired = true
		}

		// Count ready agents.
		simNow := float64(tick) * cfg.TickSeconds
		ready := agents.ReadyCount(simNow)

		// Pacer: how many dials?
		dials := pacer.Desired(ready, level, activeCalls)

		// Simulate calls.
		answered, dropped := leads.SimulateDials(dials, ready, agents, simNow)
		activeCalls = 0
		for _, a := range agents.Agents {
			if a.InCall(simNow) {
				activeCalls++
			}
		}

		tracker.Record(answered, dropped)
		dropPct := tracker.DropPct()

		// Advance time.
		now = now.Add(time.Duration(cfg.TickSeconds * float64(time.Second)))

		if !isWarmUp {
			drops = append(drops, dropPct)
			levels = append(levels, level)
		}

		// Controller tick (Decide).
		in := adapt.AdaptInput{
			Mode:             cfg.Mode,
			DropPct30d:       dropPct,
			AdaptiveDropPct:  cfg.AdaptDropPct,
			CurrentLevel:     level,
			AdaptiveMaxLevel: cfg.AdaptMaxLevel,
			Intensity:        cfg.Intensity,
			HoldBandPP:       cfg.HoldBandPP,
			LastIntegral:     integral,
			Now:              now,
			TickSeconds:      cfg.TickSeconds,
			WarmUp:           isWarmUp,
			ShiftStart:       shiftStart,
			ShiftEnd:         shiftEnd,
		}
		out := adapt.Decide(in)
		level = out.NewLevel
		integral = out.NewIntegral
	}

	return Result{
		Name:         cfg.Name,
		Ticks:        len(drops),
		MeanDrop:     mean(drops),
		MaxDrop:      maxF(drops),
		LevelOscAmp:  oscAmp(levels),
		FinalLevel:   level,
		WarmUpExited: warmUpExited,
		GatedFired:   gatedFired,
	}
}

// mean returns the mean of a slice.
func mean(xs []float64) float64 {
	if len(xs) == 0 {
		return 0
	}
	var s float64
	for _, x := range xs {
		s += x
	}
	return s / float64(len(xs))
}

// maxF returns the maximum of a slice.
func maxF(xs []float64) float64 {
	if len(xs) == 0 {
		return 0
	}
	m := xs[0]
	for _, x := range xs[1:] {
		if x > m {
			m = x
		}
	}
	return m
}

// oscAmp computes the oscillation amplitude of a level trajectory:
// half of (max - min) over the last 50% of ticks.
func oscAmp(levels []float64) float64 {
	if len(levels) < 4 {
		return 0
	}
	half := levels[len(levels)/2:]
	mn, mx := half[0], half[0]
	for _, v := range half {
		if v < mn {
			mn = v
		}
		if v > mx {
			mx = v
		}
	}
	return (mx - mn) / 2.0
}
