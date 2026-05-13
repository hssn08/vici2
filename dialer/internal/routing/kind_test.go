package routing

import "testing"

func TestKindValidate(t *testing.T) {
	valid := []Kind{
		KindTwilio, KindTelnyxCreds, KindTelnyxIP, KindSignalWire,
		KindRingCentral, KindBandwidth, KindFlowroute, KindBYOC, KindTelnyxLegacy,
	}
	for _, k := range valid {
		if err := k.Validate(); err != nil {
			t.Errorf("expected %q to be valid, got: %v", k, err)
		}
	}
	if err := Kind("unknown").Validate(); err == nil {
		t.Error("expected error for unknown kind")
	}
}

func TestNormalizeKind(t *testing.T) {
	tests := []struct {
		in       Kind
		register bool
		want     Kind
	}{
		{KindTelnyxLegacy, true, KindTelnyxCreds},
		{KindTelnyxLegacy, false, KindTelnyxIP},
		{KindTwilio, false, KindTwilio},          // non-legacy unchanged
		{KindTelnyxCreds, true, KindTelnyxCreds}, // non-legacy unchanged
	}
	for _, tt := range tests {
		got := NormalizeKind(tt.in, tt.register)
		if got != tt.want {
			t.Errorf("NormalizeKind(%q, %v) = %q, want %q", tt.in, tt.register, got, tt.want)
		}
	}
}

func TestKindRequiresRegistration(t *testing.T) {
	mustRegister := []Kind{KindTelnyxCreds, KindSignalWire, KindRingCentral}
	noRegister := []Kind{KindTwilio, KindTelnyxIP, KindBandwidth, KindFlowroute, KindBYOC}
	for _, k := range mustRegister {
		if !k.RequiresRegistration() {
			t.Errorf("%q should require registration", k)
		}
	}
	for _, k := range noRegister {
		if k.RequiresRegistration() {
			t.Errorf("%q should not require registration", k)
		}
	}
}

func TestKindRequiresIPAllowlist(t *testing.T) {
	must := []Kind{KindTwilio, KindBandwidth, KindFlowroute, KindTelnyxIP}
	no := []Kind{KindTelnyxCreds, KindSignalWire, KindRingCentral, KindBYOC}
	for _, k := range must {
		if !k.RequiresIPAllowlist() {
			t.Errorf("%q should require IP allowlist", k)
		}
	}
	for _, k := range no {
		if k.RequiresIPAllowlist() {
			t.Errorf("%q should not require IP allowlist", k)
		}
	}
}

func TestKindRequiresUDPOnly(t *testing.T) {
	if !KindBandwidth.RequiresUDPOnly() {
		t.Error("bandwidth should require UDP only")
	}
	for _, k := range []Kind{KindTwilio, KindTelnyxCreds, KindSignalWire} {
		if k.RequiresUDPOnly() {
			t.Errorf("%q should not require UDP only", k)
		}
	}
}

func TestKindHasTechPrefix(t *testing.T) {
	if !KindTelnyxIP.HasTechPrefix() {
		t.Error("telnyx-ip should have tech prefix")
	}
	if !KindFlowroute.HasTechPrefix() {
		t.Error("flowroute should have tech prefix")
	}
	if KindTwilio.HasTechPrefix() {
		t.Error("twilio should not have tech prefix")
	}
}

func TestKindDefaultTransport(t *testing.T) {
	tests := []struct {
		kind Kind
		want string
	}{
		{KindTwilio, "tls"},
		{KindTelnyxCreds, "tls"},
		{KindSignalWire, "tls"},
		{KindRingCentral, "tls"},
		{KindBandwidth, "udp"},
		{KindFlowroute, "udp"},
		{KindBYOC, "udp"},
	}
	for _, tt := range tests {
		got := tt.kind.DefaultTransport()
		if got != tt.want {
			t.Errorf("%q.DefaultTransport() = %q, want %q", tt.kind, got, tt.want)
		}
	}
}

func TestKindDefaultExpireSeconds(t *testing.T) {
	tests := []struct {
		kind Kind
		want int
	}{
		{KindTelnyxCreds, 3600},
		{KindSignalWire, 3600},
		{KindRingCentral, 600},
		{KindTwilio, 0},
		{KindBandwidth, 0},
		{KindFlowroute, 0},
	}
	for _, tt := range tests {
		got := tt.kind.DefaultExpireSeconds()
		if got != tt.want {
			t.Errorf("%q.DefaultExpireSeconds() = %d, want %d", tt.kind, got, tt.want)
		}
	}
}

func TestKindSendPAI(t *testing.T) {
	// All except Bandwidth should send PAI.
	noPAI := []Kind{KindBandwidth}
	hasPAI := []Kind{KindTwilio, KindTelnyxCreds, KindTelnyxIP, KindSignalWire, KindRingCentral, KindFlowroute, KindBYOC}
	for _, k := range noPAI {
		if k.SendPAI() {
			t.Errorf("%q should NOT send PAI", k)
		}
	}
	for _, k := range hasPAI {
		if !k.SendPAI() {
			t.Errorf("%q should send PAI", k)
		}
	}
}

func TestKindPingDefaults(t *testing.T) {
	if KindTwilio.DefaultPingSeconds() != 25 {
		t.Errorf("ping seconds should be 25, got %d", KindTwilio.DefaultPingSeconds())
	}
	if KindTelnyxCreds.DefaultPingMax() != 3 {
		t.Errorf("ping max should be 3, got %d", KindTelnyxCreds.DefaultPingMax())
	}
}
