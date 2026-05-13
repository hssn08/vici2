package recording

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/redis/go-redis/v9"
)

// fakeESL is a test double for the UUIDRecorder interface.
type fakeESL struct {
	calls  []fakeCall
	errMap map[string]error // action → error to return
}

type fakeCall struct {
	fsHost   string
	callUUID string
	action   string
	path     string
}

func (f *fakeESL) UUIDRecord(_ context.Context, fsHost, callUUID, action, path string) error {
	f.calls = append(f.calls, fakeCall{fsHost, callUUID, action, path})
	if f.errMap != nil {
		if err, ok := f.errMap[action]; ok {
			return err
		}
	}
	return nil
}

func newTestRecorder(t *testing.T) (Recorder, *fakeESL, *miniredis.Miniredis) {
	t.Helper()
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis: %v", err)
	}
	t.Cleanup(mr.Close)

	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })

	// Use an isolated prometheus registry per test to avoid duplicate registration panics.
	reg := prometheus.NewRegistry()

	esl := &fakeESL{}
	rec := New(esl, rdb, 1, "/var/lib/freeswitch/recordings", reg)
	return rec, esl, mr
}

func baseRequest() StartRequest {
	return StartRequest{
		FSHost:        "fs1",
		CallUUID:      "test-uuid-0001",
		TenantID:      1,
		CampaignID:    "SOLAR_Q2",
		LeadID:        4287,
		RecordingMode: "ondemand",
		ConsentStatus: "not_required",
		StartedAt:     time.Date(2026, 5, 6, 12, 0, 0, 0, time.UTC),
	}
}

// TestStart_Success verifies StartRecording returns the correct path and
// calls UUIDRecord with action=start.
func TestStart_Success(t *testing.T) {
	t.Parallel()
	rec, esl, _ := newTestRecorder(t)
	ctx := context.Background()

	path, err := rec.StartRecording(ctx, baseRequest())
	if err != nil {
		t.Fatalf("StartRecording: unexpected error: %v", err)
	}
	want := "/var/lib/freeswitch/recordings/1/2026/05/06/SOLAR_Q2_4287_test-uuid-0001.wav"
	if path != want {
		t.Errorf("path: got %q, want %q", path, want)
	}
	if len(esl.calls) != 1 {
		t.Fatalf("expected 1 ESL call, got %d", len(esl.calls))
	}
	if esl.calls[0].action != "start" {
		t.Errorf("action: got %q, want %q", esl.calls[0].action, "start")
	}
}

// TestStart_RequiresConsent verifies that StartRecording returns ErrConsentMissing
// when consent_status is "prompted_declined" or empty.
func TestStart_RequiresConsent(t *testing.T) {
	t.Parallel()
	rec, _, _ := newTestRecorder(t)
	ctx := context.Background()

	for _, status := range []string{"prompted_declined", "", "unknown"} {
		req := baseRequest()
		req.ConsentStatus = status
		_, err := rec.StartRecording(ctx, req)
		if !errors.Is(err, ErrConsentMissing) {
			t.Errorf("consent_status=%q: expected ErrConsentMissing, got %v", status, err)
		}
	}
}

// TestStart_RequiresConsent_AllowedValues verifies that allowed consent values succeed.
func TestStart_RequiresConsent_AllowedValues(t *testing.T) {
	t.Parallel()
	rec, _, _ := newTestRecorder(t)
	ctx := context.Background()

	for _, status := range []string{"not_required", "prompted_accepted", "assumed", "beep_only", "prompted_assumed"} {
		req := baseRequest()
		req.CallUUID = "uuid-consent-" + status
		req.ConsentStatus = status
		_, err := rec.StartRecording(ctx, req)
		if err != nil {
			t.Errorf("consent_status=%q: unexpected error: %v", status, err)
		}
	}
}

