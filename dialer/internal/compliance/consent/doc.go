// Package consent implements the C02 recording-consent state-matrix decision gate.
//
// # Overview
//
// C02 is the decider: it maps (callerState, leadState, tenantPolicy, campaignOverride)
// to one of five recording-consent modes and writes an immutable audit row for
// every call decision.  It does NOT play audio (F03), does NOT start recording
// (R01), and does NOT enforce DB immutability (C03).
//
// # Decision modes (strictness order low → high)
//
//	ALLOW          → 1-party state, no prompt; record immediately.
//	PROMPT_BEEP    → §64.501 continuous beep; record immediately.
//	PROMPT_MESSAGE → verbal disclosure + implied consent (default in 2-party states).
//	REQUIRE_ACTIVE → verbal + DTMF/ASR confirmation.
//	SKIP           → do NOT record.
//
// # 13 strict 2-party states (Phase 1)
//
//	CA, CT, DE, FL, IL, MD, MA, MI, MT, NH, OR, PA, WA
//
// All other US states + DC + 5 territories default to ALLOW (1-party federal floor,
// 18 USC §2511(2)(d)).
//
// # Key decision rules
//
//   - Stricter-state-wins (Kearney v. Salomon Smith Barney): if either party is in
//     a 2-party state, the 2-party rule applies.
//   - Campaign cannot loosen below legal floor (StricterOf monotonic).
//   - PA B2B carveout (§5704(15)): recording_purpose ∈ {training, quality_control,
//     monitoring} + LeadIsBusiness → ALLOW. C04 enforces 1-year retention.
//   - Unknown lead.state → PROMPT_MESSAGE + metric page (conservative).
//   - campaigns.recording_policy=NEVER → SKIP short-circuit.
//
// # Public API
//
//	res, err := consent.Default.CheckConsent(ctx, consent.CheckRequest{
//	    TenantID:                 tenant.ID,
//	    CampaignID:               campaign.ID,
//	    LeadID:                   lead.ID,
//	    LeadState:                lead.State,
//	    CallerState:              tenant.DefaultCallerState,
//	    LeadIsBusiness:           lead.IsBusiness,
//	    CampaignRecordingPurpose: campaign.RecordingPurpose,
//	    CampaignRecordingPolicy:  campaign.RecordingPolicy,
//	    TenantMinimumMode:        tenant.ConsentMinimumMode,
//	    CampaignOverrideMode:     campaign.ConsentPolicyOverride,
//	    ConsentMsgAudioPath:      campaign.ConsentMsgAudio,
//	    OptOutAction:             campaign.OptOutAction,
//	    When:                     time.Now(),
//	})
//
// # References
//
//   - PLAN: spec/modules/C02/PLAN.md
//   - RESEARCH: spec/modules/C02/RESEARCH.md
//   - Stake: Cal. Penal Code §637.2 — $5,000/call statutory damages
package consent
