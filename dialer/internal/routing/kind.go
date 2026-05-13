package routing

import "fmt"

// Kind is the carrier connector type. T02 PLAN §1.1 — FROZEN enum.
// F02 AMENDMENTS §3 widened carriers.kind from 5 → 9 values
// (legacy "telnyx" retained for back-compat; runtime retags to telnyx-creds/ip).
type Kind string

const (
	// KindTwilio is Twilio elastic SIP trunking.
	// register=false; IP+digest FQDN; TLS-5061.
	KindTwilio Kind = "twilio"

	// KindTelnyxCreds is Telnyx credential-auth (register=true, digest).
	KindTelnyxCreds Kind = "telnyx-creds"

	// KindTelnyxIP is Telnyx IP-auth (register=false, tech-prefix prepend).
	KindTelnyxIP Kind = "telnyx-ip"

	// KindSignalWire is SignalWire project space (register=true, TLS).
	KindSignalWire Kind = "signalwire"

	// KindRingCentral is RingCentral SBC (register=true, per-DID extension).
	KindRingCentral Kind = "ringcentral"

	// KindBandwidth is Bandwidth Communications (register=false, UDP-only, dual-SBC IP list).
	KindBandwidth Kind = "bandwidth"

	// KindFlowroute is Flowroute (register=false, IP-auth + 8-digit tech-prefix).
	KindFlowroute Kind = "flowroute"

	// KindBYOC is a bring-your-own-carrier generic gateway (fully configurable).
	KindBYOC Kind = "byoc"

	// KindTelnyxLegacy is the pre-T02 "telnyx" value retained for back-compat.
	// T02 IMPLEMENT retags rows: register=true → telnyx-creds; register=false → telnyx-ip.
	KindTelnyxLegacy Kind = "telnyx"
)

// allKinds is the complete set of valid Kind values (including legacy).
var allKinds = map[Kind]bool{
	KindTwilio:       true,
	KindTelnyxCreds:  true,
	KindTelnyxIP:     true,
	KindSignalWire:   true,
	KindRingCentral:  true,
	KindBandwidth:    true,
	KindFlowroute:    true,
	KindBYOC:         true,
	KindTelnyxLegacy: true,
}

// Validate returns an error if k is not a recognized Kind.
func (k Kind) Validate() error {
	if allKinds[k] {
		return nil
	}
	return fmt.Errorf("routing: unknown carrier kind %q", k)
}

// NormalizeKind converts the legacy "telnyx" value to the correct split value
// based on whether the gateway uses registration.
// Called during carrier row reads and create/update handlers.
func NormalizeKind(k Kind, register bool) Kind {
	if k != KindTelnyxLegacy {
		return k
	}
	if register {
		return KindTelnyxCreds
	}
	return KindTelnyxIP
}

// RequiresRegistration returns true for kinds that must register with the carrier.
// T02 PLAN §1.2 auth-mode matrix.
func (k Kind) RequiresRegistration() bool {
	switch k {
	case KindTelnyxCreds, KindSignalWire, KindRingCentral:
		return true
	default:
		return false
	}
}

// RequiresIPAllowlist returns true for kinds that rely on IP allowlist auth.
// T02 PLAN §1.2 validation rules.
func (k Kind) RequiresIPAllowlist() bool {
	switch k {
	case KindTwilio, KindBandwidth, KindFlowroute, KindTelnyxIP:
		return true
	default:
		return false
	}
}

// RequiresUDPOnly returns true for kinds where transport MUST be UDP.
// T02 PLAN §1.2 — Bandwidth.
func (k Kind) RequiresUDPOnly() bool {
	return k == KindBandwidth
}

// HasTechPrefix returns true for kinds where T04 must prepend a tech-prefix to the dialed number.
// T02 PLAN §14.1.
func (k Kind) HasTechPrefix() bool {
	return k == KindTelnyxIP || k == KindFlowroute
}

// DefaultTransport returns the default SIP transport for this carrier kind.
// Matches T02 PLAN §1.2 table.
func (k Kind) DefaultTransport() string {
	switch k {
	case KindTwilio, KindTelnyxCreds, KindSignalWire, KindRingCentral:
		return "tls"
	case KindBandwidth:
		return "udp"
	default:
		return "udp"
	}
}

// DefaultExpireSeconds returns the registration expire interval, or 0 if non-registering.
func (k Kind) DefaultExpireSeconds() int {
	switch k {
	case KindTelnyxCreds, KindSignalWire:
		return 3600
	case KindRingCentral:
		return 600
	default:
		return 0
	}
}

// DefaultPingSeconds returns the OPTIONS keepalive interval (T02 PLAN §11.4).
func (k Kind) DefaultPingSeconds() int { return 25 }

// DefaultPingMax returns the consecutive OPTIONS failures before mark-down.
func (k Kind) DefaultPingMax() int { return 3 }

// SendPAI returns whether PAI should be sent for this carrier by default.
// T02 PLAN §8.2: all except Bandwidth use sip_cid_type=pid; Bandwidth uses manual injection.
func (k Kind) SendPAI() bool {
	return k != KindBandwidth
}
