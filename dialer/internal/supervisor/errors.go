package supervisor

import "errors"

// Sentinel errors for the supervisor package.
var (
	// ErrInvalidMode is returned when a mode string cannot be parsed.
	ErrInvalidMode = errors.New("supervisor: invalid monitor mode (must be listen|whisper|barge)")

	// ErrSessionNotFound is returned when no active monitor session exists for
	// the given (tenantID, supCallUUID) tuple.
	ErrSessionNotFound = errors.New("supervisor: session not found")

	// ErrSameMode is returned by TransitionMode when the requested mode is
	// already active. API layer converts to 409 Conflict.
	ErrSameMode = errors.New("supervisor: mode transition to same mode")
)
