# C03 — Audit Log Immutability — RESEARCH

**Module:** C03 (Compliance, Phase 1)
**Author:** C03 RESEARCH sub-agent (Claude Opus 4.7, 1M ctx)
**Date:** 2026-05-06
**Status:** PROPOSED — feeds C03 PLAN.
**Companion:** [PLAN.md](./PLAN.md)
**Read first:** DESIGN.md, SPEC.md §4.1 (TCPA hard floors), `spec/modules/C03.md`,
F02 PLAN §4.5 (audit_log table + grants), F02 HANDOFF §9 (immutability triggers
shipped), F05 PLAN §9 (audit() writer API), C01 PLAN §8 (call_window_audit),
T04 RESEARCH §7 (originate_audit), C02 (consent decisions), D05 PLAN
(dnc_sync_log).

---

## 0. Scope and stakes

C03 is the module that turns "we wrote an audit row" into "we can prove we
wrote that audit row, and we can prove nobody altered it after the fact."
Five tables are in scope:

| Table | Owner module | Purpose |
|---|---|---|
| `audit_log` | F02 + F05 (writer) | Generic security/admin audit (login, role change, SIP rotate, etc.) |
| `call_window_audit` | C01 (writer) | Every TCPA-window decision (ALLOW/SKIP/BLOCK with reason) |
| `originate_audit` | T04 (writer) | Every dial-attempt decision + outcome (idempotency, compliance gates) |
| `consent_log` | C02 (writer; new table — see §11.4) | Every recording-consent prompt + DTMF response per call |
| `dnc_sync_log` | D05 (writer) | Each federal/state DNC sync (delta or full) with file_hash + counts |

The unwaivable property: **once a row is INSERTed, neither the application,
nor a compromised admin, nor a rogue insider with `vici2_root` can mutate
or delete it without leaving forensic evidence.** Defense-in-depth over a
single mechanism — F02 already ships GRANT REVOKE + BEFORE UPDATE/DELETE
triggers on `audit_log`; C03 extends that pattern to all five tables AND
adds tamper-evident **hash chains** + **nightly Merkle attestations
published to S3 with Object Lock**.

**Why each layer matters (defense-in-depth chain):**

| Attack | Stopped by |
|---|---|
| App bug issues `UPDATE audit_log SET ...` | GRANT REVOKE (vici2_app lacks UPDATE) |
| App owner social-engineers `vici2_root` to mutate a row | BEFORE UPDATE/DELETE trigger raises SQLSTATE 45000 |
| Insider drops the trigger then mutates | Hash chain: row's `prev_hash` no longer matches predecessor's `row_hash` |
| Insider rebuilds the chain after mutating | Last-day Merkle root in S3 (Object Lock) won't match recomputed root |
| Insider replaces the published Merkle root | Object Lock Compliance mode: even AWS root can't delete during retention |
| Insider rolls their own signing key into the artifact | Detached Ed25519 signature with KEK rotation history; verification public keys cached out-of-band |

No single mechanism is sufficient on its own; SOC 2 / SOX-grade audit
trails require all four layers (DB-level controls + cryptographic chain
+ external attestation + key custody).

---

## 1. WORM patterns in MySQL — what's available

### 1.1 GRANT REVOKE (table-level)

Standard SQL ANSI privilege model. MySQL grants are **additive** — a
schema-wide `GRANT INSERT, UPDATE, DELETE, SELECT ON vici2.*` and a
table-level `GRANT INSERT, SELECT ON vici2.audit_log` **both apply**, and
the union grants UPDATE on `audit_log`. The correct pattern is:

1. Grant schema-wide privileges (or specific per-table grants).
2. Then `REVOKE UPDATE, DELETE ON vici2.<immutable_table> FROM 'user'@'host'`.

MySQL stores these in `mysql.tables_priv`; `SHOW GRANTS FOR user` shows
the union. F02's migration `20260506201700_audit_grants` already does
the REVOKE for `audit_log`. C03 must extend the REVOKE to the four other
tables.

**Limitations (per F02 HANDOFF §9):** REVOKE is privilege-system-only —
it has no effect on `vici2_root` or any user with `ALL PRIVILEGES`.
That's why the trigger pair is the load-bearing layer. [Citation §1]

### 1.2 BEFORE UPDATE / BEFORE DELETE triggers (load-bearing)

```sql
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
  FOR EACH ROW SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'audit_log is append-only; UPDATE is not permitted';

CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
  FOR EACH ROW SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'audit_log is append-only; DELETE is not permitted';
```

`SQLSTATE '45000'` is the standard "user-defined exception" code; the
ODBC/JDBC layer surfaces it as a generic SQL exception. Even `vici2_root`
cannot mutate a row without first dropping the trigger — and dropping a
trigger is itself a DDL operation that gets recorded in the binlog +
the audit_log (via a wrapper migration that audits trigger drops, see
§7 below).

