# C03 — Audit Log Immutability — PLAN

| Field | Value |
|---|---|
| Track | Compliance (cross-cutting) |
| Phase | 1 |
| Effort | 4 days |
| Owner agent type | backend-node (writer/verifier) + sre (S3/key custody) + dba (grants) |
| Status | PLAN |
| Depends-on (DONE / PLAN-stable) | F02 (`audit_log` table, partitioning, INSERT-only triggers), F05 (KMS / Ed25519 key custody), O02 (backups, S3 buckets), O05 (secrets inventory) |
| Blocks | C04 (retention rotation — must NOT break chain), N02 (webhook events read from audit_log), C01 / C02 / D05 / T04 (consumers that write audit rows through the same writer + meta-audit contract) |

> **Stakes restated.** SOC 2 CC7.2, NIST 800-53 AU-9 / AU-10, GDPR Art. 30/32, TCPA §227 class-action defense, and SOX §404 (for public-company customers) all require that the audit trail be **demonstrably tamper-evident**, not merely "WORM by checkbox." F02 already revoked `UPDATE/DELETE` on `audit_log` from `vici2_app` and ships BEFORE-UPDATE/DELETE triggers (RESEARCH §1.1–1.2). C03 is the cryptographic layer that turns that into a chain-of-custody an external auditor or plaintiff's expert can verify offline against a signed reference root in S3 Object Lock Compliance mode. The goal: an insider with `vici2_root` cannot rewrite history without leaving a forensically-visible mismatch (RESEARCH §0).

---

## 0. TL;DR — 12-bullet decision summary

