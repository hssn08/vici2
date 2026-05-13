/**
 * api/src/services/audit/verifier.ts — AuditVerifier
 *
 * Read-only chain + Merkle + signature verifier (PLAN §6).
 * Uses vici2_audit_reader credentials (SELECT-only; never writes).
 *
 * Three verification modes:
 *   verifyRow()   — single row: recompute row_hash, check prev_hash linkage,
 *                   fetch attestation, build Merkle proof.
 *   verifyDay()   — all rows for (tenant, table, date): walk chain + build root.
 *   verifyRange() — date range: call verifyDay() for each day.
 *
 * PublicKeySource is an interface so callers can provide a local-file map (CI),
 * an S3 bucket reader, or a pinned manifest.
 */

import { createHash, createVerify } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import {
  buildMerkleRoot,
  buildWithProof,
  proofToHex,
  type InclusionProofHex,
} from '../../../../shared/lib/merkle.js';
import { canonicalize as jcs } from '../../../../shared/lib/jcs.js';
import {
  canonicalAuditLog,
  canonicalCallWindowAudit,
  canonicalConsentLog,
  canonicalDncSyncLog,
  canonicalOriginateAudit,
  toISOStringMicros,
  type AuditTable,
} from './canonicalize.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type VerifierFailureKind =
  | 'row_hash_mismatch'
  | 'prev_hash_mismatch'
  | 'missing_row'
  | 'merkle_root_mismatch'
  | 'signature_invalid'
  | 'missing_attestation';

export interface VerifierFailure {
  kind: VerifierFailureKind;
  table: AuditTable;
  tenantId: bigint;
  id?: bigint;
  date?: string;
  expected?: string;
  actual?: string;
}

export interface VerifierResult {
  ok: boolean;
  failures: VerifierFailure[];
  rowsChecked: number;
  daysChecked: number;
  attestationsChecked: number;
}

export interface RowVerifyResult extends VerifierResult {
  row?: Record<string, unknown>;
  prevRowHashMatches?: boolean;
  nextRowPrevHashMatches?: boolean;
  rowHashRecomputed?: string;
  rowHashStored?: string;
  merkleAttestationDate?: string;
  merkleInclusionProof?: InclusionProofHex;
}

/** Abstraction over key storage (local files, S3, pinned manifest). */
export interface PublicKeySource {
  /** Returns the PEM-encoded Ed25519 public key for the given key_id, or null. */
  getPublicKey(keyId: string): Promise<Buffer | null>;
}

export interface VerifierDeps {
  db: PrismaClient;
  pubKeys: PublicKeySource;
  /** Optional: function to fetch attestation JSON from S3 given s3_key */
  fetchAttestation?: (s3Key: string) => Promise<unknown>;
}

// ---------------------------------------------------------------------------
// AuditVerifier
// ---------------------------------------------------------------------------

export class AuditVerifier {
  private readonly db: PrismaClient;
  private readonly pubKeys: PublicKeySource;
  private readonly fetchAttestation?: (s3Key: string) => Promise<unknown>;

  constructor(deps: VerifierDeps) {
    this.db = deps.db;
    this.pubKeys = deps.pubKeys;
    this.fetchAttestation = deps.fetchAttestation;
  }

