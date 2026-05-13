package recording

import (
	"fmt"
	"path/filepath"
	"time"
)

// ComputePath returns the canonical on-disk path for a call recording.
//
// Path scheme (R01 PLAN §3, F03 PLAN §14.2):
//
//	${recordingsDir}/${tenantID}/${YYYY}/${MM}/${DD}/${campaignID}_${leadID}_${callUUID}.wav
//
// Example:
//
//	/var/lib/freeswitch/recordings/1/2026/05/06/SOLAR_Q2_4287_8a3e1c4f-0b91-46e2-9b53-9d2e1b1f3a4e.wav
//
// Notes:
//   - ${start_epoch} is explicitly NOT included (R01 PLAN §3.1 — dropped).
//   - ${callUUID} provides global uniqueness; epoch adds no information.
//   - recordingsDir should be the mount-point from vars.xml ($${recordings_dir}).
//   - startedAt drives the YYYY/MM/DD directory split.
func ComputePath(recordingsDir string, tenantID int64, campaignID string, leadID int64, callUUID string, startedAt time.Time) string {
	date := startedAt.UTC()
	filename := fmt.Sprintf("%s_%d_%s.wav", campaignID, leadID, callUUID)
	return filepath.Join(
		recordingsDir,
		fmt.Sprintf("%d", tenantID),
		date.Format("2006"),
		date.Format("01"),
		date.Format("02"),
		filename,
	)
}
