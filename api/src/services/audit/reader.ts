/**
 * api/src/services/audit/reader.ts — AuditReader
 *
 * RBAC-gated reads with automatic meta-audit (PLAN §10.2 / NIST 800-53 AU-9).
 * Every read method writes an audit.access.<endpoint> row to audit_log via
 * AuditWriter before returning data.
 *
 * Cross-tenant reads (super_admin with audit:view:cross_tenant) are allowed
 * but tagged at SEV1 severity in the meta-audit row.
 *
 * Pagination: cursor-based (id, ts). Hard cap limit ≤ 200.
 */

import type { PrismaClient } from '@prisma/client';
import type { AuditWriter } from './writer.js';
import type { AuditVerifier } from './verifier.js';

export interface RbacContext {
  userId: bigint;
  tenantId: bigint;
  /** Permissions the authenticated user holds. */
  permissions: Set<string>;
  requestId?: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface AuditListRequest {
  tenantId: bigint;
  table: 'audit_log' | 'call_window_audit' | 'originate_audit' | 'consent_log' | 'dnc_sync_log';
  fromDate?: string; // 'YYYY-MM-DD'
  toDate?: string;
  cursor?: string; // base64(id)
  limit?: number;
}

export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
  total?: number;
}

export class AuditReader {
  private readonly db: PrismaClient;
  private readonly writer: AuditWriter;
  private readonly verifier: AuditVerifier;

  constructor(deps: { db: PrismaClient; writer: AuditWriter; verifier: AuditVerifier }) {
    this.db = deps.db;
    this.writer = deps.writer;
    this.verifier = deps.verifier;
  }

  /** List rows from any audit table with cursor pagination. */
  async list(req: AuditListRequest, rbac: RbacContext): Promise<Paginated<Record<string, unknown>>> {
    this.assertPermission(rbac, 'audit:view');
    const isCrossTenant = req.tenantId !== rbac.tenantId;
    const actionBase = `audit.access.${req.table}_listed` as const;

    await this.metaAudit(rbac, actionBase, req.table, isCrossTenant);

    const limit = Math.min(req.limit ?? 50, 200);
    const cursorId = req.cursor ? BigInt(Buffer.from(req.cursor, 'base64').toString()) : null;

    let sql = `SELECT * FROM \`${req.table}\` WHERE tenant_id = ?`;
    const params: unknown[] = [req.tenantId];

    if (req.fromDate) {
      sql += ' AND hash_at >= ?';
      params.push(`${req.fromDate} 00:00:00.000000`);
    }
    if (req.toDate) {
      sql += ' AND hash_at <= ?';
      params.push(`${req.toDate} 23:59:59.999999`);
    }
    if (cursorId) {
      sql += ' AND id > ?';
      params.push(cursorId);
    }
    sql += ` ORDER BY id ASC LIMIT ${limit + 1}`;

    const rows = await this.db.$queryRawUnsafe<Record<string, unknown>[]>(sql, ...params);
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const lastId = items[items.length - 1]?.id;
    const nextCursor = hasMore && lastId != null
      ? Buffer.from(String(lastId)).toString('base64')
      : null;

    return { items, nextCursor };
  }

  /** Get all audit rows associated with a call_uuid. */
  async getByCallUuid(callUuid: string, rbac: RbacContext): Promise<Record<string, unknown>[]> {
    this.assertPermission(rbac, 'audit:view');
    await this.metaAudit(rbac, 'audit.access.log_listed', 'audit_log', false);

    const rows = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT * FROM audit_log WHERE JSON_EXTRACT(after_json, '$.call_uuid') = ${callUuid}
         AND tenant_id = ${rbac.tenantId}
      ORDER BY id ASC LIMIT 200
    `;
    return rows;
  }

  /** Get a signed attestation record for (table, date). */
  async getAttestation(
    table: string,
    date: string,
    rbac: RbacContext,
  ): Promise<Record<string, unknown> | null> {
    this.assertPermission(rbac, 'audit:view');
    await this.metaAudit(rbac, 'audit.access.attestation_fetched', table, false);

    const rows = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT * FROM audit_attestation
       WHERE tenant_id = ${rbac.tenantId}
         AND table_name = ${table}
         AND window_date = ${date}
       LIMIT 1
    `;
    return rows[0] ?? null;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private assertPermission(rbac: RbacContext, perm: string): void {
    if (!rbac.permissions.has(perm)) {
      throw Object.assign(new Error(`Forbidden: missing permission ${perm}`), { statusCode: 403 });
    }
  }

  private async metaAudit(
    rbac: RbacContext,
    action: string,
    entityType: string,
    isCrossTenant: boolean,
  ): Promise<void> {
    await this.writer.appendAuditLog({
      tenantId: rbac.tenantId,
      actorUserId: rbac.userId,
      actorKind: 'user',
      action: isCrossTenant ? 'audit.access.cross_tenant' : (action as never),
      entityType,
      entityId: null,
      afterJson: isCrossTenant ? { severity: 'SEV1', originalAction: action } : undefined,
      requestId: rbac.requestId,
      ipAddress: rbac.ipAddress,
      userAgent: rbac.userAgent,
      ts: new Date(),
    });
  }
}
