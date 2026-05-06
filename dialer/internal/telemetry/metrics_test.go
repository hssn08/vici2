package telemetry

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRegistryExposesVici2Metrics(t *testing.T) {
	r := NewRegistry("dialer")

	srv := httptest.NewServer(r.Handler())
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/metrics")
	if err != nil {
		t.Fatalf("GET /metrics: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}

	got := string(body)
	for _, want := range []string{
		"vici2_dialer_uptime_seconds",
		"vici2_dialer_heartbeats_total",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("expected %q in /metrics output, not found", want)
		}
	}
}
