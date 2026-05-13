package originate

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"
)

// auditRow is the in-memory representation of one originate_audit row.
type auditRow struct {
	id          int64
	tenantID    int64
	attemptUUID string
	callUUID    *string
	leadID      int64
	campaignID  string
	listID      int64
	agentID     int64
	mode        string
	dialTarget  string
	carrierID   *int64
	gatewayID   *int64
	gatewayName *string
	callerID    *string
	cidSource   *string
	phoneE164   string
	originatedAt time.Time

	tcpaDecision  *string
	tcpaReason    *string
	tcpaTzResolved *string

	dncDecision *string
	dnCSources  *string // JSON array

	consentDecision *string
	consentState    *string

	bypassToken *string

	outcome     string
	outcomeAt   *time.Time
	durationMs  *int64
	errorMessage *string
	fsHost       *string
	requestID    *string
	ipAddress    *string
}

// applyPatch merges a gate's AuditRowPatch into the audit row.
func (a *auditRow) applyPatch(p AuditRowPatch) {
	if p.CarrierID != 0 {
		a.carrierID = &p.CarrierID
	}
	if p.GatewayID != 0 {
		a.gatewayID = &p.GatewayID
	}
	if p.GatewayName != "" {
		a.gatewayName = &p.GatewayName
	}
	if p.TCPADecision != "" {
		a.tcpaDecision = &p.TCPADecision
	}
	if p.TCPAReason != "" {
		a.tcpaReason = &p.TCPAReason
	}
	if p.TCPATzIANA != "" {
		a.tcpaTzResolved = &p.TCPATzIANA
	}
	if p.DNCDecision != "" {
		a.dncDecision = &p.DNCDecision
	}
	if len(p.DNCSources) > 0 {
		b, _ := json.Marshal(p.DNCSources)
		s := string(b)
		a.dnCSources = &s
	}
	if p.ConsentDecision != "" {
		a.consentDecision = &p.ConsentDecision
	}
	if p.ConsentState != "" {
		a.consentState = &p.ConsentState
	}
	if p.BypassToken != "" {
		a.bypassToken = &p.BypassToken
	}
	if p.ErrorMessage != "" {
		a.errorMessage = &p.ErrorMessage
	}
}

// insertAuditRow inserts the audit row and sets a.id from the last insert ID.
// The INSERT is synchronous (T04 PLAN §6.1) — TCPA evidence must be durable
// before T01.Originate is called.
func insertAuditRow(ctx context.Context, db *sql.DB, a *auditRow) error {
	const q = `
INSERT INTO originate_audit (
	tenant_id, attempt_uuid, lead_id, campaign_id, list_id, agent_id,
	mode, dial_target,
	carrier_id, gateway_id, gateway_name,
	caller_id_number, caller_id_source,
	phone_e164, originated_at,
	tcpa_decision, tcpa_reason, tcpa_tz_resolved,
	dnc_decision, dnc_sources,
	consent_decision, consent_state,
	bypass_token,
	outcome, error_message, request_id, ip_address
) VALUES (
	?,?,?,?,?,?,
	?,?,
	?,?,?,
	?,?,
	?,?,
	?,?,?,
	?,?,
	?,?,
	?,
	?,?,?,?
)`
	res, err := db.ExecContext(ctx, q,
		a.tenantID, a.attemptUUID, a.leadID, a.campaignID, a.listID, a.agentID,
		a.mode, a.dialTarget,
		a.carrierID, a.gatewayID, a.gatewayName,
		a.callerID, a.cidSource,
		a.phoneE164, a.originatedAt,
		a.tcpaDecision, a.tcpaReason, a.tcpaTzResolved,
		a.dncDecision, a.dnCSources,
		a.consentDecision, a.consentState,
		a.bypassToken,
		a.outcome, a.errorMessage, a.requestID, a.ipAddress,
	)
	if err != nil {
		return fmt.Errorf("originate: insertAuditRow: %w", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		return fmt.Errorf("originate: insertAuditRow: LastInsertId: %w", err)
	}
	a.id = id
	return nil
}

// finalizeAuditRow performs the single-shot UPDATE guarded by
// WHERE outcome='OTHER' AND outcome_at IS NULL.
// Fields with nil pointers are left unchanged (NULL).
func finalizeAuditRow(ctx context.Context, db *sql.DB, a *auditRow) error {
	now := time.Now().UTC()
	a.outcomeAt = &now
	if a.originatedAt.IsZero() {
		a.durationMs = nil
	} else {
		ms := now.Sub(a.originatedAt).Milliseconds()
		a.durationMs = &ms
	}

	const q = `
UPDATE originate_audit
   SET outcome = ?,
       call_uuid = ?,
       outcome_at = ?,
       duration_ms = ?,
       error_message = ?,
       fs_host = ?
 WHERE id = ?
   AND originated_at = ?
   AND outcome = 'OTHER'
   AND outcome_at IS NULL`

	_, err := db.ExecContext(ctx, q,
		a.outcome,
		a.callUUID,
		a.outcomeAt,
		a.durationMs,
		a.errorMessage,
		a.fsHost,
		a.id,
		a.originatedAt,
	)
	if err != nil {
		return fmt.Errorf("originate: finalizeAuditRow: %w", err)
	}
	return nil
}

// checkIdempotency looks up an existing row for the attempt_uuid.
// Returns (rowID, outcome, callUUID, found, error).
// The SELECT scans bounded to the last 35 days (active + previous partition).
func checkIdempotency(ctx context.Context, db *sql.DB, attemptUUID string) (int64, string, string, bool, error) {
	const q = `
SELECT id, outcome, COALESCE(call_uuid,'')
  FROM originate_audit
 WHERE attempt_uuid = ?
   AND originated_at >= NOW() - INTERVAL 35 DAY
 LIMIT 1`

	var id int64
	var outcome, callUUID string
	err := db.QueryRowContext(ctx, q, attemptUUID).Scan(&id, &outcome, &callUUID)
	if err == sql.ErrNoRows {
		return 0, "", "", false, nil
	}
	if err != nil {
		return 0, "", "", false, fmt.Errorf("originate: checkIdempotency: %w", err)
	}
	return id, outcome, callUUID, true, nil
}
