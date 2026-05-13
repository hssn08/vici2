package dnc

import (
	"context"
	"database/sql"
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

// newTestChecker spins up miniredis and returns a Checker with a nil DB
// (Bloom-only tests; MySQL confirmation skipped when positiveSources is empty).
func newTestChecker(t *testing.T) (*Checker, *miniredis.Miniredis) {
	t.Helper()
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	return NewChecker(rdb, nil, nil), mr
}

// ─── malformed phone ──────────────────────────────────────────────────────────

func TestCheck_MalformedPhone(t *testing.T) {
	chk, _ := newTestChecker(t)
	res := chk.Check(context.Background(), CheckRequest{
		PhoneE164: "not-a-phone",
		TenantID:  1,
		Sources:   []Source{SourceFederal},
	})
	if !res.IsDNC {
		t.Fatal("expected IsDNC=true for malformed phone")
	}
	if res.Reason != "malformed" {
		t.Fatalf("expected reason=malformed, got %q", res.Reason)
	}
}

// ─── all-negative bloom → fast-path miss ─────────────────────────────────────

func TestCheck_BloomMiss(t *testing.T) {
	chk, _ := newTestChecker(t)
	// No entries in Bloom — miniredis doesn't have valkey-bloom module
	// but BF.EXISTS on a missing key returns error → fail-closed (positive)
	// To test the negative path properly we simulate: all bloom cmds return 0
	// by using a mock. Here we rely on the fact that miniredis returns
	// an error for unknown commands → fail-closed → covered by MysqlNil path.
	//
	// Unit test for negative fast-path: inject a redis client that returns 0.
	// We test this indirectly via the integration test.
	_ = chk
	t.Skip("negative bloom path covered in integration_test.go")
}

// ─── source sort ─────────────────────────────────────────────────────────────

func TestSortSources(t *testing.T) {
	in := []Source{SourceFederal, SourceInternal, SourceState}
	out := sortSources(in)
	if out[0] != SourceInternal {
		t.Fatalf("expected SourceInternal first, got %v", out[0])
	}
	if out[1] != SourceState {
		t.Fatalf("expected SourceState second, got %v", out[1])
	}
	if out[2] != SourceFederal {
		t.Fatalf("expected SourceFederal third, got %v", out[2])
	}
}

// ─── bloom key helpers ────────────────────────────────────────────────────────

func TestBloomKey(t *testing.T) {
	cases := []struct {
		src      Source
		tenantID int64
		want     string
	}{
		{SourceFederal, 0, "bf:dnc:federal"},
		{SourceLitigator, 0, "bf:dnc:litigator"},
		{SourceInternal, 42, "t:42:dnc:internal:bloom"},
		{SourceState, 7, "t:7:dnc:state:bloom"},
	}
	for _, c := range cases {
		got := bloomKey(c.src, c.tenantID)
		if got != c.want {
			t.Errorf("bloomKey(%v,%d) = %q, want %q", c.src, c.tenantID, got, c.want)
		}
	}
}

// ─── metrics wiring ───────────────────────────────────────────────────────────

func TestNewMetrics(t *testing.T) {
	// Just ensure no panic on NewMetrics with a fresh registry
	reg := newTestRegistry()
	m := NewMetrics(reg)
	if m == nil {
		t.Fatal("expected non-nil Metrics")
	}
}

// Stub to satisfy MySQL connection in unit tests
var _ *sql.DB
