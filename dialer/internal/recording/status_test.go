package recording

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

func newTestStore(t *testing.T) (*statusStore, *miniredis.Miniredis) {
	t.Helper()
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis: %v", err)
	}
	t.Cleanup(mr.Close)

	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })

	return &statusStore{rdb: rdb, tenantID: 1}, mr
}

func TestRecordingKey(t *testing.T) {
	t.Parallel()
	key := recordingKey(1, "abc-uuid")
	if key != "t:1:recording:abc-uuid" {
		t.Errorf("recordingKey: got %q", key)
	}
}

func TestStatusStore_WriteRead(t *testing.T) {
	t.Parallel()
	store, _ := newTestStore(t)
	ctx := context.Background()

	startedAt := time.Date(2026, 5, 6, 12, 0, 0, 0, time.UTC)
	err := store.write(ctx, "uuid-1", "/rec/test.wav", StateRecording, startedAt, 0, 0, 0, "CAM", 42)
	if err != nil {
		t.Fatalf("write: %v", err)
	}

	rs, err := store.read(ctx, "uuid-1")
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if rs.Path != "/rec/test.wav" {
		t.Errorf("path: got %q", rs.Path)
	}
	if rs.State != StateRecording {
		t.Errorf("state: got %q", rs.State)
	}
	if rs.PauseCount != 0 {
		t.Errorf("pause_count: got %d", rs.PauseCount)
	}
	if !rs.StartedAt.Equal(startedAt) {
		t.Errorf("started_at: got %v, want %v", rs.StartedAt, startedAt)
	}
}

func TestStatusStore_ReadMissing(t *testing.T) {
	t.Parallel()
	store, _ := newTestStore(t)
	ctx := context.Background()

	rs, err := store.read(ctx, "does-not-exist")
	if !errors.Is(err, ErrCallNotActive) {
		t.Errorf("expected ErrCallNotActive, got %v", err)
	}
	if rs.State != StateNotActive {
		t.Errorf("state: expected not_active, got %q", rs.State)
	}
}

func TestStatusStore_SetState(t *testing.T) {
	t.Parallel()
	store, _ := newTestStore(t)
	ctx := context.Background()

	startedAt := time.Date(2026, 5, 6, 12, 0, 0, 0, time.UTC)
	_ = store.write(ctx, "uuid-2", "/rec/x.wav", StateRecording, startedAt, 0, 0, 0, "CAM", 1)
	_ = store.setState(ctx, "uuid-2", StateMasked)

	rs, _ := store.read(ctx, "uuid-2")
	if rs.State != StateMasked {
		t.Errorf("state after setState: got %q, want %q", rs.State, StateMasked)
	}
}

func TestStatusStore_Del(t *testing.T) {
	t.Parallel()
	store, _ := newTestStore(t)
	ctx := context.Background()

	startedAt := time.Now()
	_ = store.write(ctx, "uuid-3", "/rec/y.wav", StateRecording, startedAt, 0, 0, 0, "CAM", 1)
	_ = store.del(ctx, "uuid-3")

	_, err := store.read(ctx, "uuid-3")
	if !errors.Is(err, ErrCallNotActive) {
		t.Errorf("expected ErrCallNotActive after del, got %v", err)
	}
}

func TestStatusStore_PausedAt(t *testing.T) {
	t.Parallel()
	store, _ := newTestStore(t)
	ctx := context.Background()

	startedAt := time.Date(2026, 5, 6, 12, 0, 0, 0, time.UTC)
	pausedAt := time.Date(2026, 5, 6, 12, 5, 0, 0, time.UTC)
	_ = store.write(ctx, "uuid-4", "/rec/z.wav", StateMasked, startedAt, pausedAt.UnixNano(), 0, 3, "CAM", 1)

	rs, err := store.read(ctx, "uuid-4")
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if rs.PauseCount != 3 {
		t.Errorf("pause_count: got %d, want 3", rs.PauseCount)
	}
	if rs.PausedAt == nil {
		t.Fatal("paused_at: expected non-nil")
	}
	// Round-trip via nanoseconds — compare to same precision.
	if !rs.PausedAt.Equal(pausedAt) {
		t.Errorf("paused_at: got %v, want %v", rs.PausedAt, pausedAt)
	}
}
