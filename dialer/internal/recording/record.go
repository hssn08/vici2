// Package recording implements per-call recording orchestration for vici2.
//
// R01 PLAN — Start/Stop/Pause/Resume per call leg via FreeSWITCH uuid_record.
// T01's UUIDRecord primitive handles the wire-level ESL command.
// Valkey HASH tracks in-progress recording state.
// Prometheus metrics are emitted for every lifecycle transition.
//
// PCI caveat (MUST appear in admin UI tooltip):
//
//	"Mask/unmask reduces but does not eliminate PCI scope. Per PCI DSS 4.0.1
//	(mandatory 2025-04-01) and PCI SSC 2024+ guidance, manual pause/resume is
//	treated as obsolete for PCI compliance — any failure puts the recording
//	system back in scope. Use a PCI-DSS-certified payment IVR or DTMF-suppression
//	sidecar (e.g., PCI Pal, Eckoh, Semafone, Aeriandi) for actual cardholder-data
//	capture in Phase 2+. R01 ships mask/unmask as table-stakes capability; we do
//	NOT market this as PCI-compliant."
package recording

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/redis/go-redis/v9"
)

// RecordingsDir is the default FS recording volume path (per vars.xml).
const RecordingsDir = "/var/lib/freeswitch/recordings"

// UUIDRecorder is the subset of the T01 ESL client used by Recorder.
// Matches esl.Client.UUIDRecord signature.
type UUIDRecorder interface {
	UUIDRecord(ctx context.Context, fsHost, callUUID, action, path string) error
}

// Recorder is the R01 public interface.
// R01 PLAN §7.1 — frozen API surface.
type Recorder interface {
	// StartRecording begins recording on the customer leg of an active call.
	// Used for ONDEMAND mode and as a programmatic fallback for ALL/ALLFORCE
	// when the dialplan path was skipped.
	// Returns the on-disk path and ErrConsentMissing | ErrAlreadyActive | ErrRecordingFailed.
	StartRecording(ctx context.Context, req StartRequest) (path string, err error)

	// StopRecording forces a stop (supervisor override / kill-switch / legal hold).
	// Idempotent — returns nil if already stopped.
	StopRecording(ctx context.Context, callUUID string) error

	// PauseRecording masks the recording with silence (PCI use case).
	// Returns ErrModeForbidden if campaign is ALLFORCE and actor is agent.
	// Authorization check is the caller's responsibility per R01 PLAN §7.1.
	PauseRecording(ctx context.Context, callUUID, actorRole string) error

	// ResumeRecording unmasks (audio captured normally again).
	// Returns ErrModeForbidden if campaign is ALLFORCE and actor is agent.
	ResumeRecording(ctx context.Context, callUUID, actorRole string) error

	// RecordingStatus reports current state for a given call.
	RecordingStatus(ctx context.Context, callUUID string) (RecordingStatus, error)
}

// StartRequest bundles all context needed to start a recording.
type StartRequest struct {
	// FSHost is the FreeSWITCH host that owns the call leg.
	FSHost string
	// CallUUID is the FS channel UUID (join key with call_log.uuid).
	CallUUID string
	// TenantID identifies the tenant.
	TenantID int64
	// CampaignID is the campaign string identifier (e.g. "SOLAR_Q2").
	CampaignID string
	// LeadID is the numeric lead identifier.
	LeadID int64
	// RecordingMode is the campaign recording mode.
	// ONDEMAND callers pass "ondemand"; dialplan-triggered passes "auto".
	RecordingMode string
	// ConsentStatus is the C02 consent_status channel-var value.
	// Must be "not_required", "prompted_accepted", or "assumed".
	// "prompted_declined" or "" returns ErrConsentMissing.
	ConsentStatus string
	// RecordingsDir overrides the default path root (empty = RecordingsDir const).
	RecordingsDir string
	// StartedAt overrides the start timestamp for testing (zero = time.Now()).
	StartedAt time.Time
}

// recorder is the concrete Recorder implementation.
type recorder struct {
	esl      UUIDRecorder
	store    *statusStore
	metrics  *recMetrics
	recDir   string
}

