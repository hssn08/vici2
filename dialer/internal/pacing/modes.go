// modes.go — mode dispatch helpers.
//
// E02 PLAN §7: 5-line switch to resolve dial level and agent count.
// The three ADAPT subtypes are indistinguishable to E02; E03 owns their math.
package pacing

// resolveLevel returns the effective dial_level multiplier for this tick.
// MANUAL is handled upstream (Decide returns 0 immediately), so it is not
// reached here in practice — but we guard it to be safe.
func resolveLevel(snap Snapshot) float64 {
	switch snap.Config.DialMethod {
	case DialMethodManual:
		return 0
	case DialMethodProgressive:
		return 1.0
	case DialMethodRatio:
		return snap.Config.AutoDialLevel
	default: // ADAPT_HARD, ADAPT_AVG, ADAPT_TAPERED — E03 writes the value
		if snap.DialLevel > 0 {
			return snap.DialLevel
		}
		// Cold-start fallback: E03 not yet published; use auto_dial_level.
		if snap.Config.AutoDialLevel > 0 {
			return snap.Config.AutoDialLevel
		}
		return 1.0
	}
}

// resolveAgents returns the effective agent count for the formula.
// E02 PLAN §2.2: PROGRESSIVE always uses READY-only; RATIO respects tally flag.
func resolveAgents(snap Snapshot) int {
	switch snap.Config.DialMethod {
	case DialMethodProgressive:
		return snap.ReadyAgents
	case DialMethodRatio:
		if snap.Config.AvailableOnlyTally {
			return snap.ReadyAgents
		}
		return snap.ReadyAgents + snap.InCallAgents + snap.WrapupAgents
	default: // ADAPT_* — READY only per PLAN §2.2
		return snap.ReadyAgents
	}
}
