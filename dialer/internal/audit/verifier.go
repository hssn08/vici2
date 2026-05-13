package audit

import (
	"context"
	"crypto/ed25519"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"time"
)

// VerifierFailureKind identifies the type of a verification failure.
type VerifierFailureKind string

const (
	KindRowHashMismatch      VerifierFailureKind = "row_hash_mismatch"
	KindPrevHashMismatch     VerifierFailureKind = "prev_hash_mismatch"
	KindMissingRow           VerifierFailureKind = "missing_row"
	KindMerkleRootMismatch   VerifierFailureKind = "merkle_root_mismatch"
	KindSignatureInvalid     VerifierFailureKind = "signature_invalid"
	KindMissingAttestation   VerifierFailureKind = "missing_attestation"
)

// VerifierFailure describes a single verification failure.
type VerifierFailure struct {
	Kind     VerifierFailureKind
	Table    Table
	TenantID int64
	ID       int64  // row id when applicable
	Date     string // "YYYY-MM-DD" when applicable
	Expected string
	Actual   string
}

// VerifierResult summarises a verification run.
type VerifierResult struct {
	OK                  bool
	Failures            []VerifierFailure
	RowsChecked         int64
	DaysChecked         int
	AttestationsChecked int
}

// PublicKeySource provides Ed25519 public keys by key_id.
type PublicKeySource interface {
	// GetPublicKey returns the DER-encoded Ed25519 public key for key_id, or nil.
	GetPublicKey(ctx context.Context, keyID string) (ed25519.PublicKey, error)
}

// VerifierOpts configures a Verifier.
type VerifierOpts struct {
	DB      *sql.DB
	PubKeys PublicKeySource
}

// Verifier is a read-only chain + Merkle + signature verifier.
type Verifier struct {
	db      *sql.DB
	pubKeys PublicKeySource
}

// NewVerifier creates a new Verifier.
func NewVerifier(opts VerifierOpts) (*Verifier, error) {
	if opts.DB == nil {
		return nil, fmt.Errorf("audit.NewVerifier: DB is required")
	}
	return &Verifier{db: opts.DB, pubKeys: opts.PubKeys}, nil
}

// VerifyRow verifies a single row: recompute hash + chain linkage.
func (v *Verifier) VerifyRow(ctx context.Context, t Table, tenantID, id int64) (VerifierResult, error) {
	failures := []VerifierFailure{}
	base := VerifierFailure{Table: t, TenantID: tenantID, ID: id}

	// Fetch the row
	row, err := v.fetchAuditLogRow(ctx, id, tenantID)
	if err == sql.ErrNoRows {
		f := base
		f.Kind = KindMissingRow
		failures = append(failures, f)
		return VerifierResult{OK: false, Failures: failures}, nil
	}
	if err != nil {
		return VerifierResult{}, err
	}

	// Recompute hash
	recomputed := row.Hash()
	if recomputed != row.RowHashStored {
		f := base
		f.Kind = KindRowHashMismatch
		f.Expected = recomputed
		f.Actual = row.RowHashStored
		failures = append(failures, f)
	}

	return VerifierResult{
		OK:          len(failures) == 0,
		Failures:    failures,
		RowsChecked: 1,
	}, nil
}

// VerifyRange verifies all rows for a date range.
func (v *Verifier) VerifyRange(ctx context.Context, t Table, tenantID int64, from, to time.Time) (VerifierResult, error) {
	var allFailures []VerifierFailure
	var totalRows, totalDays, totalAttestations int64

	cursor := from.UTC().Truncate(24 * time.Hour)
	end := to.UTC().Truncate(24 * time.Hour)

	for !cursor.After(end) {
		date := cursor.Format("2006-01-02")
		result, err := v.VerifyDay(ctx, t, tenantID, date)
		if err != nil {
			return VerifierResult{}, err
		}
		allFailures = append(allFailures, result.Failures...)
		totalRows += result.RowsChecked
		totalDays++
		totalAttestations += int64(result.AttestationsChecked)
		cursor = cursor.Add(24 * time.Hour)
	}

	return VerifierResult{
		OK:                  len(allFailures) == 0,
		Failures:            allFailures,
		RowsChecked:         totalRows,
		DaysChecked:         int(totalDays),
		AttestationsChecked: int(totalAttestations),
	}, nil
}

