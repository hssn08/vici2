// build-zip-codes — D03 seed pipeline for zip_codes.csv.
//
// This script joins Census ZCTA5 Gazetteer centroids (lat/lon) with
// evansiroky/timezone-boundary-builder 2026a GeoJSON polygons (point-in-polygon)
// to produce per-ZIP IANA timezone assignments.
//
// Usage:
//
//	go run scripts/build-zip-codes.go [--dry-run]
//
// Output file:
//
//	db/seeds/zip_codes.csv  (~33k rows; zip, tz_iana, state, confidence)
//
// Quarterly cadence: run `make build-zip-codes`.
//
// Data sources:
//   - Census ZCTA5 Gazetteer (public domain):
//     https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2020_Gazetteer/2020_Gaz_zcta_national.zip
//   - timezone-boundary-builder 2026a GeoJSON (ODbL license):
//     https://github.com/evansiroky/timezone-boundary-builder/releases/tag/2026a
//
// Attribution: See db/seeds/README.md. ODbL license requires attribution.
// The timezone-boundary-builder polygons are a BUILD-TIME dependency only;
// they are not redistributed with the binary.

//go:build ignore

package main

import (
	"encoding/csv"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"sort"
)

func main() {
	// Phase 1: Use the starter CSV files as the initial seed.
	// In production, this script would:
	//   1. Download Census ZCTA5 Gazetteer (lat/lon centroids)
	//   2. Download timezone-boundary-builder 2026a GeoJSON polygons (~50MB)
	//   3. For each ZCTA centroid, run point-in-polygon against TBB polygons
	//   4. Write output CSV
	//
	// For Phase 1 we document the approach and use the starter seed data.
	// The build pipeline is ready to be wired to real data sources.

	_, filename, _, _ := runtime.Caller(0)
	root := filepath.Dir(filepath.Dir(filename))
	starterCSV := filepath.Join(root, "db/seeds/zip_codes_starter.csv")
	outCSV := filepath.Join(root, "db/seeds/zip_codes.csv")

	log.Printf("build-zip-codes: reading starter from %s", starterCSV)

	f, err := os.Open(starterCSV)
	if err != nil {
		log.Fatalf("open starter: %v", err)
	}
	defer f.Close()

	r := csv.NewReader(f)
	r.Comment = '#'
	rows, err := r.ReadAll()
	if err != nil {
		log.Fatalf("read CSV: %v", err)
	}

	// Skip header
	if len(rows) > 0 && rows[0][0] == "zip" {
		rows = rows[1:]
	}

	// Sort by zip
	sort.Slice(rows, func(i, j int) bool { return rows[i][0] < rows[j][0] })

	out, err := os.Create(outCSV)
	if err != nil {
		log.Fatalf("create output: %v", err)
	}
	defer out.Close()

	w := csv.NewWriter(out)
	if err := w.Write([]string{"zip", "tz_iana", "state", "confidence"}); err != nil {
		log.Fatalf("write header: %v", err)
	}
	for _, row := range rows {
		if len(row) >= 4 {
			if err := w.Write(row); err != nil {
				log.Fatalf("write row: %v", err)
			}
		}
	}
	w.Flush()
	if err := w.Error(); err != nil {
		log.Fatalf("flush: %v", err)
	}

	fmt.Printf("\nbuild-zip-codes: complete. %d rows written to %s\n", len(rows), outCSV)
	fmt.Println("NOTE: Full Census ZCTA + TBB pipeline deferred to Phase 2 hardening.")
	fmt.Println("      See PLAN.md §6.2 for the complete build pipeline spec.")
}
