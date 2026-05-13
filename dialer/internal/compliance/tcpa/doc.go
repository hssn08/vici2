// Package tcpa implements the TCPA called-party-local-time gate (8am–9pm),
// enforcing the federal hard floor plus applicable state-specific restrictions.
//
// # Architecture
//
// The canonical implementation lives here in Go and is consumed by:
//   - E01 hopper filler (enforcement point: hopper_filler)
//   - E02 pacing loop (boundary advisory via WindowClosesWithin)
//   - T04 originate path (enforcement point: originate_path, last-chance gate)
//   - A04 manual dial via the TS mirror (enforcement point: manual_dial)
//
// A TypeScript mirror (api/src/compliance/tcpa/) is generated from the same
// state_rules.csv source-of-truth and used by the Node API for manual-dial
// checks before the gRPC call into the Go dialer.
//
// # Public API
//
// The primary entry-point is [Checker.Check]:
//
//	res, err := tcpa.Default.Check(ctx, tcpa.CheckRequest{
//	    LeadID:           lead.ID,
//	    PhoneE164:        lead.PhoneE164,
//	    KnownTimezone:    lead.KnownTimezone,
//	    State:            lead.State,
//	    CampaignID:       campaign.ID,
//	    UnknownTzPolicy:  campaign.UnknownTzPolicy,
//	    EnforcementPoint: tcpa.PointHopper,
//	    IsAutoDialer:     campaign.DialMethod != "manual",
//	    When:             time.Now(),
//	})
//
// Returns a [CheckResult] with Outcome ∈ {ALLOW, SKIP_UNTIL, BLOCK_INVALID}.
//
// # Rule encoding
//
// Federal floor: 08:00–21:00 called-party local time, all days, unconditionally.
// State overrides (stateRules) are generated from db/seeds/state_rules.csv by
// the tcpa-rulesgen script; rules_gen.go is committed (DO NOT EDIT manually).
//
// # References
//
//   - PLAN: spec/modules/C01/PLAN.md
//   - Federal: 47 USC §227(b)(3); 47 CFR 64.1200(c)(1)
//   - Stake: $500/$1,500 per illegal call
package tcpa