// TestStart_ErrAlreadyActive verifies idempotency guard.
func TestStart_ErrAlreadyActive(t *testing.T) {
	t.Parallel()
	rec, _, _ := newTestRecorder(t)
	ctx := context.Background()

	req := baseRequest()
	if _, err := rec.StartRecording(ctx, req); err != nil {
		t.Fatalf("first StartRecording: %v", err)
	}

	_, err := rec.StartRecording(ctx, req)
	if !errors.Is(err, ErrAlreadyActive) {
		t.Errorf("second StartRecording: expected ErrAlreadyActive, got %v", err)
	}
}

// TestStatus_StartTracksInValkey verifies that StartRecording writes HASH state.
func TestStatus_StartTracksInValkey(t *testing.T) {
	t.Parallel()
	rec, _, _ := newTestRecorder(t)
	ctx := context.Background()

	req := baseRequest()
	path, _ := rec.StartRecording(ctx, req)

	rs, err := rec.RecordingStatus(ctx, req.CallUUID)
	if err != nil {
		t.Fatalf("RecordingStatus: %v", err)
	}
	if rs.State != StateRecording {
		t.Errorf("state: got %q, want %q", rs.State, StateRecording)
	}
	if rs.Path != path {
		t.Errorf("path: got %q, want %q", rs.Path, path)
	}
	if rs.PauseCount != 0 {
		t.Errorf("pause_count: got %d, want 0", rs.PauseCount)
	}
}

// TestStatus_PauseUpdatesState verifies PauseRecording transitions state to masked.
func TestStatus_PauseUpdatesState(t *testing.T) {
	t.Parallel()
	rec, esl, _ := newTestRecorder(t)
	ctx := context.Background()

	req := baseRequest()
	if _, err := rec.StartRecording(ctx, req); err != nil {
		t.Fatalf("StartRecording: %v", err)
	}

	if err := rec.PauseRecording(ctx, req.CallUUID, "agent"); err != nil {
		t.Fatalf("PauseRecording: %v", err)
	}

	rs, err := rec.RecordingStatus(ctx, req.CallUUID)
	if err != nil {
		t.Fatalf("RecordingStatus: %v", err)
	}
	if rs.State != StateMasked {
		t.Errorf("state: got %q, want %q", rs.State, StateMasked)
	}
	if rs.PauseCount != 1 {
		t.Errorf("pause_count: got %d, want 1", rs.PauseCount)
	}
	if rs.PausedAt == nil {
		t.Errorf("paused_at: expected non-nil after pause")
	}

	// Verify mask ESL call was made.
	maskFound := false
	for _, c := range esl.calls {
		if c.action == "mask" {
			maskFound = true
		}
	}
	if !maskFound {
		t.Error("expected uuid_record mask call to ESL")
	}
}

// TestStatus_ResumeUpdatesState verifies ResumeRecording transitions state back to recording.
func TestStatus_ResumeUpdatesState(t *testing.T) {
	t.Parallel()
	rec, _, _ := newTestRecorder(t)
	ctx := context.Background()

	req := baseRequest()
	if _, err := rec.StartRecording(ctx, req); err != nil {
		t.Fatalf("StartRecording: %v", err)
	}
	if err := rec.PauseRecording(ctx, req.CallUUID, "agent"); err != nil {
		t.Fatalf("PauseRecording: %v", err)
	}
	if err := rec.ResumeRecording(ctx, req.CallUUID, "agent"); err != nil {
		t.Fatalf("ResumeRecording: %v", err)
	}

	rs, _ := rec.RecordingStatus(ctx, req.CallUUID)
	if rs.State != StateRecording {
		t.Errorf("state after resume: got %q, want %q", rs.State, StateRecording)
	}
	// PausedAt should be cleared on resume.
	if rs.PausedAt != nil {
		t.Errorf("paused_at should be nil after resume, got %v", rs.PausedAt)
	}
	if rs.ResumedAt == nil {
		t.Errorf("resumed_at should be non-nil after resume")
	}
	// Pause count should still be 1 (cumulative, not decremented).
	if rs.PauseCount != 1 {
		t.Errorf("pause_count: got %d, want 1 (cumulative)", rs.PauseCount)
	}
}

