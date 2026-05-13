package audit

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"
)

// sep is the canonical field separator: ASCII Unit Separator 0x1F.
const sep = "\x1f"

// nullSentinel is the two-char literal used for NULL values (MySQL LOAD DATA
// convention). Distinct from the empty string.
const nullSentinel = `\N`

// lpad20 formats a uint64 as a 20-char zero-padded decimal string.
// This ensures the byte-length of numeric fields is stable regardless of
// magnitude, matching MySQL's LPAD(CAST(col AS CHAR), 20, '0').
func lpad20(n uint64) string {
	return fmt.Sprintf("%020d", n)
}

// nullOrStr returns the two-char literal \N for nil pointers; otherwise the
// dereferenced string value.
func nullOrStr(v *string) string {
	if v == nil {
		return nullSentinel
	}
	return *v
}

// nullOrUint returns \N for nil; otherwise the string representation of *v.
func nullOrUint(v *uint64) string {
	if v == nil {
		return nullSentinel
	}
	return fmt.Sprintf("%d", *v)
}

// isoMicros formats a time.Time as ISO 8601 with microseconds and literal Z,
// matching MySQL's DATE_FORMAT(col, '%Y-%m-%dT%H:%i:%s.%fZ').
// The time MUST already be in UTC (enforced by the caller).
func isoMicros(t time.Time) string {
	t = t.UTC()
	return fmt.Sprintf("%04d-%02d-%02dT%02d:%02d:%02d.%06dZ",
		t.Year(), t.Month(), t.Day(),
		t.Hour(), t.Minute(), t.Second(),
		t.Nanosecond()/1000,
	)
}

// nullOrDate formats a nullable time as \N or isoMicros.
func nullOrDate(t *time.Time) string {
	if t == nil {
		return nullSentinel
	}
	return isoMicros(*t)
}

// jcsJSON encodes a value to RFC 8785 canonical JSON (sorted keys, no
// whitespace). Returns \N for nil input.
//
// This matches MySQL's JSON_EXTRACT(col, '$') canonical output for our subset
// of JSON values (no nested arrays of objects with mixed key types).
//
// Limitation: this implementation sorts object keys lexicographically via
// encoding/json's standard sorted-key output. The standard library DOES sort
// object keys in the same order as JCS for the Unicode subset we use (ASCII
// printable + common Latin). Golden fixture tests catch any divergence.
func jcsJSON(v interface{}) string {
	if v == nil {
		return nullSentinel
	}
	b, err := marshalJCS(v)
	if err != nil {
		return nullSentinel
	}
	return string(b)
}

// marshalJCS produces RFC 8785-compliant JSON with sorted object keys.
// For maps, it sorts keys before encoding. For other types, uses
// encoding/json which already produces valid JSON.
func marshalJCS(v interface{}) ([]byte, error) {
	switch val := v.(type) {
	case map[string]interface{}:
		return marshalJCSObject(val)
	case []interface{}:
		return marshalJCSArray(val)
	default:
		// For primitives and struct types, use standard encoding
		return json.Marshal(val)
	}
}

func marshalJCSObject(m map[string]interface{}) ([]byte, error) {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	var buf strings.Builder
	buf.WriteByte('{')
	for i, k := range keys {
		if i > 0 {
			buf.WriteByte(',')
		}
		keyBytes, err := json.Marshal(k)
		if err != nil {
			return nil, err
		}
		buf.Write(keyBytes)
		buf.WriteByte(':')
		valBytes, err := marshalJCS(m[k])
		if err != nil {
			return nil, err
		}
		buf.Write(valBytes)
	}
	buf.WriteByte('}')
	return []byte(buf.String()), nil
}

func marshalJCSArray(arr []interface{}) ([]byte, error) {
	var buf strings.Builder
	buf.WriteByte('[')
	for i, elem := range arr {
		if i > 0 {
			buf.WriteByte(',')
		}
		b, err := marshalJCS(elem)
		if err != nil {
			return nil, err
		}
		buf.Write(b)
	}
	buf.WriteByte(']')
	return []byte(buf.String()), nil
}

// ---------------------------------------------------------------------------
// Per-table canonical structs
// ---------------------------------------------------------------------------

// AuditLogRow holds the fields needed to build the canonical string for a
// single audit_log row. Matches PLAN §3.5.
type AuditLogRow struct {
	PrevHash    string
	TenantID    uint64
	ID          uint64
	Ts          time.Time
	ActorUserID *uint64
	ActorKind   string
	Action      string
	EntityType  string
	EntityID    *string
	BeforeJSON  interface{}
	AfterJSON   interface{}
	RequestID   *string
	IPAddress   *string
	UserAgent   *string
}

// Canonicalize builds the canonical byte-string for an audit_log row.
// The output is fed to SHA-256 to produce row_hash.
func (r AuditLogRow) Canonicalize() string {
	actorUID := nullSentinel
	if r.ActorUserID != nil {
		actorUID = fmt.Sprintf("%d", *r.ActorUserID)
	}
	fields := []string{
		r.PrevHash,
		lpad20(r.TenantID),
		"audit_log",
		lpad20(r.ID),
		isoMicros(r.Ts),
		actorUID,
		r.ActorKind,
		r.Action,
		r.EntityType,
		nullOrStr(r.EntityID),
		jcsJSON(r.BeforeJSON),
		jcsJSON(r.AfterJSON),
		nullOrStr(r.RequestID),
		nullOrStr(r.IPAddress),
		nullOrStr(r.UserAgent),
	}
	return strings.Join(fields, sep)
}

