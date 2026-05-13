// decision_test.go — table-driven unit tests for Decider.Decide().
//
// E02 PLAN §16.1: 5 worked examples + 12 boundary cases + mode dispatch tests
// + formula edge cases. Zero I/O — no Valkey, no Prometheus.
package pacing

import (
	"math"
	"testing"
)

// defaultConfig returns a CampaignConfig with safe defaults for tests.
func defaultConfig(method DialMethod) CampaignConfig {
	return CampaignConfig{
		TenantID:           1,
		CampaignID:         "42",
		Active:             true,
		DialMethod:         method,
		AutoDialLevel:      1.5,
		AdaptiveMaxLevel:   3.0,
		AvailableOnlyTally: false,
		CallsPerSecond:     5,
		RampUpFactor:       2.0,
		MinCallBufferSecs:  2.0,
		PacingTickMs:       1000,
		GatewayMaxCon:      map[int64]int{},
	}
}

// snap builds a Snapshot for test use.
func snap(cfg CampaignConfig, ready, incall, wrapup, active int, level float64, gw int, dropGated bool) Snapshot {
	return Snapshot{
		Config:            cfg,
		ReadyAgents:       ready,
		InCallAgents:      incall,
		WrapupAgents:      wrapup,
		ActiveCalls:       active,
		DialLevel:         level,
		GWHeadroom:        gw,
		DropGated:         dropGated,
		AvgWaitToAnswerMs: avgWaitToAnswerMsPhase2Stub,
	}
}

func newDecider() *Decider { return NewDecider(nil) }

// ── Worked examples (E02 PLAN §16.1 Table A–E) ────────────────────────────