**Important quirks:**
- `DROP PARTITION` does **NOT** fire row-level triggers (per F02 HANDOFF
  §7 — confirmed by MySQL 8.0 docs). C04 retention rotation thus
  remains possible without breaking immutability.
- `TRUNCATE TABLE` does NOT fire BEFORE DELETE triggers (it's DDL, not
  DML). Mitigation: REVOKE DROP, ALTER, TRUNCATE on these tables from
  `vici2_app`. [Citation §2]
- `REPLACE INTO` is INSERT + (conditional) DELETE. The DELETE path
  fires BEFORE DELETE → blocked. Application code must use INSERT
  exclusively.

### 1.3 Separate immutable schema (alternative we DID NOT pick)

Pattern: put audit tables in a separate MySQL schema (`vici2_audit`) and
grant `vici2_app` only `INSERT` there. Pros: bright-line; trivially
auditable grants. Cons: cross-schema FK impossible (we don't have FKs
on partitioned audit tables anyway, so this is mild); more migration
ceremony; C04 partition rotation must run as a different user; cross-
schema query requires explicit qualification in every audit reader.

**Decision:** keep audit tables in the `vici2` schema (matching F02's
shipped layout) and rely on per-table grants + triggers. Phase 4 may
revisit a separate audit schema with cross-region replication. [Citation §3]

### 1.4 MySQL Audit Plugin (server-level capture, NOT in scope)

MySQL Enterprise Audit + community alternatives (McAfee MySQL Audit,
Percona Audit Plugin) capture raw SQL statements at the server level
and write to a JSON log. Useful for forensic analysis after a
breach (you can prove what queries were issued by which user from
which host), but **not** a substitute for application-level audit
rows — the plugin captures the SQL text, not the business meaning
("agent dispositioned lead 12345 as DNC at 14:32"). F02 HANDOFF
notes this is deferred to Phase 2 (O01/O02 hand-off). C03 does NOT
require it for Phase 1.

---

## 2. Cryptographic hash chain — design

### 2.1 The pattern

Every immutable table gains three columns:

| Column | Type | Notes |
|---|---|---|
| `prev_hash` | `CHAR(64)` | SHA-256 hex of the prior row's `row_hash`; first row uses 64 zeros |
| `row_hash` | `CHAR(64)` | SHA-256 hex of `CONCAT_WS(':', prev_hash, <canonicalized fields>)` |
| `hash_at` | `DATETIME(6)` | When the hash was computed; matches `created_at` at insert time |

A `BEFORE INSERT` trigger fills these columns from the new row's data,
so no application code can forge them.

### 2.2 Per-tenant chain (Phase 1 decision)

Each tenant gets its own chain per table. Rationale:
- Tenant boundaries are the single most important security boundary
  in vici2 (F05 PLAN §1).
- Cross-tenant chain would couple tenants — one tenant's
  high-volume insert blocks another's (the trigger needs the prior
  row, which is a row-level lock).
- Per-tenant chain makes per-tenant audit export self-contained for
  GDPR Art. 15 / 30 (see §6).

Trigger walk:

```sql
DELIMITER //
CREATE TRIGGER audit_log_hash_chain BEFORE INSERT ON audit_log
FOR EACH ROW BEGIN
  DECLARE prior_hash CHAR(64);
  SELECT row_hash INTO prior_hash
    FROM audit_log
    WHERE tenant_id = NEW.tenant_id
    ORDER BY id DESC
    LIMIT 1;
  IF prior_hash IS NULL THEN
    SET prior_hash = REPEAT('0', 64);
  END IF;
  SET NEW.prev_hash = prior_hash;
  SET NEW.hash_at = COALESCE(NEW.created_at, NOW(6));
  SET NEW.row_hash = SHA2(CONCAT_WS(':',
      NEW.prev_hash,
      CAST(NEW.tenant_id AS CHAR),
      COALESCE(NEW.actor_user_id, ''),
      NEW.actor_kind,
      NEW.action,
      NEW.entity_type,
      COALESCE(NEW.entity_id, ''),
      COALESCE(JSON_EXTRACT(NEW.before_json, '$'), ''),
      COALESCE(JSON_EXTRACT(NEW.after_json, '$'), ''),
      DATE_FORMAT(NEW.ts, '%Y-%m-%dT%H:%i:%s.%f'),
      COALESCE(NEW.request_id, ''),
      COALESCE(NEW.ip_address, ''),
      COALESCE(NEW.user_agent, '')
    ), 256);
END //
DELIMITER ;
```

**Notes on the canonicalization:**
- `CONCAT_WS(':', ...)` skips NULL but keeps empty-string for our
  `COALESCE(..., '')` form so the hash is reproducible.
- `JSON_EXTRACT(json, '$')` normalizes whitespace and key order in
  MySQL 8 (output is the canonical JSON form per RFC 8785-ish; not
  strictly RFC 8785 but reproducible inside one MySQL version).
