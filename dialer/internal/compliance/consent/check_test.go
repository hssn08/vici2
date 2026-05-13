package consent_test

import (
	"context"
	_ "embed"
	"encoding/json"
	"testing"
	"time"

	"github.com/vici2/dialer/internal/compliance/consent"
)

//go:embed fixtures.json
var fixturesJSON []byte

type fixtureReq struct {
	TenantID                 int64   `json:"tenantID"`
	CampaignID               int64   `json:"campaignID"`
	LeadID                   int64   `json:"leadID"`
	CallUUID                 string  `json:"callUUID"`
	LeadState                string  `json:"leadState"`
	CallerState              string  `json:"callerState"`
	LeadIsBusiness           bool    `json:"leadIsBusiness"`
	CampaignRecordingPurpose string  `json:"campaignRecordingPurpose"`
	CampaignRecordingPolicy  string  `json:"campaignRecordingPolicy"`
	TenantMinimumMode        string  `json:"tenantMinimumMode"`
	CampaignOverrideMode     *string `json:"campaignOverrideMode"`
	ConsentMsgAudioPath      string  `json:"consentMsgAudioPath"`
	OptOutAction             string  `json:"optOutAction"`
}

type fixtureWant struct {
	Decision string `json:"decision"`
	Reason   string `json:"reason"`
}

type fixture struct {
	ID   int         `json:"id"`
	Desc string      `json:"desc"`
	Req  fixtureReq  `json:"req"`
	Want fixtureWant `json:"want"`
}

func newTestChecker(t *testing.T) *consent.Checker {
	t.Helper()
	c, err := consent.New(consent.CheckerOpts{
		Audit: consent.NoopSinkForTest(),
		NowFn: func() time.Time { return time.Date(2026, 5, 13, 15, 0, 0, 0, time.UTC) },
	})
	if err != nil {
		t.Fatalf("consent.New: %v", err)
	}
	return c
}

func parseMode(t *testing.T, s string) consent.Mode {
	t.Helper()
	m, ok := consent.ParseMode(s)
	if !ok {
		t.Fatalf("unknown mode %q", s)
	}
	return m
}

func TestCheckFixtures(t *testing.T) {
	var fixtures []fixture
	if err := json.Unmarshal(fixturesJSON, &fixtures); err != nil {
		t.Fatalf("parse fixtures: %v", err)
	}
	if len(fixtures) != 15 {
		t.Fatalf("expected 15 fixtures, got %d", len(fixtures))
	}

	c := newTestChecker(t)
	ctx := context.Background()

	for _, fx := range fixtures {
		fx := fx
		t.Run(fx.Desc, func(t *testing.T) {
			req := consent.CheckRequest{
				TenantID:                 fx.Req.TenantID,
				CampaignID:               fx.Req.CampaignID,
				LeadID:                   fx.Req.LeadID,
				CallUUID:                 fx.Req.CallUUID,
				LeadState:                fx.Req.LeadState,
				CallerState:              fx.Req.CallerState,
				LeadIsBusiness:           fx.Req.LeadIsBusiness,
				CampaignRecordingPurpose: consent.RecordingPurpose(fx.Req.CampaignRecordingPurpose),
				CampaignRecordingPolicy:  consent.CampaignRecordingPolicy(fx.Req.CampaignRecordingPolicy),
				TenantMinimumMode:        parseMode(t, fx.Req.TenantMinimumMode),
				ConsentMsgAudioPath:      fx.Req.ConsentMsgAudioPath,
				OptOutAction:             fx.Req.OptOutAction,
				When:                     time.Date(2026, 5, 13, 15, 0, 0, 0, time.UTC),
			}
			if fx.Req.CampaignOverrideMode != nil {
				m := parseMode(t, *fx.Req.CampaignOverrideMode)
				req.CampaignOverrideMode = &m
			}

			res, err := c.CheckConsent(ctx, req)
			if err != nil {
				t.Fatalf("fixture %d: unexpected error: %v", fx.ID, err)
			}

			wantDecision := parseMode(t, fx.Want.Decision)
			if res.Decision != wantDecision {
				t.Errorf("fixture %d (%s): decision = %s, want %s",
					fx.ID, fx.Desc, res.Decision, wantDecision)
			}
			if res.Reason != fx.Want.Reason {
				t.Errorf("fixture %d (%s): reason = %q, want %q",
					fx.ID, fx.Desc, res.Reason, fx.Want.Reason)
			}

			// Invariant: ConsentRequired is true iff Decision is not Allow or Skip.
			wantRequired := res.Decision != consent.ModeAllow && res.Decision != consent.ModeSkip
			if res.ConsentRequired != wantRequired {
				t.Errorf("fixture %d: ConsentRequired = %v, want %v", fx.ID, res.ConsentRequired, wantRequired)
			}
			// Invariant: ConsentRecord is false iff Decision is Skip.
			wantRecord := res.Decision != consent.ModeSkip
			if res.ConsentRecord != wantRecord {
				t.Errorf("fixture %d: ConsentRecord = %v, want %v", fx.ID, res.ConsentRecord, wantRecord)
			}

			// Reason must be in the controlled vocabulary.
			if _, ok := consent.AllReasons[res.Reason]; !ok {
				t.Errorf("fixture %d: reason %q not in AllReasons", fx.ID, res.Reason)
			}
		})
	}
}