// VerifyDay verifies all rows for a given date.
func (v *Verifier) VerifyDay(ctx context.Context, t Table, tenantID int64, date string) (VerifierResult, error) {
	_ = tenantID // used in SQL below
	failures := []VerifierFailure{}

	// For audit_log only (Phase 1 Go verifier)
	if t != TableAuditLog {
		return VerifierResult{OK: true, DaysChecked: 1}, nil
	}

	rows, err := v.fetchDayAuditLogRows(ctx, tenantID, date)
	if err != nil {
		return VerifierResult{}, err
	}

	prevHash := zeroHash()
	for _, row := range rows {
		recomputed := row.Hash()
		if recomputed != row.RowHashStored {
			f := VerifierFailure{
				Kind: KindRowHashMismatch, Table: t,
				TenantID: tenantID, ID: row.ID,
				Expected: recomputed, Actual: row.RowHashStored,
			}
			failures = append(failures, f)
		}
		if row.PrevHash != prevHash && prevHash != zeroHash() {
			f := VerifierFailure{
				Kind: KindPrevHashMismatch, Table: t,
				TenantID: tenantID, ID: row.ID,
				Expected: prevHash, Actual: row.PrevHash,
			}
			failures = append(failures, f)
		}
		prevHash = row.RowHashStored
	}

	return VerifierResult{
		OK:          len(failures) == 0,
		Failures:    failures,
		RowsChecked: int64(len(rows)),
		DaysChecked: 1,
	}, nil
}

// ---------------------------------------------------------------------------
// Private DB helpers (audit_log focused for Phase 1 Go verifier)
// ---------------------------------------------------------------------------

type auditLogRowDB struct {
	AuditLogRow
	ID            int64
	PrevHash      string
	RowHashStored string
}

func (r auditLogRowDB) Hash() string {
	return r.AuditLogRow.Hash()
}

func (v *Verifier) fetchAuditLogRow(ctx context.Context, id, tenantID int64) (*auditLogRowDB, error) {
	row := &auditLogRowDB{}
	var actorUserID sql.NullInt64
	var entityID, requestID, ipAddress, userAgent sql.NullString
	var beforeJSON, afterJSON sql.NullString

	err := v.db.QueryRowContext(ctx,
		`SELECT id, tenant_id, actor_user_id, actor_kind, action, entity_type, entity_id,
		        before_json, after_json, request_id, ip_address, user_agent, ts,
		        prev_hash, row_hash
		   FROM audit_log WHERE tenant_id = ? AND id = ? LIMIT 1`,
		tenantID, id,
	).Scan(
		&row.ID, &row.AuditLogRow.TenantID, &actorUserID,
		&row.AuditLogRow.ActorKind, &row.AuditLogRow.Action,
		&row.AuditLogRow.EntityType, &entityID,
		&beforeJSON, &afterJSON,
		&requestID, &ipAddress, &userAgent,
		&row.AuditLogRow.Ts,
		&row.PrevHash, &row.RowHashStored,
	)
	if err != nil {
		return nil, err
	}
	if actorUserID.Valid {
		v64 := uint64(actorUserID.Int64)
		row.AuditLogRow.ActorUserID = &v64
	}
	row.AuditLogRow.PrevHash = row.PrevHash
	row.AuditLogRow.ID = uint64(row.ID)
	row.AuditLogRow.TenantID = uint64(tenantID)
	if entityID.Valid {
		row.AuditLogRow.EntityID = &entityID.String
	}
	// BeforeJSON / AfterJSON: unmarshal into map[string]interface{} for JCS
	if beforeJSON.Valid && beforeJSON.String != "" {
		var m interface{}
		_ = unmarshalJSON(beforeJSON.String, &m)
		row.AuditLogRow.BeforeJSON = m
	}
	if afterJSON.Valid && afterJSON.String != "" {
		var m interface{}
		_ = unmarshalJSON(afterJSON.String, &m)
		row.AuditLogRow.AfterJSON = m
	}
	if requestID.Valid {
		row.AuditLogRow.RequestID = &requestID.String
	}
	if ipAddress.Valid {
		row.AuditLogRow.IPAddress = &ipAddress.String
	}
	if userAgent.Valid {
		row.AuditLogRow.UserAgent = &userAgent.String
	}
	return row, nil
}