  /** Verify a single row: hash recompute + chain linkage + Merkle proof. */
  async verifyRow(p: {
    tenantId: bigint;
    table: AuditTable;
    id: bigint;
  }): Promise<RowVerifyResult> {
    const failures: VerifierFailure[] = [];
    const base = { table: p.table, tenantId: p.tenantId, id: p.id };

    const row = await this.fetchRow(p.table, p.tenantId, p.id);
    if (!row) {
      failures.push({ kind: 'missing_row', ...base });
      return { ok: false, failures, rowsChecked: 0, daysChecked: 0, attestationsChecked: 0 };
    }

    // Recompute row_hash
    const recomputed = this.recomputeRowHash(p.table, row);
    const stored = String(row.row_hash ?? '');
    const hashOk = recomputed === stored;
    if (!hashOk) {
      failures.push({ kind: 'row_hash_mismatch', ...base, expected: recomputed, actual: stored });
    }

    // Check prev_hash linkage (prior row)
    let prevRowHashMatches = true;
    const id = BigInt(row.id as string | bigint);
    if (id > 1n) {
      const prior = await this.fetchPriorRow(p.table, p.tenantId, id);
      if (prior) {
        const priorHash = String(prior.row_hash ?? '');
        const myPrev = String(row.prev_hash ?? '');
        prevRowHashMatches = priorHash === myPrev;
        if (!prevRowHashMatches) {
          failures.push({ kind: 'prev_hash_mismatch', ...base, expected: priorHash, actual: myPrev });
        }
      }
    }

    // Check next row's prev_hash
    let nextRowPrevHashMatches = true;
    const next = await this.fetchNextRow(p.table, p.tenantId, id);
    if (next) {
      const nextPrev = String(next.prev_hash ?? '');
      nextRowPrevHashMatches = nextPrev === stored;
      if (!nextRowPrevHashMatches) {
        failures.push({ kind: 'prev_hash_mismatch', ...base, expected: stored, actual: nextPrev });
      }
    }

    // Merkle inclusion proof
    const hashAt = row.hash_at as Date;
    const date = hashAt ? hashAt.toISOString().slice(0, 10) : null;
    let merkleProof: InclusionProofHex | undefined;
    let attestationsChecked = 0;

    if (date) {
      const attestResult = await this.verifyDay({ tenantId: p.tenantId, table: p.table, date });
      attestationsChecked = attestResult.attestationsChecked;
      failures.push(...attestResult.failures.filter((f) => f.kind !== 'row_hash_mismatch'));

      // Build inclusion proof for this specific row
      const dayRows = await this.fetchDayRows(p.table, p.tenantId, date);
      const idx = dayRows.findIndex((r) => BigInt(r.id as string | bigint) === id);
      if (idx >= 0 && dayRows.length > 0) {
        const { proof } = buildWithProof(
          dayRows.map((r) => String(r.row_hash ?? '')),
          idx,
        );
        merkleProof = proofToHex(proof);
      }
    }

    return {
      ok: failures.length === 0,
      failures,
      rowsChecked: 1,
      daysChecked: date ? 1 : 0,
      attestationsChecked,
      row: row as Record<string, unknown>,
      prevRowHashMatches,
      nextRowPrevHashMatches,
      rowHashRecomputed: recomputed,
      rowHashStored: stored,
      merkleAttestationDate: date ?? undefined,
      merkleInclusionProof: merkleProof,
    };
  }

  /** Verify all rows for (tenant, table, date). */
  async verifyDay(p: {
    tenantId: bigint;
    table: AuditTable;
    date: string; // 'YYYY-MM-DD'
  }): Promise<VerifierResult> {
    const failures: VerifierFailure[] = [];
    const base = { table: p.table, tenantId: p.tenantId, date: p.date };

    const rows = await this.fetchDayRows(p.table, p.tenantId, p.date);

    // Walk chain
    let prevHash = '0'.repeat(64);
    for (const row of rows) {
      const id = BigInt(row.id as string | bigint);
      const storedPrev = String(row.prev_hash ?? '');
      const storedHash = String(row.row_hash ?? '');
      const recomputed = this.recomputeRowHash(p.table, row);

      if (storedHash !== recomputed) {
        failures.push({ kind: 'row_hash_mismatch', ...base, id, expected: recomputed, actual: storedHash });
      }
      if (storedPrev !== prevHash && prevHash !== '0'.repeat(64)) {
        failures.push({ kind: 'prev_hash_mismatch', ...base, id, expected: prevHash, actual: storedPrev });
      }
      prevHash = storedHash;
    }

    // Fetch + verify attestation
    let attestationsChecked = 0;
    const attestation = await this.fetchDbAttestation(p.tenantId, p.table, p.date);
    if (!attestation) {
      failures.push({ kind: 'missing_attestation', ...base });
    } else {
      attestationsChecked = 1;

      // Re-build Merkle root from DB rows
      const recomputedRoot = buildMerkleRoot(rows.map((r) => String(r.row_hash ?? '')));
      const recomputedRootHex = recomputedRoot.toString('hex');
      const storedRoot = String(attestation.merkle_root ?? '');
      if (recomputedRootHex !== storedRoot) {
        failures.push({ kind: 'merkle_root_mismatch', ...base, expected: recomputedRootHex, actual: storedRoot });
      }

      // Verify Ed25519 signature
      const sigOk = await this.verifySignature(attestation);
      if (!sigOk) {
        failures.push({ kind: 'signature_invalid', ...base });
      }
    }

    return {
      ok: failures.length === 0,
      failures,
      rowsChecked: rows.length,
      daysChecked: 1,
      attestationsChecked,
    };
  }

