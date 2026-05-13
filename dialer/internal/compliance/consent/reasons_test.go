package consent_test

import (
	"context"
	"testing"
	"time"

	"github.com/vici2/dialer/internal/compliance/consent"
)

// TestReasonVocabularyExhaustive runs a battery of scenarios and asserts that
// every returned reason string appears in AllReasons (the controlled vocabulary).
// This would catch a typo or a new code path that forgot to register a reason.
func TestReasonVocabularyExhaustive(t *testing.T) {
	c, err := consent.New(consent.CheckerOpts{
		Audit: consent.NoopSinkForTest(),
		NowFn: func() time.Time { return time.Date(2026, 5, 13, 15, 0, 0, 0, time.UTC) },
	})
	if err != nil {
		t.Fatalf("consent.New: %v", err)
	}

	ctx := context.Background()
	now := time.Date(2026, 5, 13, 15, 0, 0, 0, time.UTC)

	require_active := consent.ModeRequireActive
	prompt_beep := consent.ModePromptBeep
	allow := consent.ModeAllow

	probes := []struct {
		desc string
		req  consent.CheckRequest
	}{
		{
			"ok (TX→TX no overrides)",
			consent.CheckRequest{
				LeadState: "TX", CallerState: "TX",
				CampaignRecordingPolicy: consent.PolicyAlways,
				TenantMinimumMode:       consent.ModeAllow, When: now,
			},
		},
		{
			"campaign_disabled (NEVER policy)",
			consent.CheckRequest{
				LeadState: "CA", CallerState: "CA",
				CampaignRecordingPolicy: consent.PolicyNever,
				TenantMinimumMode:       consent.ModeAllow, When: now,
			},
		},
		{
			"tenant_policy_skip",
			consent.CheckRequest{
				LeadState: "TX", CallerState: "TX",
				CampaignRecordingPolicy: consent.PolicyAlways,
				TenantMinimumMode:       consent.ModeSkip, When: now,
			},
		},
		{
			"state_2party_lead (CA lead, TX caller)",
			consent.CheckRequest{
				LeadState: "CA", CallerState: "TX",
				CampaignRecordingPolicy: consent.PolicyAlways,
				TenantMinimumMode:       consent.ModeAllow, When: now,
			},
		},
		{
			"state_2party_caller (TX lead, CA caller)",
			consent.CheckRequest{
				LeadState: "TX", CallerState: "CA",
				CampaignRecordingPolicy: consent.PolicyAlways,
				TenantMinimumMode:       consent.ModeAllow, When: now,
			},
		},
		{
			"state_2party_both (CA lead, CA caller)",
			consent.CheckRequest{
				LeadState: "CA", CallerState: "CA",
				CampaignRecordingPolicy: consent.PolicyAlways,
				TenantMinimumMode:       consent.ModeAllow, When: now,
			},
		},
		{
			"tenant_minimum_floor (TX→TX, tenant=PROMPT_MESSAGE, no campaign override)",
			consent.CheckRequest{
				LeadState: "TX", CallerState: "TX",
				CampaignRecordingPolicy: consent.PolicyAlways,
				TenantMinimumMode:       consent.ModePromptMessage, When: now,
			},
		},
		{
			"campaign_override (TX→TX, tenant=PROMPT_MESSAGE, campaign=PROMPT_MESSAGE)",
			consent.CheckRequest{
				LeadState: "TX", CallerState: "TX",
				CampaignRecordingPolicy: consent.PolicyAlways,
				TenantMinimumMode:       consent.ModeAllow,
				CampaignOverrideMode:    &prompt_beep, // beep via campaign → campaign_override path... actually beep_campaign
				When:                    now,
			},
		},
		{
			"b2b_pa_carveout",
			consent.CheckRequest{
				LeadState: "PA", CallerState: "TX",
				LeadIsBusiness:           true,
				CampaignRecordingPurpose: consent.PurposeTraining,
				CampaignRecordingPolicy:  consent.PolicyAlways,
				TenantMinimumMode:        consent.ModeAllow, When: now,
			},
		},
		{
			"lead_state_unknown",
			consent.CheckRequest{
				LeadState: "", CallerState: "TX",
				CampaignRecordingPolicy: consent.PolicyAlways,
				TenantMinimumMode:       consent.ModeAllow, When: now,
			},
		},
		{
			"caller_state_unknown (TX lead, unknown caller, no tenant floor)",
			consent.CheckRequest{
				LeadState: "TX", CallerState: "",
				CampaignRecordingPolicy: consent.PolicyAlways,
				TenantMinimumMode:       consent.ModeAllow, When: now,
			},
		},
		{
			"require_active_tenant",
			consent.CheckRequest{
				LeadState: "TX", CallerState: "TX",
				CampaignRecordingPolicy: consent.PolicyAlways,
				TenantMinimumMode:       consent.ModeRequireActive, When: now,
			},
		},
		{
			"require_active_campaign",
			consent.CheckRequest{
				LeadState: "TX", CallerState: "TX",
				CampaignRecordingPolicy: consent.PolicyAlways,
				TenantMinimumMode:       consent.ModeAllow,
				CampaignOverrideMode:    &require_active,
				When:                    now,
			},
		},
		{
			"beep_tenant",
			consent.CheckRequest{
				LeadState: "TX", CallerState: "TX",
				CampaignRecordingPolicy: consent.PolicyAlways,
				TenantMinimumMode:       consent.ModePromptBeep, When: now,
			},
		},
		{
			"beep_campaign",
			consent.CheckRequest{
				LeadState: "TX", CallerState: "TX",
				CampaignRecordingPolicy: consent.PolicyAlways,
				TenantMinimumMode:       consent.ModeAllow,
				CampaignOverrideMode:    &prompt_beep,
				When:                    now,
			},
		},
		// campaign_override (non-beep, non-require_active)
		{
			"campaign_override (PROMPT_MESSAGE bumped by campaign)",
			consent.CheckRequest{
				LeadState: "TX", CallerState: "TX",
				CampaignRecordingPolicy: consent.PolicyAlways,
				TenantMinimumMode:       consent.ModeAllow,
				CampaignOverrideMode:    func() *consent.Mode { m := consent.ModePromptMessage; return &m }(),
				When:                    now,
			},
		},
		// allow override below legal floor → stays at legal floor
		{
			"campaign tries to loosen below floor (stays at state_2party_lead)",
			consent.CheckRequest{
				LeadState: "CA", CallerState: "TX",
				CampaignRecordingPolicy: consent.PolicyAlways,
				TenantMinimumMode:       consent.ModeAllow,
				CampaignOverrideMode:    &allow,
				When:                    now,
			},
		},
	}

	// Verify AllReasons covers the complete expected set from reasons.go.
	expectedReasons := map[string]struct{}{
		"ok":                    {},
		"campaign_disabled":     {},
		"tenant_policy_skip":    {},
		"state_2party_lead":     {},
		"state_2party_caller":   {},
		"state_2party_both":     {},
		"tenant_minimum_floor":  {},
		"campaign_override":     {},
		"b2b_pa_carveout":       {},
		"lead_state_unknown":    {},
		"caller_state_unknown":  {},
		"require_active_tenant": {},
		"require_active_campaign": {},
		"beep_tenant":           {},
		"beep_campaign":         {},
	}
	for r := range expectedReasons {
		if _, ok := consent.AllReasons[r]; !ok {
			t.Errorf("AllReasons is missing expected reason %q", r)
		}
	}
	for r := range consent.AllReasons {
		if _, ok := expectedReasons[r]; !ok {
			t.Errorf("AllReasons has unexpected reason %q not in expected set", r)
		}
	}

	// Run all probes and verify returned reason is in vocabulary.
	for _, p := range probes {
		p := p
		t.Run(p.desc, func(t *testing.T) {
			res, err := c.CheckConsent(ctx, p.req)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if _, ok := consent.AllReasons[res.Reason]; !ok {
				t.Errorf("reason %q not in AllReasons controlled vocabulary", res.Reason)
			}
		})
	}
}
