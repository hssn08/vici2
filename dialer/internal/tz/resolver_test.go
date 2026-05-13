package tz

import (
	"context"
	"encoding/json"
	"os"
	"testing"
)

// testFixture mirrors the shape of fixtures_test.json.
type testFixture struct {
	Name    string `json:"name"`
	Req     struct {
		PhoneE164     string `json:"PhoneE164"`
		KnownTimezone string `json:"KnownTimezone"`
		Zip           string `json:"Zip"`
		State         string `json:"State"`
		CampaignID    string `json:"CampaignID"`
	} `json:"req"`
	WantIANA string `json:"wantIANA"`
	WantConf string `json:"wantConf"`
	SeedPhone []struct {
		NPA  string `json:"npa"`
		NXX  string `json:"nxx"`
		IANA string `json:"iana"`
	} `json:"seedPhone"`
	SeedZip []struct {
		Zip  string `json:"zip"`
		IANA string `json:"iana"`
	} `json:"seedZip"`
	SeedOverride []struct {
		NPA  string `json:"npa"`
		NXX  string `json:"nxx"`
		IANA string `json:"iana"`
	} `json:"seedOverride"`
	CampaignDefault *struct {
		CampID string `json:"campId"`
		IANA   string `json:"iana"`
	} `json:"campaignDefault"`
}

// buildTestResolver constructs a Resolver with in-memory maps from fixture seed data.
func buildTestResolver(t *testing.T, fix testFixture) *Resolver {
	t.Helper()
	r := &Resolver{
		campaignLRU: newCampaignCache(100),
	}

	// Seed phone_codes
	pm := make(phoneMap)
	for _, s := range fix.SeedPhone {
		loc, ok := loadLocation(s.IANA)
		if !ok {
			t.Fatalf("invalid seed IANA %q", s.IANA)
		}
		npaInt := npaParse(s.NPA)
		nxxInt := nxxParse(s.NXX)
		key := uint32(npaInt*1000 + nxxInt)
		pm[key] = cacheEntry{IANA: s.IANA, Loc: loc}
	}
	r.phoneCodesCache.Store(&pm)

	// Seed overrides
	om := make(phoneMap)
	for _, s := range fix.SeedOverride {
		loc, ok := loadLocation(s.IANA)
		if !ok {
			t.Fatalf("invalid override IANA %q", s.IANA)
		}
		npaInt := npaParse(s.NPA)
		nxxInt := nxxParse(s.NXX)
		key := uint32(npaInt*1000 + nxxInt)
		om[key] = cacheEntry{IANA: s.IANA, Loc: loc}
	}
	r.overrideCache.Store(&om)

	// Seed zip_codes
	zm := make(zipMap)
	for _, s := range fix.SeedZip {
		loc, ok := loadLocation(s.IANA)
		if !ok {
			t.Fatalf("invalid zip seed IANA %q", s.IANA)
		}
		zm[zipKey(s.Zip)] = cacheEntry{IANA: s.IANA, Loc: loc}
	}
	r.zipCodesCache.Store(&zm)

	// NPA-only collapse from phone_codes
	npm := make(npaMap)
	for _, s := range fix.SeedPhone {
		if _, ok := npm[s.NPA]; !ok {
			loc, _ := loadLocation(s.IANA)
			npm[s.NPA] = cacheEntry{IANA: s.IANA, Loc: loc}
		}
	}
	r.npaOnlyCache.Store(&npm)

	// Campaign default
	if fix.CampaignDefault != nil {
		r.campaignLRU.set(fix.CampaignDefault.CampID, fix.CampaignDefault.IANA)
	}

	return r
}

func npaParse(s string) uint64 {
	var v uint64
	for _, c := range s {
		v = v*10 + uint64(c-'0')
	}
	return v
}

func nxxParse(s string) uint64 {
	return npaParse(s)
}