// New constructs a Recorder backed by the given ESL client and Valkey connection.
//
//   - reg may be nil (falls back to prometheus.DefaultRegisterer).
//   - recordingsDir may be empty (uses RecordingsDir constant).
//   - tenantID must be > 0.
func New(eslClient UUIDRecorder, rdb redis.Cmdable, tenantID int64, recordingsDir string, reg prometheus.Registerer) Recorder {
	if recordingsDir == "" {
		recordingsDir = RecordingsDir
	}
	return &recorder{
		esl:     eslClient,
		store:   &statusStore{rdb: rdb, tenantID: tenantID},
		metrics: newRecMetrics(reg),
		recDir:  recordingsDir,
	}
}

// consentOK returns true when the consent_status value allows recording.
// R01 PLAN §10.1 — consent gate.
func consentOK(consentStatus string) bool {
	switch consentStatus {
	case "not_required", "prompted_accepted", "assumed", "beep_only", "prompted_assumed":
		return true
	default:
		return false
	}
}

// StartRecording begins recording on the customer leg.
func (r *recorder) StartRecording(ctx context.Context, req StartRequest) (string, error) {
	if !consentOK(req.ConsentStatus) {
		tid := fmt.Sprintf("%d", r.store.tenantID)
		r.metrics.failuresTotal.With(prometheus.Labels{
			"tenant_id": tid,
			"reason":    "consent_missing",
		}).Inc()
		return "", ErrConsentMissing
	}

	// Check for duplicate.
	existing, err := r.store.read(ctx, req.CallUUID)
	if err == nil && existing.State == StateRecording {
		return existing.Path, ErrAlreadyActive
	}

	// Compute path.
	startedAt := req.StartedAt
	if startedAt.IsZero() {
		startedAt = time.Now().UTC()
	}
	recDir := req.RecordingsDir
	if recDir == "" {
		recDir = r.recDir
	}
	path := ComputePath(recDir, r.store.tenantID, req.CampaignID, req.LeadID, req.CallUUID, startedAt)

	// Issue uuid_record start via T01.
	if err := r.esl.UUIDRecord(ctx, req.FSHost, req.CallUUID, "start", path); err != nil {
		tid := fmt.Sprintf("%d", r.store.tenantID)
		r.metrics.failuresTotal.With(prometheus.Labels{
			"tenant_id": tid,
			"reason":    "esl_timeout",
		}).Inc()
		slog.ErrorContext(ctx, "recording: uuid_record start failed",
			slog.String("call_uuid", req.CallUUID),
			slog.String("path", path),
			slog.String("error", err.Error()),
		)
		return "", fmt.Errorf("%w: %s", ErrRecordingFailed, err.Error())
	}

	// Write state to Valkey.
	if err := r.store.write(ctx, req.CallUUID, path, StateRecording, startedAt, 0, 0, 0, req.CampaignID, req.LeadID); err != nil {
		// Non-fatal: log but don't fail the call.
		slog.WarnContext(ctx, "recording: failed to write status to Valkey",
			slog.String("call_uuid", req.CallUUID),
			slog.String("error", err.Error()),
		)
	}

	// Emit metrics.
	tid := fmt.Sprintf("%d", r.store.tenantID)
	mode := req.RecordingMode
	if mode == "" {
		mode = "auto"
	}
	r.metrics.startedTotal.With(prometheus.Labels{
		"tenant_id":   tid,
		"campaign_id": req.CampaignID,
		"mode":        mode,
	}).Inc()
	r.metrics.activeCount.With(prometheus.Labels{"tenant_id": tid}).Inc()

	slog.InfoContext(ctx, "recording: started",
		slog.String("call_uuid", req.CallUUID),
		slog.String("path", path),
		slog.String("mode", mode),
	)
	return path, nil
}

// StopRecording forces stop of a recording mid-call (supervisor override).
func (r *recorder) StopRecording(ctx context.Context, callUUID string) error {
	rs, err := r.store.read(ctx, callUUID)
	if err != nil {
		// Already stopped / not found — idempotent.
		return nil
	}

	if err := r.esl.UUIDRecord(ctx, "", callUUID, "stop", rs.Path); err != nil {
		slog.WarnContext(ctx, "recording: uuid_record stop failed",
			slog.String("call_uuid", callUUID),
			slog.String("error", err.Error()),
		)
		return fmt.Errorf("%w: %s", ErrRecordingFailed, err.Error())
	}

	if err := r.store.setState(ctx, callUUID, StateStopped); err != nil {
		slog.WarnContext(ctx, "recording: failed to update Valkey state to stopped",
			slog.String("call_uuid", callUUID),
			slog.String("error", err.Error()),
		)
	}

	slog.InfoContext(ctx, "recording: stopped (force)",
		slog.String("call_uuid", callUUID),
		slog.String("path", rs.Path),
	)
	return nil
}

