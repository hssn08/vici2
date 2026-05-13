// M04 — AuditLogViewerService.
//
// Thin wrapper over AuditReader + AuditVerifier that adds:
//   • Extra filter clauses (action, actor, entity_type, entity_id) not in
//     AuditReader.list() (which only filters by date + cursor).
//   • Chain context (prev/next 5 rows) for the detail view.
//   • Verify delegation to AuditVerifier.verifyRow() / verifyDay().
//   • CSV/JSON streaming for export.
//
// All reads emit meta-audit rows via AuditReader (already built-in).
// This service never writes to any table.

import { getPrisma } from "../../../lib/prisma.js";
import type { PrismaClient } from "@prisma/client";
import type { AuditReader } from "../../../services/audit/reader.js";
import type { RbacContext } from "../../../services/audit/reader.js";
import type { AuditVerifier } from "../../../services/audit/verifier.js";
import type { AuditLogListQuery, AuditLogExportQuery, AttestationListQuery } from "./schema.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}

// ---------------------------------------------------------------------------
// AuditLogViewerService
// ---------------------------------------------------------------------------

export class AuditLogViewerService {
  private get db(): PrismaClient {
    return getPrisma();
  }

  constructor(
    private readonly reader: AuditReader,
    private readonly verifier: AuditVerifier,
  ) {}

  // -------------------------------------------------------------------------
  // List audit_log with extended filters
  // -------------------------------------------------------------------------

  async listAuditLog(
    query: AuditLogListQuery,
    rbac: RbacContext,
  ): Promise<Paginated<Record<string, unknown>>> {
    // Guard first so callers get a clean 403 without touching the reader
    this.assertPermission(rbac, "audit:view");
    // Delegate base pagination to AuditReader (which emits meta-audit)
    const base = await this.reader.list(
      {
        tenantId: rbac.tenantId,
        table: "audit_log",
        fromDate: query.from,
        toDate: query.to,
        cursor: query.cursor,
        limit: query.limit,
      },
      rbac,
    );

    // Post-filter in memory (acceptable for ≤200-row page; row count is already limited)
    let items = base.items;
    if (query.action) {
      const prefix = query.action;
      items = items.filter((r) => String(r.action ?? "").startsWith(prefix));
    }
    if (query.actor) {
      const actorId = query.actor;
      items = items.filter((r) => String(r.actor_user_id ?? "") === actorId);
    }
    if (query.actorKind) {
      const kind = query.actorKind;
      items = items.filter((r) => r.actor_kind === kind);
    }
    if (query.entity_type) {
      const et = query.entity_type;
      items = items.filter((r) => r.entity_type === et);
    }
    if (query.entity_id) {
      const eid = query.entity_id;
      items = items.filter((r) => r.entity_id === eid);
    }

    return { items, nextCursor: base.nextCursor };
  }

  // -------------------------------------------------------------------------
  // Get single row + chain context (prev/next 5)
  // -------------------------------------------------------------------------

  async getAuditLogDetail(
    id: bigint,
    rbac: RbacContext,
  ): Promise<{
    row: Record<string, unknown>;
    chainContext: { prevRows: Record<string, unknown>[]; nextRows: Record<string, unknown>[] };
  } | null> {
    this.assertPermission(rbac, "audit:view");

    const rows = await this.db.$queryRawUnsafe<Record<string, unknown>[]>(
      "SELECT * FROM `audit_log` WHERE tenant_id = ? AND id = ? LIMIT 1",
      rbac.tenantId,
      id,
    );
    const row = rows[0];
    if (!row) return null;

    const prevRows = await this.db.$queryRawUnsafe<Record<string, unknown>[]>(
      "SELECT * FROM `audit_log` WHERE tenant_id = ? AND id < ? ORDER BY id DESC LIMIT 5",
      rbac.tenantId,
      id,
    );
    const nextRows = await this.db.$queryRawUnsafe<Record<string, unknown>[]>(
      "SELECT * FROM `audit_log` WHERE tenant_id = ? AND id > ? ORDER BY id ASC LIMIT 5",
      rbac.tenantId,
      id,
    );

    return { row, chainContext: { prevRows: prevRows.reverse(), nextRows } };
  }

