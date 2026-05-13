package esl

import "errors"

// Sentinel errors returned by Client methods. Callers should match with
// errors.Is to remain forward-compatible.
var (
	// ErrCircuitOpen is returned when the per-FS circuit breaker is OPEN.
	// The caller (T04) should retry on a sibling FS or surface to the engine.
	ErrCircuitOpen = errors.New("esl: circuit breaker is open")

	// ErrFSDead is returned when the FS host has been marked DEAD after
	// FS_ESL_DEAD_THRESHOLD consecutive failed reconnects.
	ErrFSDead = errors.New("esl: fs host is dead")

	// ErrFSUnknown is returned when a FSHost string is not in FS_HOSTS.
	ErrFSUnknown = errors.New("esl: fs host unknown (not in FS_HOSTS)")

	// ErrAllFSDown is returned when no healthy FS is available and FSHost=="".
	ErrAllFSDown = errors.New("esl: all fs hosts are down or dead")

	// ErrRateLimited is returned when a per-FS or per-gateway token bucket is empty.
	ErrRateLimited = errors.New("esl: rate limited")

	// ErrJobOrphaned is returned when a bgapi BACKGROUND_JOB does not arrive
	// within FS_ESL_BG_JOB_TIMEOUT_MS.
	ErrJobOrphaned = errors.New("esl: bgapi job orphaned (no BACKGROUND_JOB within timeout)")

	// ErrShuttingDown is returned when the Client has received a shutdown signal.
	ErrShuttingDown = errors.New("esl: client is shutting down")

	// ErrNotConnected is returned when the FSConn is not in READY state.
	ErrNotConnected = errors.New("esl: not connected to fs host")
)
