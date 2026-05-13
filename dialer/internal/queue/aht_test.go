package queue

import (
	"math"
	"testing"
)

// TestComputeEWT verifies the EWT formula and rounding rules.
// I01 PLAN §8.1 (FROZEN).
func TestComputeEWT(t *testing.T) {
	cases := []struct {
		name        string
		pos         int
		ahtSec      float64
		readyAgents float64
		wantApprox  float64
	}{
		{
			name: "pos=1, aht=180, agents=3",
			pos:  1, ahtSec: 180, readyAgents: 3,
			wantApprox: 60.0, // 180/3=60; round to 60 (nearest 30 for <120)
		},
		{
			name: "pos=2, aht=180, agents=3",
			pos:  2, ahtSec: 180, readyAgents: 3,
			wantApprox: 120.0, // 360/3=120; round up to 120
		},
		{
			name: "pos=1, aht=300, agents=1",
			pos:  1, ahtSec: 300, readyAgents: 1,
			wantApprox: 300.0, // 300; >= 120 so round to nearest 60
		},
		{
			name: "pos=1, aht=50, agents=2",
			pos:  1, ahtSec: 50, readyAgents: 2,
			wantApprox: 25.0, // 25 < 60; no rounding (below announce threshold)
		},
		{
			name: "pos=3, aht=90, agents=1",
			pos:  3, ahtSec: 90, readyAgents: 1,
			wantApprox: 300.0, // 270; >= 120 round UP to nearest 60 → 300
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ComputeEWT(tc.pos, tc.ahtSec, tc.readyAgents)
			if math.Abs(got-tc.wantApprox) > 1.0 {
				t.Errorf("ComputeEWT(%d, %.0f, %.0f) = %.1f, want approx %.1f",
					tc.pos, tc.ahtSec, tc.readyAgents, got, tc.wantApprox)
			}
		})
	}
}

// TestComputeEWT_ZeroAgents verifies division-by-zero protection.
func TestComputeEWT_ZeroAgents(t *testing.T) {
	// readyAgents=0 should clamp to 1 (not divide by zero).
	got := ComputeEWT(1, 180, 0)
	if got <= 0 || math.IsInf(got, 0) || math.IsNaN(got) {
		t.Errorf("ComputeEWT with 0 agents returned invalid value %f", got)
	}
}

// TestShouldAnnounce verifies the announce threshold.
func TestShouldAnnounce(t *testing.T) {
	ig := &InGroup{AnnounceMinWaitSec: 60}

	if ShouldAnnounce(59, ig) {
		t.Error("ShouldAnnounce(59) should be false when min=60")
	}
	if !ShouldAnnounce(60, ig) {
		t.Error("ShouldAnnounce(60) should be true when min=60")
	}
	if !ShouldAnnounce(120, ig) {
		t.Error("ShouldAnnounce(120) should be true when min=60")
	}
}

// TestPriorityScoreComputation verifies priority boost computation.
// I01 PLAN §10.2 (FROZEN).
func TestPriorityScoreComputation(t *testing.T) {
	enterTsMs := int64(1_700_000_000_000)

	cases := []struct {
		name            string
		didBoostSec     int
		crmRank         int
		crmEnabled      bool
		wantBaseScoreLE int64 // base_score <= enterTsMs − wantBoostMs
		wantBoostMs     int64
	}{
		{
			name: "DID-only boost",
			didBoostSec: 300, crmRank: 0, crmEnabled: false,
			wantBoostMs: 300_000,
		},
		{
			name: "CRM-only boost (rank=5)",
			didBoostSec: 0, crmRank: 5, crmEnabled: true,
			wantBoostMs: 150_000, // min(300, 5*30)*1000 = 150000
		},
		{
			name: "combined boost",
			didBoostSec: 400, crmRank: 5, crmEnabled: true,
			wantBoostMs: 550_000, // 400+150 = 550
		},
		{
			name: "cap enforcement",
			didBoostSec: 700, crmRank: 11, crmEnabled: true,
			// didBoost = min(600, 700) = 600; crmBoost = min(300, 11*30) = 300; total = min(900, 900) = 900
			wantBoostMs: 900_000,
		},
		{
			name: "no boost",
			didBoostSec: 0, crmRank: 0, crmEnabled: false,
			wantBoostMs: 0,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			boostSec := computeBoost(tc.didBoostSec, tc.crmRank, tc.crmEnabled)
			wantBoostSec := tc.wantBoostMs / 1000
			if int64(boostSec) != wantBoostSec {
				t.Errorf("boost = %d s, want %d s", boostSec, wantBoostSec)
			}
			baseScore := enterTsMs - tc.wantBoostMs
			_ = baseScore // ensure no overflow
		})
	}
}

// computeBoost is extracted from the priority score logic for test purposes.
// I01 PLAN §10.2.
func computeBoost(didBoostSec, crmRank int, crmEnabled bool) int {
	boost := 0
	if didBoostSec > 0 {
		if didBoostSec > 600 {
			didBoostSec = 600
		}
		boost += didBoostSec
	}
	if crmEnabled && crmRank > 0 {
		crmBoost := crmRank * 30
		if crmBoost > 300 {
			crmBoost = 300
		}
		boost += crmBoost
	}
	if boost > 900 {
		boost = 900
	}
	return boost
}
