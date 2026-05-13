package esl

import (
	"testing"
	"time"
)

func TestJobDispatcher_DeliverAndAwait(t *testing.T) {
	d := newJobDispatcher()
	ch := d.register("job-1")

	go func() {
		time.Sleep(10 * time.Millisecond)
		d.deliver("job-1", jobResult{Body: "+OK uuid-123"})
	}()

	result, err := d.await("job-1", ch, time.Second)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Body != "+OK uuid-123" {
		t.Fatalf("unexpected body: %q", result.Body)
	}
}

func TestJobDispatcher_Timeout(t *testing.T) {
	d := newJobDispatcher()
	ch := d.register("job-timeout")

	_, err := d.await("job-timeout", ch, 20*time.Millisecond)
	if err == nil {
		t.Fatal("expected ErrJobOrphaned on timeout")
	}
	if err != ErrJobOrphaned {
		t.Fatalf("expected ErrJobOrphaned, got: %v", err)
	}
}

func TestJobDispatcher_DeliverUnknownJob(t *testing.T) {
	d := newJobDispatcher()
	// Deliver to unknown job should not panic.
	d.deliver("no-such-job", jobResult{Body: "+OK"})
}

func TestJobDispatcher_LenTracking(t *testing.T) {
	d := newJobDispatcher()
	if d.len() != 0 {
		t.Fatal("expected 0 pending jobs initially")
	}
	d.register("j1")
	d.register("j2")
	if d.len() != 2 {
		t.Fatalf("expected 2 pending jobs, got %d", d.len())
	}
	d.cancel("j1")
	if d.len() != 1 {
		t.Fatalf("expected 1 pending job after cancel, got %d", d.len())
	}
}
