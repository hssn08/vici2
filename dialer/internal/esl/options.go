package esl

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Options configures the ESL client. See T01 PLAN §3.4 for the full env table.
// All durations have millisecond granularity env vars per PLAN.
type Options struct {
	// FSHosts is the list of "host:port" strings. Populated from FS_HOSTS.
	FSHosts []string

	// Password is the ESL auth password. Populated from FS_EVENT_SOCKET_PASSWORD.
	Password string

	// DialTimeout is the TCP dial timeout per attempt.
	DialTimeout time.Duration

	// HeartbeatTimeout: force-close if no HEARTBEAT received for this duration.
	HeartbeatTimeout time.Duration

	// Reconnect backoff parameters.
	ReconnectInitial time.Duration
	ReconnectMax     time.Duration

	// DeadThreshold: consecutive reconnect failures before marking host DEAD.
	DeadThreshold int

	// CircuitFailThreshold: consecutive originate failures to trip OPEN.
	CircuitFailThreshold int

	// CircuitOpenDuration: how long the breaker stays OPEN before HALF_OPEN.
	CircuitOpenDuration time.Duration

	// BgJobTimeout: max time to wait for BACKGROUND_JOB after bgapi originate.
	BgJobTimeout time.Duration

	// InternalQueueDepth: capacity of the bounded event channel (per FS).
	InternalQueueDepth int

	// OriginateRatePerFS: max originates/sec per FS host (defense-in-depth).
	OriginateRatePerFS int

	// OriginateRatePerGateway: max originates/sec per gateway.
	OriginateRatePerGateway int

	// TenantID: used for Valkey rate-limit key construction.
	TenantID int64
}

// DefaultOptions returns Options populated from environment variables.
// Hard-coded defaults match PLAN §3.4.
func DefaultOptions() Options {
	return Options{
		FSHosts:                 splitHosts(envOr("FS_HOSTS", "host.docker.internal:8021")),
		Password:                envOr("FS_EVENT_SOCKET_PASSWORD", "ClueCon"),
		DialTimeout:             msEnv("FS_ESL_DIAL_TIMEOUT_MS", 5_000),
		HeartbeatTimeout:        msEnv("FS_ESL_HEARTBEAT_TIMEOUT_MS", 40_000),
		ReconnectInitial:        msEnv("FS_ESL_RECONNECT_INITIAL_MS", 300),
		ReconnectMax:            msEnv("FS_ESL_RECONNECT_MAX_MS", 30_000),
		DeadThreshold:           intEnv("FS_ESL_DEAD_THRESHOLD", 3),
		CircuitFailThreshold:    intEnv("FS_ESL_CIRCUIT_FAIL_THRESHOLD", 3),
		CircuitOpenDuration:     msEnv("FS_ESL_CIRCUIT_OPEN_DURATION_MS", 30_000),
		BgJobTimeout:            msEnv("FS_ESL_BG_JOB_TIMEOUT_MS", 60_000),
		InternalQueueDepth:      intEnv("FS_ESL_INTERNAL_QUEUE_DEPTH", 10_000),
		OriginateRatePerFS:      intEnv("VICI2_ORIGINATE_RATE_PER_FS", 50),
		OriginateRatePerGateway: intEnv("VICI2_ORIGINATE_RATE_PER_GATEWAY", 10),
		TenantID:                int64Env("VICI2_DEFAULT_TENANT_ID", 1),
	}
}

// Validate returns an error if any required field is missing or invalid.
func (o *Options) Validate() error {
	if len(o.FSHosts) == 0 {
		return fmt.Errorf("esl: FS_HOSTS is empty or unset")
	}
	if o.Password == "" {
		return fmt.Errorf("esl: FS_EVENT_SOCKET_PASSWORD is empty")
	}
	if o.TenantID <= 0 {
		return fmt.Errorf("esl: TenantID must be > 0")
	}
	return nil
}

// helpers

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func msEnv(key string, defaultMs int64) time.Duration {
	if v := os.Getenv(key); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err == nil && n > 0 {
			return time.Duration(n) * time.Millisecond
		}
	}
	return time.Duration(defaultMs) * time.Millisecond
}

func intEnv(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		n, err := strconv.Atoi(v)
		if err == nil && n > 0 {
			return n
		}
	}
	return def
}

func int64Env(key string, def int64) int64 {
	if v := os.Getenv(key); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err == nil && n > 0 {
			return n
		}
	}
	return def
}

func splitHosts(s string) []string {
	var out []string
	for _, part := range strings.Split(s, ",") {
		h := strings.TrimSpace(part)
		if h != "" {
			out = append(out, h)
		}
	}
	return out
}
