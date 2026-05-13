package esl

import (
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

// newTestRegistry returns a fresh isolated registry for each test,
// avoiding "duplicate metric registration" panics from DefaultRegisterer.
func newTestRegistry() prometheus.Registerer {
	return prometheus.NewRegistry()
}

func baseOpts(hosts ...string) Options {
	if len(hosts) == 0 {
		hosts = []string{"127.0.0.1:8021"}
	}
	return Options{
		FSHosts:                 hosts,
		Password:                "ClueCon",
		DialTimeout:             5 * time.Second,
		HeartbeatTimeout:        40 * time.Second,
		ReconnectInitial:        300 * time.Millisecond,
		ReconnectMax:            30 * time.Second,
		DeadThreshold:           3,
		CircuitFailThreshold:    3,
		CircuitOpenDuration:     30 * time.Second,
		BgJobTimeout:            60 * time.Second,
		InternalQueueDepth:      100,
		OriginateRatePerFS:      50,
		OriginateRatePerGateway: 10,
		TenantID:                1,
	}
}

func TestNewClient_ValidOptions(t *testing.T) {
	c, err := New(baseOpts(), nil, newTestRegistry())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if c == nil {
		t.Fatal("expected non-nil client")
	}
	if _, ok := c.conns["127.0.0.1:8021"]; !ok {
		t.Error("expected conn entry for host")
	}
}

func TestNewClient_EmptyHosts(t *testing.T) {
	opts := Options{
		Password: "ClueCon",
		TenantID: 1,
	}
	_, err := New(opts, nil, newTestRegistry())
	if err == nil {
		t.Fatal("expected error on empty FSHosts")
	}
}

func TestNewClient_EmptyPassword(t *testing.T) {
	opts := Options{
		FSHosts:  []string{"127.0.0.1:8021"},
		TenantID: 1,
	}
	_, err := New(opts, nil, newTestRegistry())
	if err == nil {
		t.Fatal("expected error on empty Password")
	}
}

func TestClient_HealthyHosts_NoReady(t *testing.T) {
	opts := baseOpts()
	opts.InternalQueueDepth = 10
	c, err := New(opts, nil, newTestRegistry())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	// All conns start in CONNECTING state, not READY.
	hosts := c.HealthyHosts()
	if len(hosts) != 0 {
		t.Errorf("expected 0 healthy hosts while CONNECTING, got %v", hosts)
	}
}

func TestClient_HostStatus(t *testing.T) {
	opts := baseOpts("127.0.0.1:8021", "127.0.0.2:8021")
	c, err := New(opts, nil, newTestRegistry())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	status := c.HostStatus()
	if len(status) != 2 {
		t.Errorf("expected 2 host status entries, got %d", len(status))
	}
}

func TestClient_IsShuttingDown(t *testing.T) {
	c, err := New(baseOpts(), nil, newTestRegistry())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if c.isShuttingDown() {
		t.Fatal("expected not shutting down initially")
	}
	c.Close()
	if !c.isShuttingDown() {
		t.Fatal("expected shutting down after Close()")
	}
}
