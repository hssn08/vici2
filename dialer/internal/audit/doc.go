// Package audit provides a Go mirror of the C03 audit immutability layer.
//
// Writer: inserts rows into the five immutable audit tables; the BEFORE INSERT
// trigger in MySQL handles prev_hash / row_hash / hash_at population.
//
// Canonicalize: re-implements the canonical byte-string matching the MySQL
// trigger and the TS canonicalize.ts module. All three MUST produce the same
// output for every fixture in test/fixtures/canonicalization/.
//
// Verifier: read-only chain + Merkle + signature verification.
// Uses the vici2_audit_reader MySQL user (SELECT-only).
//
// Phase 1: Writer connects via the same *sql.DB as the dialer; no separate
// microservice or gRPC hop.
package audit