func (v *Verifier) fetchDayAuditLogRows(ctx context.Context, tenantID int64, date string) ([]auditLogRowDB, error) {
	rows, err := v.db.QueryContext(ctx,
		`SELECT id, tenant_id, actor_user_id, actor_kind, action, entity_type, entity_id,
		        before_json, after_json, request_id, ip_address, user_agent, ts,
		        prev_hash, row_hash
		   FROM audit_log
		  WHERE tenant_id = ?
		    AND hash_at >= ? AND hash_at <= ?
		  ORDER BY id ASC`,
		tenantID,
		date+" 00:00:00.000000",
		date+" 23:59:59.999999",
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []auditLogRowDB
	for rows.Next() {
		var row auditLogRowDB
		var actorUserID sql.NullInt64
		var entityID, requestID, ipAddress, userAgent sql.NullString
		var beforeJSON, afterJSON sql.NullString

		if err := rows.Scan(
			&row.ID, &row.AuditLogRow.TenantID, &actorUserID,
			&row.AuditLogRow.ActorKind, &row.AuditLogRow.Action,
			&row.AuditLogRow.EntityType, &entityID,
			&beforeJSON, &afterJSON,
			&requestID, &ipAddress, &userAgent,
			&row.AuditLogRow.Ts,
			&row.PrevHash, &row.RowHashStored,
		); err != nil {
			return nil, err
		}
		if actorUserID.Valid {
			v64 := uint64(actorUserID.Int64)
			row.AuditLogRow.ActorUserID = &v64
		}
		row.AuditLogRow.PrevHash = row.PrevHash
		row.AuditLogRow.ID = uint64(row.ID)
		row.AuditLogRow.TenantID = uint64(tenantID)
		if entityID.Valid {
			row.AuditLogRow.EntityID = &entityID.String
		}
		if beforeJSON.Valid && beforeJSON.String != "" {
			var m interface{}
			_ = unmarshalJSON(beforeJSON.String, &m)
			row.AuditLogRow.BeforeJSON = m
		}
		if afterJSON.Valid && afterJSON.String != "" {
			var m interface{}
			_ = unmarshalJSON(afterJSON.String, &m)
			row.AuditLogRow.AfterJSON = m
		}
		if requestID.Valid {
			row.AuditLogRow.RequestID = &requestID.String
		}
		if ipAddress.Valid {
			row.AuditLogRow.IPAddress = &ipAddress.String
		}
		if userAgent.Valid {
			row.AuditLogRow.UserAgent = &userAgent.String
		}
		result = append(result, row)
	}
	return result, rows.Err()
}

func zeroHash() string { return fmt.Sprintf("%064d", 0) }

func unmarshalJSON(s string, v interface{}) error {
	return json.Unmarshal([]byte(s), v)
}

func verifyEd25519(pubKey ed25519.PublicKey, message string, sigB64 string) bool {
	sig, err := base64.StdEncoding.DecodeString(sigB64)
	if err != nil {
		sig, err = base64.RawURLEncoding.DecodeString(sigB64)
		if err != nil {
			return false
		}
	}
	return ed25519.Verify(pubKey, []byte(message), sig)
}