func TestDecide_WorkedExamples(t *testing.T) {
	tests := []struct {
		name        string
		snap        Snapshot
		wantDesired int
		wantClamps  []string
	}{
		{
			name: "A: RATIO=1.5, 6 ready, 0 active",
			// base = round(6×1.5) - 0 = 9
			// buffer: bufferMax = floor(2.0*1000*6/4000) = floor(3.0) = 3 → buffer fires at 9
			// ramp_max = ceil(1.5)×ceil(2.0) = 2×2 = 4; desired after buffer=3 < ramp_max → ramp no-fire
			// final desired=3 (buffer binding)
			snap: func() Snapshot {
				cfg := defaultConfig(DialMethodRatio)
				cfg.AutoDialLevel = 1.5
				s := snap(cfg, 6, 0, 0, 0, 0, 50, false)
				return s
			}(),
			wantDesired: 3,
			wantClamps:  []string{"buffer"},
		},
		{
			name: "A-noramp: RATIO=1.5, 6 ready, 0 active, ramp_factor=10, min_buffer=0",
			// Disable buffer clamp by setting MinCallBufferSecs=0 (skips check when agents==0 fails)
			// Actually: set AvgWaitToAnswerMs=0 in snapshot... but that's fixed.
			// Use MinCallBufferSecs so bufferMax >= base: 2.0*1000*6/4000 = 3 still.
			// Use large enough MinCallBufferSecs: 30 → bufferMax=floor(30*1000*6/4000)=45
			snap: func() Snapshot {
				cfg := defaultConfig(DialMethodRatio)
				cfg.AutoDialLevel = 1.5
				cfg.RampUpFactor = 10.0
				cfg.MinCallBufferSecs = 30.0 // high buffer → bufferMax=45 → no buffer clamp
				return snap(cfg, 6, 0, 0, 0, 0, 50, false)
			}(),
			wantDesired: 9,
			wantClamps:  nil,
		},
		{
			name: "B: ADAPT, 10 ready, 6 active, level=1.85",
			// base = round(10×1.85) - 6 = 19 - 6 = 13
			// buffer: bufferMax = floor(2.0*1000*10/4000) = floor(5.0) = 5 → buffer fires
			// ramp_max = ceil(1.85)×ceil(2.0) = 2×2 = 4; desired after buffer=5 > ramp_max=4 → ramp fires
			// final desired=4
			snap: func() Snapshot {
				cfg := defaultConfig(DialMethodAdaptHard)
				return snap(cfg, 10, 0, 0, 6, 1.85, 50, false)
			}(),
			wantDesired: 4,
			wantClamps:  []string{"ramp"},
		},
		{
			name: "B-noramp: ADAPT, 10 ready, 6 active, level=1.85, ramp=10, high buffer",
			snap: func() Snapshot {
				cfg := defaultConfig(DialMethodAdaptHard)
				cfg.RampUpFactor = 10.0
				cfg.MinCallBufferSecs = 30.0 // bufferMax=75 → no buffer clamp
				return snap(cfg, 10, 0, 0, 6, 1.85, 50, false)
			}(),
			wantDesired: 13,
			wantClamps:  nil,
		},
		{
			name: "C: Drop-gated mid-campaign",
			// base = round(8×1.85) - 5 = 15 - 5 = 10
			// buffer: bufferMax=floor(2.0*1000*8/4000)=floor(4)=4 → buffer fires at 10 → desired=4
			// drop gate: desired=4 > 1 → drop fires → desired=1
			snap: func() Snapshot {
				cfg := defaultConfig(DialMethodAdaptHard)
				cfg.RampUpFactor = 10.0
				return snap(cfg, 8, 0, 0, 5, 1.85, 50, true)
			}(),
			wantDesired: 1,
			wantClamps:  []string{"drop"},
		},
		{
			name: "D: Carrier saturated",
			// base = round(12×1.5)-8 = 18-8 = 10
			// buffer: bufferMax=floor(2.0*1000*12/4000)=floor(6)=6 → buffer fires
			// gw_headroom=2 < 6 → gw fires → desired=2
			snap: func() Snapshot {
				cfg := defaultConfig(DialMethodRatio)
				cfg.AutoDialLevel = 1.5
				cfg.RampUpFactor = 10.0
				return snap(cfg, 12, 0, 0, 8, 0, 2, false)
			}(),
			wantDesired: 2,
			wantClamps:  []string{"gw"},
		},
		{
			name: "E: Wake-up storm (ramp clamp fires)",
			// 30 agents return from break
			// buffer: bufferMax=floor(2.0*1000*30/4000)=floor(15)=15
			// base=round(30*1.5)-0=45; buffer fires at 45→15; ramp_max=ceil(1.5)*ceil(2)=2*2=4; ramp fires
			snap: func() Snapshot {
				cfg := defaultConfig(DialMethodRatio)
				cfg.AutoDialLevel = 1.5
				return snap(cfg, 30, 0, 0, 0, 0, 100, false)
			}(),
			wantDesired: 4,
			wantClamps:  []string{"ramp"},
		},
	}

	d := newDecider()
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res := d.Decide(tt.snap)
			if res.Desired != tt.wantDesired {
				t.Errorf("Desired = %d, want %d (base=%d, level=%.4f, agents=%d)",
					res.Desired, tt.wantDesired, res.Base, res.Level, res.AgentCount)
			}
			if len(tt.wantClamps) == 0 && len(res.ClampsFired) != 0 {
				t.Errorf("ClampsFired = %v, want none", res.ClampsFired)
			}
			for _, wc := range tt.wantClamps {
				found := false
				for _, fc := range res.ClampsFired {
					if fc == wc {
						found = true
						break
					}
				}
				if !found {
					t.Errorf("expected clamp %q to fire, clamps_fired=%v", wc, res.ClampsFired)
				}
			}
		})
	}
}

// ── MANUAL mode ──────────────────────────────────────────────────────────────

func TestDecide_ManualAlwaysZero(t *testing.T) {
	d := newDecider()
	cfg := defaultConfig(DialMethodManual)
	s := snap(cfg, 10, 5, 3, 2, 1.5, 50, false)
	res := d.Decide(s)
	if res.Desired != 0 {
		t.Errorf("MANUAL mode: desired=%d, want 0", res.Desired)
	}
}

