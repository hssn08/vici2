// Command build-consent-rules generates dialer/internal/compliance/consent/rules_gen.go
// from db/seeds/consent_rules.csv.
//
// Usage:
//
//	go run ./scripts/build-consent-rules/ [--csv <path>] [--out <path>]
//
// Run via:
//
//	go generate ./dialer/internal/compliance/consent/...
//
// CI gate: after running the generator, CI runs `git diff --exit-code` to
// ensure the generated file is committed and up to date.
package main

import (
	"bufio"
	"bytes"
	"encoding/csv"
	"flag"
	"fmt"
	"go/format"
	"io"
	"os"
	"strings"
	"time"
)

// validStates is the set of valid 2-letter US postal codes (50 states + DC + 5 territories).
var validStates = map[string]bool{
	"AL": true, "AK": true, "AZ": true, "AR": true, "CA": true,
	"CO": true, "CT": true, "DE": true, "FL": true, "GA": true,
	"HI": true, "ID": true, "IL": true, "IN": true, "IA": true,
	"KS": true, "KY": true, "LA": true, "ME": true, "MD": true,
	"MA": true, "MI": true, "MN": true, "MS": true, "MO": true,
	"MT": true, "NE": true, "NV": true, "NH": true, "NJ": true,
	"NM": true, "NY": true, "NC": true, "ND": true, "OH": true,
	"OK": true, "OR": true, "PA": true, "RI": true, "SC": true,
	"SD": true, "TN": true, "TX": true, "UT": true, "VT": true,
	"VA": true, "WA": true, "WV": true, "WI": true, "WY": true,
	"DC": true, "AS": true, "GU": true, "MP": true, "PR": true, "VI": true,
}

// validModes is the set of valid minimum_mode values.
var validModes = map[string]bool{
	"ALLOW":          true,
	"PROMPT_BEEP":    true,
	"PROMPT_MESSAGE": true,
	"REQUIRE_ACTIVE": true,
	"SKIP":           true,
}

type ruleRow struct {
	State       string
	MinimumMode string
	BeepAccepted bool
	B2BExempt   bool
	Citation    string
	Comment     string
}

func main() {
	csvPath := flag.String("csv", "db/seeds/consent_rules.csv", "path to consent_rules.csv")
	outPath := flag.String("out", "dialer/internal/compliance/consent/rules_gen.go", "output Go file")
	flag.Parse()

	rows, err := parseCSV(*csvPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "consent-rulesgen: parse %s: %v\n", *csvPath, err)
		os.Exit(1)
	}

	if err := validate(rows); err != nil {
		fmt.Fprintf(os.Stderr, "consent-rulesgen: validation failed: %v\n", err)
		os.Exit(1)
	}

	src, err := generate(rows)
	if err != nil {
		fmt.Fprintf(os.Stderr, "consent-rulesgen: generate: %v\n", err)
		os.Exit(1)
	}

	formatted, err := format.Source(src)
	if err != nil {
		fmt.Fprintf(os.Stderr, "consent-rulesgen: gofmt: %v\nraw:\n%s\n", err, src)
		os.Exit(1)
	}

	if err := os.WriteFile(*outPath, formatted, 0o644); err != nil {
		fmt.Fprintf(os.Stderr, "consent-rulesgen: write %s: %v\n", *outPath, err)
		os.Exit(1)
	}
	fmt.Printf("consent-rulesgen: wrote %d rules to %s\n", len(rows), *outPath)
}

