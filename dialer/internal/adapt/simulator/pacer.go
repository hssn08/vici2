// E03 is a clean-room Go port of Vicidial AST_VDadapt.pl (public GPL source,
// in source control since at least 2008 per inktel/Vicidial git history).
// Improvements: explicit anti-windup (back-calculation), deadband, drop_gated fast-cut.
// Prior art documented per SPEC patent-defense protocol.

package simulator

// MockPacer implements a simplified E02 pacing formula for the simulator.
// desired_new_originates = max(0, round(ready_agents × dial_level) - active_calls)
type MockPacer struct{}

// Desired returns the number of new dials to attempt this tick.
// ready: currently ready agents; dialLevel: E03's output; active: calls in progress.
func (p MockPacer) Desired(ready int, dialLevel float64, active int) int {
	desired := int(float64(ready)*dialLevel+0.5) - active
	if desired < 0 {
		return 0
	}
	return desired
}
