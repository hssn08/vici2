package recording

import (
	"testing"
	"time"
)

func TestComputePath_StandardCase(t *testing.T) {
	t.Parallel()
	startedAt := time.Date(2026, 5, 6, 0, 0, 0, 0, time.UTC)
	got := ComputePath(
		"/var/lib/freeswitch/recordings",
		1,
		"SOLAR_Q2",
		4287,
		"8a3e1c4f-0b91-46e2-9b53-9d2e1b1f3a4e",
		startedAt,
	)
	want := "/var/lib/freeswitch/recordings/1/2026/05/06/SOLAR_Q2_4287_8a3e1c4f-0b91-46e2-9b53-9d2e1b1f3a4e.wav"
	if got != want {
		t.Errorf("ComputePath: got %q, want %q", got, want)
	}
}

func TestComputePath_DateBoundary(t *testing.T) {
	t.Parallel()
	// Just before midnight UTC
	late := time.Date(2026, 5, 6, 23, 59, 59, 0, time.UTC)
	// Just after midnight UTC
	early := time.Date(2026, 5, 7, 0, 0, 0, 0, time.UTC)

	gotLate := ComputePath("/rec", 1, "CAM", 1, "uuid-late", late)
	gotEarly := ComputePath("/rec", 1, "CAM", 1, "uuid-early", early)

	if wantDir := "/rec/1/2026/05/06/"; len(gotLate) < len(wantDir) || gotLate[:len(wantDir)] != wantDir {
		t.Errorf("late path should be in 2026/05/06, got: %s", gotLate)
	}
	if wantDir := "/rec/1/2026/05/07/"; len(gotEarly) < len(wantDir) || gotEarly[:len(wantDir)] != wantDir {
		t.Errorf("early path should be in 2026/05/07, got: %s", gotEarly)
	}
}

func TestComputePath_TenantIsolation(t *testing.T) {
	t.Parallel()
	startedAt := time.Date(2026, 5, 6, 12, 0, 0, 0, time.UTC)
	uuid := "same-uuid-1234"

	path1 := ComputePath("/rec", 1, "CAM", 1, uuid, startedAt)
	path2 := ComputePath("/rec", 2, "CAM", 1, uuid, startedAt)

	if path1 == path2 {
		t.Errorf("different tenant_ids must produce different paths; both got %q", path1)
	}
	if path1[:9] != "/rec/1/20" {
		t.Errorf("tenant 1 path should contain /rec/1/: %s", path1)
	}
	if path2[:9] != "/rec/2/20" {
		t.Errorf("tenant 2 path should contain /rec/2/: %s", path2)
	}
}

func TestComputePath_NoEpochInFilename(t *testing.T) {
	t.Parallel()
	// R01 PLAN §3.1: epoch MUST NOT appear in the filename.
	startedAt := time.Date(2026, 5, 6, 12, 0, 0, 0, time.UTC)
	epoch := "1746532800" // unix timestamp for 2026-05-06 12:00 UTC
	path := ComputePath("/rec", 1, "CAM", 1, "uuid-1234", startedAt)
	for i := 0; i+len(epoch) <= len(path); i++ {
		if path[i:i+len(epoch)] == epoch {
			t.Errorf("ComputePath must not include epoch %q in path %q", epoch, path)
		}
	}
}