func parseCSV(path string) ([]ruleRow, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	// Strip comment lines before feeding to csv.Reader.
	var filtered bytes.Buffer
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(strings.TrimSpace(line), "#") {
			continue
		}
		filtered.WriteString(line + "\n")
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}

	r := csv.NewReader(&filtered)
	r.Comment = 0 // already stripped
	r.TrimLeadingSpace = true

	header, err := r.Read()
	if err != nil {
		return nil, fmt.Errorf("read header: %w", err)
	}
	wantHeader := []string{"state", "minimum_mode", "beep_accepted", "b2b_exempt", "citation", "comment"}
	if len(header) < len(wantHeader) {
		return nil, fmt.Errorf("header has %d columns, want %d", len(header), len(wantHeader))
	}
	for i, want := range wantHeader {
		if strings.TrimSpace(header[i]) != want {
			return nil, fmt.Errorf("header[%d] = %q, want %q", i, header[i], want)
		}
	}

	var rows []ruleRow
	for {
		rec, err := r.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		if len(rec) < 6 {
			return nil, fmt.Errorf("row has %d columns: %v", len(rec), rec)
		}
		row := ruleRow{
			State:       strings.TrimSpace(rec[0]),
			MinimumMode: strings.TrimSpace(rec[1]),
			BeepAccepted: strings.TrimSpace(rec[2]) == "true",
			B2BExempt:   strings.TrimSpace(rec[3]) == "true",
			Citation:    strings.TrimSpace(rec[4]),
			Comment:     strings.TrimSpace(rec[5]),
		}
		rows = append(rows, row)
	}
	return rows, nil
}

func validate(rows []ruleRow) error {
	seen := map[string]bool{}
	for _, r := range rows {
		if !validStates[r.State] {
			return fmt.Errorf("unknown state code %q", r.State)
		}
		if seen[r.State] {
			return fmt.Errorf("duplicate state %q", r.State)
		}
		seen[r.State] = true
		if !validModes[r.MinimumMode] {
			return fmt.Errorf("state %s: invalid minimum_mode %q", r.State, r.MinimumMode)
		}
		// Phase 1 lock: only PA may have b2b_exempt=true.
		if r.B2BExempt && r.State != "PA" {
			return fmt.Errorf("state %s: b2b_exempt=true is only valid for PA in Phase 1", r.State)
		}
	}
	return nil
}

func boolStr(b bool) string {
	if b {
		return "true"
	}
	return "false"
}

func generate(rows []ruleRow) ([]byte, error) {
	var b bytes.Buffer
	ts := time.Now().UTC().Format("2006-01-02")

	fmt.Fprintf(&b, "// Code generated by consent-rulesgen from db/seeds/consent_rules.csv; DO NOT EDIT.\n")
	fmt.Fprintf(&b, "// Source: db/seeds/consent_rules.csv\n")
	fmt.Fprintf(&b, "// Generated: %s\n\n", ts)
	fmt.Fprintf(&b, "package consent\n\n")
	fmt.Fprintf(&b, "// stateRules maps 2-letter US state codes to their recording-consent rules.\n")
	fmt.Fprintf(&b, "// States absent from this map default to ModeAllow (1-party federal floor, 18 USC §2511(2)(d)).\n")
	fmt.Fprintf(&b, "var stateRules = map[string]ConsentRule{\n")

	for _, r := range rows {
		// escape citation for Go string literal
		citation := strings.ReplaceAll(r.Citation, `"`, `\"`)
		comment := r.Comment
		if comment != "" {
			comment = " // " + comment
		}
		fmt.Fprintf(&b, "\t%q: {State: %q, MinimumMode: Mode%s, BeepAccepted: %s, B2BExempt: %s, Citation: %q},%s\n",
			r.State, r.State, modeConst(r.MinimumMode), boolStr(r.BeepAccepted), boolStr(r.B2BExempt), citation, comment)
	}

	fmt.Fprintf(&b, "}\n")
	return b.Bytes(), nil
}

// modeConst converts a mode string like "PROMPT_MESSAGE" to the Go const "PromptMessage".
func modeConst(s string) string {
	switch s {
	case "ALLOW":
		return "Allow"
	case "PROMPT_BEEP":
		return "PromptBeep"
	case "PROMPT_MESSAGE":
		return "PromptMessage"
	case "REQUIRE_ACTIVE":
		return "RequireActive"
	case "SKIP":
		return "Skip"
	default:
		return "Allow"
	}
}