// PauseRecording masks the recording with silence (PCI DTMF masking).
// actorRole must be "agent" or "supervisor". ALLFORCE enforcement is the
// caller's responsibility (API layer); R01 tracks the event.
func (r *recorder) PauseRecording(ctx context.Context, callUUID, actorRole string) error {
	rs, err := r.store.read(ctx, callUUID)
	if err != nil {
		return ErrCallNotActive
	}
	if rs.State != StateRecording {
		// Already masked or stopped — idempotent.
		return nil
	}

	if err := r.esl.UUIDRecord(ctx, "", callUUID, "mask", rs.Path); err != nil {
		return fmt.Errorf("%w: %s", ErrRecordingFailed, err.Error())
	}

	now := time.Now().UTC()
	if err := r.store.write(ctx, callUUID, rs.Path, StateMasked, rs.StartedAt, now.UnixNano(), 0, rs.PauseCount+1, "", 0); err != nil {
		slog.WarnContext(ctx, "recording: failed to update Valkey state to masked",
			slog.String("call_uuid", callUUID),
			slog.String("error", err.Error()),
		)
	}

	tid := fmt.Sprintf("%d", r.store.tenantID)
	r.metrics.pauseTotal.With(prometheus.Labels{
		"tenant_id":  tid,
		"actor_role": actorRole,
	}).Inc()

	slog.InfoContext(ctx, "recording: paused (masked)",
		slog.String("call_uuid", callUUID),
		slog.String("actor_role", actorRole),
	)
	return nil
}

// ResumeRecording unmasks the recording (audio captured normally again).
func (r *recorder) ResumeRecording(ctx context.Context, callUUID, actorRole string) error {
	rs, err := r.store.read(ctx, callUUID)
	if err != nil {
		return ErrCallNotActive
	}
	if rs.State != StateMasked {
		// Not currently masked — idempotent.
		return nil
	}

	if err := r.esl.UUIDRecord(ctx, "", callUUID, "unmask", rs.Path); err != nil {
		return fmt.Errorf("%w: %s", ErrRecordingFailed, err.Error())
	}

	now := time.Now().UTC()
	resumedAtNs := now.UnixNano()
	pausedAtNs := int64(0) // clear paused_at on resume
	if err := r.store.write(ctx, callUUID, rs.Path, StateRecording, rs.StartedAt, pausedAtNs, resumedAtNs, rs.PauseCount, "", 0); err != nil {
		slog.WarnContext(ctx, "recording: failed to update Valkey state to recording after unmask",
			slog.String("call_uuid", callUUID),
			slog.String("error", err.Error()),
		)
	}

	tid := fmt.Sprintf("%d", r.store.tenantID)
	r.metrics.resumeTotal.With(prometheus.Labels{
		"tenant_id":  tid,
		"actor_role": actorRole,
	}).Inc()

	slog.InfoContext(ctx, "recording: resumed (unmasked)",
		slog.String("call_uuid", callUUID),
		slog.String("actor_role", actorRole),
	)
	return nil
}

// RecordingStatus returns the current recording state for a call.
func (r *recorder) RecordingStatus(ctx context.Context, callUUID string) (RecordingStatus, error) {
	return r.store.read(ctx, callUUID)
}

// DeleteStatus removes the in-progress Valkey HASH entry.
// Called by the T01 stream consumer (workers/recording-log-writer) on RECORD_STOP
// AFTER writing the recording_log row. Exported so the consumer package can call it.
func DeleteStatus(ctx context.Context, rdb redis.Cmdable, tenantID int64, callUUID string) error {
	store := &statusStore{rdb: rdb, tenantID: tenantID}
	return store.del(ctx, callUUID)
}
