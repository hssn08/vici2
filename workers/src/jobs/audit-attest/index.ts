/**
 * workers/src/jobs/audit-attest/index.ts
 *
 * Daily Merkle attestation worker — cron 30 3 * * * UTC (PLAN §5.6).
 *
 * For each (tenant × immutable table):
 *   1. window = yesterday 00:00:00 UTC → 23:59:59.999999 UTC
 *   2. Fetch rows ordered by id ASC
 *   3. Build Merkle root (RFC 6962, SHA-256)
 *   4. Build attestation JSON; JCS-canonicalize; Ed25519 sign
 *   5. PUT to S3 with Object Lock Compliance, 7y retention
 *   6. INSERT into audit_attestation (chained via trigger)
 *   7. INSERT into audit_log (action=audit.attestation.published)
 *
 * Empty-day handling: if no rows, merkle_root = EMPTY_ROOT hex, row_count=0,
 * first_id=null, last_id=null, first_row_prev_hash = prior day's last_row_row_hash.
 *
 * The worker is idempotent: the UNIQUE KEY (tenant_id, table_name, window_date)
 * on audit_attestation prevents duplicate inserts (ON DUPLICATE KEY IGNORE).
 */

import { canonicalize as jcs } from '../../../../shared/lib/jcs.js';
import { buildRootFromRows } from './merkle-builder.js';
import { buildS3Key, putAttestation } from './s3-publisher.js';
import type { SignerInterface } from './signer.js';

// These types are minimal stubs — the real DB client comes from the caller.
export interface DbClient {
  queryRaw<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]>;
}

export interface AttestationWorkerDeps {
  db: DbClient;
  signer: SignerInterface;
  tenantIds?: bigint[];
}

export const AUDIT_TABLES = [
  'audit_log',
  'call_window_audit',
  'originate_audit',
  'consent_log',
  'dnc_sync_log',
] as const;

export type AuditTable = typeof AUDIT_TABLES[number];

export interface AttestationArtifact {
  vici2_audit_attestation: {
    version: 1;
    tenant_id: number;
    table: string;
    date: string;
    row_count: number;
    first_id: number | null;
    last_id: number | null;
    first_row_prev_hash: string;
    last_row_row_hash: string;
    merkle_root: string;
    leaf_hash_algo: 'sha256-rfc6962';
    node_hash_algo: 'sha256-rfc6962';
    computed_at: string;
    key_id: string;
  };
  signature: string; // base64url Ed25519 over JCS-canonicalized vici2_audit_attestation
}

