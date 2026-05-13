package esl

import (
	"testing"
	"time"
)

func TestCircuitBreaker_ClosedToOpen(t *testing.T) {
	cb := newCircuitBreaker(3, 30*time.Second)

	// Should start closed.
	if !cb.Allow() {
		t.Fatal("expected circuit CLOSED on init")
	}

	// Record 3 failures → trips OPEN.
	cb.RecordFailure()
	cb.RecordFailure()
	if !cb.Allow() {
		t.Fatal("expected circuit still CLOSED after 2 failures")
	}
	cb.RecordFailure()
	if cb.Allow() {
		t.Fatal("expected circuit OPEN after 3 failures")
	}
	if cb.State() != 2 {
		t.Fatalf("expected state=2 (open), got %d", cb.State())
	}
}

func TestCircuitBreaker_HalfOpenAfterDuration(t *testing.T) {
	cb := newCircuitBreaker(1, 50*time.Millisecond)
	cb.RecordFailure()
	if cb.Allow() {
		t.Fatal("expected circuit OPEN")
	}

	time.Sleep(60 * time.Millisecond)
	if !cb.Allow() {
		t.Fatal("expected circuit HALF_OPEN after duration")
	}
	if cb.State() != 1 {
		t.Fatalf("expected state=1 (half_open), got %d", cb.State())
	}
}

func TestCircuitBreaker_HalfOpenSuccessCloses(t *testing.T) {
	cb := newCircuitBreaker(1, 10*time.Millisecond)
	cb.RecordFailure()
	time.Sleep(15 * time.Millisecond)

	cb.Allow() // transition to HALF_OPEN
	cb.RecordSuccess()
	if cb.State() != 0 {
		t.Fatalf("expected state=0 (closed), got %d", cb.State())
	}
	if !cb.Allow() {
		t.Fatal("expected circuit CLOSED after success")
	}
}

func TestCircuitBreaker_HalfOpenFailureReopens(t *testing.T) {
	cb := newCircuitBreaker(1, 10*time.Millisecond)
	cb.RecordFailure()
	time.Sleep(15 * time.Millisecond)

	cb.Allow() // transition to HALF_OPEN
	cb.RecordFailure()
	if cb.Allow() {
		t.Fatal("expected circuit OPEN after half-open failure")
	}
}