1. **Hash algorithm: SHA-256.** Available natively in MySQL as `SHA2(s, 256)` (no UDF, no extension); FIPS 180-4 approved (needed for any federal customer); 128-bit collision margin is enormous overkill against the worst-case 256M-row-per-tenant horizon at 7-year retention (RESEARCH §2.5). BLAKE3 is faster but the bottleneck is row-insert (~200 µs), not hash compute (~1 µs / 1 KB). Decision is frozen for Phase 1.
2. **Per-tenant, per-table chain** (5 chains per tenant: `audit_log`, `call_window_audit`, `originate_audit`, `consent_log`, `dnc_sync_log`). RESEARCH §2.2 — tenant boundary is the load-bearing security boundary; cross-tenant chain would couple tenants under the FOR-UPDATE lock; per-tenant chain makes GDPR Art. 15/30 export self-contained.
3. **Chain construction in a `BEFORE INSERT` trigger** so no application code can forge `prev_hash` / `row_hash`. The trigger reads the prior row's `row_hash` under `SELECT … FOR UPDATE` to serialize concurrent inserts within a tenant (RESEARCH §2.3). Per-row cost ~200 µs at p99; per-tenant insert ceiling unchanged at ~135 rows/sec aggregate across the five tables (RESEARCH §2.3 / §8.1).
4. **Daily Merkle root attestation** per (tenant, table) computed at 03:30 UTC (after O02's 03:00 backup window — RESEARCH §11.3). RFC 6962-style tree (leaf prefix `0x00`, internal prefix `0x01`, last-leaf duplication for odd counts). Root + chain endpoints + row count signed with Ed25519, PUT to S3 with **Object Lock Compliance mode**, 7-year retention. Even AWS account root cannot delete or shorten retention during the lock window (RESEARCH §3.4 / §6.4).
5. **Two-key separation:** the audit signing key (`VICI2_AUDIT_SIGNING_KEY`, Ed25519) is **distinct from** the JWT signing key (F05). Phase 1: env var on the workers host. Phase 4: HashiCorp Vault Transit. Public keys published to a separate Object-Locked S3 bucket so verifier is offline-capable (RESEARCH §9).
6. **DB grants — three users:** `vici2_app` (runtime, `INSERT, SELECT` on every audit table, no UPDATE/DELETE/DDL), `vici2_audit_reader` (verifier + compliance-officer reads, `SELECT` only), `vici2_partition_admin` (C04 rotation, narrow `DROP PARTITION` only). `vici2_root` exists for emergencies but every DDL touching audit tables runs through the Makefile target `make audit-ddl` which writes an `audit.schema.modified` row + binlog marker BEFORE the DDL runs (§7 / RESEARCH §11.7).
7. **`audit_attestation` table proposed** (§9.1) — one row per published S3 object with `tenant_id, table_name, window_date, merkle_root, first_row_id, last_row_id, row_count, key_id, signed_at, s3_key, sig_b64`. Same INSERT-only grant pattern; itself part of the chain via `prev_attestation_hash`.
8. **Five tamper scenarios in the test plan** (§11.4): direct UPDATE, trigger-drop then UPDATE, partition swap, S3 attestation tampered, signing key compromise. All must be detected by `scripts/verify-audit-chain.ts` (offline, against the public key + DB read).
9. **Meta-audit:** every read of `/api/audit/*` writes a row to `audit_log` with action `audit.access.<endpoint>` (NIST 800-53 AU-9, SOC 2 CC7.2) and is itself in the chain. Cross-tenant audit reads page at SEV1 (RESEARCH §4.2 / §4.5).
10. **Public API — three TS classes + one Go pkg:** `AuditWriter` (low-latency append, Phase 1 = direct INSERT, Phase 4 = Valkey-stream batched), `AuditVerifier` (chain + Merkle + signature), `AuditReader` (filtered, paginated, RBAC-gated reads with auto-meta-audit). Go mirror is read-only — `dialer/internal/audit/writer.go` writes via the same MySQL connection (no gRPC).
11. **CI nightly verifier** runs `verify-audit-chain.ts --window 7d` and fails the run on any chain mismatch. Same script is what we hand a customer's auditor.
12. **Failure modes explicitly handled:** (a) attestation cron missed → empty-day attestation still written so absence is detectable, (b) chain break on insert (trigger error) → INSERT fails atomically; app layer treats audit-write failure as a hard error for compliance-critical actions (no silent drop), (c) S3 PUT failure → idempotent retry; same key + same bytes is safe under Object Lock, (d) signing key rotation → new `key_id` issued, both old + new public keys remain published (RESEARCH §6.5 / §9).

---

## 1. Goals + non-goals

### 1.1 Goals (in scope for this PLAN)

- **G1.** Hash-chain every immutable audit table so that any row mutation, deletion, or out-of-order insertion is detectable from a recomputation walk.
- **G2.** Publish a signed Merkle root per (tenant, table, day) to S3 Object Lock Compliance, providing a tamper-evident reference point an offline verifier can check.
- **G3.** Tighten DB grants beyond F02's current `audit_log`-only revocation: extend the trigger + REVOKE pattern to all five immutable tables; introduce the `vici2_audit_reader` and `vici2_partition_admin` users.
- **G4.** Provide a public `AuditVerifier` API (TS + Go) and standalone `scripts/verify-audit-chain.ts` so customers, auditors, and CI can verify the chain + Merkle attestations against published public keys.
- **G5.** Provide a public `AuditReader` API for compliance officers (RBAC-gated), with automatic meta-audit on every read (SOC 2 CC7.2 / NIST 800-53 AU-9).
- **G6.** Define the per-row canonicalization, the leaf/node hashing, and the attestation artifact schema precisely enough that two independent implementations of the verifier produce identical results bit-for-bit.

### 1.2 Non-goals (explicitly out of scope)

- **NG1. What gets logged.** C03 does not define event taxonomies — each writer module (F05 for auth, C01 for TCPA, C02 for consent, D05 for DNC, T04 for originate) owns its own action vocabulary. C03's `AuditWriter` accepts an opaque `(action, entity_type, before_json, after_json)` and chains the row regardless of semantic meaning.
- **NG2. Audit-log retention rotation.** C04 owns `DROP PARTITION`. C03 only requires that C04's drop be (a) preceded by an `audit.partition.dropped` row in `audit_log`, (b) executed by `vici2_partition_admin` (no other user has `DROP PARTITION` on these tables), and (c) the dropped partition's last Merkle attestation has been verified + archived in S3 (C04 PLAN documents the gate).
- **NG3. Schema migration of `consent_log` / `originate_audit` / `dnc_sync_log` / `call_window_audit`.** Tables are owned by C02 / T04 / D05 / C01 respectively and are filed against F02 as amendments. C03 adds three columns (`prev_hash`, `row_hash`, `hash_at`) and the BEFORE-INSERT trigger to each, via one consolidated migration (§12).
- **NG4. S3 bucket creation.** O02 PLAN owns the S3 buckets + IAM. C03 specifies the bucket policies and Object Lock retention configuration that O02 must apply; O02 creates them.
- **NG5. Key custody itself.** F05 owns the Ed25519 keypair generation and (Phase 4) Vault Transit integration. C03 specifies the **interface** (`signer.Sign(message) → signature`, `signer.PublicKey() → bytes`, `signer.KeyID() → string`) and the rotation procedure; F05 supplies the implementation.
- **NG6. On-chain anchoring.** RESEARCH §5 considered anchoring the Merkle root to a public blockchain (Bitcoin OP_RETURN, Ethereum, Trillian log). Phase 1 ships S3 Object Lock Compliance which is sufficient for SOC 2 / TCPA defense. Phase 4 may add an opt-in anchor for enterprise customers (RESEARCH §15 — Trillian as the reference design); tracked as open issue not Phase 1 code path.

### 1.3 What changed vs. RESEARCH

| RESEARCH item | PLAN decision |
|---|---|
| §2.5 Hash algorithm (SHA-256 vs BLAKE3) | **SHA-256** (frozen; rationale §3.1). Switch would require a coordinated re-hash; deferred indefinitely. |
| §2.2 Chain scope (per-tenant per-table vs cross-table) | **Per-tenant per-table** (5 chains/tenant). Cross-table consolidation revisited Phase 4 only if a customer asks. |
| §2.3 Concurrency primitive (FOR UPDATE vs app lock vs GET_LOCK) | **FOR UPDATE** in the trigger. App lock rejected (RESEARCH §2.3 — moves invariant out of DB). |
| §3.1 Attestation window (hourly vs daily) | **Daily** (00:00–23:59:59.999999 UTC), worker fires at 03:30 UTC (RESEARCH §11.3). Hourly is overkill for Phase 1 volumes; revisit when any tenant exceeds 1M rows/day. |
| §3.4 Object Lock mode (Governance vs Compliance) | **Compliance**, 7-year retention (matches TCPA evidence retention). Governance rejected per RESEARCH §6.4 — root override would defeat the entire control. |
| §11.4 `consent_log` as standalone table | **Yes**, new table; not overloaded onto `audit_log`. Schema lives in C02 PLAN; C03 adds chain columns + trigger. |
| §11.5 `dnc_sync_log` partitioning | **Monthly RANGE COLUMNS** for uniformity with the other four tables (cheap; ~10 partitions over 7 years for ~10k rows). |
| §11.6 Empty-day attestation | **Publish anyway** with `row_count=0` and `merkle_root=SHA-256(0x00)` so absence is provable (vs. attestation lost / missed cron). |
| §11.7 DDL on audit tables | `make audit-ddl` wrapper writes `audit.schema.modified` first; CI lint forbids raw `mysql -e "DROP TRIGGER …"` outside this wrapper. |
| §11.8 Partition drop bypass | C04 handles; precondition is "last day's attestation verified + archived." |

---

## 2. Threat model

The threat model determines which mechanisms are load-bearing. Documented inline so reviewers can challenge the assumptions before they get welded into code.

### 2.1 Actors and capabilities

| # | Actor | Capabilities | Targets |
|---|---|---|---|
| **T1** | **Application bug** | Can issue any SQL the `vici2_app` user has privileges for; cannot DDL, cannot UPDATE/DELETE audit tables | Accidentally tries `UPDATE audit_log SET …` during a refactor |
| **T2** | **Compromised app process** | T1 + can call any internal API as any user (auth bypass); still bounded by `vici2_app` grants | Read SIP creds, forge a call, then mutate audit_log to hide it |
| **T3** | **Malicious insider with DB read** | `SELECT` on every table | Exfiltrate PII; correlate cross-tenant |
| **T4** | **Malicious insider with `vici2_root`** | All MySQL privileges incl. `DROP TRIGGER`, `DELETE`, `UPDATE`, `DDL` | Drop the trigger, mutate / delete rows, restore the trigger, hope nobody notices |
| **T5** | **Malicious insider with OS root on DB host** | Can mutate the binary log, tablespace files, edit `my.cnf` to skip binlogs | Forge history at the filesystem level |
| **T6** | **Compromised AWS account (IAM user)** | S3 PUT/DELETE on buckets they have permissions for | Delete the published attestation; replace with forged root |
| **T7** | **Compromised AWS account root** | Anything in the AWS account *except* what Object Lock Compliance forbids | Same as T6 but with admin privileges |
| **T8** | **Backup tampering** | Edit a restored mysqldump / snapshot before re-import | DR restoration replays a forged trail |
| **T9** | **External auditor / plaintiff's expert (good faith)** | Read-only access via `vici2_audit_reader` + the published public keys + the published attestations | Wants to verify chain + Merkle; the system must let them succeed offline |

### 2.2 Defense matrix

| Attack | Stopped / detected by | Layer |
|---|---|---|
| T1 issues `UPDATE audit_log SET …` | `vici2_app` lacks UPDATE grant → MySQL ERROR 1142 at parse | DB grant |
| T2 forges row via INSERT | Row appears in chain at its actual position; `before_json`/`after_json` look forged but actor_user_id is real → detectable by reviewer; no mutation possible | DB grant + chain |
| T2 + T4 collusion: drop trigger, mutate, restore | (a) `DROP TRIGGER` is DDL → recorded in `audit_log` via `make audit-ddl` wrapper (or absence raises an alert when CI compares schema). (b) Row's stored `row_hash` no longer matches recomputation → chain break detected by nightly verifier. | Chain + meta-audit |
| T4 mutates and rewrites all subsequent rows to be self-consistent | Last published Merkle root no longer matches recomputed root → verifier alerts. Root is in S3 Object Lock Compliance, 7y retention. | Merkle attestation |
| T6 / T7 deletes the S3 attestation | **Object Lock Compliance prevents deletion** even by AWS root during retention. PUT-during-retention is allowed if the version is new; verifier compares against the earliest version-id for the date. | S3 Object Lock |
| T6 / T7 replaces attestation with forged root | Forged root won't verify under the published Ed25519 public key. Public key is itself in a separate Object-Locked bucket (`vici2-audit-public-keys`) with 7y+ retention. | Ed25519 signature |
| T4 + T7: drop trigger, mutate DB, forge new Merkle root, forge new signature, replace S3 object | Requires possession of the **signing key** AND ability to replace the locked object. Signing key is in env (Phase 1) or Vault (Phase 4) — separate compromise. Object Lock Compliance prevents replacement during retention. | Key custody + Object Lock |
| T5: edits tablespace files directly to flip a byte | Row's stored `row_hash` recomputes to a different value → chain break at recompute time | Chain |
| T8: forged backup restored | Same chain recompute catches it; additionally, attestation root from before backup date is published in S3 and won't match if backup is forged | Merkle attestation |
| T9: legitimate verifier needs to confirm | Public attestation + public key + DB SELECT through `vici2_audit_reader` → re-walks chain, recomputes Merkle, verifies signature; OK / TAMPERED report | Designed-in verification path |

### 2.3 Residual risk (acknowledged + accepted)

- **Concurrent T4 + T7 + signing-key compromise** is unstoppable by C03 alone. Mitigation: signing-key custody is separate (F05/Vault Phase 4), key rotation is annual + emergency-on-compromise (§10), and the public key publication history (every key_id ever used is forever in Object Lock) means a forged root signed with a leaked key is still traceable to the leak window.
- **Insider with super-admin who knows the verifier's tolerances** could in principle write a forged but self-consistent chain for a future window where no attestation has yet been published. Mitigation: attestation cron runs daily; missing attestation pages O01; the verifier's "no attestation for this day" output is itself a flagged condition, not a pass.
- **Time-of-attestation race:** between 23:59:59.999999 UTC and 03:30:00 UTC the next day there are ~3.5 hours where the day's chain exists in the DB but no S3 root has been published. An attacker with T4+T5 capability could mutate rows during this window before the worker reads them. Mitigation: O02's 03:00 snapshot captures the row state pre-attestation; the verifier compares snapshot → live → attestation as a three-way check. Documented; acceptable for Phase 1.

---

## 3. Hash chain construction

This section is the contract two independent verifiers must agree on. Any byte-level deviation breaks reproducibility.

### 3.1 Algorithm choice: SHA-256

Decision: **SHA-256 (FIPS 180-4)**.

Rationale (RESEARCH §2.5):

| Property | SHA-256 | BLAKE3 | SHA-3 |
|---|---|---|---|
| Native in MySQL 8 | **Yes** (`SHA2(s, 256)`) | No (UDF or app-layer) | Partial (`SHA2(s, 512)` only) |
| FIPS 140-3 approved | **Yes** | No | Yes |
| Required for federal customers | **Yes** | No | Yes |
| Hash compute cost / 1 KB | ~1 µs | ~0.3 µs | ~1.5 µs |
| Collision margin | 128 bits | 128 bits | 128 bits |
| Length-extension surface | Yes (irrelevant here, RESEARCH §2.6) | No | No |
| Ubiquitous library support | **Yes** | Less | Less |

The bottleneck is row insert (~200 µs), not hash compute (~1 µs); the speed advantage of BLAKE3 is irrelevant. The FIPS 140-3 requirement is the deciding factor — without it, Phase 4 federal customers are off the table.

### 3.2 Canonical hashed bytes (per row, every table)

The trigger computes:

```
row_hash = SHA-256_HEX(
  CONCAT_WS(0x1F,
    prev_hash,                          -- hex, lowercase, 64 chars (or 64×'0' if first row)
    LPAD(CAST(tenant_id  AS CHAR), 20, '0'),
    table_tag,                          -- literal constant per table, see §3.4
    LPAD(CAST(id         AS CHAR), 20, '0'),
    -- Common columns:
    DATE_FORMAT(<ts_col>, '%Y-%m-%dT%H:%i:%s.%fZ'),
    -- Per-table payload, see §3.5
    <payload_canonical>
  )
)
```

Critical decisions:

- **Separator is `0x1F` (Unit Separator)**, not `:` (RESEARCH §2.1 used `:`; PLAN tightens). Reason: `:` appears in IPv6 addresses inside the payload and creates an ambiguity if a payload field ends with a backslash. `0x1F` is reserved in ASCII for field separation and cannot appear in any of our `VARCHAR`/`JSON` columns (we enforce in a Zod schema on the writer).
- **Output is hex lowercase** (MySQL's `SHA2()` returns hex lowercase by default — no `LOWER()` needed but the verifier MUST emit lowercase).
- **Numeric columns are LPAD-zero to 20 chars** so the byte length of the canonical form is stable regardless of magnitude. Without LPAD, `tenant_id=1` and `tenant_id=10` produce different prefix lengths and a verifier in a different language might disagree on whether to zero-pad.
- **JSON columns are normalized via `JSON_EXTRACT(col, '$')`**. MySQL 8's `JSON_EXTRACT` returns a canonical form with sorted keys + no whitespace; both Go (`json.Marshal` on a `map[string]json.RawMessage` sorted) and TS (`canonicalize` from JCS, RFC 8785) must match it. Verifier ships a golden JSON-canonicalization-fixture test (§11) to keep all three implementations in lockstep.
- **`id` IS in the hash.** RESEARCH §2.2 explicitly excluded `id` ("auto-increment is an implementation detail"); PLAN reverses that decision: including `id` lets the verifier detect a row deletion (a missing `id` in the sequence is a chain break, not just a `prev_hash` mismatch on the next row). Trade-off: we cannot ever renumber rows. Accepted — partition rotation in C04 keeps `id` monotone forever (no resets).
- **Timestamps use `%Y-%m-%dT%H:%i:%s.%fZ` (ISO 8601 microsecond UTC with literal `Z`)** regardless of session timezone. Server runs `default_time_zone='+00:00'` (F02 §2.1) so this is consistent. Verifier MUST format the same way; a Z-vs-+00:00 mismatch is the most likely cross-implementation bug (§11.3 covers).

### 3.3 First-row sentinel

For the first row in a (tenant, table) chain, `prev_hash` is literally the string `'0000000000000000000000000000000000000000000000000000000000000000'` (64 ASCII zeros). The trigger sets it via `IFNULL(prior_hash, REPEAT('0', 64))`.

### 3.4 Per-table `table_tag`

A fixed-string per-table tag in the hash input prevents cross-table replay (a row hash from `audit_log` cannot be misclaimed as a row hash from `originate_audit`). The tag is the literal table name in lowercase:

| Table | `table_tag` |
|---|---|
| `audit_log` | `'audit_log'` |
| `call_window_audit` | `'call_window_audit'` |
| `originate_audit` | `'originate_audit'` |
| `consent_log` | `'consent_log'` |
| `dnc_sync_log` | `'dnc_sync_log'` |
| `audit_attestation` | `'audit_attestation'` |

`audit_attestation` is itself chained (§9.2) so an attacker rewriting attestation history is also caught.

### 3.5 Per-table payload canonicalization

| Table | Hashed payload columns (in order) |
|---|---|
| `audit_log` | `actor_user_id` (or `NULL` literal `\N`), `actor_kind`, `action`, `entity_type`, `entity_id` (or `\N`), `JSON_EXTRACT(before_json,'$')`, `JSON_EXTRACT(after_json,'$')`, `request_id` (or `\N`), `ip_address` (or `\N`), `user_agent` (or `\N`) |
| `call_window_audit` | `lead_id`, `phone_e164`, `campaign_id`, `decision`, `reason`, `tz_iana` (or `\N`), `tz_confidence` (or `\N`), `state_code` (or `\N`), `zip` (or `\N`), `DATE_FORMAT(party_local,…)`, `party_dow`, `effective_open_min`, `effective_close_min`, `rule_applied`, `enforcement_point`, `DATE_FORMAT(next_open_at,…)`, `call_uuid` (or `\N`) |
| `originate_audit` | `lead_id`, `phone_e164`, `campaign_id`, `outcome`, `reason`, `dnc_decision`, `dnc_sources_csv`, `tcpa_decision`, `call_uuid` (or `\N`), `JSON_EXTRACT(payload,'$')` |
| `consent_log` | `call_uuid`, `lead_id`, `phone_e164`, `prompt_id`, `dtmf_response` (or `\N`), `outcome`, `language`, `prompt_played_at_micros` (UNIX micro int) |
| `dnc_sync_log` | `source`, `sync_kind`, `file_hash`, `rows_added`, `rows_removed`, `started_at_micros`, `finished_at_micros` |

`NULL` is serialized as the two-character literal `\N` (same as MySQL's `LOAD DATA` convention), so `NULL` and `''` produce different hashes. This is the second most common cross-implementation bug; the golden-fixture test catches it (§11.2).

### 3.6 Trigger pseudocode (the canonical form for `audit_log`)

```sql
DELIMITER //
CREATE TRIGGER audit_log_hash_chain
BEFORE INSERT ON audit_log
FOR EACH ROW
BEGIN
    DECLARE prior_hash CHAR(64);
    SELECT row_hash
      INTO prior_hash
      FROM audit_log
     WHERE tenant_id = NEW.tenant_id
     ORDER BY id DESC
     LIMIT 1
     FOR UPDATE;
    IF prior_hash IS NULL THEN
        SET prior_hash = REPEAT('0', 64);
    END IF;
    SET NEW.prev_hash = prior_hash;
    SET NEW.hash_at   = COALESCE(NEW.created_at, NOW(6));
    SET NEW.row_hash  = SHA2(CONCAT_WS(CHAR(31),
        NEW.prev_hash,
        LPAD(CAST(NEW.tenant_id AS CHAR), 20, '0'),
        'audit_log',
        LPAD(CAST(NEW.id        AS CHAR), 20, '0'),
        DATE_FORMAT(NEW.ts, '%Y-%m-%dT%H:%i:%s.%fZ'),
        COALESCE(CAST(NEW.actor_user_id AS CHAR), '\\N'),
        NEW.actor_kind,
        NEW.action,
        NEW.entity_type,
        COALESCE(NEW.entity_id, '\\N'),
        COALESCE(JSON_EXTRACT(NEW.before_json,'$'), '\\N'),
        COALESCE(JSON_EXTRACT(NEW.after_json, '$'), '\\N'),
        COALESCE(NEW.request_id, '\\N'),
        COALESCE(NEW.ip_address, '\\N'),
        COALESCE(NEW.user_agent, '\\N')
    ), 256);
END //
DELIMITER ;
```

Five tables × one trigger pattern each = five `*_hash_chain` triggers. All ship in one migration (§12).

### 3.7 Why `id` is in the hash even though it's auto-increment

`id` is server-assigned at INSERT and the trigger fires `BEFORE INSERT`. MySQL's `BEFORE INSERT` fires with `NEW.id` already populated for auto-increment columns (verified empirically in MySQL 8.0.40; behavior pinned in F02 §2). If a future MySQL release changes this, the trigger will fail loud (`NULL` in the hash input → `SHA2(... NULL ...) = NULL`); CI integration test guards (§11.1.4).

### 3.8 What is NOT in the hash

- `created_at` / `updated_at` (set by Prisma defaults; not part of business semantics — RESEARCH §2.2). Including them would couple the chain to clock skew.
- `hash_at` (it IS set by the trigger after the hash is computed; including it would be circular).
- `prev_hash` of the *next* row (obviously — it's the value being computed).

---

## 4. Insert path & concurrency

### 4.1 Atomicity guarantee

Every audit-table INSERT runs inside the calling transaction. The `BEFORE INSERT` trigger executes in the same transaction; the `SELECT … FOR UPDATE` on the prior row holds an InnoDB record lock (and a gap lock for the range above it) until the calling transaction commits. Two concurrent INSERTs against the same `(tenant_id, table)` chain serialize on this lock — the second waits until the first commits or rolls back. On rollback, the second sees the prior committed row's `row_hash` as its `prev_hash` (RESEARCH §2.3 confirmed via Percona's documented InnoDB FOR-UPDATE-inside-trigger semantics).

### 4.2 Per-tenant insert ceiling

| Table | Sustained rate ceiling (RESEARCH §2.3) | Lock-serialized latency add |
|---|---|---|
| `audit_log` | ~100 rows/sec | ~150 µs |
| `call_window_audit` | ~5 rows/sec (sampled) | ~150 µs |
| `originate_audit` | ~100 rows/sec (full predictive) | ~150 µs |
| `consent_log` | ~30 rows/sec p99 | ~150 µs |
| `dnc_sync_log` | <1 row/min | ~150 µs |

Total ~235 inserts/sec aggregate across the five tables for one tenant. The 5 chains are independent (one FOR UPDATE lock per chain), so cross-table contention is zero. F02's `audit_log` write SLO is 1 ms p99 (F02 PLAN §1.5); chain adds ~200 µs leaving comfortable headroom.

### 4.3 Failure modes on the insert path

| Failure | Behavior | Caller's required handling |
|---|---|---|
| Trigger raises a SQL error (e.g., `JSON_EXTRACT` on malformed payload) | INSERT rolls back; row not written | Treat audit-write failure as **fatal** for the compliance-critical action; do not silently drop. `AuditWriter.append()` returns an error; caller MUST propagate. |
| Prior-row read times out (lock contention >50ms) | INSERT blocks; eventually `innodb_lock_wait_timeout=50` fires → ER_LOCK_WAIT_TIMEOUT | Caller retries with exponential backoff (max 3 tries, total 500ms). Metric `vici2_audit_insert_lock_timeout_total{table}`. |
| Two attempts race after rollback (rare) | Second wins; chain stays linear | Transparent to caller. |
| `NULL` ends up in a hashed field due to schema bug | `SHA2()` returns `NULL`; `row_hash` is `NULL`; INSERT fails because `row_hash NOT NULL` constraint | Caller sees error; CI catches in migration test. |

### 4.4 No application-level locking

We explicitly **do not** use `GET_LOCK('audit:chain:<tid>:<table>')` or any Redis lock. Rejected in RESEARCH §2.3 — moves the invariant out of the database, breaks if any future writer (a batch job, a manual `psql`-equivalent session, a future replica re-insert) bypasses the app layer. The trigger's `FOR UPDATE` is the only mechanism.

### 4.5 What the writer module does (interface)

The TS `AuditWriter.append(entry)`:

1. Validates `entry` against Zod schema (table-specific) — rejects rows with `0x1F` in any string field.
2. Begins a transaction (`prisma.$transaction`).
3. Issues the INSERT (Prisma generates parameterized SQL; trigger fires; chain extended).
4. Commits. Returns `{ id, row_hash }` to caller for optional logging.
5. On error: bubbles up. No retry inside `append` (caller decides — for `originate_audit` an error means "don't make the call"; for `audit_log`'s meta-audit-on-read it means "fail the read").

Go mirror `audit.Writer.Append(ctx, entry)` is structurally identical.

---

## 5. Merkle root attestation

### 5.1 Windowing

**Daily**, 00:00:00.000000 UTC ≤ `hash_at` < 00:00:00.000000 UTC (next day). The worker fires at **03:30 UTC** so:
- O02's 03:00 backup window has completed (snapshot of pre-attestation state).
- The day's writes are durably committed.
- The S3 PUT happens in the low-cost / low-contention window.

Per-tenant per-table = 5 attestations per tenant per day. At 100 tenants Phase 4: 500 PUTs/day. At Phase 1 (1 tenant): 5 PUTs/day. Cost: ~$0.01/year (RESEARCH §3.4).

### 5.2 Merkle tree construction (RFC 6962)

```
leaves      = sorted([row_hash for row in window], by=id ASC)
leaf_hash_i = SHA-256(0x00 || hex_to_bytes(leaves[i]))
internal    = SHA-256(0x01 || left || right)
odd_count   = duplicate last leaf (RFC 6962 §2.1)
root        = recursive Merkle reduce
```

The verifier MUST use the exact same domain separation bytes (`0x00` for leaves, `0x01` for internal nodes); a verifier that omits them produces a different root for the same data. Golden fixture in §11.5 covers.

### 5.3 Attestation artifact schema (signed)

```json
{
  "vici2_audit_attestation": {
    "version": 1,
    "tenant_id": 1,
    "table": "audit_log",
    "date": "2026-05-12",
    "row_count": 12847,
    "first_id": 51234,
    "last_id": 64080,
    "first_row_prev_hash": "<64 hex>",
    "last_row_row_hash": "<64 hex>",
    "merkle_root": "<64 hex>",
    "leaf_hash_algo": "sha256-rfc6962",
    "node_hash_algo": "sha256-rfc6962",
    "computed_at": "2026-05-13T03:30:00.000000Z",
    "key_id": "ed25519-audit-2026-1"
  },
  "signature": "<base64url Ed25519 over JCS-canonicalized vici2_audit_attestation>"
}
```

- `first_row_prev_hash` ties this day's chain start to the prior day's chain tip (daily-meta-chain).
- `last_row_row_hash` is the chain tip at the moment of attestation; matches what the next day's first row's `prev_hash` must equal.
- Empty-day attestation: `row_count=0`, `first_id=null`, `last_id=null`, `merkle_root=SHA-256(0x00)` (the 32-byte "empty leaf" sentinel), `first_row_prev_hash=last_row_row_hash` = the prior day's `last_row_row_hash` (carried forward — proves the chain didn't move).

### 5.4 Signing

- **Algorithm:** Ed25519 (RFC 8032). Small signatures (64 bytes), fast verify, no parameter choices to get wrong. F05 PLAN §9 documents the keypair generation contract.
- **Canonicalization before signing:** JSON Canonicalization Scheme (JCS, RFC 8785) on the `vici2_audit_attestation` object. Same canonicalization on verify.
- **Key ID:** opaque string `ed25519-audit-<year>-<seq>`. Each attestation embeds its `key_id` so the verifier knows which public key to use.

### 5.5 Storage — S3 layout

Bucket: `s3://vici2-audit-attestations/`. Per-attestation object key:

```
<tenant_id>/<table>/<YYYY>/<MM>/<DD>.json
```

Bucket configuration (O02 PLAN applies; C03 specifies):

- **Object Lock enabled** at bucket creation (cannot be enabled retroactively — one-shot).
- **Default retention: Compliance mode, 7 years** (`mode=COMPLIANCE`, `days=2557` for leap-year-safe).
- **Versioning: enabled** (Object Lock requires it).
- **Bucket policy:** only `vici2_audit_writer` IAM principal can `s3:PutObject`. `vici2_audit_reader` can `s3:GetObject`, `s3:ListBucket`. All other principals (including the AWS account root in normal operation) explicitly denied via SCP. No `s3:DeleteObject` grant exists anywhere.
- **Encryption:** SSE-KMS with a CMK in a separate AWS account (Phase 4) or SSE-S3 (Phase 1).
- **Replication:** cross-region async replication to a secondary region with identical Object Lock config (Phase 4 — tracked in §15).

Public key bucket (`s3://vici2-audit-public-keys/`) follows the same pattern. Keys: `<key_id>.pem`. Retention: `validity_end + 7y` so verification of last-signed-attestation stays possible after key retirement.

### 5.6 Worker (`workers/src/jobs/audit-attest/index.ts`)

Cron: `30 3 * * *` UTC.

For each tenant × each immutable table:

```
1. window_start = today_utc_midnight - 1 day
   window_end   = today_utc_midnight
2. rows = SELECT id, prev_hash, row_hash, hash_at
            FROM <table>
           WHERE tenant_id = ? AND hash_at >= ? AND hash_at < ?
           ORDER BY id ASC
3. if rows is empty:
     load prior day's attestation; carry forward last_row_row_hash; publish empty-day
4. compute_merkle_root(rows) via shared/lib/merkle.ts
5. build attestation JSON; JCS-canonicalize; Ed25519 sign
6. s3.PutObject(Key, Body=signed_json, ObjectLockMode='COMPLIANCE',
                 ObjectLockRetainUntilDate=now+7y)
7. INSERT INTO audit_attestation (...)        -- chained row §9.2
8. INSERT INTO audit_log VALUES (action='audit.attestation.published', ...)
9. metric vici2_audit_attestation_last_success_timestamp{tenant,table} = now
```

Failure handling:

- DB unreachable → exponential retry 1m, 5m, 30m; page after 3h missed.
- S3 unreachable → idempotent retry on the same key + same body. Object Lock allows additional versions of an in-lock object to be PUT (each version locked independently); verifier prefers earliest version.
- Signing key missing / fails to load → **page immediately**, no retry — compliance break.
- Empty-day branch → still must publish; if even the empty-day publish fails, page.

### 5.7 Why daily and not hourly

Hourly would give 24× faster detection (a tamper at 04:00 UTC discovered at 05:30 UTC instead of next day 03:30 UTC). For Phase 1 volumes (~100k rows/day max), daily is sufficient and matches industry practice for SOC 2 audit log attestations. Hourly switching is a code change with no schema impact (the worker just changes the WHERE-clause window); revisit when any tenant exceeds 1M rows/day or a customer requires sub-day attestation cadence (open issue §15).

---

## 6. Verification API

Three verification paths a consumer needs:

### 6.1 Single-row chain position (a)

`GET /api/audit/verify-row?tenant_id=N&table=audit_log&id=12345`

Returns:

```json
{
  "ok": true,
  "row": { ... },
  "prev_row_hash_matches": true,
  "next_row_prev_hash_matches": true,
  "row_hash_recomputed": "<64 hex>",
  "row_hash_stored":     "<64 hex>",
  "merkle_attestation_date": "2026-05-12",
  "merkle_inclusion_proof": ["<64 hex>", "<64 hex>", ...]
}
```

Server-side: re-walks the canonicalization (§3.2), recomputes `row_hash`, compares to stored. Reads neighbor rows to assert chain linkage. Reads the day's attestation from S3 to assert the row is included in that day's tree (returns the Merkle inclusion proof). If any check fails: `ok=false` plus a `failures` array.

### 6.2 Merkle inclusion proof (b)

The proof above is constructed by the server walking the tree for that day's leaves and emitting the sibling-hash-at-each-level path. The verifier consumer can independently:

```
1. compute leaf_hash = SHA-256(0x00 || row_hash_bytes)
2. for each (sibling, side) in proof: leaf_hash = SHA-256(0x01 || left || right)
3. compare to attestation.merkle_root
```

Same algorithm as Certificate Transparency; reference implementation in `shared/lib/merkle.ts` (verify path is pure-function, no DB/S3 access).

### 6.3 Attestation signature verification (c)

`GET /api/audit/attestation?tenant_id=N&table=audit_log&date=2026-05-12`

Returns the signed attestation JSON verbatim (mirrored from S3 for caller convenience; the source-of-truth is S3 itself).

The standalone `scripts/verify-audit-chain.ts` does everything (a)+(b)+(c) for a date range, offline:

```
Usage: verify-audit-chain --tenant N --table TABLE --from YYYY-MM-DD --to YYYY-MM-DD
                          [--public-keys ./vici2-public-keys/]
                          [--attestations-from s3://vici2-audit-attestations/]
                          [--db-url mysql://vici2_audit_reader@host/db]

For each day in [from, to]:
  1. Download attestation JSON from S3 (or local mirror)
  2. Verify signature with cached public key (key_id → .pem file)
  3. Query DB rows for the day; recompute Merkle root; compare to attestation
  4. Walk per-row chain: row.prev_hash == prior_row.row_hash
  5. Walk cross-day: attestation[N].first_row_prev_hash ==
                     attestation[N-1].last_row_row_hash

Output:
  OK or TAMPERED <table>/<tenant>/<id_or_date> reason=<...>
  + structured JSON for log ingestion
Exit code: 0 if all OK, 2 if any TAMPERED, 1 on infrastructure error
```

This script is what a customer's auditor runs against an export.

### 6.4 Verifier privileges

The DB user the verifier connects as is `vici2_audit_reader` (§7.1). It has `SELECT` on all five audit tables + `audit_attestation`, nothing else. The verifier never writes; the meta-audit row recording "verifier ran" is written by the `AuditReader` if the verifier hits an API endpoint, not by the verifier itself (otherwise the verifier could not run from outside the app).

### 6.5 Public API surface (TS)

```typescript
// api/src/services/audit/verifier.ts
export interface VerifierResult {
  ok: boolean;
  failures: VerifierFailure[];
  rowsChecked: number;
  daysChecked: number;
  attestationsChecked: number;
}
export interface VerifierFailure {
  kind: 'row_hash_mismatch' | 'prev_hash_mismatch' | 'missing_row'
      | 'merkle_root_mismatch' | 'signature_invalid' | 'missing_attestation';
  table: string;
  tenantId: bigint;
  id?: bigint;
  date?: string;
  expected?: string;
  actual?: string;
}
export class AuditVerifier {
  constructor(deps: { db: PrismaClient; s3: S3Client; pubKeys: PublicKeySource });
  async verifyRow(p: {tenantId: bigint; table: AuditTable; id: bigint}): Promise<VerifierResult>;
  async verifyRange(p: {tenantId: bigint; table: AuditTable; from: Date; to: Date}): Promise<VerifierResult>;
  async verifyDay(p: {tenantId: bigint; table: AuditTable; date: string}): Promise<VerifierResult>;
}
```

### 6.6 Public API surface (Go)

`dialer/internal/audit/verifier.go` exposes the same shape for the rare Go consumer (Phase 1: only `scripts/verify-audit-chain.go` if we ever port the CLI to Go for performance; Phase 1 ships the TS CLI only).

---

## 7. Grant enforcement

### 7.1 Three users + one emergency principal

| User | Phase 1 grants | Use |
|---|---|---|
| `vici2_app` | `INSERT, SELECT` on `audit_log`, `call_window_audit`, `originate_audit`, `consent_log`, `dnc_sync_log`, `audit_attestation`. No `UPDATE`, `DELETE`, `DROP`, `ALTER`, `TRUNCATE`, `INDEX`, `REFERENCES`, `CREATE`. | Runtime writes from api / workers / dialer |
| `vici2_audit_reader` | `SELECT` on all six tables above + `SELECT` on `state_holidays`, `phone_codes` (so the verifier can reproduce TZ resolution). No DML. | Verifier process, compliance officer queries |
| `vici2_partition_admin` | `ALTER TABLE ... DROP PARTITION` on the five partitioned audit tables only. No DML, no other DDL. | C04 retention rotation only |
| `vici2_root` | All privileges (the MySQL administrative user). | Emergency only; every DDL touching audit tables runs through `make audit-ddl` wrapper (§7.3) |

### 7.2 SQL migration sketch (lives in §12.4)

```sql
-- Application user: schema-wide DML on vici2.*, then explicitly revoke on audit tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON vici2.* TO 'vici2_app'@'%';
REVOKE UPDATE, DELETE, DROP, ALTER, INDEX, REFERENCES, CREATE, TRUNCATE
       ON vici2.audit_log         FROM 'vici2_app'@'%';
REVOKE UPDATE, DELETE, DROP, ALTER, INDEX, REFERENCES, CREATE, TRUNCATE
       ON vici2.call_window_audit FROM 'vici2_app'@'%';
REVOKE UPDATE, DELETE, DROP, ALTER, INDEX, REFERENCES, CREATE, TRUNCATE
       ON vici2.originate_audit   FROM 'vici2_app'@'%';
REVOKE UPDATE, DELETE, DROP, ALTER, INDEX, REFERENCES, CREATE, TRUNCATE
       ON vici2.consent_log       FROM 'vici2_app'@'%';
REVOKE UPDATE, DELETE, DROP, ALTER, INDEX, REFERENCES, CREATE, TRUNCATE
       ON vici2.dnc_sync_log      FROM 'vici2_app'@'%';
REVOKE UPDATE, DELETE, DROP, ALTER, INDEX, REFERENCES, CREATE, TRUNCATE
       ON vici2.audit_attestation FROM 'vici2_app'@'%';

CREATE USER 'vici2_audit_reader'@'%' IDENTIFIED BY <env>;
GRANT SELECT ON vici2.audit_log         TO 'vici2_audit_reader'@'%';
GRANT SELECT ON vici2.call_window_audit TO 'vici2_audit_reader'@'%';
GRANT SELECT ON vici2.originate_audit   TO 'vici2_audit_reader'@'%';
GRANT SELECT ON vici2.consent_log       TO 'vici2_audit_reader'@'%';
GRANT SELECT ON vici2.dnc_sync_log      TO 'vici2_audit_reader'@'%';
GRANT SELECT ON vici2.audit_attestation TO 'vici2_audit_reader'@'%';
GRANT SELECT ON vici2.state_holidays    TO 'vici2_audit_reader'@'%';
GRANT SELECT ON vici2.phone_codes       TO 'vici2_audit_reader'@'%';

CREATE USER 'vici2_partition_admin'@'%' IDENTIFIED BY <env>;
-- ALTER ... DROP PARTITION requires ALTER + DROP at the table level:
GRANT ALTER, DROP ON vici2.audit_log         TO 'vici2_partition_admin'@'%';
GRANT ALTER, DROP ON vici2.call_window_audit TO 'vici2_partition_admin'@'%';
GRANT ALTER, DROP ON vici2.originate_audit   TO 'vici2_partition_admin'@'%';
GRANT ALTER, DROP ON vici2.consent_log       TO 'vici2_partition_admin'@'%';
GRANT ALTER, DROP ON vici2.dnc_sync_log      TO 'vici2_partition_admin'@'%';
-- BUT: a trigger guards against accidental full-table DROP/TRUNCATE; see §7.4
```

### 7.3 `make audit-ddl` wrapper

Any change to audit-table schema, triggers, indexes, or partitions runs through:

```
make audit-ddl FILE=<path-to-sql> REASON="<short desc>"
```

The Makefile target:

1. Reads `$VICI2_DBA_USER` / `$VICI2_DBA_PASSWORD` (NOT `vici2_root`'s — a separate DBA-bound user with the same grants but its own audit trail).
2. Connects, opens a transaction.
3. INSERTs an `audit.schema.modified` row into `audit_log` with `before_json={file_path, file_sha256}`, `after_json={reason, dba_user}`.
4. Executes the SQL.
5. INSERTs an `audit.schema.modified.completed` row with timing + rows-affected.
6. COMMIT.

CI lint (`make lint`) rejects any PR that contains raw `DROP TRIGGER` / `ALTER TABLE … DROP PARTITION` against an audit table outside of `make audit-ddl`-invoked migration files.

### 7.4 ANTI-`TRUNCATE` guardrail

`TRUNCATE TABLE` does NOT fire `BEFORE DELETE` triggers (RESEARCH §1.2). Mitigation: the F02 `audit_grants` migration REVOKEs `DROP` from `vici2_app`; PLAN extends to also REVOKE `INDEX, REFERENCES, CREATE` so the union of grants on these tables for `vici2_app` is literally `{INSERT, SELECT}`. `vici2_partition_admin` has `ALTER, DROP` but no `INSERT, DELETE, UPDATE` — so it can drop partitions but cannot `TRUNCATE` (TRUNCATE requires `DROP` and at least one DML grant in MySQL 8 ≥ 8.0.16; documented).

### 7.5 What about `vici2_root`?

`vici2_root` exists. It can do anything. The mitigation is not to deny `vici2_root` — that's impossible — but to make every use traceable:
- `vici2_root` is not in any application config; it lives in the DBA's password manager.
- Logging in as `vici2_root` from anywhere except a documented admin host requires an SSH bastion + 2FA (O01 territory).
- The MySQL audit plugin (Phase 2 deferral, RESEARCH §1.4) captures the raw SQL.
- The chain + Merkle attestation catches the *effect* of any forbidden mutation even if the mutation itself is invisible to MySQL-level auditing.

### 7.6 Verifier user MUST be read-only

If `vici2_audit_reader` ever gets any non-SELECT grant, the verifier could in principle write back forged data. CI integration test (§11.1.5): connect as `vici2_audit_reader`, try `INSERT INTO audit_log VALUES (…)`, assert `ER_TABLEACCESS_DENIED_ERROR (1142)`.

---

## 8. Failure modes + recovery

| Failure | Detection | Recovery |
|---|---|---|
| Chain break: `row.prev_hash != prior.row_hash` | Nightly CI verifier; also `verifyRange` API on demand | Cannot "fix" — the break is the evidence. Investigate via: (a) binlog replay for the affected (tenant, table) within the window, (b) check `audit_log` for `audit.schema.modified` rows, (c) check pre-day snapshot from O02 backup. Document in an incident report; alert customers if their data is affected (SOC 2 CC3.4). |
| Row missing (gap in `id`) | Verifier detects `id` sequence gap | Same as above. Note: F02 PLAN §4.5 documents that `audit_log.id` is `BIGINT AUTO_INCREMENT` — MySQL does not reuse autoinc values after rollback only if `innodb_autoinc_lock_mode=0`; we run at default `=2` (consecutive). Sequence gap from rollback is normal; verifier MUST distinguish "rolled back" (no row, expected) from "deleted" (chain still expects a row at that hash position). Algorithm: a true delete shows up because the *next* row's `prev_hash` no longer matches the *prior remaining* row's `row_hash`. A rollback shows up as a gap with chain integrity preserved. |
| Missing Merkle attestation (cron didn't run) | `vici2_audit_attestation_last_success_timestamp` stale > 28h → O01 page | Re-run worker manually with `--date=YYYY-MM-DD`. Worker is idempotent; same data produces the same root + signature. If the day's window has already partially advanced beyond 7y retention boundary (impossible in Phase 1), declare audit gap and document. |
| S3 PUT failed but `audit_attestation` row inserted | `audit_attestation` row exists but no S3 object | Worker retries S3 PUT (idempotent). `audit_attestation.s3_uploaded_at` column tracks; alert if > 1h unfilled. |
| `audit_attestation` insert failed but S3 succeeded | S3 object exists but no DB row | Re-run worker; it detects existing S3 object (HEAD), reads its bytes, re-inserts the row using the same data. |
| Signing key compromised | External report (most likely vector) or detection of unauthorized PUT to S3 attestation bucket | Emergency rotation: generate new keypair → publish new public key to `vici2-audit-public-keys/` → revoke old key from signing role → next-day attestations use new key_id. Old attestations retain their original `key_id`; verifier uses the historical public key (still published, still in Object Lock). Document a "key compromise window" in the chain — verifier flags all attestations signed with the compromised key in the suspect window as "signature-valid-but-key-untrusted." |
| Signing key lost (no compromise, just lost) | Worker fails on first run after loss with "key not found" → page | Same rotation but no revocation needed; old attestations remain valid (their signatures still verify under the public key that's still in S3). |
| Public key bucket compromised (T7) | Mismatch between cached-out-of-band copy and S3 copy | Verifier ships with a pinned manifest `vici2-audit-public-keys-manifest.json` checked into the repo; manifest contains SHA-256 of every public key file. Verifier refuses to use any key whose SHA-256 doesn't match the manifest. Manifest update is a PR (`git blame` audit). |
| Trigger dropped without `make audit-ddl` | (a) Next INSERT succeeds without setting `row_hash` → row_hash is NULL → INSERT fails because `row_hash NOT NULL`. (b) If the rogue admin also dropped the NOT NULL constraint, the inserted row has `row_hash=NULL`; verifier sees NULL and flags. (c) Trigger absence detected by `information_schema.TRIGGERS` query — CI nightly check. | Restore trigger from latest migration; investigate; possible chain break. |
| Clock skew on app servers | Insert path uses `NOW(6)` from DB, not app — DB clock is the single source of truth. Multi-server DB cluster (Phase 4) syncs via Chrony with monitoring | N/A Phase 1 (single DB). |
| Verifier disagrees with itself between languages (TS vs Go) | Golden fixture parity test in CI | Treat as a P0 spec bug — both implementations halt until reconciled. |
| C04 drops a partition before its attestation is verified | C04 PLAN includes precondition gate ("only drop partition P if attestation for the last day of P exists in S3 and verified within 7d") | Reject the drop; alert. |

---

## 9. Schema additions

### 9.1 `audit_attestation` table (new)

```sql
CREATE TABLE audit_attestation (
    id                   BIGINT NOT NULL AUTO_INCREMENT,
    tenant_id            BIGINT NOT NULL DEFAULT 1,
    table_name           ENUM('audit_log','call_window_audit','originate_audit',
                              'consent_log','dnc_sync_log') NOT NULL,
    window_date          DATE NOT NULL,                       -- the UTC day attested
    row_count            BIGINT NOT NULL,
    first_id             BIGINT NULL,                         -- NULL on empty-day
    last_id              BIGINT NULL,
    first_row_prev_hash  CHAR(64) NOT NULL,
    last_row_row_hash    CHAR(64) NOT NULL,
    merkle_root          CHAR(64) NOT NULL,
    key_id               VARCHAR(64) NOT NULL,
    signature_b64        VARCHAR(96) NOT NULL,               -- 64 bytes Ed25519 → 88 b64 chars
    s3_key               VARCHAR(255) NOT NULL,
    s3_etag              VARCHAR(64) NULL,
    s3_uploaded_at       DATETIME(6) NULL,
    -- chain columns (this table is itself chained, per-tenant per-table_name)
    prev_attestation_hash CHAR(64) NOT NULL,
    attestation_hash      CHAR(64) NOT NULL,
    hash_at              DATETIME(6) NOT NULL,
    computed_at          DATETIME(6) NOT NULL,
    created_at           DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id, computed_at),
    UNIQUE KEY uk_t_table_date (tenant_id, table_name, window_date),
    INDEX     idx_t_table_computed (tenant_id, table_name, computed_at)
)
PARTITION BY RANGE COLUMNS(computed_at) (
    PARTITION p2026_05 VALUES LESS THAN ('2026-06-01'),
    PARTITION p2026_06 VALUES LESS THAN ('2026-07-01'),
    -- … rolled forward by C04
    PARTITION pmax     VALUES LESS THAN MAXVALUE
);
```

The table is itself chained (per-tenant per-table_name) so an attacker who forges a Merkle attestation but doesn't forge the chain row is caught; and one who forges the chain row but doesn't update S3 is also caught. The unique key `(tenant_id, table_name, window_date)` makes the worker idempotent.

### 9.2 Chain columns on the four sister tables

`call_window_audit`, `originate_audit`, `consent_log`, `dnc_sync_log` each get:

```sql
ALTER TABLE <name>
    ADD COLUMN prev_hash CHAR(64) NOT NULL,
    ADD COLUMN row_hash  CHAR(64) NOT NULL,
    ADD COLUMN hash_at   DATETIME(6) NOT NULL;
ALTER TABLE <name>
    ADD INDEX idx_t_hash_at (tenant_id, hash_at);  -- attestation worker scan
```

`audit_log` itself also gets the three columns (F02 didn't add them — `audit_log` ships with grants + triggers but no chain). The C03 migration adds them.

### 9.3 BEFORE-INSERT triggers (5 tables)

Per the template in §3.6, one trigger per table.

### 9.4 BEFORE-UPDATE / BEFORE-DELETE triggers (extend F02 pattern)

F02 already ships these for `audit_log`. C03 extends to `call_window_audit`, `originate_audit`, `consent_log`, `dnc_sync_log`, `audit_attestation`:

```sql
DROP TRIGGER IF EXISTS <name>_no_update;
CREATE TRIGGER <name>_no_update BEFORE UPDATE ON <name>
FOR EACH ROW SIGNAL SQLSTATE '45000'
  SET MESSAGE_TEXT = '<name> is append-only; UPDATE not permitted (C03)';

DROP TRIGGER IF EXISTS <name>_no_delete;
CREATE TRIGGER <name>_no_delete BEFORE DELETE ON <name>
FOR EACH ROW SIGNAL SQLSTATE '45000'
  SET MESSAGE_TEXT = '<name> is append-only; DELETE not permitted (C03)';
```

### 9.5 Index additions

The attestation worker scans `WHERE tenant_id=? AND hash_at>=? AND hash_at<?`. Each chained table gets `INDEX idx_t_hash_at (tenant_id, hash_at)`. Cost: ~15 B/row × 5 tables × 7-year retention ≈ 17 GB extra index space across the cluster — same order as the row-hash data itself (RESEARCH §8.2).

### 9.6 Storage estimate (RESEARCH §8.2 confirmed)

| Table | 7y rows | Chain bytes (155 B/row) | Index bytes |
|---|---|---|---|
| `audit_log` | 10M | 1.5 GB | 200 MB |
| `call_window_audit` | 700k | 110 MB | 14 MB |
| `originate_audit` | 80M | 12 GB | 1.6 GB |
| `consent_log` | 25M | 4 GB | 500 MB |
| `dnc_sync_log` | 10k | 1.5 MB | 200 KB |
| `audit_attestation` | 12.8k (5 tbls × 365d × 7y) | 6 MB | 2 MB |
| **Total** | **~116M** | **~17.6 GB** | **~2.3 GB** |

Per tenant. At Phase 4 (100 tenants): ~2 TB across 7 years — comfortable on commodity NVMe.

---

## 10. Public API

### 10.1 Go (`dialer/internal/audit/`)

```go
package audit

type Table string
const (
    TableAuditLog        Table = "audit_log"
    TableCallWindowAudit Table = "call_window_audit"
    TableOriginateAudit  Table = "originate_audit"
    TableConsentLog      Table = "consent_log"
    TableDncSyncLog      Table = "dnc_sync_log"
)

// Append inserts a row into the named audit table and returns its id +
// computed row_hash. The hash is computed by the BEFORE INSERT trigger;
// this client just round-trips the value via RETURNING-equivalent
// SELECT on LAST_INSERT_ID. Append is transactional in `db`; commit the
// caller's transaction to publish.
type Writer struct {
    db *sql.DB
}
func NewWriter(db *sql.DB) *Writer
func (w *Writer) Append(ctx context.Context, table Table, row any) (Result, error)

type Result struct {
    ID       int64
    RowHash  string  // 64-hex lowercase, returned post-insert
}

// Verifier is read-only and uses vici2_audit_reader credentials.
type Verifier struct { /* … */ }
func NewVerifier(opts VerifierOpts) (*Verifier, error)
func (v *Verifier) VerifyRow(ctx context.Context, t Table, tenant, id int64) (VerifierResult, error)
func (v *Verifier) VerifyRange(ctx context.Context, t Table, tenant int64, from, to time.Time) (VerifierResult, error)

type VerifierResult struct {
    OK                  bool
    Failures            []VerifierFailure
    RowsChecked         int64
    DaysChecked         int
    AttestationsChecked int
}
type VerifierFailure struct {
    Kind     string  // "row_hash_mismatch" | "prev_hash_mismatch" | "missing_row"
                    // "merkle_root_mismatch" | "signature_invalid" | "missing_attestation"
    Table    Table
    TenantID int64
    ID       int64
    Date     string  // "YYYY-MM-DD" when applicable
    Expected string
    Actual   string
}
```

### 10.2 TS (`api/src/services/audit/`)

```typescript
export type AuditTable =
  | 'audit_log' | 'call_window_audit' | 'originate_audit'
  | 'consent_log' | 'dnc_sync_log';

export interface AuditEntry {
  tenantId: bigint;
  // …table-specific fields validated by per-table Zod schemas in events.ts
  [k: string]: unknown;
}

export class AuditWriter {
  constructor(deps: { db: PrismaClient });
  async append(table: AuditTable, entry: AuditEntry): Promise<{id: bigint; rowHash: string}>;
}

export class AuditReader {
  constructor(deps: { db: PrismaClient; writer: AuditWriter; rbac: RbacContext });
  // Each method writes a meta-audit row via writer.append('audit_log', {action: 'audit.access.X'})
  async list(req: AuditListRequest): Promise<Paginated<AuditRow>>;
  async getByCallUuid(uuid: string): Promise<AuditRow[]>;
  async getAttestation(t: AuditTable, date: string): Promise<SignedAttestation>;
}

export class AuditVerifier {
  constructor(deps: { db: PrismaClient; s3: S3Client; pubKeys: PublicKeySource });
  async verifyRow(p: {tenantId: bigint; table: AuditTable; id: bigint}): Promise<VerifierResult>;
  async verifyRange(p: {tenantId: bigint; table: AuditTable; from: Date; to: Date}): Promise<VerifierResult>;
  async verifyDay(p: {tenantId: bigint; table: AuditTable; date: string}): Promise<VerifierResult>;
}
```

### 10.3 HTTP surface (lives behind RBAC `audit:view` / `audit:export`)

| Method | Path | Permission | Purpose | Meta-audit action |
|---|---|---|---|---|
| GET | `/api/audit/log` | `audit:view` | Paginated `audit_log` rows | `audit.access.log_listed` |
| GET | `/api/audit/call-windows` | `audit:view` | `call_window_audit` rows | `audit.access.call_windows_listed` |
| GET | `/api/audit/originates` | `audit:view` | `originate_audit` rows | `audit.access.originates_listed` |
| GET | `/api/audit/consents` | `audit:view` | `consent_log` rows | `audit.access.consents_listed` |
| GET | `/api/audit/dnc-syncs` | `audit:view` | `dnc_sync_log` rows | `audit.access.dnc_syncs_listed` |
| GET | `/api/audit/verify-row` | `audit:view` | Single-row chain + Merkle proof | `audit.access.row_verified` |
| GET | `/api/audit/verify-range` | `audit:view` | Range verification report | `audit.access.range_verified` |
| GET | `/api/audit/attestation` | `audit:view` | Signed attestation (mirrored from S3) | `audit.access.attestation_fetched` |
| GET | `/api/audit/attestations` | `audit:view` | List attestations by date range | `audit.access.attestations_listed` |
| POST | `/api/audit/exports` | `audit:export` | Async bulk export job → S3 → emailed link | `audit.access.export_requested` |

Cross-tenant access (`?tenant_id=N` for a `super_admin` user with `audit:view:cross_tenant`) writes `audit.access.cross_tenant` at SEV1 page severity (RESEARCH §4.5).

Pagination: cursor-based `?cursor=<b64 (id, ts)>&limit=50`, hard cap `limit ≤ 200` (RESEARCH §4.3). Field redaction allowlist per RESEARCH §4.4.

---

## 11. Test plan

### 11.1 Unit tests

1. **`audit_log_hash_chain.test.ts`** — INSERT 100 rows; verify each row's `prev_hash == prior.row_hash` and each `row_hash == SHA2(canonical_concat)`.
2. **`canonicalization.test.ts`** — given a fixture row, the canonical-form byte string is byte-identical between MySQL (computed via `SELECT CONCAT_WS(…)`), TS (computed via `canonicalize()` helper), and Go (computed via `audit.Canonicalize()`).
3. **`merkle_rfc6962.test.ts`** — RFC 6962 test vectors: empty tree, single-leaf, two-leaf, three-leaf (odd-count duplication), 5-leaf. Golden roots from a known-good implementation (e.g., Trillian or CT log).
4. **`trigger_present.test.ts`** — query `information_schema.TRIGGERS`; assert all 15 expected triggers exist (5 tables × 3 triggers: hash_chain, no_update, no_delete) + `audit_attestation`'s 3.
5. **`grants_app_user.test.ts`** — connect as `vici2_app`, attempt UPDATE/DELETE/DROP on each audit table; assert `ER_TABLEACCESS_DENIED_ERROR (1142)`.
6. **`grants_reader_user.test.ts`** — connect as `vici2_audit_reader`, attempt INSERT on each audit table; assert denied. Attempt SELECT; assert allowed.
7. **`zod_payload_validation.test.ts`** — reject entries with `0x1F` in any string field; reject entries with `NULL` byte; reject oversize payload (>4 KB per C03.md §74 cap).

### 11.2 Cross-language canonicalization parity

Golden fixture JSON `test/fixtures/canonicalization/`:
- `audit_log_simple.json` — minimum-field row
- `audit_log_full.json` — every field present with edge cases (UTF-8 emoji in `user_agent`, nested JSON in `before_json`, NULL in `actor_user_id`)
- `originate_audit_with_uuid.json`
- ... (one fixture per table × 3 edge-case shapes = 15 fixtures total)

Each fixture has a `expected_canonical` (hex of the byte string) and `expected_row_hash` (hex of SHA-256). Three implementations (MySQL trigger, TS `canonicalize`, Go `Canonicalize`) MUST all produce the expected values. CI gates.

### 11.3 DST / time-zone canonicalization

Server runs UTC; trigger uses `DATE_FORMAT(... '%Y-%m-%dT%H:%i:%s.%fZ')`. Fixture: insert with `ts = '2026-03-08 07:00:00.000000'` (US DST spring-forward day); canonical form MUST contain `2026-03-08T07:00:00.000000Z` regardless of session timezone. Test toggles session TZ and re-reads.

### 11.4 Five tamper scenarios (the heart of the test plan)

Each scenario sets up a baseline of 1000 rows over 5 days, runs the attestation worker for each day, then performs the tamper and runs `verify-audit-chain.ts`. All must report TAMPERED.

| # | Scenario | Tamper | Expected detection |
|---|---|---|---|
| **S1** | **Direct UPDATE** | Connect as `vici2_root`, `UPDATE audit_log SET after_json = '{"forged": true}' WHERE id = 500` (trigger drop required first since `audit_log_no_update` blocks it) | (a) `audit_log_no_update` trigger SIGNAL prevents the UPDATE without DROP; (b) if trigger is first dropped: row 500's `row_hash` no longer matches recomputed; verifier reports `row_hash_mismatch` at id=500 |
| **S2** | **Drop trigger, mutate, restore trigger** | DROP TRIGGER audit_log_no_update → UPDATE → CREATE TRIGGER | Same as S1 detection-side; additionally, the `audit.schema.modified` row that `make audit-ddl` would have written is missing — CI schema-trigger check pages |
| **S3** | **Partition swap** | EXCHANGE PARTITION p2026_04 with a hostile table containing forged rows | `audit_log_no_delete` blocks the EXCHANGE if any row would be removed; if forced: chain breaks because `id` sequence + `prev_hash` no longer match; verifier reports `prev_hash_mismatch` at first row of next partition |
| **S4** | **Forged S3 attestation** | Replace attestation JSON with one containing a different `merkle_root` (forge requires deleting the old version; Object Lock Compliance prevents) | (a) Object Lock prevents delete; (b) if simulation bypasses lock: `signature_invalid` (signing key not held by attacker); (c) if attacker also forges signature with self-generated key: `key_id` is unknown to the public-key manifest → `signature_invalid` |
| **S5** | **Backup restore with forged history** | Restore a mysqldump where row 500's `after_json` is different | Same as S1: stored `row_hash` no longer matches recomputed `row_hash`; verifier reports mismatch |

### 11.5 Performance benchmarks

- `BenchmarkInsertWithChain` (Go): inserts 10k rows into a freshly-truncated `audit_log` (no contention); reports mean + p99 per-row latency. Gate: **mean < 500 µs, p99 < 1 ms** on the F01 dev box.
- `BenchmarkAttestationWorker` (Go): generates 100k synthetic rows, runs Merkle reduction. Gate: **< 5 s total**.
- `BenchmarkVerifyDay` (Node): 100k rows; full verify (recompute + Merkle + signature). Gate: **< 30 s**.

### 11.6 Coverage targets

- `api/src/services/audit/writer.ts`: ≥ 90% line.
- `api/src/services/audit/verifier.ts`: ≥ 90% line.
- `api/src/services/audit/reader.ts`: ≥ 80% line.
- `shared/lib/merkle.ts`: 100% line (small, no branches besides odd-count).
- `dialer/internal/audit/`: ≥ 85% line.
- `workers/src/jobs/audit-attest/index.ts`: ≥ 80% line (mock S3 + signer).
- `scripts/verify-audit-chain.ts`: ≥ 70% line (CLI argparse covered by integration test).

### 11.7 CI nightly job

`.github/workflows/audit-verify-nightly.yml` runs `verify-audit-chain.ts --tenant 1 --table all --from $(date -d '7 days ago') --to $(date)` against the staging DB + staging S3 bucket. Exit code 2 fails the workflow → pages O01.

### 11.8 Negative-test catalog (Zod / API)

- Payload > 4 KB → `AUDIT_PAYLOAD_TOO_LARGE`.
- Payload contains `` byte → rejected.
- Payload contains unbalanced UTF-16 surrogate → rejected (otherwise `JSON_EXTRACT` canonicalization disagrees with TS `JSON.stringify`).
- `entity_type` longer than 32 chars → rejected.

---

## 12. Files to be created / changed

```
api/prisma/schema.prisma
  + AuditAttestation model
  + chain columns (prevHash, rowHash, hashAt) on AuditLog, CallWindowAudit,
    OriginateAudit, ConsentLog, DncSyncLog

api/prisma/migrations/20260507000100_c03_audit_chain_columns/
  migration.sql        # ALTER TABLE for chain cols + indexes on 5 tables
  migration.down.sql   # dev/test only

api/prisma/migrations/20260507000200_c03_hash_triggers/
  migration.sql        # 5 BEFORE-INSERT hash triggers
  migration.down.sql

api/prisma/migrations/20260507000300_c03_extend_immutability/
  migration.sql        # BEFORE-UPDATE / BEFORE-DELETE triggers on the 4 sister tables
                       # plus audit_attestation triggers (no_update/no_delete/hash_chain)
  migration.down.sql

api/prisma/migrations/20260507000400_c03_audit_attestation_table/
  migration.sql        # CREATE TABLE audit_attestation + RANGE COLUMNS partitioning
  migration.down.sql

api/prisma/migrations/20260507000500_c03_audit_grants/
  migration.sql        # vici2_app revokes on sister tables; create vici2_audit_reader,
                       # vici2_partition_admin; grants matrix
  migration.down.sql

api/src/services/audit/
  writer.ts            # AuditWriter
  reader.ts            # AuditReader with auto-meta-audit
  verifier.ts          # AuditVerifier
  events.ts            # per-table Zod schemas + action vocabulary helpers
  canonicalize.ts      # the byte-level canonicalizer matching the trigger
  routes.ts            # the 10 HTTP endpoints in §10.3
  __tests__/
    writer.spec.ts
    reader.spec.ts
    verifier.spec.ts
    canonicalize.spec.ts
    grants.integration.spec.ts
    tamper_scenarios.integration.spec.ts

shared/lib/merkle.ts        # RFC 6962 Merkle reduce + inclusion proof; pure-function
shared/lib/jcs.ts           # RFC 8785 JSON canonicalization (tiny wrapper)

shared/openapi/openapi.yaml
  + /api/audit/* endpoints + schemas (SignedAttestation, VerifierResult, …)

dialer/internal/audit/
  writer.go
  verifier.go
  canonicalize.go
  doc.go
  writer_test.go
  verifier_test.go
  canonicalize_test.go

workers/src/jobs/audit-attest/
  index.ts                   # the 03:30 UTC cron worker
  merkle-builder.ts          # uses shared/lib/merkle.ts
  signer.ts                  # wraps F05's KMS / env-var Ed25519
  s3-publisher.ts            # PUT with Object Lock Compliance
  index.spec.ts

scripts/verify-audit-chain.ts   # CLI; ships to customer auditors
scripts/verify-audit-chain.spec.ts

infra/aws/audit-attestation-bucket.tf      # Terraform stub for O02 to apply
infra/aws/audit-public-keys-bucket.tf

infra/mysql/init/02-audit-users.sql        # CREATE USER for audit_reader + partition_admin
                                            # (passwords from env at boot)

Makefile
  + audit-ddl target (§7.3)
  + audit-verify-7d target (CI shortcut)

test/fixtures/canonicalization/
  audit_log_simple.json + 14 more (§11.2)

test/fixtures/merkle/
  rfc6962_test_vectors.json    # canonical CT test vectors

docs/operations/audit-verification.md       # external-auditor runbook
docs/operations/audit-key-rotation.md       # F05 key-rotation procedure (mirror)
```

Net new code: ~5,500 LoC TS + ~2,200 LoC Go + ~600 LoC SQL + ~1,800 LoC tests. Migration count: 5.

---

## 13. Acceptance criteria

- [ ] All five immutable tables (`audit_log`, `call_window_audit`, `originate_audit`, `consent_log`, `dnc_sync_log`) + `audit_attestation` carry `prev_hash`, `row_hash`, `hash_at` columns populated by their `BEFORE INSERT` trigger.
- [ ] Verification of a 7-day window passes via `verify-audit-chain.ts` against a freshly-seeded DB + S3 (CI nightly).
- [ ] `vici2_app` has `{INSERT, SELECT}` only on every immutable table; UPDATE/DELETE/DROP/TRUNCATE attempts return `ER_TABLEACCESS_DENIED_ERROR`.
- [ ] `vici2_audit_reader` has SELECT-only; INSERT/UPDATE/DELETE return denied.
- [ ] `vici2_partition_admin` has `ALTER, DROP` only on the five partitioned tables; no DML.
- [ ] All five tamper scenarios in §11.4 are detected by the verifier with the expected `VerifierFailure.kind`.
- [ ] Attestation worker produces empty-day attestations on zero-row days; chain carry-forward proves continuity.
- [ ] S3 bucket has Object Lock Compliance enabled with 7-year default retention; verified by `aws s3api get-object-lock-configuration` in CI.
- [ ] Cross-language canonicalization parity: 15 golden fixtures pass under TS, Go, and the MySQL trigger.
- [ ] HTTP `/api/audit/*` endpoints are gated by RBAC; every read writes a `audit.access.<endpoint>` row to `audit_log` (and is itself in the chain).
- [ ] Cross-tenant audit reads page at SEV1.
- [ ] Performance: insert path adds < 500 µs mean / < 1 ms p99; attestation worker < 5 s for 100k rows; verify-day < 30 s for 100k rows.
- [ ] Documentation: `docs/operations/audit-verification.md` is sufficient for an external auditor to verify a date range without any vici2-team support beyond the published public keys.
- [ ] Key rotation runbook tested in staging: generate new key → publish public → flip signer → next day's attestation uses new `key_id` → old attestations still verify.
- [ ] No code path bypasses the writer interface (CI lint forbids raw `INSERT INTO audit_log …` outside `AuditWriter`).

---

## 14. Dependencies + risks

### 14.1 Dependencies (upstream)

| Dep | What we need | Owner | Status |
|---|---|---|---|
| F02 | `audit_log` table + INSERT-only triggers + grants | F02 | DONE (merged) |
| F02 amendment | `call_window_audit`, `consent_log`, `originate_audit` (chain cols + indexes ride on top) | F02 | In-flight (multi-module amendment wave) |
| F05 | Ed25519 keypair generation, signer interface, KMS roadmap | F05 | PLAN |
| O02 | S3 buckets + Object Lock configuration + IAM users for writer/reader | O02 | PLAN |
| O05 | Secrets inventory entries for `VICI2_AUDIT_SIGNING_KEY_JWK`, `VICI2_AUDIT_READER_PASSWORD`, `VICI2_PARTITION_ADMIN_PASSWORD` | O05 | PLAN |
| C04 | Retention rotation gated on "last day's attestation exists + verified" | C04 | PLAN |
| C01 / C02 / D05 / T04 | Use `AuditWriter.append` instead of raw INSERTs; respect 4 KB payload cap; emit `entity_id` for `call_uuid` correlation | each | PLAN |

### 14.2 Downstream (we unblock)

- **N02** (webhook events): reads from `audit_log`, subscribes via `XREADGROUP` on a Valkey Stream that the audit writer also fans out to (Phase 1 = simple table poll; Phase 4 = stream).
- **C04**: trusts our "last attestation for partition" precondition.
- **External auditors / customers**: get a runnable verifier.

### 14.3 Risks

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| Trigger SELECT-FOR-UPDATE contention spikes p99 audit insert latency above 1 ms during burst | Medium | Medium | Pre-prod load test in IMPLEMENT; if violated, fall back to monotonic-id-only chain (no `prev_hash` lookup) gated on auto-increment monotonicity claim — tracked as backup §15 item |
| Cross-language canonicalization divergence | High | High | 15-fixture parity test gates CI; reviewer checklist; verify MySQL `JSON_EXTRACT` output is identical to JCS for our subset (no nested arrays of objects with mixed key types — Zod schema enforces) |
| Signing key compromised | Low | Catastrophic for in-window attestations | Rotation runbook tested; manifest of all key_ids in repo (git-blame audit); F05 Vault Phase 4 |
| Object Lock Compliance "stuck" buggy attestation that we can't delete | Medium | Low | Publish a corrected version (RESEARCH §6.4); verifier prefers latest-with-same-content-hash or earliest-version-as-source-of-truth — explicitly choose **earliest** per O02 PLAN bucket policy |
| MySQL `BEFORE INSERT` trigger semantics change in 8.4 LTS (Phase 2) | Low | High | F02 already pins 8.4 LTS as Phase 2 target; CI runs schema tests on both 8.0.40 and 8.4 — chain-trigger tests included |
| `vici2_root` social-engineered to drop a trigger | Medium | High | (a) Bastion + 2FA for root; (b) chain break leaves evidence; (c) `make audit-ddl` wrapper for the legitimate case; (d) MySQL audit plugin Phase 2 captures the DDL itself |
| Attestation worker missed cron silent failure | Low | High | `vici2_audit_attestation_last_success_timestamp{tenant,table}` gauge with 28h stale alert → O01 SEV1 |
| Customer auditor uses a verifier we didn't publish, gets wrong result | Medium | Medium | Ship `scripts/verify-audit-chain.ts` + a Dockerfile; instruct auditors to use ours; reference implementation has integration tests against the live system |
| Phase 4 multi-tenant burst on a shared chain (per-tenant) starves attestation reads | Low | Low | Per-tenant chains are independent; `idx_t_hash_at` makes worker scans fast |
| `audit_attestation` itself becomes a target | Low | Medium | It is itself chained (§9.1); its triggers are part of §11.4 S2 scenario |
| Partition pmax fills up because C04 forgets | Low | High | F02 already has a pmax-overflow alert; C03 leans on it |
| JCS library divergence (TS vs Go) | Medium | High | Use a well-tested library on each side (`canonicalize` npm pkg vs `github.com/cyberphone/json-canonicalization` Go); golden fixture catches |
| Audit-table `id` not monotone (rollback gaps) confuse verifier | Medium | Low | Verifier distinguishes "missing id with chain integrity preserved" (rollback, expected) vs "missing id breaking chain" (deletion, anomaly) — §8 |

---

## 15. Open issues / future work (not blocking PLAN)

1. **Hourly attestation cadence** (vs daily). Revisit when any tenant exceeds 1M rows/day or a customer contract requires sub-day attestation.
2. **Trillian-backed log mirror** (RESEARCH §15). Open-source verifiable log; Phase 4 enterprise feature; not Phase 1.
3. **Public blockchain anchoring** (Bitcoin OP_RETURN / Ethereum). Customer-pay feature for fintech / pharma verticals; deferred.
4. **Cross-region S3 replication** of attestations (§5.5). Phase 4.
5. **Vault Transit integration** for signing key (F05 hand-off). Phase 4.
6. **MySQL Enterprise Audit plugin** (RESEARCH §1.4) — server-level SQL capture; deferred to Phase 2 (O01/O02 ownership).
7. **`audit_log` pre-image storage** for chain "fork recovery." Phase 1 keeps `before_json/after_json` in the row; if those columns grow unwieldy, consider externalizing to S3 with a content-addressed hash reference. Deferred.
8. **BLAKE3 swap** (RESEARCH §2.5). Requires UDF or app-layer compute; no perf win at current volumes; deferred indefinitely.
9. **Audit-export PII redaction service.** GDPR Art. 17 erasure requests interact awkwardly with append-only chains — current answer: redact in export, keep raw in DB until retention boundary, document as "rectification by export" per Art. 16. Legal review pending.
10. **Per-row HMAC** (RESEARCH §2.6 length-extension hedge). Not needed at current threat model; documented.
11. **Verifier-as-service** (a customer-facing SaaS verifier endpoint). Useful for customers without their own ops capacity; Phase 4.
12. **Insert path fallback if FOR-UPDATE contention spikes** — monotonic-id-only chain. Document as the emergency tunable; gated on an `audit_chain_mode` server var (Phase 1 ships `forupdate`, fallback is `monotonic`).

---

## 16. STOP

PLAN complete. Five migrations queued. F02 amendment (chain columns + indexes on sister tables) coordinated with the in-flight F02 amendment wave. No code in this PLAN. Proceed to checkpoint review; on approval, IMPLEMENT phase begins after F05 PLAN converges on the Ed25519 signer interface and O02 PLAN confirms S3 Object Lock bucket configuration.
