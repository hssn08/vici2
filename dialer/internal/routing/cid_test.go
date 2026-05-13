package routing

import "testing"

func TestCallerIDForCall_PerCallOverride(t *testing.T) {
	req := CIDRequest{
		PerCallOverride: "+14155550001",
		PerListOverride: "+14155550002",
		CampaignDefault: "+14155550003",
		CarrierKind:     KindTwilio,
	}
	got := CallerIDForCall(req)
	if got != "+14155550001" {
		t.Errorf("per-call override not first: %q", got)
	}
}

func TestCallerIDForCall_PerListOverride(t *testing.T) {
	req := CIDRequest{
		PerListOverride: "+14155550002",
		CampaignDefault: "+14155550003",
		CarrierKind:     KindTwilio,
	}
	got := CallerIDForCall(req)
	if got != "+14155550002" {
		t.Errorf("per-list override not second: %q", got)
	}
}

func TestCallerIDForCall_CampaignDefault(t *testing.T) {
	req := CIDRequest{
		CampaignDefault: "+14155550003",
		CarrierKind:     KindTwilio,
	}
	got := CallerIDForCall(req)
	if got != "+14155550003" {
		t.Errorf("campaign default not fallback: %q", got)
	}
}

func TestCallerIDForCall_AllEmpty(t *testing.T) {
	req := CIDRequest{CarrierKind: KindTwilio}
	got := CallerIDForCall(req)
	if got != "" {
		t.Errorf("all empty: expected empty string, got %q", got)
	}
}
