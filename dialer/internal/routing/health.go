package routing

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	// HealthCacheTTL is the Valkey TTL for gateway health cache entries.
	// T02 PLAN §0 bullet 10.
	HealthCacheTTL = 90 * time.Second

	// healthKeyFmt is the Valkey key format for gateway health cache.
	// t:{tid}:carrier:status:{gateway_id}
	healthKeyFmt = "t:%d:carrier:status:%d"
)

// HealthCache reads and writes gateway health from Valkey.
// Written by the health poller; read by SelectGateway.
// T02 PLAN §11.
type HealthCache struct {
	rdb redis.Cmdable
}

// NewHealthCache constructs a HealthCache. rdb may be nil for tests.
func NewHealthCache(rdb redis.Cmdable) *HealthCache {
	return &HealthCache{rdb: rdb}
}

func healthKey(tenantID, gatewayID int64) string {
	return fmt.Sprintf(healthKeyFmt, tenantID, gatewayID)
}

// Get returns the cached health for a gateway. Returns zero value and no error
// if the key is absent (caller treats missing as unknown/healthy).
func (h *HealthCache) Get(ctx context.Context, tenantID, gatewayID int64) (GatewayHealth, bool, error) {
	if h.rdb == nil {
		return GatewayHealth{}, false, nil
	}
	key := healthKey(tenantID, gatewayID)
	raw, err := h.rdb.Get(ctx, key).Bytes()
	if err == redis.Nil {
		return GatewayHealth{}, false, nil
	}
	if err != nil {
		return GatewayHealth{}, false, fmt.Errorf("routing health Get: %w", err)
	}
	var gh GatewayHealth
	if err := json.Unmarshal(raw, &gh); err != nil {
		return GatewayHealth{}, false, fmt.Errorf("routing health Get: unmarshal: %w", err)
	}
	return gh, true, nil
}

// Set writes a health entry to Valkey with a 90-second TTL.
func (h *HealthCache) Set(ctx context.Context, tenantID int64, gh GatewayHealth) error {
	if h.rdb == nil {
		return nil
	}
	raw, err := json.Marshal(gh)
	if err != nil {
		return fmt.Errorf("routing health Set: marshal: %w", err)
	}
	key := healthKey(tenantID, gh.GatewayID)
	return h.rdb.Set(ctx, key, raw, HealthCacheTTL).Err()
}

// MGet fetches health for all given gateway IDs in a single MGET.
// Returns a map of gatewayID → GatewayHealth. Missing/expired keys are absent.
func (h *HealthCache) MGet(ctx context.Context, tenantID int64, gatewayIDs []int64) (map[int64]GatewayHealth, error) {
	result := make(map[int64]GatewayHealth, len(gatewayIDs))
	if h.rdb == nil || len(gatewayIDs) == 0 {
		return result, nil
	}
	keys := make([]string, len(gatewayIDs))
	for i, gid := range gatewayIDs {
		keys[i] = healthKey(tenantID, gid)
	}
	vals, err := h.rdb.MGet(ctx, keys...).Result()
	if err != nil {
		return nil, fmt.Errorf("routing health MGet: %w", err)
	}
	for i, v := range vals {
		if v == nil {
			continue
		}
		raw, ok := v.(string)
		if !ok {
			continue
		}
		var gh GatewayHealth
		if err := json.Unmarshal([]byte(raw), &gh); err == nil {
			result[gatewayIDs[i]] = gh
		}
	}
	return result, nil
}

// ParseGatewayStatusLine parses one whitespace-separated row from "sofia status gateway <name>".
// Expected format (from FreeSWITCH source):
//
//	external::<name>  <uri>  <state>  <ping_ms>  <ib_calls_f/t>  <ob_calls_f/t>
//
// T02 PLAN §11.2 parser.
func ParseGatewayStatusLine(_, line string) (GatewayHealth, error) {
	fields := strings.Fields(line)
	// Minimum viable parse: at least 3 fields (name, uri, state).
	if len(fields) < 3 {
		return GatewayHealth{}, fmt.Errorf("routing: cannot parse gateway status line: %q", line)
	}

	state := fields[2]
	var pingMS float64
	var ibF, ibT, obF, obT int

	if len(fields) >= 4 {
		_, _ = fmt.Sscanf(fields[3], "%f", &pingMS)
	}
	if len(fields) >= 5 {
		_, _ = fmt.Sscanf(fields[4], "%d/%d", &ibF, &ibT)
	}
	if len(fields) >= 6 {
		_, _ = fmt.Sscanf(fields[5], "%d/%d", &obF, &obT)
	}

	hs := HealthState(state)
	// status defaults to the state string; for verbose "sofia status gateway <n>"
	// output that contains "Status: UP (ping)", the health-poller's dedicated
	// verbose parse path extracts it. Here we infer from state only.
	status := state
	healthy := isHealthy(hs, status)

	return GatewayHealth{
		State:    hs,
		Status:   status,
		PingMS:   pingMS,
		IBActive: ibT - ibF,
		OBActive: obT - obF,
		Healthy:  healthy,
		PolledAt: time.Now(),
	}, nil
}

// isHealthy derives the healthy bool from state + status string.
// T02 PLAN §11.2 step 4.
func isHealthy(state HealthState, status string) bool {
	switch state {
	case HealthStateREGED:
		// register=true gateway is REGED → healthy.
		return true
	case HealthStateNOREG:
		// register=false gateway: healthy only if "UP (ping)".
		return status == "UP (ping)"
	default:
		return false
	}
}