// TestExhaustiveStateMatrix runs all 51×51×4×2 combinations against the
// decision algorithm and validates basic invariants without needing a reference
// oracle — just the structural properties guaranteed by the spec.
func TestExhaustiveStateMatrix(t *testing.T) {
	c := newTestChecker(t)
	ctx := context.Background()

	// 51 states: 50 + DC (territories rarely in lead data but valid).
	states := []string{
		"", // unknown
		"AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
		"HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
		"MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
		"NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
		"SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC",
	}
	purposes := []consent.RecordingPurpose{
		consent.PurposeGeneral, consent.PurposeTraining,
		consent.PurposeQualityControl, consent.PurposeMonitoring,
	}
	isBiz := []bool{false, true}

	combos := 0
	for _, ls := range states {
		for _, cs := range states {
			for _, purpose := range purposes {
				for _, biz := range isBiz {
					combos++
					req := consent.CheckRequest{
						TenantID:                 1,
						CampaignID:               1,
						LeadID:                   1,
						LeadState:                ls,
						CallerState:              cs,
						LeadIsBusiness:           biz,
						CampaignRecordingPurpose: purpose,
						CampaignRecordingPolicy:  consent.PolicyAlways,
						TenantMinimumMode:        consent.ModeAllow,
						When:                     time.Date(2026, 5, 13, 15, 0, 0, 0, time.UTC),
					}

					res, err := c.CheckConsent(ctx, req)
					if err != nil {
						t.Errorf("ls=%s cs=%s purpose=%s biz=%v: error: %v", ls, cs, purpose, biz, err)
						continue
					}

					// Invariant 1: Decision >= legal floor for lead state.
					// Exception: PA B2B carveout (§5704(15)) lawfully lowers PROMPT_MESSAGE → ALLOW.
					leadFloor := consent.LegalFloorForTest(ls)
					if res.Reason != "b2b_pa_carveout" && res.Decision < leadFloor {
						t.Errorf("ls=%s cs=%s: Decision %s < leadFloor %s",
							ls, cs, res.Decision, leadFloor)
					}

					// Invariant 2: Decision >= legal floor for caller state.
					// Exception: same B2B carveout.
					callerFloor := consent.LegalFloorForTest(cs)
					if res.Reason != "b2b_pa_carveout" && res.Decision < callerFloor {
						t.Errorf("ls=%s cs=%s: Decision %s < callerFloor %s",
							ls, cs, res.Decision, callerFloor)
					}

					// Invariant 3: Reason is in controlled vocabulary.
					if _, ok := consent.AllReasons[res.Reason]; !ok {
						t.Errorf("ls=%s cs=%s: reason %q not in AllReasons", ls, cs, res.Reason)
					}

					// Invariant 4: ConsentRequired iff Decision ∉ {Allow, Skip}.
					wantRequired := res.Decision != consent.ModeAllow && res.Decision != consent.ModeSkip
					if res.ConsentRequired != wantRequired {
						t.Errorf("ls=%s cs=%s: ConsentRequired=%v, want %v",
							ls, cs, res.ConsentRequired, wantRequired)
					}

					// Invariant 5: ConsentRecord iff Decision != Skip.
					wantRecord := res.Decision != consent.ModeSkip
					if res.ConsentRecord != wantRecord {
						t.Errorf("ls=%s cs=%s: ConsentRecord=%v, want %v",
							ls, cs, res.ConsentRecord, wantRecord)
					}

					// Invariant 6: PromptAudio only set when Decision is PromptMessage/RequireActive.
					if res.PromptAudio != "" && res.Decision != consent.ModePromptMessage && res.Decision != consent.ModeRequireActive {
						t.Errorf("ls=%s cs=%s: PromptAudio non-empty for decision=%s", ls, cs, res.Decision)
					}
				}
			}
		}
	}
	t.Logf("exhaustive matrix: %d combinations checked", combos)
}