- `DATE_FORMAT(ts, '%Y-%m-%dT%H:%i:%s.%f')` pins the timestamp to
  microsecond ISO 8601 — independent of session timezone (server
  is `+00:00` per F02 §2.1).
- Auto-increment `id` is **NOT** in the hash. The chain is by tenant +
  insertion order; `id` is an implementation detail.

### 2.3 Concurrency

The trigger reads `MAX(id) FOR <tenant>` then writes. Two concurrent
inserts on the same tenant can race:
- T1: read prior_hash = H_n, compute row_hash = H_{n+1}
- T2: read prior_hash = H_n (T1 hasn't committed), compute row_hash = H_{n+1}'

Both rows would then claim the same `prev_hash`. **Mitigation:** the
trigger runs inside the transaction; the `SELECT ... ORDER BY id DESC
LIMIT 1` is on the same row that other concurrent inserts are about to
become. We use `SELECT ... FOR UPDATE` to acquire a row lock on the
prior row (or `LOCK IN SHARE MODE` since we only need to read it
consistently and prevent concurrent insertion until our row commits):

```sql
SELECT row_hash INTO prior_hash
  FROM audit_log
  WHERE tenant_id = NEW.tenant_id
  ORDER BY id DESC
  LIMIT 1
  FOR UPDATE;
```

**Cost:** serializes inserts within a tenant. Volume ceiling per
tenant per table (Phase 1 single-tenant; multi-tenant is Phase 4):
- `audit_log`: ~100 rows/sec sustained → 10ms per insert ceiling →
  fine.
- `call_window_audit`: ~5 rows/sec after sampling (C01 §8.1).
- `originate_audit`: 100/sec at full predictive bore (T04 §7.3).
- `consent_log`: 30/sec p99 (only on bridges; ~10% of originates).
- `dnc_sync_log`: <1/min (one row per delta sync).

Total ~135 rows/sec per tenant ceiling; per-tenant serialization
adds ~150 µs per row (single B-tree probe + lock). p99 stays well
under SPEC §4.1's 50ms write-latency budget. [Citation §4]

**Alternative considered:** advisory locks via `GET_LOCK('audit:<tid>:<table>')`
in the api writer. Rejected — moves the invariant from DB into app,
breaks if a non-app writer ever inserts.

### 2.4 Verification

A verifier walks the chain in order (`tenant_id`, then `id`):

```sql
SELECT id, prev_hash, row_hash, ... FROM audit_log
  WHERE tenant_id = ? ORDER BY id ASC;
```

For each row:
1. Recompute `row_hash` from `prev_hash` + canonicalized fields.
2. Compare to stored `row_hash`. Mismatch → "row tampered or chain
   broken at id=N".
3. Also assert `row.prev_hash == previous_row.row_hash`. Mismatch
   → "row inserted out of order or row deleted".

The verifier surface is exposed via `GET /api/audit/verify` (§4) and
runs in a CI nightly job (§7.6).

### 2.5 Why SHA-256 and not BLAKE3 / SHA-3

- **SHA-256** ships in MySQL as `SHA2(s, 256)` — no UDF, no extension.
- BLAKE3 / SHA-3 require a UDF or moving the hash compute to the app
  layer. BLAKE3 is faster but the bottleneck is row insert (~200 µs)
  not hash compute (~1 µs for 1KB).
- SHA-256 is FIPS 140-3 approved and required by SOC 2 CC6.6 / FedRAMP
  Moderate. Future-proof for federal customers (Phase 4). [Citation §5]
- Collision resistance margin: 128-bit. We're well past 2^64 audit
  rows-per-tenant (a 7-year retention at 100k/day = 256M rows; SHA-256
  has 192 bits of margin).

### 2.6 Length-extension attack — N/A here

SHA-256 is vulnerable to length-extension (you can compute
`SHA(M || pad || X)` from `SHA(M)` without knowing M). Mitigation in
generic settings is HMAC. **In our setting it doesn't apply** because
the attacker doesn't have a pre-image-extension surface — they're
trying to forge a row, not extend a hash. The verifier recomputes from
public canonicalized fields; an attacker who could insert a forged
row whose hash collides with the prior chain would have broken SHA-256
collision resistance, which is a worse problem than length-extension.

If we ever expose `row_hash` as a "give me the hash and I'll trust
the data" oracle (we don't plan to), we'd switch to HMAC-SHA-256 with
a per-tenant key. For now, plain SHA-256 is correct.

---

## 3. Nightly Merkle attestation

### 3.1 Why Merkle on top of the chain

The chain proves "no row mutated since insertion" — but only if you
have a trusted reference point. Without one, a sufficiently-empowered
insider could:
1. Mutate row N (fire trigger drop, then UPDATE).
2. Recompute row N's `row_hash`.
3. Walk forward through every row, recomputing each `prev_hash` and
   `row_hash` to be self-consistent.

Step 3 is O(N) + requires re-issuing N UPDATEs. Detectable at runtime
(audit_log on trigger drop; binlog has the rewrites; recovery from
backup mismatches), but not detectable from the DB alone.

The Merkle root attestation is the **trusted reference point**:
- Once a day, compute `merkle_root({row_hash for every row inserted
  today, sorted by tenant + id})`.
- Sign it with `VICI2_AUDIT_SIGNING_KEY` (Ed25519 — separate from JWT
  signing key; lives in O05 secrets inventory).
- PUT to S3 with Object Lock Compliance mode (§3.4).
- Emit `vici2_audit_attestation_last_success_timestamp{tenant}`.

To tamper undetectably, an attacker now needs to (a) rewrite history
in the DB, (b) forge a new Merkle root, (c) re-sign with the audit
signing key, AND (d) somehow modify the published S3 object during
its retention window — which Object Lock Compliance mode prevents
even from AWS root.

### 3.2 Merkle tree construction

Standard binary Merkle tree per RFC 6962 (Certificate Transparency):
- Leaves = `row_hash` values for the day, sorted by `(tenant_id, id)`.
- If odd number of leaves, duplicate the last one (RFC 6962 §2.1).
- Internal node = `SHA-256(0x01 || left || right)`.
- Leaf = `SHA-256(0x00 || row_hash_bytes)` (domain separation prevents
  second-preimage attacks per RFC 6962). [Citation §6]

For 100k rows/day: tree has 17 levels (2^17 = 131k); root computation
is ~200k SHA-256 ops ≈ 50 ms on a modern CPU.

### 3.3 Attestation artifact (signed)

```json
{
  "vici2_audit_attestation": {
    "version": 1,
    "tenant_id": 1,
    "table": "audit_log",
    "date": "2026-05-06",
    "row_count": 12847,
    "first_id": 51234,
    "last_id": 64080,
    "merkle_root": "<64 hex chars>",
    "leaf_hash_algo": "sha256-rfc6962",
    "node_hash_algo": "sha256-rfc6962",
    "first_row_prev_hash": "<64 hex chars>",
    "last_row_row_hash": "<64 hex chars>",
    "computed_at": "2026-05-07T03:30:00.000Z",
    "key_id": "ed25519-audit-2026-1"
  },
  "signature": "<base64url-encoded Ed25519 signature over the canonicalized JSON>"
}
```

`first_row_prev_hash` ties the day's root to the prior day's root
(forms a daily-granularity meta-chain). `last_row_row_hash` is the
chain-tip at midnight UTC.

### 3.4 S3 Object Lock Compliance mode

Bucket: `s3://vici2-audit-attestations/`. Key:
`<tenant_id>/<table>/<YYYY>/<MM>/<DD>.json`.

Bucket settings:
- **Object Lock enabled at bucket creation** (cannot be enabled
  retroactively; one-time bucket creation is part of O02 PLAN).
- **Default retention: Compliance mode, 7 years** (matches TCPA
  evidence retention for `audit_log`, `originate_audit`, `drop_log`).
- Compliance mode means **AWS account root cannot delete or shorten
  retention** during the lock period. (Governance mode allows root
  override; we explicitly want Compliance.) [Citation §7]
- Versioning: enabled (Object Lock requires it).
- Bucket policy: only `vici2_audit_writer` IAM principal can PUT;
  `vici2_audit_reader` can GET; all other principals (including the
  AWS account root in normal use) explicitly Denied via SCP.
- Cross-region replication to a second region (Phase 4 — see §8).

Cost: PUT pricing dominated by request count. 5 tables × 365 days ×
1 tenant Phase 1 = 1825 PUTs/year ≈ $0.01/year. Storage:
~50 KB attestation × 1825 = 91 MB/year. Rounding error.

### 3.5 Worker that computes + signs + uploads

`workers/src/jobs/audit-attest/index.ts`. Cron schedule `0 30 3 * * *`
UTC (03:30 — after O02's 03:00 backup window completes). Per
SPEC §3.6 / O02 / O05: read `VICI2_AUDIT_SIGNING_KEY_JWK` from env
(Phase 1) → Vault Transit (Phase 4). For each tenant + each
immutable table:
1. `SELECT row_hash FROM <table> WHERE tenant_id=? AND DATE(hash_at)=?`
   — yields N rows, sorted by id.
2. Compute Merkle root via `shared/lib/merkle.ts`.
3. Construct attestation JSON; canonicalize via JCS (RFC 8785).
4. Sign with Ed25519; embed signature.
5. PUT to S3 with `ObjectLockMode=COMPLIANCE`,
   `ObjectLockRetainUntilDate=now+7y`.
6. Insert one row into `audit_log` action `audit.attestation.published`
   with `entity_id=<s3 key>`, `payload={merkle_root, row_count}`.
7. Emit `vici2_audit_attestation_last_success_timestamp{tenant,table}`.

Failure modes (see §3.6):
- DB unreachable → retry exponential 1m, 5m, 30m; page after 3 hours.
- S3 unreachable → idempotent retry (same key, same bytes — Object
  Lock allows multiple PUTs of same version with same retention).
- Signing key missing → page immediately (compliance break).
- Empty day (no rows) → still publish an empty-day attestation
  (`row_count: 0`, `merkle_root: SHA-256(0x00)`) so we can prove
  there was no activity (vs. attestation lost).

### 3.6 Verification path

A standalone verifier (`scripts/verify-audit-chain.ts`) takes a
date range + tenant + table:
1. Download all attestation JSONs from S3 for the range.
2. Verify each signature with the public key (cached locally).
3. For each day, re-query the DB for `row_hash`s and recompute the
   Merkle root; compare to attested root.
4. Walk the chain across the range: assert `row.prev_hash ==
   prior.row_hash` and `attestation[N].first_row_prev_hash ==
   attestation[N-1].last_row_row_hash`.

Output: `OK | TAMPERED at <table>/<tenant>/<id>` plus structured
JSON for log ingestion.

This script is what we ship to a customer's auditor + run nightly in
CI (with last-7-day window) to detect drift.

---

## 4. Audit query API — surface

### 4.1 Endpoints (RBAC `audit:view` per F05 §6)

| Method | Path | Permission | Purpose |
|---|---|---|---|
| GET | `/api/audit/log` | `audit:view` | Paginated feed of `audit_log` rows; filter by action / actor / entity / date |
| GET | `/api/audit/call-windows` | `audit:view` | Paginated feed of `call_window_audit` (for compliance officers) |
| GET | `/api/audit/originates` | `audit:view` | Paginated feed of `originate_audit` |
| GET | `/api/audit/consents` | `audit:view` | Paginated feed of `consent_log` |
| GET | `/api/audit/dnc-syncs` | `audit:view` | Paginated feed of `dnc_sync_log` |
| GET | `/api/audit/verify` | `audit:view` | Run hash-chain verification on a tenant + table + date range |
| GET | `/api/audit/attestations` | `audit:view` | List signed attestations in S3 by date range |
| GET | `/api/audit/attestations/:date/:table` | `audit:view` | Fetch specific attestation JSON (with signature) |
| POST | `/api/audit/exports` | `audit:export` | Bulk export with chain proof (background job; emails link) |

### 4.2 Meta-audit on every audit query

Every read of an audit endpoint is itself an audit event with action
`audit.access.<endpoint>` (e.g., `audit.access.log_viewed`,
`audit.access.export_requested`). This is a SOC 2 CC7.2 / NIST 800-53
AU-9 requirement — the audit trail must record who looks at the audit
trail. [Citation §8]

### 4.3 Pagination strategy

Cursor-based: `?cursor=<base64 of (id, ts)>&limit=50`. ORDER BY
`(tenant_id, id ASC)` matches the partition column (`ts` /
`originated_at` / `created_at`) so MySQL's partition pruning kicks
in only when the cursor crosses a partition boundary.

Hard limit `limit <= 200` to bound query cost; bulk exports go
through the export endpoint (asynchronous).

### 4.4 Field redaction

Some audit fields contain PII (`actor_ip`, `payload.email`). The
audit reader applies an allowlist:
- Default reader: actor_user_id (numeric only), action, entity_type,
  entity_id, ts, request_id, source_ip (last octet masked).
- `audit:view:full` (super_admin): every column, no masking.

This satisfies GDPR data-minimization while preserving the
investigation surface for super_admin during incident response.

### 4.5 Cross-tenant access

Every endpoint runs through `requireTenant` middleware (F05 §6).
A `super_admin` user with `audit:view:cross_tenant` perm can pass
`?tenant_id=N`; that read fires a `audit.access.cross_tenant` event
at severity **page** (matches F05's `auth.sip.viewed` pattern).

---

## 5. Compliance frameworks driving requirements

### 5.1 SOC 2 Type II

Trust Services Criteria CC7.2 ("logging and monitoring") and CC7.3
("evaluation of security events") require:
- Logs of system events that may indicate security breaches.
- Logs are protected from unauthorized modification (WORM).
- Procedures to evaluate logs.

CC6.1 ("logical access controls") + CC6.6 ("encryption in transit
and at rest") require:
- Access to audit logs is restricted (RBAC).
- Audit logs at rest are protected (S3 Object Lock + Compliance mode
  satisfies "physical and logical protection").

The hash chain + Merkle attestation is what auditors look for under
CC7.2 — without tamper evidence, "WORM" is a checkbox claim, not a
demonstrable control. [Citation §9]

### 5.2 FCC TCPA defense (47 USC §227)

Class-action defense requires producing, for every alleged illegal
call:
- Proof the number was scrubbed against DNC at dial time
  (`originate_audit.dnc_decision`, `originate_audit.dnc_sources`).
- Proof the call window was checked
  (`originate_audit.tcpa_decision`, `call_window_audit`).
- Proof of consent if the call was to a wireless number
  (`consent_log` for recording consent; `dnc_sync_log` for the
  scrub state at the time).
- Demonstration the records have not been altered post-hoc
  (Merkle attestation from a date prior to the lawsuit).

Statutory damages $500/$1,500 per call. A 100-agent center making
one bad campaign of 10k calls is staring down $5M–$15M; the audit
trail is what makes a $0 settlement possible (vs. summary judgment
against). C03 is the technical control behind the legal defense.
[Citation §10]

### 5.3 GDPR Article 30 (records of processing)

Requires processors to maintain records of processing activities
including:
- Categories of data processed.
- Recipients to whom personal data has been disclosed.
- Time limits for erasure.

`audit_log` is the record under Art. 30; `consent_log` is the
record under Art. 7 (consent). Hash chain + attestation provides
"appropriate technical measures" under Art. 32. [Citation §11]

### 5.4 SOX §404 (if customer is a public company)

Section 404 requires management's assessment of internal controls
over financial reporting. For a call center handling subscriptions
or sales, the dispo + DNC + recording trail is part of revenue
recognition controls. Same audit trail satisfies §404 attestation
when verified by external auditor. [Citation §12]

### 5.5 NIST SP 800-53 AU family

AU-9 (Protection of Audit Information) mandates that audit
records be protected from unauthorized modification AND deletion.
AU-10 (Non-repudiation) requires cryptographic mechanisms. The
hash chain + Ed25519 signature satisfies AU-10. AU-11 (Audit
Record Retention) sets minimum retention; we exceed federal
defaults at 7 years.

---

## 6. Anti-patterns to avoid

### 6.1 "Audit data in same DB as application without immutability"

The most common failure mode in mid-stage SaaS: audit table lives
next to lead table, app user has full DML, the audit "trail" is a
table any insider can edit. F02 prevents this for `audit_log` via
GRANT REVOKE + triggers; C03 extends to all five tables.

### 6.2 "Append-only via app code"

Relying on the app code to "never UPDATE audit rows" is a code-review
control that breaks the moment an emergency hotfix touches the audit
service. DB-level enforcement (grants + triggers) is mandatory.

### 6.3 "Hash chain without external attestation"

A chain that only exists in the DB is a chain the DB owner can
rewrite (drop trigger, UPDATE every row, re-insert chain). Without
S3 Object Lock attestation, the chain is local-only and trustable
only to the extent the DB itself is trustable — circular.

### 6.4 "Object Lock in Governance mode"

Governance mode lets an `s3:BypassGovernanceRetention` grant override
the lock — effectively making it advisory. Compliance mode is the
only setting that resists insider attack on the AWS account itself.
Trade-off: Compliance mode locks are irrevocable; if you upload a
buggy attestation, you cannot delete it. Mitigation: the attestation
is small (~5 KB), you can publish a corrected version with
`type: "corrected"` field and the verifier prefers latest. [Citation §13]

### 6.5 "Single signing key, no rotation plan"

If `VICI2_AUDIT_SIGNING_KEY` leaks, every attestation past the leak
date is forgeable. C03 PLAN includes (§3.5 / §11) a key rotation
procedure: generate a new key (`ed25519-audit-2026-2`), publish the
public key in `s3://vici2-audit-public-keys/<key_id>.pem` with
Object Lock Compliance, retire the old key from the signing
position but keep its public part for verification of past
attestations.

### 6.6 "No verification in CI"

A chain that nobody verifies is a chain that quietly breaks in
production. CI nightly job runs the verifier against the last 7
days; failure pages O01.

### 6.7 "Audit reads bypass meta-audit"

Auditor or super_admin reads the audit log "to see what happened"
without itself being audited. This is the #1 thing forensics
investigators look for in a compromise — admin reads to understand
attacker actions, but the admin's own access creates investigation
gaps. Meta-audit closes that loop.

---

## 7. Cross-region replication for audit DB (Phase 4)

S3 Object Lock provides regional durability. The audit DB itself
(MySQL) is a single instance in Phase 1. Phase 4 plan:

- Read replica in a second region (cross-region MySQL 8 replication
  via `binlog_format=ROW`, `gtid_mode=ON` — already enabled per F02
  §2.1).
- The replica is also append-only (MySQL replication preserves
  trigger semantics for ROW-format binlog).
- Verifier can run against either primary or replica.
- Attestation worker can fail over to replica reads if primary is
  down (the attestation only needs `row_hash` values, which are
  identical on the replica).

Phase 4 ticket filed in §11 hand-off.

Cost: cross-region replication ~10 GB/month at 100 ag steady-state ×
$0.02/GB egress = $0.20/month. Storage on replica matches primary.

---

## 8. Performance budgets

### 8.1 Per-insert overhead

| Component | Cost per row |
|---|---|
| BEFORE INSERT trigger SELECT prior + FOR UPDATE | ~150 µs (one B-tree probe + lock) |
| SHA2(canonicalized fields) | ~50 µs (typical row ~500 B) |
| Storage of 3 extra columns (64+64+27 bytes) | ~155 B per row |

Total: ~200 µs added to each insert. F02's pinned write budget
(§1.5 §2.2) for `audit_log` is 1 ms p99; we have headroom.

`originate_audit` at 100/sec full bore: 100 × 200 µs = 20 ms of CPU per
second on the trigger path → 2% of one core. Acceptable.

### 8.2 Storage growth from chain columns

3 columns × 5 tables × 7-year retention:
- `audit_log`: ~10M rows × 155 B = 1.5 GB
- `call_window_audit`: ~700k rows × 155 B = 110 MB
- `originate_audit`: ~80M rows × 155 B = 12 GB
- `consent_log`: ~25M rows × 155 B = 4 GB
- `dnc_sync_log`: ~10k rows × 155 B = 1.5 MB

Total: ~17 GB across 7 years (per tenant). Negligible vs. row content.

### 8.3 Verification cost

Walking 1 day at 100k rows: read 100k rows × 50 µs/recompute ≈ 5 sec.
Per-7-day verify in CI: 35 sec. Acceptable for a nightly job. Full
7-year verify (~250M rows) is offline / on-demand only.

### 8.4 Attestation worker cost

Per tenant × per table: read N rows of `(id, row_hash)` (~150 ms for
100k rows on indexed scan), compute Merkle root (~50 ms), sign
(~1 ms), PUT S3 (~200 ms). Total <500 ms per (tenant, table). 5
tables × 1 tenant Phase 1 = ~2.5 sec total per night. At 100 tenants
Phase 4: ~4 minutes per night. Run sequentially per tenant to bound
S3 PUT rate.

---

## 9. Key custody (O05 hand-off)

| Key | Phase 1 | Phase 4 |
|---|---|---|
| `VICI2_AUDIT_SIGNING_KEY` (Ed25519 private) | Env var on the workers host | Vault Transit |
| `VICI2_AUDIT_PUBLIC_KEYS` (Ed25519 public, JWKS-shaped) | Env var on api host + published to S3 | Same; S3 publish keeps verifier offline-capable |
| S3 Object Lock retention | Bucket-default 7y, set per-PUT | Same |
| Key rotation cadence | Annual | Annual + emergency on compromise |

Public key publication path:
`s3://vici2-audit-public-keys/<key_id>.pem` (Object Lock Compliance,
retention = signing key valid + 7y so verification stays possible
for the last attestation signed).

C03 hands off the secrets inventory to O05.

---

## 10. Citations

1. **MySQL 8.0 Reference Manual — `GRANT` and `REVOKE` semantics** —
   https://dev.mysql.com/doc/refman/8.0/en/grant.html — additive
   privilege model; `REVOKE` is required to remove a granted
   privilege; user privileges = UNION of all granted scopes.
2. **MySQL 8.0 Reference Manual — Trigger Restrictions** —
   https://dev.mysql.com/doc/refman/8.0/en/stored-program-restrictions.html#stored-routines-trigger-restrictions
   — `TRUNCATE TABLE` does not fire DELETE triggers; `DROP PARTITION`
   does not fire DELETE triggers.
3. **PostgreSQL Audit Trigger Patterns (informational)** —
   https://wiki.postgresql.org/wiki/Audit_trigger_91plus — separate
   schema pattern that we did not adopt; documented in §1.3 for
   completeness.
4. **MySQL Performance Blog — InnoDB row-level locking under
   triggers** — https://www.percona.com/blog/innodb-row-level-locking-and-triggers/
   — `SELECT ... FOR UPDATE` inside a trigger body holds gap locks
   for the rest of the transaction; serializes writes to the same
   key range. Used in §2.3.
5. **NIST FIPS 180-4 (SHA-2 family)** —
   https://csrc.nist.gov/publications/detail/fips/180/4/final —
   SHA-256 is FIPS-approved; required for federal customers. Used
   in §2.5.
6. **RFC 6962 — Certificate Transparency Merkle Tree definition** —
   https://datatracker.ietf.org/doc/html/rfc6962#section-2.1 —
   leaf domain separation byte 0x00, internal node byte 0x01,
   odd-leaf duplication. Used in §3.2.
7. **AWS S3 Object Lock — Compliance vs. Governance** —
   https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock-overview.html
   — Compliance mode prevents AWS root from deleting or shortening
   retention. Used in §3.4 / §6.4.
8. **NIST SP 800-53 Rev. 5 — AU-9 Protection of Audit Information** —
   https://csrc.nist.gov/publications/detail/sp/800-53/rev-5/final —
   audit records protected from unauthorized modification and
   deletion; AU-10 non-repudiation; AU-11 retention. Used in §4.2 /
   §5.5.
9. **AICPA SOC 2 Trust Services Criteria 2017 (with 2022 Points of
   Focus)** — https://www.aicpa-cima.com/topic/audit-assurance/audit-and-assurance-greater-than-soc-2
   — CC7.2 / CC6.6 logging requirements; tamper evidence is the
   distinguisher between checkbox WORM and demonstrable WORM.
10. **47 USC §227 (TCPA) — Statutory damages and class-action
    defense framework** —
    https://www.law.cornell.edu/uscode/text/47/227 — $500/$1,500 per
    call; defense relies on contemporaneous evidence of compliance.
11. **GDPR Articles 7, 30, 32 — Records of processing & technical
    measures** —
    https://gdpr-info.eu/art-30-gdpr/ , /art-32-gdpr/ , /art-7-gdpr/
    — record-keeping + appropriate technical measures (encryption,
    integrity, availability).
12. **SEC Final Rule — SOX §404 Compliance Requirements** —
    https://www.sec.gov/rules/final/33-8238.htm — internal controls
    over financial reporting attestation requirements.
13. **AWS Object Lock — Compliance vs. Governance trade-offs** —
    https://aws.amazon.com/blogs/storage/protecting-data-with-amazon-s3-object-lock/
    — irrevocability of Compliance mode; remediation pattern is to
    publish a corrected version, not delete.
14. **HashiCorp Vault Transit Secrets Engine** —
    https://developer.hashicorp.com/vault/docs/secrets/transit —
    Phase 4 key custody for `VICI2_AUDIT_SIGNING_KEY`.
15. **Google Trillian — Verifiable Log Implementation** —
    https://github.com/google/trillian — reference implementation of
    Merkle-backed transparency logs at scale; informs §3 design.
16. **Vicidial vicidial_log + vicidial_lead_log + vicidial_user_log
    schema** — https://www.vicidial.org/docs/vicidialnow/INSTALL.txt
    — Vicidial's audit equivalent (vicidial_admin_log) is mutable;
    documented as the anti-pattern we deliberately move past.

---

## 11. Open questions for PLAN

1. **Hash-chain perf overhead per insert.** Confirmed ~200 µs in §8.1
   based on one B-tree probe + SHA2; PLAN must commit to a measured
   benchmark (TEST phase) and roll back to non-chained if overhead
   exceeds 1 ms p99 on `originate_audit` at 100 RPS.
2. **Per-table vs. cross-table chain.** Phase 1: per-table per-tenant
   (5 chains per tenant). Cross-table chain (one chain spanning all
   five tables per tenant) defers correlation but eases verification
   ("one chain to verify"). Decision: per-table for Phase 1; revisit
   in Phase 4 when an enterprise customer asks. Documented in §2.2.
3. **Attestation timing.** O02 backup window is 03:00–03:30 UTC; C03
   schedules attestation at 03:30 UTC so the day's writes are
   complete + backup has captured the row data + S3 writes can
   happen in the low-traffic window. PLAN confirms the schedule and
   handoffs to O01 (alert on missed attestation).
4. **`consent_log` is a NEW table.** C02.md does not call out a
   table by name (says "audit per decision"). C03 PLAN proposes a
   dedicated `consent_log` table (§11.4 of PLAN) so consent decisions
   are independently queryable; alternative is to overload
   `audit_log` with action `consent.prompt.played` etc. Decision:
   dedicated table — consent is high-value forensic data per TCPA
   defense (§5.2), and overloading `audit_log` muddles the action
   taxonomy.
5. **`dnc_sync_log` partitioning.** Volume is 1 row/sync × ~30
   syncs/day = ~10k rows over 1 year. Probably doesn't need
   partitioning, but consistency with the other 4 tables argues
   for monthly RANGE COLUMNS partitioning anyway. PLAN goes with
   monthly partitioning for uniformity (cheap; unblocks C04
   reuse).
6. **Empty-day attestation.** If a tenant has zero rows in a table
   on a given day, do we publish? Yes — proves no activity (vs.
   "attestation lost"). §3.5.
7. **Trigger drop event.** When `vici2_root` drops a trigger to do a
   schema change, that DDL needs to be itself audited. MySQL
   binlog captures it but we want it in `audit_log` too. PLAN §7
   adds a wrapper migration pattern: every DDL touching audit
   tables runs through a Makefile target that writes a
   `audit.schema.modified` row before the DDL.
8. **Bypass for retention.** C04 partition rotation drops whole
   partitions — does NOT fire BEFORE DELETE trigger. Confirmed in
   F02 HANDOFF §7. C04's audit row `partition.dropped` is enough.

PLAN resolves all 8 in §3 / §6 / §11.
