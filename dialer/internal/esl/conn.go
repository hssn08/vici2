package esl

import (
	"sync"
	"sync/atomic"
	"time"
)

// connState represents the FSM state of a single FS connection.
// See T01 PLAN §3.2.
type connState int32

const (
	stateConnecting  connState = iota
	stateReconciling           // post-connect; running reconcile
	stateReady                 // events subscribed; commands accepted
	stateReconnecting
	stateDead // 3 consecutive reconnect failures
)

func (s connState) String() string {
	switch s {
	case stateConnecting:
		return "connecting"
	case stateReconciling:
		return "reconciling"
	case stateReady:
		return "ready"
	case stateReconnecting:
		return "reconnecting"
	case stateDead:
		return "dead"
	}
	return "unknown"
}

// fsConn holds the live *eslgo.Conn for one FS host plus its associated
// supervisor state. The supervisor goroutine is the sole writer of state.
type fsConn struct {
	host string

	// state is read by command methods; written only by supervisor goroutine.
	state atomic.Int32

	// mu protects conn (swapped on reconnect).
	mu   sync.RWMutex
	conn eslgoConn // interface for testability

	// Circuit breaker for Originate commands.
	breaker *circuitBreaker

	// Job dispatcher for BACKGROUND_JOB correlation.
	jobs *jobDispatcher

	// lastHeartbeat is updated on every received HEARTBEAT event.
	lastHeartbeat atomic.Int64 // unix nano

	// disconnectStart tracks when the current disconnect began (for metrics).
	disconnectStart time.Time

	// reconnectFailures tracks consecutive failed reconnects (for DEAD).
	reconnectFailures int
}

// eslgoConn is a marker interface stored in fsConn so tests can substitute
// a fake. In production, *realConn wraps *eslgo.Conn.
type eslgoConn interface {
	ExitAndClose()
}

// getState returns the current connection state.
func (fc *fsConn) getState() connState {
	return connState(fc.state.Load())
}

// setState atomically updates the connection state.
func (fc *fsConn) setState(s connState) {
	fc.state.Store(int32(s))
}

// isReady returns true if the connection is in READY state.
func (fc *fsConn) isReady() bool {
	return fc.getState() == stateReady
}

// isDead returns true if the FS host is classified DEAD.
func (fc *fsConn) isDead() bool {
	return fc.getState() == stateDead
}

// touchHeartbeat records the current time as the last heartbeat timestamp.
func (fc *fsConn) touchHeartbeat() {
	fc.lastHeartbeat.Store(time.Now().UnixNano())
}

// heartbeatAge returns how long ago the last heartbeat was received.
// Returns a large duration if no heartbeat was ever received.
func (fc *fsConn) heartbeatAge() time.Duration {
	ts := fc.lastHeartbeat.Load()
	if ts == 0 {
		return 9999 * time.Second
	}
	return time.Since(time.Unix(0, ts))
}