// TestStricterOfProperties verifies StricterOf is commutative and associative.
func TestStricterOfProperties(t *testing.T) {
	modes := []consent.Mode{
		consent.ModeAllow, consent.ModePromptBeep, consent.ModePromptMessage,
		consent.ModeRequireActive, consent.ModeSkip,
	}

	for _, a := range modes {
		for _, b := range modes {
			// Commutativity.
			if consent.StricterOf(a, b) != consent.StricterOf(b, a) {
				t.Errorf("StricterOf(%s,%s) != StricterOf(%s,%s)", a, b, b, a)
			}
			for _, c := range modes {
				// Associativity.
				lhs := consent.StricterOf(consent.StricterOf(a, b), c)
				rhs := consent.StricterOf(a, consent.StricterOf(b, c))
				if lhs != rhs {
					t.Errorf("StricterOf assoc failed: (%s,%s),%s vs %s,(%s,%s)",
						a, b, c, a, b, c)
				}
			}
		}
	}
}

// TestAll13TwoPartyStatesPromptByDefault verifies all 13 strict states
// return at least PROMPT_MESSAGE with default tenant settings.
func TestAll13TwoPartyStatesPromptByDefault(t *testing.T) {
	twoPartyStates := []string{"CA", "CT", "DE", "FL", "IL", "MD", "MA", "MI", "MT", "NH", "OR", "PA", "WA"}

	c := newTestChecker(t)
	ctx := context.Background()

	for _, state := range twoPartyStates {
		state := state
		t.Run(state, func(t *testing.T) {
			req := consent.CheckRequest{
				TenantID:                 1,
				CampaignID:               1,
				LeadID:                   1,
				LeadState:                state,
				CallerState:              "TX",
				LeadIsBusiness:           false,
				CampaignRecordingPurpose: consent.PurposeGeneral,
				CampaignRecordingPolicy:  consent.PolicyAlways,
				TenantMinimumMode:        consent.ModeAllow,
				When:                     time.Date(2026, 5, 13, 15, 0, 0, 0, time.UTC),
			}
			res, err := c.CheckConsent(ctx, req)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if res.Decision < consent.ModePromptMessage {
				t.Errorf("state %s: expected >= PROMPT_MESSAGE, got %s", state, res.Decision)
			}
		})
	}
}

// TestAll1PartyStatesAllow verifies a selection of 1-party states default to ALLOW.
func TestAll1PartyStatesAllow(t *testing.T) {
	onePartyStates := []string{"TX", "NY", "OH", "GA", "MN", "AZ", "NV", "CO"}

	c := newTestChecker(t)
	ctx := context.Background()

	for _, state := range onePartyStates {
		state := state
		t.Run(state, func(t *testing.T) {
			req := consent.CheckRequest{
				TenantID:                 1,
				CampaignID:               1,
				LeadID:                   1,
				LeadState:                state,
				CallerState:              "TX",
				LeadIsBusiness:           false,
				CampaignRecordingPurpose: consent.PurposeGeneral,
				CampaignRecordingPolicy:  consent.PolicyAlways,
				TenantMinimumMode:        consent.ModeAllow,
				When:                     time.Date(2026, 5, 13, 15, 0, 0, 0, time.UTC),
			}
			res, err := c.CheckConsent(ctx, req)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if res.Decision != consent.ModeAllow {
				t.Errorf("state %s: expected ALLOW, got %s (reason: %s)", state, res.Decision, res.Reason)
			}
		})
	}
}

