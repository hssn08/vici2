package esl

import (
	"sync"
	"time"
)

// cbState is the circuit-breaker state per PLAN §5.3.
type cbState int

const (
	cbClosed   cbState = iota // normal — commands allowed
	cbHalfOpen                // single probe originate allowed
	cbOpen                    // commands rejected; ErrCircuitOpen returned
)

// circuitBreaker is a per-FS, originate-only breaker (PLAN §5).
// All methods are safe for concurrent use.
type circuitBreaker struct {
	mu           sync.Mutex
	state        cbState
	failures     int   // consecutive failures while CLOSED
	threshold    int   // trips OPEN after this many failures
	openDuration time.Duration
	openAt       time.Time
}

func newCircuitBreaker(threshold int, openDuration time.Duration) *circuitBreaker {
	return &circuitBreaker{
		threshold:    threshold,
		openDuration: openDuration,
	}
}

// Allow returns true if an originate command may proceed.
// It also handles the OPEN → HALF_OPEN transition.
func (cb *circuitBreaker) Allow() bool {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	switch cb.state {
	case cbClosed:
		return true
	case cbHalfOpen:
		return true
	case cbOpen:
		if time.Since(cb.openAt) >= cb.openDuration {
			cb.state = cbHalfOpen
			return true
		}
		return false
	}
	return false
}

// RecordSuccess resets the breaker to CLOSED.
func (cb *circuitBreaker) RecordSuccess() {
	cb.mu.Lock()
	defer cb.mu.Unlock()
	cb.failures = 0
	cb.state = cbClosed
}

// RecordFailure increments the failure counter; trips OPEN if threshold reached.
func (cb *circuitBreaker) RecordFailure() {
	cb.mu.Lock()
	defer cb.mu.Unlock()
	cb.failures++
	if cb.failures >= cb.threshold || cb.state == cbHalfOpen {
		cb.state = cbOpen
		cb.openAt = time.Now()
		cb.failures = 0
	}
}

// State returns the current breaker state value for metrics.
// 0=closed, 1=half_open, 2=open (matching PLAN §12 gauge encoding).
func (cb *circuitBreaker) State() int {
	cb.mu.Lock()
	defer cb.mu.Unlock()
	// re-evaluate open→half_open transition for accurate metrics
	if cb.state == cbOpen && time.Since(cb.openAt) >= cb.openDuration {
		cb.state = cbHalfOpen
	}
	return int(cb.state)
}
