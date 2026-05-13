package routing

import (
	"fmt"
	"strings"
)

// BuildDialString constructs the FreeSWITCH originate destination string for a
// list of gateways using sequential pipe-list failover.
//
// Format: sofia/gateway/<gw1>/<dest>|sofia/gateway/<gw2>/<dest>
//
// The "|" separator causes FS to try gw1 first; on failure it tries gw2.
// Comma-list (simultaneous) is reserved for Phase 2.
//
// For Telnyx-IP and Flowroute gateways, dest has the tech-prefix prepended
// (stored in gateway.TechPrefix). T02 PLAN §14.1.
//
// Gateways must be pre-sorted by (priority ASC, weight DESC) and pre-filtered
// by health and active status — this function does no filtering.
func BuildDialString(gateways []Gateway, destE164 string) (string, error) {
	if len(gateways) == 0 {
		return "", ErrNoGateway
	}
	entries := make([]string, 0, len(gateways))
	for _, gw := range gateways {
		if gw.Name == "" {
			return "", fmt.Errorf("%w: gateway id %d", ErrEmptyGatewayName, gw.ID)
		}
		dest := effectiveDest(gw, destE164)
		entries = append(entries, fmt.Sprintf("sofia/gateway/%s/%s", gw.Name, dest))
	}
	return strings.Join(entries, "|"), nil
}

// BuildDialStringEntries is the structured variant of BuildDialString for callers
// that need to inspect individual entries (e.g., T04 audit column population).
func BuildDialStringEntries(gateways []Gateway, destE164 string) ([]DialStringEntry, error) {
	if len(gateways) == 0 {
		return nil, ErrNoGateway
	}
	entries := make([]DialStringEntry, len(gateways))
	for i, gw := range gateways {
		if gw.Name == "" {
			return nil, fmt.Errorf("%w: gateway id %d", ErrEmptyGatewayName, gw.ID)
		}
		entries[i] = DialStringEntry{
			GatewayName: gw.Name,
			DestE164:    effectiveDest(gw, destE164),
		}
	}
	return entries, nil
}

// effectiveDest returns the dialed number with tech-prefix prepended for
// carrier kinds that require it (Telnyx-IP, Flowroute). T02 PLAN §14.1.
func effectiveDest(gw Gateway, destE164 string) string {
	if gw.TechPrefix != "" && gw.CarrierKind.HasTechPrefix() {
		return gw.TechPrefix + destE164
	}
	return destE164
}

// ChannelVarsForCarrier returns the FreeSWITCH channel variable map
// that T04 must set at originate time for proper caller-ID / PAI handling.
// T02 PLAN §8.2.
func ChannelVarsForCarrier(kind Kind, cidE164, realm string) map[string]string {
	vars := map[string]string{
		"effective_caller_id_number": cidE164,
	}
	if kind == KindBandwidth {
		// Manual PAI injection — avoids dual-PAI bug (#29).
		// T02 PLAN §8.2.
		vars["sip_cid_type"] = "none"
		if realm != "" {
			vars["sip_h_P-Asserted-Identity"] = fmt.Sprintf("<sip:%s@%s>", cidE164, realm)
		}
	} else {
		vars["sip_cid_type"] = "pid"
	}
	return vars
}
