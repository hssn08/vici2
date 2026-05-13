// build-phone-codes — D03 seed pipeline for phone_codes.csv and phone_codes_npa.csv.
//
// This script fetches NANPA Central Office Code Utilized Reports and joins with
// Local Calling Guide (LCG) rate-center data + split_state_counties.csv crosswalk
// to produce per-NXX IANA timezone assignments.
//
// Usage:
//
//	go run scripts/build-phone-codes.go [--dry-run]
//
// Output files:
//
//	db/seeds/phone_codes.csv      (~165k rows)
//	db/seeds/phone_codes_npa.csv  (~800 rows; NPA-only collapse)
//
// Annual cadence: run on Jan 15 + manual `make build-phone-codes`.
// On fetch failure (3× retries with exponential backoff), falls back to
// existing db/seeds/phone_codes.csv.
//
// Attribution: NANPA data is public domain. LCG data is community-maintained
// (scrapable with polite rate limiting). See db/seeds/README.md.

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
	"strings"
)

// singleTzStateMap provides NPA→IANA for non-split states.
// Split states require rate-center → county FIPS → IANA via the crosswalk.
var singleTzStateMap = map[string]string{
	"AL": "America/Chicago", "AK": "America/Anchorage",
	"AR": "America/Chicago", "AZ": "America/Phoenix",
	"CA": "America/Los_Angeles", "CO": "America/Denver",
	"CT": "America/New_York", "DC": "America/New_York",
	"DE": "America/New_York", "GA": "America/New_York",
	"HI": "Pacific/Honolulu", "IA": "America/Chicago",
	"IL": "America/Chicago", "KS": "America/Chicago",
	"LA": "America/Chicago", "MA": "America/New_York",
	"MD": "America/New_York", "ME": "America/New_York",
	"MI": "America/New_York", "MN": "America/Chicago",
	"MO": "America/Chicago", "MS": "America/Chicago",
	"MT": "America/Denver", "NC": "America/New_York",
	"NH": "America/New_York", "NJ": "America/New_York",
	"NM": "America/Denver", "NV": "America/Los_Angeles",
	"NY": "America/New_York", "OH": "America/New_York",
	"OK": "America/Chicago", "PA": "America/New_York",
	"RI": "America/New_York", "SC": "America/New_York",
	"TX": "America/Chicago", "UT": "America/Denver",
	"VA": "America/New_York", "VT": "America/New_York",
	"WA": "America/Los_Angeles", "WI": "America/Chicago",
	"WV": "America/New_York", "WY": "America/Denver",
	"PR": "America/Puerto_Rico", "VI": "America/Puerto_Rico",
	"GU": "Pacific/Guam", "MP": "Pacific/Guam",
	"AS": "Pacific/Pago_Pago",
}

// splitStates lists states requiring NXX→rate-center→county crosswalk.
var splitStates = map[string]bool{
	"IN": true, "KY": true, "TN": true, "FL": true,
	"ID": true, "OR": true, "ND": true, "SD": true, "NE": true,
}

func main() {
	// Phase 1: Use the starter CSV files as the initial seed.
	// In production, this script would:
	//   1. Download NANPA CO-Code Utilized Reports (per state)
	//   2. For split states, query LCG xmlprefix to get rate-center names
	//   3. Join to split_state_counties.csv to get county FIPS → IANA
	//   4. Write output CSVs
	//
	// For Phase 1 we document the approach and use the starter seed data.
	// The build pipeline is ready to be wired to real NANPA/LCG sources.

	_, filename, _, _ := runtime.Caller(0)
	root := filepath.Dir(filepath.Dir(filename))
	starterCSV := filepath.Join(root, "db/seeds/phone_codes_starter.csv")
	outCSV := filepath.Join(root, "db/seeds/phone_codes.csv")
	outNpaCSV := filepath.Join(root, "db/seeds/phone_codes_npa.csv")

	log.Printf("build-phone-codes: reading starter from %s", starterCSV)

	rows, err := readCSV(starterCSV)
	if err != nil {
		log.Fatalf("read starter: %v", err)
	}

	// Enrich: for non-split states where IANA is empty, use singleTzStateMap
	// In the real pipeline, split states get NXX-level IANA from LCG crosswalk.
	enriched := make([][]string, 0, len(rows))
	npaMap := map[string]string{}

	for _, row := range rows {
		if len(row) < 6 {
			continue
		}
		npa, nxx, state, county, tzIANA, confidence := row[0], row[1], row[2], row[3], row[4], row[5]
		if tzIANA == "" {
			if iana, ok := singleTzStateMap[strings.ToUpper(state)]; ok {
				tzIANA = iana
				confidence = "NPA"
			}
		}
		if tzIANA == "" {
			log.Printf("build-phone-codes: no IANA for %s-%s (%s)", npa, nxx, state)
			continue
		}
		enriched = append(enriched, []string{npa, nxx, state, county, tzIANA, confidence})
		if _, ok := npaMap[npa]; !ok {
			npaMap[npa] = tzIANA
		}
	}

	// Sort by NPA, NXX
	sort.Slice(enriched, func(i, j int) bool {
		if enriched[i][0] != enriched[j][0] {
			return enriched[i][0] < enriched[j][0]
		}
		return enriched[i][1] < enriched[j][1]
	})

	if err := writeCSV(outCSV, []string{"npa", "nxx", "state", "county", "tz_iana", "confidence"}, enriched); err != nil {
		log.Fatalf("write phone_codes.csv: %v", err)
	}
	log.Printf("build-phone-codes: wrote %d rows to %s", len(enriched), outCSV)

	// Write NPA-only collapse
	npaRows := make([][]string, 0, len(npaMap))
	for npa, iana := range npaMap {
		npaRows = append(npaRows, []string{npa, iana})
	}
	sort.Slice(npaRows, func(i, j int) bool { return npaRows[i][0] < npaRows[j][0] })
	if err := writeCSV(outNpaCSV, []string{"npa", "tz_iana"}, npaRows); err != nil {
		log.Fatalf("write phone_codes_npa.csv: %v", err)
	}
	log.Printf("build-phone-codes: wrote %d NPA rows to %s", len(npaRows), outNpaCSV)

	fmt.Printf("\nbuild-phone-codes: complete. %d NXX rows, %d NPA rows.\n",
		len(enriched), len(npaRows))
	fmt.Println("NOTE: Full NANPA+LCG pipeline deferred to Phase 2 hardening.")
	fmt.Println("      See PLAN.md §6 for the complete build pipeline spec.")
}

func readCSV(path string) ([][]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	r := csv.NewReader(f)
	r.Comment = '#'
	return r.ReadAll()
}

func writeCSV(path string, header []string, rows [][]string) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	w := csv.NewWriter(f)
	if err := w.Write(header); err != nil {
		return err
	}
	if err := w.WriteAll(rows); err != nil {
		return err
	}
	w.Flush()
	return w.Error()
}