// TestFixtures runs all fixture assertions including the 18 split-state cases.
func TestFixtures(t *testing.T) {
	data, err := os.ReadFile("fixtures_test.json")
	if err != nil {
		t.Fatalf("read fixtures: %v", err)
	}
	var fixtures []testFixture
	if err := json.Unmarshal(data, &fixtures); err != nil {
		t.Fatalf("parse fixtures: %v", err)
	}

	for _, fix := range fixtures {
		fix := fix
		t.Run(fix.Name, func(t *testing.T) {
			r := buildTestResolver(t, fix)
			req := ResolveRequest{
				PhoneE164:     fix.Req.PhoneE164,
				KnownTimezone: fix.Req.KnownTimezone,
				Zip:           fix.Req.Zip,
				State:         fix.Req.State,
				CampaignID:    fix.Req.CampaignID,
			}
			res, err := r.Resolve(context.Background(), req)
			if err != nil {
				t.Fatalf("Resolve: %v", err)
			}
			if res.IANA != fix.WantIANA {
				t.Errorf("IANA: got %q, want %q", res.IANA, fix.WantIANA)
			}
			if string(res.Confidence) != fix.WantConf {
				t.Errorf("Confidence: got %q, want %q", res.Confidence, fix.WantConf)
			}
		})
	}
}

// TestAlgorithmicInvariants tests the 6 frozen invariants from PLAN §2.4.
func TestAlgorithmicInvariants(t *testing.T) {
	ctx := context.Background()

	t.Run("tier1_always_wins", func(t *testing.T) {
		r := buildTestResolver(t, testFixture{
			SeedPhone: []struct {
				NPA  string `json:"npa"`
				NXX  string `json:"nxx"`
				IANA string `json:"iana"`
			}{{"212", "555", "America/New_York"}},
		})
		res, _ := r.Resolve(ctx, ResolveRequest{
			PhoneE164:     "+12125550099",
			KnownTimezone: "America/Phoenix",
			State:         "NY",
		})
		if res.Confidence != ConfKnown || res.IANA != "America/Phoenix" {
			t.Errorf("Tier 1 did not win: got conf=%s iana=%s", res.Confidence, res.IANA)
		}
	})

	t.Run("tier2_wins_over_tier3", func(t *testing.T) {
		r := buildTestResolver(t, testFixture{
			SeedPhone: []struct {
				NPA  string `json:"npa"`
				NXX  string `json:"nxx"`
				IANA string `json:"iana"`
			}{{"212", "555", "America/New_York"}},
			SeedZip: []struct {
				Zip  string `json:"zip"`
				IANA string `json:"iana"`
			}{{"90210", "America/Los_Angeles"}},
		})
		res, _ := r.Resolve(ctx, ResolveRequest{
			PhoneE164: "+12125550099",
			Zip:       "90210",
		})
		if res.Confidence != ConfZIP || res.IANA != "America/Los_Angeles" {
			t.Errorf("Tier 2 did not beat Tier 3: conf=%s iana=%s", res.Confidence, res.IANA)
		}
	})

	t.Run("override_beats_phone_codes", func(t *testing.T) {
		r := buildTestResolver(t, testFixture{
			SeedPhone: []struct {
				NPA  string `json:"npa"`
				NXX  string `json:"nxx"`
				IANA string `json:"iana"`
			}{{"317", "555", "America/Indiana/Indianapolis"}},
			SeedOverride: []struct {
				NPA  string `json:"npa"`
				NXX  string `json:"nxx"`
				IANA string `json:"iana"`
			}{{"317", "555", "America/Chicago"}},
		})
		res, _ := r.Resolve(ctx, ResolveRequest{PhoneE164: "+13175551212"})
		if res.IANA != "America/Chicago" {
			t.Errorf("Override did not beat phone_codes: got %s", res.IANA)
		}
	})

	t.Run("tier5_skipped_for_8_split_states", func(t *testing.T) {
		r := buildTestResolver(t, testFixture{})
		for _, state := range []string{"IN", "KY", "TN", "FL", "ID", "OR", "ND", "SD", "NE"} {
			res, _ := r.Resolve(ctx, ResolveRequest{
				PhoneE164: "+15555550000",
				State:     state,
			})
			if res.Confidence == ConfStateDefault {
				t.Errorf("Split state %s got STATE_DEFAULT — must not happen", state)
			}
		}
	})

	t.Run("bad_known_tz_falls_through", func(t *testing.T) {
		r := buildTestResolver(t, testFixture{
			SeedZip: []struct {
				Zip  string `json:"zip"`
				IANA string `json:"iana"`
			}{{"10001", "America/New_York"}},
		})
		res, _ := r.Resolve(ctx, ResolveRequest{
			PhoneE164:     "+12125550099",
			KnownTimezone: "Mars/Olympus_Mons",
			Zip:           "10001",
		})
		if res.Confidence == ConfKnown {
			t.Error("Bad IANA string should not result in KNOWN confidence")
		}
		if res.IANA != "America/New_York" {
			t.Errorf("Expected fallthrough to ZIP=America/New_York, got %s", res.IANA)
		}
	})

	t.Run("tier5_works_for_single_tz_state", func(t *testing.T) {
		r := buildTestResolver(t, testFixture{})
		// Use a phone number that won't be in phone_codes or parseable by libphonenumber
		// We pass no phone at all and just rely on State
		res, _ := r.Resolve(ctx, ResolveRequest{
			State: "CA",
		})
		if res.Confidence != ConfStateDefault || res.IANA != "America/Los_Angeles" {
			t.Errorf("CA single-tz: conf=%s iana=%s", res.Confidence, res.IANA)
		}
	})

	t.Run("tier6_campaign_default", func(t *testing.T) {
		r := buildTestResolver(t, testFixture{})
		r.campaignLRU.set("camp1", "America/Denver")
		// No phone, no state, just campaign
		res, _ := r.Resolve(ctx, ResolveRequest{
			CampaignID: "camp1",
		})
		if res.Confidence != ConfCampaignDefault || res.IANA != "America/Denver" {
			t.Errorf("Campaign default: conf=%s iana=%s", res.Confidence, res.IANA)
		}
	})
}