  /** Verify a date range. */
  async verifyRange(p: {
    tenantId: bigint;
    table: AuditTable;
    from: Date;
    to: Date;
  }): Promise<VerifierResult> {
    const failures: VerifierFailure[] = [];
    let rowsChecked = 0;
    let daysChecked = 0;
    let attestationsChecked = 0;

    const cursor = new Date(p.from);
    cursor.setUTCHours(0, 0, 0, 0);
    const end = new Date(p.to);
    end.setUTCHours(0, 0, 0, 0);

    while (cursor <= end) {
      const date = cursor.toISOString().slice(0, 10);
      const result = await this.verifyDay({ tenantId: p.tenantId, table: p.table, date });
      failures.push(...result.failures);
      rowsChecked += result.rowsChecked;
      daysChecked += result.daysChecked;
      attestationsChecked += result.attestationsChecked;
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    return { ok: failures.length === 0, failures, rowsChecked, daysChecked, attestationsChecked };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async fetchRow(table: AuditTable, tenantId: bigint, id: bigint): Promise<Record<string, unknown> | null> {
    const rows = await this.db.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT * FROM \`${table}\` WHERE tenant_id = ? AND id = ? LIMIT 1`,
      tenantId,
      id,
    );
    return rows[0] ?? null;
  }

  private async fetchPriorRow(table: AuditTable, tenantId: bigint, id: bigint): Promise<Record<string, unknown> | null> {
    const rows = await this.db.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT id, row_hash FROM \`${table}\` WHERE tenant_id = ? AND id < ? ORDER BY id DESC LIMIT 1`,
      tenantId,
      id,
    );
    return rows[0] ?? null;
  }