// ── Formula edge cases ────────────────────────────────────────────────────────

func TestDecide_EdgeCases(t *testing.T) {
	d := newDecider()

	t.Run("round half-integer: agents=3, level=1.5 → round(4.5)=5", func(t *testing.T) {
		// math.Round(4.5) = 5 (half-away-from-zero)
		cfg := defaultConfig(DialMethodRatio)
		cfg.AutoDialLevel = 1.5
		cfg.RampUpFactor = 10.0
		s := snap(cfg, 3, 0, 0, 0, 0, 50, false)
		res := d.Decide(s)
		// base = round(3×1.5)-0 = round(4.5)-0 = 5
		if res.Base != 5 {
			t.Errorf("base=%d, want 5 (math.Round(4.5)=5)", res.Base)
		}
	})

	t.Run("negative base → 0 output", func(t *testing.T) {
		// active_calls > agents×level
		cfg := defaultConfig(DialMethodRatio)
		cfg.AutoDialLevel = 1.0
		cfg.RampUpFactor = 10.0
		s := snap(cfg, 2, 0, 0, 10, 0, 50, false)
		res := d.Decide(s)
		// base = round(2×1.0)-10 = -8 → clamped to 0
		if res.Desired < 0 {
			t.Errorf("desired=%d < 0, want ≥0", res.Desired)
		}
	})

	t.Run("agents=0 → desired=0 (no divide-by-zero in buffer clamp)", func(t *testing.T) {
		cfg := defaultConfig(DialMethodRatio)
		cfg.AutoDialLevel = 1.5
		cfg.RampUpFactor = 10.0
		s := snap(cfg, 0, 0, 0, 0, 0, 50, false)
		res := d.Decide(s)
		if res.Desired != 0 {
			t.Errorf("agents=0: desired=%d, want 0", res.Desired)
		}
	})

	t.Run("all clamps fire simultaneously → desired=0 or 1", func(t *testing.T) {
		// drop_gated caps at 1, gw_headroom=0 caps at 0 → effective desired=0
		cfg := defaultConfig(DialMethodAdaptHard)
		cfg.RampUpFactor = 10.0
		s := snap(cfg, 5, 0, 0, 0, 1.5, 0, true)
		res := d.Decide(s)
		if res.Desired > 1 {
			t.Errorf("all-clamps desired=%d, want ≤1", res.Desired)
		}
	})

	t.Run("multiple clamps fire: all counted in ClampsFired", func(t *testing.T) {
		// gw_headroom=2 < base, drop_gated fires too
		cfg := defaultConfig(DialMethodAdaptHard)
		cfg.RampUpFactor = 10.0
		s := snap(cfg, 8, 0, 0, 0, 1.85, 2, true)
		res := d.Decide(s)
		clampSet := map[string]bool{}
		for _, c := range res.ClampsFired {
			clampSet[c] = true
		}
		// gw and drop should both fire; gw fires at 2, drop reduces to min(2,1)=1
		if !clampSet["drop"] {
			t.Errorf("expected drop clamp, got %v", res.ClampsFired)
		}
	})
}

// ── Mode dispatch tests ───────────────────────────────────────────────────────

func TestResolveLevel(t *testing.T) {
	tests := []struct {
		method    DialMethod
		dialLevel float64
		autoLevel float64
		wantLevel float64
	}{
		{DialMethodProgressive, 0, 1.5, 1.0},
		{DialMethodRatio, 0, 1.5, 1.5},
		{DialMethodAdaptHard, 1.85, 1.5, 1.85},
		{DialMethodAdaptAvg, 2.1, 1.5, 2.1},
		{DialMethodAdaptTapered, 1.3, 1.5, 1.3},
		// cold start: DialLevel=0, fallback to auto_dial_level
		{DialMethodAdaptHard, 0, 1.5, 1.5},
		// cold start: DialLevel=0, auto also 0 → fallback 1.0
		{DialMethodAdaptHard, 0, 0, 1.0},
	}
	for _, tt := range tests {
		cfg := defaultConfig(tt.method)
		cfg.AutoDialLevel = tt.autoLevel
		s := Snapshot{Config: cfg, DialLevel: tt.dialLevel}
		got := resolveLevel(s)
		if math.Abs(got-tt.wantLevel) > 1e-9 {
			t.Errorf("resolveLevel(%v): got %.4f, want %.4f", tt.method, got, tt.wantLevel)
		}
	}
}