// TestStatus_StopDeletes verifies that DeleteStatus removes the Valkey HASH.
func TestStatus_StopDeletes(t *testing.T) {
	t.Parallel()
	_, eslFake, mr := newTestRecorder(t)
	_ = eslFake

	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer rdb.Close()

	rec := New(&fakeESL{}, rdb, 1, "/rec", prometheus.NewRegistry())
	ctx := context.Background()

	req := baseRequest()
	if _, err := rec.StartRecording(ctx, req); err != nil {
		t.Fatalf("StartRecording: %v", err)
	}

	// Simulate T01 stream consumer deleting on RECORD_STOP.
	if err := DeleteStatus(ctx, rdb, 1, req.CallUUID); err != nil {
		t.Fatalf("DeleteStatus: %v", err)
	}

	_, err := rec.RecordingStatus(ctx, req.CallUUID)
	if !errors.Is(err, ErrCallNotActive) {
		t.Errorf("RecordingStatus after delete: expected ErrCallNotActive, got %v", err)
	}
}

// TestPause_CallNotActive verifies PauseRecording returns ErrCallNotActive for unknown UUIDs.
func TestPause_CallNotActive(t *testing.T) {
	t.Parallel()
	rec, _, _ := newTestRecorder(t)
	ctx := context.Background()

	err := rec.PauseRecording(ctx, "nonexistent-uuid", "agent")
	if !errors.Is(err, ErrCallNotActive) {
		t.Errorf("expected ErrCallNotActive, got %v", err)
	}
}

// TestResume_CallNotActive verifies ResumeRecording returns ErrCallNotActive for unknown UUIDs.
func TestResume_CallNotActive(t *testing.T) {
	t.Parallel()
	rec, _, _ := newTestRecorder(t)
	ctx := context.Background()

	err := rec.ResumeRecording(ctx, "nonexistent-uuid", "agent")
	if !errors.Is(err, ErrCallNotActive) {
		t.Errorf("expected ErrCallNotActive, got %v", err)
	}
}

// TestErrors_TypedErrors verifies all error sentinels are exported and matchable.
func TestErrors_TypedErrors(t *testing.T) {
	t.Parallel()
	// Wrap each sentinel and verify errors.Is still matches.
	for _, sentinel := range []error{
		ErrRecordingFailed,
		ErrDiskFull,
		ErrConsentMissing,
		ErrModeForbidden,
		ErrCallNotActive,
		ErrAlreadyActive,
	} {
		wrapped := errors.Join(sentinel, errors.New("extra context"))
		if !errors.Is(wrapped, sentinel) {
			t.Errorf("errors.Is failed for sentinel %v", sentinel)
		}
	}
}

// TestStop_Idempotent verifies StopRecording is a no-op for unknown UUIDs.
func TestStop_Idempotent(t *testing.T) {
	t.Parallel()
	rec, _, _ := newTestRecorder(t)
	ctx := context.Background()

	// Should not return an error even if no recording exists.
	if err := rec.StopRecording(ctx, "does-not-exist"); err != nil {
		t.Errorf("StopRecording: expected nil for unknown UUID, got %v", err)
	}
}

// TestStart_ESLFailure verifies ErrRecordingFailed is returned when ESL fails.
func TestStart_ESLFailure(t *testing.T) {
	t.Parallel()
	_, _, mr := newTestRecorder(t)

	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer rdb.Close()

	eslFake := &fakeESL{errMap: map[string]error{"start": errors.New("esl: connection refused")}}
	rec := New(eslFake, rdb, 1, "/rec", prometheus.NewRegistry())
	ctx := context.Background()

	_, err := rec.StartRecording(ctx, baseRequest())
	if !errors.Is(err, ErrRecordingFailed) {
		t.Errorf("expected ErrRecordingFailed, got %v", err)
	}
}