  private async fetchNextRow(table: AuditTable, tenantId: bigint, id: bigint): Promise<Record<string, unknown> | null> {
    const rows = await this.db.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT id, prev_hash FROM \`${table}\` WHERE tenant_id = ? AND id > ? ORDER BY id ASC LIMIT 1`,
      tenantId,
      id,
    );
    return rows[0] ?? null;
  }

  private async fetchDayRows(table: AuditTable, tenantId: bigint, date: string): Promise<Record<string, unknown>[]> {
    const start = `${date} 00:00:00.000000`;
    const end = `${date} 23:59:59.999999`;
    return this.db.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT * FROM \`${table}\` WHERE tenant_id = ? AND hash_at >= ? AND hash_at <= ? ORDER BY id ASC`,
      tenantId,
      start,
      end,
    );
  }

  private async fetchDbAttestation(
    tenantId: bigint,
    table: AuditTable,
    date: string,
  ): Promise<Record<string, unknown> | null> {
    const rows = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT * FROM audit_attestation
       WHERE tenant_id = ${tenantId}
         AND table_name = ${table}
         AND window_date = ${date}
       LIMIT 1
    `;
    return rows[0] ?? null;
  }

  private async verifySignature(attestation: Record<string, unknown>): Promise<boolean> {
    try {
      const keyId = String(attestation.key_id ?? '');
      const sigB64 = String(attestation.signature_b64 ?? '');
      const pubKey = await this.pubKeys.getPublicKey(keyId);
      if (!pubKey) return false;

      // Reconstruct the signed payload (the attestation artifact JSON without signature)
      const signedPayload = {
        vici2_audit_attestation: {
          version: 1,
          tenant_id: Number(attestation.tenant_id),
          table: attestation.table_name,
          date: (attestation.window_date as Date)?.toISOString().slice(0, 10),
          row_count: Number(attestation.row_count),
          first_id: attestation.first_id ? Number(attestation.first_id) : null,
          last_id: attestation.last_id ? Number(attestation.last_id) : null,
          first_row_prev_hash: attestation.first_row_prev_hash,
          last_row_row_hash: attestation.last_row_row_hash,
          merkle_root: attestation.merkle_root,
          leaf_hash_algo: 'sha256-rfc6962',
          node_hash_algo: 'sha256-rfc6962',
          computed_at: toISOStringMicros(attestation.computed_at as Date),
          key_id: keyId,
        },
      };

      const canonical = jcs(signedPayload);
      const sig = Buffer.from(sigB64, 'base64');

      const verify = createVerify('Ed25519');
      verify.update(canonical);
      return verify.verify(pubKey, sig);
    } catch {
      return false;
    }
  }

  private recomputeRowHash(table: AuditTable, row: Record<string, unknown>): string {
    let canonical: string;
    const prevHash = String(row.prev_hash ?? '0'.repeat(64));

    switch (table) {
      case 'audit_log':
        canonical = canonicalAuditLog({
          prevHash,
          tenantId: BigInt(row.tenant_id as string | bigint),
          id: BigInt(row.id as string | bigint),
          ts: row.ts as Date,
          actorUserId: row.actor_user_id != null ? BigInt(row.actor_user_id as string | bigint) : null,
          actorKind: String(row.actor_kind),
          action: String(row.action),
          entityType: String(row.entity_type),
          entityId: row.entity_id as string | null,
          beforeJson: row.before_json,
          afterJson: row.after_json,
          requestId: row.request_id as string | null,
          ipAddress: row.ip_address as string | null,
          userAgent: row.user_agent as string | null,
        });
        break;
      case 'call_window_audit':
        canonical = canonicalCallWindowAudit({
          prevHash,
          tenantId: BigInt(row.tenant_id as string | bigint),
          id: BigInt(row.id as string | bigint),
          createdAt: row.created_at as Date,
          leadId: BigInt(row.lead_id as string | bigint),
          phoneE164: String(row.phone_e164),
          campaignId: String(row.campaign_id),
          decision: String(row.decision),
          reason: String(row.reason),
          tzIana: row.tz_iana as string | null,
          tzConfidence: row.tz_confidence as string | null,
          stateCode: row.state_code as string | null,
          zip: row.zip as string | null,
          partyLocal: row.party_local as Date | null,
          partyDow: row.party_dow as number | null,
          effectiveOpenMin: row.effective_open_min as number | null,
          effectiveCloseMin: row.effective_close_min as number | null,
          ruleApplied: row.rule_applied as string | null,
          enforcementPoint: String(row.enforcement_point),
          nextOpenAt: row.next_open_at as Date | null,
          callUuid: row.call_uuid as string | null,
        });
        break;
      case 'originate_audit':
        canonical = canonicalOriginateAudit({
          prevHash,
          tenantId: BigInt(row.tenant_id as string | bigint),
          id: BigInt(row.id as string | bigint),
          originatedAt: row.originated_at as Date,
          leadId: BigInt(row.lead_id as string | bigint),
          phoneE164: String(row.phone_e164),
          campaignId: row.campaign_id as string | null,
          outcome: String(row.outcome),
          tcpaReason: row.tcpa_reason as string | null,
          dncDecision: row.dnc_decision as string | null,
          dncSources: row.dnc_sources,
          tcpaDecision: row.tcpa_decision as string | null,
          callUuid: row.call_uuid as string | null,
        });
        break;
      case 'consent_log':
        canonical = canonicalConsentLog({
          prevHash,
          tenantId: BigInt(row.tenant_id as string | bigint),
          id: BigInt(row.id as string | bigint),
          callUuid: String(row.call_uuid),
          leadId: BigInt(row.lead_id as string | bigint),
          phoneE164: String(row.phone_e164),
          promptId: String(row.prompt_id),
          dtmfResponse: row.dtmf_response as string | null,
          outcome: String(row.outcome),
          language: String(row.language),
          promptPlayedAt: row.prompt_played_at as Date,
        });
        break;
      case 'dnc_sync_log':
        canonical = canonicalDncSyncLog({
          prevHash,
          id: BigInt(row.id as string | bigint),
          source: String(row.source),
          kind: String(row.kind),
          fileHash: row.file_hash as string | null,
          added: Number(row.added),
          removed: Number(row.removed),
          startedAt: row.started_at as Date,
          completedAt: row.completed_at as Date | null,
        });
        break;
      default:
        throw new Error(`Unknown audit table: ${table}`);
    }

    return createHash('sha256').update(canonical, 'utf8').digest('hex');
  }
}