func TestResolveAgents(t *testing.T) {
	tests := []struct {
		method  DialMethod
		tally   bool
		ready   int
		incall  int
		wrapup  int
		want    int
	}{
		{DialMethodProgressive, false, 5, 3, 2, 5},   // always READY only
		{DialMethodProgressive, true, 5, 3, 2, 5},    // always READY only
		{DialMethodRatio, false, 5, 3, 2, 10},        // READY+INCALL+WRAPUP
		{DialMethodRatio, true, 5, 3, 2, 5},          // tally=true → READY only
		{DialMethodAdaptHard, false, 7, 3, 1, 7},     // ADAPT: READY only
		{DialMethodAdaptAvg, true, 4, 2, 1, 4},
		{DialMethodAdaptTapered, false, 6, 2, 2, 6},
	}
	for _, tt := range tests {
		cfg := defaultConfig(tt.method)
		cfg.AvailableOnlyTally = tt.tally
		s := Snapshot{Config: cfg, ReadyAgents: tt.ready, InCallAgents: tt.incall, WrapupAgents: tt.wrapup}
		got := resolveAgents(s)
		if got != tt.want {
			t.Errorf("resolveAgents(%v, tally=%v, r=%d,i=%d,w=%d): got %d, want %d",
				tt.method, tt.tally, tt.ready, tt.incall, tt.wrapup, got, tt.want)
		}
	}
}

// ── Clamp boundary tests (4 clamps × 3 cases each) ───────────────────────────

func TestClamp_Buffer(t *testing.T) {
	d := newDecider()
	// avg_wait = 4000ms, agents=5
	// bufferMax = floor(MinCallBufferSecs*1000*5 / 4000)
	// With MinCallBufferSecs=2.0: bufferMax = floor(2.0*1000*5/4000) = floor(2.5) = 2

	t.Run("below threshold: desired=2 == bufferMax → no fire", func(t *testing.T) {
		cfg := defaultConfig(DialMethodAdaptHard)
		cfg.MinCallBufferSecs = 2.0
		cfg.RampUpFactor = 100.0
		// level=0.4 → base=round(5*0.4)-0=round(2)=2; 2 == bufferMax=2 → no fire
		s := snap(cfg, 5, 0, 0, 0, 0.4, 100, false)
		res := d.Decide(s)
		for _, c := range res.ClampsFired {
			if c == "buffer" {
				t.Errorf("buffer clamp unexpectedly fired at desired=%d bufferMax=2", res.Desired)
			}
		}
	})

	t.Run("above threshold: desired=3 > bufferMax=2 → fires", func(t *testing.T) {
		cfg := defaultConfig(DialMethodAdaptHard)
		cfg.MinCallBufferSecs = 2.0
		cfg.RampUpFactor = 100.0
		// base=round(5*0.6)-0=round(3)=3 > bufferMax=2 → buffer fires
		s := snap(cfg, 5, 0, 0, 0, 0.6, 100, false)
		res := d.Decide(s)
		fired := false
		for _, c := range res.ClampsFired {
			if c == "buffer" {
				fired = true
			}
		}
		if !fired {
			t.Errorf("buffer clamp did not fire: desired=%d, base=%d", res.Desired, res.Base)
		}
		if res.Desired > 2 {
			t.Errorf("buffer clamp: desired=%d > bufferMax=2", res.Desired)
		}
	})

	t.Run("well above threshold: desired clamped", func(t *testing.T) {
		cfg := defaultConfig(DialMethodAdaptHard)
		cfg.MinCallBufferSecs = 2.0
		cfg.RampUpFactor = 100.0
		// level=5.0 → base=round(5*5)-0=25 >> bufferMax=2
		s := snap(cfg, 5, 0, 0, 0, 5.0, 100, false)
		res := d.Decide(s)
		if res.Desired > 2 {
			t.Errorf("buffer clamp: desired=%d should be ≤2", res.Desired)
		}
	})
}