  // -------------------------------------------------------------------------
  // Verify a single row (delegates to AuditVerifier)
  // -------------------------------------------------------------------------

  async verifyRow(id: bigint, rbac: RbacContext) {
    this.assertPermission(rbac, "audit:view");
    return this.verifier.verifyRow({
      tenantId: rbac.tenantId,
      table: "audit_log",
      id,
    });
  }

  // -------------------------------------------------------------------------
  // List attestations
  // -------------------------------------------------------------------------

  async listAttestations(
    query: AttestationListQuery,
    rbac: RbacContext,
  ): Promise<Paginated<Record<string, unknown>>> {
    this.assertPermission(rbac, "audit:view");

    const limit = Math.min(query.limit ?? 50, 200);
    const cursorId = query.cursor
      ? BigInt(Buffer.from(query.cursor, "base64").toString())
      : null;

    let sql =
      "SELECT * FROM `audit_attestation` WHERE tenant_id = ?";
    const params: unknown[] = [rbac.tenantId];

    if (query.table) {
      sql += " AND table_name = ?";
      params.push(query.table);
    }
    if (query.from) {
      sql += " AND window_date >= ?";
      params.push(query.from);
    }
    if (query.to) {
      sql += " AND window_date <= ?";
      params.push(query.to);
    }
    if (cursorId) {
      sql += " AND id > ?";
      params.push(cursorId);
    }
    sql += ` ORDER BY id ASC LIMIT ${limit + 1}`;

    const rows = await this.db.$queryRawUnsafe<Record<string, unknown>[]>(sql, ...params);
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const lastId = items[items.length - 1]?.id;
    const nextCursor =
      hasMore && lastId != null
        ? Buffer.from(String(lastId)).toString("base64")
        : null;

    return { items, nextCursor };
  }

  // -------------------------------------------------------------------------
  // Verify attestation (verifyDay for the window_date of this attestation)
  // -------------------------------------------------------------------------

  async verifyAttestation(attestationId: bigint, rbac: RbacContext) {
    this.assertPermission(rbac, "audit:view");

    const rows = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT * FROM audit_attestation
       WHERE tenant_id = ${rbac.tenantId}
         AND id = ${attestationId}
       LIMIT 1
    `;
    const att = rows[0];
    if (!att) return null;

    const tableName = String(att.table_name ?? "audit_log");
    const windowDate = att.window_date instanceof Date
      ? att.window_date.toISOString().slice(0, 10)
      : String(att.window_date ?? "").slice(0, 10);

    return this.verifier.verifyDay({
      tenantId: rbac.tenantId,
      table: tableName as Parameters<AuditVerifier["verifyDay"]>[0]["table"],
      date: windowDate,
    });
  }

  // -------------------------------------------------------------------------
  // Export (stream-friendly: returns async generator of strings)
  // -------------------------------------------------------------------------

  async *exportAuditLog(
    query: AuditLogExportQuery,
    rbac: RbacContext,
  ): AsyncGenerator<string> {
    this.assertPermission(rbac, "audit:export");

    const CSV_HEADER =
      "id,ts,action,actor_kind,actor_user_id,entity_type,entity_id,row_hash,prev_hash\n";
    const isCSV = query.format !== "json";

    if (isCSV) yield CSV_HEADER;

    let cursor: string | null = null;
    const limit = 200;

    do {
      const page = await this.reader.list(
        {
          tenantId: rbac.tenantId,
          table: "audit_log",
          fromDate: query.from,
          toDate: query.to,
          cursor: cursor ?? undefined,
          limit,
        },
        rbac,
      );

      for (const row of page.items) {
        if (isCSV) {
          yield csvRow([
            row.id,
            row.ts,
            row.action,
            row.actor_kind,
            row.actor_user_id,
            row.entity_type,
            row.entity_id,
            row.row_hash,
            row.prev_hash,
          ]);
        } else {
          yield JSON.stringify(row) + "\n";
        }
      }

      cursor = page.nextCursor;
    } while (cursor !== null);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private assertPermission(rbac: RbacContext, perm: string): void {
    if (!rbac.permissions.has(perm)) {
      throw Object.assign(new Error(`Forbidden: missing permission ${perm}`), {
        statusCode: 403,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(",") + "\n";
}
