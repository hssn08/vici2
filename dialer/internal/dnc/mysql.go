package dnc

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

// dncRow holds a minimal result row from the confirmation query.
type dncRow struct {
	source Source
}

// confirmMySQL runs the MySQL confirmation query for Bloom-positive sources.
// Returns the confirmed DNC sources.
func confirmMySQL(
	ctx context.Context,
	db *sql.DB,
	phone string,
	tenantID int64,
	campaignID string,
	leadState string,
	positiveSources []Source,
) ([]Source, error) {
	if len(positiveSources) == 0 {
		return nil, nil
	}

	if campaignID == "" {
		campaignID = "__GLOBAL__"
	}
	if leadState == "" {
		leadState = "__"
	}

	// Build source IN list
	placeholders := make([]string, len(positiveSources))
	args := make([]interface{}, 0, len(positiveSources)+6)
	for i, s := range positiveSources {
		placeholders[i] = "?"
		args = append(args, string(s))
	}
	sourceIn := strings.Join(placeholders, ",")

	// Args: phone, tenantID, sourceList..., tenantID, campaignID, leadState
	args = append([]interface{}{phone, tenantID}, args...)
	args = append(args, tenantID, campaignID, leadState)

	q := fmt.Sprintf(`
SELECT source FROM dnc
WHERE phone_e164 = ?
  AND tenant_id IN (?, 0)
  AND source IN (%s)
  AND (
        source = 'federal'
     OR source = 'litigator'
     OR (source = 'internal' AND tenant_id = ?
           AND campaign_id IN ('__GLOBAL__', ?))
     OR (source = 'state' AND tenant_id = 0
           AND state IN (?, '__'))
  )
  AND (expires_at IS NULL OR expires_at > NOW())
LIMIT 4`, sourceIn)

	rows, err := db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	seen := map[Source]bool{}
	var confirmed []Source
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			return nil, err
		}
		src := Source(s)
		if !seen[src] {
			seen[src] = true
			confirmed = append(confirmed, src)
		}
	}
	return confirmed, rows.Err()
}