func TestClamp_GW(t *testing.T) {
	d := newDecider()
	// Use high MinCallBufferSecs to prevent buffer clamp from interfering.
	makeGWCfg := func() CampaignConfig {
		cfg := defaultConfig(DialMethodAdaptHard)
		cfg.RampUpFactor = 100.0
		cfg.MinCallBufferSecs = 100.0 // bufferMax >> base; no buffer clamp
		return cfg
	}

	t.Run("below: desired=3, gw=5 → no fire", func(t *testing.T) {
		// agents=3, level=1.0 → base=3; bufferMax=floor(100*1000*3/4000)=75 → no buffer
		s := snap(makeGWCfg(), 3, 0, 0, 0, 1.0, 5, false)
		res := d.Decide(s)
		for _, c := range res.ClampsFired {
			if c == "gw" {
				t.Error("gw clamp unexpectedly fired")
			}
		}
		if res.Desired != 3 {
			t.Errorf("desired=%d, want 3", res.Desired)
		}
	})

	t.Run("at: desired=5, gw=5 → no fire (not strictly above)", func(t *testing.T) {
		s := snap(makeGWCfg(), 5, 0, 0, 0, 1.0, 5, false)
		res := d.Decide(s)
		for _, c := range res.ClampsFired {
			if c == "gw" {
				t.Error("gw clamp unexpectedly fired when desired==gw_headroom")
			}
		}
	})

	t.Run("above: desired=8, gw=5 → fires, desired=5", func(t *testing.T) {
		s := snap(makeGWCfg(), 8, 0, 0, 0, 1.0, 5, false)
		res := d.Decide(s)
		fired := false
		for _, c := range res.ClampsFired {
			if c == "gw" {
				fired = true
			}
		}
		if !fired {
			t.Error("gw clamp did not fire")
		}
		if res.Desired != 5 {
			t.Errorf("desired=%d, want 5", res.Desired)
		}
	})
}

func TestClamp_Drop(t *testing.T) {
	d := newDecider()
	makeDropCfg := func() CampaignConfig {
		cfg := defaultConfig(DialMethodAdaptHard)
		cfg.RampUpFactor = 100.0
		cfg.MinCallBufferSecs = 100.0
		return cfg
	}

	t.Run("not gated: no fire", func(t *testing.T) {
		s := snap(makeDropCfg(), 5, 0, 0, 0, 1.5, 50, false)
		res := d.Decide(s)
		for _, c := range res.ClampsFired {
			if c == "drop" {
				t.Error("drop clamp fired when not gated")
			}
		}
	})

	t.Run("gated, desired=1: no fire (already at 1)", func(t *testing.T) {
		// With 1 agent, level=1.0, active=0: base=1; bufferMax=floor(100*1000*1/4000)=25 → no buffer
		// desired=1 → clamp does NOT fire (condition is desired>1)
		s := snap(makeDropCfg(), 1, 0, 0, 0, 1.0, 50, true)
		res := d.Decide(s)
		for _, c := range res.ClampsFired {
			if c == "drop" {
				t.Errorf("drop clamp fired at desired=1: %v", res.ClampsFired)
			}
		}
	})

	t.Run("gated, desired=5 → fires, desired=1", func(t *testing.T) {
		s := snap(makeDropCfg(), 5, 0, 0, 0, 1.0, 50, true)
		res := d.Decide(s)
		fired := false
		for _, c := range res.ClampsFired {
			if c == "drop" {
				fired = true
			}
		}
		if !fired {
			t.Error("drop clamp did not fire")
		}
		if res.Desired != 1 {
			t.Errorf("desired=%d, want 1", res.Desired)
		}
	})
}

