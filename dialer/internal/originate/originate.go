package originate

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/vici2/dialer/internal/esl"
)

// Service is the T04 compliance-gated originate service.
// Construct with New(Opts{}); safe for concurrent use.
type Service struct {
	db        *sql.DB
	t01       *esl.Client
	gates     []Gate
	metrics   *Metrics
	logger    *slog.Logger
	nowFn     func() time.Time
	poolSvc   PoolPicker // X04: nil = pool tier skipped
}

// Opts configures Service construction.
type Opts struct {
	DB        *sql.DB
	T01Client *esl.Client
	// Gates is the ordered 5-gate pipeline. If nil, the default phase-1 gate
	// slice is used (requires TCPAChecker and DNCChecker non-nil).
	Gates   []Gate
	Metrics *Metrics
	Logger  *slog.Logger
	// NowFn is overridable for tests.
	NowFn func() time.Time
	// PoolSvc wires the X04 number pool picker (Tier 3). nil = disabled.
	PoolSvc PoolPicker
}

// New constructs the Service with all dependencies wired.
func New(opts Opts) *Service {
	if opts.NowFn == nil {
		opts.NowFn = time.Now
	}
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	s := &Service{
		db:      opts.DB,
		t01:     opts.T01Client,
		gates:   opts.Gates,
		metrics: opts.Metrics,
		logger:  opts.Logger,
		nowFn:   opts.NowFn,
		poolSvc: opts.PoolSvc,
	}
	return s
}