// TestSingleTzStateMap verifies the state map includes expected single-tz states
// and excludes all 8 split states.
func TestSingleTzStateMap(t *testing.T) {
	expected := []string{"CA", "NY", "TX", "WA", "HI", "AK", "AZ", "PR"}
	for _, s := range expected {
		if _, ok := singleTzStateMap[s]; !ok {
			t.Errorf("singleTzStateMap missing expected state %s", s)
		}
	}
	for s := range splitStates {
		if _, ok := singleTzStateMap[s]; ok {
			t.Errorf("singleTzStateMap should NOT contain split state %s", s)
		}
	}
}

// TestResolveBatch verifies batch resolution works for N requests.
func TestResolveBatch(t *testing.T) {
	r := buildTestResolver(t, testFixture{
		SeedPhone: []struct {
			NPA  string `json:"npa"`
			NXX  string `json:"nxx"`
			IANA string `json:"iana"`
		}{
			{"317", "555", "America/Indiana/Indianapolis"},
			{"212", "555", "America/New_York"},
		},
	})

	reqs := []ResolveRequest{
		{PhoneE164: "+13175551212"},
		{PhoneE164: "+12125550099"},
		{State: "CA"}, // no phone — exercises Tier 5 state default
	}

	results, err := r.ResolveBatch(context.Background(), reqs)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != len(reqs) {
		t.Fatalf("got %d results, want %d", len(results), len(reqs))
	}
	if results[0].IANA != "America/Indiana/Indianapolis" {
		t.Errorf("batch[0]: got %s", results[0].IANA)
	}
	if results[1].IANA != "America/New_York" {
		t.Errorf("batch[1]: got %s", results[1].IANA)
	}
	if results[2].IANA != "America/Los_Angeles" || results[2].Confidence != ConfStateDefault {
		t.Errorf("batch[2]: got iana=%s conf=%s", results[2].IANA, results[2].Confidence)
	}
}
