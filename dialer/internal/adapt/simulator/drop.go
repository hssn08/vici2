// E03 is a clean-room Go port of Vicidial AST_VDadapt.pl (public GPL source,
// in source control since at least 2008 per inktel/Vicidial git history).
// Improvements: explicit anti-windup (back-calculation), deadband, drop_gated fast-cut.
// Prior art documented per SPEC patent-defense protocol.

package simulator

// MockDropTracker mocks E05: tracks answered + dropped calls and computes
// a rolling drop percentage approximation.
//
// Real E05 uses a 30-day window (2880 × 15-s ticks). The simulator uses a
// shorter window for faster convergence: windowTicks ticks.
type MockDropTracker struct {
	windowTicks int
	answered    []int // ring buffer
	dropped     []int // ring buffer
	pos         int
	total       int
}

// NewMockDropTracker creates a tracker with a given window in ticks.
// Use 192 for a 48-minute window (fast convergence) or 2880 for 30-day parity.
func NewMockDropTracker(windowTicks int) *MockDropTracker {
	if windowTicks <= 0 {
		windowTicks = 192
	}
	return &MockDropTracker{
		windowTicks: windowTicks,
		answered:    make([]int, windowTicks),
		dropped:     make([]int, windowTicks),
	}
}

// Record adds answered/dropped counts for one tick.
func (t *MockDropTracker) Record(answered, dropped int) {
	t.answered[t.pos] = answered
	t.dropped[t.pos] = dropped
	t.pos = (t.pos + 1) % t.windowTicks
	if t.total < t.windowTicks {
		t.total++
	}
}

// DropPct returns the rolling drop percentage (dropped/(dropped+answered) × 100).
func (t *MockDropTracker) DropPct() float64 {
	var totalAnswered, totalDropped int
	for i := 0; i < t.windowTicks; i++ {
		totalAnswered += t.answered[i]
		totalDropped += t.dropped[i]
	}
	total := totalAnswered + totalDropped
	if total == 0 {
		return 0
	}
	return float64(totalDropped) / float64(total) * 100.0
}

// IsGated returns true if drop% exceeds the threshold (FCC analog).
func (t *MockDropTracker) IsGated(threshold float64) bool {
	return t.DropPct() >= threshold
}
