package routing

import (
	"strings"
	"testing"
)

func TestBuildDialString_Single(t *testing.T) {
	gws := []Gateway{
		{ID: 1, Name: "twilio-east", CarrierKind: KindTwilio},
	}
	s, err := BuildDialString(gws, "+14155551212")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := "sofia/gateway/twilio-east/+14155551212"
	if s != want {
		t.Errorf("got %q, want %q", s, want)
	}
}

func TestBuildDialString_Failover(t *testing.T) {
	gws := []Gateway{
		{ID: 1, Name: "twilio-east", CarrierKind: KindTwilio},
		{ID: 2, Name: "twilio-west", CarrierKind: KindTwilio},
	}
	s, err := BuildDialString(gws, "+14155551212")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	parts := strings.Split(s, "|")
	if len(parts) != 2 {
		t.Fatalf("expected 2 parts, got %d: %q", len(parts), s)
	}
	if !strings.HasPrefix(parts[0], "sofia/gateway/twilio-east/") {
		t.Errorf("first entry should be twilio-east, got %q", parts[0])
	}
	if !strings.HasPrefix(parts[1], "sofia/gateway/twilio-west/") {
		t.Errorf("second entry should be twilio-west, got %q", parts[1])
	}
}

func TestBuildDialString_TechPrefix(t *testing.T) {
	gws := []Gateway{
		{ID: 1, Name: "flowroute-main", CarrierKind: KindFlowroute, TechPrefix: "12345678"},
	}
	s, err := BuildDialString(gws, "+14155551212")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := "sofia/gateway/flowroute-main/12345678+14155551212"
	if s != want {
		t.Errorf("got %q, want %q", s, want)
	}
}

func TestBuildDialString_TelnyxIPTechPrefix(t *testing.T) {
	gws := []Gateway{
		{ID: 1, Name: "telnyx-ip-main", CarrierKind: KindTelnyxIP, TechPrefix: "00100200"},
	}
	s, err := BuildDialString(gws, "+12125550100")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(s, "00100200+12125550100") {
		t.Errorf("expected tech prefix prepended, got %q", s)
	}
}

func TestBuildDialString_EmptyList(t *testing.T) {
	_, err := BuildDialString(nil, "+14155551212")
	if err != ErrNoGateway {
		t.Errorf("expected ErrNoGateway, got %v", err)
	}
}

func TestBuildDialString_EmptyGatewayName(t *testing.T) {
	gws := []Gateway{{ID: 1, Name: "", CarrierKind: KindTwilio}}
	_, err := BuildDialString(gws, "+14155551212")
	if err == nil {
		t.Error("expected error for empty gateway name")
	}
}

func TestBuildDialStringEntries(t *testing.T) {
	gws := []Gateway{
		{ID: 1, Name: "telnyx-ip", CarrierKind: KindTelnyxIP, TechPrefix: "12340000"},
		{ID: 2, Name: "twilio-east", CarrierKind: KindTwilio},
	}
	entries, err := BuildDialStringEntries(gws, "+15005550006")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(entries) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(entries))
	}
	if entries[0].DestE164 != "12340000+15005550006" {
		t.Errorf("entry[0] dest: %q", entries[0].DestE164)
	}
	if entries[1].DestE164 != "+15005550006" {
		t.Errorf("entry[1] dest: %q", entries[1].DestE164)
	}
}

func TestChannelVarsForCarrier_PAI(t *testing.T) {
	// Non-Bandwidth: sip_cid_type=pid
	vars := ChannelVarsForCarrier(KindTwilio, "+14155551212", "pstn.twilio.com")
	if vars["sip_cid_type"] != "pid" {
		t.Errorf("twilio: sip_cid_type = %q, want pid", vars["sip_cid_type"])
	}
	if vars["effective_caller_id_number"] != "+14155551212" {
		t.Errorf("missing effective_caller_id_number")
	}
}

func TestChannelVarsForCarrier_Bandwidth(t *testing.T) {
	// Bandwidth: manual PAI injection, sip_cid_type=none
	vars := ChannelVarsForCarrier(KindBandwidth, "+14155551212", "acct.auth.bandwidth.com")
	if vars["sip_cid_type"] != "none" {
		t.Errorf("bandwidth: sip_cid_type = %q, want none", vars["sip_cid_type"])
	}
	if vars["sip_h_P-Asserted-Identity"] == "" {
		t.Error("bandwidth: missing sip_h_P-Asserted-Identity")
	}
	if !strings.Contains(vars["sip_h_P-Asserted-Identity"], "+14155551212") {
		t.Errorf("PAI header missing CID: %q", vars["sip_h_P-Asserted-Identity"])
	}
}

func TestChannelVarsForCarrier_BandwidthNoRealm(t *testing.T) {
	// Bandwidth with empty realm should not emit PAI header.
	vars := ChannelVarsForCarrier(KindBandwidth, "+14155551212", "")
	if _, ok := vars["sip_h_P-Asserted-Identity"]; ok {
		t.Error("bandwidth with no realm should not emit PAI header")
	}
}
