package audit

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"
)

// Table identifies one of the five immutable audit tables.
type Table string

const (
	TableAuditLog        Table = "audit_log"
	TableCallWindowAudit Table = "call_window_audit"
	TableOriginateAudit  Table = "originate_audit"
	TableConsentLog      Table = "consent_log"
	TableDncSyncLog      Table = "dnc_sync_log"
)

// Result is returned by Append after a successful INSERT.
type Result struct {
	// ID is the auto-increment id of the newly inserted row.
	ID int64
	// RowHash is the 64-char lowercase hex SHA-256 row_hash computed by the
	// BEFORE INSERT trigger and read back via LAST_INSERT_ID() + SELECT.
	RowHash string
}

// Writer inserts rows into the immutable audit tables.
// The BEFORE INSERT trigger in MySQL handles prev_hash / row_hash / hash_at.
//
// Phase 1: direct MySQL INSERT via *sql.DB.
// Phase 4: batched via Valkey stream (no API change to callers).
type Writer struct {
	db *sql.DB
}

// NewWriter creates a new Writer backed by the given *sql.DB.
func NewWriter(db *sql.DB) *Writer {
	return &Writer{db: db}
}

// AppendAuditLog inserts a row into audit_log and returns its id + row_hash.
// The caller's transaction (if any) must be passed via ctx — Phase 1 uses
// auto-committed inserts for simplicity; Phase 4 may accept a *sql.Tx.
func (w *Writer) AppendAuditLog(ctx context.Context, r AuditLogRow) (Result, error) {
	var beforeJSON, afterJSON *string
	if r.BeforeJSON != nil {
		b, _ := json.Marshal(r.BeforeJSON)
		s := string(b)
		beforeJSON = &s
	}
	if r.AfterJSON != nil {
		b, _ := json.Marshal(r.AfterJSON)
		s := string(b)
		afterJSON = &s
	}

	result, err := w.db.ExecContext(ctx, `
		INSERT INTO audit_log
		  (tenant_id, actor_user_id, actor_kind, action, entity_type, entity_id,
		   before_json, after_json, request_id, ip_address, user_agent, ts)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		r.TenantID, optUint64(r.ActorUserID), r.ActorKind,
		r.Action, r.EntityType, r.EntityID,
		beforeJSON, afterJSON,
		r.RequestID, r.IPAddress, r.UserAgent,
		r.Ts.UTC().Format("2006-01-02 15:04:05.000000"),
	)
	if err != nil {
		return Result{}, fmt.Errorf("audit.Writer.AppendAuditLog: %w", err)
	}

	id, err := result.LastInsertId()
	if err != nil {
		return Result{}, fmt.Errorf("audit.Writer.AppendAuditLog: last insert id: %w", err)
	}

	rowHash, err := w.readRowHash(ctx, "audit_log", id)
	if err != nil {
		return Result{}, err
	}
	return Result{ID: id, RowHash: rowHash}, nil
}

// AppendCallWindowAudit inserts a row into call_window_audit.
func (w *Writer) AppendCallWindowAudit(ctx context.Context, r CallWindowAuditRow) (Result, error) {
	result, err := w.db.ExecContext(ctx, `
		INSERT INTO call_window_audit
		  (tenant_id, lead_id, phone_e164, campaign_id, decision, reason,
		   tz_iana, tz_confidence, state_code, zip, party_local, party_dow,
		   effective_open_min, effective_close_min, rule_applied,
		   enforcement_point, next_open_at, call_uuid)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		r.TenantID, r.LeadID, r.PhoneE164, r.CampaignID,
		r.Decision, r.Reason,
		r.TzIana, r.TzConfidence, r.StateCode, r.Zip,
		optTime(r.PartyLocal), optInt(r.PartyDow),
		optInt(r.EffectiveOpenMin), optInt(r.EffectiveCloseMin),
		r.RuleApplied, r.EnforcementPoint, optTime(r.NextOpenAt), r.CallUUID,
	)
	if err != nil {
		return Result{}, fmt.Errorf("audit.Writer.AppendCallWindowAudit: %w", err)
	}
	id, _ := result.LastInsertId()
	rowHash, err := w.readRowHash(ctx, "call_window_audit", id)
	if err != nil {
		return Result{}, err
	}
	return Result{ID: id, RowHash: rowHash}, nil
}

// AppendConsentLog inserts a row into consent_log.
func (w *Writer) AppendConsentLog(ctx context.Context, r ConsentLogRow) (Result, error) {
	result, err := w.db.ExecContext(ctx, `
		INSERT INTO consent_log
		  (tenant_id, call_uuid, lead_id, phone_e164, prompt_id,
		   dtmf_response, outcome, language, prompt_played_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		r.TenantID, r.CallUUID, r.LeadID, r.PhoneE164, r.PromptID,
		r.DtmfResponse, r.Outcome, r.Language,
		r.PromptPlayedAt.UTC().Format("2006-01-02 15:04:05.000000"),
	)
	if err != nil {
		return Result{}, fmt.Errorf("audit.Writer.AppendConsentLog: %w", err)
	}
	id, _ := result.LastInsertId()
	rowHash, err := w.readRowHash(ctx, "consent_log", id)
	if err != nil {
		return Result{}, err
	}
	return Result{ID: id, RowHash: rowHash}, nil
}

// AppendDncSyncLog inserts a row into dnc_sync_log.
func (w *Writer) AppendDncSyncLog(ctx context.Context, r DncSyncLogRow) (Result, error) {
	result, err := w.db.ExecContext(ctx, `
		INSERT INTO dnc_sync_log
		  (source, kind, file_hash, added, removed, started_at, completed_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		r.Source, r.Kind, r.FileHash,
		r.Added, r.Removed,
		r.StartedAt.UTC().Format("2006-01-02 15:04:05.000000"),
		optTimeStr(r.CompletedAt),
	)
	if err != nil {
		return Result{}, fmt.Errorf("audit.Writer.AppendDncSyncLog: %w", err)
	}
	id, _ := result.LastInsertId()
	rowHash, err := w.readRowHash(ctx, "dnc_sync_log", id)
	if err != nil {
		return Result{}, err
	}
	return Result{ID: id, RowHash: rowHash}, nil
}

// readRowHash fetches the row_hash computed by the BEFORE INSERT trigger.
func (w *Writer) readRowHash(ctx context.Context, table Table, id int64) (string, error) {
	var rowHash string
	err := w.db.QueryRowContext(ctx,
		fmt.Sprintf("SELECT row_hash FROM `%s` WHERE id = ?", table), id,
	).Scan(&rowHash)
	if err != nil {
		return "", fmt.Errorf("audit.Writer.readRowHash(%s, %d): %w", table, id, err)
	}
	return rowHash, nil
}

// ---------------------------------------------------------------------------
// Nullable helpers
// ---------------------------------------------------------------------------

func optUint64(v *uint64) interface{} {
	if v == nil {
		return nil
	}
	return *v
}

func optInt(v *int) interface{} {
	if v == nil {
		return nil
	}
	return *v
}

func optTime(v *time.Time) interface{} {
	if v == nil {
		return nil
	}
	return v.UTC().Format("2006-01-02 15:04:05.000000")
}

func optTimeStr(v *time.Time) interface{} {
	return optTime(v)
}
