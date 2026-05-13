package tz

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"time"

	"github.com/redis/go-redis/v9"
)

// OverrideRow represents a phone_codes_overrides entry.
type OverrideRow struct {
	AreaCode    string    `json:"area_code"`
	ExchangeCode string   `json:"exchange_code"`
	TzIANA      string    `json:"tz_iana"`
	Reason      string    `json:"reason"`
	CreatedAt   time.Time `json:"created_at"`
}

// ListOverrides returns all phone_codes_overrides rows.
func ListOverrides(ctx context.Context, db *sql.DB) ([]OverrideRow, error) {
	rows, err := db.QueryContext(ctx,
		`SELECT area_code, exchange_code, tz_iana, reason, created_at
		 FROM phone_codes_overrides ORDER BY area_code, exchange_code`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []OverrideRow
	for rows.Next() {
		var r OverrideRow
		if err := rows.Scan(&r.AreaCode, &r.ExchangeCode, &r.TzIANA, &r.Reason, &r.CreatedAt); err != nil {
			return nil, err
		}
		result = append(result, r)
	}
	return result, rows.Err()
}

// UpsertOverride inserts or updates a phone_codes_overrides row and publishes
// a pubsub invalidation event. createdByUserID is the admin user's ID.
func UpsertOverride(ctx context.Context, db *sql.DB, vk *redis.Client,
	npa, nxx, tzIANA, reason string, createdByUserID int64) error {

	// Validate IANA
	if _, ok := loadLocation(tzIANA); !ok {
		return fmt.Errorf("invalid IANA timezone: %q", tzIANA)
	}

	_, err := db.ExecContext(ctx,
		`INSERT INTO phone_codes_overrides
		   (area_code, exchange_code, tz_iana, reason, created_by_user_id)
		 VALUES (?, ?, ?, ?, ?)
		 ON DUPLICATE KEY UPDATE
		   tz_iana = VALUES(tz_iana),
		   reason = VALUES(reason),
		   created_by_user_id = VALUES(created_by_user_id)`,
		npa, nxx, tzIANA, reason, createdByUserID)
	if err != nil {
		return fmt.Errorf("upsert override: %w", err)
	}

	if vk != nil {
		if err := PublishInvalidate(ctx, vk, npa, nxx); err != nil {
			slog.Warn("tz: pubsub publish failed after override upsert", "err", err)
		}
	}
	return nil
}

// DeleteOverride removes a phone_codes_overrides row and publishes invalidation.
func DeleteOverride(ctx context.Context, db *sql.DB, vk *redis.Client, npa, nxx string) error {
	res, err := db.ExecContext(ctx,
		`DELETE FROM phone_codes_overrides WHERE area_code = ? AND exchange_code = ?`,
		npa, nxx)
	if err != nil {
		return fmt.Errorf("delete override: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("override not found: %s/%s", npa, nxx)
	}

	if vk != nil {
		if err := PublishInvalidate(ctx, vk, npa, nxx); err != nil {
			slog.Warn("tz: pubsub publish failed after override delete", "err", err)
		}
	}
	return nil
}

// LookupDebug performs an ad-hoc resolver lookup for operator debugging.
// This uses the resolver directly — not a Valkey HASH lookup on the hot path.
type LookupDebugResult struct {
	PhoneE164    string    `json:"phone_e164"`
	NPA          string    `json:"npa"`
	NXX          string    `json:"nxx"`
	IANA         string    `json:"iana"`
	Confidence   string    `json:"confidence"`
	Source       string    `json:"source"`
	NumberType   string    `json:"number_type"`
	FromOverride bool      `json:"from_override"`
	LookupAt     time.Time `json:"lookup_at"`
}

// DebugLookup resolves a phone number for admin/operator debugging.
func (r *Resolver) DebugLookup(ctx context.Context, req ResolveRequest) (LookupDebugResult, error) {
	res, err := r.Resolve(ctx, req)
	if err != nil {
		return LookupDebugResult{}, err
	}
	fromOverride := false
	if res.Confidence == ConfNXX {
		// Check if override map has this NXX
		p, _ := parseE164(req.PhoneE164)
		ov := r.overrideCache.Load().(*phoneMap)
		_, fromOverride = (*ov)[p.Key]
	}
	return LookupDebugResult{
		PhoneE164:    req.PhoneE164,
		NPA:          res.NPA,
		NXX:          res.NXX,
		IANA:         res.IANA,
		Confidence:   string(res.Confidence),
		Source:       res.Source,
		NumberType:   numberTypeName(res.NumberType),
		FromOverride: fromOverride,
		LookupAt:     time.Now().UTC(),
	}, nil
}

func numberTypeName(nt NumberType) string {
	switch nt {
	case NumberTypeFixedLine:
		return "FIXED_LINE"
	case NumberTypeMobile:
		return "MOBILE"
	case NumberTypeFixedOrMobile:
		return "FIXED_OR_MOBILE"
	case NumberTypeTollFree:
		return "TOLL_FREE"
	case NumberTypePremiumRate:
		return "PREMIUM_RATE"
	case NumberTypeVoip:
		return "VOIP"
	default:
		return "UNKNOWN"
	}
}
