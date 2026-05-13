package picker

import (
	"testing"
)

// TestRetryPolicyAllOutcomes verifies the 18-row outcome→D04 status table.
// Every DialOutcome constant must have an entry in outcomePolicy.
func TestRetryPolicyAllOutcomes(t *testing.T) {
	allOutcomes := []struct {
		outcome    DialOutcome
		wantStatus string
		wantRequeue bool
	}{
		{OutcomeBridged, "", false},
		{OutcomeNoAnswer, "NA", true},
		{OutcomeBusy, "B-CAR", true},
		{OutcomeAMD, "A", false},
		{OutcomeInvalidNumber, "INVALID", false},
		{OutcomeCarrierFail, "CARRIER_FAIL", true},
		{OutcomeGatewayLimit, "GATEWAY_LIMIT_TRY_LATER", true},
		{OutcomeTCPABlocked, "TCPA", true},
		{OutcomeDNCBlocked, "DNC", false},
		{OutcomeConsentBlocked, "CONSENT_NOT_OBTAINED", false},
		{OutcomeCircuitOpen, "", true},
		{OutcomeRateLimited, "", true},
		{OutcomeMediaTimeout, "MEDIA_TO", true},
		{OutcomeTimeout, "TIMEOT", true},
		{OutcomeDropAbandon, "DROP", true},
		{OutcomeAgentDisconnect, "ADC", true},
		{OutcomeCampaignPaused, "", true},
		{OutcomeLeadIneligible, "", false},
	}

	if len(allOutcomes) != 18 {
		t.Fatalf("expected 18 outcomes, got %d", len(allOutcomes))
	}

	for _, tc := range allOutcomes {
		t.Run(tc.outcome.String(), func(t *testing.T) {
			policy := PolicyFor(tc.outcome)
			if policy.D04Status != tc.wantStatus {
				t.Errorf("outcome %s: D04Status = %q, want %q",
					tc.outcome, policy.D04Status, tc.wantStatus)
			}
			if policy.Requeue != tc.wantRequeue {
				t.Errorf("outcome %s: Requeue = %v, want %v",
					tc.outcome, policy.Requeue, tc.wantRequeue)
			}
		})
	}
}

// TestRetryPolicyImmediate verifies that "gateway problem" outcomes requeue immediately.
func TestRetryPolicyImmediate(t *testing.T) {
	immediateOutcomes := []DialOutcome{
		OutcomeCarrierFail,
		OutcomeGatewayLimit,
		OutcomeAgentDisconnect,
		OutcomeCampaignPaused,
	}
	for _, o := range immediateOutcomes {
		p := PolicyFor(o)
		if !p.Immediate {
			t.Errorf("expected Immediate=true for %s, got false", o)
		}
	}
}

// TestRetryPolicyFreeze verifies that CircuitOpen sets Freeze=true.
func TestRetryPolicyFreeze(t *testing.T) {
	p := PolicyFor(OutcomeCircuitOpen)
	if !p.Freeze {
		t.Error("expected Freeze=true for OutcomeCircuitOpen")
	}
}

// TestRetryPolicyTerminal verifies that terminal outcomes do not requeue.
func TestRetryPolicyTerminal(t *testing.T) {
	terminalOutcomes := []DialOutcome{
		OutcomeBridged,
		OutcomeInvalidNumber,
		OutcomeDNCBlocked,
		OutcomeConsentBlocked,
		OutcomeLeadIneligible,
	}
	for _, o := range terminalOutcomes {
		p := PolicyFor(o)
		if p.Requeue {
			t.Errorf("expected Requeue=false for terminal outcome %s, got true", o)
		}
	}
}

// TestPolicyForUnknown verifies that an unknown outcome returns safe default.
func TestPolicyForUnknown(t *testing.T) {
	unknownOutcome := DialOutcome(999)
	p := PolicyFor(unknownOutcome)
	if p.Requeue {
		t.Error("unexpected Requeue=true for unknown outcome")
	}
}

// TestDialOutcomeString verifies all outcomes have a non-empty string.
func TestDialOutcomeString(t *testing.T) {
	outcomes := []DialOutcome{
		OutcomeBridged, OutcomeNoAnswer, OutcomeBusy, OutcomeAMD,
		OutcomeInvalidNumber, OutcomeCarrierFail, OutcomeGatewayLimit,
		OutcomeTCPABlocked, OutcomeDNCBlocked, OutcomeConsentBlocked,
		OutcomeCircuitOpen, OutcomeRateLimited, OutcomeMediaTimeout,
		OutcomeTimeout, OutcomeDropAbandon, OutcomeAgentDisconnect,
		OutcomeCampaignPaused, OutcomeLeadIneligible,
	}
	for _, o := range outcomes {
		if o.String() == "" || o.String() == "unknown" {
			t.Errorf("outcome %d has empty/unknown string", int(o))
		}
	}
}
