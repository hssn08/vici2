package janitor

import "context"

// sweepOrphanLocks delegates to picker.Janitor and originate.Service
// to clean up orphaned in_flight HASH entries and originate_audit rows.
// E06 PLAN §5.
func (j *Janitor) sweepOrphanLocks(ctx context.Context) (int, error) {
	var n1, n2 int
	var err1, err2 error

	if j.cfg.PickerJanitor != nil {
		n1, err1 = j.cfg.PickerJanitor.SweepOrphans(ctx)
		if err1 != nil {
			j.log.Error("janitor: picker orphans sweep", "err", err1)
		}
	}

	if j.cfg.OriginateJan != nil {
		n2, err2 = j.cfg.OriginateJan.SweepOrphans(ctx)
		if err2 != nil {
			j.log.Error("janitor: originate orphans sweep", "err", err2)
		}
	}

	total := n1 + n2
	if total > 0 {
		j.cfg.Metrics.OrphanLocksCleared.Add(float64(total))
	}

	return total, joinErrs(err1, err2)
}
