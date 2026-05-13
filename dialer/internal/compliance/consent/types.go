package consent

import "time"

// Mode is the recording-consent decision vocabulary, ordered low-to-high strictness.
// The numeric ordering is significant: StricterOf uses > comparison.
type Mode uint8

const (
	// ModeAllow — 1-party state; no prompt; record immediately.
	ModeAllow Mode = iota // 0
	// ModePromptBeep — §64.501 continuous beep; record immediately.
	ModePromptBeep // 1
	// ModePromptMessage — verbal disclosure; implied consent via continued participation.
	ModePromptMessage // 2
	// ModeRequireActive — verbal + DTMF/ASR confirmation.
	ModeRequireActive // 3
	// ModeSkip — do NOT record.
	ModeSkip // 4
)

// modeNames maps Mode values to their canonical string representations.
var modeNames = [5]string{"ALLOW", "PROMPT_BEEP", "PROMPT_MESSAGE", "REQUIRE_ACTIVE", "SKIP"}

// String returns the canonical uppercase string for the mode.
// Panics on out-of-range values (programmer error).
func (m Mode) String() string {
	if int(m) >= len(modeNames) {
		return "UNKNOWN"
	}
	return modeNames[m]
}

// ParseMode parses a canonical mode string. Returns ModeAllow and false if not found.
func ParseMode(s string) (Mode, bool) {
	for i, n := range modeNames {
		if n == s {
			return Mode(i), true
		}
	}
	return ModeAllow, false
}

// StricterOf returns the more restrictive (higher) of two Modes.
// Used to implement the four-way intersection:
// StricterOf(legalLead, legalCaller) then StricterOf(result, tenantMin) then StricterOf(result, campaignOverride).
func StricterOf(a, b Mode) Mode {
	if a > b {
		return a
	}
	return b
}

// RecordingPurpose classifies why a call is being recorded.
// PA §5704(15) B2B carveout applies only to Training, QualityControl, Monitoring.
type RecordingPurpose string

const (
	PurposeGeneral        RecordingPurpose = "general"
	PurposeTraining       RecordingPurpose = "training"
	PurposeQualityControl RecordingPurpose = "quality_control"
	PurposeMonitoring     RecordingPurpose = "monitoring"
)

// CampaignRecordingPolicy is the campaign-level recording policy.
// PolicyNever short-circuits to ModeSkip regardless of state law.
type CampaignRecordingPolicy string

const (
	PolicyAlways   CampaignRecordingPolicy = "ALWAYS"
	PolicyNever    CampaignRecordingPolicy = "NEVER"
	PolicyOnDemand CampaignRecordingPolicy = "ON_DEMAND"
	PolicyAuto     CampaignRecordingPolicy = "AUTO"
)

// CheckRequest is the full input to CheckConsent.
// All state/policy values are populated by T04 from D03 + tenant/campaign config.
type CheckRequest struct {
	TenantID   int64
	CampaignID int64
	LeadID     int64
	// CallUUID is "" at hopper-time; set at originate time. Written to audit row.
	CallUUID string

	// State signals — populated by T04 from D03 + tenant config.
	LeadState   string // 2-letter US code; "" if unknown
	CallerState string // 2-letter US code; "" if unknown (Phase 4: per-user)

	// B2B + purpose — for PA §5704(15) carveout.
	LeadIsBusiness           bool
	CampaignRecordingPurpose RecordingPurpose

	// Campaign / tenant policy.
	CampaignRecordingPolicy CampaignRecordingPolicy
	TenantMinimumMode       Mode
	// CampaignOverrideMode is nil = use tenant minimum.
	// Can only TIGHTEN, never loosen below legal floor.
	CampaignOverrideMode *Mode

	// Audio asset (passed through to CheckResult; C02 does not validate file exists).
	ConsentMsgAudioPath string // e.g., "/var/lib/freeswitch/sounds/consent/tenant_42/msg.wav"
	OptOutAction        string // "continue_no_record" | "hangup"

	// Time anchor for audit; zero value = time.Now() at call time.
	When time.Time
}

// CheckResult is the output of CheckConsent.
// Consumed by T04 (channel-var writer) and R01 (record_session gate).
type CheckResult struct {
	Decision     Mode
	StateApplied string // 2-letter code that drove the decision (after stricter-state-wins)
	Mechanism    string // e.g., "PROMPT_MESSAGE/lead=CA/caller=TX" — human-readable
	Reason       string // controlled vocab; see reasons.go
	PromptAudio  string // set if Decision ∈ {PromptMessage, RequireActive}; "" otherwise
	OptOutAction string // set if Decision == RequireActive; "" otherwise
	Citation     string // statute cite for audit log

	// T04 channel-var serialization helpers.
	ConsentRequired bool // true iff Decision != Allow && Decision != Skip
	ConsentRecord   bool // true iff Decision != Skip
}

// ConsentRule is the codegen target type — one row from consent_rules.csv.
type ConsentRule struct {
	State       string // 2-letter US code
	MinimumMode Mode   // PROMPT_MESSAGE for 2-party; ALLOW absent from map
	BeepAccepted bool  // for tenant policy validation (not currently enforced here)
	B2BExempt   bool  // true only for PA Phase 1
	Citation    string // statute cite; e.g., "Cal. Penal Code §§632 632.7"
}
