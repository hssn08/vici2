package picker

// RetryHint describes what E04 should do with a lead after a dial outcome.
// E01.Consumer.Release uses this hint + D04 recycle rules to compute the
// actual hopper re-ZADD score offset. E04 is stateless w.r.t. D04 schema.
type RetryHint struct {
	Requeue    bool   // true → lead should be re-queued in hopper
	Immediate  bool   // true → score offset 0 (immediate re-queue)
	D04Status  string // D04 statuses.status value to write to lead
	Freeze     bool   // true → freeze campaign 30 s (circuit_open)
}

// outcomePolicy is the 18-row table from PLAN §6.2.
// Maps DialOutcome → RetryHint.
var outcomePolicy = map[DialOutcome]RetryHint{
	OutcomeBridged: {
		Requeue:   false,
		D04Status: "", // terminal; agent dispo from A06 overrides
	},
	OutcomeNoAnswer: {
		Requeue:   true,
		Immediate: false,
		D04Status: "NA", // 300 s default; E01 reads per-status config
	},
	OutcomeBusy: {
		Requeue:   true,
		Immediate: false,
		D04Status: "B-CAR", // 180 s default
	},
	OutcomeAMD: {
		Requeue:   false, // per-list amd_action may override; default: terminal
		D04Status: "A",
	},
	OutcomeInvalidNumber: {
		Requeue:   false,
		D04Status: "INVALID", // dead number; never re-dials
	},
	OutcomeCarrierFail: {
		Requeue:   true,
		Immediate: true, // not a lead problem; gateway problem
		D04Status: "CARRIER_FAIL",
	},
	OutcomeGatewayLimit: {
		Requeue:   true,
		Immediate: true, // T02 routing may try sibling gateway
		D04Status: "GATEWAY_LIMIT_TRY_LATER",
	},
	OutcomeTCPABlocked: {
		Requeue:   true,
		Immediate: false,
		D04Status: "TCPA", // nextOpen ~9 AM local next day; C01 owns calculation
	},
	OutcomeDNCBlocked: {
		Requeue:   false,
		D04Status: "DNC", // permanently flagged
	},
	OutcomeConsentBlocked: {
		Requeue:   false,
		D04Status: "CONSENT_NOT_OBTAINED", // reserved for state recording bans
	},
	OutcomeCircuitOpen: {
		Requeue:   true,
		Immediate: false,
		Freeze:    true,  // freeze campaign 30 s
		D04Status: "",    // no status change; circuit issue not lead issue
	},
	OutcomeRateLimited: {
		Requeue:   true,
		Immediate: false,
		D04Status: "", // no status change; 300 s campaign-wide delay
	},
	OutcomeMediaTimeout: {
		Requeue:   true,
		Immediate: false,
		D04Status: "MEDIA_TO", // 300 s
	},
	OutcomeTimeout: {
		Requeue:   true,
		Immediate: false,
		D04Status: "TIMEOT", // 900 s; originate_timeout (22 s default) fired
	},
	OutcomeDropAbandon: {
		Requeue:   true,
		Immediate: false,
		D04Status: "DROP", // FCC 3% window; E05 records
	},
	OutcomeAgentDisconnect: {
		Requeue:   true,
		Immediate: true, // agent browser closed mid-bridge
		D04Status: "ADC",
	},
	OutcomeCampaignPaused: {
		Requeue:   true,
		Immediate: true, // re-enters hopper when campaign resumes
		D04Status: "",   // no status change
	},
	OutcomeLeadIneligible: {
		Requeue:   false,
		D04Status: "", // lead became DNC/dropped; E01 already handled
	},
}

// PolicyFor returns the RetryHint for a given DialOutcome.
// If the outcome is not in the table (should not happen), a safe default
// (requeue=false, no status change) is returned.
func PolicyFor(outcome DialOutcome) RetryHint {
	if h, ok := outcomePolicy[outcome]; ok {
		return h
	}
	return RetryHint{Requeue: false}
}