/** Run attestation for a single (tenant, table, date). */
export async function attestWindow(
  deps: AttestationWorkerDeps,
  tenantId: bigint,
  tableName: AuditTable,
  windowDate: string, // 'YYYY-MM-DD' — the day to attest
): Promise<void> {
  const { db, signer } = deps;

  // 1. Fetch rows for this tenant + table + day
  const windowStart = `${windowDate} 00:00:00.000000`;
  const windowEnd = `${windowDate} 23:59:59.999999`;

  type AuditRow = { id: bigint; prev_hash: string; row_hash: string; hash_at: Date };

  // dnc_sync_log has no tenant_id column; use global chain
  const whereClause = tableName === 'dnc_sync_log'
    ? `WHERE hash_at >= '${windowStart}' AND hash_at <= '${windowEnd}'`
    : `WHERE tenant_id = ${tenantId} AND hash_at >= '${windowStart}' AND hash_at <= '${windowEnd}'`;

  const rows = await db.queryRaw<AuditRow>(
    `SELECT id, prev_hash, row_hash, hash_at FROM \`${tableName}\` ${whereClause} ORDER BY id ASC`,
  );

  // 2. Determine chain endpoints
  let firstRowPrevHash: string;
  let lastRowRowHash: string;

  if (rows.length === 0) {
    // Empty day: carry forward from prior day's attestation
    const priorRows = await db.queryRaw<{ last_row_row_hash: string }>(
      `SELECT last_row_row_hash FROM audit_attestation
        WHERE tenant_id = ${tenantId} AND table_name = '${tableName}'
          AND window_date < '${windowDate}'
        ORDER BY window_date DESC LIMIT 1`,
    );
    const carried = priorRows[0]?.last_row_row_hash ?? '0'.repeat(64);
    firstRowPrevHash = carried;
    lastRowRowHash = carried;
  } else {
    firstRowPrevHash = rows[0].prev_hash;
    lastRowRowHash = rows[rows.length - 1].row_hash;
  }

  // 3. Build Merkle root
  const merkleRoot = buildRootFromRows(rows.map((r) => ({ id: r.id, row_hash: r.row_hash })));
  const rowCount = rows.length;
  const firstId = rows.length > 0 ? Number(rows[0].id) : null;
  const lastId = rows.length > 0 ? Number(rows[rows.length - 1].id) : null;

  // 4. Build attestation artifact + sign
  const artifact: AttestationArtifact = {
    vici2_audit_attestation: {
      version: 1,
      tenant_id: Number(tenantId),
      table: tableName,
      date: windowDate,
      row_count: rowCount,
      first_id: firstId,
      last_id: lastId,
      first_row_prev_hash: firstRowPrevHash,
      last_row_row_hash: lastRowRowHash,
      merkle_root: merkleRoot,
      leaf_hash_algo: 'sha256-rfc6962',
      node_hash_algo: 'sha256-rfc6962',
      computed_at: new Date().toISOString().replace(/\.\d{3}Z$/, '.000000Z'),
      key_id: signer.keyId(),
    },
    signature: '', // filled below
  };

  const payloadCanonical = jcs({ vici2_audit_attestation: artifact.vici2_audit_attestation });
  const sig = signer.sign(payloadCanonical);
  artifact.signature = sig.toString('base64');

  const artifactJson = JSON.stringify(artifact, null, 2);

  // 5. PUT to S3
  const s3Key = buildS3Key(tenantId, tableName, windowDate);
  const s3Result = await putAttestation(s3Key, artifactJson);

  // 6. INSERT into audit_attestation
  const emptyDay = rows.length === 0;
  await db.queryRaw(`
    INSERT IGNORE INTO audit_attestation
      (tenant_id, table_name, window_date, row_count,
       first_id, last_id, first_row_prev_hash, last_row_row_hash,
       merkle_root, key_id, signature_b64, s3_key, s3_etag, s3_uploaded_at,
       computed_at)
    VALUES (
      ${tenantId}, '${tableName}', '${windowDate}',
      ${rowCount},
      ${firstId ?? 'NULL'}, ${lastId ?? 'NULL'},
      '${firstRowPrevHash}', '${lastRowRowHash}',
      '${merkleRoot}', '${signer.keyId()}',
      '${artifact.signature.replace(/'/g, "''")}',
      '${s3Key}',
      ${s3Result?.etag ? `'${s3Result.etag}'` : 'NULL'},
      ${s3Result ? `'${new Date().toISOString().replace('T', ' ').slice(0, 26)}'` : 'NULL'},
      NOW(6)
    )
  `);

  // 7. Write meta-audit row
  const action = emptyDay ? 'audit.attestation.empty_day' : 'audit.attestation.published';
  await db.queryRaw(`
    INSERT INTO audit_log
      (tenant_id, actor_user_id, actor_kind, action, entity_type, entity_id,
       after_json, ts)
    VALUES (
      ${tenantId}, NULL, 'worker', '${action}', 'audit_attestation',
      '${tableName}',
      '${JSON.stringify({ windowDate, rowCount, merkleRoot, s3Key }).replace(/'/g, "''")}',
      NOW(6)
    )
  `);

  console.error(`[audit-attest] ${tenantId}/${tableName}/${windowDate}: rows=${rowCount} root=${merkleRoot.slice(0, 16)}…`);
}

/**
 * Run attestation for all tenants × all tables for yesterday.
 * Called by the cron scheduler or manually via make audit-verify-7d.
 */
export async function runAttestation(deps: AttestationWorkerDeps): Promise<void> {
  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const windowDate = yesterday.toISOString().slice(0, 10);

  const tenantIds = deps.tenantIds ?? [1n]; // Phase 1: single tenant

  for (const tenantId of tenantIds) {
    for (const table of AUDIT_TABLES) {
      try {
        await attestWindow(deps, tenantId, table, windowDate);
      } catch (err) {
        console.error(`[audit-attest] FAILED ${tenantId}/${table}/${windowDate}:`, err);
        // Re-throw so the cron scheduler can page O01
        throw err;
      }
    }
  }
}
