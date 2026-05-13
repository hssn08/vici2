package routing

import (
	"context"
	"testing"
	"time"
)

func TestHealthCache_SetGet(t *testing.T) {
	rdb, _ := newMiniRedis(t)
	hc := NewHealthCache(rdb)
	ctx := context.Background()

	gh := GatewayHealth{
		GatewayID: 1,
		State:     HealthStateREGED,
		Status:    "REGED",
		PingMS:    25.0,
		IBActive:  0,
		OBActive:  3,
		Healthy:   true,
		PolledAt:  time.Now().Truncate(time.Second),
	}
	if err := hc.Set(ctx, 1, gh); err != nil {
		t.Fatalf("Set: %v", err)
	}
	got, found, err := hc.Get(ctx, 1, 1)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if !found {
		t.Fatal("Get: not found")
	}
	if got.GatewayID != 1 || !got.Healthy || got.State != HealthStateREGED {
		t.Errorf("unexpected health: %+v", got)
	}
}

func TestHealthCache_GetMissing(t *testing.T) {
	rdb, _ := newMiniRedis(t)
	hc := NewHealthCache(rdb)
	ctx := context.Background()

	_, found, err := hc.Get(ctx, 1, 999)
	if err != nil {
		t.Fatalf("Get missing: %v", err)
	}
	if found {
		t.Error("expected not found for missing key")
	}
}

func TestHealthCache_MGet(t *testing.T) {
	rdb, _ := newMiniRedis(t)
	hc := NewHealthCache(rdb)
	ctx := context.Background()

	for i := int64(1); i <= 3; i++ {
		gh := GatewayHealth{GatewayID: i, Healthy: i%2 == 1}
		_ = hc.Set(ctx, 1, gh)
	}
	m, err := hc.MGet(ctx, 1, []int64{1, 2, 3, 99})
	if err != nil {
		t.Fatalf("MGet: %v", err)
	}
	if len(m) != 3 {
		t.Errorf("expected 3 results, got %d", len(m))
	}
	if !m[1].Healthy {
		t.Error("gw1 should be healthy")
	}
	if m[2].Healthy {
		t.Error("gw2 should be unhealthy")
	}
	if _, ok := m[99]; ok {
		t.Error("gw99 should be absent")
	}
}

func TestHealthCache_NilRDB(t *testing.T) {
	hc := NewHealthCache(nil)
	ctx := context.Background()
	_, found, err := hc.Get(ctx, 1, 1)
	if err != nil || found {
		t.Errorf("nil rdb Get: found=%v err=%v", found, err)
	}
	if err := hc.Set(ctx, 1, GatewayHealth{}); err != nil {
		t.Errorf("nil rdb Set: %v", err)
	}
}

func TestIsHealthy(t *testing.T) {
	tests := []struct {
		state  HealthState
		status string
		want   bool
	}{
		{HealthStateREGED, "REGED", true},
		{HealthStateNOREG, "UP (ping)", true},
		{HealthStateNOREG, "DOWN", false},
		{HealthStateFAILED, "", false},
		{HealthStateFAILWAIT, "", false},
		{HealthStateUNREG, "", false},
	}
	for _, tt := range tests {
		got := isHealthy(tt.state, tt.status)
		if got != tt.want {
			t.Errorf("isHealthy(%q, %q) = %v, want %v", tt.state, tt.status, got, tt.want)
		}
	}
}

func TestParseGatewayStatusLine_REGED(t *testing.T) {
	// Simulate a REGED line from sofia status gateway.
	line := "external::twilio-east sip:twilio-east@192.0.2.1:5060 REGED 25.3 0/0 0/5"
	gh, err := ParseGatewayStatusLine("twilio-east", line)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if gh.State != HealthStateREGED {
		t.Errorf("state: %q", gh.State)
	}
}

func TestParseGatewayStatusLine_NOREG(t *testing.T) {
	line := "external::flowroute sip:flowroute@198.51.100.1:5060 NOREG 18.7 0/0 0/2"
	gh, err := ParseGatewayStatusLine("flowroute", line)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if gh.State != HealthStateNOREG {
		t.Errorf("state: %q", gh.State)
	}
}

func TestParseGatewayStatusLine_BadLine(t *testing.T) {
	_, err := ParseGatewayStatusLine("x", "tooshort")
	if err == nil {
		t.Error("expected error for unparseable line")
	}
	_, err2 := ParseGatewayStatusLine("x", "")
	if err2 == nil {
		t.Error("expected error for empty line")
	}
}
