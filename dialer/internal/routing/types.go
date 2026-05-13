package routing

import "time"

// Carrier mirrors the relevant fields from the carriers DB table.
// The API layer reads the full row and maps it here for routing logic.
// T02 PLAN §1.2, F02 AMENDMENTS §2.
type Carrier struct {
	ID            int64
	TenantID      int64
	Name          string
	Kind          Kind
	Register      bool
	Transport     string // "tls", "udp", "tcp"
	Proxy         string // e.g. "sip.telnyx.com"
	IPAllowlist   []string
	MaxConcurrent *int  // nil = unlimited
	SendPAI       bool
	IsEmergency   bool
	Active        bool
	Version       int
}

// Gateway mirrors the relevant fields from the gateways DB table.
// One Carrier has N Gateways. T02 PLAN §9.1.
type Gateway struct {
	ID            int64
	TenantID      int64
	CarrierID     int64
	Name          string // sofia gateway name, e.g. "twilio-us-east"
	Priority      int    // lower = higher priority
	Weight        int16  // relative weight within same priority tier
	MaxConcurrent *int   // nil = unlimited; per-gateway cap
	Active        bool
	Version       int

	// Carrier fields copied for routing decisions (avoids N+1 join).
	CarrierKind      Kind
	CarrierRegister  bool
	CarrierTransport string
	TechPrefix       string // Telnyx-IP / Flowroute 8-digit prefix from template_overrides
}

// HealthState represents the FreeSWITCH gateway state.
// Parsed from "sofia status gateway <name>" by the health poller.
// T02 PLAN §11.2.
type HealthState string

const (
	HealthStateREGED    HealthState = "REGED"
	HealthStateNOREG    HealthState = "NOREG"
	HealthStateUNREG    HealthState = "UNREG"
	HealthStateFAILED   HealthState = "FAILED"
	HealthStateFAILWAIT HealthState = "FAIL_WAIT"
	HealthStateEXPIRED  HealthState = "EXPIRED"
	HealthStateNOAVAIL  HealthState = "NOAVAIL"
	HealthStateUNKNOWN  HealthState = "UNKNOWN"
)

// GatewayHealth is the health cache entry written by the health poller.
// Stored in Valkey at t:{tid}:carrier:status:{gateway_id} (TTL 90s).
// T02 PLAN §0 bullet 10, §11.2.
type GatewayHealth struct {
	GatewayID  int64
	State      HealthState
	Status     string    // raw "Status:" line, e.g. "UP (ping)"
	PingMS     float64   // OPTIONS RTT milliseconds
	IBActive   int       // inbound active calls
	OBActive   int       // outbound active calls
	Healthy    bool      // derived: REGED or (NOREG + "UP (ping)")
	PolledAt   time.Time
}

// SelectRequest is the input to SelectGateway.
// T02 PLAN §14.1 hand-off to T04.
type SelectRequest struct {
	TenantID   int64
	CarrierID  int64
	Gateways   []Gateway // ordered by (priority ASC, weight DESC) — caller provides
	ActiveCounts map[int64]int64 // gatewayID → current active count from Valkey
	HealthCache  map[int64]GatewayHealth // gatewayID → health (may be stale/missing)
}

// SelectResult is returned by SelectGateway.
type SelectResult struct {
	Gateway    Gateway
	ActiveCount int64  // count at selection time
}

// CIDRequest is the input to CallerIDForCall.
// T02 PLAN §8 caller-ID three-knob policy.
type CIDRequest struct {
	// Per-call override (highest priority).
	PerCallOverride string

	// Per-list override (F02 AMENDMENTS lists.caller_id_override).
	PerListOverride string

	// Campaign default.
	CampaignDefault string

	// Carrier kind — used to determine PAI mode (T04 sets channel vars).
	CarrierKind Kind
}

// DialStringEntry is a single gateway+destination pair in the failover list.
type DialStringEntry struct {
	GatewayName string
	DestE164    string // full E.164, with tech-prefix prepended for telnyx-ip/flowroute
}