func TestClamp_Ramp(t *testing.T) {
	d := newDecider()
	makeRampCfg := func(rampFactor float64) CampaignConfig {
		cfg := defaultConfig(DialMethodAdaptHard)
		cfg.RampUpFactor = rampFactor
		cfg.MinCallBufferSecs = 100.0 // disable buffer clamp
		return cfg
	}

	t.Run("below ramp_max: 1 agent, level=1.0 → desired=1 < ramp_max=2 → no fire", func(t *testing.T) {
		// ramp_max = ceil(1.0)×ceil(2.0) = 1×2 = 2; base=1 < 2 → no fire
		s := snap(makeRampCfg(2.0), 1, 0, 0, 0, 1.0, 50, false)
		res := d.Decide(s)
		for _, c := range res.ClampsFired {
			if c == "ramp" {
				t.Errorf("ramp clamp fired unexpectedly: %v (desired=%d base=%d)", res.ClampsFired, res.Desired, res.Base)
			}
		}
		if res.Desired != 1 {
			t.Errorf("desired=%d, want 1", res.Desired)
		}
	})

	t.Run("at ramp_max: 2 agents, level=1.0 → desired=2 == ramp_max=2 → no fire", func(t *testing.T) {
		// desired=2 == ramp_max=2 → no fire (condition: desired > ramp_max)
		s := snap(makeRampCfg(2.0), 2, 0, 0, 0, 1.0, 50, false)
		res := d.Decide(s)
		for _, c := range res.ClampsFired {
			if c == "ramp" {
				t.Errorf("ramp clamp fired at desired==ramp_max: %v", res.ClampsFired)
			}
		}
	})

	t.Run("above ramp_max: 30 agents, level=1.5 → ramp_max=4, fires", func(t *testing.T) {
		// ramp_max = ceil(1.5)×ceil(2.0) = 2×2 = 4; 30 agents → base=45 → buffer→15 → ramp→4
		s := snap(makeRampCfg(2.0), 30, 0, 0, 0, 1.5, 50, false)
		res := d.Decide(s)
		fired := false
		for _, c := range res.ClampsFired {
			if c == "ramp" {
				fired = true
			}
		}
		if !fired {
			t.Errorf("ramp clamp did not fire (desired=%d clamps=%v)", res.Desired, res.ClampsFired)
		}
		if res.Desired > 4 {
			t.Errorf("ramp clamp: desired=%d > ramp_max=4", res.Desired)
		}
	})
}

// ── Progressive vs Ratio=1.0 agent count distinction ─────────────────────────

func TestDecide_ProgressiveVsRatio(t *testing.T) {
	d := newDecider()

	t.Run("PROGRESSIVE: 5 READY + 3 INCALL → desired uses READY only", func(t *testing.T) {
		cfg := defaultConfig(DialMethodProgressive)
		cfg.RampUpFactor = 10.0
		cfg.MinCallBufferSecs = 100.0
		// base = round(5×1.0)-0 = 5
		s := snap(cfg, 5, 3, 2, 0, 0, 50, false)
		res := d.Decide(s)
		if res.AgentCount != 5 {
			t.Errorf("PROGRESSIVE agent_count=%d, want 5", res.AgentCount)
		}
		if res.Base != 5 {
			t.Errorf("PROGRESSIVE base=%d, want 5", res.Base)
		}
	})

	t.Run("RATIO=1.0, tally=false: 5 READY + 3 INCALL + 2 WRAPUP → desired uses 10", func(t *testing.T) {
		cfg := defaultConfig(DialMethodRatio)
		cfg.AutoDialLevel = 1.0
		cfg.RampUpFactor = 10.0
		cfg.MinCallBufferSecs = 100.0
		// base = round(10×1.0)-0 = 10
		s := snap(cfg, 5, 3, 2, 0, 0, 50, false)
		res := d.Decide(s)
		if res.AgentCount != 10 {
			t.Errorf("RATIO agent_count=%d, want 10", res.AgentCount)
		}
	})
}
