// export_test.go exposes internal functions for black-box tests in package consent_test.
package consent

import (
	"context"
	"errors"
)

// NoopSinkForTest returns a Sink that discards all rows.
func NoopSinkForTest() Sink {
	return noopSink{}
}

// StdoutSinkForTest returns a StdoutSink for coverage.
func StdoutSinkForTest() Sink {
	return StdoutSink{}
}

// errSink returns a Sink that always returns an error (tests audit-drop path).
type errSink struct{}

func (errSink) Write(_ context.Context, _ ConsentLogRow) error {
	return errors.New("sink error")
}

// ErrSinkForTest returns a Sink that always errors.
func ErrSinkForTest() Sink {
	return errSink{}
}

// StrictTwoPartyStates returns the set of 2-letter codes with a stateRules entry.
// Used by parametric tests to iterate known strict states.
func StrictTwoPartyStates() map[string]ConsentRule {
	out := make(map[string]ConsentRule, len(stateRules))
	for k, v := range stateRules {
		out[k] = v
	}
	return out
}

// LegalFloorForTest exposes legalFloor for property tests.
func LegalFloorForTest(state string) Mode {
	return legalFloor(state)
}

// PickReasonForTest exposes pickReason for tests.
func PickReasonForTest(
	b2bApplied, campaignBumped, tenantBumped bool,
	leadMode, callerMode Mode,
	leadHas, callerHas bool,
	leadStateUnknown, callerStateUnknown bool,
	final Mode, tenantMin Mode,
	campaignOverride *Mode,
) string {
	return pickReason(b2bApplied, campaignBumped, tenantBumped,
		leadMode, callerMode, leadHas, callerHas,
		leadStateUnknown, callerStateUnknown,
		final, tenantMin, campaignOverride)
}
