package consent

// Reason constants form a stable controlled vocabulary for CheckResult.Reason.
// A linter test (reasons_test.go) asserts that no string outside this set is
// ever returned from CheckConsent.
//
// Adding a new reason requires updating this file AND AllReasons AND the test.
const (
	// ReasonOK — ModeAllow with no overrides; pure 1-party state.
	ReasonOK = "ok"
	// ReasonCampaignDisabled — campaigns.recording_policy=NEVER → ModeSkip.
	ReasonCampaignDisabled = "campaign_disabled"
	// ReasonTenantPolicySkip — tenants.consent_minimum_mode=SKIP.
	ReasonTenantPolicySkip = "tenant_policy_skip"
	// ReasonState2PartyLead — lead-state 2-party drove ModePromptMessage (Kearney lead side).
	ReasonState2PartyLead = "state_2party_lead"
	// ReasonState2partyCaller — caller-state 2-party drove ModePromptMessage (Kearney caller side).
	ReasonState2PartyCaller = "state_2party_caller"
	// ReasonState2PartyBoth — both states 2-party; pick the stricter.
	ReasonState2PartyBoth = "state_2party_both"
	// ReasonTenantMinimumFloor — tenant.consent_minimum_mode bumped legal floor up.
	ReasonTenantMinimumFloor = "tenant_minimum_floor"
	// ReasonCampaignOverride — campaigns.consent_policy_override bumped above tenant.
	ReasonCampaignOverride = "campaign_override"
	// ReasonB2BPACarveout — PA §5704(15) downgraded PROMPT_MESSAGE → ALLOW.
	ReasonB2BPACarveout = "b2b_pa_carveout"
	// ReasonLeadStateUnknown — lead.state=NULL; defaulted to PROMPT_MESSAGE + page.
	ReasonLeadStateUnknown = "lead_state_unknown"
	// ReasonCallerStateUnknown — tenant.default_caller_state=NULL; treated as ALLOW; page.
	ReasonCallerStateUnknown = "caller_state_unknown"
	// ReasonRequireActiveTenant — ModeRequireActive via tenant policy.
	ReasonRequireActiveTenant = "require_active_tenant"
	// ReasonRequireActiveCampaign — ModeRequireActive via campaign override.
	ReasonRequireActiveCampaign = "require_active_campaign"
	// ReasonBeepTenant — ModePromptBeep via tenant policy.
	ReasonBeepTenant = "beep_tenant"
	// ReasonBeepCampaign — ModePromptBeep via campaign override.
	ReasonBeepCampaign = "beep_campaign"
)

// AllReasons is the exhaustive set of reason strings.
// reasons_test.go asserts this set == all strings returned by CheckConsent.
var AllReasons = map[string]struct{}{
	ReasonOK:                    {},
	ReasonCampaignDisabled:      {},
	ReasonTenantPolicySkip:      {},
	ReasonState2PartyLead:       {},
	ReasonState2PartyCaller:     {},
	ReasonState2PartyBoth:       {},
	ReasonTenantMinimumFloor:    {},
	ReasonCampaignOverride:      {},
	ReasonB2BPACarveout:         {},
	ReasonLeadStateUnknown:      {},
	ReasonCallerStateUnknown:    {},
	ReasonRequireActiveTenant:   {},
	ReasonRequireActiveCampaign: {},
	ReasonBeepTenant:            {},
	ReasonBeepCampaign:          {},
}