// TestCampaignCannotLoosenBelowLegalFloor verifies the StricterOf monotonic invariant.
func TestCampaignCannotLoosenBelowLegalFloor(t *testing.T) {
	c := newTestChecker(t)
	ctx := context.Background()

	// CA lead with campaign override=ALLOW — must stay at PROMPT_MESSAGE.
	allow := consent.ModeAllow
	req := consent.CheckRequest{
		TenantID:                 1,
		CampaignID:               1,
		LeadID:                   1,
		LeadState:                "CA",
		CallerState:              "TX",
		LeadIsBusiness:           false,
		CampaignRecordingPurpose: consent.PurposeGeneral,
		CampaignRecordingPolicy:  consent.PolicyAlways,
		TenantMinimumMode:        consent.ModeAllow,
		CampaignOverrideMode:     &allow,
		When:                     time.Date(2026, 5, 13, 15, 0, 0, 0, time.UTC),
	}
	res, err := c.CheckConsent(ctx, req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.Decision != consent.ModePromptMessage {
		t.Errorf("CA lead with ALLOW override: expected PROMPT_MESSAGE, got %s", res.Decision)
	}
}

// TestIsStrictTwoParty exercises the helper.
func TestIsStrictTwoParty(t *testing.T) {
	twoParty := []string{"CA", "FL", "PA", "WA", "OR"}
	for _, s := range twoParty {
		if !consent.IsStrictTwoParty(s) {
			t.Errorf("IsStrictTwoParty(%s) = false, want true", s)
		}
	}
	oneParty := []string{"TX", "NY", "OH", ""}
	for _, s := range oneParty {
		if consent.IsStrictTwoParty(s) {
			t.Errorf("IsStrictTwoParty(%s) = true, want false", s)
		}
	}
}

// TestModeString verifies Mode.String() returns canonical names.
func TestModeString(t *testing.T) {
	cases := map[consent.Mode]string{
		consent.ModeAllow:         "ALLOW",
		consent.ModePromptBeep:    "PROMPT_BEEP",
		consent.ModePromptMessage: "PROMPT_MESSAGE",
		consent.ModeRequireActive: "REQUIRE_ACTIVE",
		consent.ModeSkip:          "SKIP",
	}
	for m, want := range cases {
		if got := m.String(); got != want {
			t.Errorf("Mode(%d).String() = %q, want %q", m, got, want)
		}
	}
}

// TestParseModeRoundtrip verifies ParseMode is the inverse of String().
func TestParseModeRoundtrip(t *testing.T) {
	modes := []consent.Mode{
		consent.ModeAllow, consent.ModePromptBeep, consent.ModePromptMessage,
		consent.ModeRequireActive, consent.ModeSkip,
	}
	for _, m := range modes {
		got, ok := consent.ParseMode(m.String())
		if !ok {
			t.Errorf("ParseMode(%q) returned false", m.String())
		}
		if got != m {
			t.Errorf("ParseMode(%q) = %v, want %v", m.String(), got, m)
		}
	}
	// Unknown string.
	_, ok := consent.ParseMode("BOGUS")
	if ok {
		t.Error("ParseMode(BOGUS) should return false")
	}
}

// TestStdoutSinkWrite exercises StdoutSink for coverage.
func TestStdoutSinkWrite(t *testing.T) {
	c, err := consent.New(consent.CheckerOpts{
		Audit: consent.StdoutSinkForTest(),
	})
	if err != nil {
		t.Fatalf("consent.New: %v", err)
	}
	ctx := context.Background()
	req := consent.CheckRequest{
		LeadState: "TX", CallerState: "TX",
		CampaignRecordingPolicy: consent.PolicyAlways,
		TenantMinimumMode:       consent.ModeAllow,
		When:                    time.Date(2026, 5, 13, 15, 0, 0, 0, time.UTC),
	}
	res, err := c.CheckConsent(ctx, req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.Decision != consent.ModeAllow {
		t.Errorf("expected ALLOW, got %s", res.Decision)
	}
}

// TestSinkErrorDoesNotPropagate verifies that an audit sink error does NOT
// cause CheckConsent to return an error (fire-and-forget async pattern).
func TestSinkErrorDoesNotPropagate(t *testing.T) {
	c, err := consent.New(consent.CheckerOpts{
		Audit: consent.ErrSinkForTest(),
	})
	if err != nil {
		t.Fatalf("consent.New: %v", err)
	}
	ctx := context.Background()
	req := consent.CheckRequest{
		LeadState: "CA", CallerState: "TX",
		CampaignRecordingPolicy: consent.PolicyAlways,
		TenantMinimumMode:       consent.ModeAllow,
		When:                    time.Date(2026, 5, 13, 15, 0, 0, 0, time.UTC),
	}
	// Should succeed despite sink error.
	res, err := c.CheckConsent(ctx, req)
	if err != nil {
		t.Fatalf("unexpected error from CheckConsent: %v", err)
	}
	if res.Decision != consent.ModePromptMessage {
		t.Errorf("expected PROMPT_MESSAGE, got %s", res.Decision)
	}
}

// TestPAB2BCarveoutAllPurposes verifies PA B2B carveout fires for training/QC/monitoring
// but NOT for general.
func TestPAB2BCarveoutAllPurposes(t *testing.T) {
	c := newTestChecker(t)
	ctx := context.Background()

	cases := []struct {
		purpose      consent.RecordingPurpose
		wantDecision consent.Mode
	}{
		{consent.PurposeTraining, consent.ModeAllow},
		{consent.PurposeQualityControl, consent.ModeAllow},
		{consent.PurposeMonitoring, consent.ModeAllow},
		{consent.PurposeGeneral, consent.ModePromptMessage},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(string(tc.purpose), func(t *testing.T) {
			req := consent.CheckRequest{
				TenantID:                 1,
				CampaignID:               1,
				LeadID:                   1,
				LeadState:                "PA",
				CallerState:              "TX",
				LeadIsBusiness:           true,
				CampaignRecordingPurpose: tc.purpose,
				CampaignRecordingPolicy:  consent.PolicyAlways,
				TenantMinimumMode:        consent.ModeAllow,
				When:                     time.Date(2026, 5, 13, 15, 0, 0, 0, time.UTC),
			}
			res, err := c.CheckConsent(ctx, req)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if res.Decision != tc.wantDecision {
				t.Errorf("purpose=%s: decision=%s, want %s", tc.purpose, res.Decision, tc.wantDecision)
			}
		})
	}
}