// Originate runs the 5-gate compliance pipeline, INSERTs the originate_audit
// row, and (on all-ALLOW) calls T01.Client.Originate with the assembled
// channel vars. See T04 PLAN §6.1 for the full timing contract.
//
// Returns (*OriginateResult, nil) on full pipeline pass.
// Returns (nil, OriginateError) for any gate block or transport fail.
// Returns (nil, ErrInProgress) if the row is already in-flight (outcome=OTHER).
// Returns (*OriginateResult, nil) with AuditRowID set for idempotent replay.
func (s *Service) Originate(ctx context.Context, req OriginateRequest) (*OriginateResult, error) {
	if req.AttemptUUID == "" {
		return nil, ErrMissingAttemptUUID
	}

	// ── Step 0: idempotency check ──────────────────────────────────────────────
	if s.db != nil {
		rowID, outcome, callUUID, found, err := checkIdempotency(ctx, s.db, req.AttemptUUID)
		if err != nil {
			s.logger.Error("originate: idempotency check failed", "err", err, "attempt_uuid", req.AttemptUUID)
			// Non-fatal: proceed (risk duplicate but better than rejecting).
		} else if found {
			if outcome == string(OutcomeOther) {
				return nil, ErrInProgress
			}
			// Idempotent replay — return prior result without re-running gates.
			if s.metrics != nil {
				s.metrics.IdempotentReplaysTotal.WithLabelValues(string(req.Mode)).Inc()
			}
			return &OriginateResult{
				AttemptUUID: req.AttemptUUID,
				CallUUID:    callUUID,
				AuditRowID:  rowID,
				Outcome:     OriginateOutcome(outcome),
			}, nil
		}
	}

	// ── Step 1: pick caller-ID ─────────────────────────────────────────────────
	scratch := &GateScratch{}
	// poolSvc wired via s.poolSvc (nil = pool tier skipped, falls through to campaign default)
	cidNum, cidName, cidSrc, err := PickCallerID(ctx, &req, s.poolSvc)
	if err != nil {
		return nil, fmt.Errorf("originate: caller-id: %w", err)
	}
	scratch.CallerID = cidNum
	scratch.CallerIDName = cidName
	scratch.CallerIDSource = cidSrc

	// ── Step 2: run the 5 gates in FROZEN order ────────────────────────────────
	row := &auditRow{
		tenantID:    req.TenantID,
		attemptUUID: req.AttemptUUID,
		leadID:      req.LeadID,
		campaignID:  req.CampaignID,
		listID:      req.ListID,
		agentID:     req.AgentID,
		mode:        string(req.Mode),
		dialTarget:  string(dialTargetFor(req.Mode)),
		phoneE164:   req.DestNumber,
		originatedAt: s.nowFn().UTC(),
		requestID:   strPtr(req.RequestID),
		ipAddress:   strPtr(req.IPAddress),
	}
	if cidNum != "" {
		row.callerID = &cidNum
	}
	cidSrcStr := string(cidSrc)
	if cidSrcStr != "" {
		row.cidSource = &cidSrcStr
	}

	for _, gate := range s.gates {
		gStart := s.nowFn()
		result := gate.Check(ctx, &req, scratch)
		gDur := time.Since(gStart)

		if s.metrics != nil {
			s.metrics.GateDuration.WithLabelValues(gate.Name()).Observe(gDur.Seconds())
		}

		row.applyPatch(result.AuditPatch)

		if result.Outcome == GateBlock {
			row.outcome = string(result.Block.Outcome())

			// Synchronous INSERT before returning the block error.
			if s.db != nil {
				insertStart := s.nowFn()
				if ierr := insertAuditRow(ctx, s.db, row); ierr != nil {
					s.logger.Error("originate: audit INSERT failed on block", "err", ierr)
				}
				if s.metrics != nil {
					s.metrics.AuditInsertLatency.Observe(time.Since(insertStart).Seconds())
				}
			}

			if s.metrics != nil {
				s.metrics.ComplianceBlockedTotal.WithLabelValues(
					gate.Name(), result.Block.SubReason(),
				).Inc()
				s.metrics.OriginateTotal.WithLabelValues(
					fmt.Sprintf("%d", req.TenantID), req.CampaignID,
					string(req.Mode), string(result.Block.Outcome()),
				).Inc()
			}

			return nil, result.Block
		}
	}

	// ── Step 3: all gates ALLOW — INSERT audit row with outcome=OTHER ──────────
	row.outcome = string(OutcomeOther)

	if s.db != nil {
		insertStart := s.nowFn()
		if ierr := insertAuditRow(ctx, s.db, row); ierr != nil {
			// Audit INSERT failure is fatal: we cannot proceed without TCPA evidence.
			return nil, fmt.Errorf("originate: audit INSERT failed: %w", ierr)
		}
		if s.metrics != nil {
			s.metrics.AuditInsertLatency.Observe(time.Since(insertStart).Seconds())
		}
		if s.metrics != nil {
			s.metrics.Inflight.Inc()
		}
	}

	// ── Step 4: assemble channel vars and call T01 ─────────────────────────────
	channelVars := buildChannelVars(&req, scratch)

	// Map mode → on-answer action.
	dt := dialTargetFor(req.Mode)
	var onAnswer esl.OnAnswerAction
	if dt == DialTargetConference {
		onAnswer = esl.OnAnswerConference{Name: conferenceNameForReq(&req)}
	} else {
		onAnswer = esl.OnAnswerPark{}
	}

	t01Req := esl.OriginateRequest{
		FSHost:           req.FSHost,
		GatewayName:      req.GatewayName,
		DestNumber:       req.DestNumber,
		CallerIDNumber:   scratch.CallerID,
		CallerIDName:     scratch.CallerIDName,
		OriginateTimeout: req.DialTimeout,
		OnAnswer:         onAnswer,
		ChannelVars:      channelVars,
		LeadID:           req.LeadID,
		TenantID:         req.TenantID,
		// one-UUID rule: PreSuppliedUUID == PreSuppliedJobID == AttemptUUID
		PreSuppliedUUID:  req.AttemptUUID,
		PreSuppliedJobID: req.AttemptUUID,
	}

	// ── Step 5: call T01 ───────────────────────────────────────────────────────
	var callUUID string
	var t01Err error
	if s.t01 != nil {
		callUUID, t01Err = s.t01.Originate(ctx, t01Req)
	} else {
		// nil T01 = test-only: echo the attempt_uuid as callUUID.
		callUUID = req.AttemptUUID
	}

	// ── Step 6: finalize audit row ─────────────────────────────────────────────
	if s.metrics != nil {
		s.metrics.Inflight.Dec()
	}

	if t01Err != nil {
		outcome, retryAfter, subReason := mapT01Error(t01Err)
		row.outcome = string(outcome)
		errMsg := t01Err.Error()
		row.errorMessage = &errMsg

		if s.db != nil {
			_ = finalizeAuditRow(ctx, s.db, row)
		}

		if s.metrics != nil {
			s.metrics.CarrierFailTotal.WithLabelValues(req.FSHost, subReason).Inc()
			s.metrics.OriginateTotal.WithLabelValues(
				fmt.Sprintf("%d", req.TenantID), req.CampaignID,
				string(req.Mode), string(outcome),
			).Inc()
		}

		return nil, NewCarrierFailErr(req.AttemptUUID, subReason, retryAfter, outcome)
	}

	// Success.
	row.outcome = string(OutcomeSuccess)
	row.callUUID = &callUUID
	fsHost := req.FSHost
	if fsHost != "" {
		row.fsHost = &fsHost
	}

	if s.db != nil {
		_ = finalizeAuditRow(ctx, s.db, row)
	}

	if s.metrics != nil {
		s.metrics.OriginateTotal.WithLabelValues(
			fmt.Sprintf("%d", req.TenantID), req.CampaignID,
			string(req.Mode), string(OutcomeSuccess),
		).Inc()
	}

	return &OriginateResult{
		AttemptUUID: req.AttemptUUID,
		CallUUID:    callUUID,
		AuditRowID:  row.id,
		Outcome:     OutcomeSuccess,
		GateApplied: "",
	}, nil
}

// mapT01Error maps T01 error types to T04 outcome + retry hint.
func mapT01Error(err error) (OriginateOutcome, time.Duration, string) {
	switch {
	case errors.Is(err, esl.ErrCircuitOpen):
		return OutcomeGatewayFail, 60 * time.Second, "circuit_open"
	case errors.Is(err, esl.ErrFSDead):
		return OutcomeGatewayFail, 60 * time.Second, "fs_dead"
	case errors.Is(err, esl.ErrAllFSDown):
		return OutcomeGatewayFail, 60 * time.Second, "all_fs_down"
	case errors.Is(err, esl.ErrJobOrphaned):
		return OutcomeJobOrphaned, 300 * time.Second, "job_orphaned"
	case errors.Is(err, esl.ErrRateLimited):
		return OutcomeRateLimited, 5 * time.Second, "rate_limited"
	default:
		return OutcomeGatewayFail, 60 * time.Second, "gateway_failure"
	}
}

// strPtr returns a pointer to s, or nil if s is empty.
func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
