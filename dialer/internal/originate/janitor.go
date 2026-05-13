package originate

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

// SweepOrphans reaps originate_audit rows that have outcome='OTHER' and
// originated_at < now - 5 minutes. These rows are left by T04 crashes or
// T01 BACKGROUND_JOB timeouts that consumed the context before the UPDATE.
//
// Called by E06 every 60s. Returns the number of rows updated to JOB_ORPHANED.
//
// T04 PLAN §6.5.
func (s *Service) SweepOrphans(ctx context.Context) (int, error) {
	if s.db == nil {
		return 0, nil
	}
	return sweepOrphans(ctx, s.db)
}

// sweepOrphans is the underlying DB sweep (exported for E06 without a Service).
func sweepOrphans(ctx context.Context, db *sql.DB) (int, error) {
	now := time.Now().UTC()
	cutoff := now.Add(-5 * time.Minute)
	floor := now.Add(-35 * 24 * time.Hour) // bounded to active + previous partition

	const q = `
UPDATE originate_audit
   SET outcome = 'JOB_ORPHANED',
       outcome_at = ?,
       error_message = 'reaped_by_janitor'
 WHERE outcome = 'OTHER'
   AND originated_at < ?
   AND originated_at >= ?
   AND outcome_at IS NULL`

	res, err := db.ExecContext(ctx, q, now, cutoff, floor)
	if err != nil {
		return 0, fmt.Errorf("originate: sweepOrphans: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("originate: sweepOrphans: RowsAffected: %w", err)
	}
	return int(n), nil
}