// Hash computes SHA-256 of the canonical string and returns 64-char lowercase hex.
func (r AuditLogRow) Hash() string {
	return sha256hex(r.Canonicalize())
}

// CallWindowAuditRow holds fields for a call_window_audit row.
type CallWindowAuditRow struct {
	PrevHash         string
	TenantID         uint64
	ID               uint64
	CreatedAt        time.Time
	LeadID           uint64
	PhoneE164        string
	CampaignID       string
	Decision         string
	Reason           string
	TzIana           *string
	TzConfidence     *string
	StateCode        *string
	Zip              *string
	PartyLocal       *time.Time
	PartyDow         *int
	EffectiveOpenMin *int
	EffectiveCloseMin *int
	RuleApplied      *string
	EnforcementPoint string
	NextOpenAt       *time.Time
	CallUUID         *string
}

// Canonicalize builds the canonical byte-string for a call_window_audit row.
func (r CallWindowAuditRow) Canonicalize() string {
	partyDow := nullSentinel
	if r.PartyDow != nil {
		partyDow = fmt.Sprintf("%d", *r.PartyDow)
	}
	effOpen := nullSentinel
	if r.EffectiveOpenMin != nil {
		effOpen = fmt.Sprintf("%d", *r.EffectiveOpenMin)
	}
	effClose := nullSentinel
	if r.EffectiveCloseMin != nil {
		effClose = fmt.Sprintf("%d", *r.EffectiveCloseMin)
	}
	fields := []string{
		r.PrevHash,
		lpad20(r.TenantID),
		"call_window_audit",
		lpad20(r.ID),
		isoMicros(r.CreatedAt),
		fmt.Sprintf("%d", r.LeadID),
		r.PhoneE164,
		r.CampaignID,
		r.Decision,
		r.Reason,
		nullOrStr(r.TzIana),
		nullOrStr(r.TzConfidence),
		nullOrStr(r.StateCode),
		nullOrStr(r.Zip),
		nullOrDate(r.PartyLocal),
		partyDow,
		effOpen,
		effClose,
		nullOrStr(r.RuleApplied),
		r.EnforcementPoint,
		nullOrDate(r.NextOpenAt),
		nullOrStr(r.CallUUID),
	}
	return strings.Join(fields, sep)
}

// Hash returns SHA-256 of the canonical string as 64-char lowercase hex.
func (r CallWindowAuditRow) Hash() string {
	return sha256hex(r.Canonicalize())
}

// ConsentLogRow holds fields for a consent_log row.
type ConsentLogRow struct {
	PrevHash       string
	TenantID       uint64
	ID             uint64
	CallUUID       string
	LeadID         uint64
	PhoneE164      string
	PromptID       string
	DtmfResponse   *string
	Outcome        string
	Language       string
	PromptPlayedAt time.Time
}

// Canonicalize builds the canonical byte-string for a consent_log row.
func (r ConsentLogRow) Canonicalize() string {
	fields := []string{
		r.PrevHash,
		lpad20(r.TenantID),
		"consent_log",
		lpad20(r.ID),
		r.CallUUID,
		fmt.Sprintf("%d", r.LeadID),
		r.PhoneE164,
		r.PromptID,
		nullOrStr(r.DtmfResponse),
		r.Outcome,
		r.Language,
		isoMicros(r.PromptPlayedAt),
	}
	return strings.Join(fields, sep)
}

// Hash returns SHA-256 as 64-char lowercase hex.
func (r ConsentLogRow) Hash() string {
	return sha256hex(r.Canonicalize())
}

// DncSyncLogRow holds fields for a dnc_sync_log row.
type DncSyncLogRow struct {
	PrevHash    string
	ID          uint64
	Source      string
	Kind        string
	FileHash    *string
	Added       int
	Removed     int
	StartedAt   time.Time
	CompletedAt *time.Time
}

// Canonicalize builds the canonical byte-string for a dnc_sync_log row.
// dnc_sync_log is a global table; tenant sentinel = 1.
func (r DncSyncLogRow) Canonicalize() string {
	fields := []string{
		r.PrevHash,
		lpad20(1), // global table sentinel
		"dnc_sync_log",
		lpad20(r.ID),
		r.Source,
		r.Kind,
		nullOrStr(r.FileHash),
		fmt.Sprintf("%d", r.Added),
		fmt.Sprintf("%d", r.Removed),
		isoMicros(r.StartedAt),
		nullOrDate(r.CompletedAt),
	}
	return strings.Join(fields, sep)
}

// Hash returns SHA-256 as 64-char lowercase hex.
func (r DncSyncLogRow) Hash() string {
	return sha256hex(r.Canonicalize())
}

// sha256hex returns the SHA-256 digest of s as 64-char lowercase hex.
func sha256hex(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}
