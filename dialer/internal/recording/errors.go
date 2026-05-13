// Package recording owns per-call recording orchestration for vici2.
//
// R01 PLAN §5.5 — typed errors exported for callers to match with errors.Is.
package recording

import "errors"

// Sentinel errors — callers use errors.Is to match.
var (
	// ErrRecordingFailed is returned when the FreeSWITCH uuid_record command
	// fails (disk full, permission denied, FS not reachable).
	ErrRecordingFailed = errors.New("recording: start/stop failed at FS")

	// ErrDiskFull is returned when the scratch volume is at or above the 95%
	// stop-new-recordings threshold.
	ErrDiskFull = errors.New("recording: scratch volume at capacity")

	// ErrConsentMissing is returned when StartRecording is called without
	// consent_status having been set on the channel by C02.
	ErrConsentMissing = errors.New("recording: cannot start without consent_status set")

	// ErrModeForbidden is returned when the caller (agent) attempts a
	// pause/resume operation on a campaign with recording_mode=ALLFORCE.
	ErrModeForbidden = errors.New("recording: campaign mode forbids this action")

	// ErrCallNotActive is returned when the call_uuid is not found in the
	// active recordings Valkey HASH.
	ErrCallNotActive = errors.New("recording: call_uuid not in active recordings hash")

	// ErrAlreadyActive is returned when StartRecording is called for a
	// call_uuid that already has an active recording entry.
	ErrAlreadyActive = errors.New("recording: already recording this call")
)
